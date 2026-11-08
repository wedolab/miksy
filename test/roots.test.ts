// Фаза 0.2.0: несколько корней workspace (local/machine.yaml → workspace: строка или список корней
// { path, tree }) — одно дерево слоёв на все корни; у дополнительных корней ветка (tree) обязательна и своя
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, renameSync, symlinkSync } from "node:fs";
import { dirsOf, locate, type Root, treeJoin } from "../src/roots";
import { orphanTreeDirs, parseRoots } from "../src/load";
import { cliFixture, put } from "./helpers";
import { git, read, rootsFixture, yamlRoots } from "./rootshelp";

describe("корни: путь → корень и место в дереве, обратно", () => {
  test("locate: самый глубокий корень; dirsOf: каталог вложенного корня — не внешнего", () => {
    const f = rootsFixture();
    const roots: Root[] = parseRoots([f.ws, { path: f.drive, tree: "Clients" }, { path: f.archive, tree: "Archive" }, { path: f.inner, tree: "Code" }], "machine.yaml");
    expect(locate(`${f.inner}/p`, roots)).toMatchObject({ rel: "p", tree: "Code/p", root: { path: f.inner } });
    expect(locate(`${f.ws}/Grp/q`, roots)).toMatchObject({ rel: "Grp/q", tree: "Grp/q" });
    expect(locate(`${f.drive}/Acme/site`, roots)?.tree).toBe("Clients/Acme/site");
    expect(locate(`${f.dir}/elsewhere`, roots)).toBeNull();
    expect(dirsOf("Clients/acme", roots).map((d) => d.dir)).toEqual([`${f.drive}/Acme`]);
    expect(dirsOf("Grp/Inner", roots)).toEqual([]); // это каталог вложенного корня (Code), не Grp/Inner
    expect(dirsOf("Code", roots).map((d) => d.dir)).toEqual([f.inner]);
    expect(treeJoin("Clients", "", "a/b")).toBe("Clients/a/b");
  });

  test("machine.yaml: строка, список, { path, tree }; без tree у дополнительного, одинаковый tree, неверный tree, один каталог дважды — понятная ошибка", () => {
    const f = rootsFixture();
    expect(parseRoots(f.ws, "m.yaml")).toMatchObject([{ path: f.ws, tree: "" }]);
    expect(parseRoots([f.ws, { path: f.drive, tree: "/Clients/A/" }], "m.yaml")[1].tree).toBe("Clients/A");
    // Основной — можно со своей веткой; дополнительный — только с веткой, и ветки разные (без учёта регистра)
    expect(parseRoots([{ path: f.ws, tree: "Main" }, { path: f.drive, tree: "Clients" }], "m.yaml").map((r) => r.tree)).toEqual(["Main", "Clients"]);
    expect(() => parseRoots([f.ws, f.drive], "m.yaml")).toThrow(`у корня ${f.drive} не указана ветка дерева слоёв — укажите: { path: "${f.drive}", tree: <ветка, например Clients> }`);
    expect(() => parseRoots([f.ws, { path: f.drive, tree: "" }], "m.yaml")).toThrow(/не указана ветка дерева слоёв/);
    expect(() => parseRoots([f.ws, { path: f.drive, tree: "Clients" }, { path: f.archive, tree: "clients" }], "m.yaml")).toThrow(`tree: clients уже у корня ${f.drive} — выберите корню ${f.archive} другое имя ветки`);
    expect(() => parseRoots([{ path: f.ws, tree: "Main" }, { path: f.drive, tree: "Main" }], "m.yaml")).toThrow(/tree: Main уже у корня/);
    expect(() => parseRoots([f.ws, { path: f.drive, tree: "../x" }], "m.yaml")).toThrow(/tree «\.\.\/x»/);
    expect(() => parseRoots([f.ws, { path: f.drive, tree: "Org/mcp" }], "m.yaml")).toThrow(/имён instructions, mcp/);
    expect(() => parseRoots([{ path: f.ws, extra: 1 }], "m.yaml")).toThrow(/workspace — путь или список корней/);
    expect(() => parseRoots([], "m.yaml")).toThrow(/workspace — путь или список корней/);
    expect(() => parseRoots([f.ws, { path: `${f.ws}/`, tree: "X" }], "m.yaml")).toThrow(/указан дважды/);
    symlinkSync(f.ws, `${f.dir}/wslink`, process.platform === "win32" ? "junction" : "dir");
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: `${f.dir}/wslink`, tree: "Link" }])}agents: [claude]\n`);
    const r = f.run(["projects"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`корень ${f.ws} указан дважды (${f.ws} и ${f.dir}/wslink — один и тот же каталог: повтор, junction или симлинк)`);
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, f.drive])}agents: [claude]\n`);
    expect(f.run(["projects"]).err).toContain("не указана ветка дерева слоёв");
  }, 30000);
});

