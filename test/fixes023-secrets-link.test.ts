// Выпуск 0.2.3, A5 («Открытое» 8b): local/secrets — ссылка на открытую или битую папку. Отказ — каждой цели, которой
// нужно записать файл секрета (раньше — только первой: секреты отмечались сделанными до записи, и следующие цели писали
// конфиги со ссылкой на несуществующий файл секрета), одной строкой; цель без секретов записана; --dry-run говорит то же
// и с тем же кодом. Команда закрытия из строки (открытая папка) — затем sync пишет все цели. Только временные каталоги
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CLI } from "./helpers";

const win = process.platform === "win32";
const tmp = (p: string) => realpathSync.native(mkdtempSync(join(tmpdir(), p))).replaceAll("\\", "/");
const put = (p: string, s = "x\n") => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };
const git = (d: string) => { mkdirSync(d, { recursive: true }); Bun.spawnSync(["git", "init", "-q", d]); };
const openDir = (p: string) => win
  ? Bun.spawnSync([join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), p.replaceAll("/", "\\"), "/grant", "*S-1-1-0:(OI)(CI)(R)"], { stdout: "pipe" })
  : Bun.spawnSync(["chmod", "755", p]);

function world(kind: "открытая" | "битая") {
  const root = tmp("a5-");
  const home = `${root}/home`, config = `${root}/config`, ws = `${root}/ws`, vault = `${root}/vault`;
  put(`${config}/map.yaml`, "global:\n  - { use: global }\nlayers: []\n");
  put(`${config}/layers/global/instructions/00.md`, "# global\n");
  put(`${config}/layers/tree/Org/mcp/srv.yaml`, "name: srv\ncommand: echo\nenv:\n  A_TOKEN: ${A_TOKEN}\n");
  put(`${config}/layers/tree/Lab/instructions/10.md`, "# lab\n");
  put(`${config}/local/machine.yaml`, `workspace: ${ws}\nagents: [opencode]\n`);
  put(`${config}/local/secrets.env`, "A_TOKEN=abcdef123\n");
  for (const p of ["Org/p1", "Org/p2", "Lab/p3"]) git(`${ws}/${p}`);
  mkdirSync(home, { recursive: true });
  mkdirSync(vault, { recursive: true });
  openDir(vault);
  symlinkSync(vault, `${config}/local/secrets`, win ? "junction" : "dir");
  if (kind === "битая") rmSync(vault, { recursive: true, force: true });
  const env = { ...process.env, MIKSY_CONFIG: config, HOME: home, USERPROFILE: home };
  const run = (args: string[]) => { const r = Bun.spawnSync([process.execPath, CLI, ...args], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" }); return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }; };
  return { root, ws, vault, run };
}
const refusals = (o: string, dry: boolean) => o.split("\n").filter((l) => l.includes(`ОШИБКА (${dry ? "цель будет пропущена" : "цель пропущена"}): файлы секретов не записаны:`)).length;

for (const kind of ["открытая", "битая"] as const)
  test(`A5: local/secrets — ссылка, цель ${kind}: отказ каждой цели с секретом, одной строкой; без секрета — записана; --dry-run так же`, () => {
    const w = world(kind);
    const dry = w.run(["sync", "--all", "--yes", "--dry-run"]);
    const real = w.run(["sync", "--all", "--yes"])
    expect({
      codes: [dry.code, real.code], dry: refusals(dry.out, true), real: refusals(real.out, false), create: /файл секрета A_TOKEN: создать/.test(dry.out),
      p1: existsSync(`${w.ws}/Org/p1/opencode.json`), p2: existsSync(`${w.ws}/Org/p2/opencode.json`), p3: existsSync(`${w.ws}/Lab/p3/.opencode/miksy.md`),
    }).toEqual({ codes: [3, 3], dry: 2, real: 2, create: false, p1: false, p2: false, p3: true });
    // A6: итог — правдой: цели пропущены из-за ошибки, а не «конфликтов … эти места не изменены»
    expect({ skipped: real.out.includes("Целей пропущено из-за ошибки: 2 — в них ничего не записано"), conflicts: /Конфликтов: /.test(real.out) }).toEqual({ skipped: true, conflicts: false });
    // Круг 9b: --dry-run — будущее время, как в строке цели
    expect({ dry: dry.out.includes("Целей будет пропущено из-за ошибки: 2 — в них ничего не запишется"), past: dry.out.includes("Целей пропущено из-за ошибки") }).toEqual({ dry: true, past: false });
    if (kind === "открытая") {
      // Команда закрытия из строки (Windows — PowerShell, иначе sh) дословно — затем пишутся обе цели
      const cmd = real.out.match(/закройте вручную(?: \(PowerShell\))?: (.+)$/m)![1].trim();
      const r = win ? Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd], { stdout: "pipe" }) : Bun.spawnSync(["sh", "-c", cmd]);
      expect(r.exitCode).toBe(0);
      const again = w.run(["sync", "--all", "--yes"]);
      expect({ code: again.code, p1: existsSync(`${w.ws}/Org/p1/opencode.json`), p2: existsSync(`${w.ws}/Org/p2/opencode.json`), token: existsSync(`${w.vault}/A_TOKEN`) })
        .toEqual({ code: 0, p1: true, p2: true, token: true });
    }
  }, 300000);

