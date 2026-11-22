// Агенты, которых знает miksy: единственное место в src/ со списком адаптеров (круг 10x). Добавить агента — папка
// adapters/<агент>/ и строка здесь; всё, что относится к агенту, — в его адаптере (src/adapter.ts).
// Список ленивый (круг 10x-3): адаптеры загружаются при первом обращении, а не при импорте этого модуля. Адаптеры сами
// импортируют модули ядра, которые обращаются к списку (src/trust.ts, src/apply.ts), — при обычном импорте первый
// загруженный адаптер получал бы список с недозагруженными соседями (ReferenceError)
import type { Adapter } from "./adapter";

let loaded: Record<string, Adapter> | null = null;
const load = (): Record<string, Adapter> => (loaded ??= {
  claude: require("../adapters/claude").claude,
  codex: require("../adapters/codex").codex,
  opencode: require("../adapters/opencode").opencode,
  antigravity: require("../adapters/antigravity").antigravity,
});

// Как обычный объект id → адаптер (ADAPTERS[id], Object.values, Object.keys, in)
export const ADAPTERS: Record<string, Adapter> = new Proxy({} as Record<string, Adapter>, {
  get: (_t, k) => (typeof k === "string" ? load()[k] : undefined),
  has: (_t, k) => k in load(),
  ownKeys: () => Reflect.ownKeys(load()),
  getOwnPropertyDescriptor: (_t, k) => {
    const d = Reflect.getOwnPropertyDescriptor(load(), k);
    return d && { ...d, configurable: true };
  },
});
