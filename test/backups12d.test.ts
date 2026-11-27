// Круг 12d: local/backups — ссылка на закрытую цель, а глубже, в папке оригиналов (путь записи), — открытая папка (Windows)
// или ссылка (все ОС). Раньше doctor и --dry-run молчали, а sync отказывал на полпути записи («цель записана частично»).
// Теперь отказ сразу: doctor, --dry-run и sync говорят одну строку, sync ничего не пишет; команда исправления из
// сообщения выполняется дословно (PowerShell 5.1 и из cmd, путь с пробелом и кириллицей), после неё sync, clean и повторный
// sync проходят. Итог после отказа на полпути (другая ошибка записи) — честный. Только временные каталоги
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { closeCommand } from "../src/secretfiles";
import { CLI, said } from "./helpers";
import { openToOthers } from "./openacl";

const win = process.platform === "win32";
const tmp = (p: string) => realpathSync.native(mkdtempSync(join(tmpdir(), p))).replaceAll("\\", "/");
const put = (p: string, s = "x\n") => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };
const ps = (cmd: string) => Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd], { stdout: "pipe", stderr: "pipe" });
const files = (d: string): string[] => existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const p = `${d}/${e.name}`;
  return e.isSymbolicLink() ? [`${p} (ссылка)`] : e.isDirectory() ? files(p) : [p];
}) : [];
const REFUSED = /miksy не пишет туда бэкапы/;

