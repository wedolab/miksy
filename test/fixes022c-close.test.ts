// Выпуск 0.2.2, круг 8c, C11 (рецензия A №2 = B №1 проверки 8b): команда «закройте вручную» печатается в самой строке
// doctor и sync; выполненная дословно, она закрывает цель ссылки — папку или файл, с унаследованными и с явными чужими
// записями — и оставляет полный доступ вам. Затем строки doctor нет, sync пишет секреты, файл читается. Цель с одной
// вашей явной записью — команда ничего не ломает. Путь с ' и ’ (PowerShell; sh — с '). Только временные каталоги
import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { aclProblem, closeCommand } from "../src/secretfiles";
import { CLI } from "./helpers";

const win = process.platform === "win32";
const sys = (exe: string) => join(process.env.SystemRoot ?? "C:\\Windows", "System32", exe);
const tmp = (p: string) => realpathSync.native(mkdtempSync(join(tmpdir(), p))).replaceAll("\\", "/");
const put = (p: string, s = "x\n") => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };
const nat = (p: string) => p.replaceAll("/", "\\");
const can = (() => {
  const d = tmp("c11can-");
  put(`${d}/f`);
  mkdirSync(`${d}/t`);
  const ok = (f: () => void) => { try { f(); return true; } catch { return false; } };
  return { file: ok(() => symlinkSync(`${d}/f`, `${d}/lf`, "file")), dir: ok(() => symlinkSync(`${d}/t`, `${d}/ld`, "dir")) };
})();
const sid = () => new TextDecoder("latin1").decode(Bun.spawnSync([sys("whoami.exe"), "/user", "/fo", "csv", "/nh"], { stdout: "pipe" }).stdout).trim().match(/,"(S-[0-9-]+)"$/)![1];

type Rights = "унаследованные" | "явная чужая" | "только ваша";
// Права цели: унаследованные (Windows — от временной папки, она открыта; sh — 0755/0644), явная чужая запись
// (Everyone / Users), только ваша явная запись (уже закрыта)
function setRights(p: string, dir: boolean, r: Rights) {
  if (!win) return chmodSync(p, r === "только ваша" ? (dir ? 0o700 : 0o600) : (dir ? 0o755 : 0o644));
  if (r === "явная чужая") Bun.spawnSync([sys("icacls.exe"), nat(p), "/grant", dir ? "*S-1-1-0:(OI)(CI)(R)" : "*S-1-5-32-545:(R)"], { stdout: "pipe" });
  if (r === "только ваша") Bun.spawnSync([sys("icacls.exe"), nat(p), "/inheritance:r", "/grant:r", `*${sid()}:${dir ? "(OI)(CI)" : ""}F`], { stdout: "pipe" });
}
const runCmd = (cmd: string) => win
  ? Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd.replace(/^\(PowerShell\) /, "")], { stdout: "pipe", stderr: "pipe" })
  : Bun.spawnSync(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe" });

function world(kind: "dir" | "file", name: string) {
  const root = tmp("c11-");
  const config = `${root}/config`, home = `${root}/home`, vault = `${root}/${name}`;
  put(`${config}/map.yaml`, "global:\n  - { use: global }\nlayers: []\n");
  put(`${config}/layers/global/mcp/srv.yaml`, "name: srv\ncommand: echo\nenv:\n  A_TOKEN: ${A_TOKEN}\n");
  put(`${config}/local/machine.yaml`, `workspace: ${root}/ws\nagents: [opencode]\n`);
  mkdirSync(`${root}/ws`, { recursive: true });
  if (kind === "dir") {
    put(`${config}/local/secrets.env`, "A_TOKEN=abcdef123\n");
    mkdirSync(vault, { recursive: true });
    symlinkSync(vault, `${config}/local/secrets`, win ? "junction" : "dir");
  } else {
    put(`${vault}/secrets.env`, "A_TOKEN=abcdef123\n");
    symlinkSync(`${vault}/secrets.env`, `${config}/local/secrets.env`, "file");
  }
  const target = kind === "dir" ? vault : `${vault}/secrets.env`;
  const run = (args: string[]) => {
    const r = Bun.spawnSync([process.execPath, CLI, ...args], { cwd: root, env: { ...process.env, MIKSY_CONFIG: config, HOME: home, USERPROFILE: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  };
  return { root, config, vault, target, run };
}

const NAMES = win ? ["vault", "va'ul’t ‘x‚y‛"] : ["vault", "va'ult ’x"];
for (const kind of ["dir", "file"] as const)
  for (const r of ["унаследованные", "явная чужая", "только ваша"] as Rights[])
    for (const name of NAMES)
      test.skipIf(kind === "file" && !can.file)(`${kind === "dir" ? "папка (local/secrets)" : "файл (local/secrets.env)"}, ${r}, путь «${name}» — команда из строки doctor дословно`, () => {
        const w = world(kind, name);
        setRights(w.target, kind === "dir", r);
        const line = (out: string) => out.split("\n").find((l) => /закройте вручную(?: \(PowerShell\))?: /.test(l) && (l.includes(kind === "dir" ? "local/secrets" : "local/secrets.env")));
        const before = w.run(["doctor"]);
        const l1 = line(before.out);
        if (r === "только ваша") {
          // Уже закрыта: строки нет; команда для неё (closeCommand) ничего не ломает
          expect(l1).toBeUndefined();
          expect(runCmd(closeCommand(w.target, kind === "dir")).exitCode).toBe(0);
        } else {
          expect(l1).toBeTruthy();
          const cmd = l1!.match(/закройте вручную(?: \(PowerShell\))?: (.+)$/)![1].trim();
          const res = runCmd(cmd);
          expect({ code: res.exitCode, err: res.stderr.toString().trim() }).toEqual({ code: 0, err: "" });
        }
        let readable = true;
        try { readFileSync(kind === "dir" ? (put(`${w.vault}/probe`), `${w.vault}/probe`) : w.target, "utf8"); } catch { readable = false; }
        const after = w.run(["doctor"]);
        const sync = w.run(["sync", "--global"]);
        expect({
          closed: aclProblem(w.target),
          readable,
          doctorLine: line(after.out) ?? null,
          sync: sync.code,
          skipped: /не заданы переменные|файлы секретов не записаны/.test(sync.out),
          secretFile: kind === "dir" ? existsSync(`${w.vault}/A_TOKEN`) : true,
        }).toEqual({ closed: null, readable: true, doctorLine: null, sync: 0, skipped: false, secretFile: true });
      }, 120000);
