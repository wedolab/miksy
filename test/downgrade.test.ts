// Откат с 0.2.0 на 0.1.x по рецепту README («Откатиться на прежнюю версию») — настоящим движком v0.1.1: тег
// v0.1.1 репо движка разворачивается во временный каталог (временный индекс git, индекс и ветки репо не
// меняются). Тега нет (CI и стенды клонируют без тегов) — пропуск
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENGINE } from "../src/load";
import { cliFixture, put } from "./helpers";
import { git, inProcess, ledger, read } from "./rootshelp";

const TAG = "v0.1.1";
const hasTag = Bun.spawnSync(["git", "-C", ENGINE, "rev-parse", "--verify", "-q", `${TAG}^{commit}`], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;

// Движок прежней версии — файлы тега во временном каталоге
function oldEngine(): string {
  const dir = mkdtempSync(join(tmpdir(), "v011-")).replaceAll("\\", "/");
  const env = { ...process.env, GIT_INDEX_FILE: `${dir}/index` };
  for (const args of [["read-tree", TAG], ["checkout-index", "-a", "-f", `--prefix=${dir}/engine/`]]) {
    const r = Bun.spawnSync(["git", "-C", ENGINE, ...args], { env, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args[0]}: ${r.stderr}`);
  }
  return `${dir}/engine`;
}

test.skipIf(!hasTag)("рецепт README: до переключения — корни убрать, имя gemini вернуть, clean --agent antigravity; 0.1.1 пишет без конфликтов; обратно на новую версию — тоже", () => {
  const engine = oldEngine();
  expect(existsSync(`${engine}/src/cli.ts`)).toBe(true);
  const f = cliFixture({ agents: ["claude", "antigravity"], projects: ["Org/p1"] });
  put(`${f.config}/layers/tree/mcp/t.yaml`, "name: t\ncommand: echo\nargs: [x]\nenv:\n  T: ${DOWN_TOKEN}\n");
  put(`${f.config}/layers/global/mcp/g.yaml`, "name: g\ncommand: echo\nargs: [y]\nenv:\n  T: ${DOWN_TOKEN}\n");
  put(`${f.config}/local/secrets.env`, "DOWN_TOKEN=abcdefgh12345678\n");
  git(`${f.dir}/drive/Acme/site`);
  const old = (args: string[]) => {
    const r = Bun.spawnSync([process.execPath, `${engine}/src/cli.ts`, ...args], {
      cwd: f.dir, env: { ...process.env, MIKSY_CONFIG: f.config, HOME: f.home, USERPROFILE: f.home }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  // Новая версия: второй корень, всё записано
  expect(f.run(["root", "add", `${f.dir}/drive`, "--tree", "Clients"]).code).toBe(0);
  expect(f.run(["sync", "--global"]).code).toBe(0);
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  // Рецепт, шаги новой версией: дополнительный корень убрать (в терминале — согласиться убрать записанное)
  const rm = inProcess(f, ["root", "remove", `${f.dir}/drive`], f.dir, [true]);
  expect(rm.err).toBe("");
  expect(read(`${f.config}/local/machine.yaml`)).toMatch(/^workspace: /m);
  expect(existsSync(`${f.dir}/drive/Acme/site/CLAUDE.local.md`)).toBe(false);
  // Имя агента — как понимает 0.1.x; записанное Antigravity — убрать
  put(`${f.config}/local/machine.yaml`, read(`${f.config}/local/machine.yaml`).replace("antigravity", "gemini"));
  expect(f.run(["clean", "--all", "--agent", "antigravity"]).code).toBe(0);
  expect(f.run(["clean", "--global", "--agent", "antigravity"]).code).toBe(0);
  expect(Object.keys(ledger(f.config).targets).filter((k) => /^(antigravity|gemini)\|/.test(k))).toEqual([]);
  // Прежняя версия: setup --yes, sync --global, sync --all — без конфликтов; Antigravity записан её именем
  const steps = [old(["setup", "--yes"]), old(["sync", "--global"]), old(["sync", "--all", "--yes"])];
  for (const s of steps) expect({ code: s.code, err: s.err }).toEqual({ code: 0, err: "" });
  expect(steps[1].out + steps[2].out).not.toContain("КОНФЛИКТ");
  expect(read(`${f.home}/.gemini/GEMINI.md`)).toContain("miksy:begin");
  expect(existsSync(`${f.ws}/Org/p1/.agents/plugins/miksy/plugin.json`)).toBe(true);
  expect(old(["doctor"]).out).toContain("Всё синхронизировано");
  // Снова новая версия: учёт gemini переходит к antigravity, конфликтов нет
  expect(f.run(["sync", "--global"]).code).toBe(0);
  const all = f.run(["sync", "--all", "--yes"]);
  expect(all.code).toBe(0);
  expect(all.out).not.toContain("КОНФЛИКТ");
  expect(f.run(["doctor"]).out).toContain("Всё синхронизировано");
}, 300000);

test.skipIf(!hasTag)("после root remove последнего дополнительного корня 0.1.1 загружает machine.yaml (workspace — строкой)", () => {
  const engine = oldEngine();
  const f = cliFixture({ projects: ["Org/p1"] });
  git(`${f.dir}/drive/Acme/site`);
  expect(f.run(["root", "add", `${f.dir}/drive`, "--tree", "Clients"]).code).toBe(0);
  expect(f.run(["root", "remove", `${f.dir}/drive`]).code).toBe(0);
  const r = Bun.spawnSync([process.execPath, `${engine}/src/cli.ts`, "doctor"], {
    cwd: f.dir, env: { ...process.env, MIKSY_CONFIG: f.config, HOME: f.home, USERPROFILE: f.home }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  expect(r.stderr.toString()).toBe("");
  expect(r.stdout.toString()).toContain("miksy doctor");
}, 120000);

// Основной корень с tree и второй корень, Antigravity и skills: откат по README и возврат по README («Вернуться на
// новую версию — miksy update, затем root add …, tree основной папки …, затем sync --all») (рецензия 6w)
const status = (dir: string) => Bun.spawnSync(["git", "-C", dir, "status", "--porcelain", "--untracked-files=all"]).stdout.toString();
test.skipIf(!hasTag)("основной корень с tree и второй корень: откат по README и возврат по README — без конфликтов, doctor чист, git status проектов пуст", () => {
  const engine = oldEngine();
  const f = cliFixture({ agents: ["claude", "antigravity"], projects: ["Org/p1"] });
  const drive = `${f.dir}/drive`;
  git(`${drive}/Acme/site`);
  put(`${f.config}/layers/tree/Main/Org/skills/sk/SKILL.md`, "---\nname: sk\ndescription: d\n---\nbody\n");
  put(`${f.config}/layers/tree/Clients/instructions/10.md`, "# clients\n");
  const file = `${f.config}/local/machine.yaml`;
  put(file, `workspace:\n  - { path: "${f.ws}", tree: "Main" }\nagents: [claude, antigravity]\n`);
  const old = (args: string[]) => {
    const r = Bun.spawnSync([process.execPath, `${engine}/src/cli.ts`, ...args], {
      cwd: f.dir, env: { ...process.env, MIKSY_CONFIG: f.config, HOME: f.home, USERPROFILE: f.home }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  expect(f.run(["root", "add", drive, "--tree", "Clients"]).code).toBe(0);
  expect(f.run(["sync", "--global"]).code).toBe(0);
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  expect(existsSync(`${f.ws}/Org/p1/.claude/skills/sk/SKILL.md`)).toBe(true);
  // Рецепт отката, шаги 1–4 новой версией
  expect(inProcess(f, ["root", "remove", drive], f.dir, [true]).err).toBe("");
  put(file, `workspace: ${f.ws}\nagents: [claude, gemini]\n`);
  expect(f.run(["clean", "--all", "--agent", "antigravity"]).code).toBe(0);
  expect(f.run(["clean", "--global", "--agent", "antigravity"]).code).toBe(0);
  // Прежняя версия
  const steps = [old(["setup", "--yes"]), old(["sync", "--global"]), old(["sync", "--all", "--yes"])];
  for (const s of steps) expect({ code: s.code, err: s.err, conflict: s.out.includes("КОНФЛИКТ") }).toEqual({ code: 0, err: "", conflict: false });
  // Возврат по README: update (он сам предложит sync --global и sync --all), затем вернуть корень, tree, имя; sync --all
  const afterUpdate = [f.run(["sync", "--global"]), f.run(["sync", "--all", "--yes"])];
  for (const s of afterUpdate) expect({ code: s.code, conflict: s.out.includes("КОНФЛИКТ") }).toEqual({ code: 0, conflict: false });
  put(file, `workspace:\n  - { path: "${f.ws}", tree: "Main" }\nagents: [claude, antigravity]\n`);
  expect(f.run(["root", "add", drive, "--tree", "Clients"]).code).toBe(0);
  const back = f.run(["sync", "--all", "--yes"]);
  expect({ code: back.code, conflict: back.out.includes("КОНФЛИКТ") }).toEqual({ code: 0, conflict: false });
  const d = f.run(["doctor"]);
  expect(d.out).toContain("Всё синхронизировано");
  expect({ p1: status(`${f.ws}/Org/p1`), site: status(`${drive}/Acme/site`) }).toEqual({ p1: "", site: "" });
  expect(read(`${drive}/Acme/site/CLAUDE.local.md`)).toContain("# clients");
  expect(Object.keys(ledger(f.config).targets).some((k) => k.startsWith("gemini|"))).toBe(false);
}, 300000);

// Круг 6x: учёт новой версии с отметкой «проект забыт» и признаком «доверие ставил miksy», решения доверия нового
// расчёта (без ответов пользователя в окне Claude) — 0.1.1 работает с ними без вопросов и конфликтов; отметку 0.1.1
// при записи учёта теряет (README, «Откатиться на прежнюю версию»); после возврата решения работают без нового вопроса
test.skipIf(!hasTag)("отметка «проект забыт» и решения доверия новой версии: 0.1.1 — без вопросов и конфликтов, отметку теряет; возврат — без вопросов", () => {
  const engine = oldEngine();
  const f = cliFixture({ agents: ["claude"], projects: ["Org/p1", "Org/p2"] });
  const p1 = `${f.ws}/Org/p1`, p2 = `${f.ws}/Org/p2`;
  const drive = `${f.dir}/drive`;
  git(`${drive}/Acme/site`);
  const old = (args: string[]) => {
    const r = Bun.spawnSync([process.execPath, `${engine}/src/cli.ts`, ...args], {
      cwd: f.dir, env: { ...process.env, MIKSY_CONFIG: f.config, HOME: f.home, USERPROFILE: f.home }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  const gitc = (dir: string, ...args: string[]) => Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  const team = (dir: string) => {
    put(`${dir}/.mcp.json`, JSON.stringify({ mcpServers: { team: { command: "team-server" } } }));
    gitc(dir, "add", ".mcp.json");
    gitc(dir, "commit", "-qm", "team");
  };
  // Пользователь ответил в окне Claude «да, больше не спрашивать»
  const allow = (dir: string) => put(`${dir}/.claude/settings.local.json`, JSON.stringify({ ...JSON.parse(read(`${dir}/.claude/settings.local.json`) || "{}"), permissions: { allow: ["Bash(ls:*)"] } }, null, 2));
  const trusted = (dir: string) => Object.entries(JSON.parse(read(`${f.home}/.claude.json`) || "{}").projects ?? {})
    .some(([k, v]) => k.toLowerCase() === dir.toLowerCase() && (v as { hasTrustDialogAccepted?: boolean }).hasTrustDialogAccepted === true);
  // p1: ответы в Claude были до miksy, команда добавила .mcp.json; p2: доверие miksy, ответы в Claude, затем .mcp.json
  team(p1);
  allow(p1);
  expect(f.run(["root", "add", drive, "--tree", "Clients"]).code).toBe(0);
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  allow(p2);
  team(p2);
  expect(f.run(["sync", p2]).out).toContain("Нужно решение");
  for (const p of [p1, p2]) expect(f.run(["trust", p, "--confirm"]).code).toBe(0);
  expect(f.run(["sync", "--all", "--yes"]).out).not.toContain("Нужно решение");
  // Второй корень: «забыть» при отключённом диске — отметка в учёте; диск вернулся
  renameSync(drive, `${drive}-disk`);
  mkdirSync(drive);
  expect(f.run(["root", "remove", drive, "--forget"]).code).toBe(0);
  rmSync(drive, { recursive: true });
  renameSync(`${drive}-disk`, drive);
  const before = ledger(f.config) as { forgotten?: Record<string, unknown>; targets: Record<string, { everTrusted?: true }> };
  expect({ forgotten: Object.keys(before.forgotten ?? {}).length, everTrusted: Object.values(before.targets).some((t) => t.everTrusted) }).toEqual({ forgotten: 1, everTrusted: true });
  // Прежняя версия (рецепт: корни убраны, workspace одной строкой)
  expect(read(`${f.config}/local/machine.yaml`)).toMatch(/^workspace: /m);
  const steps = [old(["setup", "--yes"]), old(["sync", "--global"]), old(["sync", "--all", "--yes"]), old(["sync", "--all", "--yes"])];
  for (const s of steps) expect({ code: s.code, err: s.err, conflict: s.out.includes("КОНФЛИКТ"), ask: s.out.includes("Нужно решение") }).toEqual({ code: 0, err: "", conflict: false, ask: false });
  expect({ p1: trusted(p1), p2: trusted(p2) }).toEqual({ p1: true, p2: true });
  // 0.1.1 переписала учёт без отметки «проект забыт» (README говорит)
  expect((ledger(f.config) as { forgotten?: unknown }).forgotten).toBeUndefined();
  // Снова новая версия: без вопросов и конфликтов, доверие стоит
  const back = [f.run(["sync", "--all", "--yes"]), f.run(["sync", "--all", "--yes"])];
  for (const s of back) expect({ code: s.code, conflict: s.out.includes("КОНФЛИКТ"), ask: s.out.includes("Нужно решение"), removed: s.out.includes("снимается") }).toEqual({ code: 0, conflict: false, ask: false, removed: false });
  expect({ p1: trusted(p1), p2: trusted(p2) }).toEqual({ p1: true, p2: true });
  expect(f.run(["doctor"]).out).not.toContain("Нужно решение");
}, 300000);

// Рецепт README, шаг 0 (рецензия 6x): проект основного корня забыт при отключённом диске, диск вернулся — перед
// откатом sync --all новой версией: 0.1.1 работает без конфликтов, git ничего лишнего не видит
test.skipIf(!hasTag)("рецепт, шаг 0: забытый проект, диск вернулся — sync --all новой версией перед откатом, 0.1.1 без конфликтов", () => {
  const engine = oldEngine();
  const f = cliFixture({ agents: ["claude", "codex"], projects: ["Org/p1", "Org/p2"] });
  const p1 = `${f.ws}/Org/p1`;
  const old = (args: string[]) => {
    const r = Bun.spawnSync([process.execPath, `${engine}/src/cli.ts`, ...args], {
      cwd: f.dir, env: { ...process.env, MIKSY_CONFIG: f.config, HOME: f.home, USERPROFILE: f.home }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  put(`${f.config}/layers/tree/Org/mcp/tool.yaml`, "name: tool\ncommand: tool\nargs: []\n");
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  renameSync(f.ws, `${f.ws}-disk`);
  mkdirSync(f.ws);
  expect(f.run(["clean", p1, "--forget"]).code).toBe(0);
  rmSync(f.ws, { recursive: true });
  renameSync(`${f.ws}-disk`, f.ws);
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  const s = old(["sync", "--all", "--yes"]);
  expect({ code: s.code, err: s.err, conflict: s.out.includes("КОНФЛИКТ"), git: status(p1) }).toEqual({ code: 0, err: "", conflict: false, git: "" });
}, 300000);

// Рецепт README для корня, убранного с «забыть», когда диск вернулся (проверка 6x, A3; круг 6y, B.5): шаг 0 —
// вернуть корень и sync --all, шаг 1 — убрать его снова (с согласием убрать записанное). После возврата на новую
// версию — не больше одного вопроса о доверии (ответы пользователя в окне Claude; A2 отложен), README о нём
// говорит; после «да» вопросов больше нет
test.skipIf(!hasTag)("рецепт, шаг 0 для корня, убранного с «забыть»: root add и sync --all, затем шаг 1; 0.1.1 без конфликтов; возврат — вопрос о доверии не больше одного, после «да» — без вопросов", () => {
  const engine = oldEngine();
  const f = cliFixture({ agents: ["claude", "codex"], projects: ["Org/p1"] });
  const drive = `${f.dir}/drive`, site = `${drive}/Acme/site`;
  git(site);
  const old = (args: string[]) => {
    const r = Bun.spawnSync([process.execPath, `${engine}/src/cli.ts`, ...args], {
      cwd: f.dir, env: { ...process.env, MIKSY_CONFIG: f.config, HOME: f.home, USERPROFILE: f.home }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  const local = () => JSON.parse(read(`${site}/.claude/settings.local.json`) || "{}");
  const trusted = () => Object.entries(JSON.parse(read(`${f.home}/.claude.json`) || "{}").projects ?? {})
    .some(([k, v]) => k.toLowerCase() === site.toLowerCase() && (v as { hasTrustDialogAccepted?: boolean }).hasTrustDialogAccepted === true);
  const asked = (r: { out: string }) => r.out.includes("Нужно решение");
  put(`${f.config}/layers/tree/Clients/mcp/crm.yaml`, "name: crm\ncommand: crm\nargs: []\n");
  expect(f.run(["root", "add", drive, "--tree", "Clients"]).code).toBe(0);
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  put(`${site}/.claude/settings.local.json`, JSON.stringify({ ...local(), permissions: { allow: ["Bash(ls:*)"] } }, null, 2));
  renameSync(drive, `${drive}-disk`);
  mkdirSync(drive);
  expect(f.run(["root", "remove", drive, "--forget"]).code).toBe(0);
  rmSync(drive, { recursive: true });
  renameSync(`${drive}-disk`, drive);
  // Шаг 0: вернуть корень и sync --all — отметка «забыт» снята, учёт снова есть
  expect(f.run(["root", "add", drive, "--tree", "Clients"]).code).toBe(0);
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  expect((ledger(f.config) as { forgotten?: object }).forgotten).toBeUndefined();
  // Шаг 1: убрать корень, согласившись убрать записанное
  const rm = inProcess(f, ["root", "remove", drive], f.dir, [true]);
  expect({ code: rm.code, err: rm.err }).toEqual({ code: 0, err: "" });
  for (const s of [old(["setup", "--yes"]), old(["sync", "--global"]), old(["sync", "--all", "--yes"])])
    expect({ code: s.code, err: s.err, conflict: s.out.includes("КОНФЛИКТ") }).toEqual({ code: 0, err: "", conflict: false });
  // Возврат по README
  f.run(["sync", "--global"]);
  f.run(["sync", "--all", "--yes"]);
  expect(f.run(["root", "add", drive, "--tree", "Clients"]).code).toBe(0);
  const back = f.run(["sync", "--all", "--yes"]);
  // README говорит о вопросе в любом случае; вопрос (A2 отложен) — с ответами в окне Claude отдельной строкой
  expect(read(`${ENGINE}/README.md`).replace(/\s+/g, " ").includes("может один раз спросить о доверии")).toBe(true);
  if (asked(back)) {
    expect(back.out.includes("ответы в окне Claude")).toBe(true);
    expect(f.run(["trust", site, "--confirm"]).code).toBe(0);
  }
  const runs = [1, 2].map(() => f.run(["sync", "--all", "--yes"]));
  expect({ asked: runs.map(asked), trusted: trusted(), codex: existsSync(`${site}/.codex/config.toml`), git: status(site).replace("?? .claude/settings.local.json\n", "") })
    .toEqual({ asked: [false, false], trusted: true, codex: true, git: "" });
}, 300000);

test.skipIf(!hasTag)("цель без git со своим хуком в settings.local.json и .mcp.json, «да» новой версией: 0.1.1 снимает доверие и спрашивает (только .mcp.json); без ответа возврат — без вопроса, «да» в 0.1.1 — вопрос о хуке; Codex — правку не замечает (README)", () => {
  // README — без переносов строк (редактура выпуска 0.2.1: «цель без git» — «папка без git»)
  const r = read(`${ENGINE}/README.md`).replace(/\s+/g, " ");
  expect(r).toContain("кроме папок без git: там 0.1.x не читает `.claude/settings.local.json` и `.codex/config.toml`");
  expect(r).toContain("Правку `.codex/config.toml` в папке без git 0.1.x не заметит");
  const asked = (x: { out: string }) => x.out.includes("Нужно решение");
  for (const oldYes of [false, true]) {
    const engine = oldEngine();
    const f = cliFixture({ agents: ["claude", "codex"], projects: ["Org/p1"] });
    const old = (args: string[]) => {
      const x = Bun.spawnSync([process.execPath, `${engine}/src/cli.ts`, ...args], {
        cwd: f.dir, env: { ...process.env, MIKSY_CONFIG: f.config, HOME: f.home, USERPROFILE: f.home }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      return { code: x.exitCode, out: x.stdout.toString(), err: x.stderr.toString() };
    };
    const grp = `${f.ws}/Grp`;
    put(`${f.config}/layers/tree/Grp/layer.yaml`, "target: true\n");
    put(`${f.config}/layers/tree/Grp/mcp/tool.yaml`, "name: tool\ncommand: tool\nargs: []\n");
    put(`${grp}/.mcp.json`, JSON.stringify({ mcpServers: { g: { command: "g" } } }));
    put(`${grp}/.claude/settings.local.json`, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "my-notify.sh" }] }] } }, null, 2));
    expect(asked(f.run(["sync", "--all", "--yes"]))).toBe(true);
    expect(f.run(["trust", grp, "--agent", "claude", "--confirm"]).err).toBe("");
    // Codex: правка своего .codex/config.toml — вопрос новой версии, «да»
    const cfg = `${grp}/.codex/config.toml`;
    put(cfg, read(cfg) + "\nnotify = [\"my-notify\"]\n");
    expect(asked(f.run(["sync", "--all", "--yes"]))).toBe(true);
    f.run(["trust", grp, "--agent", "codex", "--confirm"]);
    expect(asked(f.run(["sync", "--all", "--yes"]))).toBe(false);
    // 0.1.1 (корней нет, workspace строкой)
    for (const s of [old(["setup", "--yes"]), old(["sync", "--global"])]) expect(s.err).toBe("");
    const o = old(["sync", "--all", "--yes"]);
    const block = o.out.slice(o.out.indexOf("Нужно решение"));
    expect({ asked: asked(o), removed: /Grp \(снять своё\)/.test(o.out), mcp: block.includes(".mcp.json: MCP g"), hook: block.includes("my-notify.sh") })
      .toEqual({ asked: true, removed: true, mcp: true, hook: false });
    expect(read(`${f.home}/.codex/config.toml`).toLowerCase()).toContain(`${grp.toLowerCase().replaceAll("/", process.platform === "win32" ? "\\\\" : "/")}"]\ntrust_level = "trusted"`);
    if (oldYes) expect(old(["trust", grp, "--confirm"]).code).toBe(0);
    const back = f.run(["sync", "--all", "--yes"]);
    const again = back.out.slice(back.out.indexOf("Нужно решение"));
    expect({ asked: asked(back), hook: asked(back) && again.includes("my-notify.sh") }).toEqual({ asked: oldYes, hook: oldYes });
  }
}, 300000);

test.skipIf(!hasTag)("цель без git, хук коллеги в settings.local.json (решение не принято / «нет»): 0.1.1 ставит доверие Claude без вопроса — README предупреждает (рецензия 6z, п. 2)", () => {
  expect(read(`${ENGINE}/README.md`).replace(/\s+/g, " ")).toContain("0.1.x не увидит и поставит доверие Claude без вопроса");
  for (const deny of [false, true]) {
    const engine = oldEngine();
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const old = (args: string[]) => {
      const x = Bun.spawnSync([process.execPath, `${engine}/src/cli.ts`, ...args], {
        cwd: f.dir, env: { ...process.env, MIKSY_CONFIG: f.config, HOME: f.home, USERPROFILE: f.home }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      return { code: x.exitCode, out: x.stdout.toString(), err: x.stderr.toString() };
    };
    const grp = `${f.ws}/Grp`;
    put(`${f.config}/layers/tree/Grp/layer.yaml`, "target: true\n");
    put(`${f.config}/layers/tree/Grp/instructions/1.md`, "# grp\n");
    put(`${grp}/.claude/settings.local.json`, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "colleague.sh" }] }] } }));
    const trusted = () => Object.entries(JSON.parse(read(`${f.home}/.claude.json`) || "{}").projects ?? {})
      .some(([k, v]) => k.toLowerCase() === grp.toLowerCase() && (v as { hasTrustDialogAccepted?: boolean }).hasTrustDialogAccepted === true);
    expect(f.run(["sync", "--all", "--yes"]).out).toContain("Нужно решение");
    if (deny) f.run(["trust", grp, "--deny"]);
    expect(trusted()).toBe(false);
    for (const s of [old(["setup", "--yes"]), old(["sync", "--global"])]) expect(s.err).toBe("");
    const o = old(["sync", "--all", "--yes"]);
    expect({ asked: o.out.includes("Нужно решение"), trusted: trusted() }).toEqual({ asked: false, trusted: true });
  }
}, 300000);
