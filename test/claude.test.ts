import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claude, nativeMcp } from "../adapters/claude";
import { projectKeys } from "../adapters/claude/current";
import type { Machine, Resolved } from "../src/types";

import { canonical } from "../src/paths";
const root = canonical(mkdtempSync(join(tmpdir(), "claude-render-")));
const project = `${root}/ws/Proj`;
mkdirSync(project, { recursive: true });
mkdirSync(`${root}/home`);
const machine: Machine = { workspace: `${root}/ws`, os: process.platform === "win32" ? "windows" : "linux", home: `${root}/home`, vars: {} };

function fixture(): Resolved {
  const dir = mkdtempSync(join(tmpdir(), "miksy-"));
  writeFileSync(join(dir, "a.md"), "# A\n");
  mkdirSync(join(dir, "skill", "sub"), { recursive: true });
  writeFileSync(join(dir, "skill", "SKILL.md"), "---\nname: s\n---\n");
  writeFileSync(join(dir, "skill", "sub", "x.txt"), "x");
  return {
    layers: ["workspace", "org"],
    instructions: [{ item: { file: "a.md", path: join(dir, "a.md") }, layer: "workspace" }],
    skills: [{ item: { name: "s", dir: join(dir, "skill") }, layer: "org" }],
    mcp: [
      { item: { name: "ctx", command: "npx", args: ["-y", "c"] }, layer: "workspace" },
      { item: { name: "gh", url: "https://x/mcp", headers: { Authorization: "Bearer t" } }, layer: "org" },
      { item: { name: "off", command: "x", agents: { claude: "skip" } }, layer: "org" },
    ],
    notes: [],
  };
}

describe("claude: MCP", () => {
  test("stdio и http в нативный формат", () => {
    expect(nativeMcp({ name: "a", command: "npx", args: ["x"], env: { K: "v" } })).toEqual({ type: "stdio", command: "npx", args: ["x"], env: { K: "v" } });
    expect(nativeMcp({ name: "b", url: "u", headers: { H: "1" } })).toEqual({ type: "http", url: "u", headers: { H: "1" } });
  });

  test("skip и raw", () => {
    expect(nativeMcp({ name: "a", command: "x", agents: { claude: "skip" } })).toBeNull();
    expect(nativeMcp({ name: "a", command: "x", agents: { claude: { raw: { timeout: 5 } } } })).toMatchObject({ command: "x", timeout: 5 });
  });

  test("ключи проекта: канонический + существующие написания того же каталога", () => {
    const upper = project.toUpperCase();
    const variants = [project + "/", ...(existsSync(upper) ? [upper] : [])];
    expect(projectKeys(project, machine.os, [...variants, project + "-other"]))
      .toEqual({ canonical: project, variants });
  });
});

describe("claude: render", () => {
  test("проект: CLAUDE.local.md, skills в проекте, MCP в local scope", () => {
    const r = claude.render(fixture(), { scope: "project", dir: project, rel: "x" }, machine);
    const paths = r.files.map((f) => `${f.base}:${f.path}`);
    expect(paths).toContain("project:CLAUDE.local.md");
    expect(paths).toContain("project:.claude/skills/s/SKILL.md");
    expect(paths).toContain("project:.claude/skills/s/sub/x.txt");
    const merges = r.files.filter((f) => f.mode === "merge");
    expect(merges.map((f) => f.mode === "merge" && f.key)).toEqual([["projects", project, "mcpServers"]]);
    expect(Object.keys((merges[0] as { data: object }).data)).toEqual(["ctx", "gh"]);
    expect(r.warnings).toEqual(["mcp off: для claude указан skip", expect.stringContaining(`Claude ещё не открывал ${project}`)]);
  });

  test("глобально: ~/.claude/CLAUDE.md с шапкой и user scope", () => {
    const r = claude.render(fixture(), { scope: "global" }, machine);
    const md = r.files.find((f) => f.path === ".claude/CLAUDE.md");
    expect(md?.mode === "own" && md.content.startsWith("<!-- Сгенерировано miksy (слои: workspace → org)")).toBe(true);
    expect(r.files.filter((f) => f.mode === "merge").map((f) => f.mode === "merge" && f.key)).toEqual([["mcpServers"]]);
  });
});
