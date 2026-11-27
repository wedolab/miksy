// Что opencode видит сейчас из ручных конфигов — для сравнения с тем, что сгенерирует miksy.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { CurrentState } from "../../src/adapter";
import { readJsoncText } from "../../src/jsonc";

// JSONC-толерантное чтение (комментарии, концевые запятые, BOM) — общий разбор src/jsonc.ts (круг 11y); не разобрать — {}
export function readJsonc(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  try { return readJsoncText(readFileSync(path, "utf8")); } catch { return {}; }
}

// Конфиги opencode в каталоге: root/opencode.json(.jsonc) и .opencode/opencode.json — все сливаются
export function configsOf(dir: string): { path: string; cfg: Record<string, any> }[] {
  return ["opencode.json", "opencode.jsonc", join(".opencode", "opencode.json")]
    .map((rel) => {
      const path = join(dir, rel).replaceAll("\\", "/");
      return { path, cfg: existsSync(path) ? readJsonc(path) : null };
    })
    .filter((c): c is { path: string; cfg: Record<string, any> } => c.cfg !== null);
}

// Ссылки instructions из конфигов: локальные файлы (не glob, не URL); относительные — от каталога конфига
function instructionRefs(configs: { path: string; cfg: Record<string, any> }[], home: string): string[] {
  const out: string[] = [];
  for (const { path, cfg } of configs)
    for (const ref of (cfg.instructions ?? []) as string[]) {
      if (!ref || /[*?[]/.test(ref) || /^https?:/.test(ref)) continue;
      const p = ref.startsWith("~") ? join(home, ref.slice(1)) : isAbsolute(ref) ? ref : join(dirname(path), ref);
      if (existsSync(p) && statSync(p).isFile()) out.push(p.replaceAll("\\", "/"));
    }
  return out;
}

function serversOf(configs: { path: string; cfg: Record<string, any> }[]): CurrentState["mcp"] {
  const mcp: CurrentState["mcp"] = {};
  for (const { path, cfg } of configs)
    for (const [name, def] of Object.entries<Record<string, unknown>>(cfg.mcp ?? {}))
      if ((def as Record<string, unknown>)?.enabled !== false) mcp[name] = { source: path, def };
  return mcp;
}

export function currentGlobal(home: string): CurrentState {
  const dir = join(home, ".config", "opencode");
  const configs = configsOf(dir);
  const instructionFiles: string[] = [];
  const md = join(dir, "AGENTS.md").replaceAll("\\", "/");
  const claude = join(home, ".claude", "CLAUDE.md").replaceAll("\\", "/");
  if (existsSync(md)) instructionFiles.push(md);
  else if (existsSync(claude)) instructionFiles.push(claude); // Claude-совместимость: запасной глобальный файл
  instructionFiles.push(...instructionRefs(configs, home));
  return { instructionFiles, mcp: serversOf(configs) };
}

// Как у claude/codex: глобальные источники сравниваются отдельно, проектный снимок — только файлы проекта
export function currentProject(dir: string, home: string): CurrentState {
  const configs = configsOf(dir);
  const instructionFiles: string[] = [];
  const agents = join(dir, "AGENTS.md").replaceAll("\\", "/");
  const claude = join(dir, "CLAUDE.md").replaceAll("\\", "/");
  if (existsSync(agents)) instructionFiles.push(agents);
  else if (existsSync(claude)) instructionFiles.push(claude); // Claude-совместимость (если нет AGENTS.md)
  instructionFiles.push(...instructionRefs(configs, home));
  return { instructionFiles, mcp: serversOf(configs) };
}
