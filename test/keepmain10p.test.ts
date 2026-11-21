// Круг 10p: setup --force, основным выбран новый каталог, а прежняя папка с проектами на месте — вопрос «Оставить её
// основной, а <новую> добавить ещё одной папкой с проектами?». «Да» (по умолчанию) — прежний остаётся основным (ветка,
// слои, ${WORKSPACE} — как были), новая — дополнительным корнем с веткой; «нет» — смена основного, короткий текст: что
// убрать в прежней и как передумать. Движок внутри новой папки — по умолчанию «нет». Вопроса нет, если прежней нет, она
// пуста или недоступна, одна папка внутри другой; без терминала основной не меняется. Диск прежнего не подключён — так
// и сказано. Мастер — в процессе, поддельная система (как test/fixes022e-helpers.ts)
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import type { Ask } from "../src/ask";
import { runCommand } from "../src/commands";
import { newBackupRun } from "../src/backup";
import { setup } from "../src/setup";
import { loadMachine } from "../src/load";
import { machineRoots } from "../src/roots";
import { cliFixture, put, expectCode, said } from "./helpers";
import { git, read, yamlRoots } from "./rootshelp";
import { sandboxEngine } from "./fixes022e-helpers";

type F = ReturnType<typeof cliFixture>;
const Q = /Оставить её основной/;
const layers = (f: F, p: string) => f.run(["explain", p]).out.match(/^Слои\s+(.*)$/m)?.[1] ?? "";
const rules = (file: string) => [...read(file).matchAll(/^# (\w+(?: \w+)?)$/gm)].map((m) => m[1]);

// Мастер с ответами по шаблонам вопросов (нет ответа — умолчание); ask null — без терминала. asked — заданные вопросы
function wizard(f: F, rules: [RegExp, (boolean | string | null)[]][] | null, engine = sandboxEngine(f.dir)) {
  const saved = { ...process.env }, cwd = process.cwd(), logs: string[] = [], asked: string[] = [];
  Object.assign(process.env, { MIKSY_CONFIG: f.config, HOME: f.home, USERPROFILE: f.home });
  process.chdir(f.dir);
  newBackupRun();
  const pick = (q: string) => { asked.push(q); const r = rules!.find(([re, a]) => re.test(q) && a.length); return r ? { hit: true, v: r[1].shift()! } : { hit: false, v: null }; };
  const ask: Ask | null = rules ? {
    yes: (q, def = false) => { const a = pick(q); return a.hit ? (a.v as boolean) : def; },
    line: (q) => { const a = pick(q); return a.hit ? (a.v as string | null) : null; },
    choose: (q, _o, def) => { const a = pick(q); return a.hit ? (a.v as string | null) : def ?? null; },
  } : null;
  const fake = { which: () => null, exec: () => 0, git: () => 0, userPath: { get: () => "", set: () => {} }, refreshPath: () => {} };
  const orig = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  try {
    const run = (cmd: string, args: string[], io: { ask?: Ask | null }) => runCommand(cmd, args, { ask: io.ask ?? ask });
    return { code: setup({ ask, force: true, run, sys: fake, engine, log: (s = "") => logs.push(s) }), out: logs.join("\n"), asked };
  } finally {
    console.log = orig; process.chdir(cwd); newBackupRun();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}
const roots = (f: F) => {
  const saved = process.env.MIKSY_CONFIG;
  process.env.MIKSY_CONFIG = f.config;
  try { return machineRoots(loadMachine(f.config)).map((r) => [r.path, r.tree]); }
  finally { if (saved === undefined) delete process.env.MIKSY_CONFIG; else process.env.MIKSY_CONFIG = saved; }
};

// Прежний основной ws (Org/p1, слой layers/tree/Org) и новая отдельная папка work (Team/p2, слой ветки work)
function base() {
  const f = cliFixture({ agents: ["claude"], projects: [] });
  const ws = `${f.dir}/ws`, work = `${f.dir}/work`;
  git(`${ws}/Org/p1`);
  git(`${work}/Team/p2`);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([ws])}agents: [claude]\n`);
  put(`${f.config}/layers/tree/Org/instructions/10.md`, "# org rule\n");
  put(`${f.config}/layers/tree/work/Team/instructions/20.md`, "# team rule\n");
  expectCode(f.run(["sync", "--all", "--yes"]), 0);
  return { f, ws, work };
}
const asks = (s: { asked: string[] }) => s.asked.filter((q) => Q.test(q));

test("«да» (по умолчанию): прежний остаётся основным, новая — ещё корнем с веткой; sync --all — у каждой папки свои слои", () => {
  const { f, ws, work } = base();
  const before = layers(f, `${ws}/Org/p1`);
  const s = wizard(f, [[/Корень workspace/, [work]], [/Есть ещё папки/, [null]], [/Записать настройки агентам/, [false]]]);
  expectCode(s, 0);
  expect(asks(s)).toEqual([`Прежняя папка с проектами ${ws} на месте, в ней есть проекты. Оставить её основной, а ${work} добавить ещё одной папкой с проектами? (нет — основной станет ${work}, как при переносе папки)`]);
  expect(s.out).toContain(`основной остаётся ${ws} (его ветка дерева слоёв, слои и \${WORKSPACE} — как были); ${work} — ещё одна папка с проектами:`);
  expect(s.out).toContain(`✓ ещё корень: ${work} → layers/tree/work`);
  expect(s.out).not.toMatch(/из workspace уходит|workspace меняется/);
  expect(roots(f)).toEqual([[ws, ""], [work, "work"]]);
  // Сквозной: после мастера sync --all — проекты обеих папок получают свои слои, прежний — те же, что до мастера
  const all = f.run(["sync", "--all"]);
  expectCode(all, 0);
  expect({ p1: layers(f, `${ws}/Org/p1`), p1rules: rules(`${ws}/Org/p1/CLAUDE.local.md`), p2rules: rules(`${work}/Team/p2/CLAUDE.local.md`) }, said(all))
    .toEqual({ p1: before, p1rules: ["workspace", "org rule"], p2rules: ["workspace", "team rule"] });
  expect(layers(f, `${work}/Team/p2`)).toContain("work/Team");
}, 300000);

test("«да», ветка — своя: ответ на вопрос ветки; занятая или неверная — папка не добавлена, основной прежний", () => {
  const { f, ws, work } = base();
  const s = wizard(f, [[/Корень workspace/, [work]], [Q, [true]], [/Ветка этой папки/, ["Side"]], [/Есть ещё папки/, [null]], [/Записать настройки агентам/, [false]]]);
  expectCode(s, 0);
  expect(roots(f)).toEqual([[ws, ""], [work, "Side"]]);
  const bad = base();
  const s2 = wizard(bad.f, [[/Корень workspace/, [bad.work]], [/Ветка этой папки/, ["a/../b"]], [/Есть ещё папки/, [null]], [/Записать настройки агентам/, [false]]]);
  expectCode(s2, 0);
  expect(s2.out).toContain(`${bad.work} не добавлена — добавить позже: miksy root add "${bad.work}"`);
  expect(roots(bad.f)).toEqual([[bad.ws, ""]]);
}, 300000);

test("«нет»: основным — новая папка, прежняя уходит; короткий текст без рецепта возврата", () => {
  const { f, ws, work } = base();
  const s = wizard(f, [[/Корень workspace/, [work]], [Q, [false]], [/Есть ещё папки/, [null]], [/Записать настройки агентам/, [false]]]);
  expectCode(s, 0);
  expect(roots(f)).toEqual([[work, ""]]);
  const line = s.out.split("\n").find((l) => l.includes("из workspace уходит"))!;
  expect(line).toBe(`  прежний основной ${ws} из workspace уходит: его проекты miksy больше не обновляет. Прежняя папка не нужна — уберите записанное в неё: miksy clean "<путь проекта>" в её проектах; если новая — её копия, файлы miksy с путями в ней (например, .codex/config.toml с \${WORKSPACE}) — конфликт, пока не выполните miksy sync "<путь проекта>" --force в её проектах (бэкап будет). Передумали — miksy setup --force ещё раз, корень workspace — ${ws} (на вопрос «Оставить её основной…», если он будет, — «нет»). \${WORKSPACE} в слоях теперь — ${work}`);
  // Дословно: clean в её проекте — файлов miksy там нет
  expectCode(f.run(["clean", `${ws}/Org/p1`]), 0);
  expect(read(`${ws}/Org/p1/CLAUDE.local.md`)).toBe("");
  // «Передумали» дословно: тот же мастер с прежней папкой, «нет» — основной снова прежний
  const back = wizard(f, [[/Корень workspace/, [ws]], [Q, [false]], [/Есть ещё папки/, [null]], [/Записать настройки агентам/, [false]]]);
  expectCode(back, 0);
  expect(roots(f)).toEqual([[ws, ""]]);
  expect(f.run(["sync", "--all"]).code).toBe(0);
  expect(rules(`${ws}/Org/p1/CLAUDE.local.md`)).toEqual(["workspace", "org rule"]);
}, 300000);

test("«нет»: ветка прежнего основного переходит к новому", () => {
  const f = cliFixture({ agents: ["claude"], projects: [] });
  const ws = `${f.dir}/ws`, work = `${f.dir}/work`;
  git(`${ws}/Org/p1`); git(`${work}/Team/p2`);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([{ path: ws, tree: "Main" }])}agents: [claude]\n`);
  const s = wizard(f, [[/Корень workspace/, [work]], [Q, [false]], [/Есть ещё папки/, [null]], [/Записать настройки агентам/, [false]]]);
  expectCode(s, 0);
  expect(s.out).toContain(`ветка layers/tree/Main перешла к новому основному ${work}; прежний основной ${ws} из workspace уходит`);
  expect(roots(f)).toEqual([[work, "Main"]]);
}, 300000);

