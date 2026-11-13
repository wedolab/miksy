// Выпуск 0.2.2, круг 8d (тесты рецензента A, `out/review022d-a`): E3, B №2, B №3, B №4, B №5 — тексты setup --force при
// смене основного корня, выполненные дословно; слои (miksy explain) проектов всех корней до и после. Рецензия A №3 (B №4 при
// бывшем дополнительном корне), №4 (подсказка clean), №5 (проект без git). Мастер в процессе — с поддельной системой (sys)
import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Ask } from "../src/ask";
import { setup } from "../src/setup";
import { runCommand } from "../src/commands";
import { newBackupRun } from "../src/backup";
import { cliFixture, put } from "./helpers";
import { git, inProcess, yamlRoots } from "./rootshelp";

type F = ReturnType<typeof cliFixture>;
function inSetup(f: F, rules: [RegExp, (boolean | string | null)[]][]) {
  const saved = { ...process.env }, cwd = process.cwd(), logs: string[] = [];
  Object.assign(process.env, { MIKSY_CONFIG: f.config, HOME: f.home, USERPROFILE: f.home });
  process.chdir(f.dir);
  newBackupRun();
  const pick = (q: string) => { const r = rules.find(([re, a]) => re.test(q) && a.length); return r ? { hit: true, v: r[1].shift()! } : { hit: false, v: null }; };
  const ask: Ask = {
    yes: (q, def = false) => { const a = pick(q); return a.hit ? (a.v as boolean) : def; },
    line: (q) => { const a = pick(q); return a.hit ? (a.v as string | null) : null; },
    choose: (q, _o, def) => { const a = pick(q); return a.hit ? (a.v as string | null) : def ?? null; },
  };
  const sys = { which: () => null, exec: () => 0, git: () => 0, userPath: { get: () => "", set: () => {} }, refreshPath: () => {} };
  const orig = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  try {
    const run = (cmd: string, args: string[], io: { ask?: Ask | null }) => runCommand(cmd, args, { ask: io.ask ?? ask });
    return { code: setup({ ask, force: true, run, sys, log: (s = "") => logs.push(s) }), out: logs.join("\n") };
  } finally {
    console.log = orig; process.chdir(cwd); newBackupRun();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}
const layers = (f: F, p: string) => f.run(["explain", p]).out.match(/^Слои\s+(.*)$/m)?.[1] ?? `(explain: ${f.run(["explain", p]).out.split("\n").slice(0, 2).join(" ")})`;
const rules = (file: string) => existsSync(file) ? [...readFileSync(file, "utf8").matchAll(/^# (\w+(?: \w+)?)$/gm)].map((m) => m[1]).join(",") : "(нет файла)";

// E3: основной корень с веткой Main, вложенные корни: ws/Inner (Code) и ws/Grp/Deep (Deep). Шаги дословно
test("E3: основной с веткой и два вложенных корня — шаги дословно, слои прежние", () => {
  const f = cliFixture({ projects: [] });
  const ws = `${f.dir}/ws`, ws2 = `${f.dir}/disk2/ws`;
  git(`${ws}/Org/p1`); git(`${ws}/Inner/Acme/site`); git(`${ws}/Grp/Deep/d1`);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([{ path: ws, tree: "Main" }, { path: `${ws}/Inner`, tree: "Code" }, { path: `${ws}/Grp/Deep`, tree: "Deep" }])}agents: [claude]\n`);
  put(`${f.config}/layers/tree/Main/Org/instructions/10.md`, "# org rule\n");
  put(`${f.config}/layers/tree/Main/Grp/instructions/12.md`, "# grp rule\n");
  put(`${f.config}/layers/tree/Code/instructions/30.md`, "# code rule\n");
  put(`${f.config}/layers/tree/Deep/instructions/40.md`, "# deep rule\n");
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  const before = { p1: layers(f, `${ws}/Org/p1`), site: layers(f, `${ws}/Inner/Acme/site`), d1: layers(f, `${ws}/Grp/Deep/d1`) };
  mkdirSync(`${f.dir}/disk2`, { recursive: true });
  renameSync(ws, ws2);
  const s = inSetup(f, [[/Корень workspace/, [ws2]], [/Есть ещё папки/, [null]], [/Записать настройки агентам/, [true]], [/Заменить эти файлы/, [false]]]);
  const line = s.out.split("\n").find((l) => l.includes("нет на месте")) ?? "(нет строки)";
  // Дословно: «поправьте path: этих корней в local/machine.yaml (workspace) на новое место» — новое место из строки
  const file = `${f.config}/local/machine.yaml`;
  let text = readFileSync(file, "utf8");
  for (const m of line.matchAll(/(\S+) \(ветка \w+; если папку перенесли сюда — теперь ([^)]+)\)/g)) text = text.replace(m[1], () => m[2]);
  writeFileSync(file, text);
  const a = f.run(["sync", "--all"]);
  const after = { p1: layers(f, `${ws2}/Org/p1`), site: layers(f, `${ws2}/Inner/Acme/site`), d1: layers(f, `${ws2}/Grp/Deep/d1`) };
  const doc = f.run(["doctor"]);
  expect({ named: (line.match(/; если папку перенесли сюда — теперь /g) ?? []).length, after, code: a.code, doctor: doc.code }).toEqual({ named: 2, after: { p1: before.p1.replace(ws, ws2), site: before.site, d1: before.d1 }, code: 0, doctor: 0 });
}, 300000);

// B №2: прежняя папка осталась, проектов-git в ней нет, но есть проект без git, где работал агент (реестр ~/.claude.json)
test("B №2: в прежнем основном только проект без git (из реестра агента) — «проектов нет … делать ничего не нужно»?", () => {
  const f = cliFixture({ projects: [] });
  const ws = `${f.dir}/ws`, work = `${f.dir}/work`;
  mkdirSync(`${ws}/Notes/n1`, { recursive: true });
  git(`${work}/Team/p2`);
  put(`${f.home}/.claude.json`, JSON.stringify({ projects: { [`${ws}/Notes/n1`]: {} } }));
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([ws])}agents: [claude]\n`);
  put(`${f.config}/layers/tree/Notes/instructions/10.md`, "# notes rule\n");
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  const synced = rules(`${ws}/Notes/n1/CLAUDE.local.md`);
  const s = inSetup(f, [[/Корень workspace/, [work]], [/Есть ещё папки/, [null]], [/Записать настройки агентам/, [false]]]);
  const line = s.out.split("\n").find((l) => /прежн/.test(l)) ?? "(нет строки)";
  expect({ synced, saysNothingToDo: /делать ничего не нужно/.test(line), leaves: /больше не обновляет/.test(line) }).toEqual({ synced: "workspace,notes rule", saysNothingToDo: false, leaves: true });
}, 300000);

// B №3: прежний основной на «отключённом диске» → setup --force → work → sync --all → clean --forget → диск вернулся → clean
// → подсказка дословно. У нового основного та же папка Org (как B №4)
test("B №3: подсказка clean забытого проекта вне workspace — дословно; слои нового основного", () => {
  const f = cliFixture({ projects: [] });
  const ws = `${f.dir}/ws`, away = `${f.dir}/ws-away`, work = `${f.dir}/work`;
  git(`${ws}/Org/p1`); git(`${work}/Org/p2`);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([ws])}agents: [claude]\n`);
  put(`${f.config}/layers/tree/Org/instructions/10.md`, "# org rule\n");
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  renameSync(ws, away); // диск отключён
  const s = inSetup(f, [[/Корень workspace/, [work]], [/Есть ещё папки/, [null]], [/Записать настройки агентам/, [true]], [/Заменить эти файлы/, [false]]]);
  const said = s.out.split("\n").find((l) => /нет на месте/.test(l)) ?? "(нет)";
  const p2before = layers(f, `${work}/Org/p2`);
  const forget = inProcess(f, ["clean", `${ws}/Org/p1`, "--forget"]);
  renameSync(away, ws); // диск подключили
  const c = f.run(["clean", `${ws}/Org/p1`]);
  const hint = c.out + c.err;
  // Дословно (рецензия A круга 8d, №4): root add прежнего основного с любой новой веткой, layers/tree не переносить; затем
  // строки sync; clean из подсказки
  expect(hint).toContain("ветка — любая новая, которой нет в layers/tree. Слои его проектов под неё скопируйте, а не переносите");
  const add = f.run(["root", "add", ws, "--tree", "Old", "--yes"]);
  for (const l of hint.split("\n").filter((x) => /^\s+miksy sync /.test(x))) for (const part of l.trim().split("; ")) {
    const args = [...part.matchAll(/"([^"]+)"|(\S+)/g)].map((m) => m[1] ?? m[2]).slice(1);
    f.run(args);
  }
  const c2 = f.run(["clean", `${ws}/Org/p1`]);
  expect(f.run(["root", "remove", ws]).code).toBe(0); // «после clean его можно снова убрать (root remove)»
  f.run(["sync", "--all"]);
  const p2after = layers(f, `${work}/Org/p2`);
  expect({ add: add.code, hintNoBack: !/как подсказал тот setup/.test(hint), cleaned: c2.code, p1: existsSync(`${ws}/Org/p1/CLAUDE.local.md`) ? readFileSync(`${ws}/Org/p1/CLAUDE.local.md`, "utf8") : false, p2: p2after })
    .toEqual({ add: 0, hintNoBack: true, cleaned: 0, p1: false, p2: p2before });
}, 300000);

// B №5: «папку скопировали» — дословно: clean в проектах прежней копии, sync <проект> --force в проектах новой
test("B №5: скопировали — clean в прежней копии, sync --force в новой: конфликтов нет, слои прежние", () => {
  const f = cliFixture({ agents: ["claude", "codex"], projects: [] });
  const ws = `${f.dir}/ws`, ws2 = `${f.dir}/copy/ws`;
  git(`${ws}/Org/p1`); git(`${ws}/Lab/q`);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([ws])}agents: [claude, codex]\n`);
  put(`${f.config}/layers/tree/Org/instructions/10.md`, "# org rule\n");
  put(`${f.config}/layers/tree/Org/mcp/tool.yaml`, "name: tool\ncommand: echo\nargs: [\"${WORKSPACE}/x\"]\n");
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  const before = { p1: layers(f, `${ws}/Org/p1`), q: layers(f, `${ws}/Lab/q`) };
  mkdirSync(`${f.dir}/copy`, { recursive: true });
  cpSync(ws, ws2, { recursive: true });
  const s = inSetup(f, [[/Корень workspace/, [ws2]], [/Есть ещё папки/, [null]], [/Записать настройки агентам/, [false]]]);
  const line = s.out.split("\n").find((l) => /уходит/.test(l)) ?? "(нет)";
  const g = f.run(["sync", "--global"]);
  const a1 = f.run(["sync", "--all"]);
  const cleans = [`${ws}/Org/p1`, `${ws}/Lab/q`].map((p) => inProcess(f, ["clean", p]));
  const forces = [`${ws2}/Org/p1`, `${ws2}/Lab/q`].map((p) => f.run(["sync", p, "--force"]));
  const a2 = f.run(["sync", "--all"]);
  const doc = f.run(["doctor"]);
  const after = { p1: layers(f, `${ws2}/Org/p1`), q: layers(f, `${ws2}/Lab/q`) };
  expect({ a2: a2.code, doctor: doc.code, after }).toEqual({ a2: 0, doctor: 0, after: { p1: before.p1.replace(ws, ws2), q: before.q.replace(ws, ws2) } });
}, 300000);

