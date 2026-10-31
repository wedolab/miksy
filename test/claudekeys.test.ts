// Ключ проекта Claude в ~/.claude.json: Claude хранит путь «как открыли» (регистр, d:/D:, слэши,
// симлинк) — MCP пишутся во все существующие варианты пути каталога и в канонический
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claude } from "../adapters/claude";
import { apply, plan } from "../src/apply";
import { emptyState } from "../src/manifest";
import type { Machine, Resolved } from "../src/types";

const win = process.platform === "win32";
const cfg: Resolved = { layers: ["w"], instructions: [], skills: [], mcp: [{ item: { name: "ctx", url: "https://ctx" }, layer: "w" }], notes: [] };

function fixture(keys: (dirs: { proj: string; link: string; other: string }) => string[]) {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), "ckeys-"))).replaceAll("\\", "/");
  const home = `${d}/home`;
  const proj = `${d}/ws/Proj`;
  const other = `${d}/ws/other`;
  for (const x of [home, `${proj}/.git/info`, other]) mkdirSync(x, { recursive: true });
  const link = `${d}/link`;
  symlinkSync(proj, link, "junction");
  const projects = Object.fromEntries(keys({ proj, link, other }).map((k) => [k, { allowedTools: [] }]));
  writeFileSync(`${home}/.claude.json`, JSON.stringify({ projects }));
  const machine: Machine = { workspace: `${d}/ws`, os: win ? "windows" : "linux", home, vars: {} };
  return { proj, link, other, home, machine };
}

const keysOf = (r: ReturnType<typeof claude.render>) =>
  r.files.filter((f) => f.mode === "merge").map((f) => (f.mode === "merge" ? f.key[1] : "")).sort();

describe("claude: ключи проекта", () => {
  test("все существующие варианты пути каталога + канонический; чужие ключи не трогаются", () => {
    const f = fixture(({ proj, link, other }) => [
      link,
      other,
      ...(win ? [proj.toLowerCase(), proj.replaceAll("/", "\\"), proj[0].toLowerCase() + proj.slice(1)] : []),
    ]);
    const r = claude.render(cfg, { scope: "project", dir: f.proj, rel: "Proj" }, f.machine);
    const expected = [f.proj, f.link, ...(win ? [f.proj.toLowerCase(), f.proj.replaceAll("/", "\\"), f.proj[0].toLowerCase() + f.proj.slice(1)] : [])];
    expect(keysOf(r)).toEqual([...new Set(expected)].sort());
    expect(keysOf(r)).not.toContain(f.other);
    expect(r.warnings.join()).not.toContain("не открывал");

    const { state } = apply(plan(r, { scope: "project", dir: f.proj, rel: "Proj" }, f.machine, emptyState(), false), emptyState());
    const doc = JSON.parse(readFileSync(`${f.home}/.claude.json`, "utf8"));
    for (const k of expected) expect(doc.projects[k].mcpServers).toEqual({ ctx: { type: "http", url: "https://ctx" } });
    expect(doc.projects[f.other].mcpServers).toBeUndefined();
    expect(Object.keys(state.merges[`${f.home}/.claude.json`]).length).toBe(new Set(expected).size);
  });

  test("ни одного варианта — канонический ключ и предупреждение", () => {
    const f = fixture(({ other }) => [other]);
    const r = claude.render(cfg, { scope: "project", dir: f.proj, rel: "Proj" }, f.machine);
    expect(keysOf(r)).toEqual([f.proj]);
    expect(r.files.find((x) => x.mode === "merge")).not.toHaveProperty("optional", true);
    expect(r.warnings.join()).toContain("не открывал");
  });
});
