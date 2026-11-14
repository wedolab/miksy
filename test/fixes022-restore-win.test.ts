// Выпуск 0.2.2, A1 — команда возврата для Windows (PowerShell 5.1): тесты повторной проверки после рецензии A
// (out/review022c/recheck-1.md, п. 1–4) и её контрольные случаи; копию делает copyAgentSettings мастера
import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyAgentSettings, restoreCommand } from "../src/setup";

const win = process.platform === "win32";
// Канонический путь (длинные имена): на GitHub Windows временная папка — короткое имя C:\Users\RUNNER~1\…, а цель ссылки
// после возврата — длинное (выпуск 0.2.3, часть 0)
const tmp = (name = "rc022-") => realpathSync.native(mkdtempSync(join(tmpdir(), name))).replaceAll("\\", "/");
const put = (p: string, s: string) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, s); };
const isLink = (p: string) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
const tgt = (p: string) => readlinkSync(p).replaceAll("\\", "/").replace(/^\/\/\?\//, "").replace(/\/$/, "");
const w = (p: string) => p.replaceAll("/", "\\");
const ps = (cmd: string, home: string, cwd?: string) => {
  const r = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd],
    { env: { ...process.env, USERPROFILE: w(home) }, stdout: "pipe", stderr: "pipe", ...(cwd && { cwd }) });
  return { code: r.exitCode ?? -1, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
};
// Как у пользователя: команда, затем следующая строка в том же окне (exit в команде закрыл бы окно — «после» не напечаталось бы)
const restore = (copy: string, home: string, cwd?: string) => ps(`${restoreCommand(copy, "windows")}; Write-Output "после: $LASTEXITCODE"`, home, cwd);
const ok = { out: "после: 0", err: "" };

// Домашний каталог с ' ’ $ ` [ ] и пробелом; ~/.claude — junction на dotfiles, в ней skills — junction, CLAUDE.md —
// символическая ссылка на файл (режим разработчика: node создаёт её без прав администратора). Копия — copyAgentSettings
// мастера с rels адаптеров, в папку с ' ’ $ ` [ ] и пробелом
function sandbox(dotName = "dot x", fileLink = true) {
  const t = tmp();
  const home = `${t}/ho'me ’$x\` [2]`, dot = `${t}/${dotName}/claude`, skills = `${t}/${dotName}/skills`;
  put(`${home}/.claude.json`, "backup");
  put(`${home}/.codex/config.toml`, "cfg");
  put(`${dot}/settings.json`, "{}");
  put(`${dot}/CLAUDE.real.md`, "rules");
  put(`${skills}/x/SKILL.md`, "sk");
  symlinkSync(dot, `${home}/.claude`, "junction");
  symlinkSync(skills, `${dot}/skills`, "junction");
  if (fileLink) symlinkSync(`${dot}/CLAUDE.real.md`, `${dot}/CLAUDE.md`, "file");
  const copy = `${t}/my 'copy$x\`’ [1]`;
  const r = copyAgentSettings(home, [".claude.json", ".claude/CLAUDE.md", ".claude/settings.json", ".claude/skills", ".codex/config.toml"], copy);
  expect(r.links).toEqual([]);
  return { t, copy, home, dot, skills };
}

test.skipIf(!win)("контроль: пути с ' ’ $ ` [ ], скрытый файл, dotfiles на месте, повторный запуск — код 0, окно не закрыто", () => {
  const s = sandbox();
  put(`${s.dot}/settings.json`, "changed");
  put(`${s.home}/.codex/config.toml`, "changed");
  Bun.spawnSync(["cmd", "/c", "attrib", "+h", w(`${s.home}/.codex/config.toml`)]);
  const r = restore(s.copy, s.home), r2 = restore(s.copy, s.home);
  expect({ r, r2 }).toEqual({ r: { code: 0, ...ok }, r2: { code: 0, ...ok } });
  expect([readFileSync(`${s.dot}/settings.json`, "utf8"), readFileSync(`${s.home}/.codex/config.toml`, "utf8"), readFileSync(`${s.home}/.claude.json`, "utf8")]).toEqual(["{}", "cfg", "backup"]);
  expect([isLink(`${s.home}/.claude`), isLink(`${s.dot}/skills`), isLink(`${s.dot}/CLAUDE.md`)]).toEqual([true, true, true]);
}, 60000);

// Повторная проверка, п. 1 (было до правки): New-Item -ItemType SymbolicLink в Windows PowerShell 5.1 требует прав администратора и в режиме разработчика
// (mklink в cmd — нет): ссылка на файл из копии не возвращается никогда; прежнюю ссылку/файл команда до этого удаляет
test.skipIf(!win)("ссылка на файл из копии (режим разработчика, без прав администратора) — вернулась ссылкой", () => {
  const s = sandbox();
  Bun.spawnSync(["cmd", "/c", "del", w(`${s.dot}/CLAUDE.md`)]);
  const r = restore(s.copy, s.home);
  expect({ r, link: isLink(`${s.dot}/CLAUDE.md`) }).toEqual({ r: { code: 0, ...ok }, link: true });
}, 60000);

test.skipIf(!win)("на месте ссылки на файл — обычный файл (Claude переписал его): после неудачи не остаётся пусто", () => {
  const s = sandbox();
  Bun.spawnSync(["cmd", "/c", "del", w(`${s.dot}/CLAUDE.md`)]);
  put(`${s.dot}/CLAUDE.md`, "user's current text");
  const r = restore(s.copy, s.home);
  expect(existsSync(`${s.dot}/CLAUDE.md`)).toBe(true);
}, 60000);

