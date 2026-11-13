// Выпуск 0.2.2, круг 8b, C2 (рецензия A №2 = B №1 проверки 8a): путь копии с «\», «/» или несколькими косыми в конце —
// тот же результат, что и без них. Было: Windows-команда отрезала первый знак каждого пути (~\codex\…, ~\claude\…),
// ничего не возвращала и давала $LASTEXITCODE 0
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyAgentSettings, restoreCommand } from "../src/setup";

const win = process.platform === "win32";
const tmp = () => mkdtempSync(join(tmpdir(), "rs8b-")).replaceAll("\\", "/");
const put = (p: string, s: string) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, s); };
const w = (p: string) => p.replaceAll("/", "\\");

function sandbox() {
  const t = tmp();
  const home = `${t}/home`;
  put(`${home}/.claude.json`, "keep");
  put(`${home}/.codex/config.toml`, "cfg");
  put(`${home}/.claude/settings.json`, "{}");
  const copy = `${t}/copy`;
  copyAgentSettings(home, [".claude.json", ".codex/config.toml", ".claude/settings.json"], copy);
  put(`${home}/.codex/config.toml`, "changed");
  put(`${home}/.claude/settings.json`, "changed");
  put(`${home}/.claude.json`, "now");
  return { home, copy };
}
const state = (home: string) => ({
  codex: readFileSync(`${home}/.codex/config.toml`, "utf8"),
  claude: readFileSync(`${home}/.claude/settings.json`, "utf8"),
  claudeJson: readFileSync(`${home}/.claude.json`, "utf8"),
  home: readdirSync(home).filter((x) => x !== "AppData").sort(), // AppData — кеш самого PowerShell
});
const want = { codex: "cfg", claude: "{}", claudeJson: "now", home: [".claude", ".claude.json", ".codex"] };

const ps = (cmd: string, home: string) => {
  const r = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", `${cmd}; Write-Output "после: $LASTEXITCODE"`],
    { env: { ...process.env, USERPROFILE: w(home) }, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString().trim() };
};
const sh = (cmd: string, home: string) => {
  const r = Bun.spawnSync(["sh", "-c", cmd], { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: (r.stdout.toString() + r.stderr.toString()).trim() };
};

// Как в README: человек вставляет путь своей копии сам — с косой (или косыми) в конце
for (const tail of ["", "\\", "/", "\\\\", "//", "\\/\\"])
  test.skipIf(!win)(`Windows: путь копии ${tail ? `с «${tail}» в конце` : "без косой (контроль)"} — всё вернулось на место, код 0`, () => {
    const s = sandbox();
    const r = ps(restoreCommand(`${w(s.copy)}${tail}`, "windows"), s.home);
    expect({ r, ...state(s.home), junk: ["codex", "claude", "claude.json"].filter((x) => existsSync(`${s.home}/${x}`)) })
      .toEqual({ r: { code: 0, out: "после: 0" }, ...want, junk: [] });
  }, 60000);

for (const tail of ["", "/", "//"])
  test.skipIf(win)(`macOS, Linux: путь копии ${tail ? `с «${tail}» в конце` : "без косой (контроль)"} — всё вернулось на место, код 0`, () => {
    const s = sandbox();
    const r = sh(restoreCommand(`${s.copy}${tail}`, "linux"), s.home);
    expect({ r, ...state(s.home) }).toEqual({ r: { code: 0, out: "" }, ...want });
  }, 60000);
