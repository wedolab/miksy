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
import { shimPath, shimState } from "../../src/shim";
import { splitInstructions } from "../../src/instructions";
import { adoptCodexTable } from "./adopt";

export const HEADER = (layers: string[]) =>
  `<!-- Сгенерировано miksy (слои: ${layers.join(" → ")}). Не править вручную — изменения вносить в конфигурацию miksy (слои). -->`;

// Секреты: stdio — обёртка, HTTP — http_headers_helper (строка-команда; Windows — через %COMSPEC%);
// секрет в URL — мост
export function nativeMcp(s: McpServer, launch?: Launcher): Record<string, unknown> | null {
  const special = s.agents?.codex;
  if (special === "skip") return null;
  const d = deliver(s, launch, "helper");
  const base: Record<string, unknown> =
    // Переносимая форма: Codex очищает окружение сервера (на Windows нет и HOME) — MIKSY_CONFIG, если задан, нужен miksy mcp
    d.kind === "stdio" ? { command: d.command, args: d.args, ...(d.portable && { env_vars: ["MIKSY_CONFIG"] }) }
    : d.kind === "helper" ? { url: d.url, http_headers_helper: d.helper }
    : s.url ? { url: s.url, ...(s.headers && { http_headers: s.headers }) }
    : { command: s.command, args: s.args ?? [], ...(s.env && { env: s.env }) };
  return special ? { ...base, ...special.raw } : base;
}
export const codex: Adapter = {
  id: "codex",
  title: "Codex",
  detect: { commands: ["codex"], dirs: [".codex"] },
  program: { name: "Codex", commands: ["codex"] },
  envVars: [{ name: "CODEX_HOME", title: "Codex", std: (h) => join(h, ".codex"), replace: true }],
  homeSkillsDir: ".agents/skills",
  teamImport: true,
  collections: [".agents/skills", ".codex/skills"],
  // Командная коллекция в .agents/skills — skills проекта в .codex/skills (render ниже)
  skillsFallback: { from: ".agents/skills", to: ".codex/skills" },
  restore: {
    everCopied: [".codex/config.toml", ".codex/AGENTS.md", ".codex/AGENTS.override.md", ".agents/skills"],
    // Вход; сессии, история, логи, снимки оболочки, служебные кэши и номера
    notRestored: [
      ".codex/auth.json",
      ".codex/sessions", ".codex/archived_sessions", ".codex/history.jsonl", ".codex/log", ".codex/logs",
      ".codex/shell_snapshots", ".codex/tmp", ".codex/cache", ".codex/version.json", ".codex/models_cache.json",
      ".codex/internal_storage.json",
    ],
  },
  adoptGlobal: adoptCodexTable,
  skillDirs: [".agents/skills", ".codex/skills"],
  homeConfig: [".codex/config.toml", ".codex/AGENTS.md", ".codex/AGENTS.override.md", ".agents/skills"],
  // node_repl заводит само приложение Codex (computer use), это не пользовательский сервер
  internalMcp: ["node_repl"],
  nativeMcp,
  httpSecrets: "helper",
  projectMcp: "portable",
  knownDirs: (machine) => Object.keys(readConfig(join(machine.home, ".codex", "config.toml")).projects ?? {}),
  current: (target, machine) => target.scope === "global"
    ? currentGlobal(machine.home) : currentProject(target.dir, machine.home, machine.os),

  render(cfg, target, machine, ctx) {
    const files: RenderedFile[] = [];
    const warnings: string[] = [];
    const advice: string[] = [];
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
      // macOS, Linux: Codex вне терминала (приложение, расширение IDE) PATH оболочки не получает, а MCP проектов
      // запускает команда miksy (miksy mcp). Codex дописывает окружение из $CODEX_HOME/.env (${PATH} в нём
      // раскрывается) — блок miksy с каталогом команды. Windows: PATH пользователя из реестра есть у всех программ
      const shim = shimPath(machine.home, machine.os);
      const dir = shim.slice(0, shim.lastIndexOf("/"));
      // В .env бывают ключи: файл со своими строками пользователя miksy не меняет (запись сохранила бы его копию в
      // бэкапах) — doctor подсказывает строку
      if (machine.os !== "windows" && ["current", "legacy"].includes(shimState(shim))) {
        const line = `PATH="${dir}:\${PATH}"`;
        let foreign = false;
        try {
          const parts = splitInstructions(readFileSync(join(machine.home, ".codex", ".env"), "utf8"));
          foreign = !parts.block && /\S/.test(parts.before + parts.after);
        } catch { /* файла нет; повреждённые маркеры — блок miksy ниже, apply скажет */ }
        if (/["$`\\\r\n]/.test(dir)) advice.push(`Codex вне терминала (приложение, IDE) может не найти команду miksy: каталог ${dir} содержит " $ \` или \\ — в ~/.codex/.env не записан`);
        else if (foreign) advice.push(`Codex вне терминала (приложение, IDE) может не найти команду miksy, которой запускаются MCP-серверы проектов: ~/.codex/.env — ваш файл, miksy его не меняет. Допишите в него строку: ${line}`);
        else files.push({ base: "home", path: ".codex/.env", mode: "own", block: true, content: line + "\n" });
      }
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
    return { files, warnings, ...(advice.length && { advice }) };
  },
};
