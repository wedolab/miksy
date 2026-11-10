// Добавки, сделанные агентами в обход слоёв: MCP в их конфигах и skills в их каталогах,
// которых нет в слоях miksy и которые не принадлежат команде проекта (не в git).
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Adapter, Target } from "./adapter";
import { type Manifest, sha, type TargetState } from "./manifest";
import { readFileSync } from "node:fs";
import { repoOf, trackedPaths } from "./git";
import { coveredBy, miksyExcludeLines } from "./apply";
import type { AgentId } from "./teamskills";
import type { Machine, Resolved } from "./types";

export interface ForeignMcp {
  kind: "mcp";
  agent: string;
  name: string;
  source: string; // где агент его хранит
  def: Record<string, unknown>; // определение в формате агента
}

export interface ForeignSkill {
  kind: "skill";
  name: string;
  dir: string; // абсолютный путь каталога skill
  seenBy: string[]; // какие агенты его находят
}

import { canonical, inside, pathKey, slash } from "./paths";

// Принадлежит ли файл команде: отслеживается git того репо, где лежит (в т.ч. родительского),
// сам или через закоммиченную ссылку выше по пути
// Сбой git — считаем командным: не предлагаем поднять в слой то, о чём ничего не известно
function teamOwned(file: string): boolean {
  const f = slash(file);
  if (!/^[A-Za-z]:\/|^\//.test(f) || !existsSync(f)) return false;
  try {
    const top = repoOf(dirname(f));
    if (!top) return false;
    const rel = slash(relative(top, canonical(f)));
    const parts = rel.split("/");
    const candidates = parts.map((_, i) => parts.slice(0, i + 1).join("/"));
    return trackedPaths(top, candidates).length > 0;
  } catch {
    return true;
  }
}

// Сервер записал miksy (учёт цели state): имя среди своих ключей общих файлов (~/.claude.json и т. п.) и таблиц TOML
// или файл целиком свой (хеш на диске — записанный: .codex/config.toml проекта, opencode.json, mcp_config.json).
// Убран из слоёв, а sync ещё не запускали, — это «устарело» (sync уберёт), а не добавка агента (выпуск 0.2.1, A16).
// Учёта цели нет («забыть», диск вернулся): файл проекта под строкой блока miksy в .git/info/exclude — тоже его (как у
// skills). При учёте решают его ключи и записанный хеш: сервер, дописанный пользователем в файл miksy, — его добавка
// (рецензия 0.2.1 A, п. 1)
function miksyServer(state: TargetState | undefined, target: Target, name: string, source: string): boolean {
  if (!state && target.scope === "project" && /^[A-Za-z]:\/|^\//.test(source) && inside(source, target.dir)) {
    const hidden = miksyExcludeLines(target.dir);
    if (hidden.length && coveredBy(hidden, slash(relative(target.dir, source)))) return true;
  }
  if (!state) return false;
  if (Object.values(state.merges).some((keys) => Object.values(keys).some((names) => names.includes(name)))) return true;
  if (Object.values(state.toml ?? {}).some((t) => t.names.includes(name))) return true;
  if (state.ownMcp?.[pathKey(source)]?.includes(name)) return true;
  const recorded = state.files[pathKey(source)];
  try { return !!recorded && recorded === sha(readFileSync(source, "utf8")); } catch { return false; }
}

// Серверы, которые miksy записал в свои own-файлы цели (TargetState.ownMcp): файл на диске — записанный (хеш тот же)
// — его серверы; правленый пользователем (конфликт, не перезаписан) — прежний список; файлов, которых больше нет в
// учёте, — нет
export function ownMcpOf(adapter: Adapter, target: Target, machine: Machine, state: TargetState, prev?: TargetState): Record<string, string[]> | undefined {
  const out: Record<string, string[]> = {};
  const same = (p: string) => { try { return state.files[p] === sha(readFileSync(p, "utf8")); } catch { return false; } };
  let current: Record<string, { source: string }> = {};
  try { current = adapter.current?.(target, machine).mcp ?? {}; } catch { /* конфиг не читается — прежний список */ }
  for (const [name, { source }] of Object.entries(current)) {
    const key = pathKey(source);
    if (state.files[key] && same(key)) (out[key] ??= []).push(name);
  }
  for (const [key, list] of Object.entries(prev?.ownMcp ?? {})) if (state.files[key] && !out[key] && !same(key)) out[key] = [...list];
  for (const list of Object.values(out)) list.sort();
  return Object.keys(out).length ? out : undefined;
}

// MCP, которые агент видит для цели, но которые не сгенерировал miksy и не закоммитила команда
export function foreignMcp(adapter: Adapter, cfg: Resolved, target: Target, machine: Machine, state?: TargetState): ForeignMcp[] {
  if (!adapter.current) return [];
  const generated = new Set([
    // Сервер слоя для агента — всё, что не skip (с секретом nativeMcp без доставки не строится)
    ...cfg.mcp.filter(({ item }) => item.agents?.[adapter.id] !== "skip").map(({ item }) => item.name),
    ...(adapter.internalMcp ?? []),
  ]);
  const current = adapter.current(target, machine).mcp;
  return Object.entries(current)
    .filter(([name, { source }]) => !generated.has(name) && !miksyServer(state, target, name, source) && !teamOwned(source))
    .map(([name, { source, def }]) => ({ kind: "mcp" as const, agent: adapter.id, name, source: slash(source), def }));
}

// Skills в каталогах проекта, где их находят агенты: не в git и не записаны miksy
export function foreignSkills(projectDir: string, readers: Record<AgentId, string[]>, manifest: Manifest): ForeignSkill[] {
  // loadManifest уже канонизировал весь учёт: не обходим файлы всех целей для каждого проекта.
  const owned = new Set(Object.values(manifest.targets).flatMap((s) => Object.keys(s.files)));
  const dirs = [...new Set(Object.values(readers).flat())];
  // Каталог skill под строкой блока miksy в .git/info/exclude — skill записал miksy (учёт забыт — clean --forget,
  // диск вернулся: sync возьмёт его обратно), а не агент в обход слоёв: adopt не советуем
  const hidden = miksyExcludeLines(projectDir);
  const out: ForeignSkill[] = [];
  for (const rel of dirs) {
    const base = join(projectDir, rel);
    if (!existsSync(base) || !statSync(base).isDirectory()) continue; // бывает файлом (симлинк без поддержки)
    for (const e of readdirSync(base, { withFileTypes: true })) {
      if (!e.isDirectory() || !existsSync(join(base, e.name, "SKILL.md"))) continue;
      const skillMd = slash(join(base, e.name, "SKILL.md"));
      if (owned.has(pathKey(skillMd))) continue;
      if (hidden.length && coveredBy(hidden, slash(relative(projectDir, skillMd)))) continue;
      if (teamOwned(skillMd)) continue;
      const seenBy = Object.keys(readers).filter((a) => readers[a].includes(rel));
      out.push({ kind: "skill", name: e.name, dir: slash(join(base, e.name)), seenBy });
    }
  }
  return out;
}
