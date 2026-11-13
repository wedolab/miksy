// Выпуск 0.2.2, круг 8e, F1 (проверка 8d, находка 1): папку с проектами скопировали (или перенесли, а пустые папки
// проектов остались) вместе с вложенным дополнительным корнем; setup --force выбирает новое место основным. Мастер
// называет вложенный корень и в этом случае; подсказки дословно (path: вложенного корня, sync --global и --all, clean в
// прежней копии, sync --force в новой) → miksy explain: прежние слои; ни одна подсказка их не снимает; в списке
// одноимённых папок нет папки вложенного корня. Мастер — в процессе, поддельная система, движок — копия в песочнице
import { expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { cliFixture, put } from "./helpers";
import { git, read, yamlRoots } from "./rootshelp";
import { inSetup } from "./fixes022e-helpers";

type F = ReturnType<typeof cliFixture>;
const rules = (file: string) => [...read(file).matchAll(/^# (\w+(?: \w+)?)$/gm)].map((m) => m[1]).join(",");
const layers = (f: F, p: string) => f.run(["explain", p]).out.match(/^Слои\s+(.*)$/m)?.[1] ?? "";

function base() {
  const f = cliFixture({ agents: ["claude", "codex"], projects: [] });
  const ws = `${f.dir}/ws`, ws2 = `${f.dir}/disk2/ws`;
  git(`${ws}/Org/p1`);
  git(`${ws}/Inner/Acme/site`);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([ws, { path: `${ws}/Inner`, tree: "Code" }])}agents: [claude, codex]\n`);
  put(`${f.config}/layers/tree/Org/instructions/10.md`, "# org rule\n");
  put(`${f.config}/layers/tree/Code/instructions/30.md`, "# code rule\n");
  put(`${f.config}/layers/tree/Code/Acme/instructions/31.md`, "# acme rule\n");
  put(`${f.config}/layers/tree/Code/mcp/tool.yaml`, "name: tool\ncommand: echo\nargs: [\"${WORKSPACE}/x\"]\n");
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  const before = { p1: rules(`${ws}/Org/p1/CLAUDE.local.md`), site: rules(`${ws}/Inner/Acme/site/CLAUDE.local.md`), layers: layers(f, `${ws}/Inner/Acme/site`) };
  mkdirSync(`${f.dir}/disk2`, { recursive: true });
  return { f, ws, ws2, before };
}

test("F1: папку СКОПИРОВАЛИ с вложенным корнем — корень назван, подсказки дословно: слои прежние", () => {
  const { f, ws, ws2, before } = base();
  cpSync(ws, ws2, { recursive: true });
  const s = inSetup(f, [[/Корень workspace/, [ws2]], [/Есть ещё папки/, [null]], [/Записать настройки агентам/, [false]]]);
  const line = s.out.split("\n").find((l) => l.includes("из workspace уходит"))!;
  // Корень назван, его копия — тоже; утверждения о его проектах — правда; его папка — не «одноимённая со своими слоями»
  const m = line.match(/Внутри него ещё корень (\S+) \(ветка Code; если новая папка — копия прежней, его копия — (\S+)\): он остаётся в workspace по прежнему пути, его проекты miksy обновляет, как раньше\./)!;
  expect(m).toBeTruthy();
  expect([m[1], m[2]]).toEqual([`${ws}/Inner`, `${ws2}/Inner`]);
  expect(line).toContain("его проекты (кроме вложенного корня — ниже) miksy больше не обновляет");
  expect(line).not.toMatch(/с тем же именем \([^)]*Inner/);
  expect(line).toContain("в копии вложенного корня — только после правки его path:");
  // Дословно: path: на новое место, sync --global и --all; затем «скопировали»: clean в прежней копии, --force в новой
  const file = `${f.config}/local/machine.yaml`;
  writeFileSync(file, readFileSync(file, "utf8").replace(m[1], () => m[2]));
  expect(f.run(["sync", "--global"]).code).toBe(0);
  f.run(["sync", "--all"]);
  for (const p of [`${ws}/Org/p1`, `${ws}/Inner/Acme/site`]) f.run(["clean", p]);
  for (const p of [`${ws2}/Org/p1`, `${ws2}/Inner/Acme/site`]) f.run(["sync", p, "--force"]);
  const all = f.run(["sync", "--all"]);
  const doc = f.run(["doctor"]);
  expect({
    all: all.code, conflicts: all.out.split("\n").filter((l) => /КОНФЛИКТ/.test(l)), doctor: doc.code,
    after: { p1: rules(`${ws2}/Org/p1/CLAUDE.local.md`), site: rules(`${ws2}/Inner/Acme/site/CLAUDE.local.md`), layers: layers(f, `${ws2}/Inner/Acme/site`) },
    oldSite: rules(`${ws}/Inner/Acme/site/CLAUDE.local.md`),
  }).toEqual({ all: 0, conflicts: [], doctor: 0, after: before, oldSite: "" });
}, 300000);

test("F1: перенесли, а пустые папки проектов остались — вложенный корень назван", () => {
  const { f, ws, ws2 } = base();
  renameSync(ws, ws2);
  for (const d of ["Org/p1", "Inner/Acme/site"]) mkdirSync(`${ws}/${d}`, { recursive: true });
  const s = inSetup(f, [[/Корень workspace/, [ws2]], [/Есть ещё папки/, [null]], [/Записать настройки агентам/, [false]]]);
  const line = s.out.split("\n").find((l) => /из workspace уходит|нет на месте|проектов нет/.test(l)) ?? "";
  expect(line).toContain(`${ws}/Inner (ветка Code`);
}, 300000);

// Одноимённые папки: у нового основного есть Org, Lab (слой — только через привязку map.yaml; рецензия 8e, №2) и Inner
// (папка вложенного корня, его слои — в его ветке) — названы Lab и Org, без Inner
test("F1: список одноимённых папок — без папки вложенного корня; папка со слоем через привязку — в списке", () => {
  const { f, ws, ws2 } = base();
  cpSync(ws, ws2, { recursive: true });
  git(`${ws2}/Lab/q`); git(`${ws}/Lab/q2`);
  put(`${f.config}/map.yaml`, "global:\n  - { use: global }\nlayers:\n  - { match: \"Lab/**\", use: labx }\n");
  put(`${f.config}/layers/labx/instructions/50.md`, "# labx rule\n");
  const s = inSetup(f, [[/Корень workspace/, [ws2]], [/Есть ещё папки/, [null]], [/Записать настройки агентам/, [false]]]);
  const line = s.out.split("\n").find((l) => l.includes("из workspace уходит"))!;
  expect({ named: line.includes("у нового основного есть папки с тем же именем (Lab, Org)"), recipe: line.includes("Вернуть его: 1)") }).toEqual({ named: true, recipe: false });
}, 300000);

// Повторная проверка 8e, A: вложенный корень лежит глубже (ws/Lab/Inner), рядом — проект основного ws/Lab/p2 со слоем
// layers/tree/Lab; у нового основного тоже есть Lab → Lab в списке одноимённых, рецепта «Вернуть его: 1)» нет
test("F1: вложенный корень глубже одноимённой папки — папка в списке, рецепта нет", () => {
  const f = cliFixture({ agents: ["claude"], projects: [] });
  const ws = `${f.dir}/ws`, work = `${f.dir}/work`;
  git(`${ws}/Lab/p2`); git(`${ws}/Lab/Inner/Acme/site`); git(`${work}/Lab/q`);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([ws, { path: `${ws}/Lab/Inner`, tree: "Code" }])}agents: [claude]\n`);
  put(`${f.config}/layers/tree/Lab/instructions/10.md`, "# lab rule\n");
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  const s = inSetup(f, [[/Корень workspace/, [work]], [/Есть ещё папки/, [null]], [/Записать настройки агентам/, [false]]]);
  const line = s.out.split("\n").find((l) => l.includes("из workspace уходит"))!;
  expect({ named: line.includes("у нового основного есть папка с тем же именем (Lab)"), recipe: line.includes("Вернуть его: 1)") }).toEqual({ named: true, recipe: false });
}, 300000);
