// Выпуск 0.2.2, круг 8b, C3 (рецензия A №3, №4, «новичок» 2 проверки 8a): README «Как удалить», шаг 3 — команда
// возврата из README дословно, путь вставлен по правилу README: кавычка в пути — в PowerShell удвоить (' и ’ ‘ ‚ ‛),
// в sh — '\''. Строки «не возвращён: …»: на месте файла папка — убрать её и запустить ту же команду ещё раз; повторять
// безопасно (файлы — тем же содержимым, ссылки, которые уже на месте, — пропуск). Временные каталоги
import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENGINE } from "../src/load";
import { copyAgentSettings } from "../src/setup";

const win = process.platform === "win32";
const readme = readFileSync(join(ENGINE, "README.md"), "utf8");
// Команды README: первая строка «& { try { $c = …» (PowerShell) и «(cd -- '…' && find …» (sh)
const PS = readme.split("\n").find((l) => l.startsWith("& { try { $c = (Get-Item -LiteralPath '"))!;
const SH = readme.split("\n").find((l) => l.startsWith("(cd -- '"))!;
// Путь в одинарных кавычках в начале команды — заменить на свой (правило README)
const withPath = (cmd: string, quoted: string) => cmd.replace(/'[^']*'/, () => quoted);
const psQuoted = (p: string) => `'${p.replace(/['‘’‚‛]/g, "$&$&")}'`;
const shQuoted = (p: string) => `'${p.replaceAll("'", "'\\''")}'`;
const put = (p: string, s: string) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, s); };
const isLink = (p: string) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

function sandbox(name: string) {
  const t = mkdtempSync(join(tmpdir(), "rr8b-")).replaceAll("\\", "/");
  const home = `${t}/home`, dot = `${t}/dot`;
  put(`${home}/.codex/config.toml`, "cfg");
  put(`${home}/.claude/settings.json`, "{}");
  put(`${home}/.claude.json`, "keep");
  put(`${dot}/skills/s1/SKILL.md`, "sk");
  mkdirSync(`${home}/.agents`, { recursive: true });
  symlinkSync(`${dot}/skills`, `${home}/.agents/skills`, win ? "junction" : "dir");
  const copy = `${t}/${name}/before-miksy-x`;
  copyAgentSettings(home, [".codex/config.toml", ".claude/settings.json", ".claude.json", ".agents/skills"], copy);
  put(`${home}/.codex/config.toml`, "changed");
  return { home, copy };
}
const run = (cmd: string, home: string) => {
  const r = win
    ? Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", `${cmd}; Write-Output "после: $LASTEXITCODE"`], { env: { ...process.env, USERPROFILE: home.replaceAll("/", "\\") }, stdout: "pipe", stderr: "pipe" })
    : Bun.spawnSync(["sh", "-c", `${cmd}; echo "после: $?"`], { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
  return (r.stdout.toString() + r.stderr.toString()).trim().replaceAll("\\", "/");
};
const cmdFor = (copy: string) => (win ? withPath(PS, psQuoted(copy.replaceAll("/", "\\"))) : withPath(SH, shQuoted(copy)));

for (const name of win ? ["O'Brien", "O’Brien ‘x‚y‛"] : ["O'Brien", "it's 'here'"])
  test(`путь копии с кавычками «${name}», вставлен по правилу README — всё вернулось`, () => {
    const s = sandbox(name);
    expect(run(cmdFor(s.copy), s.home)).toBe("после: 0");
    expect([readFileSync(`${s.home}/.codex/config.toml`, "utf8"), isLink(`${s.home}/.agents/skills`)]).toEqual(["cfg", true]);
  }, 60000);

test("«не возвращён»: на месте файла папка — убрать её и повторить ту же команду; повтор безопасен", () => {
  const s = sandbox("c");
  rmSync(`${s.home}/.codex/config.toml`);
  mkdirSync(`${s.home}/.codex/config.toml/inner`, { recursive: true });
  const first = run(cmdFor(s.copy), s.home);
  expect(first).toContain("не возвращён: .codex/config.toml");
  expect(first).toMatch(/после: [1-9]/);
  rmSync(`${s.home}/.codex/config.toml`, { recursive: true });
  // Ссылку, которая уже на месте, команда пропускает; убранную — возвращает
  if (win) Bun.spawnSync(["cmd", "/c", "rmdir", `${s.home}/.agents/skills`.replaceAll("/", "\\")]);
  else unlinkSync(`${s.home}/.agents/skills`);
  expect(run(cmdFor(s.copy), s.home)).toBe("после: 0");
  expect(run(cmdFor(s.copy), s.home)).toBe("после: 0");
  expect([readFileSync(`${s.home}/.codex/config.toml`, "utf8"), readFileSync(`${s.home}/.claude/settings.json`, "utf8"), readFileSync(`${s.home}/.claude.json`, "utf8"), isLink(`${s.home}/.agents/skills`), existsSync(`${s.home}/.agents/skills/s1/SKILL.md`)])
    .toEqual(["cfg", "{}", "keep", true, true]);
}, 60000);

// Круг 8c, D3 (рецензия A №6 проверки 8b): файл «только для чтения» — «не возвращён»; совет README (attrib -r / chmod u+w)
// дословно, затем та же команда ещё раз — вернулся
test("«не возвращён»: файл только для чтения — совет README дословно, повтор — вернулся", () => {
  const s = sandbox("ro");
  const file = `${s.home}/.codex/config.toml`;
  if (win) Bun.spawnSync(["attrib", "+r", file.replaceAll("/", "\\")]); else Bun.spawnSync(["chmod", "a-w", file]);
  const first = run(cmdFor(s.copy), s.home);
  expect(first).toContain("не возвращён: .codex/config.toml");
  // <файл> — путь из строки «не возвращён» (от домашнего каталога), как велит README
  const shown = first.match(/не возвращён: (\S+)/)![1];
  const advice = readme.match(win ? /`(attrib -r "\$HOME\\<файл>")`/ : /`(chmod u\+w ~\/'<файл>')`/)![1].replace("<файл>", win ? shown.replaceAll("/", "\\") : shown);
  const env = { ...process.env, USERPROFILE: s.home.replaceAll("/", "\\"), HOME: s.home };
  const r = win ? Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", advice], { env }) : Bun.spawnSync(["sh", "-c", advice], { env });
  expect(r.exitCode).toBe(0);
  expect(run(cmdFor(s.copy), s.home)).toBe("после: 0");
  expect(readFileSync(file, "utf8")).toBe("cfg");
}, 60000);
