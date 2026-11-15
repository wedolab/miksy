// Круг 10c: miksy restore на Windows — ссылки (junction, символическая ссылка на файл), dotfiles, занятый и «только для
// чтения» файл, скрытый файл, [ ] и кавычки в путях. Сценарии прежней команды PowerShell (test/fixes022-restore-win,
// fixes022-restore-cmd) — на planRestore/applyRestore; копию делает copyAgentSettings мастера
import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyAgentSettings } from "../src/setup";
import { applyRestore, planRestore } from "../src/restore";

const win = process.platform === "win32";
const tmp = (name = "rw10c-") => realpathSync.native(mkdtempSync(join(tmpdir(), name))).replaceAll("\\", "/");
const put = (p: string, s: string) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, s); };
const isLink = (p: string) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
const tgt = (p: string) => readlinkSync(p).replaceAll("\\", "/").replace(/^\/\/\?\//, "").replace(/\/$/, "");
const w = (p: string) => p.replaceAll("/", "\\");
const restore = (copy: string, home: string) => {
  const saved: string[] = [];
  const r = applyRestore(planRestore(copy, home), home, (p) => saved.push(p));
  return { failed: r.failed, saved };
};
const linkKind = (p: string) => {
  const r = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $i = Get-Item -LiteralPath $env:P -Force; "$($i.LinkType)/$([int]$i.PSIsContainer)"`], { stdout: "pipe", env: { ...process.env, P: w(p) } });
  return r.stdout.toString().trim();
};

// Домашний каталог с ' ’ $ ` [ ] и пробелом; ~/.claude — junction на dotfiles, в ней skills — junction, CLAUDE.md —
// символическая ссылка на файл (режим разработчика). Копия — в папку с ' ’ $ ` [ ] и пробелом
function sandbox(dotName = "dot x", fileLink = true) {
  const t = tmp();
  const home = `${t}/ho'me ’$x\` [2] кат`, dot = `${t}/${dotName}/claude`, skills = `${t}/${dotName}/skills`;
  put(`${home}/.claude.json`, "{}");
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

test.skipIf(!win)("сквозь junction dotfiles, скрытый файл, повторный запуск — всё вернулось; ссылки на месте; затёртое — в бэкап", () => {
  const s = sandbox();
  put(`${s.dot}/settings.json`, "changed");
  put(`${s.home}/.codex/config.toml`, "changed");
  Bun.spawnSync(["cmd", "/c", "attrib", "+h", w(`${s.home}/.codex/config.toml`)]);
  const r = restore(s.copy, s.home), r2 = restore(s.copy, s.home);
  expect({ f1: r.failed, f2: r2.failed, saved: r.saved.length, saved2: r2.saved.length }).toEqual({ f1: [], f2: [], saved: 2, saved2: 0 });
  expect([readFileSync(`${s.dot}/settings.json`, "utf8"), readFileSync(`${s.home}/.codex/config.toml`, "utf8")]).toEqual(["{}", "cfg"]);
  expect([isLink(`${s.home}/.claude`), isLink(`${s.dot}/skills`), isLink(`${s.dot}/CLAUDE.md`)]).toEqual([true, true, true]);
  // Скрытый атрибут остался (запись в файл на месте)
  expect(linkKind(`${s.home}/.codex/config.toml`)).toBe("/0");
}, 60000);

test.skipIf(!win)("ссылка на файл из копии — вернулась ссылкой (режим разработчика) или названа с причиной", () => {
  const s = sandbox();
  Bun.spawnSync(["cmd", "/c", "del", w(`${s.dot}/CLAUDE.md`)]);
  const r = restore(s.copy, s.home);
  if (r.failed.length) expect(r.failed[0].why).toContain("режим разработчика");
  else expect(linkKind(`${s.dot}/CLAUDE.md`)).toBe("SymbolicLink/0");
}, 60000);

test.skipIf(!win)("на месте ссылки на файл — обычный файл (Claude переписал его): заменён ссылкой, не остаётся пусто", () => {
  const s = sandbox();
  Bun.spawnSync(["cmd", "/c", "del", w(`${s.dot}/CLAUDE.md`)]);
  put(`${s.dot}/CLAUDE.md`, "user's current text");
  const r = restore(s.copy, s.home);
  expect(existsSync(`${s.dot}/CLAUDE.md`)).toBe(true);
  expect(existsSync(`${s.dot}/CLAUDE.md.miksy-new`)).toBe(false);
  if (!r.failed.length) expect(isLink(`${s.dot}/CLAUDE.md`)).toBe(true);
}, 60000);

test.skipIf(!win)("dotfiles в папке с [ ]: junction skills убран — вернулся junction", () => {
  const s = sandbox("dot [old]", false);
  Bun.spawnSync(["cmd", "/c", "rmdir", w(`${s.dot}/skills`)]);
  const r = restore(s.copy, s.home);
  expect({ f: r.failed, kind: linkKind(`${s.dot}/skills`), to: tgt(`${s.dot}/skills`) }).toEqual({ f: [], kind: "Junction/1", to: s.skills });
}, 60000);

test.skipIf(!win)("junction skills ведёт в другое место — заменён, прежняя цель цела; остаток .miksy-new не мешает", () => {
  const s = sandbox("dot [old]", false);
  put(`${s.t}/other/keep.txt`, "keep");
  Bun.spawnSync(["cmd", "/c", "rmdir", w(`${s.dot}/skills`)]);
  symlinkSync(`${s.t}/other`, `${s.dot}/skills`, "junction");
  symlinkSync(`${s.t}/other`, `${s.dot}/skills.miksy-new`, "junction"); // остаток прошлой неудачи
  const r = restore(s.copy, s.home);
  expect({ f: r.failed, keep: readFileSync(`${s.t}/other/keep.txt`, "utf8"), to: tgt(`${s.dot}/skills`), rest: existsSync(`${s.dot}/skills.miksy-new`) })
    .toEqual({ f: [], keep: "keep", to: s.skills, rest: false });
}, 60000);

test.skipIf(!win)("junction ~/.claude убран — файлы вернулись в папку, junction skills внутри — ссылкой", () => {
  const s = sandbox("dot x", false);
  Bun.spawnSync(["cmd", "/c", "rmdir", w(`${s.home}/.claude`)]);
  const r = restore(s.copy, s.home);
  expect({ f: r.failed, settings: readFileSync(`${s.home}/.claude/settings.json`, "utf8"), skills: tgt(`${s.home}/.claude/skills`), dot: readdirSync(s.skills) })
    .toEqual({ f: [], settings: "{}", skills: s.skills, dot: ["x"] });
}, 60000);

test.skipIf(!win)("относительная ссылка на папку ~/.agents/skills → ..\\dot\\skills — вернулась на ту же папку", () => {
  const t = tmp(), home = `${t}/home`;
  put(`${home}/dot/skills/a/SKILL.md`, "sk");
  mkdirSync(`${home}/.agents`, { recursive: true });
  Bun.spawnSync(["cmd", "/c", "mklink", "/D", w(`${home}/.agents/skills`), "..\\dot\\skills"]);
  const copy = `${t}/copy`;
  expect(copyAgentSettings(home, [".agents/skills"], copy).links).toEqual([]);
  Bun.spawnSync(["cmd", "/c", "rmdir", w(`${home}/.agents/skills`)]);
  const r = restore(copy, home);
  expect({ f: r.failed, back: existsSync(`${home}/.agents/skills/a/SKILL.md`) }).toEqual({ f: [], back: true });
}, 60000);

test.skipIf(!win)("битый junction в копии — вернулся junction (битым), цель не создана", () => {
  const t = tmp(), home = `${t}/home`;
  mkdirSync(`${home}/.claude`, { recursive: true });
  symlinkSync(`${t}/gone`, `${home}/.claude/skills`, "junction");
  const copy = `${t}/copy`;
  expect(copyAgentSettings(home, [".claude/skills"], copy).links).toEqual([]);
  Bun.spawnSync(["cmd", "/c", "rmdir", w(`${home}/.claude/skills`)]);
  const r = restore(copy, home);
  expect({ f: r.failed, kind: linkKind(`${home}/.claude/skills`), gone: existsSync(`${t}/gone`) }).toEqual({ f: [], kind: "Junction/1", gone: false });
}, 60000);

test.skipIf(!win)("файл «только для чтения» — назван с командой attrib, остальное вернулось", () => {
  const s = sandbox("dot x", false);
  put(`${s.dot}/settings.json`, "changed");
  put(`${s.home}/.codex/config.toml`, "changed");
  Bun.spawnSync(["cmd", "/c", "attrib", "+r", w(`${s.dot}/settings.json`)]);
  const r = restore(s.copy, s.home);
  Bun.spawnSync(["cmd", "/c", "attrib", "-r", w(`${s.dot}/settings.json`)]);
  expect(r.failed.map((f) => f.rel)).toEqual([".claude/settings.json"]);
  expect(r.failed[0].why).toContain("«только для чтения»: снимите пометку — attrib -r");
  expect(readFileSync(`${s.home}/.codex/config.toml`, "utf8")).toBe("cfg");
}, 60000);

test.skipIf(!win)("занятый файл (открыт без общего доступа) — назван, остальное вернулось; после закрытия — повтор", async () => {
  const s = sandbox("dot x", false);
  put(`${s.dot}/settings.json`, "changed");
  put(`${s.home}/.codex/config.toml`, "changed");
  const held = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-Command",
    `$f = [IO.File]::Open($env:HELD, 'Open', 'ReadWrite', 'None'); 'ready'; Start-Sleep 30; $f.Close()`], { stdout: "pipe", env: { ...process.env, HELD: w(`${s.home}/.codex/config.toml`) } });
  const reader = held.stdout.getReader();
  await reader.read();
  const r = restore(s.copy, s.home);
  held.kill();
  await held.exited;
  expect(r.failed.map((f) => f.rel)).toEqual([".codex/config.toml"]);
  expect(r.failed[0].why).toMatch(/занят/);
  expect(readFileSync(`${s.dot}/settings.json`, "utf8")).toBe("{}");
  expect(restore(s.copy, s.home).failed).toEqual([]);
  expect(readFileSync(`${s.home}/.codex/config.toml`, "utf8")).toBe("cfg");
}, 60000);
