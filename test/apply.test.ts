import { canonical } from "../src/paths";
import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RenderResult, Target } from "../src/adapter";
import { apply, plan, verifyMerges } from "../src/apply";
import { emptyState } from "../src/manifest";

let home: string;
let proj: string;
let target: Target;
const machine = () => ({ workspace: "/ws", os: "linux" as const, home, vars: {} });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "h-home-")).replaceAll("\\", "/");
  proj = mkdtempSync(join(tmpdir(), "h-proj-")).replaceAll("\\", "/");
  mkdirSync(join(proj, ".git", "info"), { recursive: true });
  writeFileSync(join(proj, ".git", "info", "exclude"), "# git default\n*.log\n");
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects: { [proj]: { allowedTools: ["x"], mcpServers: { mine: { url: "m" } } } } }));
  target = { scope: "project", dir: proj, rel: "p" };
});

const result = (servers: Record<string, unknown>, md = "hello\n"): RenderResult => ({
  warnings: [],
  files: [
    { base: "project", path: "CLAUDE.local.md", mode: "own", content: md },
    { base: "home", path: ".claude.json", mode: "merge", format: "json", key: ["projects", proj, "mcpServers"], data: servers },
  ],
});
const cfg = () => JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));

describe("sync", () => {
  test("первый sync: пишет файл, сливает ключи, не трогает чужое, exclude", () => {
    const actions = plan(result({ ctx: { url: "c" } }), target, machine(), emptyState(), false);
    const { state } = apply(actions, emptyState());
    expect(readFileSync(join(proj, "CLAUDE.local.md"), "utf8")).toBe("hello\n");
    expect(cfg().projects[proj]).toEqual({ allowedTools: ["x"], mcpServers: { mine: { url: "m" }, ctx: { url: "c" } } });
    const ex = readFileSync(join(proj, ".git", "info", "exclude"), "utf8");
    expect(ex).toContain("*.log");
    expect(ex).toContain("/CLAUDE.local.md");
    expect(verifyMerges(state)).toEqual([]);
  });

  test("повторный sync без изменений — пустой план", () => {
    const { state } = apply(plan(result({ ctx: { url: "c" } }), target, machine(), emptyState(), false), emptyState());
    expect(plan(result({ ctx: { url: "c" } }), target, machine(), state, false)).toEqual([]);
  });

  test("чужой ключ с тем же именем: разный — конфликт, одинаковый — под учёт", () => {
    const diff = plan(result({ mine: { url: "other" } }), target, machine(), emptyState(), false);
    expect(diff.some((a) => a.kind === "conflict")).toBe(true);
    const same = plan(result({ mine: { url: "m" } }), target, machine(), emptyState(), false);
    expect(same.find((a) => a.kind === "merge")).toMatchObject({ adopt: ["mine"], set: {} });
  });

  test("ручная правка нашего файла — конфликт, без --force не перезаписывается", () => {
    const { state } = apply(plan(result({}), target, machine(), emptyState(), false), emptyState());
    writeFileSync(join(proj, "CLAUDE.local.md"), "edited by hand\n");
    const actions = plan(result({}, "new\n"), target, machine(), state, false);
    expect(actions).toEqual([expect.objectContaining({ kind: "conflict" })]);
    apply(actions, state);
    expect(readFileSync(join(proj, "CLAUDE.local.md"), "utf8")).toBe("edited by hand\n");
  });

  test("существующий чужой файл не перезаписывается", () => {
    writeFileSync(join(proj, "CLAUDE.local.md"), "user's own\n");
    const actions = plan(result({}), target, machine(), emptyState(), false);
    expect(actions[0]).toMatchObject({ kind: "conflict" });
  });

  test("clean: убирает только своё", () => {
    const { state } = apply(plan(result({ ctx: { url: "c" } }), target, machine(), emptyState(), false), emptyState());
    const { state: after } = apply(plan({ files: [], warnings: [] }, target, machine(), state, false), state);
    expect(existsSync(join(proj, "CLAUDE.local.md"))).toBe(false);
    expect(cfg().projects[proj]).toEqual({ allowedTools: ["x"], mcpServers: { mine: { url: "m" } } });
    const ex = readFileSync(join(proj, ".git", "info", "exclude"), "utf8");
    expect(ex).not.toContain("miksy");
    expect(ex).toContain("*.log");
    expect(after).toEqual(emptyState());
  });

  test("exclude: у каждого агента свой блок", () => {
    const exPath = join(proj, ".git", "info", "exclude");
    writeFileSync(exPath, "*.log\n");
    const own = (path: string): RenderResult => ({ warnings: [], files: [{ base: "project", path, mode: "own", content: "x" }] });
    const { state: a } = apply(plan(own("A.md"), target, machine(), emptyState(), false, "claude"), emptyState());
    apply(plan(own("B.md"), target, machine(), emptyState(), false, "codex"), emptyState());
    const ex = readFileSync(exPath, "utf8");
    expect(ex).toContain("*.log");
    expect(ex).toContain("# >>> miksy:claude");
    expect(ex).toContain("/A.md");
    expect(ex).toContain("/B.md");
    // повторный sync claude ничего не меняет, clean claude не трогает блок codex
    expect(plan(own("A.md"), target, machine(), a, false, "claude").filter((x) => x.kind === "exclude")).toEqual([]);
    apply(plan({ files: [], warnings: [] }, target, machine(), a, false, "claude"), a);
    const after = readFileSync(exPath, "utf8");
    expect(after).not.toContain("/A.md");
    expect(after).toContain("/B.md");
  });

  test("путь, занятый файлом (симлинк команды как файл), — конфликт, а не падение", () => {
    mkdirSync(join(proj, ".claude", "skills"), { recursive: true });
    writeFileSync(join(proj, ".claude", "skills", "taken"), "../elsewhere/taken");
    const r: RenderResult = { warnings: [], files: [{ base: "project", path: ".claude/skills/taken/SKILL.md", mode: "own", content: "x" }] };
    const actions = plan(r, target, machine(), emptyState(), true);
    expect(actions[0]).toMatchObject({ kind: "conflict" });
    expect(actions.some((a) => a.kind === "write")).toBe(false);
  });

  test("ошибка посреди apply: выполненное попадает в учёт", () => {
    const ok = join(proj, "ok.md").replaceAll("\\", "/");
    const bad = join(proj, "file-not-dir", "x.md").replaceAll("\\", "/");
    writeFileSync(join(proj, "file-not-dir"), "occupied");
    try {
      apply([{ kind: "write", abs: ok, content: "a", why: "новый" }, { kind: "write", abs: bad, content: "b", why: "новый" }], emptyState());
      throw new Error("должна быть ошибка");
    } catch (e) {
      expect(Object.keys((e as { partialState: { files: object } }).partialState.files)).toEqual([canonical(ok)]);
    }
  });

  test("optional-ключ без родителя не создаётся", () => {
    const r: RenderResult = { warnings: [], files: [{ base: "home", path: ".claude.json", mode: "merge", format: "json", key: ["projects", "nope", "mcpServers"], data: { a: 1 }, optional: true }] };
    expect(plan(r, target, machine(), emptyState(), false)).toEqual([]);
  });
});
