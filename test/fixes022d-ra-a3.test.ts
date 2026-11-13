// Выпуск 0.2.2, круг 8d, рецензия A №2 (A №3 не для всех путей): ссылка ниже originals/ на открытую, закрытую или
// несуществующую цель — при обычной local/backups и при local/backups-ссылке на закрытую цель. Обычная — отказ в начале,
// в --dry-run и doctor; ссылка — по решению «б» (круг 8c) устройство цели в начале не проверяется: отказ на записи. Текст
// везде — «замените … обычной папкой», без «закрыть цель» и без текста guard «не трогаю». Только временные каталоги
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { closeCommand } from "../src/secretfiles";
import { CLI } from "./helpers";

const win = process.platform === "win32";
const tmp = (p: string) => realpathSync.native(mkdtempSync(join(tmpdir(), p))).replaceAll("\\", "/");
const put = (p: string, s = "x\n") => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };
const ps = (cmd: string) => Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd], { stdout: "pipe", stderr: "pipe" });
const openDir = (p: string) => win
  ? Bun.spawnSync([join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), p.replaceAll("/", "\\"), "/grant", "*S-1-1-0:(OI)(CI)(R)"], { stdout: "pipe" })
  : Bun.spawnSync(["chmod", "755", p]);
const closeDir = (p: string) => win ? ps(closeCommand(p, true)) : Bun.spawnSync(["chmod", "700", p]);

function world(linkedBackups: boolean) {
  const root = tmp("r8da-a3-");
  const home = `${root}/home`, config = `${root}/config`, ext = `${root}/ext`, vault = `${root}/vault`;
  put(`${config}/map.yaml`, "global:\n  - { use: global }\nlayers: []\n");
  put(`${config}/layers/global/instructions/00.md`, "# global\n");
  put(`${config}/layers/global/skills/gs/SKILL.md`, "---\nname: gs\ndescription: g\n---\nmiksy\n");
  put(`${config}/local/machine.yaml`, `workspace: ${root}/ws\nagents: [claude]\n`);
  mkdirSync(`${root}/ws`, { recursive: true });
  put(`${home}/.claude/skills/gs/SKILL.md`, "---\nname: gs\ndescription: mine\n---\nMY NOTES\n");
  put(`${ext}/old.md`);
  if (linkedBackups) { mkdirSync(vault, { recursive: true }); closeDir(vault); symlinkSync(vault, `${config}/local/backups`, win ? "junction" : "dir"); }
  const env = { ...process.env, MIKSY_CONFIG: config, HOME: home, USERPROFILE: home };
  const run = (args: string[]) => { const r = Bun.spawnSync([process.execPath, CLI, ...args], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" }); return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }; };
  return { root, config, ext, run };
}
const keyLines = (o: string) => o.split("\n").filter((l) => /originals|не пишет|симлинк|ОШИБКА|Ошибка|откажет/.test(l)).map((l) => l.trim().slice(0, 400));

for (const linked of [true, false])
  for (const kind of ["open", "closed", "broken"] as const)
    test(`A №3: local/backups ${linked ? "— ссылка на закрытую цель" : "обычная"}, originals/C — ссылка на ${kind} цель`, () => {
      const w = world(linked);
      expect([0, 3]).toContain(w.run(["sync", "--global"]).code);
      // Первая часть пути оригиналов: на Windows — диск (C), на macOS и Linux — первый каталог пути домашней папки песочницы
      const link = `${w.config}/local/backups/originals/${win ? "C" : w.root.split("/")[1]}`;
      mkdirSync(dirname(link), { recursive: true });
      if (kind === "open") openDir(w.ext); else closeDir(w.ext);
      symlinkSync(w.ext, link, win ? "junction" : "dir");
      if (kind === "broken") { if (win) Bun.spawnSync(["cmd", "/c", "rmdir", "/s", "/q", w.ext.replaceAll("/", "\\")]); else rmSync(w.ext, { recursive: true }); }
      const dry = w.run(["sync", "--global", "--force", "--dry-run"]);
      const doc = w.run(["doctor"]);
      const first = w.run(["sync", "--global", "--force"]);
      const second = w.run(["sync", "--global", "--force"]);
      const r = { dry: { code: dry.code, lines: keyLines(dry.out) }, doctor: { code: doc.code, lines: keyLines(doc.out) }, first: { code: first.code, lines: keyLines(first.out) }, second: { code: second.code, lines: keyLines(second.out) } };
      void r;
      const text = (o: string) => /originals\/\S+ — ссылка на|originals\/\S+: битая ссылка/.test(o) && /[Зз]амените/.test(o) && !/[Зз]акрыть цель|не трогаю/.test(o);
      expect({
        dry: dry.code === 1 && text(dry.out), doctor: text(doc.out),
        first: first.code === 1 && text(first.out) && !/частично/.test(first.out),
        second: text(second.out),
      }).toEqual(linked
        // Ссылка local/backups: в начале не проверяется (решение «б») — отказ на записи, «частично», текст тот же
        ? { dry: false, doctor: false, first: false, second: true }
        : { dry: true, doctor: true, first: true, second: true });
      if (linked) expect({ code: first.code, text: text(first.out) }).toEqual({ code: 3, text: true });
    }, 300000);
