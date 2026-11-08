// Идентификаторы агентов. Прежнее имя — рабочий синоним во всех входных данных (local/machine.yaml
// agents, --agent, agents: в MCP слоёв, учёт): старые конфигурации работают без правок, doctor
// подсказывает переименовать. Antigravity — агент, Gemini — модель (miksy с моделями не работает)
export const AGENT_ALIASES: Record<string, string> = { gemini: "antigravity" };

export const agentId = (id: string) => AGENT_ALIASES[id] ?? id;
