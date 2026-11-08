// Фаза 0.2.0, исправления после проверки (out/phase-roots-fixes.md): совпадение ветки корня с папкой другого
// корня, вложенные корни — справка, ${WORKSPACE} — основной корень (и adopt), sync без пути, miksy root,
// недоступный корень (нет диска, ссылка в никуда, пустая точка монтирования), setup --force, корень на
// корне диска
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync } from "node:fs";
import type { Ask } from "../src/ask";
import { fromNative } from "../src/adopt";
import { runCommand } from "../src/commands";
import { listProjects } from "../src/load";
import { dirsOf, type Root } from "../src/roots";
import { rewriteRoots } from "../src/rootfile";
import type { Machine } from "../src/types";
import { cliFixture, put } from "./helpers";
import { missingDrive } from "./nodrive";
import { git, read, rootsFixture, yamlRoots } from "./rootshelp";

const win = process.platform === "win32";
const ledger = (config: string) => JSON.parse(read(`${config}/local/state/manifest.json`) || "{\"targets\":{}}") as { targets: Record<string, unknown>; roots?: Record<string, string> };

// Команда в этом процессе «в терминале»: ответы — по порядку (да/нет и строки)
function inTerminal(f: { config: string; home: string; dir: string }, args: string[], answers: (boolean | string)[], cwd = f.dir) {
  const saved = { ...process.env }, dir = process.cwd(), log = console.log, out: string[] = [];
  Object.assign(process.env, { MIKSY_CONFIG: f.config, HOME: f.home, USERPROFILE: f.home });
  process.chdir(cwd);
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  const questions: string[] = [];
  const next = (q: string) => { questions.push(q); if (!answers.length) throw new Error(`лишний вопрос: ${q}`); return answers.shift()!; };
  const io: Ask = { yes: (q) => next(q) as boolean, choose: () => null, line: (q) => (next(q) as string) || null };
  try { return { code: runCommand(args[0], args.slice(1), { ask: io }), out: out.join("\n"), questions }; }
  finally {
    console.log = log;
    process.chdir(dir);
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

// То же без терминала и без отдельного процесса: корень на отсутствующем диске защита прогона
// (test/guard.ts) для запуска CLI не пропускает — он вне песочницы
function inProcess(f: { config: string; home: string; dir: string }, args: string[], cwd = f.dir) {
  const saved = { ...process.env }, dir = process.cwd(), log = console.log, out: string[] = [];
  Object.assign(process.env, { MIKSY_CONFIG: f.config, HOME: f.home, USERPROFILE: f.home });
  process.chdir(cwd);
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  try { return { code: runCommand(args[0], args.slice(1), { ask: null }), out: out.join("\n"), err: "" }; }
  catch (e) { return { code: 1, out: out.join("\n"), err: (e as Error).message }; }
  finally {
    console.log = log;
    process.chdir(dir);
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

describe("A.1: ветка корня обязательна и своя; совпадение ветки с папкой другого корня — предупреждение", () => {
  test("папка Clients в основном корне и корень с tree: Clients — doctor (проблема), sync --all, projects, sync проекта; вложенный корень на своём месте — не совпадение", () => {
    const f = cliFixture({ projects: ["Org/p1", "Clients/x"] });
    const drive = `${f.dir}/drive`;
    git(`${drive}/Acme/site`);
    put(`${f.config}/layers/tree/Clients/instructions/10-clients.md`, "# rule clients\n");
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive, tree: "Clients" }])}agents: [claude]\n`);
    const clash = `ветка layers/tree/Clients корня ${drive} совпадает с папкой ${f.ws}/Clients корня ${f.ws}: слои этой ветки получат обе`;
    const d = f.run(["doctor"]);
    expect(d.out).toContain(`Ветка корня совпадает с папкой другого корня (1) — слои у них общие\n  —    ${clash}`);
    expect(d.out).toMatch(/Проблем: \d+/);
    expect(f.run(["sync", "--all", "--dry-run"]).out).toContain(`предупреждение: ${clash}`);
    // Одно и то же место в двух корнях — заголовок с корнем
    git(`${drive}/x`);
    const p = f.run(["projects"]).out;
    expect(p).toContain(`предупреждение: ${clash}`);
    expect(p).toContain(`Clients/x (${drive})\nClients/x (${f.ws})`);
    expect(f.run(["sync", `${f.ws}/Clients/x`, "--dry-run"]).out).toContain(`предупреждение: ${clash}`);
    expect(f.run(["sync", `${f.ws}/Org/p1`, "--dry-run"]).out).not.toContain("совпадает с папкой");
    // Вложенный корень, повешенный на своё же место (ws/Org → tree Org), — не совпадение, а справка
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: `${f.ws}/Org`, tree: "Org" }])}agents: [claude]\n`);
    const n = f.run(["doctor"]).out;
    expect(n).not.toContain("совпадает с папкой");
    expect(n).toContain(`Вложенные корни (1):\n  корень ${f.ws}/Org внутри корня ${f.ws}, место в дереве — layers/tree/Org`);
    expect(f.run(["explain", `${f.ws}/Org/p1`]).out).toMatch(new RegExp(`Корень +${f.ws}/Org \\(внутри корня ${f.ws}\\)`));
  }, 60000);
});