describe("корни: команды", () => {
  test("projects: корни, места в дереве; вложенный корень — свой (справка: внутри какого корня)", () => {
    const f = rootsFixture();
    const r = f.run(["projects"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Корни workspace (5):");
    expect(r.out).toContain(`  ${f.drive} → layers/tree/Clients\n`);
    expect(r.out).toContain(`  ${f.inner} → layers/tree/Code  (внутри корня ${f.ws})`);
    for (const p of ["Clients/Acme/site", "Archive/Acme/app", "Books/novel", "Org/p1", "Code/p"]) expect(r.out).toMatch(new RegExp(`^${p}$`, "m"));
    expect(r.out).not.toContain("Inner/p");
    // Вложенный корень внутри группы внешнего: группы — в пределах корня, Claude читает родителей физически
    expect(r.out).toContain(`корень ${f.inner} лежит внутри группы Grp`);
  }, 30000);

  test("sync --all: слои по месту в дереве, общее двум корням — слоем map.yaml; ${WORKSPACE} — основной корень у целей любого корня; doctor чистый", () => {
    const f = rootsFixture();
    const all = f.run(["sync", "--all", "--yes"]);
    expect(all.code).toBe(0);
    expect(all.out).toContain(`workspace ${f.ws}, ${f.drive} → layers/tree/Clients`);
    expect(f.rules(`${f.drive}/Acme/site`)).toEqual(["workspace", "clients", "acme", "shared"]);
    expect(f.rules(`${f.archive}/Acme/app`)).toEqual(["workspace", "shared"]);
    expect(f.rules(`${f.books}/novel`)).toEqual(["workspace"]);
    // Вложенный корень внутри группы Grp внешнего корня: полная цепочка своего места (Code), не отрезок
    expect(f.rules(`${f.inner}/p`)).toEqual(["workspace", "code"]);
    expect(f.rules(`${f.ws}/Grp`)).toEqual(["workspace", "grp"]);
    expect(f.rules(`${f.ws}/Grp/q`)).toEqual([]);
    const projects = JSON.parse(read(`${f.home}/.claude.json`)).projects;
    for (const p of [`${f.drive}/Acme/site`, `${f.ws}/Org/p1`, `${f.inner}/p`, `${f.books}/novel`]) expect(projects[p].mcpServers.ws.args).toEqual([`${f.ws}/x`]);
    expect(f.run(["sync", "--global"]).code).toBe(0);
    const d = f.run(["doctor"]);
    expect(d.out).toContain("Всё синхронизировано");
    expect(d.out).toContain("корней: 5");
    expect(d.out).toContain(`Корни workspace (5): ${f.ws}; ${f.drive} → layers/tree/Clients`);
    expect(d.out).toContain(`Вложенные корни (1):\n  корень ${f.inner} внутри корня ${f.ws}, место в дереве — layers/tree/Code`);
  }, 90000);

  test("исчезнувший корень (каталога нет): пропускается с предупреждением, учёт его целей не трогается и не «пропал»", () => {
    const f = rootsFixture();
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(f.run(["sync", "--global"]).code).toBe(0);
    const manifest = () => Object.keys(JSON.parse(read(`${f.config}/local/state/manifest.json`)).targets);
    expect(manifest()).toContain(`claude|${f.archive}/Acme/app`);
    renameSync(f.archive, `${f.archive}-away`);
    const p = f.run(["projects"]);
    expect(p.code).toBe(0);
    expect(p.out).toContain(`корень ${f.archive} → layers/tree/Archive недоступен (каталога нет)`);
    expect(p.out).not.toMatch(/^Archive\/Acme\/app$/m);
    const d = f.run(["doctor"]);
    expect(d.out).not.toContain("Учёт ссылается на несуществующие каталоги");
    expect(d.out).toContain(`Учёт целей недоступного корня (1) не проверяется — подключите диск: ${f.archive}/Acme/app`);
    expect(d.out).toContain("Всё синхронизировано");
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(manifest()).toContain(`claude|${f.archive}/Acme/app`);
    renameSync(`${f.archive}-away`, f.archive);
    expect(f.run(["doctor"]).out).toContain("Всё синхронизировано");
  }, 90000);

  test("doctor: «лишние» каталоги дерева — только там, куда смонтированы корни этой машины", () => {
    const f = cliFixture({ projects: [] });
    git(`${f.dir}/code/app`);
    git(`${f.dir}/clients/Acme/site`);
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([{ path: `${f.dir}/code`, tree: "Code" }, { path: `${f.dir}/clients`, tree: "Clients" }])}agents: [claude]\n`);
    for (const l of ["Books/Old", "Clients/Acme", "Clients/Ghost", "Clients/Acmee", "Code/app"]) put(`${f.config}/layers/tree/${l}/instructions/00.md`, `# ${l}\n`);
    const d = f.run(["doctor"]).out;
    expect(d).toContain("Части дерева слоёв, которых нет на этой машине (над ними нет корня workspace — для других машин): Books");
    expect(d).toMatch(/layers\/tree\/Clients\/Acmee {2}↔ в workspace есть Clients\/Acme/);
    expect(d).toContain("Слои, которые на этой машине ни к чему не применяются (проектов нет): Clients/Ghost");
    expect(d).not.toMatch(/layers\/tree\/Books/);
    // Функция: unmounted — ветка без корня над ней; недоступный корень — его часть не проверяется
    const roots = [{ path: `${f.dir}/code`, tree: "Code" }, { path: `${f.dir}/nowhere`, tree: "Clients" }];
    expect(orphanTreeDirs(roots, f.config)).toEqual([{ path: "Books", unmounted: true }]);
  }, 30000);

  test("explain: корень и место в дереве; вложенный корень — внутри какого; корень — не цель; вне корней — глобальный срез", () => {
    const f = rootsFixture();
    const e = f.run(["explain", `${f.drive}/Acme/site`]);
    expect(e.code).toBe(0);
    expect(e.out).toMatch(new RegExp(`Корень +${f.drive}\n`));
    expect(e.out).toMatch(/Место в дереве +layers\/tree\/Clients\/Acme\/site/);
    expect(e.out).toMatch(/Слои +workspace → Clients → Clients\/Acme → acme/);
    expect(f.run(["explain", `${f.inner}/p`]).out).toMatch(new RegExp(`Корень +${f.inner} \\(внутри корня ${f.ws}\\)`));
    const root = f.run(["explain", f.drive]);
    expect(root.out).toContain("корень — не цель");
    expect(root.out).toMatch(/Слои +workspace → Clients\n/);
    mkdirSync(`${f.dir}/elsewhere`);
    expect(f.run(["explain", `${f.dir}/elsewhere`]).out).toContain("вне workspace — только глобальные настройки");
  }, 30000);

  test("target в другом корне: пометка — в слое по месту в дереве; корень — не цель", () => {
    const f = rootsFixture();
    const t = f.run(["target", `${f.drive}/Acme`]);
    expect(t.code).toBe(0);
    expect(read(`${f.config}/layers/tree/Clients/Acme/layer.yaml`)).toBe("target: true\n");
    expect(f.run(["projects"]).out).toContain("Clients/Acme   (группа");
    const root = f.run(["target", f.drive]);
    expect(root.code).toBe(1);
    expect(root.err).toContain("сам workspace (корень): он не цель (общие настройки его проектов — слой layers/tree/Clients)");
  }, 30000);
});

describe("sync без пути — проект текущего каталога", () => {
  test("из подпапки проекта — этот проект; в корне и вне корней — ошибка с подсказкой, ничего не записано", () => {
    const f = rootsFixture();
    mkdirSync(`${f.drive}/Acme/site/src/deep`, { recursive: true });
    const r = f.run(["sync"], { cwd: `${f.drive}/Acme/site/src/deep` });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Clients/Acme/site");
    expect(f.rules(`${f.drive}/Acme/site`)).toEqual(["workspace", "clients", "acme", "shared"]);
    expect(existsSync(`${f.archive}/Acme/app/CLAUDE.local.md`)).toBe(false);
    for (const cwd of [f.drive, f.ws]) {
      const root = f.run(["sync"], { cwd });
      expect(root.code).toBe(2);
      expect(root.err).toContain("— корень workspace, а не проект: sync без пути (и с путём «.») — для одного проекта. Все проекты — miksy sync --all, домашние настройки агентов — miksy sync --global");
      expect(f.run(["sync", "."], { cwd }).code).toBe(2);
    }
    expect(existsSync(`${f.drive}/CLAUDE.local.md`)).toBe(false);
    mkdirSync(`${f.dir}/elsewhere`);
    const out = f.run(["sync", "--dry-run"], { cwd: `${f.dir}/elsewhere` });
    expect(out.code).toBe(2);
    expect(out.err).toContain(`${f.dir}/elsewhere — каталог вне workspace`);
    expect(out.err).toContain("Здесь: проектов (git-репо) в нём нет, а корень workspace — папка с проектами.");
    expect(out.err).toContain("если сюда вы будете класть проекты — miksy root add .; домашние настройки агентов — miksy sync --global");
    // clean — только явно
    const c = f.run(["clean"], { cwd: `${f.drive}/Acme/site` });
    expect(c.code).toBe(2);
    expect(c.err).toContain("clean убирает записанное — только явно");
    expect(existsSync(`${f.drive}/Acme/site/CLAUDE.local.md`)).toBe(true);
  }, 60000);

  test("explain без пути — текущий каталог; --global — домашние настройки", () => {
    const f = rootsFixture();
    const e = f.run(["explain"], { cwd: `${f.drive}/Acme/site` });
    expect(e.code).toBe(0);
    expect(e.out).toMatch(/Проект +Clients\/Acme\/site/);
    const g = f.run(["explain", "--global"], { cwd: `${f.drive}/Acme/site` });
    expect(g.out).toContain("домашний каталог агентов");
    expect(f.run(["explain", "--global", "."]).code).toBe(2);
  }, 30000);
});
