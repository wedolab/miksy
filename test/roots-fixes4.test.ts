// Фаза 0.2.0, исправления после четвёртой проверки (out/phase-roots-fixes4.md): после «забыть» и возвращения диска —
// файлы miksy, которые он больше не пишет, одобрения серверов .mcp.json, доверие Codex к узнанному файлу; корень-ссылка
// в никуда; план root remove --dry-run недоступного корня; оригиналы после «забыть». Тесты рецензента 6w (п. 1–8) —
// здесь, ожидания — по решениям владельца. Окружение подпроцессов (п. 9) — test/guardenv.test.ts
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { cliFixture, put } from "./helpers";
import { git, inProcess, ledger, read, rootsFixture, yamlRoots } from "./rootshelp";

// git — песочное окружение (test/guard.ts отдаёт его и запуску без env); системный конфиг выключен
const genv = () => ({ ...process.env, GIT_CONFIG_NOSYSTEM: "1" });
const status = (dir: string) => Bun.spawnSync(["git", "-C", dir, "status", "--porcelain", "--untracked-files=all"], { env: genv() }).stdout.toString();
const gitc = (dir: string, ...args: string[]) => Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { env: genv() });
// Диск «отключён»: каталог корня пуст, в учёте есть его цели — корень недоступен
const unplug = (dir: string) => { renameSync(dir, `${dir}-disk`); mkdirSync(dir); };
const plugBack = (dir: string) => { rmSync(dir, { recursive: true }); renameSync(`${dir}-disk`, dir); };
const local = (dir: string) => (existsSync(`${dir}/.claude/settings.local.json`) ? JSON.parse(read(`${dir}/.claude/settings.local.json`)) : {});
const exclude = (dir: string) => read(`${dir}/.git/info/exclude`);
// «Забыть» при отключённом диске, затем диск вернулся
const forgetAway = (f: { run: (a: string[]) => { code: number | null; out: string } }, root: string, app: string) => {
  unplug(root);
  const c = f.run(["clean", app, "--forget"]);
  expect(c.code).toBe(0);
  plugBack(root);
  return c;
};

