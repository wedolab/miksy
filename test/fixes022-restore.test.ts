// Выпуск 0.2.2, A1: команда возврата копии «до miksy» (мастер и README «Как удалить», шаг 3). Сгенерированная команда
// выполняется в песочнице текущей ОС: sh на macOS и Linux, PowerShell на Windows; временный домашний каталог. Копию
// делает тот же copyAgentSettings, что и мастер: ссылки (dotfiles) в ней — ссылками (рецензия A 0.2.2, п. 2, 3)
import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENGINE } from "../src/load";
import { copyAgentSettings, restoreCommand } from "../src/setup";

const win = process.platform === "win32";
const WIN_EXAMPLE = "C:/Users/you/Projects/miksy-config/local/backups/before-miksy-2026-11-10T09-00-00";
const POSIX_EXAMPLE = "/Users/you/Projects/miksy-config/local/backups/before-miksy-2026-11-10T09-00-00";

test("README и мастер дают одну и ту же команду (пример пути)", () => {
  const readme = readFileSync(join(ENGINE, "README.md"), "utf8");
  expect(readme).toContain(restoreCommand(WIN_EXAMPLE, "windows"));
  expect(readme).toContain(restoreCommand(POSIX_EXAMPLE, "macos"));
  expect(restoreCommand(POSIX_EXAMPLE, "linux")).toBe(restoreCommand(POSIX_EXAMPLE, "macos"));
});

const put = (p: string, s: string) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, s); };
const isLink = (p: string) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
const target = (p: string) => readlinkSync(p).replaceAll("\\", "/").replace(/^\/\/\?\//, "").replace(/\/$/, "");

function run(copy: string, home: string) {
  const cmd = restoreCommand(copy, win ? "windows" : "linux");
  const r = win
    ? Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", `${cmd}; exit $LASTEXITCODE`], { env: { ...process.env, USERPROFILE: home.replaceAll("/", "\\") }, stdout: "pipe", stderr: "pipe" })
    : Bun.spawnSync(["sh", "-c", cmd], { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString(), said: r.stdout.toString() + r.stderr.toString() };
}

// Домашний каталог: ~/.claude — ссылка на dotfiles (junction на Windows), в ней skills — ссылка на папку dotfiles,
// ~/.codex — обычная папка; копия — copyAgentSettings мастера в папку с пробелом, ' $ ` ’ (и " — где ОС позволяет)
function sandbox() {
  const t = mkdtempSync(join(tmpdir(), "r022-")).replaceAll("\\", "/");
  const home = `${t}/home`, dot = `${t}/dot/claude`, skills = `${t}/dot/skills`;
  put(`${home}/.claude.json`, "backup");
  put(`${home}/.codex/config.toml`, "cfg");
  put(`${dot}/settings.json`, "{}");
  put(`${dot}/.credentials.json`, "cred");
  put(`${skills}/x/SKILL.md`, "sk");
  symlinkSync(dot, `${home}/.claude`, "junction");
  symlinkSync(skills, `${dot}/skills`, "junction");
  const copy = `${t}/my 'copy$x\`’${win ? "" : '"'}`;
  const r = copyAgentSettings(home, [".claude.json", ".claude/settings.json", ".claude/skills", ".codex/config.toml"], copy);
  expect(r.links).toEqual([]);
  expect(isLink(`${copy}/.claude/skills`)).toBe(true);
  // После копии пользователь поменял файлы; .claude.json — живой
  put(`${home}/.claude.json`, "live");
  put(`${dot}/settings.json`, "changed");
  put(`${home}/.codex/config.toml`, "changed");
  return { t, copy, home, dot, skills };
}

test("всё вернулось: код 0; .claude.json не тронут; сквозь dotfiles-ссылку; ссылка на папку уже на месте — без ошибки; путь с ' $ ` ’ пробелом", () => {
  const s = sandbox();
  const r = run(s.copy, s.home);
  expect({ code: r.code, said: r.said.trim() }).toEqual({ code: 0, said: "" });
  expect(readFileSync(`${s.home}/.claude.json`, "utf8")).toBe("live");
  expect(readFileSync(`${s.home}/.codex/config.toml`, "utf8")).toBe("cfg");
  expect(readFileSync(`${s.dot}/settings.json`, "utf8")).toBe("{}");
  expect(isLink(`${s.home}/.claude`)).toBe(true);
  expect(isLink(`${s.dot}/skills`)).toBe(true);
  expect(existsSync(`${s.dot}/.credentials.json`)).toBe(true);
  // Повторно — то же
  expect(run(s.copy, s.home).code).toBe(0);
  rmSync(s.t, { recursive: true, force: true });
}, 60000);

test("ссылки из копии вернулись ссылками: ссылки на папку skills нет — создана заново (без прав администратора)", () => {
  const s = sandbox();
  if (win) Bun.spawnSync(["cmd", "/c", "rmdir", `${s.dot}/skills`.replaceAll("/", "\\")]);
  else unlinkSync(`${s.dot}/skills`);
  expect(existsSync(`${s.dot}/skills`)).toBe(false);
  const r = run(s.copy, s.home);
  expect({ code: r.code, said: r.said.trim() }).toEqual({ code: 0, said: "" });
  expect(isLink(`${s.dot}/skills`)).toBe(true);
  expect(target(`${s.dot}/skills`)).toBe(s.skills);
  expect(readFileSync(`${s.dot}/skills/x/SKILL.md`, "utf8")).toBe("sk");
  rmSync(s.t, { recursive: true, force: true });
}, 60000);

test("файл не вернулся (на его месте в домашнем каталоге папка): код не 0, файл назван; остальное вернулось", () => {
  const s = sandbox();
  put(`${s.copy}/blocked.txt`, "f");
  mkdirSync(`${s.home}/blocked.txt`, { recursive: true });
  const r = run(s.copy, s.home);
  expect(r.code).not.toBe(0);
  expect(r.said).toContain("не возвращён: blocked.txt");
  expect(lstatSync(`${s.home}/blocked.txt`).isDirectory()).toBe(true);
  expect(readFileSync(`${s.home}/.codex/config.toml`, "utf8")).toBe("cfg");
  expect(readdirSync(`${s.home}/blocked.txt`)).toEqual([]);
  rmSync(s.t, { recursive: true, force: true });
}, 60000);
