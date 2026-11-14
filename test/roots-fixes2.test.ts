// Фаза 0.2.0, исправления после второй проверки (out/phase-roots-fixes2.md): корень на корне диска, clean и
// root remove при недоступном корне (вопрос, --forget, что остаётся в учёте), doctor при недоступном корне,
// справка о ветке внутри чужого места, setup --force с несколькими корнями, sync без пути в служебном
// каталоге и в каталоге, который содержит корень. Тесты рецензента 6t (R1–R9) — здесь, ожидания — по
// решениям владельца
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { fromNative } from "../src/adopt";
import { parseRoots } from "../src/load";
import { driveRoot, trimSlash } from "../src/paths";
import { expandPath } from "../src/setup";
import { cliFixture, put } from "./helpers";
import { missingDrive } from "./nodrive";
import { git, inProcess, ledger, read, rootsFixture, yamlRoots } from "./rootshelp";

const win = process.platform === "win32";
const status = (dir: string) => Bun.spawnSync(["git", "-C", dir, "status", "--porcelain", "--untracked-files=all"]).stdout.toString();
// Диск «отключён»: каталог корня пуст, в учёте есть его цели — корень недоступен
const unplug = (dir: string) => { renameSync(dir, `${dir}-disk`); mkdirSync(dir); };
const plugBack = (dir: string) => { rmSync(dir, { recursive: true }); renameSync(`${dir}-disk`, dir); };

describe("R1: корень на корне диска — X:/ остаётся X:/", () => {
  test("косая в конце — прочь, кроме корня; X: — корень диска, а не текущий каталог диска", () => {
    expect(["C:/", "/", "/a/", "C:/a/", "C:/a", "//srv/share/"].map(trimSlash)).toEqual(["C:/", "/", "/a", "C:/a", "C:/a", "//srv/share"]);
    expect(["C:", "C:x", "/"].map(driveRoot)).toEqual(["C:/", "C:x", "/"]);
    expect(expandPath("/", "/home/u", "/x")).toBe("/");
  });

  test.skipIf(!win)("мастер (основной корень, «Есть ещё папки», setup --force) и machine.yaml: «G:/» и «G:» — корень диска G:/", () => {
    expect(expandPath("G:/", "C:/Users/u", "D:/x")).toBe("G:/");
    expect(expandPath("G:", "C:/Users/u", "D:/x")).toBe("G:/");
    const f = cliFixture({ projects: [] });
    const drive = f.dir.slice(0, 2);
    expect(parseRoots([f.ws, { path: drive, tree: "Disk" }], "m.yaml")[1].path).toBe(`${drive}/`);
    expect(parseRoots([f.ws, { path: `${drive}/`, tree: "Disk" }], "m.yaml")[1].path).toBe(`${drive}/`);
  });

  test.skipIf(!win)("miksy target X:/ (корень на корне диска) — ошибка «корень — не цель», а не пометка текущего каталога", () => {
    const f = cliFixture({ projects: ["Org/p1"] });
    const drive = f.dir.slice(0, 2);
    mkdirSync(`${f.ws}/Org/notes`, { recursive: true });
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: `${drive}/`, tree: "Disk" }])}agents: [claude]\n`);
    const r = inProcess(f, ["target", `${drive}/`, "--dry-run"], `${f.ws}/Org/notes`);
    expect(r.out).not.toContain("сделать целью");
    expect(r.err).toContain("сам workspace (корень)");
    expect(inProcess(f, ["target", drive, "--dry-run"], `${f.ws}/Org/notes`).err).toContain("сам workspace (корень)");
    expect(inProcess(f, ["root"], f.dir).out).toContain(`  ${drive}/ → layers/tree/Disk`);
  }, 60000);
});

describe("R2: doctor при недоступном корне", () => {
  test("слияния в файлах проектов недоступного корня не проверяются — нет ложной проблемы «Ключи пропали»", () => {
    const f = cliFixture({ agents: ["opencode"], projects: ["Org/p1"] });
    const drive = `${f.dir}/drive`;
    git(`${drive}/Acme/site`);
    put(`${drive}/Acme/site/opencode.json`, "{}\n");
    put(`${f.config}/layers/tree/mcp/ws.yaml`, "name: ws\ncommand: echo\nargs: [x]\n");
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive, tree: "Clients" }])}agents: [opencode]\n`);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(f.run(["doctor"]).out).not.toContain("Ключи пропали");
    unplug(drive);
    const d = f.run(["doctor"]);
    expect(d.out).toContain("Учёт целей недоступного корня (1) не проверяется");
    expect(d.out).not.toContain("Ключи пропали");
  }, 90000);
});