describe("B.1: файл (блок) miksy, который после «забыть» miksy больше не пишет, — sync и clean убирают (рецензия 6w, п. 1)", () => {
  test("Codex: .codex/config.toml с шапкой (правила убрали из слоёв, пока диска не было) — sync убирает, строка exclude уходит, вопроса о «конфиге Codex не от miksy» нет", () => {
    const f = cliFixture({ agents: ["codex"], projects: ["Org/p1"] });
    const archive = `${f.dir}/archive`, app = `${archive}/Acme/app`;
    git(app);
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: archive, tree: "Archive" }])}agents: [codex]\n`);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(read(`${app}/.codex/config.toml`)).toContain("Сгенерировано miksy");
    forgetAway(f, archive, app);
    rmSync(`${f.config}/layers/tree/instructions`, { recursive: true });
    const s = f.run(["sync", app]);
    expect(s.out).toContain("файл miksy, которого не было в учёте, — больше не нужен");
    const c = f.run(["clean", app]);
    expect({ sync: s.code, clean: c.code, left: existsSync(`${app}/.codex/config.toml`), git: status(app), line: exclude(app).includes("/.codex/config.toml"), askTrustForOwnFile: s.out.includes("конфиг Codex не от miksy") })
      .toEqual({ sync: 0, clean: 0, left: false, git: "", line: false, askTrustForOwnFile: false });
    // Бэкап прежнего файла — в бэкапах запуска
    const runs = readdirSync(`${f.config}/local/backups`).filter((d) => d !== "originals");
    expect(runs.some((d) => existsSync(`${f.config}/local/backups/${d}`) && JSON.stringify(readdirSync(`${f.config}/local/backups/${d}`, { recursive: true })).includes("config.toml"))).toBe(true);
  }, 120000);

  test("Claude: блок miksy в CLAUDE.local.md, который miksy больше не пишет (в проекте появился вложенный репо), — sync убирает только блок", () => {
    const f = rootsFixture(["claude"]);
    const app = `${f.archive}/Acme/app`;
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    forgetAway(f, f.archive, app);
    git(`${app}/sub`);
    const s = f.run(["sync", app]);
    expect(s.out).toContain("блок miksy, которого не было в учёте, больше не нужен");
    expect(f.run(["sync", app, "--force"]).code).toBe(0);
    expect(f.run(["clean", app]).code).toBe(0);
    expect({ block: read(`${app}/CLAUDE.local.md`).includes("miksy:begin"), file: existsSync(`${app}/CLAUDE.local.md`), line: exclude(app).includes("/CLAUDE.local.md") })
      .toEqual({ block: false, file: false, line: false });
  }, 120000);

  test("текст пользователя вне блока остаётся, git его видит; clean цели без учёта (без sync) убирает так же", () => {
    const f = rootsFixture(["claude"]);
    const app = `${f.archive}/Acme/app`;
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    put(`${app}/CLAUDE.local.md`, `${read(`${app}/CLAUDE.local.md`)}\n# мои заметки\n`);
    expect(f.run(["sync", app, "--force"]).code).toBe(0);
    forgetAway(f, f.archive, app);
    git(`${app}/sub`);
    const c = f.run(["clean", app]);
    expect(c.code).toBe(0);
    expect(c.out).toContain("блок miksy, которого не было в учёте, больше не нужен");
    expect({ text: read(`${app}/CLAUDE.local.md`), git: status(app).split("\n").filter(Boolean).sort() }).toEqual({ text: "\n# мои заметки\n", git: ["?? CLAUDE.local.md", "?? sub/"] });
  }, 120000);

  test("clean цели без учёта: Codex после «забыть» — .codex/config.toml с шапкой и точной строкой убирается, строка уходит; повторный clean — изменений нет", () => {
    const f = rootsFixture(["codex"]);
    const app = `${f.archive}/Acme/app`;
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    forgetAway(f, f.archive, app);
    const c = f.run(["clean", app]);
    expect({ code: c.code, left: existsSync(`${app}/.codex/config.toml`), line: exclude(app).includes("/.codex/config.toml"), git: status(app) })
      .toEqual({ code: 0, left: false, line: false, git: "" });
    expect(f.run(["clean", app]).out).toContain("изменений нет");
  }, 120000);

  test("свой: файл с шапкой miksy на пути, который miksy в этом проекте не пишет, без строки в exclude — sync и clean не трогают (и после «забыть»)", () => {
    const f = rootsFixture(["claude"]);
    const app = `${f.archive}/Acme/app`;
    const md = "<!-- Сгенерировано miksy (слои: tree). Не править вручную — изменения вносить в конфигурацию miksy (слои). -->\n# скопировано\n";
    const toml = "# Сгенерировано miksy. Не править вручную — изменения вносить в конфигурацию miksy (слои).\nmodel = \"x\"\n";
    put(`${app}/docs/rules.md`, md);
    put(`${app}/.codex/config.toml`, toml);
    const check = () => expect({ md: read(`${app}/docs/rules.md`), toml: read(`${app}/.codex/config.toml`), git: status(app).split("\n").filter(Boolean).sort() })
      .toEqual({ md, toml, git: ["?? .codex/config.toml", "?? docs/rules.md"] });
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    check();
    forgetAway(f, f.archive, app);
    expect(f.run(["sync", app]).code).toBe(0);
    check();
    expect(f.run(["clean", app]).code).toBe(0);
    check();
    // clean цели без учёта — тоже не трогает
    expect(f.run(["sync", app]).code).toBe(0);
    forgetAway(f, f.archive, app);
    expect(f.run(["clean", app]).code).toBe(0);
    check();
  }, 120000);

  test("файл с шапкой под точной строкой, но отслеживаемый git (команда закоммитила), — не трогается", () => {
    const f = rootsFixture(["codex"]);
    const app = `${f.archive}/Acme/app`;
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    forgetAway(f, f.archive, app);
    const text = read(`${app}/.codex/config.toml`);
    gitc(app, "add", "-f", ".codex/config.toml");
    gitc(app, "commit", "-qm", "team");
    rmSync(`${f.config}/layers/tree/instructions`, { recursive: true });
    expect(f.run(["sync", app]).code).toBe(0);
    expect(f.run(["clean", app]).code).toBe(0);
    expect(read(`${app}/.codex/config.toml`)).toBe(text);
  }, 120000);
});

