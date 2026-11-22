// Круг 10x: особенности агентов — только в adapters/<агент>/ (CLAUDE.local.md движка, «Особенности агентов — только в
// адаптерах»). Страж: в src/ нет сравнений с id агента, литералов id, путей файлов агентов, их переменных окружения и
// импортов адаптеров — кроме разрешённых мест. Строки с комментарием целиком не проверяются.
// ALLOWED — сколько находок допускается в файле. Пометка «10x-2» — временно: переносится в круге 10x-2, после него
// таких строк не остаётся
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ID = "claude|codex|opencode|antigravity|gemini";
const RULES: [string, RegExp][] = [
  ["сравнение с id агента", new RegExp(`[!=]==\\s*["'\`](?:${ID})["'\`]`)],
  ["литерал — id агента", new RegExp(`["'\`](?:${ID})["'\`]`)],
  ["путь файлов агента", /["'`]\/?\.(?:claude|codex|gemini|opencode|agents)(?:[/."'`])|["'`]\.config\/opencode|["'`]opencode\.jsonc?["'`]|["'`]\.claude\.json/],
  ["регулярка с путём агента", /\/[^/\n]*\\\.(?:claude|codex|gemini|opencode|agents)\b[^\n]*\/[gimsuy]*/],
  ["переменная окружения агента", /["'`](?:CLAUDE_CONFIG_DIR|CODEX_HOME|OPENCODE_\w*|GEMINI_\w*)["'`]/],
  ["импорт адаптера", /from\s+["']\.\.\/adapters\//],
];

const ALLOWED: Record<string, { count: number; why: string }> = {
  "agents.ts": { count: 4, why: "список адаптеров — единственное место" },
  "trust.ts": { count: 33, why: "10x-2: доверие Claude и Codex, одобрения .mcp.json — в адаптеры (trust?)" },
  "commands.ts": { count: 12, why: "10x-2: ветки доверия Claude (отметка «доверие ставил miksy»), miksy trust" },
  "doctor.ts": { count: 2, why: "10x-2: наследуемое доверие группы (Claude)" },
  "restore.ts": { count: 3, why: "10x-2: возврат серверов в ~/.claude.json — в адаптер Claude" },
  "load.ts": { count: 1, why: "10x-2: допустимые ключи trust: в слоях и machine.yaml — из адаптеров с доверием" },
  "resolve.ts": { count: 1, why: "10x-2: тип ключей trust: из слоёв" },
  "teamskills.ts": { count: 10, why: "10x-2: таблица разбора командных skills по умолчанию — снять вместе с правкой тестов разбора (читатели — явно)" },
};

function findings(file: string): string[] {
  const out: string[] = [];
  readFileSync(file, "utf8").split("\n").forEach((l, i) => {
    if (/^\s*\/\//.test(l)) return;
    const code = l.replace(/\s\/\/\s.*$/, "");
    for (const [name, rx] of RULES) if (rx.test(code)) { out.push(`${i + 1} [${name}] ${code.trim().slice(0, 120)}`); break; }
  });
  return out;
}

test("src/: знание о конкретных агентах — только в разрешённых местах (остальное — в adapters/<агент>/)", () => {
  const dir = join(import.meta.dir, "..", "src");
  const over: Record<string, string[]> = {};
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts")).sort()) {
    const hits = findings(join(dir, f));
    if (hits.length > (ALLOWED[f]?.count ?? 0)) over[f] = hits;
  }
  expect(over).toEqual({});
});

test("разрешённые места не пустуют: снятое из списка — убрать из ALLOWED (список 10x-2 после круга пуст)", () => {
  const dir = join(import.meta.dir, "..", "src");
  const stale = Object.entries(ALLOWED).filter(([f, a]) => findings(join(dir, f)).length < a.count).map(([f, a]) => `${f}: ${findings(join(dir, f)).length} < ${a.count}`);
  expect(stale).toEqual([]);
});
