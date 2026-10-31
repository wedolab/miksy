import { canonical } from "../src/paths";
// Чей файл — по учёту, а не по метке в содержимом; удаление и слияние одного пути в одном плане запрещены
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opencode } from "../adapters/opencode";
import type { RenderResult, Target } from "../src/adapter";
import { apply, plan } from "../src/apply";
import { emptyState, sha, type TargetState } from "../src/manifest";
import type { Machine, Resolved } from "../src/types";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "own-")).replaceAll("\\", "/");
  const project = `${dir}/p`;
  mkdirSync(`${project}/.git/info`, { recursive: true });
  mkdirSync(`${dir}/home`);
  const machine: Machine = { workspace: dir, os: "linux", home: `${dir}/home`, vars: {} };
  const target: Target = { scope: "project", dir: project, rel: "p" };
  const cfg: Resolved = { layers: ["w"], instructions: [], skills: [], mcp: [{ item: { name: "ctx", url: "https://ctx" }, layer: "w" }], notes: [] };
  return { project, machine, target, cfg };
}

const sync = (f: ReturnType<typeof fixture>, prev: TargetState) => {
  const r = opencode.render(f.cfg, f.target, f.machine, { ownedFiles: Object.keys(prev.files) });
  return plan(r, f.target, f.machine, prev, false, "opencode");
};

describe("opencode: own или merge — по учёту", () => {
  test("свой opencode.json без метки instructions: повторный sync ничего не меняет (не {\"mcp\":{}})", () => {
    const f = fixture();
    const { state } = apply(sync(f, emptyState()), emptyState());
    const before = readFileSync(`${f.project}/opencode.json`, "utf8");
    const again = sync(f, state);
    expect(again.filter((a) => a.kind !== "exclude")).toEqual([]);
    apply(again, state);
    expect(readFileSync(`${f.project}/opencode.json`, "utf8")).toBe(before);
    expect(JSON.parse(before).mcp.ctx.url).toBe("https://ctx");
  });

  test("файл с меткой miksy, но не из учёта — чужой: только merge поимённо", () => {
    const f = fixture();
    writeFileSync(`${f.project}/opencode.json`, JSON.stringify({ instructions: [".opencode/miksy.md"], mcp: { team: { url: "t" } } }));
    const r = opencode.render(f.cfg, f.target, f.machine, { ownedFiles: [] });
    expect(r.files.find((x) => x.path === "opencode.json")?.mode).toBe("merge");
  });

  test("файл из учёта — свой, даже если метку убрали", () => {
    const f = fixture();
    writeFileSync(`${f.project}/opencode.json`, JSON.stringify({ mcp: {} }));
    const r = opencode.render(f.cfg, f.target, f.machine, { ownedFiles: [`${f.project}/opencode.json`] });
    expect(r.files.find((x) => x.path === "opencode.json")?.mode).toBe("own");
  });
});

describe("план: удаление и слияние одного пути", () => {
  test("путь из учёта, который теперь сливается, — конфликт, файл не удалён и не перезаписан", () => {
    const f = fixture();
    const path = `${f.project}/opencode.json`;
    const text = JSON.stringify({ $schema: "x", mcp: { ctx: { url: "https://ctx" } } });
    writeFileSync(path, text);
    const prev = { ...emptyState(), files: { [path]: sha(text) } };
    const r: RenderResult = { warnings: [], files: [{ base: "project", path: "opencode.json", mode: "merge", format: "json", key: ["mcp"], data: { ctx: { url: "https://ctx" } } }] };
    const actions = plan(r, f.target, f.machine, prev, true, "opencode");
    expect(actions.some((a) => a.kind === "delete" || a.kind === "merge")).toBe(false);
    expect(actions.find((a) => a.abs === canonical(path))).toMatchObject({ kind: "conflict" });
    apply(actions, prev);
    expect(readFileSync(path, "utf8")).toBe(text);
  });
});
