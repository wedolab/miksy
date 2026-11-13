// Выпуск 0.2.2, круг 8f, G1 и G2 (проверка 8e, находки 1 и 2; тесты рецензента out/check022e). Мастер в процессе — поддельная система, движок — копия (fixes022e-helpers)
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { cliFixture, put } from "./helpers";
import { git, read, yamlRoots } from "./rootshelp";
import { inSetup } from "./fixes022e-helpers";

type F = ReturnType<typeof cliFixture>;
const layers = (f: F, p: string) => f.run(["explain", p]).out.match(/^Слои\s+(.*)$/m)?.[1] ?? "";
const say = (s: { out: string }) => s.out.split("\n").find((l) => /из workspace уходит/.test(l)) ?? "";

// G1. Вложенный корень с «естественной» веткой (ветка = имя папки, как предлагает root add по Enter): его слои —
// layers/tree/Clients = layers/tree/<папка>. Единственная общая папка с новым основным — Clients → на d8 она в списке
// одноимённых (рецепта нет), в 8e исключена → рецепт «Вернуть его: 1) … layers/tree/<папка> перенесите …»
test("G1: вложенный корень с веткой = имя папки — остаётся в одноимённых, рецепта переноса нет, слои прежние", () => {
  const f = cliFixture({ agents: ["claude"], projects: [] });
  const ws = `${f.dir}/ws`, work = `${f.dir}/work`;
  git(`${ws}/Org/p1`); git(`${ws}/Clients/Acme/site`); git(`${work}/Clients/q`); git(`${work}/Lab/x`);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([ws, { path: `${ws}/Clients`, tree: "Clients" }])}agents: [claude]\n`);
  put(`${f.config}/layers/tree/Clients/instructions/10.md`, "# clients rule\n");
  put(`${f.config}/layers/tree/Org/instructions/10.md`, "# org rule\n");
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  const before = { site: layers(f, `${ws}/Clients/Acme/site`), q: "" };
  const s = inSetup(f, [[/Корень workspace/, [work]], [/Есть ещё папки/, [null]], [/Записать настройки агентам/, [false]]]);
  f.run(["sync", "--all"]);
  before.q = layers(f, `${work}/Clients/q`);
  const line = say(s);
  // Рецепта переноса нет — переносить нечего; слои обоих проектов после sync --all прежние
  f.run(["sync", "--all"]);
  expect({ recipe: line.includes("Вернуть его: 1)"), sameListed: /с тем же именем \([^)]*Clients/.test(line), site: layers(f, `${ws}/Clients/Acme/site`), q: layers(f, `${work}/Clients/q`) })
    .toEqual({ recipe: false, sameListed: true, site: before.site, q: before.q });
}, 300000);

// 2. Новый основной — другая папка (не копия), внутри прежнего — вложенный корень: копии нет, а текст говорит о ней
test("G2: новый основной — другая папка, копии нет — о копии и переходе только условно", () => {
  const f = cliFixture({ agents: ["claude"], projects: [] });
  const ws = `${f.dir}/ws`, work = `${f.dir}/work`;
  git(`${ws}/Org/p1`); git(`${ws}/Inner/Acme/site`); git(`${work}/Lab/x`);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([ws, { path: `${ws}/Inner`, tree: "Code" }])}agents: [claude]\n`);
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  const s = inSetup(f, [[/Корень workspace/, [work]], [/Есть ещё папки/, [null]], [/Записать настройки агентам/, [false]]]);
  const line = say(s);
  // Всё о копии и переходе — только с условием «если папку скопировали или перенесли»; копии нет — пути копии нет
  expect({
    unconditional: line.includes("Переходите на новую папку целиком"), conditional: line.includes("Если папку скопировали или перенесли и вы переходите на новую целиком"),
    copyPath: line.includes(`${work}/Inner`), notCopy: line.includes("Новая папка — не копия прежней: path: не меняйте"),
  }).toEqual({ unconditional: false, conditional: true, copyPath: false, notCopy: true });
}, 300000);

