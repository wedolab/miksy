// Выпуск 0.2.2, круг 8d, мелочи кода: A №3 — ссылка ниже originals/ на открытую цель: отказ не предлагает «закрыть цель»
// (сквозь ссылку внутри папки оригиналов miksy не пишет и при закрытой цели), замена папкой — проходит; A №5 — сводка
// плана при отказе: только строка отказа, один раз, без «изменений нет» и «конфликтов нет». Только временные каталоги
import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { planSummary } from "../src/setup";
import { CLI } from "./helpers";

const win = process.platform === "win32";
const tmp = (p: string) => realpathSync.native(mkdtempSync(join(tmpdir(), p))).replaceAll("\\", "/");
const put = (p: string, s = "x\n") => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };
const openDir = (p: string) => win
  ? Bun.spawnSync([join(process.env.SystemRoot ?? "C:\Windows", "System32", "icacls.exe"), p.replaceAll("/", "\\"), "/grant", "*S-1-1-0:(OI)(CI)(R)"], { stdout: "pipe" })
  : Bun.spawnSync(["chmod", "755", p]);

test("A №3: local/backups/originals/C — ссылка на открытую папку: только «замените обычной папкой»; после замены — пишется", () => {
  const root = tmp("a3-");
  const home = `${root}/home`, config = `${root}/config`, ext = `${root}/ext`;
  put(`${config}/map.yaml`, "global:\n  - { use: global }\nlayers: []\n");
  put(`${config}/layers/global/instructions/00.md`, "# global\n");
  put(`${config}/layers/global/skills/gs/SKILL.md`, "---\nname: gs\ndescription: g\n---\nmiksy\n");
  put(`${config}/local/machine.yaml`, `workspace: ${root}/ws\nagents: [claude]\n`);
  mkdirSync(`${root}/ws`, { recursive: true });
  put(`${home}/.claude/skills/gs/SKILL.md`, "---\nname: gs\ndescription: mine\n---\nMY NOTES\n");
  put(`${ext}/old.md`);
  openDir(ext);
  const env = { ...process.env, MIKSY_CONFIG: config, HOME: home, USERPROFILE: home };
  const run = (args: string[]) => { const r = Bun.spawnSync([process.execPath, CLI, ...args], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" }); return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }; };
  // Обычная local/backups (закрыта первым запуском), в ней originals/C — ссылка
  expect([0, 3]).toContain(run(["sync", "--global"]).code); // 3 — конфликт с вашим skill, не отказ
  const link = `${config}/local/backups/originals/${win ? "C" : "home"}`;
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(ext, link, win ? "junction" : "dir");
  const first = run(["sync", "--global", "--force"]);
  const doc = run(["doctor"]);
  expect({
    code: first.code,
    replace: /originals\/\S+ — ссылка на .*Внутри папки оригиналов miksy не пишет сквозь ссылку, даже если её цель закрыта, — miksy не пишет туда бэкапы.*Замените эту ссылку обычной папкой/.test(first.out),
    close: /Закрыть цель|закрыть цель или/.test(first.out + doc.out),
  }).toEqual({ code: 1, replace: true, close: false });
  // Замена: ссылку — обычной папкой с содержимым цели
  if (win) Bun.spawnSync(["cmd", "/c", "rmdir", link.replaceAll("/", "\\")]); else unlinkSync(link);
  cpSync(ext, link, { recursive: true });
  const again = run(["sync", "--global", "--force"]);
  expect({ code: again.code, refused: /не пишет туда бэкапы|ОШИБКА/.test(again.out) }).toEqual({ code: 0, refused: false });
}, 300000);

test("A №5: сводка плана при отказе — только строка отказа, один раз", () => {
  const refusal = "Ошибка (запуск откажет): …/local/backups — ссылка на …: открыт для Пользователи. miksy не пишет туда бэкапы";
  const plan = planSummary(() => { console.log(refusal); return 1; });
  expect({ lines: plan.lines, refused: plan.refused }).toEqual({ lines: [`  ${refusal}`], refused: true });
});
