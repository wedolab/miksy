// .git/info/exclude: пишется до файлов; строка не снимается, пока файл существует; worktree делят exclude
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RenderResult, Target } from "../src/adapter";
import { apply, plan } from "../src/apply";
import { emptyState } from "../src/manifest";

const git = (dir: string, ...args: string[]) =>
  Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdout: "pipe", stderr: "pipe" });

function fixture() {
  const d = mkdtempSync(join(tmpdir(), "exclude-")).replaceAll("\\", "/");
  const home = `${d}/home`;
  const proj = `${d}/p`;
  mkdirSync(home, { recursive: true });
  mkdirSync(`${proj}/.git/info`, { recursive: true });
  writeFileSync(`${proj}/.git/info/exclude`, "*.log\n");
  return { home, proj, ex: `${proj}/.git/info/exclude`, machine: { workspace: d, os: "linux" as const, home, vars: {} } };
}

const files = (...paths: string[]): RenderResult => ({
  warnings: [],
  files: paths.map((path) => ({ base: "project" as const, path, mode: "own" as const, content: `${path}\n` })),
});

describe("exclude", () => {
  test("пишется до файлов: сбой посреди записи — новые файлы уже скрыты", () => {
    const f = fixture();
    const t: Target = { scope: "project", dir: f.proj, rel: "p" };
    const actions = plan(files("CLAUDE.local.md", "sub/x.md"), t, f.machine, emptyState(), false, "claude");
    writeFileSync(`${f.proj}/sub`, "файл на месте каталога — запись sub/x.md упадёт");
    expect(() => apply(actions, emptyState())).toThrow();
    const ex = readFileSync(f.ex, "utf8");
    expect(ex).toContain("/CLAUDE.local.md");
    expect(ex).toContain("/sub/x.md");
  });

  test("clean: файл, изменённый вручную, не удалён — строка exclude остаётся", () => {
    const f = fixture();
    const t: Target = { scope: "project", dir: f.proj, rel: "p" };
    const { state } = apply(plan(files("CLAUDE.local.md", "B.md"), t, f.machine, emptyState(), false, "claude"), emptyState());
    writeFileSync(`${f.proj}/CLAUDE.local.md`, "правка вручную\n");
    const actions = plan({ files: [], warnings: [] }, t, f.machine, state, false, "claude");
    expect(actions.some((a) => a.kind === "conflict")).toBe(true);
    const { state: after } = apply(actions, state);
    expect(existsSync(`${f.proj}/CLAUDE.local.md`)).toBe(true);
    expect(existsSync(`${f.proj}/B.md`)).toBe(false);
    const ex = readFileSync(f.ex, "utf8");
    expect(ex).toContain("/CLAUDE.local.md");
    expect(ex).not.toContain("/B.md");
    // повторный clean — тот же конфликт, строка по-прежнему на месте
    apply(plan({ files: [], warnings: [] }, t, f.machine, after, false, "claude"), after);
    expect(readFileSync(f.ex, "utf8")).toContain("/CLAUDE.local.md");
  });

  test("clean: удаление упало — строки удаляемых файлов остаются", () => {
    const f = fixture();
    const t: Target = { scope: "project", dir: f.proj, rel: "p" };
    const { state } = apply(plan(files("A.md", "B.md"), t, f.machine, emptyState(), false, "claude"), emptyState());
    const actions = plan({ files: [], warnings: [] }, t, f.machine, state, false, "claude");
    // Удаление B.md упадёт: между планом и записью он стал каталогом с файлом внутри
    const bad = actions.map((a) => (a.kind === "delete" && a.abs.endsWith("/B.md") ? { ...a, abs: `${f.proj}/dir-not-file` } : a));
    mkdirSync(`${f.proj}/dir-not-file/x`, { recursive: true });
    expect(() => apply(bad, state)).toThrow();
    expect(readFileSync(f.ex, "utf8")).toContain("/B.md");
  });

  test("worktree: у каждого свой блок в общем exclude, sync одного не ломает другой", () => {
    const d = realpathSync.native(mkdtempSync(join(tmpdir(), "exclude-wt-"))).replaceAll("\\", "/");
    const main = `${d}/main`;
    const wt = `${d}/wt`;
    mkdirSync(main);
    git(main, "init", "--quiet");
    writeFileSync(`${main}/README`, "r");
    git(main, "add", "README");
    git(main, "commit", "--quiet", "-m", "init");
    expect(git(main, "worktree", "add", "--quiet", wt).exitCode).toBe(0);
    const home = `${d}/home`;
    mkdirSync(home);
    const machine = { workspace: d, os: "linux" as const, home, vars: {} };
    const tm: Target = { scope: "project", dir: main, rel: "main" };
    const tw: Target = { scope: "project", dir: wt, rel: "wt" };

    const { state: sm } = apply(plan(files("A.md"), tm, machine, emptyState(), false, "claude"), emptyState());
    const { state: sw } = apply(plan(files("B.md"), tw, machine, emptyState(), false, "claude"), emptyState());
    // Повторный план ни для одного не трогает exclude: блоки не перетирают друг друга
    expect(plan(files("A.md"), tm, machine, sm, false, "claude").filter((a) => a.kind === "exclude")).toEqual([]);
    expect(plan(files("B.md"), tw, machine, sw, false, "claude").filter((a) => a.kind === "exclude")).toEqual([]);
    const ex = readFileSync(`${main}/.git/info/exclude`, "utf8");
    expect(ex).toContain("/A.md");
    expect(ex).toContain("/B.md");
    // clean worktree не снимает строки основного
    apply(plan({ files: [], warnings: [] }, tw, machine, sw, false, "claude"), sw);
    const after = readFileSync(`${main}/.git/info/exclude`, "utf8");
    expect(after).toContain("/A.md");
    expect(after).not.toContain("/B.md");
    // файлы основного по-прежнему скрыты от git
    expect(git(main, "status", "--porcelain").stdout.toString()).not.toContain("A.md");
  });
});