// Рецензия 9a, №1: файл секрета уже записан, цель ссылки local/secrets потом открыли, у цели есть изменения — --dry-run и
// sync говорят одно (раньше sync проверял каталог и при «записывать нечего» и отказывал, а --dry-run — нет)
const icaclsExe = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");
const sidOf = () => new TextDecoder("latin1").decode(Bun.spawnSync([join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe"), "/user", "/fo", "csv", "/nh"], { stdout: "pipe" }).stdout).trim().match(/,"(S-[0-9-]+)"$/)![1];
test("A5: секрет уже записан, цель ссылки открыли, конфиг изменился — dry-run и sync говорят одно", () => {
  const root = tmp("rv-a5-");
  const home = `${root}/home`, config = `${root}/config`, ws = `${root}/ws`, vault = `${root}/vault`;
  put(`${config}/map.yaml`, "global:\n  - { use: global }\nlayers: []\n");
  put(`${config}/layers/global/instructions/00.md`, "# global\n");
  put(`${config}/layers/tree/Org/mcp/srv.yaml`, "name: srv\ncommand: echo\nenv:\n  A_TOKEN: ${A_TOKEN}\n");
  put(`${config}/layers/tree/Org/instructions/10.md`, "# org\n");
  put(`${config}/local/machine.yaml`, `workspace: ${ws}\nagents: [opencode]\n`);
  put(`${config}/local/secrets.env`, "A_TOKEN=abcdef123\n");
  for (const p of ["Org/p1", "Org/p2"]) git(`${ws}/${p}`);
  mkdirSync(home, { recursive: true });
  mkdirSync(vault, { recursive: true });
  if (win) Bun.spawnSync([icaclsExe, vault.replaceAll("/", "\\"), "/inheritance:r", "/grant:r", `*${sidOf()}:(OI)(CI)F`], { stdout: "pipe" });
  else Bun.spawnSync(["chmod", "700", vault]);
  symlinkSync(vault, `${config}/local/secrets`, win ? "junction" : "dir");
  const env = { ...process.env, MIKSY_CONFIG: config, HOME: home, USERPROFILE: home };
  const run = (args: string[]) => { const r = Bun.spawnSync([process.execPath, CLI, ...args], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" }); return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }; };
  const first = run(["sync", "--all", "--yes"]);
  expect({ code: first.code, tok: existsSync(`${vault}/A_TOKEN`) }).toEqual({ code: 0, tok: true });
  // Цель открыли
  if (win) Bun.spawnSync([icaclsExe, vault.replaceAll("/", "\\"), "/grant", "*S-1-1-0:(OI)(CI)(R)"], { stdout: "pipe" });
  else Bun.spawnSync(["chmod", "755", vault]);
  put(`${config}/layers/tree/Org/instructions/10.md`, "# org changed\n");
  const dry = run(["sync", "--all", "--yes", "--dry-run"]);
  const real = run(["sync", "--all", "--yes"]);
  const errs = (o: string) => o.split("\n").filter((l) => /ОШИБКА/.test(l)).length;
  expect({ dry: [dry.code, errs(dry.out)], real: [real.code, errs(real.out)] }).toEqual({ dry: [real.code, errs(real.out)], real: [real.code, errs(real.out)] });
}, 300000);

// Повторная проверка 9a, №1: файл секрета — битая ссылка в открытой цели local/secrets — --dry-run и sync говорят одно
// Ссылку на файл Windows даёт создать только в режиме разработчика (или с правами администратора)
const can = () => { const d = tmp("can-"); try { symlinkSync(`${d}/x`, `${d}/l`, "file"); return true; } catch { return false; } };
test.skipIf(win && !can())("A5: файл секрета — битая ссылка в открытой цели local/secrets — dry-run и sync говорят одно", () => {
  const root = tmp("rv-a5-");
  const home = `${root}/home`, config = `${root}/config`, ws = `${root}/ws`, vault = `${root}/vault`;
  put(`${config}/map.yaml`, "global:\n  - { use: global }\nlayers: []\n");
  put(`${config}/layers/global/instructions/00.md`, "# global\n");
  put(`${config}/layers/tree/Org/mcp/srv.yaml`, "name: srv\ncommand: echo\nenv:\n  A_TOKEN: ${A_TOKEN}\n");
  put(`${config}/layers/tree/Org/instructions/10.md`, "# org\n");
  put(`${config}/local/machine.yaml`, `workspace: ${ws}\nagents: [opencode]\n`);
  put(`${config}/local/secrets.env`, "A_TOKEN=abcdef123\n");
  for (const p of ["Org/p1", "Org/p2"]) git(`${ws}/${p}`);
  mkdirSync(home, { recursive: true });
  mkdirSync(vault, { recursive: true });
  if (win) Bun.spawnSync([icaclsExe, vault.replaceAll("/", "\\"), "/inheritance:r", "/grant:r", `*${sidOf()}:(OI)(CI)F`], { stdout: "pipe" });
  else Bun.spawnSync(["chmod", "700", vault]);
  symlinkSync(vault, `${config}/local/secrets`, win ? "junction" : "dir");
  const env = { ...process.env, MIKSY_CONFIG: config, HOME: home, USERPROFILE: home };
  const run = (args: string[]) => { const r = Bun.spawnSync([process.execPath, CLI, ...args], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" }); return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }; };
  const first = run(["sync", "--all", "--yes"]);
  expect({ code: first.code, tok: existsSync(`${vault}/A_TOKEN`) }).toEqual({ code: 0, tok: true });
  const fs = require("node:fs") as typeof import("node:fs"); fs.rmSync(`${vault}/A_TOKEN`); fs.symlinkSync(`${root}/nowhere`, `${vault}/A_TOKEN`, "file");
  // Цель открыли
  if (win) Bun.spawnSync([icaclsExe, vault.replaceAll("/", "\\"), "/grant", "*S-1-1-0:(OI)(CI)(R)"], { stdout: "pipe" });
  else Bun.spawnSync(["chmod", "755", vault]);
  put(`${config}/layers/tree/Org/instructions/10.md`, "# org changed\n");
  const dry = run(["sync", "--all", "--yes", "--dry-run"]);
  const real = run(["sync", "--all", "--yes"]);
  const errs = (o: string) => o.split("\n").filter((l) => /ОШИБКА/.test(l)).length;
  expect({ dry: [dry.code, errs(dry.out)], real: [real.code, errs(real.out)] }).toEqual({ dry: [real.code, errs(real.out)], real: [real.code, errs(real.out)] });
}, 300000);
