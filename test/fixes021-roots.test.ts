// Выпуск 0.2.1, часть A (out/phase-021.md), корни, «забыть» и clean: A6 — подкаталог git-репо в root add; A7 — недоступный
// вложенный корень в группе — не «каталог без git»; A8 — --dry-run у root add и root remove как настоящий запуск; A9 —
// target --remove без диска; A12 — clean забытого проекта говорит, что могло остаться; A13 — итог clean --all при
// недоступном корне; A14 — «забыть» и агент, убранный из agents; A15 — копия CLAUDE.local.md, куда miksy только дописал
// блок; A16 — doctor после «забыть» и для серверов, убранных из слоёв до sync. Мастер setup (A6, A11) —
// test/fixes021-wizard.test.ts. Тесты рецензентов — out/reviewer-tests/… (указаны у тестов)
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { cliFixture, put } from "./helpers";
import { missingDrive } from "./nodrive";
import { git, inProcess, ledger, read, rootsFixture, yamlRoots } from "./rootshelp";

const genv = () => ({ ...process.env, GIT_CONFIG_NOSYSTEM: "1" });
const status = (dir: string) => Bun.spawnSync(["git", "-C", dir, "status", "--porcelain", "--untracked-files=all", "--ignored"], { env: genv() }).stdout.toString();
const unplug = (dir: string) => { renameSync(dir, `${dir}-disk`); mkdirSync(dir); };
const plugBack = (dir: string) => { rmSync(dir, { recursive: true }); renameSync(`${dir}-disk`, dir); };
const files = (dir: string, rel = ""): string[] => !existsSync(dir) ? [] : readdirSync(dir).flatMap((n) => {
  if (n === ".git") return [];
  const p = `${dir}/${n}`;
  return statSync(p).isDirectory() ? files(p, `${rel}${n}/`) : [`${rel}${n}`];
});
const targetsUnder = (config: string, dir: string) => Object.keys(ledger(config).targets).filter((k) => k.toLowerCase().includes(dir.toLowerCase()));
const SKILL = "---\nname: sk\ndescription: d\n---\nbody\n";

