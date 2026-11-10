// Выпуск 0.2.1, круг 7b — рецензия A (out/review021c/miksy/test/zz-rev021c-{trust,ledger}.test.ts): п. 1–3 и 5
import { expect, test } from "bun:test";
import { mkdirSync, renameSync } from "node:fs";
import { cliFixture, put } from "./helpers";
import { git, inProcess, ledger, read, yamlRoots } from "./rootshelp";
import { allow, trusted } from "./fixes021b-helpers";

const pending = (out: string) => out.includes("Нужно решение пользователя о доверии");
const before = (config: string) => (ledger(config) as { trustedBefore?: Record<string, string> }).trustedBefore;
const DIALOG = "ответы в окне Claude («да";

test("рецензия 7b A: clean недоступной папки (без --forget) → диск вернулся → sync: свои ответы в окне Claude не должны попасть в вопрос", () => {
  const f = cliFixture({ projects: ["Org/p1"] });
  const drive = `${f.dir}/drive`;
  git(`${drive}/Acme/site`);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive, tree: "Clients" }])}agents: [claude]\n`);
  const site = `${drive}/Acme/site`;
  expect(f.run(["sync", "--all", "--yes"]).err).toBe("");
  allow(site);
  expect(f.run(["sync", site]).out).not.toContain("Нужно решение");
  expect(trusted(f.home, site)).toBe(true);
  renameSync(drive, `${drive}-off`);
  const c = inProcess(f, ["clean", site]);
  expect(c.err).toBe("");
  const mark = before(f.config);
  renameSync(`${drive}-off`, drive);
  // Диск вернулся: sync — как после обычного clean, без вопроса о своих ответах
  const s = f.run(["sync", site]);
  console.log("mark after unreachable clean:", JSON.stringify(mark));
  console.log(s.out);
  expect({ asked: pending(s.out), dialog: s.out.includes(DIALOG), trusted: trusted(f.home, site) }).toEqual({ asked: false, dialog: false, trusted: true });
}, 300000);

test("рецензия 7b A: clean недоступной папки → диск вернулся → повторный clean (как велит вывод) → sync: без вопроса о своих ответах", () => {
  const f = cliFixture({ projects: ["Org/p1"] });
  const drive = `${f.dir}/drive`;
  git(`${drive}/Acme/site`);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive, tree: "Clients" }])}agents: [claude]\n`);
  const site = `${drive}/Acme/site`;
  expect(f.run(["sync", "--all", "--yes"]).err).toBe("");
  allow(site);
  expect(f.run(["sync", site]).out).not.toContain("Нужно решение");
  renameSync(drive, `${drive}-off`);
  expect(inProcess(f, ["clean", site]).err).toBe("");
  renameSync(`${drive}-off`, drive);
  const c2 = f.run(["clean", site]);
  expect(c2.err).toBe("");
  const s = f.run(["sync", site]);
  console.log(s.out);
  expect({ asked: pending(s.out), trusted: trusted(f.home, site) }).toEqual({ asked: false, trusted: true });
}, 300000);

// README «Переименовали или перенесли каталог»: в корне все проекты прошли clean (или проект один) — учёта с файлами
// там нет, переезд не находится, отметка остаётся на старом пути
test("рецензия 7b A: корень с единственным проектом: clean → корень переименовали → sync --all: свои ответы без вопроса, на старом пути отметки нет", () => {
  const f = cliFixture({ projects: ["Org/p1"] });
  const books = `${f.dir}/books`, books2 = `${f.dir}/books2`;
  git(`${books}/novel`);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: books, tree: "Books" }])}agents: [claude]\n`);
  expect(f.run(["sync", "--all", "--yes"]).err).toBe("");
  allow(`${books}/novel`);
  expect(f.run(["sync", "--all", "--yes"]).out).not.toContain("Нужно решение");
  expect(f.run(["clean", `${books}/novel`]).err).toBe("");
  renameSync(books, books2);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: books2, tree: "Books" }])}agents: [claude]\n`);
  const s = f.run(["sync", "--all", "--yes"]);
  console.log(s.out);
  console.log(JSON.stringify(before(f.config)));
  expect({ asked: /Books\/novel — Claude/.test(s.out), trusted: trusted(f.home, `${books2}/novel`) }).toEqual({ asked: false, trusted: true });
}, 120000);

test("рецензия 7b A: учёт с trustedBefore-списком (форма 7a) — учёт читается, отметки нет", () => {
  const f = cliFixture({ projects: ["Org/app"] });
  const app = `${f.ws}/Org/app`;
  expect(f.run(["sync", "--all", "--yes"]).err).toBe("");
  allow(app);
  expect(f.run(["sync", app]).err).toBe("");
  expect(f.run(["clean", app]).err).toBe("");
  const m = ledger(f.config) as any;
  m.trustedBefore = Object.keys(m.trustedBefore);
  put(`${f.config}/local/state/manifest.json`, JSON.stringify(m, null, 2) + "\n");
  const d = f.run(["doctor"]);
  const s = f.run(["sync", app]);
  console.log(d.out.slice(0, 600), "\n----\n", s.out.slice(0, 400), s.err.slice(0, 400));
  expect({ doctor: /учёт повреждён/.test(d.out + d.err), sync: s.code }).toEqual({ doctor: false, sync: 0 });
}, 120000);

test("rev021c п. 5: clean недоступной папки с --agent — советы «повторите» и «--forget» с тем же --agent", () => {
  const f = cliFixture({ agents: ["claude", "codex"], projects: ["Org/p1"] });
  const drive = `${f.dir}/drive`;
  git(`${drive}/Acme/site`);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive, tree: "Clients" }])}agents: [claude, codex]\n`);
  const site = `${drive}/Acme/site`;
  expect(f.run(["sync", "--all", "--yes"]).err).toBe("");
  renameSync(drive, `${drive}-off`);
  const c = f.run(["clean", site, "--agent", "claude"]);
  expect(c.out).toMatch(/повторите miksy clean "[^"]+" --agent claude; данных больше нет — miksy clean "[^"]+" --forget --agent claude\./);
  mkdirSync(drive, { recursive: true });
}, 120000);
