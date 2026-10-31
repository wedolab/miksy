import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CurrentState } from "../../src/adapter";
import { parseToml } from "../../src/toml";

export const readConfig = (path: string): Record<string, any> =>
  existsSync(path) ? parseToml(readFileSync(path, "utf8")) : {};

// В каждом каталоге Codex читает только первый непустой файл; @-импортов нет.
export function instructionFile(dir: string, fallbacks: string[] = []): string | undefined {
  return ["AGENTS.override.md", "AGENTS.md", ...fallbacks]
    .map((name) => join(dir, name))
    .find((path) => existsSync(path) && readFileSync(path, "utf8").trim().length > 0)
    ?.replaceAll("\\", "/");
}

function servers(config: Record<string, any>, source: string): CurrentState["mcp"] {
  return Object.fromEntries(Object.entries<Record<string, unknown>>(config.mcp_servers ?? {})
    .filter(([, def]) => def.enabled !== false)
    .map(([name, def]) => [name, { source: source.replaceAll("\\", "/"), def }]));
}

export function currentGlobal(home: string): CurrentState {
  const dir = join(home, ".codex");
  const file = instructionFile(dir);
  const path = join(dir, "config.toml");
  const config = readConfig(path);
  return { instructionFiles: file ? [file] : [], mcp: servers(config, path),
    ...(typeof config.developer_instructions === "string" && { instructionTexts: [{ source: path.replaceAll("\\", "/") + " (developer_instructions)", text: config.developer_instructions }] }) };
}

// Как у Claude, проектный снимок не включает глобальный слой: он сравнивается отдельно.
// Target.dir — корень проекта; родительские AGENTS.md выше git-корня не загружаются.
export function currentProject(dir: string, home: string, os = process.platform === "win32" ? "windows" : "linux"): CurrentState {
  const global = readConfig(join(home, ".codex", "config.toml"));
  const norm = (s: string) => os === "windows" ? s.replaceAll("\\", "/").toLowerCase() : s;
  const trust = Object.entries<any>(global.projects ?? {}).find(([key]) => norm(key) === norm(dir))?.[1]?.trust_level;
  const path = join(dir, ".codex", "config.toml");
  const config = trust === "trusted" ? readConfig(path) : {};
  const file = instructionFile(dir, config.project_doc_fallback_filenames ?? global.project_doc_fallback_filenames ?? []);
  return { instructionFiles: file ? [file] : [], mcp: servers(config, path),
    ...(typeof config.developer_instructions === "string" && { instructionTexts: [{ source: path.replaceAll("\\", "/") + " (developer_instructions)", text: config.developer_instructions }] }) };
}
