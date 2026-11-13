// Выпуск 0.2.2, A1 — команда возврата для Windows: символы, которые cmd разбирает сам (^ & , ; = %…%), в путях
// домашнего каталога и цели ссылки; остаток <имя>.miksy-new. Тест повторной проверки 2 (out/review022d/recheck-2.md)
import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyAgentSettings, restoreCommand } from "../src/setup";

const win = process.platform === "win32";
const tmp = () => mkdtempSync(join(tmpdir(), "rc022d-")).replaceAll("\\", "/");
const put = (p: string, s: string) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, s); };
const isLink = (p: string) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
const tgt = (p: string) => { try { return readlinkSync(p).replaceAll("\\", "/").replace(/^\/\/\?\//, "").replace(/\/$/, ""); } catch { return "нет ссылки"; } };
const w = (p: string) => p.replaceAll("/", "\\");
const ps = (cmd: string, home: string, cwd: string) => {
  const r = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd],
    { env: { ...process.env, USERPROFILE: w(home) }, stdout: "pipe", stderr: "pipe", cwd });
  return { code: r.exitCode ?? -1, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
};
const restore = (copy: string, home: string, cwd: string) => ps(`${restoreCommand(copy, "windows")}; Write-Output "после: $LASTEXITCODE"`, home, cwd);

// ~/.claude — обычная папка; skills — junction на <dot>/skills, CLAUDE.md — ссылка на файл <dot>/CLAUDE.real.md.
// Копия — copyAgentSettings; затем обе ссылки в домашнем каталоге убраны (или заменены) — команда должна их вернуть
function setup(homeName: string, dotName: string, replace = false) {
  const t = tmp();
  const home = `${t}/${homeName}`, dot = `${t}/${dotName}`, cwd = `${t}/cwd`;
  mkdirSync(cwd, { recursive: true });
  put(`${dot}/skills/x/SKILL.md`, "sk");
  put(`${dot}/CLAUDE.real.md`, "rules");
  put(`${t}/other/keep.txt`, "keep");
  mkdirSync(`${home}/.claude`, { recursive: true });
  symlinkSync(`${dot}/skills`, `${home}/.claude/skills`, "junction");
  symlinkSync(`${dot}/CLAUDE.real.md`, `${home}/.claude/CLAUDE.md`, "file");
  const copy = `${t}/copy`;
  expect(copyAgentSettings(home, [".claude/skills", ".claude/CLAUDE.md"], copy).links).toEqual([]);
  unlinkSync(`${home}/.claude/skills`);
  unlinkSync(`${home}/.claude/CLAUDE.md`);
  expect([existsSync(`${home}/.claude/skills`), isLink(`${home}/.claude/CLAUDE.md`)]).toEqual([false, false]);
  if (replace) {
    symlinkSync(`${t}/other`, `${home}/.claude/skills`, "junction");
    put(`${home}/.claude/CLAUDE.md`, "current");
  }
  return { t, home, dot, cwd, copy };
}

const check = (homeName: string, dotName: string, replace = false) => {
  const s = setup(homeName, dotName, replace);
  const r = restore(s.copy, s.home, s.cwd);
  return {
    r,
    skills: tgt(`${s.home}/.claude/skills`), wantSkills: `${s.dot}/skills`,
    claude: tgt(`${s.home}/.claude/CLAUDE.md`), wantClaude: `${s.dot}/CLAUDE.real.md`,
    left: readdirSync(`${s.home}/.claude`).filter((n) => n.includes("miksy-new")),
    keep: existsSync(`${s.t}/other/keep.txt`), stray: readdirSync(s.cwd),
  };
};
const good = (c: ReturnType<typeof check>) => {
  expect({ code: c.r.out.split("\n").at(-1), skills: c.skills, claude: c.claude, left: c.left, keep: c.keep, stray: c.stray })
    .toEqual({ code: "после: 0", skills: c.wantSkills, claude: c.wantClaude, left: [], keep: true, stray: [] });
};

// Символы, которые cmd разбирает вне кавычек (PowerShell 5.1 берёт аргумент в кавычки только при пробеле)
for (const [homeName, dotName] of [
  ["home", "d&x"], ["home", "d^x"], ["home", "d,x"], ["home", "d;x"], ["home", "d=x"], ["home", "d%USERNAME%x"],
  ["home", "d(x)"], ["home", "d!x"], ["home", "d [x] & (y) ^ z"], ["home", "д о т"], ["home", "дот"],
  ["h&me", "dot"], ["h^me", "dot"], ["h,me", "dot"], ["h%USERNAME%me", "dot"], ["h (w) & x", "dot"], ["домой", "dot"],
] as const) {
  test.skipIf(!win)(`спецсимволы: дом «${homeName}», dotfiles «${dotName}» — ссылки вернулись верно`, () => good(check(homeName, dotName)), 60000);
  test.skipIf(!win)(`спецсимволы, ссылки уже в другом месте: дом «${homeName}», dotfiles «${dotName}»`, () => good(check(homeName, dotName, true)), 60000);
}

// Остаток .miksy-new: прежний файл на месте ссылки «только для чтения» — удалить не вышло; затем атрибут снят, повторный запуск
test.skipIf(!win)("остаток .miksy-new после неудачи не мешает повторному запуску", () => {
  const s = setup("home", "dot", true);
  Bun.spawnSync(["cmd", "/c", "attrib", "+r", w(`${s.home}/.claude/CLAUDE.md`)]);
  const r1 = restore(s.copy, s.home, s.cwd);
  const left1 = readdirSync(`${s.home}/.claude`).filter((n) => n.includes("miksy-new"));
  Bun.spawnSync(["cmd", "/c", "attrib", "-r", w(`${s.home}/.claude/CLAUDE.md`)]);
  const r2 = restore(s.copy, s.home, s.cwd);
  expect({ r1: r1.out, left1, r2: r2.out, claude: tgt(`${s.home}/.claude/CLAUDE.md`), left2: readdirSync(`${s.home}/.claude`).filter((n) => n.includes("miksy-new")) })
    .toEqual({ r1: "не возвращён: .claude\\CLAUDE.md\nпосле: 1", left1: [], r2: "после: 0", claude: `${s.dot}/CLAUDE.real.md`, left2: [] });
}, 60000);

// Относительная ссылка на файл из копии, на месте — обычный файл (путь через .miksy-new и Move)
test.skipIf(!win)("относительная ссылка на файл, на месте обычный файл — вернулась, читается", () => {
  const t = tmp(), home = `${t}/home`, cwd = `${t}/cwd`;
  mkdirSync(cwd); put(`${home}/dot/config.toml`, "cfg"); mkdirSync(`${home}/.codex`);
  Bun.spawnSync(["cmd", "/c", "mklink", w(`${home}/.codex/config.toml`), "..\\dot\\config.toml"]);
  const copy = `${t}/copy`;
  expect(copyAgentSettings(home, [".codex/config.toml"], copy).links).toEqual([]);
  Bun.spawnSync(["cmd", "/c", "del", w(`${home}/.codex/config.toml`)]);
  put(`${home}/.codex/config.toml`, "changed");
  const r = restore(copy, home, cwd), r2 = restore(copy, home, cwd);
  expect({ r: r.out, r2: r2.out, link: isLink(`${home}/.codex/config.toml`), text: readFileSync(`${home}/.codex/config.toml`, "utf8") })
    .toEqual({ r: "после: 0", r2: "после: 0", link: true, text: "cfg" });
}, 60000);

// П. 3, вторая часть: папку внутри копии не прочитать (запрет чтения в ACL) — названа, код 1
test.skipIf(!win)("папку копии не прочитать — названа, код 1", () => {
  const t = tmp(), home = `${t}/home`, cwd = `${t}/cwd`, copy = `${t}/copy`;
  mkdirSync(cwd); mkdirSync(home); put(`${copy}/.claude/settings.json`, "{}"); put(`${copy}/.codex/config.toml`, "cfg");
  const user = process.env.USERNAME!;
  Bun.spawnSync(["icacls", w(`${copy}/.claude`), "/deny", `${user}:(RD)`]);
  const r = restore(copy, home, cwd);
  Bun.spawnSync(["icacls", w(`${copy}/.claude`), "/remove:d", user]);
  expect({ said: /не возвращён: .*\.claude/.test(r.out), end: r.out.endsWith("после: 1"), codex: readFileSync(`${home}/.codex/config.toml`, "utf8") })
    .toEqual({ said: true, end: true, codex: "cfg" });
}, 60000);

// На месте ссылки — «битая» ссылка пользователя (цель удалена): заменяется ссылкой из копии
test.skipIf(!win)("битая ссылка на месте — заменена", () => {
  const s = setup("home", "dot");
  mkdirSync(`${s.t}/gone/skills`, { recursive: true }); put(`${s.t}/gone/c.md`, "x");
  symlinkSync(`${s.t}/gone/skills`, `${s.home}/.claude/skills`, "junction");
  symlinkSync(`${s.t}/gone/c.md`, `${s.home}/.claude/CLAUDE.md`, "file");
  Bun.spawnSync(["cmd", "/c", "rmdir", "/s", "/q", w(`${s.t}/gone`)]);
  const c = restore(s.copy, s.home, s.cwd);
  expect({ out: c.out, skills: tgt(`${s.home}/.claude/skills`), claude: tgt(`${s.home}/.claude/CLAUDE.md`) })
    .toEqual({ out: "после: 0", skills: `${s.dot}/skills`, claude: `${s.dot}/CLAUDE.real.md` });
}, 60000);
