// Выпуск 0.2.3, A9 («Открытое» 8a, 8b): копия «до miksy» и ссылки — тип ссылки по источнику. Windows: junction и
// символическая ссылка на папку → junction (прав не требует), битый junction — junction (битым, цель не создаётся), на
// файл — символическая ссылка на файл; команда возврата из «Как удалить» возвращает их ссылками того же вида (папки —
// junction). Только временные каталоги
import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { copyAgentSettings, restoreCommand } from "../src/setup";

const win = process.platform === "win32";
const tmp = (p: string) => realpathSync.native(mkdtempSync(join(tmpdir(), p))).replaceAll("\\", "/");
const put = (p: string, s = "x\n") => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };
// Вид ссылки: Junction, SymbolicLink (и папка ли) — PowerShell, без захода в ссылку
function kinds(paths: string[]): Record<string, string> {
  const list = paths.map((p) => `'${p.replaceAll("/", "\\")}'`).join(",");
  const r = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", `foreach ($p in @(${list})) { $i = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue; if ($i) { "$($i.LinkType)/$([int][bool]$i.PSIsContainer)" } else { "нет" } }`], { stdout: "pipe" });
  const out = r.stdout.toString().split(/\r?\n/).filter(Boolean);
  return Object.fromEntries(paths.map((p, i) => [p.split("/").slice(-2).join("/"), out[i]]));
}

test.skipIf(!win)("A9: копия «до miksy» — junction, битый junction, ссылка на папку — junction; на файл — ссылка на файл; возврат — тем же видом", () => {
  const root = tmp("a9-");
  const home = `${root}/home`, dot = `${root}/dot`, copy = `${root}/copy`;
  put(`${dot}/skills/s1/SKILL.md`);
  put(`${dot}/agents/a1/x.md`);
  put(`${dot}/settings.json`, "{}");
  mkdirSync(`${home}/.claude`, { recursive: true });
  symlinkSync(`${dot}/skills`, `${home}/.claude/skills`, "junction");
  symlinkSync(`${dot}/gone`, `${home}/.claude/gone`, "junction"); // битый junction
  symlinkSync(`${dot}/agents`, `${home}/.claude/agents`, "dir");
  symlinkSync(`${dot}/settings.json`, `${home}/.claude/settings.json`, "file");
  const r = copyAgentSettings(home, [".claude"], copy);
  const names = ["skills", "gone", "agents", "settings.json"];
  const inCopy = kinds(names.map((n) => `${copy}/.claude/${n}`));
  expect({ links: r.links, inCopy, gone: existsSync(`${dot}/gone`) }).toEqual({
    links: [],
    inCopy: { ".claude/skills": "Junction/1", ".claude/gone": "Junction/1", ".claude/agents": "Junction/1", ".claude/settings.json": "SymbolicLink/0" },
    gone: false,
  });
  expect(readlinkSync(`${copy}/.claude/gone`).replace(/^\\\\\?\\/, "").replaceAll("\\", "/").replace(/\/$/, "").toLowerCase()).toBe(`${dot}/gone`.toLowerCase());
  // Возврат командой из «Как удалить»: убрать нынешние ссылки, вернуть из копии
  for (const n of names) { const p = `${home}/.claude/${n}`; if (lstatSync(p).isSymbolicLink()) { try { rmSync(p); } catch { Bun.spawnSync(["cmd", "/c", "rmdir", p.replaceAll("/", "\\")]); } } }
  const back = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", restoreCommand(copy, "windows")], { env: { ...process.env, USERPROFILE: home, HOME: home }, stdout: "pipe", stderr: "pipe" });
  const restored = kinds(names.map((n) => `${home}/.claude/${n}`));
  expect({ code: back.exitCode, restored, gone: existsSync(`${dot}/gone`) }).toEqual({
    code: 0,
    restored: { ".claude/skills": "Junction/1", ".claude/gone": "Junction/1", ".claude/agents": "Junction/1", ".claude/settings.json": "SymbolicLink/0" },
    gone: false,
  });
}, 120000);

test.skipIf(win)("A9: macOS, Linux — ссылки копии с той же целью, как записана", () => {
  const root = tmp("a9-");
  const home = `${root}/home`, dot = `${root}/dot`, copy = `${root}/copy`;
  put(`${dot}/skills/s1/SKILL.md`);
  mkdirSync(`${home}/.claude`, { recursive: true });
  symlinkSync(`${dot}/skills`, `${home}/.claude/skills`);
  symlinkSync("../dot-rel", `${home}/.claude/rel`);
  symlinkSync(`${dot}/gone`, `${home}/.claude/gone`);
  const r = copyAgentSettings(home, [".claude"], copy);
  expect({ links: r.links, targets: ["skills", "rel", "gone"].map((n) => readlinkSync(`${copy}/.claude/${n}`)) })
    .toEqual({ links: [], targets: [`${dot}/skills`, "../dot-rel", `${dot}/gone`] });
});

// Рецензия 9a, №3: PowerShell недоступен (PATH процесса без него), битый junction — копия не падает (как прежде)
test.skipIf(process.platform !== "win32")("A9: нет PowerShell в PATH, битый junction — copyAgentSettings не бросает", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "rv-a9-"))).replaceAll("\\", "/");
  const home = `${root}/home`, copy = `${root}/copy`;
  mkdirSync(`${home}/.claude`, { recursive: true });
  writeFileSync(`${home}/.claude/settings.json`, "{}");
  symlinkSync(`${root}/gone`, `${home}/.claude/gone`, "junction");
  const saved = process.env.PATH;
  let err = "";
  let res: unknown = null;
  try { process.env.PATH = `${root}/nothing`; res = copyAgentSettings(home, [".claude"], copy); }
  catch (e) { err = (e as Error).message; }
  finally { process.env.PATH = saved; }
  expect(err).toBe("");
});