// Цель ссылки — в папке с пробелом и кириллицей: команда исправления должна выполниться дословно
function world() {
  const root = tmp("b12d-");
  const home = `${root}/home`, config = `${root}/config`, ws = `${root}/ws`, vault = `${root}/Мои бэкапы/vault`;
  put(`${config}/map.yaml`, "global:\n  - { use: global }\nlayers: []\n");
  put(`${config}/layers/global/instructions/00.md`, "# global\n");
  put(`${config}/layers/global/skills/gs/SKILL.md`, "---\nname: gs\ndescription: g\n---\nmiksy\n");
  put(`${config}/local/machine.yaml`, `workspace: ${ws}\nagents: [claude]\n`);
  mkdirSync(`${ws}/Org/p1`, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", `${ws}/Org/p1`]);
  put(`${home}/.claude/skills/gs/SKILL.md`, "---\nname: gs\ndescription: mine\n---\nMY NOTES\n");
  mkdirSync(vault, { recursive: true });
  if (win) ps(closeCommand(vault, true)); else chmodSync(vault, 0o700);
  symlinkSync(vault, `${config}/local/backups`, win ? "junction" : "dir");
  const env = { ...process.env, MIKSY_CONFIG: config, HOME: home, USERPROFILE: home };
  const run = (args: string[]) => {
    const r = Bun.spawnSync([process.execPath, CLI, ...args], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const res = { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
    Object.defineProperty(res, "cmd", { value: `miksy ${args.join(" ")}`, enumerable: false });
    return res;
  };
  // Папка оригинала ~/.claude/skills/gs: originals/<путь без двоеточия диска>
  const orig = `${vault}/originals/${`${home}/.claude/skills/gs`.replace(/^([A-Za-z]):/, "$1").replace(/^\/+/, "")}`;
  // Папки оригиналов «от прежней версии»: originals закрыта, внутри всё наследует (как после команды исправления)
  const preOriginals = () => { mkdirSync(orig, { recursive: true }); if (win) ps(closeCommand(`${vault}/originals`, true)); };
  return { root, home, config, vault, run, orig, preOriginals, done: () => rmSync(root, { recursive: true, force: true }) };
}
const line = (out: string) => out.split("\n").find((l) => REFUSED.test(l))?.replace(/^(Ошибка( \(запуск откажет\))?: )/, "") ?? null;
const written = (home: string) => files(`${home}/.claude`).filter((p) => !p.endsWith("/skills/gs/SKILL.md"));

describe("12d: глубже в папке оригиналов за ссылкой — отказ сразу, sync ничего не пишет", () => {
  test.skipIf(!win)("открытая папка глубже (Windows): doctor, --dry-run и sync — одна строка; команда из неё (PowerShell и из cmd) — затем sync, clean, повторный sync", () => {
    const w = world();
    w.preOriginals();
    openToOthers(dirname(w.orig));
    const doc = w.run(["doctor"]), dry = w.run(["sync", "--global", "--force", "--dry-run"]), s = w.run(["sync", "--global", "--force"]);
    const cl = w.run(["clean", "--global"]);
    const msg = line(s.out);
    const fix = msg?.match(/\(PowerShell\): (.*)$/)?.[1] ?? "";
    // Из cmd — так же: powershell -Command "<команда>" (в команде нет двойных кавычек)
    const viaCmd = Bun.spawnSync(["cmd.exe", "/d", "/c", `powershell -NoProfile -NonInteractive -Command "${fix}"`], { stdout: "pipe", stderr: "pipe", windowsVerbatimArguments: true } as any);
    const after = [w.run(["doctor"]), w.run(["sync", "--global", "--force"]), w.run(["sync", "--global"]), w.run(["clean", "--global"])];
    expect({
      doctor: !!msg && doc.out.includes(msg), dry: [dry.code, line(dry.out) === msg], sync: s.code, clean: [cl.code, line(cl.out) === msg],
      deep: /\.claude\/skills( \(и ещё \d+\))?: доступ есть не только у владельца/.test(msg ?? ""), fix: fix.includes("Мои бэкапы"),
      nothing: written(w.home), cmd: viaCmd.exitCode,
      afterCodes: after.map((r) => r.code), afterRefused: after.some((r) => REFUSED.test(r.out)),
      stable: /изменений нет/.test(after[2].out), original: files(w.vault).some((p) => /originals\/.*skills\/gs\/SKILL\.md$/.test(p)),
    }, said([doc, dry, s, cl, ...after])).toEqual({
      doctor: true, dry: [1, true], sync: 1, clean: [1, true], deep: true, fix: true, nothing: [], cmd: 0,
      afterCodes: [expect.any(Number), 0, 0, 0], afterRefused: false, stable: true, original: true,
    });
    w.done();
  }, 300000);

  test.skipIf(!win)("открытая папка глубже: команда из сообщения в PowerShell 5.1 дословно", () => {
    const w = world();
    w.preOriginals();
    openToOthers(dirname(w.orig));
    const msg = line(w.run(["sync", "--global", "--force"]).out) ?? "";
    const fix = ps(msg.match(/\(PowerShell\): (.*)$/)?.[1] ?? "exit 9");
    const s = w.run(["sync", "--global", "--force"]);
    expect({ fix: fix.exitCode, sync: s.code, refused: REFUSED.test(s.out) }, said([s])).toEqual({ fix: 0, sync: 0, refused: false });
    w.done();
  }, 300000);

  // Папка без единой записи прав (так их оставляли 0.2.1 и раньше) плюс открытая папка: отказ по запертой, без проверки
  // прав каждого файла (иначе — icacls на файл, минуты на тысячах), команда из строки закрывает всё — затем sync проходит
  test.skipIf(!win)("запертая папка и открытая глубже (Windows): отказ с командой; после неё sync и повторный sync", () => {
    const w = world();
    w.preOriginals();
    openToOthers(dirname(w.orig));
    const locked = `${w.vault}/originals/C/locked`;
    mkdirSync(locked);
    for (let i = 0; i < 50; i++) writeFileSync(`${dirname(w.orig)}/f${i}.md`, "x");
    Bun.spawnSync([join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), locked.replaceAll("/", "\\"), "/inheritance:r"], { stdout: "pipe" });
    const t0 = performance.now();
    const doc = w.run(["doctor"]);
    const took = performance.now() - t0;
    const s = w.run(["sync", "--global", "--force"]);
    const msg = line(s.out) ?? "";
    const nothing = written(w.home);
    const fix = ps(msg.match(/\(PowerShell\): (.*)$/)?.[1] ?? "exit 9");
    const after = [w.run(["sync", "--global", "--force"]), w.run(["sync", "--global"])];
    expect({
      locked: /originals\/C\/locked( \(и ещё \d+\))?: нет доступа даже вам/.test(msg), doctor: !!msg && doc.out.includes(msg), sync: s.code,
      nothing, fix: fix.exitCode, after: after.map((r) => r.code), refused: after.some((r) => REFUSED.test(r.out)),
      stable: /изменений нет/.test(after[1].out), fast: took < 30000,
    }, said([doc, s, ...after])).toEqual({ locked: true, doctor: true, sync: 1, nothing: [], fix: 0, after: [0, 0], refused: false, stable: true, fast: true });
    w.done();
  }, 300000);

  test("ссылка глубже (все ОС): отказ сразу — заменить обычной папкой; после замены sync пишет", () => {
    const w = world();
    w.preOriginals();
    const other = `${w.root}/other`;
    mkdirSync(other, { recursive: true });
    rmSync(w.orig, { recursive: true, force: true });
    symlinkSync(other, w.orig, win ? "junction" : "dir");
    const doc = w.run(["doctor"]), dry = w.run(["sync", "--global", "--force", "--dry-run"]), s = w.run(["sync", "--global", "--force"]);
    const msg = line(s.out);
    const nothing = written(w.home);
    rmSync(w.orig, { recursive: true, force: true });
    mkdirSync(w.orig);
    const again = w.run(["sync", "--global", "--force"]);
    expect({
      same: [!!msg && doc.out.includes(msg), line(dry.out) === msg], codes: [dry.code, s.code],
      replace: /Внутри папки оригиналов miksy не пишет сквозь ссылку[^]*Замените эту ссылку обычной папкой/.test(msg ?? ""),
      nothing, other: files(other), again: again.code, refused: REFUSED.test(again.out),
    }, said([doc, dry, s, again])).toEqual({ same: [true, true], codes: [1, 1], replace: true, nothing: [], other: [], again: 0, refused: false });
    w.done();
  }, 300000);

  test("всё закрыто: отказа нет, оригинал записан в прежнюю папку; повторный sync стабилен", () => {
    const w = world();
    w.preOriginals();
    const runs = [w.run(["doctor"]), w.run(["sync", "--global", "--force"]), w.run(["sync", "--global"])];
    expect({
      refused: runs.some((r) => REFUSED.test(r.out)), codes: runs.slice(1).map((r) => r.code),
      original: files(w.orig).some((p) => p.endsWith("/SKILL.md")), stable: /изменений нет/.test(runs[2].out),
    }, said(runs)).toEqual({ refused: false, codes: [0, 0], original: true, stable: true });
    w.done();
  }, 300000);
});

// Отказ на полпути остаётся для гонок и других ошибок записи: итог — что записано частично, без «эти места не изменены»
test("итог после ошибки на полпути записи: «записано частично», не «эти места не изменены»", () => {
  const root = tmp("b12d-part-");
  const home = `${root}/home`, config = `${root}/config`, ws = `${root}/ws`;
  put(`${config}/map.yaml`, "global:\n  - { use: global }\nlayers: []\n");
  put(`${config}/layers/global/instructions/00.md`, "# global\n");
  put(`${config}/layers/global/skills/gs/SKILL.md`, "---\nname: gs\ndescription: g\n---\nmiksy\n");
  put(`${config}/local/machine.yaml`, `workspace: ${ws}\nagents: [claude]\n`);
  mkdirSync(ws, { recursive: true });
  // Свой skill gs, который не перезаписать: на Windows — файл «только чтение», на macOS и Linux — папка без записи
  put(`${home}/.claude/skills/gs/SKILL.md`, "---\nname: gs\ndescription: mine\n---\nMY NOTES\n");
  if (win) Bun.spawnSync(["attrib", "+R", `${home}/.claude/skills/gs/SKILL.md`.replaceAll("/", "\\")]);
  else chmodSync(`${home}/.claude/skills/gs`, 0o555);
  const r = Bun.spawnSync([process.execPath, CLI, "sync", "--global", "--force"], {
    cwd: root, env: { ...process.env, MIKSY_CONFIG: config, HOME: home, USERPROFILE: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const out = r.stdout.toString() + r.stderr.toString();
  if (win) Bun.spawnSync(["attrib", "-R", `${home}/.claude/skills/gs/SKILL.md`.replaceAll("/", "\\")]);
  else chmodSync(`${home}/.claude/skills/gs`, 0o755);
  expect({
    partial: /ОШИБКА \(цель синхронизирована частично\)/.test(out), summary: /Целей записано частично: 1/.test(out),
    notChanged: /эти места не изменены/.test(out), before: existsSync(`${home}/.claude/CLAUDE.md`),
  }, out).toEqual({ partial: true, summary: true, notChanged: false, before: true });
  rmSync(root, { recursive: true, force: true });
}, 120000);
