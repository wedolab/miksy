import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Adapter, RenderedFile } from "../../src/adapter";
import { deliver, type Launcher, nativeServers } from "../../src/launch";
import { skillFiles } from "../../src/skillfiles";
import type { McpServer } from "../../src/types";
import { gitStatusOf } from "../../src/sync";
import { mcpTables, parseToml, tomlValue } from "../../src/toml";
import { currentGlobal, currentProject, instructionFile, readConfig } from "./current";
import { keepOwn } from "../../src/paths";
import { teamCollection } from "../../src/git";

export const HEADER = (layers: string[]) =>
  `<!-- Сгенерировано miksy (слои: ${layers.join(" → ")}). Не править вручную — изменения вносить в конфигурацию miksy (слои). -->`;

// Секреты: stdio — обёртка, HTTP — http_headers_helper (строка-команда; Windows — через %COMSPEC%);
// секрет в URL — мост
export function nativeMcp(s: McpServer, launch?: Launcher): Record<string, unknown> | null {
  const special = s.agents?.codex;
  if (special === "skip") return null;
  const d = deliver(s, launch, "helper");
  const base: Record<string, unknown> =
    d.kind === "stdio" ? { command: d.command, args: [] }
    : d.kind === "helper" ? { url: d.url, http_headers_helper: d.helper }
    : s.url ? { url: s.url, ...(s.headers && { http_headers: s.headers }) }
    : { command: s.command, args: s.args ?? [], ...(s.env && { env: s.env }) };
  return special ? { ...base, ...special.raw } : base;
}
export const codex: Adapter = {
  id: "codex",
  skillDirs: [".agents/skills", ".codex/skills"],
  homeConfig: [".codex/config.toml", ".codex/AGENTS.md", ".codex/AGENTS.override.md", ".agents/skills"],
  // node_repl заводит само приложение Codex (computer use), это не пользовательский сервер
  internalMcp: ["node_repl"],
  nativeMcp,
  httpSecrets: "helper",
  knownDirs: (machine) => Object.keys(readConfig(join(machine.home, ".codex", "config.toml")).projects ?? {}),
  current: (target, machine) => target.scope === "global"
    ? currentGlobal(machine.home) : currentProject(target.dir, machine.home, machine.os),

  render(cfg, target, machine, ctx) {
    const files: RenderedFile[] = [];
    const warnings: string[] = [];
    const isGlobal = target.scope === "global";
    const body = cfg.instructions.map(({ item }) => readFileSync(item.path, "utf8").trim()).join("\n\n");

    if (cfg.instructions.length) {
      if (isGlobal) {
        const selected = instructionFile(join(machine.home, ".codex"));
        if (selected?.endsWith("/AGENTS.override.md")) {
          warnings.push("инструкции codex: ~/.codex/AGENTS.override.md перекрывает AGENTS.md — инструкции не записаны");
        } else {
          files.push({ base: "home", path: ".codex/AGENTS.md", mode: "own", block: true, content: `${HEADER(cfg.layers)}\n\n${body}\n` });
        }
      }
    }

    let skillsDir = ".agents/skills";
    try { if (!isGlobal && cfg.skills.length && teamCollection(target.dir, skillsDir)) skillsDir = ".codex/skills"; }
    catch (e) { warnings.push(`${(e as Error).message} — skills Codex не записаны`); skillsDir = ""; }
    for (const { item } of skillsDir ? cfg.skills : []) {
      for (const f of skillFiles(item, warnings)) {
        files.push({ base: isGlobal ? "home" : "project", path: `${skillsDir}/${item.name}/${f.rel}`,
          mode: "own", content: f.content, ...(f.executable && { executable: true }), ...(item.team && { team: true }) });
      }
    }

    const servers = nativeServers(cfg.mcp, "codex", nativeMcp, ctx?.launch, warnings);
    const scripts = () => files.push(...(ctx?.launch?.files() ?? []));
    if (isGlobal) {
      if (Object.keys(servers).length)
        files.push({ base: "home", path: ".codex/config.toml", mode: "merge", format: "toml", key: ["mcp_servers"], data: servers });
      scripts();
    } else if (body || Object.keys(servers).length || keepOwn(ctx, join(target.dir, ".codex/config.toml"))) {
      const path = ".codex/config.toml";
      let tracked: boolean | string;
      try {
        tracked = gitStatusOf(target.dir, [path]).tracked.length > 0;
      } catch (e) {
        tracked = (e as Error).message; // сбой git — не пишем, как и в отслеживаемый файл
      }
      if (typeof tracked === "string") {
        warnings.push(`${tracked} — инструкции и MCP codex не записаны`);
      } else if (tracked) {
        warnings.push(`${path} отслеживается git проекта — это файл команды; инструкции и MCP codex не записаны`);
      } else {
        const content = `# Сгенерировано miksy. Не править вручную — изменения вносить в конфигурацию miksy (слои).\n`
          + (body ? `developer_instructions = ${tomlValue(body)}\n\n` : "") + mcpTables(servers);
        parseToml(content);
        files.push({ base: "project", path, mode: "own", content, mcp: { format: "toml", key: "mcp_servers" } });
        scripts();
      }
    }
    return { files, warnings };
  },
};