describe("A6 — root add подкаталога git-репо: объяснение, совет и вопрос, как у самого репо", () => {
  test("вне workspace: без терминала — отказ с советом (корнем — папка, где лежит репо) и командой с --yes; в терминале — вопрос, «нет» по умолчанию", () => {
    const f = cliFixture({ projects: ["Org/p1"] });
    git(`${f.dir}/other/repo`);
    const src = `${f.dir}/other/repo/src`;
    mkdirSync(src, { recursive: true });
    const r = f.run(["root", "add", src, "--tree", "R"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain(`${src} — папка внутри git-репо ${f.dir}/other/repo`);
    expect(r.err).toContain(`miksy root add "${f.dir}/other"`);
    expect(r.err).toContain(`miksy root add "${src}" --tree R --yes`);
    const t = inProcess(f, ["root", "add", src, "--tree", "R"], f.dir, [false]);
    expect({ q: t.questions.length, out: t.out.includes("Корень не добавлен") }).toEqual({ q: 1, out: true });
    expect(read(`${f.config}/local/machine.yaml`)).not.toContain("repo/src");
    const y = f.run(["root", "add", src, "--tree", "R", "--yes"]);
    expect(y.code).toBe(0);
    expect(read(`${f.config}/local/machine.yaml`)).toContain("repo/src");
  }, 120000);

  test("подпапка проекта в workspace — «папка внутри проекта», совет miksy sync проекта; папка с проектами внутри git-репо — без вопроса", () => {
    const f = cliFixture({ projects: ["Org/p1"] });
    const sub = `${f.ws}/Org/p1/docs`;
    mkdirSync(sub, { recursive: true });
    const r = f.run(["root", "add", sub, "--tree", "Docs"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain(`папка внутри проекта ${f.ws}/Org/p1`);
    expect(r.err).toContain(`miksy sync "${f.ws}/Org/p1"`);
    // Монорепо: внутри папки apps — свои git-репо: это папка с проектами
    git(`${f.dir}/mono`);
    git(`${f.dir}/mono/apps/x`);
    const ok = f.run(["root", "add", `${f.dir}/mono/apps`, "--tree", "Apps"]);
    expect({ code: ok.code, err: ok.err }).toEqual({ code: 0, err: "" });
  }, 120000);
});

describe("A7 — недоступный вложенный корень в группе (zz-b-nested-away, тест 1)", () => {
  test("пустая точка монтирования Grp/Inner: sync --all и doctor не советуют git init / miksy target", () => {
    const f = rootsFixture(["claude"]);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    const keys = Object.keys(ledger(f.config).targets).sort();
    renameSync(f.inner, `${f.dir}/inner-disk`);
    mkdirSync(f.inner);
    const s = inProcess(f, ["sync", "--all", "--yes"], f.dir, null);
    const d = inProcess(f, ["doctor"], f.dir, null);
    expect(Object.keys(ledger(f.config).targets).sort()).toEqual(keys);
    expect(s.out).not.toMatch(/Grp\/Inner[^\n]*git init/);
    expect(d.out.split("\n")).not.toContain("  Grp/Inner");
    expect(d.out).not.toMatch(/Grp\/Inner[^\n]*git init/);
  }, 120000);
});

describe("A8 — --dry-run у root add и root remove — как настоящий запуск в том же режиме", () => {
  test("root add <git-репо> --dry-run: без терминала — «не будет добавлен, нужно --yes»; в терминале — «будет вопрос … «нет»» (zz-b6z-rootadd)", () => {
    const f = cliFixture({ projects: ["Org/p1"] });
    const repo = `${f.dir}/repo`;
    git(repo);
    const dry = inProcess(f, ["root", "add", repo, "--tree", "R", "--dry-run"], f.dir, null);
    expect(dry.err).toBe("");
    expect(dry.out).toContain("без терминала корень не будет добавлен");
    expect(dry.out).toContain(`miksy root add "${repo}" --tree R --yes`);
    expect(dry.out).not.toContain("Новый корень");
    const real = inProcess(f, ["root", "add", repo, "--tree", "R"], f.dir, null);
    expect(real.err).toContain("--yes");
    const term = inProcess(f, ["root", "add", repo, "--tree", "R", "--dry-run"], f.dir, []);
    expect(term.err).toBe("");
    expect(term.out).toMatch(/будет вопрос «Всё равно сделать [^»]+ корнем workspace\?» — по умолчанию «нет»/);
    expect(term.out).toContain("Новый корень");
    expect(term.out).toContain("Записать настройки проектам workspace сейчас");
    expect(read(`${f.config}/local/machine.yaml`)).not.toContain(repo);
  }, 60000);

  test("root remove <доступный корень> --dry-run: в терминале — вопрос «Убрать записанное…» с «да» по умолчанию; без терминала — что останется и команды clean (zz-review-root2)", () => {
    const f = cliFixture({ projects: ["Org/p1"] });
    const drive = `${f.dir}/drive`, site = `${drive}/Acme/site`;
    git(site);
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive, tree: "Clients" }])}agents: [claude]\n`);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    const no = f.run(["root", "remove", drive, "--dry-run"]);
    expect(no.out).toContain("Без терминала вопроса нет — записанное в проекты и учёт останутся");
    expect(no.out).toContain(`miksy clean "${site}"`);
    const yes = inProcess(f, ["root", "remove", drive, "--dry-run"], f.dir, []);
    expect(yes.out).toMatch(/Будет вопрос «Убрать записанное miksy в эти проекты сейчас\?» — по умолчанию «да»/);
    // Настоящий запуск в терминале с «да» — то, что обещал план
    const real = inProcess(f, ["root", "remove", drive], f.dir, [true]);
    expect({ err: real.err, q: real.questions.length, left: files(site) }).toEqual({ err: "", q: 1, left: [] });
  }, 120000);
});

describe("A9 — target --remove без диска (zz-review-target-away)", () => {
  test("корень на отсутствующем диске: пометку снять можно, без «симлинк…»", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const away = missingDrive("Clients");
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: away, tree: "Clients" }])}agents: [claude]\n`);
    put(`${f.config}/layers/tree/Clients/Notes/layer.yaml`, "target: true\n");
    const dry = inProcess(f, ["target", `${away}/Notes`, "--remove", "--dry-run"]);
    expect({ code: dry.code, err: dry.err }).toEqual({ code: 0, err: "" });
    expect(dry.out).toContain("снять пометку цели");
    const r = inProcess(f, ["target", `${away}/Notes`, "--remove"]);
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
    expect(existsSync(`${f.config}/layers/tree/Clients/Notes/layer.yaml`)).toBe(false);
  });
});

describe("A12 — clean забытого проекта говорит, что могло остаться (review6x, F2)", () => {
  test("«забыть» → диск вернулся → clean: подсказка sync, затем clean; по ней — ничего от miksy", () => {
    const f = rootsFixture(["claude", "codex", "opencode", "antigravity"]);
    const app = `${f.archive}/Acme/app`;
    put(`${f.config}/layers/tree/Archive/skills/sk/SKILL.md`, SKILL);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    unplug(f.archive);
    expect(f.run(["clean", app, "--forget"]).code).toBe(0);
    plugBack(f.archive);
    const c1 = f.run(["clean", app]);
    expect(c1.code).toBe(0);
    expect(c1.out).toContain("Проект был забыт");
    expect(c1.out).toContain(`miksy sync "${app}"; miksy clean "${app}"`);
    // По подсказке
    expect(f.run(["sync", app]).code).toBe(0);
    const c2 = f.run(["clean", app]);
    expect({ code: c2.code, again: c2.out.includes("Проект был забыт"), left: files(app), git: status(app) }).toEqual({ code: 0, again: false, left: [], git: "" });
  }, 180000);
});

