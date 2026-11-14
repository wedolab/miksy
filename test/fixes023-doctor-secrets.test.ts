// Выпуск 0.2.3, A7 («Открытое» 8c, 8d): doctor о секретах.
// - Ссылка local/secrets на открытую папку — одна строка (в «Файлах секретов», с готовой командой), не две.
// - Файл секрета, который не прочесть даже вам (так его оставляла 0.2.1 за ссылкой на цель без наследования), —
//   «не читается (нет доступа даже вам)», а не «устарел (значение другое)»; sync его перезаписывает. Только временные каталоги
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CLI } from "./helpers";

const win = process.platform === "win32";
const icacls = (...a: string[]) => Bun.spawnSync([join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), ...a], { stdout: "pipe", stderr: "pipe" }).exitCode;
const sid = () => new TextDecoder("latin1").decode(Bun.spawnSync([join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe"), "/user", "/fo", "csv", "/nh"], { stdout: "pipe" }).stdout).trim().match(/,"(S-[0-9-]+)"$/)![1];
const tmp = (p: string) => realpathSync.native(mkdtempSync(join(tmpdir(), p))).replaceAll("\\", "/");
const put = (p: string, s = "x\n") => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };

function world(link: boolean) {
  const root = tmp("a7-");
  const home = `${root}/home`, config = `${root}/config`, vault = `${root}/vault`;
  put(`${config}/map.yaml`, "global:\n  - { use: global }\nlayers: []\n");
  put(`${config}/layers/global/mcp/srv.yaml`, "name: srv\ncommand: echo\nenv:\n  A_TOKEN: ${A_TOKEN}\n");
  put(`${config}/local/machine.yaml`, `workspace: ${root}/ws\nagents: [opencode]\n`);
  put(`${config}/local/secrets.env`, "A_TOKEN=abcdef123\n");
  mkdirSync(`${root}/ws`, { recursive: true });
  mkdirSync(home, { recursive: true });
  if (link) { mkdirSync(vault, { recursive: true }); symlinkSync(vault, `${config}/local/secrets`, win ? "junction" : "dir"); }
  const env = { ...process.env, MIKSY_CONFIG: config, HOME: home, USERPROFILE: home };
  const run = (args: string[]) => { const r = Bun.spawnSync([process.execPath, CLI, ...args], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" }); return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }; };
  return { root, config, vault, run };
}

test("A7: ссылка local/secrets на открытую папку — в doctor одна строка о ней", () => {
  const w = world(true);
  expect([0, 3]).toContain(w.run(["sync", "--global"]).code);
  if (win) icacls(w.vault.replaceAll("/", "\\"), "/grant", "*S-1-1-0:(OI)(CI)(R)"); else Bun.spawnSync(["chmod", "755", w.vault]);
  const doc = w.run(["doctor"]);
  const lines = doc.out.split("\n").filter((l) => l.includes(`${w.config}/local/secrets →`) || l.includes(`${w.config}/local/secrets:`));
  expect(lines.length).toBe(1);
  expect(lines[0]).toMatch(/закройте вручную(?: \(PowerShell\))?: /);
}, 300000);

test.skipIf(!win)("A7: файл секрета без доступа даже вам — «не читается», а не «устарел»; sync перезаписывает", () => {
  const w = world(false);
  expect([0, 3]).toContain(w.run(["sync", "--global"]).code);
  const file = `${w.config}/local/secrets/A_TOKEN`;
  // Как оставляла 0.2.1: ни одной записи прав
  icacls(file.replaceAll("/", "\\"), "/inheritance:r");
  icacls(file.replaceAll("/", "\\"), "/remove:g", `*${sid()}`);
  let unreadable = false;
  try { readFileSync(file); } catch { unreadable = true; }
  const doc = w.run(["doctor"]);
  const line = doc.out.split("\n").find((l) => l.includes("A_TOKEN:")) ?? "";
  const s = w.run(["sync", "--global"]);
  let value = "";
  try { value = readFileSync(file, "utf8"); } catch (e) { value = (e as Error).message; }
  icacls(w.root.replaceAll("/", "\\"), "/grant", `*${sid()}:(OI)(CI)F`, "/t", "/c", "/q");
  expect({ unreadable, line: /не читается \(нет доступа даже вам\) — miksy sync перезапишет его/.test(line), stale: /устарел/.test(line), sync: [0, 3].includes(s.code), value })
    .toEqual({ unreadable: true, line: true, stale: false, sync: true, value: "abcdef123\n" });
}, 300000);

// Рецензия 9a, №8: local/ сама — ссылка, local/secrets — ссылка на открытую папку: одна строка о ней
test("A7: local/ — ссылка, local/secrets — ссылка на открытую папку: одна строка о ней", () => {
  const root = tmp("rv-a7-");
  const home = `${root}/home`, config = `${root}/config`, vault = `${root}/vault`, realLocal = `${root}/other/local`;
  put(`${config}/map.yaml`, "global:\n  - { use: global }\nlayers: []\n");
  put(`${config}/layers/global/mcp/srv.yaml`, "name: srv\ncommand: echo\nenv:\n  A_TOKEN: ${A_TOKEN}\n");
  put(`${realLocal}/machine.yaml`, `workspace: ${root}/ws\nagents: [opencode]\n`);
  put(`${realLocal}/secrets.env`, "A_TOKEN=abcdef123\n");
  symlinkSync(realLocal, `${config}/local`, win ? "junction" : "dir");
  mkdirSync(`${root}/ws`, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(vault, { recursive: true });
  symlinkSync(vault, `${realLocal}/secrets`, win ? "junction" : "dir");
  const env = { ...process.env, MIKSY_CONFIG: config, HOME: home, USERPROFILE: home };
  const run = (args: string[]) => { const r = Bun.spawnSync([process.execPath, CLI, ...args], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" }); return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }; };
  run(["sync", "--global"]);
  if (win) icacls(vault.replaceAll("/", "\\"), "/grant", "*S-1-1-0:(OI)(CI)(R)"); else Bun.spawnSync(["chmod", "755", vault]);
  const doc = run(["doctor"]);
  const lines = doc.out.split("\n").filter((l) => /secrets (→|:)/.test(l) && /закройте вручную/.test(l));
  expect(lines.length).toBe(1);
}, 120000);
