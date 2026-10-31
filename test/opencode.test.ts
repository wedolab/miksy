import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { opencode, nativeMcp } from "../adapters/opencode";
import { currentGlobal, currentProject, readJsonc } from "../adapters/opencode/current";
import type { Machine, Resolved } from "../src/types";
import { plan } from "../src/apply";
import { emptyState } from "../src/manifest";

const temp = mkdtempSync(join(tmpdir(), "opencode-test-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
function fixture() {
  const dir = mkdtempSync(join(temp, "case-"));
  const home = join(dir, "home");
  const project = join(dir, "project");
  for (const d of [join(home, ".config", "opencode"), join(project, ".opencode"), join(dir, "skill", "sub")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(dir, "a.md"), "# A\n");
  writeFileSync(join(dir, "skill", "SKILL.md"), "---\nname: s\ndescription: Test skill\n---\n");
  writeFileSync(join(dir, "skill", "sub", "x.txt"), "resource\n");
  const machine: Machine = { home, workspace: dir, os: process.platform === "win32" ? "windows" : "linux", vars: {} };
  const cfg: Resolved = { layers: ["workspace"], instructions: [{ item: { file: "a.md", path: join(dir, "a.md") }, layer: "workspace" }],
    skills: [{ item: { name: "s", dir: join(dir, "skill") }, layer: "workspace" }],
    mcp: [{ item: { name: "ctx", command: "npx", args: ["x"], env: { TOKEN: "v" } }, layer: "workspace" }], notes: [] };
  return { dir, home, project, machine, cfg };
}

describe("opencode", () => {
  test("MCP: local с массивом command и environment, remote с headers, skip, raw", () => {
    expect(nativeMcp({ name: "s", command: "bin", args: ["-y", "p"], env: { TOKEN: "v" } })).toEqual({ type: "local", command: ["bin", "-y", "p"], environment: { TOKEN: "v" } });
    expect(nativeMcp({ name: "s", url: "https://example.com", headers: { Authorization: "Bearer t" } })).toEqual({ type: "remote", url: "https://example.com", headers: { Authorization: "Bearer t" } });
    expect(nativeMcp({ name: "s", command: "bin", agents: { opencode: "skip" } })).toBeNull();
    expect(nativeMcp({ name: "s", command: "bin", agents: { opencode: { raw: { enabled: false } } } })).toEqual({ type: "local", command: ["bin"], enabled: false });
  });

  test("глобально: AGENTS.md, skills, merge mcp в новый opencode.json", () => {
    const { cfg, machine } = fixture();
    const r = opencode.render(cfg, { scope: "global" }, machine);
    expect(r.files).toContainEqual(expect.objectContaining({ base: "home", path: ".config/opencode/AGENTS.md", content: expect.stringContaining("Сгенерировано miksy") }));
    expect(r.files).toContainEqual({ base: "home", path: ".config/opencode/skills/s/sub/x.txt", mode: "own", content: "resource\n" });
    expect(r.files).toContainEqual({ base: "home", path: ".config/opencode/opencode.json", mode: "merge", format: "json", key: ["mcp"], data: { ctx: { type: "local", command: ["npx", "x"], environment: { TOKEN: "v" } } } });
    expect(r.warnings).toEqual([]);
  });

  test("глобально: существующий чистый opencode.jsonc — merge в него; инструкции в нём — предупреждение", () => {
    const { cfg, machine, home } = fixture();
    writeFileSync(join(home, ".config", "opencode", "opencode.jsonc"), JSON.stringify({ instructions: ["~/extra.md"] }));
    const r = opencode.render(cfg, { scope: "global" }, machine);
    expect(r.files).toContainEqual(expect.objectContaining({ base: "home", path: ".config/opencode/opencode.jsonc", mode: "merge", key: ["mcp"] }));
    expect(r.warnings.join("\n")).toContain("instructions");
  });

  test("глобально: JSONC-комментарии и дублирующий skill — предупреждения, mcp не записан", () => {
    const { cfg, machine, home } = fixture();
    writeFileSync(join(home, ".config", "opencode", "opencode.json"), '{\n  // мой конфиг\n  "model": "x",\n}\n');
    mkdirSync(join(home, ".claude", "skills", "s"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "s", "SKILL.md"), "dup\n");
    const r = opencode.render(cfg, { scope: "global" }, machine);
    expect(r.files.some((f) => f.mode === "merge")).toBe(false);
    expect(r.warnings.join("\n")).toContain("строгий JSON");
    expect(r.warnings.join("\n")).toContain("duplicate skill name");
  });

  test("проект без конфига: miksy.md (own) + собственный opencode.json c instructions и mcp", () => {
    const { cfg, machine, project } = fixture();
    const r = opencode.render(cfg, { scope: "project", dir: project, rel: "project" }, machine);
    expect(r.warnings).toEqual([]);
    expect(r.files.some((f) => f.path.startsWith("AGENTS"))).toBe(false);
    expect(r.files).toContainEqual({ base: "project", path: ".opencode/miksy.md", mode: "own", content: expect.stringContaining("Сгенерировано miksy") });
    expect(r.files).toContainEqual({
      base: "project", path: "opencode.json", mode: "own", mcp: { format: "json", key: "mcp" },
      content: JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        instructions: [".opencode/miksy.md"],
        mcp: { ctx: { type: "local", command: ["npx", "x"], environment: { TOKEN: "v" } } },
      }, null, 2) + "\n",
    });
    expect(r.files).toContainEqual(expect.objectContaining({ base: "project", path: ".opencode/skills/s/SKILL.md" }));
  });

  test("проект: только mcp без инструкций — собственный opencode.json без instructions", () => {
    const { cfg, machine, project } = fixture();
    const r = opencode.render({ ...cfg, instructions: [] }, { scope: "project", dir: project, rel: "project" }, machine);
    expect(r.files).toContainEqual({
      base: "project", path: "opencode.json", mode: "own", mcp: { format: "json", key: "mcp" },
      content: JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp: { ctx: { type: "local", command: ["npx", "x"], environment: { TOKEN: "v" } } } }, null, 2) + "\n",
    });
    expect(r.files.some((f) => f.path === ".opencode/miksy.md")).toBe(false);
  });

  test("проект: наш opencode.json (в учёте miksy) — обновляется как own", () => {
    const { cfg, machine, project } = fixture();
    writeFileSync(join(project, "opencode.json"), JSON.stringify({ $schema: "x", instructions: [".opencode/miksy.md"], mcp: { old: { type: "local", command: ["o"] } } }));
    const r = opencode.render(cfg, { scope: "project", dir: project, rel: "project" }, machine, { ownedFiles: [join(project, "opencode.json").replaceAll("\\", "/")] });
    const own = r.files.find((f) => f.path === "opencode.json");
    expect(own?.mode).toBe("own");
    expect(JSON.parse(own!.content).mcp).toEqual({ ctx: { type: "local", command: ["npx", "x"], environment: { TOKEN: "v" } } });
    expect(r.warnings).toEqual([]);
  });

  test("проект: чужой opencode.json — инструкции не записаны, mcp merge поимённо", () => {
    const { cfg, machine, project } = fixture();
    writeFileSync(join(project, "opencode.json"), JSON.stringify({ instructions: ["TEAM.md"], mcp: { team: { type: "remote", url: "https://t.com" } } }));
    const r = opencode.render(cfg, { scope: "project", dir: project, rel: "project" }, machine);
    expect(r.warnings.join("\n")).toContain("не от miksy");
    expect(r.files.some((f) => f.path === ".opencode/miksy.md")).toBe(false);
    expect(r.files).toContainEqual(expect.objectContaining({ base: "project", path: "opencode.json", mode: "merge", key: ["mcp"] }));
  });

  test("проект: командный .opencode/opencode.json, корень свободен — свой корневой opencode.json (own)", () => {
    const { cfg, machine, project } = fixture();
    writeFileSync(join(project, ".opencode", "opencode.json"), JSON.stringify({ mcp: { team: { type: "remote", url: "https://t.com" } } }));
    const r = opencode.render(cfg, { scope: "project", dir: project, rel: "project" }, machine);
    expect(r.warnings.join("\n")).toContain(".opencode/opencode.json тоже загрузится");
    const own = r.files.find((f) => f.path === "opencode.json");
    expect(own?.mode).toBe("own");
    expect(JSON.parse(own!.content).instructions).toEqual([".opencode/miksy.md"]);
    expect(r.files.some((f) => f.path === ".opencode/miksy.md")).toBe(true);
    expect(r.files.some((f) => f.path === ".opencode/opencode.json" && f.mode === "merge")).toBe(false);
  });

  test("skills: patch подменяет файл, бинарник без patch пропускается", () => {
    const { machine, dir } = fixture();
    writeFileSync(join(dir, "skill", "bin.dat"), Buffer.from([0, 1, 2, 255]));
    const cfg = {
      layers: ["l"], instructions: [], notes: [],
      mcp: [],
      skills: [{ item: { name: "s", dir: join(dir, "skill"), patch: { "SKILL.md": "---\nname: s\ndescription: fixed\n---\n" } }, layer: "l" }],
    } as const;
    const r = opencode.render(cfg, { scope: "global" }, machine);
    expect(r.files.find((f) => f.path === ".config/opencode/skills/s/SKILL.md")!.content).toContain("fixed");
    expect(r.files.some((f) => f.path.endsWith("bin.dat"))).toBe(false);
    expect(r.warnings.join("\n")).toContain("бинарный файл bin.dat пропущен");
  });

  test("skillDirs объявлен по живой проверке", () => {
    expect(opencode.skillDirs).toEqual([".agents/skills", ".claude/skills", ".opencode/skills", ".opencode/skill"]);
  });

  test("отслеживаемый opencode.json проекта — конфликт, ключи не сливаются", () => {
    const { cfg, machine, project } = fixture();
    expect(Bun.spawnSync(["git", "init", "--quiet", project]).exitCode).toBe(0);
    writeFileSync(join(project, "opencode.json"), JSON.stringify({ mcp: { team: { type: "remote", url: "https://t.com" } } }));
    expect(Bun.spawnSync(["git", "-C", project, "add", "--", "opencode.json"]).exitCode).toBe(0);
    const target = { scope: "project" as const, dir: project, rel: "project" };
    const actions = plan(opencode.render(cfg, target, machine), target, machine, emptyState(), true);
    expect(actions.some((a) => a.kind === "conflict" && a.abs.endsWith("opencode.json"))).toBe(true);
    expect(actions.some((a) => a.kind === "merge")).toBe(false);
  });

  test("пустой конфиг ничего не создаёт", () => {
    const { machine } = fixture();
    expect(opencode.render({ layers: [], instructions: [], skills: [], mcp: [], notes: [] }, { scope: "global" }, machine)).toEqual({ files: [], warnings: [] });
  });

  test("current: AGENTS.md приоритетнее CLAUDE-фолбэка, instructions из конфига, enabled:false", () => {
    const { home } = fixture();
    const cfgDir = join(home, ".config", "opencode");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "claude fallback\n");
    writeFileSync(join(home, "extra.md"), "extra\n");
    writeFileSync(join(cfgDir, "opencode.jsonc"), JSON.stringify({ instructions: ["~/extra.md"], mcp: { on: { type: "remote", url: "https://e.com" }, off: { type: "local", command: ["x"], enabled: false } } }));
    const fallback = currentGlobal(home);
    expect(fallback.instructionFiles).toEqual([join(home, ".claude", "CLAUDE.md").replaceAll("\\", "/"), join(home, "extra.md").replaceAll("\\", "/")]);
    expect(Object.keys(fallback.mcp)).toEqual(["on"]);
    writeFileSync(join(cfgDir, "AGENTS.md"), "# личные правила\n");
    const state = currentGlobal(home);
    expect(state.instructionFiles[0]).toEndWith(".config/opencode/AGENTS.md");
  });

  test("current: проект — AGENTS.md из корня, mcp из конфига проекта", () => {
    const { home, project } = fixture();
    writeFileSync(join(project, "AGENTS.md"), "team\n");
    writeFileSync(join(project, "opencode.json"), JSON.stringify({ mcp: { local: { type: "local", command: ["bin"] } } }));
    const state = currentProject(project, home);
    expect(state.instructionFiles).toEqual([join(project, "AGENTS.md").replaceAll("\\", "/")]);
    expect(state.mcp.local.def.command).toEqual(["bin"]);
  });

  test("readJsonc: комментарии, концевые запятые, URL в строках", () => {
    const { dir } = fixture();
    const p = join(dir, "oc.jsonc");
    writeFileSync(p, `{\n  // комментарий\n  "url": "https://e.com/x", /* блок */\n  "list": [1, 2,],\n}\n`);
    expect(readJsonc(p)).toEqual({ url: "https://e.com/x", list: [1, 2] });
  });

  test("knownDirs: каталоги из лога запусков", () => {
    const { home, machine } = fixture();
    const log = join(home, ".local", "share", "opencode", "log");
    mkdirSync(log, { recursive: true });
    writeFileSync(join(log, "opencode.log"), `timestamp=x level=INFO run=1 message="creating instance" directory="D:\\\\work\\\\Org"\ntimestamp=x level=INFO run=2 message="creating instance" directory="D:\\\\work\\\\Org"\n`);
    expect(opencode.knownDirs!(machine)).toEqual(["D:/work/Org"]);
  });
});