// B №4: основным стал дополнительный корень со СВОЕЙ веткой (Clients), у него тоже папка Org. Его проекты берут слои из
// layers/tree/Clients/…, а не из layers/tree/Org — перенос layers/tree/Org их не задевает. Утверждение «перенос снял бы слои
// и с её проектов» — верно ли? Проверка: рецепт backHint (как печатался до 8d) дословно → слои drive/Org/x не меняются
test("B №4: новый основной — бывший дополнительный корень с веткой; та же папка Org", () => {
  const f = cliFixture({ projects: [] });
  const ws = `${f.dir}/ws`, drive = `${f.dir}/drive`;
  git(`${ws}/Org/p1`); git(`${drive}/Org/x`);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([ws, { path: drive, tree: "Clients" }])}agents: [claude]\n`);
  put(`${f.config}/layers/tree/Org/instructions/10.md`, "# org rule\n");
  put(`${f.config}/layers/tree/Clients/Org/instructions/20.md`, "# clients org rule\n");
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  const before = { p1: layers(f, `${ws}/Org/p1`), x: layers(f, `${drive}/Org/x`) };
  const s = inSetup(f, [[/Корень workspace/, [drive]], [/Есть ещё папки/, [null]], [/Записать настройки агентам/, [false]]]);
  const line = s.out.split("\n").find((l) => /уходит/.test(l)) ?? "(нет)";
  // Рецепт дословно (как в 0.2.1/8c): слои ws (layers/tree/Org) — под новую ветку прежнего, затем root add
  const tree = "Ws";
  mkdirSync(`${f.config}/layers/tree/${tree}`, { recursive: true });
  renameSync(`${f.config}/layers/tree/Org`, `${f.config}/layers/tree/${tree}/Org`);
  const add = f.run(["root", "add", ws, "--tree", tree, "--yes"]);
  f.run(["sync", "--all"]);
  const after = { p1: layers(f, `${ws}/Org/p1`), x: layers(f, `${drive}/Org/x`) };
  expect({ claim: /снял бы слои и с её проектов/.test(line), xUnchanged: after.x === before.x }).toEqual({ claim: false, xUnchanged: true });
}, 300000);

// Повторная проверка 1 круга 8d, новая находка: подсказка clean дословно в терминале — root add спрашивает «Записать
// настройки проектам workspace сейчас?» («да» по умолчанию: sync --all переписал бы остальные проекты прежнего основного по
// пустой ветке). Подсказка велит ответить «нет» и на вопрос root remove — тоже «нет»: другой проект (p3) не тронут
test("подсказка clean дословно в терминале: root add и root remove — «нет», как в подсказке; p3 и p2 не тронуты", () => {
  const f = cliFixture({ projects: [] });
  const ws = `${f.dir}/ws`, away = `${f.dir}/ws-away`, work = `${f.dir}/work`;
  git(`${ws}/Org/p1`); git(`${ws}/Org/p3`); git(`${work}/Org/p2`);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([ws])}agents: [claude]\n`);
  put(`${f.config}/layers/tree/Org/instructions/10.md`, "# org rule\n");
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  renameSync(ws, away);
  inSetup(f, [[/Корень workspace/, [work]], [/Есть ещё папки/, [null]], [/Записать настройки агентам/, [true]], [/Заменить эти файлы/, [false]]]);
  const p2before = layers(f, `${work}/Org/p2`);
  inProcess(f, ["clean", `${ws}/Org/p1`, "--forget"]);
  renameSync(away, ws);
  const p3before = rules(`${ws}/Org/p3/CLAUDE.local.md`);
  const c = f.run(["clean", `${ws}/Org/p1`]);
  const hint = c.out + c.err;
  expect(hint).toContain("На вопрос root add «Записать настройки проектам workspace сейчас?» ответьте «нет»");
  expect(hint).toContain("на вопрос root remove «Убрать записанное miksy в эти проекты сейчас?» — тоже «нет»");
  const add = inProcess(f, ["root", "add", ws, "--tree", "Old"], f.dir, [false]);
  for (const l of hint.split("\n").filter((x) => /^\s+miksy sync /.test(x))) for (const part of l.trim().split("; ")) f.run([...part.matchAll(/"([^"]+)"|(\S+)/g)].map((m) => m[1] ?? m[2]).slice(1));
  const rm = inProcess(f, ["root", "remove", ws], f.dir, [false, false, false]);
  f.run(["sync", "--all"]);
  expect({ add: add.code, rm: rm.code, p1: rules(`${ws}/Org/p1/CLAUDE.local.md`), p3: rules(`${ws}/Org/p3/CLAUDE.local.md`), p2: layers(f, `${work}/Org/p2`) })
    .toEqual({ add: 0, rm: 0, p1: "(нет файла)", p3: p3before, p2: p2before });
}, 300000);
