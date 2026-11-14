// Выпуск 0.2.3, A10 («Открытое» 8d, 8f): подсказки setup --force.
// - Основным стал бывший дополнительный корень (ветка Clients), у прежнего основного (без ветки) — папка Clients: рецепт
//   «Вернуть его» перенёс бы layers/tree/Clients — слои нового основного. Рецепта нет, причина названа; слои проектов
//   нового основного после sync прежние.
// - Несколько вложенных корней — множественное число («их копии»).
// Мастер в процессе — поддельная система, движок — копия (fixes022e-helpers)
import { expect, test } from "bun:test";
import { cliFixture, put } from "./helpers";
import { git, yamlRoots } from "./rootshelp";
import { inSetup } from "./fixes022e-helpers";

type F = ReturnType<typeof cliFixture>;
const layers = (f: F, p: string) => f.run(["explain", p]).out.match(/^Слои\s+(.*)$/m)?.[1] ?? "";
const say = (s: { out: string }) => s.out.split("\n").find((l) => /из workspace уходит/.test(l)) ?? "";

test("A10: папка прежнего основного = ветка нового основного — рецепта переноса нет, слои нового основного целы", () => {
  const f = cliFixture({ agents: ["claude"], projects: [] });
  const ws = `${f.dir}/ws`, drive = `${f.dir}/drive`;
  git(`${ws}/Clients/c1`); git(`${drive}/Org/x`);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([ws, { path: drive, tree: "Clients" }])}agents: [claude]\n`);
  put(`${f.config}/layers/tree/Clients/instructions/20.md`, "# clients rule\n");
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  const before = layers(f, `${drive}/Org/x`);
  const s = inSetup(f, [[/Корень workspace/, [drive]], [/Есть ещё папки/, [null]], [/Записать настройки агентам/, [false]]]);
  const line = say(s);
  f.run(["sync", "--all"]);
  expect({
    recipe: line.includes("Вернуть его: 1)") || line.includes("Вернуть его: miksy root add"),
    why: line.includes("его папка Clients совпадает с веткой нового основного (layers/tree/Clients), перенос layers/tree/Clients снял бы его слои"),
    x: layers(f, `${drive}/Org/x`),
  }).toEqual({ recipe: false, why: true, x: before });
}, 300000);

test("A10: два вложенных корня — множественное число в тексте о копиях", () => {
  const f = cliFixture({ agents: ["claude"], projects: [] });
  const ws = `${f.dir}/ws`, work = `${f.dir}/work`;
  git(`${ws}/Org/p1`); git(`${ws}/Inner/a`); git(`${ws}/Inner2/b`); git(`${work}/Inner/q`); git(`${work}/Inner2/r`);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([ws, { path: `${ws}/Inner`, tree: "Code" }, { path: `${ws}/Inner2`, tree: "Code2" }])}agents: [claude]\n`);
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  const s = inSetup(f, [[/Корень workspace/, [work]], [/Есть ещё папки/, [null]], [/Записать настройки агентам/, [false]]]);
  const line = say(s);
  expect({ plural: line.includes("одноимённая папка в ней — не их копии"), singular: line.includes("не его копия)") }).toEqual({ plural: true, singular: false });
}, 300000);

// Рецензия 9a, №4: папка прежнего основного (без ветки) совпадает с веткой ДРУГОГО дополнительного корня — рецепта нет
test("A10+: основным стал бывший дополнительный (Clients); у прежнего основного папка Lab = ветка третьего корня", () => {
  const f = cliFixture({ agents: ["claude"], projects: [] });
  const ws = `${f.dir}/ws`, drive = `${f.dir}/drive`, lab = `${f.dir}/lab3`;
  git(`${ws}/Lab/c1`); git(`${drive}/Org/x`); git(`${lab}/Q/y`);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([ws, { path: drive, tree: "Clients" }, { path: lab, tree: "Lab" }])}agents: [claude]\n`);
  put(`${f.config}/layers/tree/Lab/instructions/20.md`, "# lab rule\n");
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  const s = inSetup(f, [[/Корень workspace/, [drive]], [/Есть ещё папки/, [null]], [/Записать настройки агентам/, [false]]]);
  const line = say(s);
  expect({ recipe: line.includes("Вернуть его: 1)") }).toEqual({ recipe: false });
}, 300000);

test("A10+: основной — новая папка; у прежнего основного папка Lab = ветка дополнительного корня", () => {
  const f = cliFixture({ agents: ["claude"], projects: [] });
  const ws = `${f.dir}/ws`, neu = `${f.dir}/neu`, lab = `${f.dir}/lab3`;
  git(`${ws}/Lab/c1`); git(`${neu}/Org/x`); git(`${lab}/Q/y`);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([ws, { path: lab, tree: "Lab" }])}agents: [claude]\n`);
  put(`${f.config}/layers/tree/Lab/instructions/20.md`, "# lab rule\n");
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  const s = inSetup(f, [[/Корень workspace/, [neu]], [/Есть ещё папки/, [null]], [/Записать настройки агентам/, [false]]]);
  const line = say(s);
  expect({ recipe: /Вернуть его: 1\)|Вернуть его: miksy root add/.test(line) }).toEqual({ recipe: false });
}, 300000);
