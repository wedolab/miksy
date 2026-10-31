// Что Claude Code видит сейчас из ручных конфигов — для сравнения с тем, что сгенерирует miksy.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CurrentState } from "../../src/adapter";

type CurrentMcp = CurrentState["mcp"][string];

// Ключи проекта в ~/.claude.json. Claude хранит путь «как открыли»: «D:/work/x» из CLI, «D:\work\x»
// из Zed, «d:/…», другой регистр (Windows, macOS), путь через симлинк. Возвращает канонический ключ
// (каталог проекта, realpath) и все уже существующие ключи, указывающие на тот же каталог
import { canonical, samePath } from "../../src/paths";
function sameDir(key: string, dir: string, _os: string): boolean {
  try { return samePath(key, dir); } catch { return false; }
}

// Ключи projects из ~/.claude.json (файл бывает большим — разбор кешируется по mtime и размеру)
let keysCache: { stamp: string; keys: string[] } | null = null;
export function claudeProjects(home: string): string[] {
  const p = join(home, ".claude.json");
  if (!existsSync(p)) return [];
  const st = statSync(p);
  const stamp = `${p}|${st.mtimeMs}|${st.size}`;
  if (keysCache?.stamp !== stamp) keysCache = { stamp, keys: Object.keys(readJson(p)?.projects ?? {}) };
  return keysCache.keys;
}

export function projectKeys(dir: string, os: string, existing: string[]): { canonical: string; variants: string[] } {
  const key = canonical(dir);
  return { canonical: key, variants: existing.filter((k) => k !== key && sameDir(k, key, os)) };
}

// Битый JSON — как отсутствующий: сравнение и doctor не должны падать (sync сообщит конфликт)
export const readJson = (p: string) => {
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : undefined;
  } catch {
    return undefined;
  }
};

// Импорты вида «@путь» в CLAUDE.md (один уровень)
function withImports(file: string, home: string): string[] {
  const out = [file];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^@(\S+)$/);
    if (!m) continue;
    const p = m[1].startsWith("~") ? join(home, m[1].slice(1)) : join(dirname(file), m[1]);
    if (existsSync(p)) out.push(p.replaceAll("\\", "/"));
  }
  return out;
}

export function currentGlobal(home: string): CurrentState {
  const md = join(home, ".claude", "CLAUDE.md");
  const cfg = readJson(join(home, ".claude.json")) ?? {};
  const mcp: Record<string, CurrentMcp> = {};
  for (const [n, d] of Object.entries<Record<string, unknown>>(cfg.mcpServers ?? {})) mcp[n] = { source: "~/.claude.json (user)", def: d };
  return { instructionFiles: existsSync(md) ? withImports(md, home).map((x) => x.replaceAll("\\", "/")) : [], mcp };
}

// Проект: CLAUDE.md / CLAUDE.local.md / .mcp.json в каталоге и всех родителях + local scope.
// Ближний к проекту источник перекрывает дальний, local scope — всё.
export function currentProject(dir: string, home: string, os: string): CurrentState {
  const chain: string[] = [];
  for (let d = dir; ; d = dirname(d)) {
    chain.push(d);
    if (dirname(d) === d) break;
  }

  const instructionFiles: string[] = [];
  const mcp: Record<string, CurrentMcp> = {};
  for (const d of chain.reverse().map((x) => x.replaceAll("\\", "/"))) {
    for (const f of ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"]) {
      const p = join(d, f);
      if (existsSync(p)) instructionFiles.push(...withImports(p, home).map((x) => x.replaceAll("\\", "/")));
    }
    const servers = readJson(join(d, ".mcp.json"))?.mcpServers ?? {};
    for (const [n, def] of Object.entries<Record<string, unknown>>(servers)) mcp[n] = { source: join(d, ".mcp.json").replaceAll("\\", "/"), def };
  }

  const cfg = readJson(join(home, ".claude.json")) ?? {};
  const { canonical, variants } = projectKeys(dir, os, claudeProjects(home));
  for (const key of [canonical, ...variants]) {
    for (const [n, def] of Object.entries<Record<string, unknown>>(cfg.projects?.[key]?.mcpServers ?? {}))
      mcp[n] = { source: `~/.claude.json (local: ${key})`, def };
  }
  return { instructionFiles, mcp };
}