// G2: у нового основного (не копии) — своя одноимённая папка Clients: её путь — только «если новая папка — копия прежней»,
// совет перевести path: на неё — только при этом условии
test("G2: у нового основного своя одноимённая папка — совет о копии только условный", () => {
  const f = cliFixture({ agents: ["claude"], projects: [] });
  const ws = `${f.dir}/ws`, work = `${f.dir}/work`;
  git(`${ws}/Org/p1`); git(`${ws}/Clients/Acme/site`); git(`${work}/Clients/q`);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([ws, { path: `${ws}/Clients`, tree: "Code" }])}agents: [claude]\n`);
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  const s = inSetup(f, [[/Корень workspace/, [work]], [/Есть ещё папки/, [null]], [/Записать настройки агентам/, [false]]]);
  const line = say(s);
  expect({
    copy: line.includes(`(ветка Code; если новая папка — копия прежней, его копия — ${work}/Clients)`),
    plain: line.includes(`в новой папке — ${work}/Clients`),
  }).toEqual({ copy: true, plain: false });
}, 300000);

// 3. Перенесли (robocopy /MOV — пустые папки проектов остались), подсказки дословно → прежние слои обоих корней
test("F1: перенесли, пустые папки остались — подсказки дословно, слои прежние", () => {
  const f = cliFixture({ agents: ["claude", "codex"], projects: [] });
  const ws = `${f.dir}/ws`, ws2 = `${f.dir}/disk2/ws`;
  git(`${ws}/Org/p1`); git(`${ws}/Inner/Acme/site`); git(`${ws}/Lab/Inner2/x`); git(`${ws}/Lab/p3`);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([ws, { path: `${ws}/Inner`, tree: "Code" }, { path: `${ws}/Lab/Inner2`, tree: "Code2" }])}agents: [claude, codex]\n`);
  put(`${f.config}/map.yaml`, "global:\n  - { use: global }\nlayers:\n  - { match: \"Org/**\", use: orgx }\n");
  put(`${f.config}/layers/orgx/instructions/50.md`, "# orgx rule\n");
  put(`${f.config}/layers/tree/Lab/instructions/10.md`, "# lab rule\n");
  put(`${f.config}/layers/tree/Code/instructions/30.md`, "# code rule\n");
  put(`${f.config}/layers/tree/Code2/instructions/30.md`, "# code2 rule\n");
  put(`${f.config}/layers/tree/Code/mcp/tool.yaml`, "name: tool\ncommand: echo\nargs: [\"${WORKSPACE}/x\"]\n");
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  const P = ["Org/p1", "Inner/Acme/site", "Lab/Inner2/x", "Lab/p3"];
  const before = P.map((p) => layers(f, `${ws}/${p}`));
  mkdirSync(`${f.dir}/disk2`, { recursive: true });
  renameSync(ws, ws2);
  for (const d of P) mkdirSync(`${ws}/${d}`, { recursive: true });
  const s = inSetup(f, [[/Корень workspace/, [ws2]], [/Есть ещё папки/, [null]], [/Записать настройки агентам/, [false]]]);
  const line = say(s);
  const file = `${f.config}/local/machine.yaml`;
  writeFileSync(file, readFileSync(file, "utf8").replaceAll(`${ws}/Inner`, `${ws2}/Inner`).replaceAll(`${ws}/Lab/Inner2`, `${ws2}/Lab/Inner2`));
  f.run(["sync", "--global"]);
  const all1 = f.run(["sync", "--all"]);
  for (const p of P) f.run(["clean", `${ws}/${p}`]);
  for (const p of P) f.run(["sync", `${ws2}/${p}`, "--force"]);
  const all = f.run(["sync", "--all"]);
  const after = P.map((p) => layers(f, `${ws2}/${p}`));
  expect({ code: all.code, after, oldLeft: P.map((p) => read(`${ws}/${p}/CLAUDE.local.md`)) }).toEqual({ code: 0, after: before, oldLeft: ["", "", "", ""] });
}, 300000);

// Проверка круга 8f, №1: ветка вложенного корня лежит внутри layers/tree/<папка прежнего основного> (Clients/Main, Org/X) —
// перенос layers/tree/<папка> задел бы её: папка в списке одноимённых, рецепта переноса нет
for (const [dir, tree] of [["Clients", "Clients/Main"], ["Inner", "Org/X"], ["Clients", "clients"]] as const)
  test(`G1: вложенный корень ${dir} с веткой ${tree} — рецепта переноса нет`, () => {
    const f = cliFixture({ agents: ["claude"], projects: [] });
    const ws = `${f.dir}/ws`, work = `${f.dir}/work`;
    git(`${ws}/Org/p1`); git(`${ws}/${dir}/Acme/site`); git(`${work}/${dir}/q`); git(`${work}/Org/p2`);
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([ws, { path: `${ws}/${dir}`, tree }])}agents: [claude]\n`);
    put(`${f.config}/layers/tree/${tree}/instructions/10.md`, "# nested rule\n");
    put(`${f.config}/layers/tree/Org/instructions/10.md`, "# org rule\n");
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    const s = inSetup(f, [[/Корень workspace/, [work]], [/Есть ещё папки/, [null]], [/Записать настройки агентам/, [false]]]);
    expect(say(s).includes("Вернуть его: 1)")).toBe(false);
  }, 300000);

// Проверка круга 8f, №2: прежнего основного нет (диск не подключён), новый основной — другая папка со своей Inner: о новом
// месте вложенного корня — только «если папку перенесли сюда», совет поправить path: — только условно
test("G2: «нет на месте», у нового основного своя одноимённая папка — новое место и совет только условно", () => {
  const f = cliFixture({ agents: ["claude"], projects: [] });
  const ws = `${f.dir}/ws`, work = `${f.dir}/work`;
  git(`${ws}/Org/p1`); git(`${ws}/Inner/Acme/site`); git(`${work}/Inner/q`);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([ws, { path: `${ws}/Inner`, tree: "Code" }])}agents: [claude]\n`);
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  renameSync(ws, `${ws}.off`);
  const s = inSetup(f, [[/Корень workspace/, [work]], [/Есть ещё папки/, [null]], [/Записать настройки агентам/, [false]]]);
  const line = s.out.split("\n").find((l) => l.includes("нет на месте"))!;
  expect({
    plain: line.includes(`, теперь — ${work}/Inner`), cond: line.includes(`если папку перенесли сюда — теперь ${work}/Inner`),
    advice: line.includes("Если папку перенесли в новую — на вопрос"), notMoved: line.includes("Новая папка — не та, куда перенесли прежнюю: path: не меняйте"),
  }).toEqual({ plain: false, cond: true, advice: true, notMoved: true });
}, 300000);