describe("A13 — clean --all при недоступном корне (zz-b6z-cleanall)", () => {
  test("итог: что осталось на недоступном диске и что сделать; root remove --forget по подсказке — учёта нет", () => {
    const f = rootsFixture(["claude"]);
    expect(f.run(["sync", "--global"]).code).toBe(0);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    unplug(f.archive);
    const dry = f.run(["clean", "--all", "--dry-run"]);
    expect(dry.out).toContain(`Корень ${f.archive} недоступен`);
    expect(dry.out).toContain("останется записанное miksy");
    const r = inProcess(f, ["clean", "--all"], f.dir, []);
    expect(r.err).toBe("");
    expect(r.out).toContain(`Корень ${f.archive} недоступен`);
    expect(r.out).toContain("Подключите диск и повторите miksy clean --all");
    const hint = r.out.match(/miksy root remove "([^"]+)" --forget/);
    expect(hint?.[1]).toBe(f.archive);
    expect(targetsUnder(f.config, "/Acme/app").length).toBeGreaterThan(0);
    expect(f.run(["root", "remove", hint![1], "--forget"]).code).toBe(0);
    expect(targetsUnder(f.config, "/Acme/app")).toEqual([]);
  }, 180000);
});

describe("A14 — «забыть» и агент, убранный из agents без clean (review6x, E)", () => {
  test("root remove --forget: план и сделанное совпадают — забывается и учёт агента вне agents; doctor называет его учёт и команду, которая убирает его файлы", () => {
    const f = rootsFixture(["claude", "codex"]);
    const app = `${f.archive}/Acme/app`, p1 = `${f.ws}/Org/p1`;
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(existsSync(`${p1}/.codex/config.toml`)).toBe(true);
    // codex убрали из agents без clean
    put(`${f.config}/local/machine.yaml`, read(`${f.config}/local/machine.yaml`).replace("agents: [claude, codex]", "agents: [claude]"));
    const doc = f.run(["doctor"]).out;
    expect(doc).toContain("Учёт агентов, которых нет в agents");
    expect(doc).toContain(`miksy clean "${p1}" --agent codex`);
    unplug(f.archive);
    const dry = f.run(["root", "remove", f.archive, "--forget", "--dry-run"]);
    const planned = Number(dry.out.match(/записанное в его проекты \((\d+) файл\S*\) забывается/)?.[1]);
    const r = f.run(["root", "remove", f.archive, "--forget"]);
    expect(r.code).toBe(0);
    const done = [...r.out.matchAll(/\((\d+) файл\S* на недоступном диске\) забыто/g)].map((m) => Number(m[1]));
    expect(done.length).toBe(1);
    expect(planned).toBe(done[0]);
    expect(targetsUnder(f.config, "/Acme/app")).toEqual([]);
    // Команда из doctor убирает файлы codex
    expect(f.run(["clean", p1, "--agent", "codex"]).code).toBe(0);
    expect(existsSync(`${p1}/.codex/config.toml`)).toBe(false);
    expect(f.run(["doctor"]).out).not.toContain(`miksy clean "${p1}" --agent codex`);
  }, 180000);
});

describe("A15 — «забыто»: копия CLAUDE.local.md, куда miksy только дописал блок, — не «заменённый файл»", () => {
  test("файл пользователя с блоком miksy: сообщение о нём отдельно — файл на месте, уберётся только блок", () => {
    const f = rootsFixture(["claude"]);
    const app = `${f.archive}/Acme/app`;
    put(`${app}/CLAUDE.local.md`, "# мои заметки\n");
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    unplug(f.archive);
    const c = f.run(["clean", app, "--forget"]);
    expect(c.out).not.toContain("которые miksy когда-то заменил");
    expect(c.out).toContain("В 1 файле (CLAUDE.local.md и т. п.) miksy только дописал свой блок");
    plugBack(f.archive);
    // Диск вернулся: sync берёт блок обратно, clean убирает только его — заметки пользователя на месте
    expect(f.run(["sync", app]).code).toBe(0);
    expect(f.run(["clean", app]).code).toBe(0);
    expect(read(`${app}/CLAUDE.local.md`)).toBe("# мои заметки\n");
  }, 120000);
});

