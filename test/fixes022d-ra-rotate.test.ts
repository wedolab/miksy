// Выпуск 0.2.2, круг 8d, рецензия A №1: старая папка запуска за ссылкой local/backups без доступа для вас (так её оставляет
// v0.2.1 при цели, закрытой без наследования: icacls /reset сквозь ссылку). Раньше rotate падал на ней в каждом запуске;
// теперь — отказ в начале с командой, doctor говорит то же; команда дословно — rotate проходит. Только временные каталоги
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CLI } from "./helpers";

const win = process.platform === "win32";
const sysx = (exe: string) => join(process.env.SystemRoot ?? "C:\\Windows", "System32", exe);
const nat = (p: string) => p.replaceAll("/", "\\");
const tmp = (p: string) => realpathSync.native(mkdtempSync(join(tmpdir(), p))).replaceAll("\\", "/");
const put = (p: string, s = "x\n") => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };
const sid = () => new TextDecoder("latin1").decode(Bun.spawnSync([sysx("whoami.exe"), "/user", "/fo", "csv", "/nh"], { stdout: "pipe" }).stdout).trim().match(/,"(S-[0-9-]+)"$/)![1];
const icacls = (...a: string[]) => Bun.spawnSync([sysx("icacls.exe"), ...a], { stdout: "pipe", stderr: "pipe" }).exitCode;

test.skipIf(!win)("старая папка запуска без доступа за ссылкой: rotate", () => {
  const root = tmp("r8da-rot-");
  const home = `${root}/home`, config = `${root}/config`, vault = `${root}/vault`;
  put(`${config}/map.yaml`, "global:\n  - { use: global }\nlayers: []\n");
  put(`${config}/layers/global/instructions/00.md`, "# global\n");
  put(`${config}/local/machine.yaml`, `workspace: ${root}/ws\nagents: [claude]\n`);
  mkdirSync(`${root}/ws`, { recursive: true });
  put(`${home}/.claude/CLAUDE.md`, "# mine\n");
  mkdirSync(vault, { recursive: true });
  icacls(nat(vault), "/inheritance:r", "/grant:r", `*${sid()}:F`);
  for (let i = 0; i < 21; i++) put(`${vault}/2026-01-${String(i + 1).padStart(2, "0")}T00-00-00-000Z/x.md`);
  // Как после v0.2.1: /reset /t под целью без наследуемых записей — пусто, доступа нет
  icacls(nat(`${vault}/2026-01-01T00-00-00-000Z`), "/reset", "/t", "/q");
  let unreadable = false;
  try { readdirSync(`${vault}/2026-01-01T00-00-00-000Z`); } catch { unreadable = true; }
  symlinkSync(vault, `${config}/local/backups`, "junction");
  const env = { ...process.env, MIKSY_CONFIG: config, HOME: home, USERPROFILE: home };
  const run = (args: string[]) => { const r = Bun.spawnSync([process.execPath, CLI, ...args], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" }); return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }; };
  const doc = run(["doctor"]);
  const first = run(["sync", "--global", "--force"]);
  const re = /2026-01-01T00-00-00-000Z: нет доступа даже вам .*Закройте папку бэкапов и всё в ней \(PowerShell\): (.+)$/m;
  const cmd = first.out.match(re)?.[1] ?? "";
  const psr = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd], { stdout: "pipe", stderr: "pipe" }); const ps = psr.exitCode; if (ps) console.error("CMD", cmd, "OUT", psr.stdout.toString(), "ERR", psr.stderr.toString());
  const s = run(["sync", "--global", "--force"]);
  const doc2 = run(["doctor"]);
  const left = readdirSync(vault).filter((d) => d.startsWith("2026-01-")).length;
  icacls(nat(root), "/grant", `*${sid()}:(OI)(CI)F`, "/t", "/c", "/q");
  expect({
    unreadable, doctor: re.test(doc.out), first: first.code, cmd: !!cmd, ps,
    code: s.code, err: /EPERM|EACCES|operation not permitted|Ошибка|ОШИБКА/.test(s.out), rotated: left < 21, doctor2: /backups/.test(doc2.out),
  }).toEqual({ unreadable: true, doctor: true, first: 1, cmd: true, ps: 0, code: 0, err: false, rotated: true, doctor2: false });
}, 300000);
