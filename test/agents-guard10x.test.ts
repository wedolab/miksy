// Круг 10x: особенности агентов — только в adapters/<агент>/ (CLAUDE.local.md движка, «Особенности агентов — только в
// адаптерах»). Страж: в src/ нет сравнений с id агента, литералов id, обращений к свойствам и ключей с id агента, названий
// агентов, путей и имён файлов агентов, их переменных окружения и импортов адаптеров — кроме разрешённых мест. Строки с
// комментарием целиком и комментарии в конце строки не проверяются. Круг 10x-3: правила усилены (рецензия 10x-2); круг 11w —
// и формы: таблицы и поля конфигов агентов, каталоги агентов в регулярке, файлы правил агентов
// ALLOWED — сколько находок допускается в файле: список адаптеров и тексты для человека, где агенты названы как
// пример или пояснение (не знание, по которому работает код)
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ID = "claude|codex|opencode|antigravity|gemini";
const RULES: [string, RegExp][] = [
  ["сравнение с id агента", new RegExp(`[!=]==\\s*["'\`](?:${ID})["'\`]`)],
  ["литерал — id агента", new RegExp(`["'\`](?:${ID})["'\`]`)],
  ["свойство — id агента", new RegExp(`[\\w)\\]]\\??\\.(?:${ID})\\b(?![/\\w-])`)],
  ["ключ — id агента", new RegExp(`[{,]\\s*(?:${ID})\\s*:`)],
  ["название агента", /\b(?:Claude|Codex|Antigravity|Gemini)\b|\bopencode\b/],
  ["путь файлов агента", /["'`]\/?\.(?:claude|codex|gemini|opencode|agents)(?:[/."'`])|["'`]\.config\/opencode|["'`]opencode\.jsonc?["'`]|["'`]\.claude\.json/],
  ["файл агента", /\.mcp\.json|settings\.local\.json|config\.toml|\.claude\.json/],
  ["регулярка с путём агента", /\/[^/\n]*\\\.(?:claude|codex|gemini|opencode|agents)\b[^\n]*\/[gimsuy]*/],
  ["переменная окружения агента", /["'`](?:CLAUDE_CONFIG_DIR|CODEX_HOME|OPENCODE_\w*|GEMINI_\w*)["'`]/],
  ["импорт адаптера", /from\s+["']\.\.\/adapters\/|require\(["']\.\.\/adapters\//],
  // Круг 11w: знание агента по форме, а не по имени — таблицы и поля его конфигов, каталоги в регулярке-альтернативе,
  // файлы правил агентов (в текстах — через пример адаптера: rulesExample)
  ["таблица или поле агента", /\b(?:mcp_servers|trust_level|hasTrustDialogAccepted|developer_instructions|enabledMcpjsonServers|mcpServers)\b|\[\s*["'`]projects["'`]|\bdoc\.projects\b/],
  ["регулярка-альтернатива с каталогом агента", /\\\.\(\?:[^)\n]*\b(?:claude|codex|gemini|opencode|agents)\b/],
  ["файл правил агента", /\b(?:CLAUDE(?:\.local)?\.md|AGENTS\.md|GEMINI\.md)\b/],
];

const ALLOWED: Record<string, { count: number; why: string }> = {
  "agents.ts": { count: 4, why: "список адаптеров — единственное место" },
  "commands.ts": { count: 7, why: "справка (USAGE): перечень агентов, пример файлов и ключа trust; текст о файлах, которые остаются после «забыть»; строка explain о правилах родительских каталогов" },
  "registry.ts": { count: 2, why: "пояснения в предупреждениях о корнях: как агенты читают родительские каталоги" },
  "setup.ts": { count: 2, why: "пример файла с путями машины в тексте мастера о смене основного корня" },
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

// Круг 10x-3 (рецензия 10x-2): адаптер, загруженный первым, не ломается о цикл импортов адаптер → ядро → список
// адаптеров (src/agents.ts — ленивый). Каждый — в отдельном процессе
test("каждый адаптер импортируется первым без ошибки; список адаптеров после этого полный", () => {
  const root = join(import.meta.dir, "..").replaceAll("\\", "/");
  const ids = readdirSync(join(root, "adapters"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const res = ids.map((id) => {
    const code = `const m = await import(${JSON.stringify(`${root}/adapters/${id}/index.ts`)}); const { ADAPTERS } = await import(${JSON.stringify(`${root}/src/agents.ts`)}); ` +
      `console.log(JSON.stringify({ own: Object.values(m).filter((x) => x && x.id).map((x) => x.id), all: Object.values(ADAPTERS).map((a) => a.id) }))`;
    const r = Bun.spawnSync([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
    return { id, code: r.exitCode, err: r.stderr.toString().trim().split("\n")[0] ?? "", out: r.stdout.toString().trim() };
  });
  const all = JSON.stringify({ own: [], all: ["claude", "codex", "opencode", "antigravity"] });
  expect(res.map((r) => ({ id: r.id, code: r.code, err: r.err, out: r.out }))).toEqual(ids.map((id) => ({ id, code: 0, err: "", out: all.replace("[]", JSON.stringify([id])) })));
}, 60000);