describe("A16 — doctor после «забыть» и для серверов, убранных из слоёв до sync (review6w)", () => {
  test("забытый проект — своя строка, а не «sync ни разу не запускался»", () => {
    const f = rootsFixture(["claude", "codex"]);
    const app = `${f.archive}/Acme/app`;
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    unplug(f.archive);
    expect(f.run(["clean", app, "--forget"]).code).toBe(0);
    plugBack(f.archive);
    const d = f.run(["doctor"]).out;
    expect(d).toContain("Проект забыт");
    expect(d).not.toMatch(/Не синхронизировано[^\n]*\n(  [^\n]*\n)*  [^\n]*Archive\/Acme\/app/);
  }, 120000);

  test("сервер убран из слоёв, пока диск был отключён: doctor не советует adopt для сервера, который записал miksy (opencode)", () => {
    const f = rootsFixture(["opencode"]);
    const app = `${f.archive}/Acme/app`;
    put(`${f.config}/layers/tree/Archive/mcp/old.yaml`, "name: old\ncommand: echo\nargs: [old]\n");
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(read(`${app}/opencode.json`)).toContain("\"old\"");
    unplug(f.archive);
    expect(f.run(["clean", app, "--forget"]).code).toBe(0);
    plugBack(f.archive);
    rmSync(`${f.config}/layers/tree/Archive/mcp/old.yaml`);
    const d = f.run(["doctor"]).out;
    expect(d).not.toMatch(/adopt[^\n]*\bold\b|\bold\b[^\n]*adopt|mcp old/);
  }, 120000);

  test("то же без «забыть» (учёт есть), все агенты: ~/.claude.json, .codex/config.toml, opencode.json, mcp_config.json — «устарело», не добавка", () => {
    const f = rootsFixture(["claude", "codex", "opencode", "antigravity"]);
    put(`${f.config}/layers/tree/Archive/mcp/old.yaml`, "name: old\ncommand: echo\nargs: [old]\n");
    put(`${f.config}/layers/global/mcp/gold.yaml`, "name: gold\ncommand: echo\nargs: [gold]\n");
    expect(f.run(["sync", "--global"]).code).toBe(0);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    rmSync(`${f.config}/layers/tree/Archive/mcp/old.yaml`);
    rmSync(`${f.config}/layers/global/mcp/gold.yaml`);
    const d = f.run(["doctor"]).out;
    expect(d).not.toMatch(/mcp old|mcp gold/);
    expect(d).toContain("Устарело");
  }, 180000);

  test("сервер miksy пропущен: новому определению в слое нужны переменные, которых на машине нет (живой случай Mac) — запись miksy остаётся, doctor не зовёт её добавкой", () => {
    const f = rootsFixture(["claude", "codex", "opencode", "antigravity"]);
    const p1 = `${f.ws}/Org/p1`;
    put(`${f.config}/local/secrets.env`, "GD_TOKEN=abcdefgh12345678\n");
    put(`${f.config}/layers/tree/Org/mcp/gdrive.yaml`, "name: gdrive\ncommand: echo\nargs: [gd]\nenv:\n  T: ${GD_TOKEN}\n");
    put(`${f.config}/layers/global/mcp/ggdrive.yaml`, "name: ggdrive\ncommand: echo\nargs: [gd]\nenv:\n  T: ${GD_TOKEN}\n");
    expect(f.run(["sync", "--global"]).code).toBe(0);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    // Новое определение — с переменной, которой нет
    put(`${f.config}/layers/tree/Org/mcp/gdrive.yaml`, "name: gdrive\ncommand: echo\nargs: [gd]\nenv:\n  T: ${GD_TOKEN}\n  O: ${GD_OTHER}\n");
    put(`${f.config}/layers/global/mcp/ggdrive.yaml`, "name: ggdrive\ncommand: echo\nargs: [gd]\nenv:\n  T: ${GD_TOKEN}\n  O: ${GD_OTHER}\n");
    const g = f.run(["sync", "--global"]);
    const s = f.run(["sync", "--all", "--yes"]);
    expect(s.out).toContain("пропущен сервер gdrive — не заданы переменные GD_OTHER");
    expect(g.out).toContain("пропущен сервер ggdrive");
    // Прежняя запись miksy осталась у агентов (keep)
    expect(read(`${p1}/opencode.json`)).toContain("gdrive");
    expect(read(`${p1}/.codex/config.toml`)).toContain("gdrive");
    expect(read(`${f.home}/.claude.json`)).toContain("gdrive");
    const d = f.run(["doctor"]).out;
    expect(d).not.toMatch(/mcp g?gdrive/);
    expect(d).not.toMatch(/adopt[^\n]*gdrive/);
  }, 180000);
});
