import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Adapter, RenderedFile } from "../../src/adapter";
import { deliver, type Launcher, nativeServers } from "../../src/launch";
import { skillFiles } from "../../src/skillfiles";
import type { McpServer } from "../../src/types";
import { currentGlobal, currentProject, strictJson } from "./current";
import { keepOwn } from "../../src/paths";

export const HEADER = (layers: string[]) =>
  `<!-- Сгенерировано miksy (слои: ${layers.join(" → ")}). Не править вручную — изменения вносить в конфигурацию miksy (слои). -->`;

// Подсказка в правилах плагина (только если у цели есть MCP): у Antigravity инструменты MCP — не
// отдельные, а через общий call_mcp_tool, и сервер плагина называется <плагин>_<имя>. Без подсказки
// модель (Gemini Flash, agy 1.4.7) отвечает «инструмент не подключён», хотя сервер поднят
export const mcpHint = (names: string[]) =>
  `## MCP-серверы проекта (Antigravity)\n\nСерверы этого проекта подключены плагином miksy: их инструменты вызываются через \`call_mcp_tool\`, имя сервера — \`miksy_<имя>\`: ${names.map((n) => `\`miksy_${n}\``).join(", ")}.`;

// Antigravity не подставляет ничего в mcp_config.json (ни env, ни файлы): stdio с секретом —
// обёртка, HTTP с секретом — мост (stdio-сервер miksy, пересылающий на HTTP с заголовками)
export function nativeMcp(s: McpServer, launch?: Launcher): Record<string, unknown> | null {
  const special = s.agents?.antigravity;
  if (special === "skip") return null;
  const d = deliver(s, launch, "bridge");
  const base: Record<string, unknown> =
    d.kind === "stdio" ? { command: d.command, args: [] }
    : s.url ? { url: s.url, ...(s.headers && { headers: s.headers }) }
    : { command: s.command, args: s.args ?? [], ...(s.env && { env: s.env }) };
  return special ? { ...base, ...special.raw } : base;
}

export const antigravity: Adapter = {
  id: "antigravity",
  // Проверено вживую (2026-10-10): Antigravity ищет проектные skills в .agents/skills/
  // .gemini/skills в коде и исполняемом файле не поддерживается
  skillDirs: [".agents/skills"],
  homeConfig: [".gemini/GEMINI.md", ".gemini/config", ".gemini/antigravity-ide/mcp_config.json", ".gemini/antigravity-cli/mcp_config.json"],
  nativeMcp,
  httpSecrets: "bridge",

  knownDirs(machine) {
    const p = join(machine.home, ".gemini", "projects.json");
    if (!existsSync(p)) return [];
    try {
      const data = JSON.parse(readFileSync(p, "utf8"));
      return Object.keys(data.projects ?? {}).map((k) => k.replaceAll("\\", "/"));
    } catch {
      return [];
    }
  },

  current: (target, machine) =>
    target.scope === "global" ? currentGlobal(machine.home) : currentProject(target.dir, machine.home),

  render(cfg, target, machine, ctx) {
    const files: RenderedFile[] = [];
    const warnings: string[] = [];
    const isGlobal = target.scope === "global";
    const body = cfg.instructions.map((i) => readFileSync(i.item.path, "utf8").trim()).join("\n\n");
    const hasInstructions = cfg.instructions.length > 0;
    const hasSkills = cfg.skills.length > 0;
    const servers = nativeServers(cfg.mcp, "antigravity", nativeMcp, ctx?.launch, warnings);
    const kept = !isGlobal && keepOwn(ctx, join(target.dir, ".agents/plugins/miksy/mcp_config.json"));
    const hasMcp = Object.keys(servers).length > 0 || (isGlobal ? !!ctx?.keep?.length : kept);
    // Серверы плагина (и оставленные keep-ом записанные раньше) — для подсказки call_mcp_tool
    const pluginServers = isGlobal ? [] : [...new Set([...Object.keys(servers), ...(kept ? ctx?.keep ?? [] : [])])].sort();

    // 1. Проектный плагин: манифест .agents/plugins/miksy/plugin.json
    if (!isGlobal && (hasInstructions || hasSkills || hasMcp)) {
      files.push({
        base: "project",
        path: ".agents/plugins/miksy/plugin.json",
        mode: "own",
        content: JSON.stringify({ name: "miksy" }, null, 2) + "\n",
      });
    }

    // 2. Инструкции (у проекта с MCP — и подсказка call_mcp_tool, даже без своих правил)
    if (hasInstructions || pluginServers.length) {
      if (isGlobal) {
        // Глобальные правила: ~/.gemini/GEMINI.md читается и Antigravity CLI, и Antigravity IDE
        files.push({
          base: "home",
          path: ".gemini/GEMINI.md",
          mode: "own",
          block: true,
          content: `${HEADER(cfg.layers)}\n\n${body}\n`,
        });
      } else {
        // Проектные правила: rules/AGENTS.md плагина miksy (.agents/plugins/miksy/rules/AGENTS.md)
        const text = [body, ...(pluginServers.length ? [mcpHint(pluginServers)] : [])].filter(Boolean).join("\n\n");
        files.push({
          base: "project",
          path: ".agents/plugins/miksy/rules/AGENTS.md",
          mode: "own",
          content: `${HEADER(cfg.layers)}\n\n${text}\n`,
        });
      }
    }

    // 3. Skills: глобально -> ~/.gemini/config/skills/<name>/
    //            проект   -> .agents/plugins/miksy/skills/<name>/
    for (const { item } of cfg.skills) {
      for (const f of skillFiles(item, warnings)) {
        files.push({
          base: isGlobal ? "home" : "project",
          path: isGlobal
            ? `.gemini/config/skills/${item.name}/${f.rel}`
            : `.agents/plugins/miksy/skills/${item.name}/${f.rel}`,
          mode: "own",
          content: f.content,
          ...(f.executable && { executable: true }),
          ...(item.team && { team: true }),
        });
      }
    }

    // 4. MCP:
    if (isGlobal) {
      if (hasMcp) {
        // Настройки CLI и IDE хранятся раздельно:
        // CLI читает ~/.gemini/config/mcp_config.json
        // IDE читает ~/.gemini/antigravity-ide/mcp_config.json
        const configs = [
          { path: ".gemini/config/mcp_config.json", label: "CLI" },
          { path: ".gemini/antigravity-ide/mcp_config.json", label: "IDE" },
        ];
        for (const { path } of configs) {
          const abs = join(machine.home, path);
          if (existsSync(abs) && !strictJson(abs)) {
            warnings.push(`mcp antigravity: ${path} не парсится как строгий JSON (JSONC-комментарии? — DESIGN §11); серверы не записаны`);
          } else {
            files.push({
              base: "home",
              path,
              mode: "merge",
              format: "json",
              key: ["mcpServers"],
              data: servers,
            });
          }
        }
      }
      files.push(...(ctx?.launch?.files() ?? []));
    } else if (hasMcp) {
      files.push(...(ctx?.launch?.files() ?? []));
      // Проектный MCP пишется в mcp_config.json плагина miksy
      files.push({
        base: "project",
        path: ".agents/plugins/miksy/mcp_config.json",
        mode: "own",
        mcp: { format: "json", key: "mcpServers" },
        content: JSON.stringify({ mcpServers: servers }, null, 2) + "\n",
      });
    }

    return { files, warnings };
  },
};
