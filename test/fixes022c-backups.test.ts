// Выпуск 0.2.2, круг 8c, C10 (рецензия A №1 проверки 8b): ни одна запись в local/backups не идёт за ссылку с открытой
// или несуществующей целью. План — out/8c-plan.md (таблица), ответ — out/8c-plan-answer.md. Где ссылка: local/backups или
// local/backups/originals; вид: junction (Windows), ссылка на папку, битая; цель открыта или закрыта. Писатели: бэкап
// запуска (sync, clean, root add), оригинал (sync --force), копия «до miksy» (setup --yes --backup, мастер), rotate,
// часть setup в update. Открытая или битая — отказ в начале команды, код 1, за ссылкой ничего не создано и не удалено,
// --dry-run и doctor говорят то же; команда из отказа дословно (или удалить ссылку) — следующая команда проходит.
// Закрытая — пишется, как раньше. Всё — во временных каталогах
import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Ask } from "../src/ask";
import { runCommand } from "../src/commands";
import { privateLocal } from "../src/secretfiles";
import { finishUpdate } from "../src/update";
import { CLI } from "./helpers";

const win = process.platform === "win32";
const ENGINE = join(import.meta.dir, "..");
const tmp = (p: string) => realpathSync.native(mkdtempSync(join(tmpdir(), p))).replaceAll("\\", "/");
const put = (p: string, s = "x\n") => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };
const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const canDir = (() => { const d = tmp("c10can-"); mkdirSync(`${d}/t`); try { symlinkSync(`${d}/t`, `${d}/l`, "dir"); return true; } catch { return false; } })();
type Kind = "junction" | "dir" | "broken";
const KINDS: Kind[] = win ? ["junction", ...(canDir ? ["dir" as Kind] : []), "broken"] : ["dir", "broken"];
const link = (k: Kind, target: string, at: string) => {
  mkdirSync(dirname(at), { recursive: true });
  if (k === "broken") symlinkSync(`${target}-нет`, at, win ? "junction" : "dir");
  else symlinkSync(target, at, k);
};
const unlink = (p: string) => (win ? Bun.spawnSync(["cmd", "/c", "rmdir", p.replaceAll("/", "\\")]) : unlinkSync(p));
// Все файлы под каталогом (за ссылкой): что создано и что удалено
const files = (d: string): string[] => existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(`${d}/${e.name}`) : [`${d}/${e.name}`.slice(d.length)]).map((p) => p).sort() : [];
const walk = (d: string, base = d): string[] => existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(`${d}/${e.name}`, base) : [`${d}/${e.name}`.slice(base.length)]).sort() : [];