// Повторная проверка, п. 2 (было до правки): -Target у New-Item в PowerShell 5.1 — шаблон: [ ] в пути цели ссылки ломают возврат; прежнюю ссылку
// команда к этому моменту уже удалила
test.skipIf(!win)("dotfiles в папке с [ ]: junction skills убран — вернулся", () => {
  const s = sandbox("dot [old]", false);
  Bun.spawnSync(["cmd", "/c", "rmdir", w(`${s.dot}/skills`)]);
  const r = restore(s.copy, s.home);
  expect({ r, skills: isLink(`${s.dot}/skills`) && tgt(`${s.dot}/skills`) }).toEqual({ r: { code: 0, ...ok }, skills: s.skills });
}, 60000);

test.skipIf(!win)("dotfiles в папке с [ ]: junction skills ведёт в другое место — заменён, прежняя цель цела", () => {
  const s = sandbox("dot [old]", false);
  put(`${s.t}/other/keep.txt`, "keep");
  Bun.spawnSync(["cmd", "/c", "rmdir", w(`${s.dot}/skills`)]);
  symlinkSync(`${s.t}/other`, `${s.dot}/skills`, "junction");
  const r = restore(s.copy, s.home);
  expect({ keep: readFileSync(`${s.t}/other/keep.txt`, "utf8"), skills: isLink(`${s.dot}/skills`) ? tgt(`${s.dot}/skills`) : "нет ссылки" })
    .toEqual({ keep: "keep", skills: s.skills });
}, 60000);

test.skipIf(!win)("контроль: junction skills ведёт в другое место (без [ ]) — заменён, содержимое прежней цели цело", () => {
  const s = sandbox("dot x", false);
  put(`${s.t}/other/keep.txt`, "keep");
  Bun.spawnSync(["cmd", "/c", "rmdir", w(`${s.dot}/skills`)]);
  symlinkSync(`${s.t}/other`, `${s.dot}/skills`, "junction");
  const r = restore(s.copy, s.home);
  expect({ r, keep: readFileSync(`${s.t}/other/keep.txt`, "utf8"), skills: tgt(`${s.dot}/skills`) }).toEqual({ r: { code: 0, ...ok }, keep: "keep", skills: s.skills });
}, 60000);

test.skipIf(!win)("контроль: junction ~/.claude убран — файлы вернулись в папку, junction skills внутри — ссылкой", () => {
  const s = sandbox("dot x", false);
  Bun.spawnSync(["cmd", "/c", "rmdir", w(`${s.home}/.claude`)]);
  const r = restore(s.copy, s.home);
  expect({ r, settings: readFileSync(`${s.home}/.claude/settings.json`, "utf8"), skills: tgt(`${s.home}/.claude/skills`), dot: readdirSync(s.skills) })
    .toEqual({ r: { code: 0, ...ok }, settings: "{}", skills: s.skills, dot: ["x"] });
}, 60000);

// Повторная проверка, п. 3 (было до правки): относительная ссылка на папку в копии (copyAgentSettings сохраняет цель как есть) — New-Item считает её от
// текущего каталога PowerShell, а не от места ссылки (sh-вариант: ln -s — от места ссылки)
test.skipIf(!win)("относительная ссылка на папку ~/.agents/skills → ../dot/skills — вернулась на ту же папку", () => {
  const t = tmp(), home = `${t}/home`, cwd = `${t}/cwd`;
  put(`${home}/dot/skills/a/SKILL.md`, "sk");
  mkdirSync(`${home}/.agents`, { recursive: true }); mkdirSync(cwd);
  Bun.spawnSync(["cmd", "/c", "mklink", "/D", w(`${home}/.agents/skills`), "..\\dot\\skills"]);
  const copy = `${t}/copy`;
  expect(copyAgentSettings(home, [".agents/skills"], copy).links).toEqual([]);
  Bun.spawnSync(["cmd", "/c", "rmdir", w(`${home}/.agents/skills`)]);
  const r = restore(copy, home, cwd);
  expect({ r, back: existsSync(`${home}/.agents/skills/a/SKILL.md`) }).toEqual({ r: { code: 0, ...ok }, back: true });
}, 60000);

// Повторная проверка, п. 4 (было до правки): путь копии с опечаткой — красная ошибка, но $LASTEXITCODE 0 («всё вернулось» по README)
test.skipIf(!win)("путь копии с опечаткой — код не 0", () => {
  const t = tmp();
  mkdirSync(`${t}/home`, { recursive: true });
  const r = restore(`${t}/no such copy`, `${t}/home`);
  expect({ said: /^не возвращён ни один файл: .*no such copy/s.test(r.out), end: r.out.endsWith("после: 1") }).toEqual({ said: true, end: true });
}, 60000);

// Как у cp в sh: файл «только для чтения» в домашнем каталоге — не возвращается (назван, код 1)
test.skipIf(!win)("файл только для чтения — назван и код 1 (как cp в sh)", () => {
  const s = sandbox("dot x", false);
  put(`${s.dot}/settings.json`, "changed");
  Bun.spawnSync(["cmd", "/c", "attrib", "+r", w(`${s.dot}/settings.json`)]);
  const r = restore(s.copy, s.home);
  expect(r.out).toBe("не возвращён: .claude\\settings.json\nпосле: 1");
}, 60000);
