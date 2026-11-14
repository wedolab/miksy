// Выпуск 0.2.2, круг 8d, E1 (рецензия A №1 проверки 8c; уточнения основного агента — out/8d-plan-answer.md): цель ссылки
// local/backups или local/secrets закрыта — с наследованием (команда miksy) или без него (/inheritance:r /grant:r <вы>:F).
// Папки и файлы, которые miksy создаёт за ссылкой, — его собственные: закрыты при создании, читаемы вами. Несколько
// запусков подряд — без отказов и «частично», за ссылкой ничего открытого, doctor чист. Свои папки оригиналов, уже
// открытые (созданы прежней версией), — одна команда из отказа закрывает всё поддерево. Только временные каталоги
import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { aclProblem, closeCommand } from "../src/secretfiles";
import { CLI } from "./helpers";
import { foreignForBuiltinAdmin, openToOthers, USERS } from "./openacl";

const win = process.platform === "win32";
const sys = (exe: string) => join(process.env.SystemRoot ?? "C:\\Windows", "System32", exe);
const nat = (p: string) => p.replaceAll("/", "\\");
const tmp = (p: string) => realpathSync.native(mkdtempSync(join(tmpdir(), p))).replaceAll("\\", "/");
const put = (p: string, s = "x\n") => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };
const sid = () => new TextDecoder("latin1").decode(Bun.spawnSync([sys("whoami.exe"), "/user", "/fo", "csv", "/nh"], { stdout: "pipe" }).stdout).trim().match(/,"(S-[0-9-]+)"$/)![1];
const ps = (cmd: string) => Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd.replace(/^\(PowerShell\) /, "")], { stdout: "pipe", stderr: "pipe" });

type Close = "с наследованием" | "без наследования";
function closeTarget(p: string, how: Close) {
  if (!win) return Bun.spawnSync(["chmod", "700", p]);
  if (how === "с наследованием") return ps(closeCommand(p, true));
  return Bun.spawnSync([sys("icacls.exe"), nat(p), "/inheritance:r", "/grant:r", `*${sid()}:F`], { stdout: "pipe" });
}
// Все пути под каталогом (не заходя в ссылки)
const walk = (d: string): string[] => existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const p = `${d}/${e.name}`;
  return e.isSymbolicLink() ? [] : e.isDirectory() ? [p, ...walk(p)] : [p];
}) : [];
const openPaths = (d: string) => walk(d).filter((p) => { try { return aclProblem(p) !== null; } catch { return true; } });

