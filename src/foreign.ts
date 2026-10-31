// Добавки, сделанные агентами в обход слоёв: MCP в их конфигах и skills в их каталогах,
// которых нет в слоях miksy и которые не принадлежат команде проекта (не в git).
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Adapter, Target } from "./adapter";
import type { Manifest } from "./manifest";
import { repoOf, trackedPaths } from "./git";
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

import { canonical, pathKey, slash } from "./paths";

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

// MCP, которые агент видит для цели, но которые не сгенерировал miksy и не закоммитила команда
export function foreignMcp(adapter: Adapter, cfg: Resolved, target: Target, machine: Machine): ForeignMcp[] {
  if (!adapter.current) return [];
  const generated = new Set([
    // Сервер слоя для агента — всё, что не skip (с секретом nativeMcp без доставки не строится)
    ...cfg.mcp.filter(({ item }) => item.agents?.[adapter.id] !== "skip").map(({ item }) => item.name),
    ...(adapter.internalMcp ?? []),
  ]);
  const current = adapter.current(target, machine).mcp;
  return Object.entries(current)
    .filter(([name, { source }]) => !generated.has(name) && !teamOwned(source))
    .map(([name, { source, def }]) => ({ kind: "mcp" as const, agent: adapter.id, name, source: slash(source), def }));
}

// Skills в каталогах проекта, где их находят агенты: не в git и не записаны miksy
export function foreignSkills(projectDir: string, readers: Record<AgentId, string[]>, manifest: Manifest): ForeignSkill[] {
  // loadManifest уже канонизировал весь учёт: не обходим файлы всех целей для каждого проекта.
  const owned = new Set(Object.values(manifest.targets).flatMap((s) => Object.keys(s.files)));
  const dirs = [...new Set(Object.values(readers).flat())];
  const out: ForeignSkill[] = [];
  for (const rel of dirs) {
    const base = join(projectDir, rel);
    if (!existsSync(base) || !statSync(base).isDirectory()) continue; // бывает файлом (симлинк без поддержки)
    for (const e of readdirSync(base, { withFileTypes: true })) {
      if (!e.isDirectory() || !existsSync(join(base, e.name, "SKILL.md"))) continue;
      const skillMd = slash(join(base, e.name, "SKILL.md"));
      if (owned.has(pathKey(skillMd))) continue;
      if (teamOwned(skillMd)) continue;
      const seenBy = Object.keys(readers).filter((a) => readers[a].includes(rel));
      out.push({ kind: "skill", name: e.name, dir: slash(join(base, e.name)), seenBy });
    }
  }
  return out;
}
