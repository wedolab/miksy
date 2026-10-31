// Импорт командных skills: только то, что закоммичено в git; ссылки наружу не разыменовываются
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { claude } from "../adapters/claude";
import { withTeamSkills } from "../src/teamskills";
import type { Resolved } from "../src/types";

const skill = (name: string) => `---\nname: ${name}\ndescription: Team skill\n---\nBody\n`;
const base: Resolved = { layers: ["l"], instructions: [], skills: [], mcp: [], notes: [], importSkills: { item: "all", layer: "l" } };

const git = (dir: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...args], { stdout: "pipe", stderr: "pipe", stdin: "pipe" });
  return r.stdout.toString().trim();
};
const put = (path: string, content: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};
// Симлинк в git независимо от поддержки симлинков ФС: blob с путём и режим 120000
const gitLink = (dir: string, path: string, to: string) => {
  const blob = Bun.spawnSync(["git", "-C", dir, "hash-object", "-w", "--stdin"], { stdin: Buffer.from(to), stdout: "pipe" }).stdout.toString().trim();
  git(dir, "update-index", "--add", "--cacheinfo", `120000,${blob},${path}`);
};

function project() {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "team-import-"))).replaceAll("\\", "/");
  git(dir, "init", "--quiet");
  return dir;
}

// Что получит claude: путь в skill → содержимое
function delivered(dir: string) {
  const { cfg, warnings } = withTeamSkills(base, dir, "claude");
  const r = claude.render(cfg, { scope: "project", dir, rel: "p" }, { workspace: dir, os: "linux", home: dir, vars: {} });
  return {
    files: Object.fromEntries(r.files.filter((f) => f.mode === "own").map((f) => [f.path, (f as { content: string }).content])),
    warnings: [...warnings, ...r.warnings].join("\n"),
  };
}

describe("импорт командных skills: только git", () => {
  test("неотслеживаемые и игнорируемые файлы (.env) не копируются", () => {
    const dir = project();
    put(`${dir}/.agents/skills/x/SKILL.md`, skill("x"));
    put(`${dir}/.gitignore`, ".env\n");
    git(dir, "add", ".");
    git(dir, "commit", "--quiet", "-m", "x");
    put(`${dir}/.agents/skills/x/.env`, "TOKEN=secret");
    put(`${dir}/.agents/skills/x/notes.txt`, "untracked");
    const d = delivered(dir);
    expect(d.files[".claude/skills/x/SKILL.md"]).toContain("name: x");
    expect(Object.keys(d.files).some((p) => p.endsWith(".env") || p.endsWith("notes.txt"))).toBe(false);
  });

  test("незакоммиченная правка не доставляется — берётся закоммиченная версия", () => {
    const dir = project();
    put(`${dir}/.agents/skills/x/SKILL.md`, skill("x"));
    put(`${dir}/.agents/skills/x/run.sh`, "echo committed\n");
    git(dir, "add", ".");
    git(dir, "commit", "--quiet", "-m", "x");
    put(`${dir}/.agents/skills/x/run.sh`, "echo local edit\n");
    git(dir, "add", ".agents/skills/x/run.sh"); // даже в индексе — ещё не закоммичено
    expect(delivered(dir).files[".claude/skills/x/run.sh"]).toBe("echo committed\n");
  });

  test("симлинк внутри skill на файл вне репо не разыменовывается", () => {
    const dir = project();
    const outside = mkdtempSync(join(tmpdir(), "team-outside-")).replaceAll("\\", "/");
    put(`${outside}/id_rsa`, "PRIVATE KEY");
    put(`${dir}/.agents/skills/x/SKILL.md`, skill("x"));
    git(dir, "add", ".");
    gitLink(dir, ".agents/skills/x/key", `${outside}/id_rsa`);
    gitLink(dir, ".agents/skills/x/up", "../../../../etc/passwd");
    git(dir, "commit", "--quiet", "-m", "x");
    try {
      symlinkSync(`${outside}/id_rsa`, `${dir}/.agents/skills/x/key`, "file");
    } catch {}
    const d = delivered(dir);
    expect(Object.values(d.files).join()).not.toContain("PRIVATE KEY");
    expect(Object.keys(d.files).some((p) => p.endsWith("/key") || p.endsWith("/up"))).toBe(false);
    expect(d.warnings).toContain("за пределы");
  });

  test("каталог skill — симлинк внутри репо: доставляется из цели ссылки", () => {
    const dir = project();
    put(`${dir}/skills/x/SKILL.md`, skill("x"));
    git(dir, "add", ".");
    gitLink(dir, ".agents/skills/x", "../../skills/x");
    git(dir, "commit", "--quiet", "-m", "x");
    mkdirSync(`${dir}/.agents/skills`, { recursive: true });
    symlinkSync(`${dir}/skills/x`, `${dir}/.agents/skills/x`, "junction");
    expect(delivered(dir).files[".claude/skills/x/SKILL.md"]).toContain("name: x");
  });

  test("каталог skill — симлинк за пределы репо: не доставляется, предупреждение", () => {
    const dir = project();
    const outside = mkdtempSync(join(tmpdir(), "team-outside-")).replaceAll("\\", "/");
    put(`${outside}/x/SKILL.md`, skill("x"));
    put(`${dir}/README`, "r");
    git(dir, "add", ".");
    gitLink(dir, ".agents/skills/x", `${outside}/x`);
    git(dir, "commit", "--quiet", "-m", "x");
    mkdirSync(`${dir}/.agents/skills`, { recursive: true });
    symlinkSync(`${outside}/x`, `${dir}/.agents/skills/x`, "junction");
    const d = delivered(dir);
    expect(Object.keys(d.files)).toEqual([]);
    expect(d.warnings).toContain("за пределы");
  });
});

test("переводы строк — как в выгрузке git (core.autocrlf=true: CRLF), содержимое — из коммита", async () => {
  const { rmSync } = await import("node:fs");
  const dir = project();
  git(dir, "config", "core.autocrlf", "true");
  put(`${dir}/.agents/skills/x/SKILL.md`, skill("x"));
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "x");
  rmSync(`${dir}/.agents/skills/x/SKILL.md`);
  Bun.spawnSync(["git", "-C", dir, "checkout", "--", "."]); // без -c core.autocrlf=false из помощника
  const md = delivered(dir).files[".claude/skills/x/SKILL.md"];
  expect(md).toBe(skill("x").split("\n").join("\r\n"));
});

test("симлинк выше по пути (.claude/skills → ../.agents/skills) раскрывается по объектам git", async () => {
  const { committedSkill } = await import("../src/teamskills");
  const dir = project();
  put(`${dir}/.agents/skills/x/SKILL.md`, skill("x"));
  git(dir, "add", ".");
  gitLink(dir, ".claude/skills", "../.agents/skills");
  git(dir, "commit", "--quiet", "-m", "x");
  const warnings: string[] = [];
  const files = committedSkill(dir, ".claude/skills/x", (w) => warnings.push(w));
  expect(files?.map((f) => f.rel)).toEqual(["SKILL.md"]);
  expect(warnings).toEqual([]);
  gitLink(dir, ".gemini", "../../outside");
  git(dir, "commit", "--quiet", "-m", "y");
  expect(committedSkill(dir, ".gemini/skills/x", (w) => warnings.push(w))).toBeNull();
  expect(warnings.join()).toContain("за пределы");
});
