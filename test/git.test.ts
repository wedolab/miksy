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
import { cliFixture, expectCode } from "./helpers";

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

// Круг 10d-6: причина сбоя git в тексте ошибки — первая строка stderr (суть), последняя — если другая, код; пусто — сказано
describe("git: причина сбоя в тексте ошибки", () => {
  test("первая и последняя строки stderr, код; пустой stderr — «git ничего не написал»", async () => {
    const { gitWhy } = await import("../src/git");
    expect(gitWhy("fatal: not a git repository (or any of the parent directories): .git\n", 128)).toBe("fatal: not a git repository (or any of the parent directories): .git (код 128)");
    expect(gitWhy("warning: x\r\nhint: y\nfatal: index file corrupt\n", 128)).toBe("warning: x … fatal: index file corrupt (код 128)");
    expect(gitWhy("", 128)).toBe("код 128, git ничего не написал");
    expect(gitWhy("  \n", null)).toBe("код null, git ничего не написал");
  });
});

// Круг 10d-6: ответ git не дошёл (на macOS GitHub — «код 0, пустой stdout» и «код 128, пустой stderr») — ровно один
// повтор; пустой и после повтора — понятная ошибка, а не «корень репо = текущий каталог»; обычный ответ — без повтора
describe("git: потерянный ответ — один повтор", () => {
  const real = (argv: string[], opts: { env: Record<string, string | undefined> }) => Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", env: opts.env });
  const empty = (code: number) => ({ exitCode: code, stdout: Buffer.from(""), stderr: Buffer.from("") });
  // Подмена: первые answers вызовов — заданные ответы, дальше — настоящий git; calls — сколько раз запускали
  const fake = async (answers: ReturnType<typeof empty>[]) => {
    const g = await import("../src/git");
    const state = { calls: 0 };
    g.setGitSpawnForTest((argv, opts) => (state.calls++ < answers.length ? answers[state.calls - 1] : real(argv, opts)));
    return { g, state };
  };
  const repo = () => { const d = mkdtempSync(join(tmpdir(), "git-lost-")).replaceAll("\\", "/"); git(d, "init", "--quiet"); return d; };

  test("код 0 и пустой stdout → повтор → путь репо", async () => {
    const d = repo();
    const { g, state } = await fake([empty(0)]);
    try {
      const top = g.repoOf(d);
      expect({ top: !!top && top.replaceAll("\\", "/").toLowerCase().endsWith(d.split("/").pop()!.toLowerCase()), calls: state.calls }).toEqual({ top: true, calls: 2 });
    } finally { g.setGitSpawnForTest(null); }
  });

  test("код 128 и пустой stderr → повтор → обычный ответ «не репо»", async () => {
    const d = mkdtempSync(join(tmpdir(), "git-lost-plain-")).replaceAll("\\", "/");
    const { g, state } = await fake([empty(128)]);
    try { expect({ top: g.repoOf(d), calls: state.calls }).toEqual({ top: null, calls: 2 }); } finally { g.setGitSpawnForTest(null); }
  });

  test("два пустых ответа подряд — понятная ошибка, а не корень = текущий каталог", async () => {
    const d = repo();
    const { g, state } = await fake([empty(0), empty(0)]);
    try {
      expect(() => g.repoOf(d)).toThrow("git ничего не ответил (код 0)");
      expect(state.calls).toBe(2);
    } finally { g.setGitSpawnForTest(null); }
    const { g: g3, state: s3 } = await fake([empty(128), empty(128)]);
    try {
      expect(() => g3.repoOf(d)).toThrow("код 128, git ничего не написал");
      expect(s3.calls).toBe(2);
    } finally { g3.setGitSpawnForTest(null); }
  });

  test("git убит или вышел по тайм-ауту (код null) и команды, меняющие репо, — без повтора", async () => {
    const d = repo();
    const killed = { exitCode: null, stdout: Buffer.from(""), stderr: Buffer.from("") };
    const { g, state } = await fake([killed, killed]);
    try {
      expect(g.gitSpawn(["-C", d, "fetch", "origin"], { timeout: 1000 }).code).toBeNull();
      expect(state.calls).toBe(1);
      expect(() => g.repoOf(d)).toThrow("git rev-parse");
      expect(state.calls).toBe(2);
    } finally { g.setGitSpawnForTest(null); }
    const { g: g2, state: s2 } = await fake([empty(1), empty(1)]);
    try {
      expectCode(g2.gitSpawn(["-C", d, "checkout", "-q", "-b", "x"], { readOnly: false }), 1);
      expect(s2.calls).toBe(1);
    } finally { g2.setGitSpawnForTest(null); }
  });

  test("обычный «not a git repository» и путь репо — без повтора", async () => {
    const plain = mkdtempSync(join(tmpdir(), "git-plain-")).replaceAll("\\", "/");
    const { g, state } = await fake([]);
    try {
      expect(g.repoOf(plain)).toBeNull();
      expect(state.calls).toBe(1);
      g.repoOf(repo());
      expect(state.calls).toBe(2);
    } finally { g.setGitSpawnForTest(null); }
  });
});
