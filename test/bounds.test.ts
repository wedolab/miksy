// Границы файловой системы: запись и удаление только внутри своего проекта или домашнего каталога
import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RenderResult, Target } from "../src/adapter";
import { layerDir } from "../src/adopt";
import { apply, plan } from "../src/apply";
import { escapes, inside } from "../src/bounds";
import { emptyState, sha } from "../src/manifest";

const win = process.platform === "win32";

function fixture() {
  const d = mkdtempSync(join(tmpdir(), "bounds-")).replaceAll("\\", "/");
  const home = `${d}/home`;
  const proj = `${d}/ws/p`;
  const outside = `${d}/outside`;
  for (const x of [home, `${proj}/.git/info`, outside]) mkdirSync(x, { recursive: true });
  const target: Target = { scope: "project", dir: proj, rel: "p" };
  const machine = { workspace: `${d}/ws`, os: "linux" as const, home, vars: {} };
  return { d, home, proj, outside, target, machine };
}

const own = (path: string, base: "home" | "project" = "project"): RenderResult => ({
  warnings: [],
  files: [{ base, path, mode: "own", content: "x\n" }],
});

describe("границы ФС", () => {
  test("каталог проекта — junction/симлинк наружу: конфликт, снаружи ничего не создано", () => {
    const f = fixture();
    symlinkSync(f.outside, `${f.proj}/.claude`, "junction");
    const actions = plan(own(".claude/skills/x/SKILL.md"), f.target, f.machine, emptyState(), true);
    expect(actions.find((a) => a.abs.endsWith("SKILL.md"))).toMatchObject({ kind: "conflict" });
    apply(actions, emptyState());
    expect(existsSync(`${f.outside}/skills`)).toBe(false);
  });

  test("файл проекта — симлинк наружу: конфликт, чужой файл не изменён", () => {
    const f = fixture();
    writeFileSync(`${f.outside}/secret.md`, "keep");
    symlinkSync(`${f.outside}/secret.md`, `${f.proj}/CLAUDE.local.md`, "file");
    const actions = plan(own("CLAUDE.local.md"), f.target, f.machine, emptyState(), true);
    expect(actions[0]).toMatchObject({ kind: "conflict" });
    apply(actions, emptyState());
    expect(readFileSync(`${f.outside}/secret.md`, "utf8")).toBe("keep");
  });

  test("симлинк внутри домашнего каталога (dotfiles в ~) — можно", () => {
    const f = fixture();
    mkdirSync(`${f.home}/dotfiles`);
    writeFileSync(`${f.home}/dotfiles/CLAUDE.md`, "old");
    mkdirSync(`${f.home}/.claude`);
    symlinkSync(`${f.home}/dotfiles/CLAUDE.md`, `${f.home}/.claude/CLAUDE.md`, "file");
    const g: Target = { scope: "global" };
    const prev = { ...emptyState(), files: { [`${f.home}/.claude/CLAUDE.md`]: sha("old") } };
    const actions = plan(own(".claude/CLAUDE.md", "home"), g, f.machine, prev, false);
    expect(actions.map((a) => a.kind)).toEqual(["write"]);
    apply(actions, prev);
    expect(readFileSync(`${f.home}/dotfiles/CLAUDE.md`, "utf8")).toBe("x\n");
  });

  test("путь адаптера с .. — конфликт", () => {
    const f = fixture();
    const actions = plan(own("../escape.md"), f.target, f.machine, emptyState(), true);
    expect(actions[0]).toMatchObject({ kind: "conflict" });
    apply(actions, emptyState());
    expect(existsSync(`${f.d}/ws/escape.md`)).toBe(false);
  });

  test("путь из учёта вне цели не удаляется даже при совпадении хеша", () => {
    const f = fixture();
    writeFileSync(`${f.outside}/victim.txt`, "data");
    const prev = { ...emptyState(), files: { [`${f.outside}/victim.txt`]: sha("data") } };
    const actions = plan({ files: [], warnings: [] }, f.target, f.machine, prev, true);
    expect(actions.some((a) => a.kind === "delete")).toBe(false);
    expect(actions[0]).toMatchObject({ kind: "conflict" });
    apply(actions, prev);
    expect(existsSync(`${f.outside}/victim.txt`)).toBe(true);
  });

  test("путь из учёта через junction наружу не удаляется", () => {
    const f = fixture();
    writeFileSync(`${f.outside}/x.md`, "data");
    symlinkSync(f.outside, `${f.proj}/.opencode`, "junction");
    const prev = { ...emptyState(), files: { [`${f.proj}/.opencode/x.md`]: sha("data") } };
    const actions = plan({ files: [], warnings: [] }, f.target, f.machine, prev, true);
    expect(actions.some((a) => a.kind === "delete")).toBe(false);
    apply(actions, prev);
    expect(existsSync(`${f.outside}/x.md`)).toBe(true);
  });

  test("clean симлинка: ни ссылка, ни файл, на который она указывает, не удаляются", () => {
    const f = fixture();
    mkdirSync(`${f.home}/dotfiles`);
    writeFileSync(`${f.home}/dotfiles/CLAUDE.md`, "data");
    mkdirSync(`${f.home}/.claude`);
    symlinkSync(`${f.home}/dotfiles/CLAUDE.md`, `${f.home}/.claude/CLAUDE.md`, "file");
    const prev = { ...emptyState(), files: { [`${f.home}/.claude/CLAUDE.md`]: sha("data") } };
    const actions = plan({ files: [], warnings: [] }, { scope: "global" }, f.machine, prev, true);
    expect(actions).toEqual([expect.objectContaining({ kind: "conflict", why: expect.stringContaining("симлинк") })]);
    apply(actions, prev);
    expect(lstatSync(`${f.home}/.claude/CLAUDE.md`).isSymbolicLink()).toBe(true);
    expect(readFileSync(`${f.home}/dotfiles/CLAUDE.md`, "utf8")).toBe("data");
  });

  test("симлинк появился между планом и записью — отказ при записи", () => {
    const f = fixture();
    const actions = plan(own(".claude/skills/x/SKILL.md"), f.target, f.machine, emptyState(), false);
    expect(actions.some((a) => a.kind === "write")).toBe(true);
    symlinkSync(f.outside, `${f.proj}/.claude`, "junction");
    expect(() => apply(actions, emptyState())).toThrow("вне");
    expect(existsSync(`${f.outside}/skills`)).toBe(false);
  });

  test("слияние ключей в файл, который ведёт наружу, — конфликт", () => {
    const f = fixture();
    writeFileSync(`${f.outside}/cfg.json`, "{}");
    symlinkSync(`${f.outside}/cfg.json`, `${f.home}/.claude.json`, "file");
    const r: RenderResult = { warnings: [], files: [{ base: "home", path: ".claude.json", mode: "merge", format: "json", key: ["mcpServers"], data: { a: { url: "u" } } }] };
    const actions = plan(r, { scope: "global" }, f.machine, emptyState(), true);
    expect(actions).toEqual([expect.objectContaining({ kind: "conflict" })]);
    apply(actions, emptyState());
    expect(readFileSync(`${f.outside}/cfg.json`, "utf8")).toBe("{}");
  });

  test.skipIf(!win)("Windows: другой диск — не внутри (relative даёт абсолютный путь)", () => {
    expect(inside("D:/ws/p/x", "C:/ws/p")).toBe(false);
    expect(inside("C:/ws/p/x", "c:/WS/p")).toBe(true);
    expect(escapes("Z:/nowhere/x.md", "C:/ws")).not.toBeNull();
  });

  test("inside: соседний каталог с общим префиксом и .. — не внутри", () => {
    expect(inside("/a/proj2/x", "/a/proj")).toBe(false);
    expect(inside("/a/proj/../x", "/a/proj")).toBe(false);
    expect(inside("/a/proj/..x", "/a/proj")).toBe(true);
    expect(inside("/a/proj", "/a/proj")).toBe(true);
  });

  test("adopt --to: выход из дерева слоёв — ошибка", () => {
    const root = mkdtempSync(join(tmpdir(), "bounds-cfg-"));
    mkdirSync(join(root, "layers", "tree"), { recursive: true });
    for (const bad of ["../x", "Org/../../x", "Org/..", "/abs", "C:/abs", "C:\\abs", "Org\\..\\..\\x", "./x"])
      expect(() => layerDir(bad, root)).toThrow();
    expect(layerDir("Org/Team", root).replaceAll("\\", "/")).toEndWith("layers/tree/Org/Team");
  });

  test("adopt --to: каталог дерева — симлинк наружу — ошибка", () => {
    const root = mkdtempSync(join(tmpdir(), "bounds-cfg-")).replaceAll("\\", "/");
    const out = mkdtempSync(join(tmpdir(), "bounds-out-")).replaceAll("\\", "/");
    mkdirSync(`${root}/layers/tree`, { recursive: true });
    symlinkSync(out, `${root}/layers/tree/Org`, "junction");
    expect(() => layerDir("Org", root)).toThrow("вне");
  });
});

