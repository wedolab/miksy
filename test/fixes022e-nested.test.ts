// Выпуск 0.2.2, круг 8e, F1 (проверка 8d, находка 1): папку с проектами скопировали (или перенесли, а пустые папки
// проектов остались) вместе с вложенным дополнительным корнем; setup --force выбирает новое место основным. Мастер
// называет вложенный корень и в этом случае; подсказки дословно (path: вложенного корня, sync --global и --all, clean в
// прежней копии, sync --force в новой) → miksy explain: прежние слои; ни одна подсказка их не снимает.
// Мастер — в процессе, поддельная система, движок — копия в песочнице
import { expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { cliFixture, put, expectCode, said } from "./helpers";
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
  { const r = f.run(["sync", "--all", "--yes"]); expect({ code: r.code, out: r.code ? r.out + r.err : "" }, said(r)).toEqual({ code: 0, out: "" }); }
  const before = { p1: rules(`${ws}/Org/p1/CLAUDE.local.md`), site: rules(`${ws}/Inner/Acme/site/CLAUDE.local.md`), layers: layers(f, `${ws}/Inner/Acme/site`) };
  mkdirSync(`${f.dir}/disk2`, { recursive: true });
  return { f, ws, ws2, before };
}

test("F1: папку СКОПИРОВАЛИ с вложенным корнем — корень назван, подсказки дословно: слои прежние", () => {
  const { f, ws, ws2, before } = base();
  cpSync(ws, ws2, { recursive: true });
  const s = inSetup(f, [[/Корень workspace/, [ws2]], [/Оставить её основной/, [false]], [/Есть ещё папки/, [null]], [/Записать настройки агентам/, [false]]]);
  const line = s.out.split("\n").find((l) => l.includes("из workspace уходит"))!;
  // Корень назван, его копия — тоже; утверждения о его проектах — правда; его папка — не «одноимённая со своими слоями»
  const m = line.match(/Внутри него ещё корень (\S+) \(раздел Code; если новая папка — копия прежней, его копия — (\S+)\): он остаётся в workspace по прежнему пути, его проекты miksy обновляет, как раньше\./)!;
  expect(m).toBeTruthy();
  expect([m[1], m[2]]).toEqual([`${ws}/Inner`, `${ws2}/Inner`]);
  expect(line).toContain("его проекты (кроме вложенного корня — ниже) miksy больше не обновляет");
  expect(line).not.toMatch(/с тем же именем \([^)]*Inner/);
  expect(line).toContain("в копии вложенного корня — только после правки его path:");
  // Дословно: path: на новое место, sync --global и --all; затем «скопировали»: clean в прежней копии, --force в новой
  const file = `${f.config}/local/machine.yaml`;
  writeFileSync(file, readFileSync(file, "utf8").replace(m[1], () => m[2]));
  expectCode(f.run(["sync", "--global"]), 0);
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
  expect(line).toContain(`${ws}/Inner (раздел Code`);
}, 300000);