function world(where: "backups" | "originals", k: Kind, open: boolean) {
  const root = tmp("c10-");
  const home = `${root}/home`, config = `${root}/config`, ws = `${root}/ws`, vault = `${root}/vault`;
  put(`${config}/map.yaml`, "global:\n  - { use: global }\nlayers: []\n");
  put(`${config}/layers/global/instructions/00.md`, "# global\n");
  put(`${config}/layers/global/skills/gs/SKILL.md`, "---\nname: gs\ndescription: g\n---\nmiksy\n");
  const machine = `workspace: ${ws}\nagents: [claude, codex]\n`;
  put(`${config}/local/machine.yaml`, machine);
  mkdirSync(`${ws}/Org/p1`, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", `${ws}/Org/p1`]);
  mkdirSync(`${root}/drive/Acme/site`, { recursive: true });
  put(`${home}/.claude/CLAUDE.md`, "# my rules\n");
  put(`${home}/.codex/AGENTS.md`, "# my codex rules\n");
  put(`${home}/.claude.json`, JSON.stringify({ mcpServers: { x: { command: "x", env: { API_KEY: "sk-secret" } } } }));
  put(`${home}/.claude/skills/gs/SKILL.md`, "---\nname: gs\ndescription: mine\n---\nMY NOTES token=abc\n");
  // Цель ссылки: 25 старых запусков (rotate удалил бы лишние) и оригинал
  for (let i = 0; i < 25; i++) put(`${vault}/2026-01-${String(i + 1).padStart(2, "0")}T00-00-00-000Z/x.md`);
  if (where === "originals") { mkdirSync(`${config}/local/backups`, { recursive: true }); put(`${vault}/C/old.md`); }
  if (!open) privateLocal(vault);
  link(k, where === "originals" ? vault : vault, where === "originals" ? `${config}/local/backups/originals` : `${config}/local/backups`);
  const env = { MIKSY_CONFIG: config, HOME: home, USERPROFILE: home, BUN_INSTALL: `${root}/bun` };
  const run = (args: string[]) => {
    const r = Bun.spawnSync([process.execPath, CLI, ...args], { cwd: root, env: { ...process.env, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  };
  return { root, home, config, ws, vault, env, run, machine };
}
type W = ReturnType<typeof world>;

// Команда в этом процессе с окружением песочницы: мастер (на «Скопировать …?» — да) и часть setup в update
function inproc(w: W, f: (log: (s?: string) => void) => number) {
  const saved = { ...process.env }, cwd = process.cwd(), log = console.log, out: string[] = [];
  Object.assign(process.env, w.env);
  process.chdir(w.root);
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  try { return { code: f((s = "") => out.push(s)), out: out.join("\n") }; }
  catch (e) { return { code: -1, out: out.join("\n") + "\n" + (e as Error).message }; }
  finally {
    console.log = log;
    process.chdir(cwd);
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}
const asked: string[] = [];
const wizardAsk: Ask = { yes: (q) => { asked.push(q); return /^Скопировать/.test(q); }, choose: (q, _o, def) => { asked.push(q); return def ?? null; }, line: (q) => { asked.push(q); return null; } };

describe("C10: local/backups — ссылка с открытой или несуществующей целью: отказ в начале, за ссылкой ничего", () => {
  for (const where of ["backups", "originals"] as const)
    for (const k of KINDS)
      test(`${where === "backups" ? "local/backups" : "local/backups/originals"} — ${k}${k === "broken" ? "" : ", цель открыта"}`, () => {
        const w = world(where, k, true);
        const vaultBefore = walk(w.vault);
        const doc = w.run(["doctor"]);
        const dry = w.run(["sync", "--global", "--force", "--dry-run"]);
        const sync = w.run(["sync", "--global", "--force"]);
        const clean = w.run(["clean", "--global"]);
        const rootDry = w.run(["root", "add", `${w.root}/drive`, "--tree", "Drive", "--dry-run"]);
        const rootAdd = w.run(["root", "add", `${w.root}/drive`, "--tree", "Drive", "--yes"]);
        const setupYes = w.run(["setup", "--yes", "--backup"]);
        asked.length = 0;
        const wz = inproc(w, () => runCommand("setup", [], { ask: wizardAsk }));
        const upd = inproc(w, (log) => finishUpdate({ from: "0.2.1", ask: null, run: (c, a, io) => runCommand(c, a, io), log, engine: ENGINE }));
        const refusal = k === "broken" ? /битая ссылка внутри local\/ — miksy не пишет туда бэкапы и копии ваших файлов \(в них бывают токены\)\. Исправьте ссылку или замените её обычной папкой/ : /miksy не пишет туда бэкапы и копии ваших файлов \(в них бывают токены\)\. Выход — закрыть цель или заменить эту ссылку обычной папкой .* с содержимым цели \(там оригиналы ваших файлов, по ним clean их возвращает; шаги — README, сообщение «… ссылка на …: … miksy не пишет туда бэкапы»\)\. Закрыть цель(?: \(PowerShell\))?: /;
        expect({
          doctor: refusal.test(doc.out) && /все команды, которые пишут .*откажут/.test(doc.out),
          dry: [dry.code, refusal.test(dry.out) && /Ошибка \(запуск откажет\)/.test(dry.out)],
          sync: [sync.code, refusal.test(sync.out)],
          clean: clean.code,
          root: [rootDry.code, rootAdd.code, read(`${w.config}/local/machine.yaml`) === w.machine],
          setup: [setupYes.code, refusal.test(setupYes.out)],
          wizard: [wz.code !== 0, refusal.test(wz.out), asked.length],
          update: /Движок обновлён, но setup не выполнен: исправьте сказанное выше, затем miksy setup --yes/.test(upd.out) && refusal.test(upd.out) && /План не построен: запись откажет/.test(upd.out) && !/Записывать агентам нечего/.test(upd.out),
          // За ссылкой ничего не создано и не удалено (rotate не ходил)
          vault: walk(w.vault),
          // Файлы агентов не тронуты
          mine: [read(`${w.home}/.claude/CLAUDE.md`), read(`${w.home}/.claude/skills/gs/SKILL.md`).includes("MY NOTES")],
        }).toEqual({
          doctor: true, dry: [1, true], sync: [1, true], clean: 1, root: [1, 1, true], setup: [1, true], wizard: [true, true, 0], update: true,
          vault: vaultBefore, mine: ["# my rules\n", true],
        });
        // Выход: открытая цель — команда из отказа дословно; битая — удалить ссылку. Затем следующая команда проходит
        if (k === "broken") unlink(where === "originals" ? `${w.config}/local/backups/originals` : `${w.config}/local/backups`);
        else {
          // Команда — последней в строке: её можно скопировать до конца строки
          const cmd = sync.out.match(/Закрыть цель(?: \(PowerShell\))?: (.+)$/m)![1].trim();
          const r = win
            ? Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd.replace(/^\(PowerShell\) /, "")], { stdout: "pipe", stderr: "pipe" })
            : Bun.spawnSync(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
          expect(r.exitCode).toBe(0);
        }
        const again = w.run(["sync", "--global", "--force"]);
        expect({ code: again.code, refused: /не пишет туда бэкапы/.test(again.out), doctor: /все команды, которые пишут .*откажут/.test(w.run(["doctor"]).out) }).toEqual({ code: 0, refused: false, doctor: false });
      }, 300000);

  // Цель закрыта — всё пишется, как раньше: бэкапы, оригинал, копия «до miksy»
  for (const where of ["backups", "originals"] as const)
    for (const k of KINDS.filter((x) => x !== "broken"))
      test(`${where === "backups" ? "local/backups" : "local/backups/originals"} — ${k}, цель закрыта: пишется`, () => {
        const w = world(where, k, false);
        const doc = w.run(["doctor"]);
        const sync = w.run(["sync", "--global", "--force"]);
        const clean = w.run(["clean", "--global"]);
        const inVault = walk(w.vault);
        expect({
          doctor: /все команды, которые пишут .*откажут|не пишет туда бэкапы/.test(doc.out),
          codes: [sync.code, clean.code],
          refused: /не пишет туда бэкапы/.test(sync.out + clean.out),
          wrote: where === "originals" ? inVault.some((p) => /\/skills\/gs\/SKILL\.md$/.test(p)) : inVault.some((p) => /CLAUDE\.md$/.test(p)),
        }).toEqual({ doctor: false, codes: [0, 0], refused: false, wrote: true });
      }, 300000);

  // Ссылка глубже по пути записи (папка запуска — ссылка, сделал пользователь): запасной замок в backup()
  test.skipIf(!win)("ссылка глубже по пути записи (backups/<папка> — junction на открытую) — запись туда отказана", async () => {
    const { backup, newBackupRun } = await import("../src/backup");
    const root = tmp("c10deep-");
    const config = `${root}/config`, vault = `${root}/vault`;
    put(`${config}/local/machine.yaml`, "agents: [claude]\n");
    mkdirSync(vault, { recursive: true });
    put(`${root}/home/f.txt`, "secret\n");
    newBackupRun();
    // Первый бэкап создаёт папку запуска; затем её заменяет ссылка на открытую цель
    backup(`${root}/home/f.txt`, config);
    const stamp = readdirSync(`${config}/local/backups`)[0];
    rmSync(`${config}/local/backups/${stamp}`, { recursive: true });
    symlinkSync(vault, `${config}/local/backups/${stamp}`, "junction");
    put(`${root}/home/g.txt`, "secret2\n");
    let err = "";
    try { backup(`${root}/home/g.txt`, config); } catch (e) { err = (e as Error).message; }
    newBackupRun();
    expect({ refused: /не пишет туда бэкапы/.test(err), vault: walk(vault) }).toEqual({ refused: true, vault: [] });
  }, 60000);
});

// Рецензия A круга 8c: п. 1 — local/backups ссылкой на закрытую цель, а папка originals за ней открыта (явная запись
// другого): отказ, команда «Закройте папку бэкапов и всё в ней» дословно → следующая команда пишет; п. 9 — ссылка глубже (originals/C) на
// открытую цель: --dry-run и запуск — отказ в начале; п. 7 — trust, target, adopt — отказ до любой записи.
const openDir = (p: string) => win
  ? Bun.spawnSync([join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), p.replaceAll("/", "\\"), "/grant", "*S-1-1-0:(OI)(CI)(R)"], { stdout: "pipe" })
  : Bun.spawnSync(["chmod", "755", p]);
const runCloseCmd = (cmd: string) => win
  ? Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd.replace(/^\(PowerShell\) /, "")], { stdout: "pipe", stderr: "pipe" })
  : Bun.spawnSync(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe" });

test.skipIf(!win)("Windows: цель local/backups закрыта, папка originals за ней открыта — отказ; «Закройте папку оригиналов» дословно — пишется", () => {
  const w = world("backups", win ? "junction" : "dir", false);
  mkdirSync(`${w.vault}/originals`, { recursive: true });
  openDir(`${w.vault}/originals`);
  const before = walk(w.vault);
  const dry = w.run(["sync", "--global", "--force", "--dry-run"]);
  const sync = w.run(["sync", "--global", "--force"]);
  const doc = w.run(["doctor"]);
  expect({ dry: dry.code, sync: sync.code, text: /originals: .*miksy не пишет туда бэкапы.*Закройте папку бэкапов и всё в ней \(PowerShell\): /.test(sync.out), doctor: /откажут/.test(doc.out), vault: walk(w.vault) })
    .toEqual({ dry: 1, sync: 1, text: true, doctor: true, vault: before });
  const cmd = sync.out.match(/Закройте папку бэкапов и всё в ней \(PowerShell\): (.+)$/m)![1].trim();
  expect(runCloseCmd(cmd).exitCode).toBe(0);
  const again = w.run(["sync", "--global", "--force"]);
  expect({ code: again.code, original: walk(`${w.vault}/originals`).some((p) => /SKILL\.md$/.test(p)) }).toEqual({ code: 0, original: true });
}, 300000);

test.skipIf(!KINDS.includes(win ? "junction" : "dir"))("ссылка глубже: local/backups/originals/C — на открытую цель: --dry-run и запуск — отказ, за ссылкой ничего", () => {
  const w = world("backups", win ? "junction" : "dir", false);
  // Обычная local/backups вместо ссылки, в ней originals/C — ссылка на открытую папку
  unlink(`${w.config}/local/backups`);
  const deep = `${w.root}/deep`;
  mkdirSync(deep, { recursive: true });
  link(win ? "junction" : "dir", deep, `${w.config}/local/backups/originals/C`);
  const dry = w.run(["sync", "--global", "--force", "--dry-run"]);
  const sync = w.run(["sync", "--global", "--force"]);
  expect({ dry: dry.code, sync: sync.code, refused: /originals\/C — ссылка на .*miksy не пишет туда бэкапы/.test(sync.out), deep: walk(deep) }).toEqual({ dry: 1, sync: 1, refused: true, deep: [] });
}, 300000);

test.skipIf(!KINDS.includes(win ? "junction" : "dir"))("trust, target, adopt — отказ в начале, до записи; adopt --dry-run — код 1", () => {
  const w = world("backups", win ? "junction" : "dir", true);
  const trustFile = `${w.config}/local/trust.json`;
  const trustBefore = read(trustFile);
  const trust = w.run(["trust", `${w.ws}/Org/p1`, "--deny"]);
  const target = w.run(["target", `${w.ws}/Org`]);
  const adoptDry = w.run(["adopt", "--global", "x", "--to", "global", "--dry-run"]);
  const adopt = w.run(["adopt", "--global", "x", "--to", "global"]);
  expect({
    codes: [trust.code, target.code, adoptDry.code, adopt.code],
    refused: [trust.out, target.out, adoptDry.out, adopt.out].every((o) => /miksy не пишет туда бэкапы/.test(o)),
    trustJson: read(trustFile) === trustBefore,
    layer: existsSync(`${w.config}/layers/tree/Org/layer.yaml`),
  }).toEqual({ codes: [1, 1, 1, 1], refused: true, trustJson: true, layer: false });
}, 300000);

// Повторная проверка 1 круга 8c, п. 3: macOS, Linux — папка 0755 за ссылкой на закрытую цель (700) другим недоступна:
// отказа нет, пишется. П. 2: в строке doctor об отказе готовая команда — последней (строку можно скопировать до конца)
test.skipIf(win)("macOS, Linux: originals 0755 за закрытой целью local/backups — отказа нет, пишется", () => {
  const w = world("backups", "dir", false);
  mkdirSync(`${w.vault}/originals`, { recursive: true });
  openDir(`${w.vault}/originals`);
  const sync = w.run(["sync", "--global", "--force"]);
  expect({ code: sync.code, refused: /не пишет туда бэкапы/.test(sync.out) }).toEqual({ code: 0, refused: false });
}, 300000);

test.skipIf(!KINDS.includes(win ? "junction" : "dir"))("doctor: строка отказа local/backups кончается готовой командой", () => {
  const w = world("backups", win ? "junction" : "dir", true);
  const line = w.run(["doctor"]).out.split("\n").find((l) => /все команды, которые пишут .*откажут: /.test(l))!.trim();
  expect(line).toMatch(win ? /Закрыть цель \(PowerShell\): icacls '.*' \/reset; icacls '.*' \/inheritance:r \/grant:r '\*S-[0-9-]+:\(OI\)\(CI\)F'$/ : /Закрыть цель: chmod 700 '.*'$/);
}, 300000);

// Решение основного агента (8c, вариант «б»): при ссылке local/backups на закрытую цель устройство цели не проверяется в
// начале; отказ — на записи. Условие: отказ на полпути называет папку и даёт готовую команду, за ссылку ничего не пишется
test.skipIf(!win)("Windows: закрытая цель local/backups, глубже открытая папка originals/C — отказ на записи: папка и команда", () => {
  const w = world("backups", "junction", false);
  mkdirSync(`${w.vault}/originals/C`, { recursive: true });
  openDir(`${w.vault}/originals/C`);
  const before = walk(w.vault);
  const sync = w.run(["sync", "--global", "--force"]);
  expect({
    // Строка: «ОШИБКА (цель синхронизирована частично): <папка>: … Закройте папку оригиналов и всё в ней: <команда>» —
    // команда последней, закрывает всё поддерево originals (круг 8d, E1)
    named: /ОШИБКА \(цель синхронизирована частично\): .*originals\/C: .*miksy не пишет туда бэкапы.*Закройте папку оригиналов и всё в ней \(PowerShell\): icacls '[^']*originals' \/reset; .*F'; function Reset-MiksyTree\(\$d\) \{ .* \}; Reset-MiksyTree '[^']*originals'$/m.test(sync.out),
    vault: walk(w.vault),
  }).toEqual({ named: true, vault: before });
  // Выпуск 0.2.3, A6: итог — «записано частично», а не «конфликтов … эти места не изменены»
  expect({ partial: /Целей записано частично: [0-9]+ — запись остановилась на ошибке/.test(sync.out), conflicts: /Конфликтов: /.test(sync.out) }).toEqual({ partial: true, conflicts: false });
}, 300000);
