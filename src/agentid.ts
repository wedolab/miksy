// Идентификаторы агентов. Прежнее имя — рабочий синоним во всех входных данных (local/machine.yaml
// agents, --agent, agents: в MCP слоёв, учёт): старые конфигурации работают без правок, doctor
// подсказывает переименовать. Antigravity — агент, Gemini — модель (miksy с моделями не работает)
import { existsSync } from "node:fs";
import { join } from "node:path";
import { slash } from "./paths";
import { ADAPTERS } from "./agents";

// Прежнее имя → нынешний id (адаптер: aliases)
export const aliasesOf = (): Record<string, string> =>
  Object.fromEntries(Object.values(ADAPTERS).flatMap((a) => (a.aliases ?? []).map((old) => [old, a.id])));

export const agentId = (id: string) => aliasesOf()[id] ?? id;

// Какие агенты есть на машине: команда в PATH или (отдельно) только каталог настроек — агент бывает только в
// редакторе (Zed), без команды в PATH (адаптер: detect)
export function detectAgents(home: string, which: (cmd: string) => string | null = (c) => Bun.which(c)) {
  const inPath: string[] = [], dirOnly: { id: string; dir: string }[] = [];
  for (const { id, detect } of Object.values(ADAPTERS)) {
    if (detect.commands.some((c) => which(c))) { inPath.push(id); continue; }
    const dir = detect.dirs.map((d) => join(home, d)).find((d) => existsSync(d));
    if (dir) dirOnly.push({ id, dir: slash(dir) });
  }
  return { inPath, dirOnly };
}

// Агент найден на машине, но его нет в agents (local/machine.yaml): без терминала miksy его не подключает (круг 10i) —
// подсказка, как подключить; убрал пользователь сам — делать ничего не нужно
export function connectHint(n: number): string {
  const it = n === 1 ? "его" : "их";
  return `Подключить: miksy setup в терминале (спросит) или допишите ${it} в agents в local/machine.yaml, затем miksy sync --global и miksy sync --all. Убрали ${it} сами — ничего делать не нужно`;
}
export const notConnectedText = (ids: string[]): string =>
  `${ids.length === 1 ? `найден агент ${ids[0]}, его нет` : `найдены агенты ${ids.join(", ")}, их нет`} в agents (local/machine.yaml) — miksy ${ids.length === 1 ? "его" : "их"} не настраивает. ${connectHint(ids.length)}`;