describe("B.2: одобрения .mcp.json после «забыть» (рецензия 6w, п. 2)", () => {
  const team = (app: string) => {
    put(`${app}/.mcp.json`, JSON.stringify({ mcpServers: { team: { command: "team-server" } } }));
    gitc(app, "add", ".mcp.json");
    gitc(app, "commit", "-qm", "team");
  };

  test("trust: claude: true в слое — sync берёт одобрения обратно (строка exclude остаётся, git файла не видит), clean их снимает", () => {
    const f = rootsFixture(["claude"]);
    const app = `${f.archive}/Acme/app`;
    team(app);
    put(`${f.config}/layers/tree/Archive/layer.yaml`, "trust: { claude: true }\n");
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(local(app).enabledMcpjsonServers).toEqual(["team"]);
    expect(status(app)).toBe("");
    forgetAway(f, f.archive, app);
    const s = f.run(["sync", app]);
    expect(s.out).toContain("взять под учёт — одобрения miksy, которых не было в учёте (team)");
    const afterSync = status(app);
    const c = f.run(["clean", app]);
    expect({ sync: s.code, afterSync, clean: c.code, afterClean: status(app), approvals: local(app).enabledMcpjsonServers ?? [] })
      .toEqual({ sync: 0, afterSync: "", clean: 0, afterClean: "", approvals: [] });
  }, 120000);

  test("решение пользователя «да» (miksy trust --confirm): после «забыть» sync не спрашивает решение снова", () => {
    const f = rootsFixture(["claude"]);
    const app = `${f.archive}/Acme/app`;
    team(app);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(f.run(["trust", app, "--confirm"]).code).toBe(0);
    expect(local(app).enabledMcpjsonServers).toEqual(["team"]);
    expect(f.run(["sync", app]).out).not.toContain("Нужно решение");
    forgetAway(f, f.archive, app);
    const s = f.run(["sync", app]);
    expect({ ask: s.out.includes("Нужно решение"), git: status(app) }).toEqual({ ask: false, git: "" });
  }, 120000);

  test("основания одобрить сейчас нет (trust убрали из слоя, пока диска не было) — одобрения чужие: не в учёт, clean их не снимает", () => {
    const f = rootsFixture(["claude"]);
    const app = `${f.archive}/Acme/app`;
    team(app);
    put(`${f.config}/layers/tree/Archive/layer.yaml`, "trust: { claude: true }\n");
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    forgetAway(f, f.archive, app);
    rmSync(`${f.config}/layers/tree/Archive/layer.yaml`);
    const s = f.run(["sync", app]);
    expect(s.out).not.toContain("одобрения miksy, которых не было в учёте");
    expect(s.out).toContain("Нужно решение");
    expect(f.run(["clean", app]).code).toBe(0);
    expect(local(app).enabledMcpjsonServers).toEqual(["team"]);
  }, 120000);

  test("одобрение без строки miksy в exclude (Claude записал его сам по ответу пользователя) — чужое, даже если miksy одобрил бы", () => {
    const f = rootsFixture(["claude"]);
    const app = `${f.archive}/Acme/app`;
    team(app);
    put(`${app}/.claude/settings.local.json`, JSON.stringify({ enabledMcpjsonServers: ["team"] }));
    put(`${f.config}/layers/tree/Archive/layer.yaml`, "trust: { claude: true }\n");
    const s = f.run(["sync", app]);
    expect(s.out).not.toContain("одобрения miksy, которых не было в учёте");
    expect(f.run(["clean", app]).code).toBe(0);
    expect(local(app).enabledMcpjsonServers).toEqual(["team"]);
  }, 120000);
});

describe("B.3: Codex после «забыть» — узнанный .codex/config.toml свой и для проверки доверия (рецензия 6w, п. 3)", () => {
  test("слои поменялись, пока диск был отключён: sync — конфликт без вопроса о доверии; sync --force — доверие в том же запуске", () => {
    const f = rootsFixture(["codex"]);
    const app = `${f.archive}/Acme/app`;
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    const trusted = () => read(`${f.home}/.codex/config.toml`).toLowerCase().includes(`${app.toLowerCase().replaceAll("/", process.platform === "win32" ? "\\\\" : "/")}"]\ntrust_level = "trusted"`);
    expect(trusted()).toBe(true);
    forgetAway(f, f.archive, app);
    put(`${f.config}/layers/tree/Archive/instructions/60-new.md`, "# rule new\n");
    const s = f.run(["sync", app]);
    const forced = f.run(["sync", app, "--force"]);
    expect({
      conflict: s.out.includes("файл miksy, которого нет в учёте, отличается"),
      askAfterSync: s.out.includes("Нужно решение пользователя о доверии"),
      askAfterForce: forced.out.includes("Нужно решение пользователя о доверии"),
      trustedAfterForce: trusted(),
    }).toEqual({ conflict: true, askAfterSync: false, askAfterForce: false, trustedAfterForce: true });
  }, 120000);
});

