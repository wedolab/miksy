import { readFileSync } from "node:fs";
import type { Adapter, RenderedFile } from "../../src/adapter";
import { deliver, type Launcher, nativeServers } from "../../src/launch";
import { skillFiles } from "../../src/skillfiles";
import type { McpServer } from "../../src/types";
import { claudeProjects, currentGlobal, currentProject, projectKeys } from "./current";
import { teamCollection, trackedPaths } from "../../src/git";

export const HEADER = (layers: string[]) =>
  `<!-- Сгенерировано miksy (слои: ${layers.join(" → ")}). Не править вручную — изменения вносить в конфигурацию miksy (слои). -->`;

// Секреты: stdio — обёртка (в конфиге только путь), HTTP — headersHelper (скрипт печатает JSON
// заголовков); секрет в URL — мост
export function nativeMcp(s: McpServer, launch?: Launcher): Record<string, unknown> | null {
  const special = s.agents?.claude;
  if (special === "skip") return null;
  const d = deliver(s, launch, "helper");
  const base: Record<string, unknown> =
    d.kind === "stdio" ? { type: "stdio", command: d.command, args: [] }
    : d.kind === "helper" ? { type: "http", url: d.url, headersHelper: d.helper }
    : s.url ? { type: "http", url: s.url, ...(s.headers && { headers: s.headers }) }
    : { type: "stdio", command: s.command, args: s.args ?? [], ...(s.env && { env: s.env }) };
  return special ? { ...base, ...special.raw } : base;
}
export const claude: Adapter = {
  id: "claude",
  skillDirs: [".claude/skills"],
  nativeMcp,

  // Проверено вживую (2.1.310, фаза 2в): CLAUDE.md/CLAUDE.local.md/.claude/rules — из всех родительских
  // каталогов; .claude/skills — из родителей до git-корня (git-проект — только свои; одноимённый —
  // ближний); MCP local scope — только по точному пути
  inherits: (target) => ({ rules: true, skills: !target.git }),
  rulesFiles: ["CLAUDE.local.md", ".claude/rules/miksy.md"],
  httpSecrets: "helper",
  homeConfig: [".claude.json", ".claude/CLAUDE.md", ".claude/settings.json", ".claude/skills"],

  knownDirs(machine) {
    return claudeProjects(machine.home);
  },

  current(target, machine) {
    return target.scope === "global"
      ? currentGlobal(machine.home)
      : currentProject(target.dir, machine.home, machine.os);
  },

  render(cfg, target, machine, ctx) {
    const files: RenderedFile[] = [];
    const warnings: string[] = [];
    const isGlobal = target.scope === "global";

    // Инструкции: глобально — ~/.claude/CLAUDE.md, в проекте — CLAUDE.local.md (не коммитится).
    // Claude читает CLAUDE.local.md всех родительских каталогов: в цель с вложенными проектами не пишем,
    // кроме цели-группы — цели ниже неё получают только свой отрезок (ядро, Resolved.below)
    const inherited = target.scope === "project" && !!target.nested && !target.group;
    if (cfg.instructions.length && inherited)
      warnings.push("внутри есть другие проекты — CLAUDE.local.md не пишется: Claude загрузил бы его и во вложенных (MCP и skills записаны)");
    if (cfg.instructions.length && !inherited) {
      const body = cfg.instructions.map((i) => readFileSync(i.item.path, "utf8").trim()).join("\n\n");
      let path = isGlobal ? ".claude/CLAUDE.md" : "CLAUDE.local.md";
      if (!isGlobal && trackedPaths(target.dir, [path]).length) {
        if (teamCollection(target.dir, ".claude/rules")) {
          warnings.push("инструкции Claude не записаны: CLAUDE.local.md и .claude/rules версионирует команда");
          path = "";
        } else path = ".claude/rules/miksy.md";
      }
      if (path) files.push({
        base: isGlobal ? "home" : "project",
        path,
        mode: "own",
        ...(path !== ".claude/rules/miksy.md" && { block: true }),
        content: `${HEADER(cfg.layers)}\n\n${body}\n`,
      });
    }

    // Skills: ~/.claude/skills/<name> или <проект>/.claude/skills/<name>
    for (const { item } of cfg.skills) {
      for (const f of skillFiles(item, warnings)) {
        files.push({
          base: isGlobal ? "home" : "project",
          path: `.claude/skills/${item.name}/${f.rel}`,
          mode: "own",
          content: f.content,
          ...(f.executable && { executable: true }),
          ...(item.team && { team: true }),
        });
      }
    }

    // MCP: user scope (глобально) или local scope проекта — оба в ~/.claude.json
    const servers = nativeServers(cfg.mcp, "claude", nativeMcp, ctx?.launch, warnings);
    if (Object.keys(servers).length) {
      // Канонический ключ проекта создаётся; другие написания того же каталога (регистр, d:/D:, слэши,
      // симлинк) — только если Claude их уже завёл: он ищет MCP по пути, которым открыли проект
      if (isGlobal) files.push({ base: "home", path: ".claude.json", mode: "merge", format: "json", key: ["mcpServers"], data: servers });
      else {
        const existing = claudeProjects(machine.home);
        const { canonical, variants } = projectKeys(target.dir, machine.os, existing);
        if (!existing.includes(canonical) && !variants.length)
          warnings.push(`Claude ещё не открывал ${canonical}: MCP записаны под этим путём; если откроете проект по другому пути (симлинк, другой регистр) — повторите sync`);
        // headersHelper выполняется только в доверенном проекте: доверие и предупреждение о нём — ядро
        // (src/trust.ts, по итогу плана доверия)
        for (const [i, k] of [canonical, ...variants].entries())
          files.push({ base: "home", path: ".claude.json", mode: "merge", format: "json", key: ["projects", k, "mcpServers"], data: servers, ...(i > 0 && { optional: true }) });
      }
    }
    files.push(...(ctx?.launch?.files() ?? []));

    return { files, warnings };
  },
};
