// Git-проверки: сбой git — отказ записи; глобальные файлы в dotfiles-репо не трогаем
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codex } from "../adapters/codex";
import type { RenderResult, Target } from "../src/adapter";
import { apply, plan } from "../src/apply";
import { emptyState } from "../src/manifest";
import type { Resolved } from "../src/types";
import { cliFixture } from "./helpers";

const git = (dir: string, ...args: string[]) =>
  Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdout: "ignore", stderr: "ignore" });

// Репо с повреждённым индексом: rev-parse работает, ls-files — сбой
function brokenRepo() {
  const d = mkdtempSync(join(tmpdir(), "git-")).replaceAll("\\", "/");
  git(d, "init", "--quiet");
  writeFileSync(`${d}/a.txt`, "a");
  git(d, "add", "a.txt");
  writeFileSync(`${d}/.git/index`, "garbage, not an index");
  return d;
}

const own = (path: string, base: "home" | "project" = "project"): RenderResult => ({
  warnings: [],
  files: [{ base, path, mode: "own", content: "x\n" }],
});

describe("git: сбой — отказ записи", () => {
  test("ls-files падает (битый индекс) — конфликт, файл не записан", () => {
    const proj = brokenRepo();
    const home = mkdtempSync(join(tmpdir(), "git-home-")).replaceAll("\\", "/");
    const target: Target = { scope: "project", dir: proj, rel: "p" };
    const actions = plan(own("CLAUDE.local.md"), target, { workspace: "/ws", os: "linux", home, vars: {} }, emptyState(), true);
    expect(actions.some((a) => a.kind === "write")).toBe(false);
    expect(actions.find((a) => a.kind === "conflict")?.why).toContain("git");
    apply(actions, emptyState());
    expect(existsSync(`${proj}/CLAUDE.local.md`)).toBe(false);
  });

  test("codex: сбой git при проверке .codex/config.toml — предупреждение, не падение и не запись", () => {
    const proj = brokenRepo();
    const cfg: Resolved = { layers: ["w"], instructions: [], skills: [], mcp: [{ item: { name: "a", url: "u" }, layer: "w" }], notes: [] };
    const r = codex.render(cfg, { scope: "project", dir: proj, rel: "p" }, { workspace: "/ws", os: "linux", home: proj, vars: {} });
    expect(r.files.some((f) => f.path === ".codex/config.toml")).toBe(false);
    expect(r.warnings.join("\n")).toContain("git");
  });

  test("git не найден — sync проекта ничего не пишет", () => {
    const f = cliFixture();
    const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "sync", `${f.ws}/Org/p1`], {
      cwd: f.dir,
      env: { ...process.env, MIKSY_CONFIG: f.config, HOME: f.home, USERPROFILE: f.home, PATH: f.dir, Path: f.dir },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(existsSync(`${f.ws}/Org/p1/CLAUDE.local.md`)).toBe(false);
    expect(r.stdout.toString() + r.stderr.toString()).toContain("git");
  }, 30000);
});

describe("git: глобальные файлы в dotfiles-репо", () => {
  test("файл ~, отслеживаемый git (dotfiles), — конфликт даже с --force", () => {
    const home = mkdtempSync(join(tmpdir(), "git-home-")).replaceAll("\\", "/");
    git(home, "init", "--quiet");
    mkdirSync(`${home}/.claude`);
    writeFileSync(`${home}/.claude/CLAUDE.md`, "mine\n");
    git(home, "add", ".claude/CLAUDE.md");
    git(home, "commit", "--quiet", "-m", "dotfiles");
    const machine = { workspace: "/ws", os: "linux" as const, home, vars: {} };
    const actions = plan(own(".claude/CLAUDE.md", "home"), { scope: "global" }, machine, emptyState(), true);
    expect(actions).toEqual([expect.objectContaining({ kind: "conflict", why: expect.stringContaining("git") })]);
    apply(actions, emptyState());
    expect(readFileSync(`${home}/.claude/CLAUDE.md`, "utf8")).toBe("mine\n");
  });

  test("слияние ключей в отслеживаемый ~/.claude.json — конфликт", () => {
    const home = mkdtempSync(join(tmpdir(), "git-home-")).replaceAll("\\", "/");
    git(home, "init", "--quiet");
    writeFileSync(`${home}/.claude.json`, "{}");
    git(home, "add", ".claude.json");
    const r: RenderResult = { warnings: [], files: [{ base: "home", path: ".claude.json", mode: "merge", format: "json", key: ["mcpServers"], data: { a: { url: "u" } } }] };
    const actions = plan(r, { scope: "global" }, { workspace: "/ws", os: "linux", home, vars: {} }, emptyState(), true);
    expect(actions).toEqual([expect.objectContaining({ kind: "conflict" })]);
  });

  test("неотслеживаемый файл в dotfiles-репо — пишется", () => {
    const home = mkdtempSync(join(tmpdir(), "git-home-")).replaceAll("\\", "/");
    git(home, "init", "--quiet");
    const actions = plan(own(".claude/CLAUDE.md", "home"), { scope: "global" }, { workspace: "/ws", os: "linux", home, vars: {} }, emptyState(), false);
    expect(actions.map((a) => a.kind)).toEqual(["write"]);
  });
});