describe("A.3: ${WORKSPACE} — основной корень; adopt сворачивает в него только пути основного корня", () => {
  const machineOf = (ws: string, drive: string, inner: string): Machine => ({
    workspace: ws, home: "/h", os: win ? "windows" : "linux", vars: {},
    roots: [{ path: ws, tree: "" }, { path: drive, tree: "Clients" }, { path: inner, tree: "Cloud" }],
  });

  test("fromNative: путь основного корня — ${WORKSPACE} при любом --to; путь другого или вложенного корня — как есть (elsewhere); граница имени", () => {
    const ws = win ? "D:/Work" : "/w/Work", drive = win ? "G:/Clients" : "/g/Clients", inner = `${ws}/Cloud`;
    const m = machineOf(ws, drive, inner);
    for (const to of ["global", "workspace", "Clients", "Clients/Acme"]) {
      const r = fromNative("t", { command: "python", args: [`${ws}/tools/a.py`, `${drive}/tools/b.py`, `${inner}/c.py`, `${ws}2/x`, `--dir=${ws}`] }, "claude", m, to);
      expect(r.server.args).toEqual(["${WORKSPACE}/tools/a.py", `${drive}/tools/b.py`, `${inner}/c.py`, `${ws}2/x`, "--dir=${WORKSPACE}"]);
      expect(r.elsewhere).toEqual([{ path: drive, tree: "Clients" }, { path: inner, tree: "Cloud" }]);
    }
    // Переменная машины для другого корня — сворачивается в неё
    const withVar = { ...m, vars: { CLIENTS: drive } };
    const v = fromNative("t", { command: `${drive}/bin/x` }, "claude", withVar, "Clients");
    expect(v.server.command).toBe("${CLIENTS}/bin/x");
    expect(v.elsewhere).toEqual([]);
  });

  test("adopt --global … --to Clients: подсказка завести переменную для пути другого корня", () => {
    const f = rootsFixture();
    put(`${f.home}/.claude.json`, JSON.stringify({ mcpServers: { tool: { type: "stdio", command: "python", args: [`${f.ws}/tools/a.py`, `${f.drive}/tools/b.py`] } } }));
    const r = f.run(["adopt", "--global", "tool", "--to", "Clients", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('args: ["${WORKSPACE}/tools/a.py", "' + `${f.drive}/tools/b.py"]`);
    expect(r.out).toContain(`путь в корне ${f.drive} (не основном) остался в слое как есть — на другой машине этот корень лежит иначе: заведите переменную в vars local/machine.yaml (CLIENTS: "${f.drive}") и замените в слое ${f.drive} на \${CLIENTS}`);
  }, 30000);
});

describe("A.4–A.5: sync (и sync --out) без пути — только проект или цель текущего каталога", () => {
  test("подпапка цели target: true — сама цель; каталог без git, не цель — ошибка; каталог, где работал агент, — проект; явный путь — с предупреждением", () => {
    const f = rootsFixture();
    mkdirSync(`${f.ws}/Grp/notes/2024`, { recursive: true });
    const g = f.run(["sync", "--dry-run"], { cwd: `${f.ws}/Grp/notes/2024` });
    expect(g.code).toBe(0);
    expect(g.out).toContain("Grp");
    expect(g.out).not.toContain("Grp/notes");
    const org = f.run(["sync", "--dry-run"], { cwd: `${f.ws}/Org` });
    expect(org.code).toBe(2);
    expect(org.err).toContain(`${f.ws}/Org — не проект: каталог без git и не цель (внутри — проекты); sync без пути пишет настройки только проекту или цели. Сделать его проектом — git init, целью без git — miksy target; все проекты — miksy sync --all`);
    // Каталог из реестра проектов агента (агент там уже работал) — проект и без git
    mkdirSync(`${f.ws}/Notes/sub`, { recursive: true });
    put(`${f.home}/.claude.json`, JSON.stringify({ projects: { [`${f.ws}/Notes`]: {} } }));
    const known = f.run(["sync", "--dry-run"], { cwd: `${f.ws}/Notes/sub` });
    expect(known.code).toBe(0);
    expect(known.out).not.toContain("Notes/sub");
    // Явный путь — как раньше, но с предупреждением
    const plain = f.run(["sync", `${f.ws}/Org`, "--dry-run"]);
    expect(plain.code).toBe(0);
    expect(plain.out).toContain(`предупреждение: Org — каталог без git и не цель: sync --all его не обновит (и doctor не проверит). Сделать целью — miksy target "${f.ws}/Org"`);
    expect(f.run(["sync", `${f.ws}/Org/p1`, "--dry-run"]).out).not.toContain("каталог без git и не цель");
    // explain — тот же выбор цели; каталог без git — с пометкой
    expect(f.run(["explain"], { cwd: `${f.ws}/Grp/notes/2024` }).out).toMatch(/Цель-группа +Grp\n/);
    expect(f.run(["explain"], { cwd: `${f.ws}/Org` }).out).toMatch(/Цель +не проект и не цель — sync --all его не обновит/);
  }, 60000);

  test("sync --out без пути — проект текущего каталога; вне workspace — ошибка без «пишет настройки проекта»", () => {
    const f = rootsFixture();
    mkdirSync(`${f.drive}/Acme/site/src`, { recursive: true });
    const r = f.run(["sync", "--out", `${f.dir}/box`, "--dry-run"], { cwd: `${f.drive}/Acme/site/src` });
    expect(r.code).toBe(0);
    expect(r.out.split("\n")[0]).toBe("Clients/Acme/site");
    mkdirSync(`${f.dir}/elsewhere`);
    const out = f.run(["sync", "--out", `${f.dir}/box`, "--dry-run"], { cwd: `${f.dir}/elsewhere` });
    expect(out.code).toBe(2);
    expect(out.err).toContain("sync --out без пути показывает настройки проекта, в каталоге которого вы находитесь");
    expect(out.err).not.toContain("пишет настройки");
    expect(out.err).toContain("miksy sync --global --out <каталог>");
  }, 60000);
});

describe("A.6: miksy root add / remove", () => {
  const machineText = (ws: string) => `# Настройки этой машины\nworkspace: ${ws}  # основной\nvars:\n  TOOL: "x"\n# Агенты\nagents: [claude]\ntrust: { codex: true }\n`;

  test("add: строка становится списком, остальное в файле — как было; новый корень сразу в projects; без терминала без --tree — подсказка; повтор, занятая ветка, нет каталога — ошибка; --dry-run", () => {
    const f = cliFixture({ projects: ["Org/p1"] });
    git(`${f.dir}/drive/Acme/site`);
    mkdirSync(`${f.dir}/books`);
    const file = `${f.config}/local/machine.yaml`;
    put(file, machineText(f.ws));
    const noTree = f.run(["root", "add", `${f.dir}/drive`]);
    expect(noTree.code).toBe(2);
    expect(noTree.err).toContain(`укажите ветку дерева слоёв для нового корня: miksy root add "${f.dir}/drive" --tree <ветка> (например, --tree drive)`);
    const dry = f.run(["root", "add", `${f.dir}/drive`, "--tree", "Clients", "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("--dry-run: ничего не записано.");
    expect(read(file)).toBe(machineText(f.ws));
    const r = f.run(["root", "add", `${f.dir}/drive`, "--tree", "Clients"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Новый корень: ${f.dir}/drive → layers/tree/Clients — local/machine.yaml: workspace станет списком корней`);
    expect(r.out).toContain("Проектов в нём: 1 — Clients/Acme/site");
    expect(r.out).toContain("Дальше: miksy projects — проверить, что видно; miksy sync --all — записать настройки");
    expect(read(file)).toBe(`# Настройки этой машины\nworkspace: # основной\n  - ${f.ws}\n  - { path: "${f.dir}/drive", tree: "Clients" }\nvars:\n  TOOL: "x"\n# Агенты\nagents: [claude]\ntrust: { codex: true }\n`);
    expect(f.run(["projects"]).out).toMatch(/^Clients\/Acme\/site$/m);
    // Блочный список — дописывается строкой
    expect(f.run(["root", "add", `${f.dir}/books`, "--tree", "Books"]).code).toBe(0);
    expect(read(file)).toContain(`  - { path: "${f.dir}/drive", tree: "Clients" }\n  - { path: "${f.dir}/books", tree: "Books" }\nvars:`);
    expect(f.run(["root", "add", `${f.dir}/books`, "--tree", "B2"]).err).toContain(`${f.dir}/books — уже корень workspace`);
    mkdirSync(`${f.dir}/other`);
    expect(f.run(["root", "add", `${f.dir}/other`, "--tree", "clients"]).err).toContain(`tree: clients уже у корня ${f.dir}/drive — выберите другое имя ветки`);
    expect(f.run(["root", "add", `${f.dir}/missing`, "--tree", "M"]).err).toContain(`${f.dir}/missing: каталога нет`);
    // Совпадение ветки — предупреждение; вложенный корень на своём месте — справка
    const clash = f.run(["root", "add", `${f.dir}/other`, "--tree", "Org", "--dry-run"]);
    expect(clash.out).toContain(`предупреждение: ветка layers/tree/Org корня ${f.dir}/other совпадает с папкой ${f.ws}/Org корня ${f.ws}`);
    const nested = f.run(["root", "add", `${f.ws}/Org`, "--tree", "Org", "--dry-run"]);
    expect(nested.out).not.toContain("совпадает с папкой");
    expect(nested.out).toContain(`справка: корень ${f.ws}/Org внутри корня ${f.ws}, место в дереве — layers/tree/Org`);
    // Список корней
    expect(f.run(["root"]).out).toContain(`Корни workspace (3):\n  ${f.ws}  (основной)\n  ${f.dir}/drive → layers/tree/Clients\n  ${f.dir}/books → layers/tree/Books`);
  }, 60000);

  test("add в терминале: ветка — вопросом (Enter — имя папки), затем предложение sync --all", () => {
    const f = cliFixture({ projects: ["Org/p1"] });
    git(`${f.dir}/Google Drive/Acme/site`);
    const r = inTerminal(f, ["root", "add"], ["", true], `${f.dir}/Google Drive`);
    expect(r.code).toBe(0);
    expect(r.questions[0]).toContain("(Enter — Google Drive)");
    expect(r.questions[1]).toContain("miksy sync --all");
    expect(read(`${f.dir}/Google Drive/Acme/site/CLAUDE.local.md`)).toContain("# workspace");
    expect((Bun.YAML.parse(read(`${f.config}/local/machine.yaml`)) as { workspace: unknown }).workspace).toEqual([f.ws, { path: `${f.dir}/Google Drive`, tree: "Google Drive" }]);
  }, 60000);

  test("remove: основной — нельзя; записанное в его проекты — без терминала не трогается (подсказка clean, clean работает и после), в терминале — clean с согласия", () => {
    const f = rootsFixture();
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    const primary = f.run(["root", "remove", f.ws]);
    expect(primary.code).toBe(2);
    expect(primary.err).toContain(`${f.ws} — основной корень, его нельзя убрать: на нём \${WORKSPACE} и ветка дерева без префикса. Сменить основной — miksy setup --force`);
    expect(f.run(["root", "remove", `${f.dir}/nowhere`]).err).toContain(`${f.dir}/nowhere — не корень workspace`);
    // Без терминала: корень убран, записанное и учёт — как были
    const before = ledger(f.config).targets;
    const r = f.run(["root", "remove", f.books]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`miksy записывал в его проекты (1): Books/novel`);
    expect(r.out).toContain(`Записанное в проекты и учёт не тронуты. Убрать позже (работает и без корня в workspace):\n  miksy clean "${f.books}/novel"`);
    expect(ledger(f.config).targets).toEqual(before);
    expect(existsSync(`${f.books}/novel/CLAUDE.local.md`)).toBe(true);
    expect(read(`${f.config}/local/machine.yaml`)).not.toContain(f.books);
    // doctor — справочно; sync --all его не трогает; clean <путь> — убирает по учёту
    expect(f.run(["doctor"]).out).toContain(`Цели учёта вне workspace (1) — их корень убран или workspace сменился: miksy их больше не обновляет; убрать записанное туда — miksy clean <путь>:\n  ${f.books}/novel`);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(existsSync(`${f.books}/novel/CLAUDE.local.md`)).toBe(true);
    expect(f.run(["clean", `${f.books}/novel`]).code).toBe(0);
    expect(existsSync(`${f.books}/novel/CLAUDE.local.md`)).toBe(false);
    expect(Object.keys(ledger(f.config).targets).some((k) => k.includes("/books/"))).toBe(false);
    // В терминале — clean с согласия, затем корень убран
    const t = inTerminal(f, ["root", "remove", f.archive], [true]);
    expect(t.code).toBe(0);
    expect(t.questions).toEqual(["Убрать записанное miksy в эти проекты сейчас (miksy clean — 1)?"]);
    expect(existsSync(`${f.archive}/Acme/app/CLAUDE.local.md`)).toBe(false);
    expect(read(`${f.config}/local/machine.yaml`)).not.toContain(f.archive);
  }, 120000);
});

describe("B.1: недоступный корень — нет диска, ссылка в никуда — не ломает команды", () => {
  test("корень на отсутствующем диске: projects, doctor, explain --global, sync --global работают; предупреждение «нет диска»", () => {
    const f = cliFixture({ projects: ["Org/p1"] });
    const away = missingDrive("Clients");
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: away, tree: "Clients" }])}agents: [claude]\n`);
    const p = inProcess(f, ["projects"]);
    expect(p.code).toBe(0);
    expect(p.out).toContain(`корень ${away} → layers/tree/Clients недоступен (нет диска): его проекты пропущены`);
    expect(p.out).toMatch(/^Org\/p1$/m);
    expect(inProcess(f, ["doctor"]).out).toContain("miksy doctor");
    expect(inProcess(f, ["explain", "--global"]).code).toBe(0);
    expect(inProcess(f, ["sync", "--global"]).code).toBe(0);
    expect(inProcess(f, ["sync", "--all", "--dry-run"]).code).toBe(0);
  }, 60000);

  test("корень — ссылка (junction, симлинк), цель пропала: «ссылка ведёт в никуда»; учёт его целей — по пути назначения, не «пропавшие»", () => {
    const f = cliFixture({ projects: ["Org/p1"] });
    const target = `${f.dir}/real-clients`, link = `${f.dir}/clients-link`;
    git(`${target}/Acme/site`);
    symlinkSync(target, link, win ? "junction" : "dir");
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: link, tree: "Clients" }])}agents: [claude]\n`);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(f.run(["sync", "--global"]).code).toBe(0);
    expect(Object.keys(ledger(f.config).targets)).toContain(`claude|${target}/Acme/site`);
    // Учёт помнит настоящий путь корня-ссылки
    expect(Object.values(ledger(f.config).roots ?? {})).toContain(target);
    renameSync(target, `${target}-away`);
    // Ссылка в никуда: защита прогона CLI с таким корнем не запускает — в этом процессе
    const p = inProcess(f, ["projects"]);
    expect(p.code).toBe(0);
    expect(p.out).toContain(`корень ${target} → layers/tree/Clients недоступен (ссылка ведёт в никуда)`);
    const d = inProcess(f, ["doctor"]);
    expect(d.out).not.toContain("Учёт ссылается на несуществующие каталоги");
    expect(d.out).toContain(`Учёт целей недоступного корня (1) не проверяется — подключите диск: ${target}/Acme/site`);
    expect(inProcess(f, ["sync", "--all", "--yes"]).code).toBe(0);
    expect(Object.keys(ledger(f.config).targets)).toContain(`claude|${target}/Acme/site`);
    renameSync(`${target}-away`, target);
    expect(f.run(["doctor"]).out).toContain("Всё синхронизировано");
  }, 90000);
});

describe("B.7: пустая точка монтирования — корень пуст, а в учёте есть его цели — недоступен", () => {
  test("цели не «пропали» и не переносятся; после возвращения диска — как было", () => {
    const f = rootsFixture();
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(f.run(["sync", "--global"]).code).toBe(0);
    renameSync(f.archive, `${f.archive}-disk`);
    mkdirSync(f.archive);
    const p = f.run(["projects"]);
    expect(p.out).toContain(`корень ${f.archive} → layers/tree/Archive недоступен (пуст, а в учёте есть его цели — диск не смонтирован?)`);
    const d = f.run(["doctor"]);
    expect(d.out).not.toContain("Учёт ссылается на несуществующие каталоги");
    expect(d.out).toContain(`Учёт целей недоступного корня (1) не проверяется — подключите диск: ${f.archive}/Acme/app`);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(Object.keys(ledger(f.config).targets)).toContain(`claude|${f.archive}/Acme/app`);
    rmSync(f.archive, { recursive: true });
    renameSync(`${f.archive}-disk`, f.archive);
    expect(f.run(["doctor"]).out).toContain("Всё синхронизировано");
  }, 90000);
});

describe("B.3: setup --force сохраняет ветку основного корня и форму записи", () => {
  test("{ path, tree } основного корня и список — как были", () => {
    const f = cliFixture({ projects: ["Org/p1"] });
    mkdirSync(`${f.dir}/drive`);
    const file = `${f.config}/local/machine.yaml`;
    put(file, `workspace:\n  - { path: "${f.ws}", tree: "Main" }\n  - { path: "${f.dir}/drive", tree: "Clients" }\nagents: [claude]\n`);
    expect(f.run(["setup", "--force", "--yes"]).code).toBe(0);
    expect((Bun.YAML.parse(read(file)) as { workspace: unknown }).workspace).toEqual([{ path: f.ws, tree: "Main" }, { path: `${f.dir}/drive`, tree: "Clients" }]);
    put(file, `workspace:\n  - "${f.ws}"\nagents: [claude]\n`);
    expect(f.run(["setup", "--force", "--yes"]).code).toBe(0);
    expect((Bun.YAML.parse(read(file)) as { workspace: unknown }).workspace).toEqual([f.ws]);
  }, 120000);
});

describe("B.6: корень на корне диска и вложенный корень — проект один раз", () => {
  test("путь корня с косой в конце (как D:/ или /) — обход и вложенный корень сравниваются без двойной косой", () => {
    const f = cliFixture({ projects: ["Org/p1", "inner/p"] });
    const roots: Root[] = [{ path: `${f.ws}/`, tree: "" }, { path: `${f.ws}/inner`, tree: "In" }];
    const list = listProjects(roots).map((p) => `${p.abs} ${p.rel}`);
    expect(list).toEqual([`${f.ws}/Org/p1 Org/p1`, `${f.ws}/inner/p In/p`]);
    expect(dirsOf("Org", roots).map((d) => d.dir)).toEqual([`${f.ws}/Org`]);
  });
});

describe("miksy root: правка workspace строками (src/rootfile.ts)", () => {
  test("блочный список (с отступом и без), flow-список, CRLF; комментарии внутри списка — на месте; удаление элемента", () => {
    const add = { path: "E:/Clients", tree: "Clients" };
    expect(rewriteRoots("workspace:\n- D:/a  # основной\n- { path: B, tree: B }\nagents: [claude]\n", ["D:/a", { path: "B", tree: "B" }, add], [0, 1, -1]))
      .toBe("workspace:\n- D:/a  # основной\n- { path: B, tree: B }\n- { path: \"E:/Clients\", tree: \"Clients\" }\nagents: [claude]\n");
    expect(rewriteRoots("workspace:\r\n  # корни\r\n  - D:/a\r\n  # второй\r\n  - { path: B, tree: B }\r\nvars: {}\r\n", ["D:/a", add], [0, -1]))
      .toBe("workspace:\r\n  # корни\r\n  - D:/a\r\n  # второй\r\n  - { path: \"E:/Clients\", tree: \"Clients\" }\r\nvars: {}\r\n");
    expect(rewriteRoots("workspace: [D:/a, { path: B, tree: B }]  # c\nagents: [claude]\n", ["D:/a", add], [0, -1]))
      .toBe("workspace: # c\n  - \"D:/a\"\n  - { path: \"E:/Clients\", tree: \"Clients\" }\nagents: [claude]\n");
    expect(() => rewriteRoots("agents: [claude]\n", ["D:/a"], [0])).toThrow("нет ключа workspace");
  });
});

describe("находки рецензии: недоступный корень, adopt, память пути корня, BOM, root remove вложенного", () => {
  test("недоступный дополнительный корень (нет диска) и группа, совпадение ветки, sync проекта, explain, --out — работают", () => {
    const f = cliFixture({ projects: ["Org/p1"] });
    const away = missingDrive("Drive/Clients");
    mkdirSync(`${f.ws}/Clients/notes`, { recursive: true });
    mkdirSync(`${f.ws}/Grp`, { recursive: true });
    put(`${f.config}/layers/tree/Grp/layer.yaml`, "target: true\n");
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: away, tree: "Clients" }])}agents: [claude]\n`);
    for (const args of [["sync", `${f.ws}/Org/p1`, "--dry-run"], ["explain", `${f.ws}/Clients/notes`], ["projects"], ["doctor"], ["sync", "--all", "--dry-run"], ["root"]]) {
      const r = inProcess(f, args);
      expect(r.err).toBe("");
      expect(r.out).not.toContain("симлинк указывает");
    }
    expect(inProcess(f, ["sync", "--out", `${f.dir}/box`, "--dry-run"], `${f.ws}/Org/p1`).err).toBe("");
  }, 60000);

  test("недоступен основной корень: sync --global, sync проекта второго корня и doctor работают", () => {
    const f = cliFixture({ projects: [] });
    const drive = `${f.dir}/drive`;
    git(`${drive}/Acme/site`);
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([missingDrive("Work"), { path: drive, tree: "Clients" }])}agents: [claude]\n`);
    const g = inProcess(f, ["sync", "--global"]);
    expect(g.err).toBe("");
    expect(g.code).toBe(0);
    const p = inProcess(f, ["sync", `${drive}/Acme/site`]);
    expect(p.err).toBe("");
    expect(p.code).toBe(0);
    expect(read(`${drive}/Acme/site/CLAUDE.local.md`)).toContain("# workspace");
    const d = inProcess(f, ["doctor"]);
    expect(d.out).not.toContain("не проверена");
  }, 60000);

  test("корень-junction без памяти в учёте, цель пропала: projects, doctor, root, sync <путь> — работают", () => {
    const f = cliFixture({ projects: ["Org/p1"] });
    const target = `${f.dir}/real`, link = `${f.ws}/Link`;
    mkdirSync(target);
    symlinkSync(target, link, win ? "junction" : "dir");
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: link, tree: "Clients" }])}agents: [claude]\n`);
    rmSync(target, { recursive: true });
    for (const args of [["projects"], ["doctor"], ["root"], ["sync", `${f.ws}/Org/p1`, "--dry-run"]]) expect(inProcess(f, args).err).toBe("");
    expect(inProcess(f, ["projects"]).out).toContain("недоступен (ссылка ведёт в никуда)");
  }, 60000);

  test("память настоящего пути корня пишется в учёт и тогда, когда sync ничего не изменил", () => {
    const f = cliFixture({ projects: [] });
    const target = `${f.dir}/real`, link = `${f.dir}/link`;
    git(`${target}/Acme/site`);
    symlinkSync(target, link, win ? "junction" : "dir");
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: link, tree: "Clients" }])}agents: [claude]\n`);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    // Учёт, как после 0.1.1: поля roots нет; все цели актуальны
    const file = `${f.config}/local/state/manifest.json`;
    const doc = JSON.parse(read(file));
    delete doc.roots;
    put(file, JSON.stringify(doc, null, 2));
    const r = f.run(["sync", "--all", "--yes"]);
    expect(r.code).toBe(0);
    expect(Object.values(ledger(f.config).roots ?? {})).toContain(target);
    // --dry-run учёт не трогает
    delete doc.roots;
    put(file, JSON.stringify(doc, null, 2));
    expect(f.run(["sync", "--all", "--dry-run"]).code).toBe(0);
    expect(ledger(f.config).roots).toBeUndefined();
  }, 90000);

  test("adopt: путь другого корня под домашним каталогом — не ${HOME}, подсказка; основной корень внутри дополнительного — ${WORKSPACE}", () => {
    const home = win ? "C:/Users/u" : "/home/u";
    const m: Machine = { workspace: "D:/Work", home, os: win ? "windows" : "linux", vars: {},
      roots: [{ path: "D:/Work", tree: "" }, { path: `${home}/CloudDrive/Clients`, tree: "Clients" }] };
    const a = fromNative("t", { command: "python", args: [`${home}/CloudDrive/Clients/tools/x.py`, `${home}/bin/y`] }, "claude", m, "Clients");
    expect(a.server.args).toEqual([`${home}/CloudDrive/Clients/tools/x.py`, "${HOME}/bin/y"]);
    expect(a.elsewhere).toEqual([{ path: `${home}/CloudDrive/Clients`, tree: "Clients" }]);
    const nested: Machine = { workspace: `${home}/Dev`, home, os: m.os, vars: {}, roots: [{ path: `${home}/Dev`, tree: "" }, { path: `${home}/Dev/Cloud/X`, tree: "X" }] };
    const b = fromNative("t", { command: `${home}/Dev/Cloud/X/t.py`, args: [`${home}/Dev/a.py`] }, "claude", nested, "X");
    expect(b.server.command).toBe(`${home}/Dev/Cloud/X/t.py`);
    expect(b.server.args).toEqual(["${WORKSPACE}/a.py"]);
    expect(b.elsewhere).toEqual([{ path: `${home}/Dev/Cloud/X`, tree: "X" }]);
    const inner: Machine = { workspace: "D:/Work/Sub", home, os: m.os, vars: {}, roots: [{ path: "D:/Work/Sub", tree: "" }, { path: "D:/Work", tree: "W" }] };
    const c = fromNative("t", { command: "D:/Work/Sub/tool.py", args: ["D:/Work/other.py"] }, "claude", inner, "W");
    expect(c.server.command).toBe("${WORKSPACE}/tool.py");
    expect(c.server.args).toEqual(["D:/Work/other.py"]);
    expect(c.elsewhere).toEqual([{ path: "D:/Work", tree: "W" }]);
  });

  test("machine.yaml с BOM: root add работает, BOM сохраняется", () => {
    const f = cliFixture({ projects: ["Org/p1"] });
    mkdirSync(`${f.dir}/drive`);
    put(`${f.config}/local/machine.yaml`, `\uFEFFworkspace: ${f.ws}\nagents: [claude]\n`);
    const r = f.run(["root", "add", `${f.dir}/drive`, "--tree", "Clients"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(read(`${f.config}/local/machine.yaml`)).toBe(`\uFEFFworkspace:\n  - ${f.ws}\n  - { path: "${f.dir}/drive", tree: "Clients" }\nagents: [claude]\n`);
  }, 30000);

  test("ветка внутри ветки другого корня — справка; root remove вложенного корня — что станет с его папками", () => {
    const f = cliFixture({ projects: ["Org/p1"] });
    git(`${f.dir}/drive/Acme/site`);
    git(`${f.dir}/sub/proj`);
    git(`${f.ws}/Cloud/c1`);
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: `${f.dir}/drive`, tree: "Clients" }, { path: `${f.dir}/sub`, tree: "Clients/Sub" }, { path: `${f.ws}/Cloud`, tree: "Cloud" }])}agents: [claude]\n`);
    expect(f.run(["doctor"]).out).toContain(`Ветки корней внутри чужих мест (1) — не ошибка, но проекты этих корней получают слои этих мест:\n  корень ${f.dir}/sub: ветка layers/tree/Clients/Sub лежит внутри места Clients (там же: ${f.dir}/drive — корень, ветка Clients) — своих слоёв у Clients пока нет, но всё, что там появится, получат и его проекты.`);
    const r = f.run(["root", "remove", `${f.ws}/Cloud`, "--dry-run"]);
    expect(r.code).toBe(0);
    const rm = f.run(["root", "remove", `${f.ws}/Cloud`]);
    expect(rm.out).toContain(`${f.ws}/Cloud лежит внутри корня ${f.ws}: после удаления его папки — обычные папки ${f.ws}. Следующий sync --all пересчитает их проекты по месту в ${f.ws}`);
    expect(rm.out).not.toContain("работает и без корня в workspace");
  }, 60000);
});