// Аргументы команды из подсказки (как их разобрал бы shell): «"a b" c» → [a b, c]
const shellWords = (cmd: string) => cmd.match(/"[^"]*"|\S+/g)!.map((a) => a.replace(/^"|"$/g, ""));

describe.skipIf(process.platform !== "win32")("корень-junction в никуда (Windows; рецензия 6w, п. 6 и проверки без находок)", () => {
  test("root remove --forget, путь с пробелом, ветка из двух слов: root add и sync --all из подсказки; затем clean — ничего от miksy", () => {
    const { symlinkSync } = require("node:fs");
    const f = cliFixture({ projects: ["Org/p1"] });
    const target = `${f.dir}/real disk/Clients`, link = `${f.dir}/My Clients`;
    git(`${target}/Acme/site`);
    symlinkSync(target, link, "junction");
    put(`${f.config}/layers/tree/Client Zone/skills/sk/SKILL.md`, "---\nname: sk\ndescription: d\n---\nbody\n");
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: link, tree: "Client Zone" }])}agents: [claude, codex]\n`);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    const site = `${target}/Acme/site`;
    expect(status(site)).toBe("");
    renameSync(`${f.dir}/real disk`, `${f.dir}/real disk-away`);
    const r = inProcess(f, ["root", "remove", link, "--forget"]);
    expect(r.code).toBe(0);
    const hint = r.out.match(/miksy (root add "[^"]+" --tree (?:"[^"]+"|\S+));/)?.[1] ?? "";
    const then = r.out.match(/затем miksy (sync --all)/)?.[1] ?? "";
    expect(hint).not.toBe("");
    renameSync(`${f.dir}/real disk-away`, `${f.dir}/real disk`);
    const add = f.run(shellWords(hint));
    expect({ code: add.code, err: add.err }).toEqual({ code: 0, err: "" });
    const s = f.run([...shellWords(then), "--yes"]);
    expect({ code: s.code, conflict: s.out.includes("КОНФЛИКТ"), git: status(site) }).toEqual({ code: 0, conflict: false, git: "" });
    expect(f.run(["sync", site]).out).not.toContain("КОНФЛИКТ");
    const c = f.run(["clean", site]);
    expect({ code: c.code, git: status(site), left: ["CLAUDE.local.md", ".claude/skills/sk/SKILL.md", ".codex/config.toml", ".agents/skills/sk/SKILL.md"].filter((p) => existsSync(`${site}/${p}`)) })
      .toEqual({ code: 0, git: "", left: [] });
  }, 120000);

  test("root remove без «забыть»: подсказка «miksy clean <путь проекта>» по списку — когда диск вернулся, всё убрано; doctor чист", () => {
    const { symlinkSync } = require("node:fs");
    const f = cliFixture({ projects: ["Org/p1"] });
    const target = `${f.dir}/real disk/Clients`, link = `${f.dir}/My Clients`;
    git(`${target}/Acme/site`);
    git(`${target}/Beta/app`);
    symlinkSync(target, link, "junction");
    put(`${f.config}/layers/tree/Client Zone/skills/sk/SKILL.md`, "---\nname: sk\ndescription: d\n---\nbody\n");
    put(`${f.config}/layers/tree/mcp/ws.yaml`, "name: ws\ncommand: echo\nargs: [x]\n");
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: link, tree: "Client Zone" }])}agents: [claude, codex, opencode, antigravity]\n`);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(f.run(["sync", "--global"]).code).toBe(0);
    renameSync(`${f.dir}/real disk`, `${f.dir}/real disk-away`);
    const r = inProcess(f, ["root", "remove", link]);
    expect(r.code).toBe(0);
    const dirs = [...r.out.matchAll(/^  (\S.*)$/gm)].map((m) => m[1]).filter((d) => d.startsWith(f.dir));
    expect(dirs.length).toBe(2);
    renameSync(`${f.dir}/real disk-away`, `${f.dir}/real disk`);
    for (const d of dirs) expect(f.run(["clean", d]).code).toBe(0);
    const left = dirs.filter((d) => status(d) !== "");
    const doc = f.run(["doctor"]).out;
    expect({ left, outside: doc.includes("вне workspace"), problems: /Проблем: [1-9]/.test(doc) }).toEqual({ left: [], outside: false, problems: false });
  }, 180000);

  // Корень — junction link → target; цель пропала (ссылка в никуда); clean пути проекта typed(link, target)
  const junctionClean = (typed: (link: string, target: string) => string) => {
    const { symlinkSync } = require("node:fs");
    const f = cliFixture({ projects: ["Org/p1"] });
    const target = `${f.dir}/real`, link = `${f.dir}/link`;
    git(`${target}/Acme/site`);
    symlinkSync(target, link, "junction");
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: link, tree: "Clients" }])}agents: [claude]\n`);
    put(`${f.config}/layers/tree/mcp/ws.yaml`, "name: ws\ncommand: echo\nargs: [x]\n");
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    const site = `${target}/Acme/site`;
    const projects = () => JSON.parse(read(`${f.home}/.claude.json`)).projects ?? {};
    expect(projects()[site]?.mcpServers?.ws).toBeDefined();
    renameSync(target, `${target}-away`);
    const r = inProcess(f, ["clean", typed(link, target)]);
    return { code: r.code, err: r.err, key: projects()[site]?.mcpServers?.ws, stranded: r.out.includes("На недоступном диске осталось") };
  };
  const ok = { code: 0, err: "", key: undefined, stranded: true };

  test("clean проекта: путь назначения (как в учёте) с обратными косыми и в другом регистре — работает", () => {
    expect(junctionClean((_link, target) => `${target}/ACME/Site`.replaceAll("/", "\\"))).toEqual(ok);
  }, 120000);

  test("clean проекта: путь через корень, как он записан в machine.yaml (и в другом регистре), — работает так же", () => {
    expect(junctionClean((link) => `${link}/Acme/site`)).toEqual(ok);
    expect(junctionClean((link) => `${link}/ACME/SITE`.replaceAll("/", "\\"))).toEqual(ok);
  }, 180000);
});

describe("B.7: root remove недоступного корня --dry-run — план говорит, что будет (рецензия 6w, п. 7)", () => {
  const setup = () => {
    const f = rootsFixture(["claude"]);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    unplug(f.archive);
    return { f, yaml: read(`${f.config}/local/machine.yaml`), led: JSON.stringify(ledger(f.config)) };
  };
  const untouched = (x: ReturnType<typeof setup>) => expect({ yaml: read(`${x.f.config}/local/machine.yaml`), led: JSON.stringify(ledger(x.f.config)) }).toEqual({ yaml: x.yaml, led: x.led });

  test("без терминала: корень недоступен (почему), вопроса нет — что останется в учёте; ничего не записано", () => {
    const x = setup();
    const r = x.f.run(["root", "remove", x.f.archive, "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Корень недоступен (пуст, а в учёте есть его цели — диск не смонтирован?) — на нём записанное miksy: 2 файлов.");
    expect(r.out).toContain("Без терминала вопроса нет — корень убирается, а записанное (2 файлов) и учёт остаются");
    expect(r.out).toContain("Забыть сразу — --forget.");
    untouched(x);
  }, 120000);

  test("в терминале: «будет вопрос» — без вопроса сейчас", () => {
    const x = setup();
    const r = inProcess(x.f, ["root", "remove", x.f.archive, "--dry-run"], x.f.dir, []);
    expect({ code: r.code, err: r.err, questions: r.questions }).toEqual({ code: 0, err: "", questions: [] });
    expect(r.out).toContain("Будет вопрос: забыть записанное в его проекты? «Нет» (по умолчанию) — корень убирается, а записанное (2 файлов) и учёт остаются");
    untouched(x);
  }, 120000);

  test("--forget --dry-run: по проектам — что убирается и что забудется, итог; «ничего не записано» — один раз", () => {
    const x = setup();
    const r = x.f.run(["root", "remove", x.f.archive, "--forget", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Корень недоступен (");
    expect(r.out).toContain(`План: записанное в ${x.f.archive}/Acme/app (2 файлов на недоступном диске) будет забыто.`);
    expect(r.out).toContain("План: корень убирается из workspace, записанное в его проекты (2 файлов) забывается.");
    expect(r.out.split("--dry-run: ничего не записано.").length - 1).toBe(1);
    untouched(x);
  }, 120000);

  test("вложенный недоступный корень без --forget: план — корень не будет убран", () => {
    const f = rootsFixture(["claude"]);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    unplug(f.inner);
    const r = f.run(["root", "remove", f.inner, "--dry-run"]);
    expect(r.out).toContain(`Корень лежит внутри корня ${f.ws}: без «забыть» он не убирается`);
    expect(r.out).toContain("Без терминала вопроса нет — корень не будет убран; забыть — --forget.");
  }, 120000);
});

describe("B.8: оригинал файла пользователя после «забыть» (рецензия 6w, п. 8; A.5)", () => {
  test("свой .codex/config.toml пользователя, заменённый miksy (--force): «забыто» говорит, где копия; после возвращения диска sync → clean удаляет файл, копия остаётся в originals/", () => {
    const f = rootsFixture(["codex"]);
    const app = `${f.archive}/Acme/app`;
    const mine = "model = \"my-model\"\n";
    put(`${app}/.codex/config.toml`, mine);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(3);
    expect(f.run(["sync", app, "--force"]).code).toBe(0);
    const forgot = forgetAway(f, f.archive, app);
    expect(forgot.out).toContain(`Копии ваших прежних файлов (1), которые miksy когда-то заменил, остаются в ${f.config}/local/backups/originals/ — сами на место не вернутся.`);
    const s = f.run(["sync", app]);
    expect(s.out).toContain("файл miksy, которого не было в учёте");
    expect(f.run(["clean", app]).code).toBe(0);
    const originals = (dir: string): string[] => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? originals(`${dir}/${e.name}`) : [`${dir}/${e.name}`]) : [];
    const kept = originals(`${f.config}/local/backups/originals`).filter((p) => p.endsWith(".codex/config.toml") && read(p) === mine);
    expect({ after: existsSync(`${app}/.codex/config.toml`), copyInOriginals: kept.length > 0 }).toEqual({ after: false, copyInOriginals: true });
  }, 120000);

  test("без оригиналов — о копиях не говорит; --dry-run — «останутся»", () => {
    const f = rootsFixture(["codex"]);
    const app = `${f.archive}/Acme/app`;
    put(`${app}/.codex/config.toml`, "model = \"m\"\n");
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(3);
    expect(f.run(["sync", app, "--force"]).code).toBe(0);
    unplug(f.archive);
    expect(f.run(["clean", app, "--forget", "--dry-run"]).out).toContain("Копии ваших прежних файлов (1), которые miksy когда-то заменил, останутся в");
    const other = rootsFixture(["codex"]);
    const app2 = `${other.archive}/Acme/app`;
    expect(other.run(["sync", "--all", "--yes"]).code).toBe(0);
    unplug(other.archive);
    const c = other.run(["clean", app2, "--forget"]);
    expect(c.out).toContain("забыто.");
    expect(c.out).not.toContain("Копии ваших прежних файлов");
  }, 120000);
});

describe("рецензия круга 6w", () => {
  test("п. 1: Antigravity — ненужные файлы плагина после «забыть» (точной строки нет): не удаляются, после clean их видит git", () => {
    const f = rootsFixture(["antigravity"]);
    const app = `${f.archive}/Acme/app`;
    put(`${f.config}/layers/tree/Archive/skills/sk/SKILL.md`, "---\nname: sk\ndescription: d\n---\nbody\n");
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    const rules = `${app}/.agents/plugins/miksy/rules/AGENTS.md`;
    const text = read(rules);
    expect(text).toContain("Сгенерировано miksy");
    forgetAway(f, f.archive, app);
    rmSync(`${f.config}/layers/tree/instructions`, { recursive: true });
    rmSync(`${f.config}/layers/acme/instructions`, { recursive: true });
    rmSync(`${f.config}/layers/tree/mcp/ws.yaml`);
    expect(f.run(["sync", app]).code).toBe(0);
    expect(read(rules)).toBe(text);
    expect(f.run(["clean", app]).code).toBe(0);
    expect({ rules: read(rules), line: exclude(app).includes("/.agents/plugins/miksy/"), git: status(app).split("\n").filter(Boolean).sort() })
      .toEqual({ rules: text, line: false, git: ["?? .agents/plugins/miksy/mcp_config.json", "?? .agents/plugins/miksy/rules/AGENTS.md"] });
  }, 120000);

  test("п. 2: файл пользователя с шапкой miksy в каталоге плагина и чужой конфликтный файл рядом — точной строки не получает, sync и clean его не удаляют", () => {
    const f = cliFixture({ agents: ["antigravity"], projects: ["Org/p1"] });
    const p1 = `${f.ws}/Org/p1`;
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(exclude(p1)).toContain("/.agents/plugins/miksy/\n");
    const notes = `${p1}/.agents/plugins/miksy/notes.md`;
    const mine = "<!-- Сгенерировано miksy (слои: workspace). Не править вручную — изменения вносить в конфигурацию miksy (слои). -->\n\n# мои заметки\n";
    put(notes, mine);
    put(`${p1}/.agents/plugins/miksy/skills/sk/SKILL.md`, "---\nname: sk\ndescription: моё\n---\nмоё\n");
    put(`${f.config}/layers/tree/skills/sk/SKILL.md`, "---\nname: sk\ndescription: d\n---\nbody\n");
    f.run(["sync", p1]);
    const s2 = f.run(["sync", p1]);
    expect(s2.out).not.toContain("больше не нужен");
    expect({ notes: read(notes), exactLine: exclude(p1).includes("/.agents/plugins/miksy/notes.md"), visible: status(p1).includes(".agents/plugins/miksy/notes.md") })
      .toEqual({ notes: mine, exactLine: false, visible: true });
    f.run(["clean", p1]);
    expect(read(notes)).toBe(mine);
  }, 120000);

  test("п. 3: одобрение пользователем того же сервера (miksy одобрил бы его сейчас) после «забыть» miksy от своего не отличает — берёт, clean снимает (решение A.4, README)", () => {
    const f = rootsFixture(["claude"]);
    const app = `${f.archive}/Acme/app`;
    put(`${app}/.mcp.json`, JSON.stringify({ mcpServers: { team: { command: "team-server" }, mine: { command: "mine-server" } } }));
    gitc(app, "add", ".mcp.json");
    gitc(app, "commit", "-qm", "team");
    put(`${app}/.claude/settings.local.json`, JSON.stringify({ enabledMcpjsonServers: ["mine"] }));
    put(`${f.config}/layers/tree/Archive/layer.yaml`, "trust: { claude: true }\n");
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    forgetAway(f, f.archive, app);
    expect(f.run(["sync", app]).out).toContain("взять под учёт — одобрения miksy, которых не было в учёте (mine, team)");
    expect(f.run(["clean", app]).code).toBe(0);
    expect(local(app).enabledMcpjsonServers ?? []).toEqual([]);
  }, 120000);

  test("п. 4: повторный clean цели без учёта ничего не меняет — строки, оставленные первым clean, на месте, git не видит файлы miksy", () => {
    const f = rootsFixture(["codex"]);
    const app = `${f.archive}/Acme/app`;
    put(`${f.config}/layers/tree/Archive/skills/sk/SKILL.md`, "---\nname: sk\ndescription: d\n---\nbody\n");
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    forgetAway(f, f.archive, app);
    expect(f.run(["clean", app]).code).toBe(0);
    const after1 = { line: exclude(app).includes("/.agents/skills/sk/"), git: status(app), config: existsSync(`${app}/.codex/config.toml`) };
    const c2 = f.run(["clean", app]);
    const after2 = { line: exclude(app).includes("/.agents/skills/sk/"), git: status(app), config: existsSync(`${app}/.codex/config.toml`) };
    expect({ after1, after2, c2: c2.out.includes("изменений нет") }).toEqual({ after1: { line: true, git: "", config: false }, after2: { line: true, git: "", config: false }, c2: true });
    expect(Object.keys(ledger(f.config).targets).filter((k) => k.endsWith("/Acme/app"))).toEqual([]);
  }, 120000);
});
