import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withTeamSkills } from "../src/teamskills";
import { codex, nativeMcp } from "../adapters/codex";
import { currentGlobal, currentProject } from "../adapters/codex/current";
import type { Machine, Resolved } from "../src/types";
import { apply, plan } from "../src/apply";
import { emptyState, sha } from "../src/manifest";

const temp = mkdtempSync(join(tmpdir(), "codex-test-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
function fixture() {
  const dir = mkdtempSync(join(temp, "case-"));
  const home = join(dir, "home");
  const project = join(dir, "project");
  for (const d of [join(home, ".codex"), join(project, ".codex"), join(dir, "skill/sub")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(dir, "a.md"), "# A\n");
  writeFileSync(join(dir, "skill/SKILL.md"), "---\nname: s\ndescription: Test skill\n---\n");
  writeFileSync(join(dir, "skill/sub/x.txt"), "resource\n");
  const machine: Machine = { home, workspace: dir, os: process.platform === "win32" ? "windows" : "linux", vars: {} };
  const cfg: Resolved = { layers: ["workspace"], instructions: [{ item: { file: "a.md", path: join(dir, "a.md") }, layer: "workspace" }],
    skills: [{ item: { name: "s", dir: join(dir, "skill") }, layer: "workspace" }],
    mcp: [{ item: { name: "ctx", command: "npx", args: ["x"] }, layer: "workspace" }], notes: [] };
  return { dir, home, project, machine, cfg };
}

describe("codex", () => {
  test("MCP: stdio, HTTP headers, skip, raw overrides", () => {
    expect(nativeMcp({ name: "s", command: "bin", env: { TOKEN: "value" } })).toEqual({ command: "bin", args: [], env: { TOKEN: "value" } });
    expect(nativeMcp({ name: "s", url: "https://example.com", headers: { Authorization: "Bearer test" } })).toEqual({ url: "https://example.com", http_headers: { Authorization: "Bearer test" } });
    expect(nativeMcp({ name: "s", command: "bin", agents: { codex: "skip" } })).toBeNull();
    expect(nativeMcp({ name: "s", command: "bin", agents: { codex: { raw: { args: ["custom"], startup_timeout_sec: 30 } } } })).toEqual({ command: "bin", args: ["custom"], startup_timeout_sec: 30 });
  });

  test("глобальные инструкции и вложенные ресурсы skills", () => {
    const { cfg, machine } = fixture();
    const r = codex.render(cfg, { scope: "global" }, machine);
    expect(r.files).toContainEqual(expect.objectContaining({ base: "home", path: ".codex/AGENTS.md", content: expect.stringContaining("Сгенерировано miksy") }));
    expect(r.files).toContainEqual({ base: "home", path: ".agents/skills/s/sub/x.txt", mode: "own", content: "resource\n" });
    expect(r.files).toContainEqual(expect.objectContaining({ base: "home", path: ".codex/config.toml", mode: "merge", format: "toml", key: ["mcp_servers"] }));
  });

  test("глобальный override: предупреждение вместо неработающего AGENTS.md", () => {
    const { cfg, machine, home } = fixture();
    writeFileSync(join(home, ".codex/AGENTS.override.md"), "manual override");
    const r = codex.render(cfg, { scope: "global" }, machine);
    expect(r.files.some((f) => f.path === ".codex/AGENTS.md")).toBe(false);
    expect(r.warnings.join("\n")).toContain("AGENTS.override.md");
  });

  test("проект: командные инструкции не заменяются", () => {
    const { cfg, machine, project } = fixture();
    writeFileSync(join(project, "AGENTS.md"), "team");
    const r = codex.render(cfg, { scope: "project", dir: project, rel: "project" }, machine);
    expect(r.files.some((f) => f.path.startsWith("AGENTS"))).toBe(false);
    expect(r.files).toContainEqual(expect.objectContaining({ base: "project", path: ".agents/skills/s/SKILL.md" }));
    expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toBe("team");
    const config = r.files.find((f) => f.path === ".codex/config.toml");
    expect(config?.mode).toBe("own");
    if (config?.mode !== "own") throw new Error("Missing project config");
    expect(Bun.TOML.parse(config.content)).toEqual({ developer_instructions: "# A", mcp_servers: { ctx: { command: "npx", args: ["x"] } } });
  });

  test("пустой конфиг ничего не создаёт", () => {
    const { machine } = fixture();
    expect(codex.render({ layers: [], instructions: [], skills: [], mcp: [], notes: [] }, { scope: "global" }, machine)).toEqual({ files: [], warnings: [] });
  });

  test("current: override, пустые файлы, TOML и отключённые MCP", () => {
    const { home } = fixture();
    writeFileSync(join(home, ".codex/AGENTS.md"), "@no-import\n");
    writeFileSync(join(home, ".codex/AGENTS.override.md"), "  \n");
    writeFileSync(join(home, ".codex/config.toml"), '[mcp_servers.on]\nurl="https://example.com"\n[mcp_servers.off]\ncommand="bin"\nenabled=false\n');
    const state = currentGlobal(home);
    expect(state.instructionFiles).toEqual([join(home, ".codex/AGENTS.md").replaceAll("\\", "/")]);
    expect(Object.keys(state.mcp)).toEqual(["on"]);
  });

  test("current: проектный TOML только при trust, fallback и knownDirs", () => {
    const { dir, home, project, machine } = fixture();
    writeFileSync(join(project, "TEAM.md"), "team fallback");
    writeFileSync(join(project, ".codex/config.toml"), 'project_doc_fallback_filenames=["TEAM.md"]\n[mcp_servers.local]\ncommand="bin"\n');
    expect(currentProject(project, home)).toEqual({ instructionFiles: [], mcp: {} });
    writeFileSync(join(home, ".codex/config.toml"), `[projects.${JSON.stringify(dir)}]\ntrust_level="trusted"\n`);
    expect(currentProject(project, home)).toEqual({ instructionFiles: [], mcp: {} });
    writeFileSync(join(home, ".codex/config.toml"), `[projects.${JSON.stringify(project)}]\ntrust_level="trusted"\n`);
    const state = currentProject(project, home);
    expect(state.instructionFiles[0]).toEndWith("/TEAM.md");
    expect(state.mcp.local.def.command).toBe("bin");
    expect(codex.knownDirs!(machine)).toEqual([project]);
  });

  test("tracked config: warning и отсутствие записи; untracked own: sync/exclude/clean", () => {
    const { cfg, machine, project } = fixture();
    expect(Bun.spawnSync(["git", "init", "--quiet", project]).exitCode).toBe(0);
    const target = { scope: "project" as const, dir: project, rel: "project" };
    const path = join(project, ".codex/config.toml");
    writeFileSync(path, 'developer_instructions="team"\n');
    expect(Bun.spawnSync(["git", "-C", project, "add", "--", ".codex/config.toml"]).exitCode).toBe(0);
    const skipped = codex.render(cfg, target, machine);
    expect(skipped.files.some((f) => f.path === ".codex/config.toml")).toBe(false);
    expect(skipped.warnings.join("\n")).toContain("отслеживается git");
    expect(Bun.spawnSync(["git", "-C", project, "rm", "--cached", "--", ".codex/config.toml"]).exitCode).toBe(0);
    const wanted = codex.render(cfg, target, machine);
    expect(plan(wanted, target, machine, emptyState(), false).some((a) => a.kind === "conflict")).toBe(true);
    rmSync(path);
    const { state } = apply(plan(wanted, target, machine, emptyState(), false), emptyState());
    expect(Bun.TOML.parse(readFileSync(path, "utf8")).developer_instructions).toBe("# A");
    expect(readFileSync(join(project, ".git/info/exclude"), "utf8")).toContain("/.codex/config.toml");
    expect(plan(wanted, target, machine, state, false)).toEqual([]);
    const { state: cleaned } = apply(plan({ files: [], warnings: [] }, target, machine, state, false), state);
    expect(cleaned).toEqual(emptyState());
  });

  test("tracked skill защищён от sync --force и clean", () => {
    const { cfg, machine, project } = fixture();
    expect(Bun.spawnSync(["git", "init", "--quiet", project]).exitCode).toBe(0);
    const path = ".agents/skills/s/SKILL.md";
    mkdirSync(join(project, ".agents/skills/s"), { recursive: true });
    writeFileSync(join(project, path), "team skill");
    expect(Bun.spawnSync(["git", "-C", project, "add", "--", path]).exitCode).toBe(0);
    const target = { scope: "project" as const, dir: project, rel: "project" };
    const result = codex.render(cfg, target, machine);
    const actions = plan(result, target, machine, emptyState(), true);
    expect(actions.some((a) => a.kind === "write" && a.abs.endsWith(".codex/skills/s/SKILL.md"))).toBe(true);
    expect(actions.some((a) => a.kind === "write" && a.abs.endsWith(path))).toBe(false);
    const state = emptyState();
    state.files[join(project, path).replaceAll("\\", "/")] = sha("team skill");
    const clean = plan({ files: [], warnings: [] }, target, machine, state, true);
    expect(clean.some((a) => a.kind === "delete")).toBe(false);
    expect(clean.some((a) => a.kind === "conflict")).toBe(true);
  });

  test("worktree: project config получает рабочий git exclude", () => {
    const { cfg, machine, project, dir } = fixture();
    const run = (...args: string[]) => {
      const r = Bun.spawnSync(["git", "-C", project, ...args], { stderr: "pipe" });
      if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    };
    run("init", "--quiet");
    run("-c", "user.name=Miksy Test", "-c", "user.email=miksy@example.invalid", "commit", "--allow-empty", "-m", "test");
    const worktree = join(dir, "worktree");
    run("worktree", "add", "--detach", worktree);
    const target = { scope: "project" as const, dir: worktree, rel: "worktree" };
    const generated = codex.render(cfg, target, machine);
    const actions = plan(generated, target, machine, emptyState(), false);
    expect(actions.some((a) => a.kind === "exclude")).toBe(true);
    apply(actions, emptyState());
    expect(Bun.spawnSync(["git", "-C", worktree, "check-ignore", "--quiet", ".codex/config.toml"]).exitCode).toBe(0);
  });
});


describe("codex: Skill.patch и бинарные ресурсы", () => {
  for (const scope of ["global", "project"] as const) {
    test(scope + ": patches override source including an empty binary replacement", () => {
      const { cfg, machine, project, dir } = fixture();
      const source = join(dir, "skill");
      const original = readFileSync(join(source, "SKILL.md"), "utf8");
      writeFileSync(join(source, "sub/empty.bin"), Buffer.from([0, 1, 2]));
      writeFileSync(join(source, "sub/patched.bin"), Buffer.from([0, 3, 4]));
      cfg.skills[0].item.patch = {
        "SKILL.md": "---\nname: patched\ndescription: Corrected metadata\n---\n",
        "sub/x.txt": "patched resource",
        "sub/empty.bin": "",
        "sub/patched.bin": "text replacement",
      };
      const target = scope === "global" ? { scope } : { scope, dir: project, rel: "project" };
      const rendered = codex.render({ ...cfg, instructions: [], mcp: [] }, target, machine);
      for (const [rel, content] of Object.entries(cfg.skills[0].item.patch))
        expect(rendered.files).toContainEqual({ base: scope === "global" ? "home" : "project", path: ".agents/skills/s/" + rel, mode: "own", content });
      expect(rendered.warnings).toEqual([]);
      expect(readFileSync(join(source, "SKILL.md"), "utf8")).toBe(original);
      expect(readFileSync(join(source, "sub/empty.bin"))).toEqual(Buffer.from([0, 1, 2]));
    });
    test(scope + ": unpatched NUL files are skipped with a warning; text resources survive", () => {
      const { cfg, machine, project, dir } = fixture();
      writeFileSync(join(dir, "skill/sub/image.bin"), Buffer.from([65, 0, 66]));
      const target = scope === "global" ? { scope } : { scope, dir: project, rel: "project" };
      const rendered = codex.render({ ...cfg, instructions: [], mcp: [] }, target, machine);
      expect(rendered.files.some(f => f.path.endsWith("image.bin"))).toBe(false);
      expect(rendered.files).toContainEqual(expect.objectContaining({ path: ".agents/skills/s/sub/x.txt", content: "resource\n" }));
      expect(rendered.warnings).toEqual(["skill s: бинарный файл sub/image.bin пропущен (контракт передаёт только текст)"]);
    });
  }
});


test("codex team import: native legacy skills are not duplicated, patched names are rendered", () => {
  const { project, machine } = fixture();
  expect(Bun.spawnSync(["git", "init", "--quiet", project]).exitCode).toBe(0);
  for (const [path, name] of [[".codex/skills/seen", "seen"], [".agents/rename", "Other_Name"]]) {
    mkdirSync(join(project, path), { recursive: true });
    writeFileSync(join(project, path, "SKILL.md"), "---\nname: " + name + "\ndescription: Test skill\n---\n");
  }
  expect(Bun.spawnSync(["git", "-C", project, "add", "--", ".codex/skills", ".agents/rename"]).exitCode).toBe(0);
  expect(Bun.spawnSync(["git", "-C", project, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "team"]).exitCode).toBe(0);
  const base: Resolved = { layers: [], instructions: [], skills: [], mcp: [], notes: [], importSkills: { item: "all", layer: "test" } };
  const imported = withTeamSkills(base, project, "codex", { codex: codex.skillDirs! });
  expect(imported.cfg.skills.map(s => s.item.name)).toEqual(["other-name"]);
  const rendered = codex.render(imported.cfg, { scope: "project", dir: project, rel: "project" }, machine);
  expect(rendered.files).toContainEqual(expect.objectContaining({ path: ".agents/skills/other-name/SKILL.md", content: expect.stringContaining("name: other-name") }));
  expect(rendered.files.some(f => f.path.includes("/seen/"))).toBe(false);
  expect(readFileSync(join(project, ".agents/rename/SKILL.md"), "utf8")).toContain("name: Other_Name");
});