test("движок лежит в новой папке (её скопировали или перенесли с ним) — по умолчанию «нет»", () => {
  const { f, ws, work } = base();
  const s = wizard(f, [[/Корень workspace/, [work]], [/Есть ещё папки/, [null]], [/Записать настройки агентам/, [false]]], sandboxEngine(work));
  expectCode(s, 0);
  expect(asks(s).length).toBe(1);
  expect(roots(f)).toEqual([[work, ""]]);
  expect(s.out).toContain(`прежний основной ${ws} из workspace уходит`);
}, 300000);

test("вопроса нет: прежнюю перенесли, она пуста (остались пустые папки проектов), одна папка внутри другой", () => {
  const cases: [string, (b: ReturnType<typeof base>) => string][] = [
    ["перенесли", (b) => { renameSync(b.ws, `${b.f.dir}/ws-moved`); return `${b.f.dir}/ws-moved`; }],
    ["пустые папки", (b) => { renameSync(b.ws, `${b.f.dir}/ws-moved`); mkdirSync(`${b.ws}/Org/p1`, { recursive: true }); return `${b.f.dir}/ws-moved`; }],
    ["новая внутри прежней", (b) => `${b.ws}/Org`],
    ["прежняя внутри новой", () => ""],
  ];
  for (const [label, pick] of cases) {
    const b = base();
    const target = pick(b) || b.f.dir;
    const s = wizard(b.f, [[/Корень workspace/, [target]], [/Есть ещё папки/, [null]], [/Записать настройки агентам/, [false]], [/Точно взять его/, [true]]]);
    expect({ label, code: s.code, asked: asks(s), main: roots(b.f)[0][0] }, s.out).toEqual({ label, code: 0, asked: [], main: target });
  }
}, 300000);

