// Идентификаторы агентов. Прежнее имя — рабочий синоним во всех входных данных (local/machine.yaml
// agents, --agent, agents: в MCP слоёв, учёт): старые конфигурации работают без правок, doctor
// подсказывает переименовать. Antigravity — агент, Gemini — модель (miksy с моделями не работает)
import { existsSync } from "node:fs";
import { join } from "node:path";
import { slash } from "./paths";

export const AGENT_ALIASES: Record<string, string> = { gemini: "antigravity" };

export const agentId = (id: string) => AGENT_ALIASES[id] ?? id;

// Как найти агента: команда в PATH
export const AGENT_COMMANDS: Record<string, string[]> = {
  claude: ["claude"],
  codex: ["codex"],
  opencode: ["opencode"],
  antigravity: ["agy", "antigravity"],
};

// Каталоги настроек агента в домашнем каталоге: агент бывает только в редакторе (Zed), без команды в PATH
const AGENT_DIRS: Record<string, string[]> = {
  claude: [".claude"],
  codex: [".codex"],
  opencode: [".config/opencode"],
  antigravity: [".gemini/antigravity-cli", ".gemini/antigravity-ide", ".gemini/antigravity"],
};

// Какие агенты есть на машине: команда в PATH или (отдельно) только каталог настроек
export function detectAgents(home: string, which: (cmd: string) => string | null = (c) => Bun.which(c)) {
  const inPath: string[] = [], dirOnly: { id: string; dir: string }[] = [];
  for (const [id, cmds] of Object.entries(AGENT_COMMANDS)) {
    if (cmds.some((c) => which(c))) { inPath.push(id); continue; }
    const dir = AGENT_DIRS[id].map((d) => join(home, d)).find((d) => existsSync(d));
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
