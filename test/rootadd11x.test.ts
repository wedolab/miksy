// Круг 11x (решения владельца 2026-11-25, BACKLOG А из 6y): root add пустой папки — без вопроса, но вместо тупика
// «Проектов в нём: 0» — что делать дальше; --yes у root add — «да» на все вопросы (каталог — проект, «sync сейчас?»),
// а ветку дерева не угадать: без --tree — ошибка с точной командой, которая дословно проходит
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { cliFixture, expectCode, said } from "./helpers";
import { git, inProcess, read } from "./rootshelp";

const EMPTY = "Проектов в нём пока нет: положите сюда git-репо (или создайте — git init в папке проекта) и запустите miksy sync --all — miksy их найдёт.";

// Команда из совета ошибки: «miksy root add "<путь>" --tree <ветка> --yes [--dry-run]» → аргументы (кавычки — как в shell)
function advice(text: string): string[] {
  const m = text.match(/miksy (root add .*? --yes(?: --dry-run)?)(?= \()/);
  if (!m) throw new Error(`нет совета в: ${text}`);
  return [...m[1].matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((x) => x[1] ?? x[2] ?? x[3]);
}

describe("root add пустой папки (круг 11x)", () => {
  test("без терминала и в терминале: без вопроса о папке, текст «что дальше» дословно, без «Проектов в нём: 0»", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const box = `${f.dir}/empty-box`;
    mkdirSync(box, { recursive: true });
    const dry = f.run(["root", "add", box, "--tree", "Box", "--dry-run"]);
    expect({ code: dry.code, text: dry.out.includes(EMPTY), zero: dry.out.includes("Проектов в нём:") }, said(dry)).toEqual({ code: 0, text: true, zero: false });
    const r = f.run(["root", "add", box, "--tree", "Box"]);
    expect({ code: r.code, text: r.out.includes(EMPTY), zero: r.out.includes("Проектов в нём:"), next: r.out.includes("Дальше:"), yaml: read(`${f.config}/local/machine.yaml`).includes("empty-box") }, said(r))
      .toEqual({ code: 0, text: true, zero: false, next: false, yaml: true });
    // В терминале — только прежний вопрос «записать сейчас?» (sync обновит остальные корни), о самой папке — нет
    const box2 = `${f.dir}/empty-two`;
    mkdirSync(box2, { recursive: true });
    const t = inProcess(f, ["root", "add", box2, "--tree", "Two"], f.dir, [false]);
    expect({ code: t.code, q: t.questions, text: t.out.includes(EMPTY), zero: t.out.includes("Проектов в нём:") }, said(t))
      .toEqual({ code: 0, q: ["Записать настройки проектам workspace сейчас (miksy sync --all)?"], text: true, zero: false });
  }, 60000);
});

describe("root add --yes — «да» на все вопросы (круг 11x)", () => {
  test("в терминале: ни одного вопроса, sync --all запускается сразу; каталог — проект — тоже без вопроса", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const side = `${f.dir}/side`;
    git(`${side}/app`);
    const y = inProcess(f, ["root", "add", side, "--tree", "Side", "--yes"], f.dir, []);
    expect({ code: y.code, q: y.questions, count: y.out.includes("Проектов в нём: 1 — Side/app"), synced: read(`${side}/app/CLAUDE.local.md`).includes("# workspace") }, said(y))
      .toEqual({ code: 0, q: [], count: true, synced: true });
    // Каталог, который сам проект (git-репо): вопрос «Всё равно сделать … корнем?» — тоже «да»
    const repo = `${f.dir}/lone-repo`;
    git(repo);
    const p = inProcess(f, ["root", "add", repo, "--tree", "Lone", "--yes"], f.dir, []);
    expect({ code: p.code, q: p.questions, added: read(`${f.config}/local/machine.yaml`).includes("lone-repo") }, said(p)).toEqual({ code: 0, q: [], added: true });
  }, 120000);

  test("без --tree: ошибка с точной командой (и прочими флагами), совет дословно проходит — в терминале и без", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const dir = `${f.dir}/my side`;
    git(`${dir}/app`);
    const yaml = () => read(`${f.config}/local/machine.yaml`);
    const before = yaml();
    // В терминале: вопроса о ветке нет — ошибка
    const t = inProcess(f, ["root", "add", dir, "--yes"], f.dir, []);
    expect({ code: t.code, q: t.questions, cmd: advice(t.err), yaml: yaml() }, said(t)).toEqual({ code: -1, q: [], cmd: ["root", "add", dir, "--tree", "my side", "--yes"], yaml: before });
    // С --dry-run совет его сохраняет; выполненный дословно — план без записи
    const d = f.run(["root", "add", dir, "--yes", "--dry-run"]);
    expect({ code: d.code, cmd: advice(d.err) }, said(d)).toEqual({ code: 2, cmd: ["root", "add", dir, "--tree", "my side", "--yes", "--dry-run"] });
    const dd = f.run(advice(d.err));
    expect({ code: dd.code, dry: dd.out.includes("--dry-run: ничего не записано"), yaml: yaml() }, said(dd)).toEqual({ code: 0, dry: true, yaml: before });
    // Без терминала — тот же совет; выполненный дословно — корень добавлен, sync прошёл
    const n = f.run(["root", "add", dir, "--yes"]);
    expect({ code: n.code, yaml: yaml() }, said(n)).toEqual({ code: 2, yaml: before });
    const ok = f.run(advice(n.err));
    expectCode(ok, 0);
    expect({ added: yaml().includes("my side"), synced: read(`${dir}/app/CLAUDE.local.md`).includes("# workspace") }, said(ok)).toEqual({ added: true, synced: true });
  }, 120000);

  test("без терминала --yes тоже запускает sync; «новых целей больше 10» --yes снимает в обоих режимах", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const many = `${f.dir}/many`;
    for (let i = 1; i <= 11; i++) git(`${many}/app${i}`);
    const n = f.run(["root", "add", many, "--tree", "Many", "--yes"]);
    expect({ code: n.code, synced: read(`${many}/app11/CLAUDE.local.md`).includes("# workspace") }, said(n)).toEqual({ code: 0, synced: true });
    const more = `${f.dir}/more`;
    for (let i = 1; i <= 11; i++) git(`${more}/app${i}`);
    const t = inProcess(f, ["root", "add", more, "--tree", "More", "--yes"], f.dir, []);
    expect({ code: t.code, q: t.questions, synced: read(`${more}/app11/CLAUDE.local.md`).includes("# workspace") }, said(t)).toEqual({ code: 0, q: [], synced: true });
  }, 120000);

  test("корень — домашний каталог: --yes вопрос sync не снимает; без терминала — отказ, корень записан, совет дословно проходит", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    git(`${f.home}/code/app`);
    const yaml = () => read(`${f.config}/local/machine.yaml`);
    // В терминале: вопрос о доме задаётся и при --yes; «нет» — корень записан, настройки — нет
    const t = inProcess(f, ["root", "add", f.home, "--tree", "Home", "--yes"], f.dir, [false]);
    expect({ code: t.code, q: t.questions.length, home: t.questions[0]?.includes("sync --all запишет конфиги во все git-репо внутри"), added: yaml().includes("Home"), later: t.out.includes("Позже: miksy sync --all"), synced: read(`${f.home}/code/app/CLAUDE.local.md`) }, said(t))
      .toEqual({ code: 1, q: 1, home: true, added: true, later: true, synced: "" });
    expectCode(f.run(["root", "remove", f.home]), 0);
    // Без терминала: отказ с точной командой; корень записан
    const n = f.run(["root", "add", f.home, "--tree", "Home", "--yes"]);
    const m = n.err.match(/подтвердите: miksy (sync --all --yes)/);
    expect({ code: n.code, recorded: n.err.includes("корень записан"), added: yaml().includes("Home"), cmd: m?.[1] }, said(n)).toEqual({ code: 2, recorded: true, added: true, cmd: "sync --all --yes" });
    const ok = f.run(m![1].split(" "));
    expectCode(ok, 0);
    expect(read(`${f.home}/code/app/CLAUDE.local.md`)).toContain("# workspace");
  }, 120000);

  test("каталог — проект без терминала и без --tree: совет с предложенной веткой проходит дословно", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const repo = `${f.dir}/elsewhere/new-repo`;
    git(repo);
    const r = f.run(["root", "add", repo]);
    const m = (r.out + r.err).match(/miksy (root add "[^"]+" --tree \S+ --yes)/);
    expect({ code: r.code, cmd: m?.[1] }, said(r)).toEqual({ code: 2, cmd: `root add "${repo}" --tree new-repo --yes` });
    expectCode(f.run(["root", "add", repo, "--tree", "new-repo", "--yes"]), 0);
  }, 60000);
});

describe("sync --all без единого проекта (круг 11x)", () => {
  test("вместо голого «проектов: 0» — что делать дальше", () => {
    const f = cliFixture({ agents: ["claude"], projects: [] });
    mkdirSync(f.ws, { recursive: true });
    const r = f.run(["sync", "--all"]);
    expect({ code: r.code, hint: r.out.includes("проектов пока нет: положите в папку с проектами (корень workspace) git-репо (или создайте — git init в папке проекта) и запустите miksy sync --all снова — miksy их найдёт") }, said(r))
      .toEqual({ code: 0, hint: true });
    git(`${f.ws}/Org/p1`);
    const s = f.run(["sync", "--all"]);
    expect({ code: s.code, hint: s.out.includes("проектов пока нет") }, said(s)).toEqual({ code: 0, hint: false });
  }, 60000);
});