test("без терминала (--yes) основной не меняется и вопроса нет", () => {
  const { f, ws } = base();
  const s = wizard(f, null);
  expectCode(s, 0);
  expect(roots(f)).toEqual([[ws, ""]]);
  expect(s.out).not.toMatch(/Оставить её основной|из workspace уходит/);
}, 300000);

// Диск прежнего основного не подключён: не «перенесли — делать ничего не нужно», а прямо; вопроса нет (проверить нечего)
test("диск прежнего основного не подключён — так и сказано, без «делать ничего не нужно»", () => {
  const f = cliFixture({ agents: ["claude"], projects: [] });
  const work = `${f.dir}/work`;
  git(`${work}/Team/p2`);
  const free = process.platform === "win32" ? "QRSTUVWXYZ".split("").find((l) => !existsSync(`${l}:/`)) : "x";
  if (!free) return; // все буквы дисков заняты — проверить нечем
  const ws = process.platform === "win32" ? `${free}:/miksy-none-10p/ws` : `/Volumes/miksy-none-10p/ws`;
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([ws])}agents: [claude]\n`);
  const s = wizard(f, [[/Корень workspace/, [work]], [/Есть ещё папки/, [null]], [/Записать настройки агентам/, [false]]]);
  expectCode(s, 0);
  expect(asks(s)).toEqual([]);
  const line = s.out.split("\n").find((l) => l.includes(ws)) ?? "";
  expect(line).toBe(`  прежний основной ${ws} сейчас недоступен (нет диска) — его проекты miksy больше не обновляет. Если основной меняли только поэтому — это не нужно: недоступный корень miksy просто пропускает, пока диск не подключат; верните прежний — miksy setup --force ещё раз, корень workspace — ${ws} (на вопрос «Оставить её основной…», если он будет, — «нет»). \${WORKSPACE} в слоях теперь — ${work}`);
  expect(roots(f)[0][0]).toBe(work);
}, 300000);

test("новая папка — сам проект (git-репо): «да» — она не добавлена без явного согласия, основной прежний", () => {
  const { f, ws } = base();
  const repo = `${f.dir}/repo`;
  git(repo);
  const s = wizard(f, [[/Корень workspace/, [repo]], [/Есть ещё папки/, [null]], [/Записать настройки агентам/, [false]]]);
  expectCode(s, 0);
  expect(roots(f)).toEqual([[ws, ""]]);
  expect(s.out).toContain(`${repo} не добавлена — добавить позже: miksy root add "${repo}"`);
}, 300000);
