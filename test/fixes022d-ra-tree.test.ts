// Выпуск 0.2.2, круг 8d, рецензия A №1 (тесты рецензента, `out/review022d-a`): свои папки за ссылкой local/backups,
// которые оставила настоящая v0.2.1 — открытые (цель с наследованием) или без единой записи прав (цель без наследования).
// 0.2.2 отказывает с одной командой; команда дословно (PowerShell, путь конфигурации с ' ’ $ пробелом [ ]) — дальше всё
// проходит, за ссылкой всё закрыто и читаемо, doctor чист. Только временные каталоги
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { aclProblem, closeCommand } from "../src/secretfiles";
import { CLI } from "./helpers";
import { hasTag, oldEngine } from "./fixes021b-helpers";

const win = process.platform === "win32";
const OLD = win && hasTag("v0.2.1") ? `${oldEngine("v0.2.1")}/src/cli.ts` : "";
const sysx = (exe: string) => join(process.env.SystemRoot ?? "C:\\Windows", "System32", exe);
const nat = (p: string) => p.replaceAll("/", "\\");
const tmp = (p: string) => realpathSync.native(mkdtempSync(join(tmpdir(), p))).replaceAll("\\", "/");
const put = (p: string, s = "x\n") => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };
const sid = () => new TextDecoder("latin1").decode(Bun.spawnSync([sysx("whoami.exe"), "/user", "/fo", "csv", "/nh"], { stdout: "pipe" }).stdout).trim().match(/,"(S-[0-9-]+)"$/)![1];
const ps = (cmd: string) => { const r = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd], { stdout: "pipe", stderr: "pipe" }); return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }; };
const ls = (d: string) => { try { return readdirSync(d, { withFileTypes: true }); } catch { return []; } };
const walk = (d: string): string[] => existsSync(d) ? ls(d).flatMap((e) => {
  const p = `${d}/${e.name}`;
  return e.isSymbolicLink() ? [] : e.isDirectory() ? [p, ...walk(p)] : [p];
}) : [];
const problems = (d: string) => walk(d).flatMap((p) => {
  const out: string[] = [];
  try { const why = aclProblem(p); if (why) out.push(`${p.slice(d.length)}: ${why}`); } catch (e) { out.push(`${p.slice(d.length)}: acl ${(e as Error).message}`); }
  try { readdirSync(p); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOTDIR") { try { readFileSync(p); } catch (e2) { out.push(`${p.slice(d.length)}: не читается`); } } else out.push(`${p.slice(d.length)}: папка не читается`); }
  return out;
});

for (const how of ["inherit", "noinherit"] as const)
  for (const weird of [false, true])
    test.skipIf(!win || !OLD)(`v0.2.1 → 0.2.2: local/backups → цель ${how}, путь ${weird ? "с ' ’ $ [ ]" : "простой"}: команды из отказа дословно`, () => {
      const root = tmp("r8da-tree-");
      const base = weird ? `${root}/My 'cfg’ $x [1]` : root;
      const home = `${root}/home`, config = `${base}/config`, ws = `${root}/ws`, vault = `${root}/vault`;
      put(`${config}/map.yaml`, "global:\n  - { use: global }\nlayers: []\n");
      put(`${config}/layers/global/instructions/00.md`, "# global\n");
      put(`${config}/layers/global/skills/gs/SKILL.md`, "---\nname: gs\ndescription: g\n---\nmiksy\n");
      put(`${config}/layers/tree/instructions/00.md`, "# ws\n");
      put(`${config}/local/machine.yaml`, `workspace: "${ws}"\nagents: [claude, codex]\n`);
      mkdirSync(`${ws}/Org/p1`, { recursive: true }); Bun.spawnSync(["git", "init", "-q", `${ws}/Org/p1`]);
      put(`${ws}/Org/p1/CLAUDE.local.md`, "# mine\n");
      put(`${home}/.claude/CLAUDE.md`, "# my rules\n");
      put(`${home}/.claude/skills/gs/SKILL.md`, "---\nname: gs\ndescription: mine\n---\nMY NOTES\n");
      mkdirSync(vault, { recursive: true });
      if (how === "inherit") ps(closeCommand(vault, true));
      else Bun.spawnSync([sysx("icacls.exe"), nat(vault), "/inheritance:r", "/grant:r", `*${sid()}:F`], { stdout: "pipe" });
      symlinkSync(vault, `${config}/local/backups`, "junction");
      const env = { ...process.env, MIKSY_CONFIG: config, HOME: home, USERPROFILE: home, BUN_INSTALL: `${root}/bun` };
      const run = (cli: string, args: string[]) => { const r = Bun.spawnSync([process.execPath, cli, ...args], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" }); return { args: args.join(" "), code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }; };
      const old = [run(OLD, ["sync", "--global", "--force"]), run(OLD, ["sync", `${ws}/Org/p1`, "--force"]), run(OLD, ["sync", "--all", "--yes"]), run(OLD, ["sync", "--global", "--force"])];
      const afterOld = problems(vault);
      const doc = run(CLI, ["doctor"]);
      // Шаги: команда пишущая — отказ — выполнить команду из строки дословно — снова; до 6 раз
      const steps: string[] = [];
      let last = run(CLI, ["sync", "--global", "--force"]);
      for (let i = 0; i < 6 && /\(PowerShell\): /.test(last.out); i++) {
        const line = last.out.split("\n").find((l) => /\(PowerShell\): /.test(l))!;
        const cmd = line.slice(line.indexOf("(PowerShell): ") + 14).trim();
        const r = ps(cmd);
        steps.push(`${line.slice(0, 160)} … ⇒ ${cmd} ⇒ ${r.code}`);
        last = run(CLI, ["sync", "--global", "--force"]);
      }
      const more = [run(CLI, ["sync", "--all", "--yes"]), run(CLI, ["sync", `${ws}/Org/p1`, "--force"]), run(CLI, ["clean", `${ws}/Org/p1`]), run(CLI, ["clean", "--global"])];
      const doc2 = run(CLI, ["doctor"]);
      const r = {
        old: old.map((o) => `${o.args}: ${o.code} ${o.out.split("\n").filter((l) => /Ошибка|ОШИБКА|icacls/.test(l)).join(" | ").slice(0, 300)}`),
        afterOld: afterOld.slice(0, 8), afterOldCount: afterOld.length,
        doctorBefore: doc.out.split("\n").filter((l) => /backups|откажут/.test(l)).map((l) => l.slice(0, 300)),
        steps,
        last: `${last.code} ${last.out.split("\n").filter((l) => /Ошибка|ОШИБКА|частично/.test(l)).join(" | ").slice(0, 400)}`,
        more: more.map((o) => `${o.args}: ${o.code} ${o.out.split("\n").filter((l) => /Ошибка|ОШИБКА|частично/.test(l)).join(" | ")}`),
        doctorAfter: doc2.out.split("\n").filter((l) => /backups|откажут/.test(l)),
        vault: problems(vault),
      };
      // Временный каталог — вернуть себе доступ, чтобы песочница удалилась
      Bun.spawnSync([sysx("icacls.exe"), nat(root), "/grant", `*${sid()}:(OI)(CI)F`, "/t", "/c", "/q"], { stdout: "pipe", stderr: "pipe" });
      expect({ steps: r.steps.length <= 1, last: last.code === 0 || last.code === 3, more: more.filter((o) => /Ошибка|ОШИБКА|частично/.test(o.out)).map((o) => o.args), vault: r.vault, doctorAfter: r.doctorAfter, beforeSays: doc.code !== 0 || afterOld.length === 0 })
        .toEqual({ steps: true, last: true, more: [], vault: [], doctorAfter: [], beforeSays: true });
    }, 600000);

// Свои папки originals уже открыты (права по умолчанию: вы, SYSTEM, Администраторы), путь конфигурации и цели с ' ’ $ [ ]
// пробелом: команда «Закройте папку бэкапов и всё в ней» дословно — затем всё проходит
for (const how of ["inherit", "noinherit"] as const)
  test.skipIf(!win)(`закрыть поддерево originals дословно: путь с ' ’ $ [ ], цель ${how}`, () => {
    const root = tmp("r8da-tw-");
    const base = `${root}/My 'cfg’ $x [1] ‘q’`;
    const home = `${root}/home`, config = `${base}/config`, vault = `${base}/va$ult '1'`;
    put(`${config}/map.yaml`, "global:\n  - { use: global }\nlayers: []\n");
    put(`${config}/layers/global/instructions/00.md`, "# global\n");
    put(`${config}/layers/global/skills/gs/SKILL.md`, "---\nname: gs\ndescription: g\n---\nmiksy\n");
    put(`${config}/local/machine.yaml`, `workspace: "${root}/ws"\nagents: [claude]\n`);
    mkdirSync(`${root}/ws`, { recursive: true });
    put(`${home}/.claude/skills/gs/SKILL.md`, "---\nname: gs\ndescription: mine\n---\nMY NOTES\n");
    mkdirSync(vault, { recursive: true });
    if (how === "inherit") ps(closeCommand(vault, true));
    else Bun.spawnSync([sysx("icacls.exe"), nat(vault), "/inheritance:r", "/grant:r", `*${sid()}:F`], { stdout: "pipe" });
    // Как оставила бы прежняя версия: открытые папки и файл (явная запись «Все — чтение» с наследованием)
    for (const d of ["originals", "originals/C", "originals/C/Users", "originals/C/Users/x"]) mkdirSync(`${vault}/${d}`);
    put(`${vault}/originals/C/Users/x/old.md`);
    Bun.spawnSync([sysx("icacls.exe"), nat(`${vault}/originals`), "/grant", "*S-1-1-0:(OI)(CI)(R)", "/t", "/q"], { stdout: "pipe" });
    symlinkSync(vault, `${config}/local/backups`, "junction");
    const env = { ...process.env, MIKSY_CONFIG: config, HOME: home, USERPROFILE: home };
    const run = (args: string[]) => { const r = Bun.spawnSync([process.execPath, CLI, ...args], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" }); return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }; };
    const first = run(["sync", "--global", "--force"]);
    const line = first.out.split("\n").find((l) => /\(PowerShell\): /.test(l)) ?? "";
    const cmd = line.slice(line.indexOf("(PowerShell): ") + 14).trim();
    const r = ps(cmd);
    const again = run(["sync", "--global", "--force"]);
    const doc = run(["doctor"]);
    Bun.spawnSync([sysx("icacls.exe"), nat(root), "/grant", `*${sid()}:(OI)(CI)F`, "/t", "/c", "/q"], { stdout: "pipe", stderr: "pipe" });
    expect({ first: first.code, tree: /Закройте папку бэкапов и всё в ней/.test(line), again: again.code, vault: problems(vault), doctor: doc.out.split("\n").filter((l) => /backups/.test(l)) })
      .toEqual({ first: 1, tree: true, again: 0, vault: [], doctor: [] });
  }, 300000);

// local/secrets → цель без наследования: v0.2.1 (protectFiles: icacls /reset) → 0.2.2
test.skipIf(!win || !OLD)("v0.2.1 → 0.2.2: local/secrets → цель noinherit: файл секрета читается после 0.2.2", () => {
  const root = tmp("r8da-sec-");
  const home = `${root}/home`, config = `${root}/config`, vault = `${root}/vault`;
  put(`${config}/map.yaml`, "global:\n  - { use: global }\nlayers: []\n");
  put(`${config}/layers/global/instructions/00.md`, "# global\n");
  put(`${config}/layers/global/mcp/srv.yaml`, "name: srv\ncommand: echo\nenv:\n  A_TOKEN: ${A_TOKEN}\n");
  put(`${config}/local/machine.yaml`, `workspace: "${root}/ws"\nagents: [claude]\n`);
  put(`${config}/local/secrets.env`, "A_TOKEN=abcdef123\n");
  mkdirSync(`${root}/ws`, { recursive: true });
  mkdirSync(vault, { recursive: true });
  Bun.spawnSync([sysx("icacls.exe"), nat(vault), "/inheritance:r", "/grant:r", `*${sid()}:F`], { stdout: "pipe" });
  symlinkSync(vault, `${config}/local/secrets`, "junction");
  const env = { ...process.env, MIKSY_CONFIG: config, HOME: home, USERPROFILE: home };
  const run = (cli: string, args: string[]) => { const r = Bun.spawnSync([process.execPath, cli, ...args], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" }); return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }; };
  const o1 = run(OLD, ["sync", "--global"]);
  const readable = () => { try { return readFileSync(`${vault}/A_TOKEN`, "utf8"); } catch (e) { return `не читается`; } };
  const afterOld = readable();
  const doc = run(CLI, ["doctor"]);
  const n1 = run(CLI, ["sync", "--global"]);
  const after1 = readable();
  const n2 = run(CLI, ["sync", "--global"]);
  const doc2 = run(CLI, ["doctor"]);
  Bun.spawnSync([sysx("icacls.exe"), nat(root), "/grant", `*${sid()}:(OI)(CI)F`, "/t", "/c", "/q"], { stdout: "pipe", stderr: "pipe" });
  expect({ after1, n2: n2.code }).toEqual({ after1: "abcdef123\n", n2: 0 });
}, 300000);