describe("A.2: clean каталога, до которого не дотянуться, — убирает достижимое, остальное помнит или забывает", () => {
  // Проект archive/Acme/app записан (CLAUDE.local.md, ключи в ~/.claude.json, блок .git/info/exclude), диск отключён
  const unplugged = () => {
    const f = rootsFixture();
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    const app = `${f.archive}/Acme/app`;
    const projects = () => JSON.parse(read(`${f.home}/.claude.json`)).projects ?? {};
    expect(projects()[app].mcpServers.ws).toBeDefined();
    unplug(f.archive);
    const mine = () => Object.entries(ledger(f.config).targets).filter(([k]) => k.includes("/archive/"));
    return { ...f, app, projects, mine };
  };

  test("без терминала и без --forget: ключи в домашних конфигах убраны, учёт файлов на диске остался; диск вернулся — clean убирает их", () => {
    const f = unplugged();
    const r = f.run(["clean", f.app]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`На недоступном диске осталось записанное miksy — 2 файла в ${f.app}: подключите диск и повторите miksy clean "${f.app}"; данных больше нет — miksy clean "${f.app}" --forget.`);
    expect(f.projects()[f.app]?.mcpServers?.ws).toBeUndefined();
    const [[, st]] = f.mine();
    expect(Object.keys(st.blocks ?? {}).some((p) => p.endsWith("/Acme/app/CLAUDE.local.md"))).toBe(true);
    expect(Object.keys(st.merges).some((p) => p.endsWith(".claude.json"))).toBe(false);
    // doctor не прячет оставленное: обе подсказки
    expect(f.run(["doctor"]).out).toContain(`Учёт целей недоступного корня (1) не проверяется — подключите диск: ${f.app}. Убрать записанное туда (2 файла): диск вернётся — miksy clean "<путь>"; данных больше нет — miksy clean "<путь>" --forget`);
    plugBack(f.archive);
    expect(read(`${f.app}/CLAUDE.local.md`)).toContain("# workspace");
    expect(f.run(["clean", f.app]).code).toBe(0);
    expect(read(`${f.app}/CLAUDE.local.md`)).toBe("");
    expect(f.mine()).toEqual([]);
    expect(status(f.app)).toBe("");
  }, 120000);

  test("в терминале — вопрос (по умолчанию «нет»); «да» и --forget забывают целиком; диск нашёлся — sync узнаёт блок miksy и берёт его обратно сам (6v)", () => {
    const f = unplugged();
    const no = inProcess(f, ["clean", f.app], f.dir, [false]);
    expect(no.code).toBe(0);
    expect(no.questions).toEqual([`Каталога ${f.app} нет: диск не подключён или данных больше нет? Забыть записанное туда (2 файла)?`]);
    expect(f.mine().length).toBe(1);
    const yes = inProcess(f, ["clean", f.app], f.dir, [true]);
    expect(yes.out).toContain(`Записанное в ${f.app} (2 файла на недоступном диске) забыто. Если диск найдётся: miksy sync "${f.app}"`);
    expect(f.mine()).toEqual([]);
    plugBack(f.archive);
    const sync = f.run(["sync", f.app]);
    expect(sync.code).toBe(0);
    expect(sync.out).toContain("взять под учёт — блок miksy, которого не было в учёте");
    // Сгенерированный файл не открыт git: строка его в блоке exclude miksy осталась
    expect(read(`${f.app}/.git/info/exclude`)).toContain("/CLAUDE.local.md");
    expect(status(f.app)).toBe("");
    expect(f.mine().length).toBe(1);
    expect(f.run(["sync", f.app]).out).toContain("изменений нет");
  }, 120000);

  test("--forget без терминала; каталог удалён при доступном корне — забывается без вопроса", () => {
    const f = unplugged();
    const r = f.run(["clean", f.app, "--forget"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("забыто");
    expect(f.mine()).toEqual([]);
    // Доступный корень, каталога проекта нет — данных точно нет: без вопроса. (Корень, в котором после
    // этого не осталось ничего, а в учёте есть цели, считался бы пустой точкой монтирования — поэтому
    // проект основного корня, где есть и другие)
    plugBack(f.archive);
    rmSync(`${f.ws}/Org/p1`, { recursive: true });
    const gone = inProcess(f, ["clean", `${f.ws}/Org/p1`], f.dir, []);
    expect(gone.err).toBe("");
    expect(gone.questions).toEqual([]);
    expect(Object.keys(ledger(f.config).targets).some((k) => k.includes("/Org/p1"))).toBe(false);
  }, 120000);

  test("root remove недоступного корня: вопрос «забыть» (по умолчанию «нет») — без согласия корень убран, учёт остался, doctor — обе подсказки; --forget — забыто", () => {
    const f = unplugged();
    const r = inProcess(f, ["root", "remove", f.archive], f.dir, [false]);
    expect(r.err).toBe("");
    expect(r.questions).toEqual([`Корень ${f.archive} недоступен (пуст, а в учёте есть его цели — диск не смонтирован?): диск не подключён или данных больше нет? Забыть записанное в его проекты (2 файла)?`]);
    expect(r.out).toContain("Корень недоступен — записанное в его проекты и учёт не тронуты. Когда диск вернётся — miksy clean \"<путь проекта>\" уберёт 2 файла");
    expect(read(`${f.config}/local/machine.yaml`)).not.toContain(f.archive);
    expect(f.mine().length).toBe(1);
    // Каталога нет, корня в workspace нет — не «пропавший», а «осталось убрать»
    rmSync(f.archive, { recursive: true });
    const d = f.run(["doctor"]).out;
    expect(d).not.toContain("Учёт ссылается на несуществующие каталоги");
    expect(d).toContain(`Учёт целей вне workspace без каталога (1; 2 файла): ${f.app} — каталога нет: диск не подключён или папку удалили. Убрать записанное туда: диск вернётся — miksy clean "<путь>"; папки больше нет — miksy clean "<путь>" (спросит, забыть ли; без терминала — --forget)`);
    // clean без --forget — тоже не забывает
    expect(f.run(["clean", f.app]).out).toContain("На недоступном диске осталось записанное miksy");
    expect(f.mine().length).toBe(1);
    expect(f.run(["clean", f.app, "--forget"]).code).toBe(0);
    expect(f.mine()).toEqual([]);
  }, 120000);

  test("root remove --forget недоступного корня без терминала — достижимое убрано, учёт забыт", () => {
    const f = unplugged();
    const r = f.run(["root", "remove", f.archive, "--forget"]);
    expect(r.code).toBe(0);
    expect(f.mine()).toEqual([]);
    expect(f.projects()[f.app]?.mcpServers?.ws).toBeUndefined();
    expect(f.run(["root", "remove", f.books, "--forget", "--dry-run"]).code).toBe(0);
    expect(f.run(["root", "add", f.books, "--forget"]).code).toBe(2);
  }, 120000);
});

describe("A.3: root remove — один корень без ветки записывается строкой", () => {
  test("после удаления последнего дополнительного — workspace: <путь> (так его поймёт и 0.1.x)", () => {
    const f = cliFixture({ projects: ["Org/p1"] });
    mkdirSync(`${f.dir}/drive`);
    put(`${f.config}/local/machine.yaml`, `# машина\nworkspace:\n  - "${f.ws}"  # основной\n  - { path: "${f.dir}/drive", tree: Clients }\nagents: [claude]\n`);
    expect(f.run(["root", "remove", `${f.dir}/drive`]).code).toBe(0);
    expect(read(`${f.config}/local/machine.yaml`)).toBe(`# машина\nworkspace: "${f.ws}"  # основной\nagents: [claude]\n`);
    // С веткой у основного — остаётся списком
    put(`${f.config}/local/machine.yaml`, `workspace:\n  - { path: "${f.ws}", tree: Main }\n  - { path: "${f.dir}/drive", tree: Clients }\nagents: [claude]\n`);
    expect(f.run(["root", "remove", `${f.dir}/drive`]).code).toBe(0);
    expect((Bun.YAML.parse(read(`${f.config}/local/machine.yaml`)) as { workspace: unknown }).workspace).toEqual([{ path: f.ws, tree: "Main" }]);
  }, 60000);
});

describe("R6: setup --force при недоступном основном корне", () => {
  test("не падает: недоступный каталог не создаётся, machine.yaml записывается", () => {
    const f = cliFixture({ projects: [] });
    const drive = `${f.dir}/drive`;
    git(`${drive}/Acme/site`);
    const away = missingDrive("Work");
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([away, { path: drive, tree: "Clients" }])}agents: [claude]\n`);
    const r = inProcess(f, ["setup", "--force", "--yes"], f.dir);
    expect(r.err).toBe("");
    // Не обещает создать то, что создать нельзя, и не пытается (под root на POSIX это создало бы каталог)
    expect(r.out).toContain(`Workspace: ${away}  (сейчас недоступен — нет диска; создаваться не будет`);
    expect(r.out).not.toContain("будет создан");
    expect(existsSync(away)).toBe(false);
    expect((Bun.YAML.parse(read(`${f.config}/local/machine.yaml`)) as { workspace: unknown }).workspace).toEqual([away, { path: drive, tree: "Clients" }]);
  }, 60000);
});

describe("R7 и подсказки sync без пути", () => {
  test("служебный каталог miksy (git-репо в local/ конфигурации): sync, --out и explain без пути — ошибка; явный путь — как в 0.1.1", () => {
    const f = cliFixture({ projects: ["Org/p1"] });
    const config = `${f.ws}/home/Miksy/miksy-config`;
    for (const p of ["map.yaml", "layers/global/instructions/00.md", "layers/tree/instructions/00.md", "local/machine.yaml"]) put(`${config}/${p}`, read(`${f.config}/${p}`));
    const backup = `${config}/local/backups/2026-11-01/repo`;
    git(backup);
    const g = { ...f, config };
    expect(inProcess(g, ["projects"]).out).not.toContain("local/backups");
    for (const args of [["sync", "--dry-run"], ["sync", "--out", `${f.dir}/box`, "--dry-run"], ["explain"]]) {
      const r = inProcess(g, args, backup);
      expect(r.code).toBe(-1);
      expect(r.err).toContain(`${backup} — служебный каталог miksy`);
    }
    expect(inProcess(g, ["sync", backup, "--dry-run"], f.dir).err).toBe("");
  }, 60000);

  test("каталог, в котором лежит корень, — не советует root add . (корнем стал бы весь каталог)", () => {
    const f = cliFixture({ projects: ["Org/p1"] });
    const r = f.run(["sync", "--dry-run"], { cwd: f.dir });
    expect(r.code).toBe(2);
    expect(r.err).toContain(`в нём лежит корень workspace ${f.ws} — перейдите в каталог проекта внутри него`);
    expect(r.err).not.toContain("root add");
    mkdirSync(`${f.dir}/elsewhere`);
    // Пустой каталог: проектов в нём нет — подсказка git init и корень выше (круг 6y, рецензия 6y п. 2); root add . —
    // только «если сюда вы будете класть проекты»
    const e = f.run(["sync", "--dry-run"], { cwd: `${f.dir}/elsewhere` }).err;
    expect(e).toContain("проектов (git-репо) в нём нет, а корень workspace — папка с проектами. Сделать его проектом — git init в нём");
    expect(e).toContain("если сюда вы будете класть проекты — miksy root add .");
  }, 60000);
});

describe("A.1 и R9: ветка корня внутри чужого места — справка с рекомендацией", () => {
  test("tree: Org/Sub при папке Org основного корня со своим слоем: doctor, root add, explain — что унаследуется и как вынести; проблемой не считается", () => {
    const f = cliFixture({ projects: ["Org/p1"] });
    git(`${f.dir}/drive/site`);
    put(`${f.config}/layers/tree/Org/mcp/org.yaml`, "name: org\ncommand: echo\nargs: [org]\n");
    put(`${f.config}/layers/tree/Org/instructions/10-org.md`, "# org\n");
    const add = f.run(["root", "add", `${f.dir}/drive`, "--tree", "Org/Sub"]);
    expect(add.code).toBe(0);
    const note = `корень ${f.dir}/drive: ветка layers/tree/Org/Sub лежит внутри места Org (там же: ${f.ws}/Org — папка корня ${f.ws}) — его проекты получают и слои layers/tree/Org (правила 10-org.md; MCP org). Не нужно — вынесите ветку из Org (например, tree: Org-Sub), а общее задайте явно слоем в map.yaml (docs/roots.md, «Правила нескольких корней»)`;
    expect(add.out).toContain(`справка: ${note}`);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(f.run(["sync", "--global"]).code).toBe(0);
    expect(Object.keys(JSON.parse(read(`${f.home}/.claude.json`)).projects[`${f.dir}/drive/site`].mcpServers)).toContain("org");
    const d = f.run(["doctor"]);
    expect(d.out).toContain(`Ветки корней внутри чужих мест (1) — не ошибка, но проекты этих корней получают слои этих мест:\n  ${note}`);
    expect(d.code).toBe(0);
    expect(f.run(["explain", `${f.dir}/drive/site`]).out).toContain("Ветка корня");
    // Вложенный корень на своём месте (ws/Org/Deep, tree Org/Deep) — не справка
    git(`${f.ws}/Org/Deep/x`);
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: `${f.ws}/Org/Deep`, tree: "Org/Deep" }])}agents: [claude]\n`);
    expect(f.run(["doctor"]).out).not.toContain("Ветки корней внутри чужих мест");
  }, 90000);
});

describe("рецензия 6u", () => {
  // Проект archive/Acme/app записан агентом, учёт забыт (clean --forget при отключённом диске), диск вернулся
  const forgotten = (agent: string) => {
    const f = rootsFixture([agent]);
    put(`${f.config}/layers/tree/Archive/skills/sk/SKILL.md`, "---\nname: sk\ndescription: d\n---\nbody\n");
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    const app = `${f.archive}/Acme/app`;
    expect(status(app)).toBe("");
    unplug(f.archive);
    expect(f.run(["clean", app, "--forget"]).code).toBe(0);
    plugBack(f.archive);
    return { ...f, app };
  };
  const leftovers = (app: string) => ["CLAUDE.local.md", ".codex/config.toml", ".agents/plugins/miksy/plugin.json", "opencode.json", ".opencode/miksy.md", ".claude/skills/sk/SKILL.md", ".agents/skills/sk/SKILL.md"]
    .filter((p) => existsSync(`${app}/${p}`) && /miksy|name: sk/.test(read(`${app}/${p}`)));

  for (const agent of ["claude", "codex", "antigravity", "opencode"])
    test(`${agent}: «забыть» → диск вернулся → sync не открывает git файлы miksy и берёт их обратно сам; sync --force, затем clean — проект как до miksy`, () => {
      const f = forgotten(agent);
      const s = f.run(["sync", f.app]);
      expect(s.out).not.toContain("ОШИБКА");
      // 6v: совпадающие с выводом файлы miksy — обратно под учёт без --force
      expect({ code: s.code, conflict: s.out.includes("КОНФЛИКТ"), known: s.out.includes("которого не было в учёте") }).toEqual({ code: 0, conflict: false, known: true });
      expect(status(f.app)).toBe("");
      expect(f.run(["sync", f.app]).out).toContain("изменений нет");
      expect(f.run(["sync", f.app, "--force"]).code).toBe(0);
      expect(f.run(["clean", f.app]).code).toBe(0);
      expect({ left: leftovers(f.app), git: status(f.app) }).toEqual({ left: [], git: "" });
    }, 120000);

  test("вложенный недоступный корень: root remove без «забыть» не убирает его (иначе учёт забылся бы молча); --forget — убирает и забывает", () => {
    const f = cliFixture({ projects: ["Org/p1"] });
    const mnt = `${f.ws}/mnt`;
    git(`${mnt}/G/a`);
    git(`${mnt}/solo`);
    put(`${f.config}/layers/tree/Data/G/layer.yaml`, "target: true\n");
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: mnt, tree: "Data" }])}agents: [claude]\n`);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    const keys = () => Object.keys(ledger(f.config).targets).filter((k) => k.includes("/mnt/"));
    expect(keys().length).toBe(2);
    renameSync(mnt, `${f.dir}/disk`);
    mkdirSync(mnt);
    const no = inProcess(f, ["root", "remove", mnt], f.dir, [false]);
    expect(no.code).toBe(1);
    expect(no.out).toContain(`Корень ${mnt} недоступен и лежит внутри корня ${f.ws}`);
    expect(no.out).toContain("Корень не убран");
    expect(read(`${f.config}/local/machine.yaml`)).toContain(mnt);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(keys().length).toBe(2);
    expect(f.run(["root", "remove", mnt]).code).toBe(1);
    expect(f.run(["root", "remove", mnt, "--forget"]).code).toBe(0);
    expect(keys()).toEqual([]);
    expect(read(`${f.config}/local/machine.yaml`)).not.toContain(mnt);
  }, 120000);

  test.skipIf(!win)("буква диска без косой (X:) в sync, clean и explain — корень диска, а не текущий каталог", () => {
    const f = cliFixture({ projects: ["Org/p1"] });
    const p1 = `${f.ws}/Org/p1`;
    expect(f.run(["sync", p1]).code).toBe(0);
    const drive = f.dir.slice(0, 2);
    const c = inProcess(f, ["clean", drive, "--dry-run"], p1);
    expect(c.out).not.toContain("CLAUDE.local.md");
    expect(c.err).toContain("вне workspace");
    expect(inProcess(f, ["sync", drive, "--dry-run"], p1).err).toContain("вне workspace");
    expect(inProcess(f, ["explain", drive], p1).out).toContain("вне workspace — только глобальные настройки");
  }, 60000);

  test("adopt: основной корень на корне диска (X:/) — свёрнутый путь после подстановки совпадает с исходным", () => {
    const m = { workspace: "X:/", roots: [{ path: "X:/", tree: "" }], home: "C:/Users/u", vars: {}, os: "windows" as const };
    const { server } = fromNative("t", { command: "python", args: ["X:/tools/x.py", "X:/"] }, "claude", m, "global");
    expect(server.args!.map((a) => a.replace("${WORKSPACE}", m.workspace))).toEqual(["X:/tools/x.py", "X:/"]);
  });

  test("служебный каталог вне workspace (конфигурация рядом с ним): sync без пути — «служебный каталог», а не root add", () => {
    const f = cliFixture({ projects: ["Org/p1"] });
    const backup = `${f.config}/local/backups/2026-11-01/repo`;
    git(backup);
    const r = f.run(["sync", "--dry-run"], { cwd: backup });
    expect(r.err).toContain(`${backup} — служебный каталог miksy`);
    expect(r.err).not.toContain("root add");
  }, 60000);

  test("путь внутри недоступного корня, которого нет в учёте, — понятная ошибка, а не ENOENT", () => {
    const f = cliFixture({ projects: ["Org/p1"] });
    const away = missingDrive("Data");
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: away, tree: "Data" }])}agents: [claude]\n`);
    const r = inProcess(f, ["sync", `${away}/proj`, "--dry-run"]);
    expect(r.err).toContain(`${away}/proj: каталога нет — корень ${away} недоступен (нет диска)`);
    expect(r.err).not.toContain("ENOENT");
  }, 60000);
});