function world(which: "backups" | "secrets", how: Close) {
  const root = tmp("e1-");
  const home = `${root}/home`, config = `${root}/config`, ws = `${root}/ws`, vault = `${root}/vault`;
  put(`${config}/map.yaml`, "global:\n  - { use: global }\nlayers: []\n");
  put(`${config}/layers/global/instructions/00.md`, "# global\n");
  put(`${config}/layers/global/skills/gs/SKILL.md`, "---\nname: gs\ndescription: g\n---\nmiksy\n");
  put(`${config}/layers/global/mcp/srv.yaml`, "name: srv\ncommand: echo\nenv:\n  A_TOKEN: ${A_TOKEN}\n");
  put(`${config}/local/machine.yaml`, `workspace: ${ws}\nagents: [claude, codex, opencode]\n`);
  put(`${config}/local/secrets.env`, "A_TOKEN=abcdef123\n");
  mkdirSync(`${ws}/Org/p1`, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", `${ws}/Org/p1`]);
  put(`${home}/.claude/CLAUDE.md`, "# my rules\n");
  put(`${home}/.codex/AGENTS.md`, "# my codex rules\n");
  put(`${home}/.claude/skills/gs/SKILL.md`, "---\nname: gs\ndescription: mine\n---\nMY NOTES token=abc\n");
  mkdirSync(vault, { recursive: true });
  closeTarget(vault, how);
  symlinkSync(vault, `${config}/local/${which}`, win ? "junction" : "dir");
  const env = { ...process.env, MIKSY_CONFIG: config, HOME: home, USERPROFILE: home, BUN_INSTALL: `${root}/bun` };
  const run = (args: string[]) => {
    const r = Bun.spawnSync([process.execPath, CLI, ...args], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  };
  return { root, home, config, vault, run };
}
const bad = (o: string) => /частично|не пишет туда бэкапы|ОШИБКА|Ошибка|не закрыт/.test(o);

describe("E1: цель ссылки закрыта с наследованием и без — свои папки и файлы miksy закрыты, отказов нет", () => {
  for (const how of ["с наследованием", "без наследования"] as Close[])
    test(`local/backups — ссылка на цель, закрытую ${how}: несколько запусков подряд`, () => {
      const w = world("backups", how);
      const runs = [w.run(["sync", "--all", "--yes"]), w.run(["sync", "--global", "--force"]), w.run(["clean", "--global"]), w.run(["sync", "--global"]), w.run(["sync", "--all", "--yes"])];
      const doc = w.run(["doctor"]);
      expect({
        codes: runs.map((r) => (r.code === 3 ? 0 : r.code)), // 3 — конфликт с вашими файлами, не отказ
        complaints: runs.flatMap((r, i) => r.out.split("\n").filter(bad).map((l) => `${i}: ${l.trim()}`)),
        doctor: doc.out.split("\n").filter((l) => /local\/backups|не пишет туда бэкапы/.test(l)),
        wrote: walk(w.vault).some((p) => /originals\/.*SKILL\.md$/.test(p)) && walk(w.vault).some((p) => /CLAUDE\.md$/.test(p)),
        open: openPaths(w.vault),
      }).toEqual({ codes: [0, 0, 0, 0, 0], complaints: [], doctor: [], wrote: true, open: [] });
    }, 300000);

  for (const how of ["с наследованием", "без наследования"] as Close[])
    test(`local/secrets — ссылка на цель, закрытую ${how}: файл секрета закрыт и читается`, () => {
      const w = world("secrets", how);
      const s1 = w.run(["sync", "--global"]);
      // Значение изменилось — файл перезаписывается (writeAtomic, protectFiles)
      put(`${w.config}/local/secrets.env`, "A_TOKEN=zzzz9999\n");
      const s2 = w.run(["sync", "--global"]);
      const doc = w.run(["doctor"]);
      let value = "";
      try { value = readFileSync(`${w.vault}/A_TOKEN`, "utf8"); } catch (e) { value = `не читается: ${(e as Error).message}`; }
      expect({
        codes: [s1.code, s2.code].map((c) => (c === 3 ? 0 : c)), complaints: [s1, s2].flatMap((r) => r.out.split("\n").filter(bad)),
        value, closed: aclProblem(`${w.vault}/A_TOKEN`),
        doctor: doc.out.split("\n").filter((l) => /A_TOKEN|local\/secrets/.test(l)),
      }).toEqual({ codes: [0, 0], complaints: [], value: "zzzz9999\n", closed: null, doctor: [] });
    }, 300000);

  // Свои папки оригиналов, уже открытые (созданы прежней версией без закрытия): отказ даёт одну команду на всё поддерево —
  // после неё следующий запуск проходит
  test.skipIf(!win)("Windows: папки оригиналов за ссылкой уже открыты (прежняя версия) — одна команда из отказа, затем проходит", () => {
    const w = world("backups", "без наследования");
    // Как оставила бы прежняя версия: originals и подпапки созданы без закрытия — права по умолчанию (SY, BA)
    for (const d of ["originals", "originals/C", "originals/C/Users", "originals/C/Users/x"]) mkdirSync(`${w.vault}/${d}`);
    put(`${w.vault}/originals/C/Users/x/old.md`);
    // Под встроенным Администратором (…-500) SY и BA свои — открыть явной записью «Пользователей» (круг 9c)
    openToOthers(`${w.vault}/originals`, USERS);
    expect(foreignForBuiltinAdmin(`${w.vault}/originals`).length).toBeGreaterThan(0);
    expect(openPaths(`${w.vault}/originals`).length).toBeGreaterThan(0);
    const first = w.run(["sync", "--global", "--force"]);
    expect(first.code).toBe(1);
    const cmd = first.out.match(/Закройте папку бэкапов и всё в ней \(PowerShell\): (.+)$/m)![1].trim();
    expect(ps(cmd).exitCode).toBe(0);
    const again = w.run(["sync", "--global", "--force"]);
    expect({ code: again.code, complaints: again.out.split("\n").filter(bad), open: openPaths(w.vault) }).toEqual({ code: 0, complaints: [], open: [] });
  }, 300000);
});

// A №6: ссылка там, куда miksy не пишет (старая папка запуска, сама папка копии «до miksy») — без отказа; rotate её не
// удаляет и в неё не заходит
test.skipIf(!win)("A №6: ссылка — старая папка запуска и папка копии «до miksy» на открытые цели — без отказа, rotate не трогает", () => {
  const root = tmp("a6-");
  const home = `${root}/home`, config = `${root}/config`, ext = `${root}/ext`;
  put(`${config}/map.yaml`, "global:\n  - { use: global }\nlayers: []\n");
  put(`${config}/layers/global/instructions/00.md`, "# global\n");
  put(`${config}/local/machine.yaml`, `workspace: ${root}/ws\nagents: [claude]\n`);
  mkdirSync(`${root}/ws`, { recursive: true });
  put(`${home}/.claude/CLAUDE.md`, "# mine\n");
  for (let i = 0; i < 25; i++) put(`${config}/local/backups/2026-01-${String(i + 1).padStart(2, "0")}T00-00-00-000Z/x.md`);
  put(`${ext}/run/keep.md`);
  put(`${ext}/copy/.claude/settings.json`, "{}");
  symlinkSync(`${ext}/run`, `${config}/local/backups/2025-12-31T00-00-00-000Z`, "junction");
  symlinkSync(`${ext}/copy`, `${config}/local/backups/before-miksy-2025-12-31T00-00-00`, "junction");
  const env = { ...process.env, MIKSY_CONFIG: config, HOME: home, USERPROFILE: home };
  const run = (args: string[]) => { const r = Bun.spawnSync([process.execPath, CLI, ...args], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" }); return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }; };
  const s = run(["sync", "--global"]);
  const left = readdirSync(`${config}/local/backups`).filter((d) => d.startsWith("2026-01-")).length;
  expect({
    code: s.code, refused: /не пишет туда бэкапы/.test(s.out),
    runLink: lstatSync(`${config}/local/backups/2025-12-31T00-00-00-000Z`).isSymbolicLink(), keep: existsSync(`${ext}/run/keep.md`),
    copyLink: existsSync(`${ext}/copy/.claude/settings.json`), rotated: left < 25,
  }).toEqual({ code: 0, refused: false, runLink: true, keep: true, copyLink: true, rotated: true });
}, 300000);
