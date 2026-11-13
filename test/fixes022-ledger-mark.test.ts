// Выпуск 0.2.2, A5: отметка версии в учёте (local/state/manifest.json, ключ engine) после отката. Правило (план
// out/8a-plan.md, таблица A5; ответ основного агента): отметку новее этой версии переписывает только setup — после шага
// «Команда miksy», когда команда miksy ведёт на эту копию движка. Меняется только значение верхнего ключа engine, остальное
// байт в байт (поля, которых эта версия не знает, тоже). sync без изменений, --dry-run, doctor — не пишут, сообщение
// «записан более новой версией» остаётся (вторая, необновлённая копия движка). Отметки нет или она не новее — как было
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter } from "node:path";
import { packageVersion } from "../src/version";
import { cliFixture, put } from "./helpers";
import { inProcess } from "./rootshelp";

const CLI = `${import.meta.dir}/../src/cli.ts`;
const VERSION = packageVersion();
const NEWER = /более новой версией движка/;
const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
type F = ReturnType<typeof cliFixture>;

// Команда miksy песочницы ($HOME/.bun/bin) — первой в PATH; other — каталог с чужой командой miksy перед ней
const pathFor = (f: F, other?: string) => [other, `${f.home}/.bun/bin`, process.env[pathKey]].filter(Boolean).join(delimiter);
const run = (f: F, args: string[], other?: string) => {
  const r = Bun.spawnSync([process.execPath, CLI, ...args], {
    cwd: f.dir, env: { ...process.env, MIKSY_CONFIG: f.config, HOME: f.home, USERPROFILE: f.home, [pathKey]: pathFor(f, other) },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
// setup в терминале (в этом процессе): на все вопросы — «нет» / Enter; answers: [] — прерван на первом вопросе (с --force это
// «Корень workspace», шаг 2 — до шага «Команда miksy» на любой ОС)
const terminal = (f: F, answers: false[] = Array(40).fill(false), args = ["setup"]) => {
  const saved = process.env[pathKey];
  process.env[pathKey] = pathFor(f);
  try { return inProcess(f, args, f.dir, answers); } finally { process.env[pathKey] = saved; }
};

const ledgerPath = (f: F) => `${f.config}/local/state/manifest.json`;
// Учёт с отметкой mark (undefined — без отметки) и полями, которых эта версия не знает; вложенный "engine" — раньше
// верхнего (меняется только верхний)
function prepare(mark: string | undefined): F {
  const f = cliFixture();
  // Команда miksy этой копии уже есть (обычный откат: тот же каталог движка); всё записано
  expect(run(f, ["setup", "--yes"]).code).toBe(0);
  expect(run(f, ["sync", "--global"]).code).toBe(0);
  expect(run(f, ["sync", "--all", "--yes"]).code).toBe(0);
  const { version, engine: _, ...rest } = JSON.parse(readFileSync(ledgerPath(f), "utf8"));
  const text = JSON.stringify({ future: { engine: mark ?? "9.9.9", list: [1, "два"] }, version, ...(mark === undefined ? {} : { engine: mark }), ...rest, tail: "x" }, null, 2) + "\n";
  writeFileSync(ledgerPath(f), text);
  return f;
}
const read = (f: F) => readFileSync(ledgerPath(f), "utf8");
const rewritten = (before: string) => before.replace(/("version": \d+,\n  "engine": )"9\.9\.9"/, `$1"${VERSION}"`);

test("A5: setup переписывает отметку новее этой версии — только её; остальные команды и случаи — учёт байт в байт", () => {
  const got: unknown[] = [], want: unknown[] = [];
  const check = (n: string, mark: string | undefined, act: (f: F) => { code: number | null; out: string; err?: string }, changes: boolean) => {
    const f = prepare(mark);
    const before = read(f);
    const r = act(f);
    const after = read(f);
    const doc = run(f, ["doctor"]).out;
    const msg = /✓ учёт: отметка версии 9\.9\.9 → /.test(r.out);
    got.push({ n, code: r.code, err: r.err ?? "", changed: after !== before, exact: after === (changes ? rewritten(before) : before), msg, newerAfter: NEWER.test(doc) });
    want.push({ n, code: r.code, err: "", changed: changes, exact: true, msg: changes, newerAfter: mark === "9.9.9" && !changes });
    if (changes) {
      // JSON нового = JSON старого, кроме engine
      const a = JSON.parse(after), b = JSON.parse(before);
      expect({ ...a, engine: 0 }).toEqual({ ...b, engine: 0 });
      expect(a.engine).toBe(VERSION);
    }
  };
  // Отметка новее: setup в любом режиме — переписывает
  check("setup --yes", "9.9.9", (f) => run(f, ["setup", "--yes"]), true);
  check("setup --yes --force", "9.9.9", (f) => run(f, ["setup", "--yes", "--force"]), true);
  check("setup --yes --backup", "9.9.9", (f) => run(f, ["setup", "--yes", "--backup"]), true);
  check("setup в терминале", "9.9.9", (f) => terminal(f), true);
  // Не пишут: sync без изменений, --dry-run, doctor; прерванный setup; команда miksy в PATH — чужая (другая копия)
  check("sync --global без изменений", "9.9.9", (f) => run(f, ["sync", "--global"]), false);
  check("sync --all без изменений", "9.9.9", (f) => run(f, ["sync", "--all", "--yes"]), false);
  check("sync --global --dry-run", "9.9.9", (f) => run(f, ["sync", "--global", "--dry-run"]), false);
  check("doctor", "9.9.9", (f) => run(f, ["doctor"]), false);
  check("setup прерван до шага «Команда miksy»", "9.9.9", (f) => { const r = terminal(f, [], ["setup", "--force"]); expect(r.questions[0]).toMatch(/Корень workspace/); return { ...r, err: r.err.includes("лишний вопрос") ? "" : r.err }; }, false);
  check("setup, а miksy в PATH — другая копия", "9.9.9", (f) => {
    const other = `${f.dir}/other-bin`;
    mkdirSync(other, { recursive: true });
    put(`${other}/${process.platform === "win32" ? "miksy.cmd" : "miksy"}`, "echo other\n");
    if (process.platform !== "win32") Bun.spawnSync(["chmod", "+x", `${other}/miksy`]);
    return run(f, ["setup", "--yes"], other);
  }, false);
  // Отметка не новее или её нет — setup не трогает
  check("setup, отметка старее", "0.0.1", (f) => run(f, ["setup", "--yes"]), false);
  check("setup, отметка этой версии", VERSION, (f) => run(f, ["setup", "--yes"]), false);
  check("setup, учёт без отметки", undefined, (f) => run(f, ["setup", "--yes"]), false);
  expect(got).toEqual(want);
}, 600000);

test("A5: sync с изменениями — пишет учёт и свою отметку, как раньше", () => {
  const f = prepare("9.9.9");
  put(`${f.config}/layers/global/instructions/01.md`, "# ещё\n");
  expect(run(f, ["sync", "--global"]).code).toBe(0);
  expect(JSON.parse(read(f)).engine).toBe(VERSION);
  expect(run(f, ["doctor"]).out).not.toMatch(NEWER);
}, 120000);
