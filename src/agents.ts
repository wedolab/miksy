// Агенты, которых знает miksy: единственное место в src/ со списком адаптеров (круг 10x). Добавить агента — папка
// adapters/<агент>/ и строка здесь; всё, что относится к агенту, — в его адаптере (src/adapter.ts)
import { claude } from "../adapters/claude";
import { codex } from "../adapters/codex";
import { antigravity } from "../adapters/antigravity";
import { opencode } from "../adapters/opencode";
import type { Adapter } from "./adapter";

export const ADAPTERS: Record<string, Adapter> = { claude, codex, opencode, antigravity };