describe("границы ФС: проекты и adopt", () => {
  test("listProjects: каталог агента через симлинк наружу workspace — не проект", async () => {
    const { listProjects } = await import("../src/load");
    const d = mkdtempSync(join(tmpdir(), "bounds-ws-")).replaceAll("\\", "/");
    mkdirSync(`${d}/ws/a`, { recursive: true });
    mkdirSync(`${d}/outside/x`, { recursive: true });
    symlinkSync(`${d}/outside`, `${d}/ws/link`, "junction");
    const list = listProjects(`${d}/ws`, [`${d}/ws/link/x`]);
    expect(list.map((p) => p.rel)).toEqual([]);
  });

  test("findProject: путь вне workspace через симлинк — ошибка", async () => {
    const { findProject } = await import("../src/load");
    const d = mkdtempSync(join(tmpdir(), "bounds-ws-")).replaceAll("\\", "/");
    mkdirSync(`${d}/ws`, { recursive: true });
    mkdirSync(`${d}/outside/x`, { recursive: true });
    symlinkSync(`${d}/outside`, `${d}/ws/link`, "junction");
    expect(() => findProject(`${d}/ws/link/x`, `${d}/ws`)).toThrow("вне workspace");
  });

  test("adopt skill: симлинки внутри skill не копируются", async () => {
    const { adoptSkill } = await import("../src/adopt");
    const root = mkdtempSync(join(tmpdir(), "bounds-cfg-")).replaceAll("\\", "/");
    const src = mkdtempSync(join(tmpdir(), "bounds-skill-")).replaceAll("\\", "/");
    mkdirSync(`${root}/layers/tree`, { recursive: true });
    writeFileSync(`${src}/SKILL.md`, "---\nname: s\ndescription: d\n---\n");
    writeFileSync(`${root}/secret`, "id_rsa");
    symlinkSync(`${root}/secret`, `${src}/key`, "file");
    adoptSkill(src, "s", "workspace", root);
    expect(existsSync(`${root}/layers/tree/skills/s/SKILL.md`)).toBe(true);
    expect(existsSync(`${root}/layers/tree/skills/s/key`)).toBe(false);
  });

  test("adopt: имя с путём — ошибка", async () => {
    const { adoptMcp } = await import("../src/adopt");
    const root = mkdtempSync(join(tmpdir(), "bounds-cfg-")).replaceAll("\\", "/");
    mkdirSync(`${root}/layers/tree`, { recursive: true });
    expect(() => adoptMcp({ name: "../../evil", url: "u" }, {}, "workspace", root, root)).toThrow("недопустимое имя");
  });
});
