import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { cliFixture, put } from "./helpers";

describe("CLI: sync --all показывает цели и спрашивает подтверждение", () => {
  test("печатает workspace и список целей", () => {
    const f = cliFixture({ projects: ["Org/p1", "Org/p2"] });
    const r = f.run(["sync", "--all", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(f.ws);
    expect(r.out).toContain("Org/p1");
    expect(r.out).toContain("Org/p2");
    expect(r.out).toContain("новые");
  });

  test("много новых целей: без --yes и без терминала — отказ; --dry-run не спрашивает; известные цели не спрашивают", () => {
    const projects = Array.from({ length: 11 }, (_, i) => `Org/p${i}`);
    const f = cliFixture({ projects });
    const r = f.run(["sync", "--all"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--yes");
    expect(projects.some((p) => existsSync(`${f.ws}/${p}/CLAUDE.local.md`))).toBe(false);
    expect(f.run(["sync", "--all", "--dry-run"]).code).toBe(0);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(projects.every((p) => existsSync(`${f.ws}/${p}/CLAUDE.local.md`))).toBe(true);
    expect(f.run(["sync", "--all"]).code).toBe(0);
  }, 30000);

  test("workspace — домашний каталог: без --yes — отказ до обхода", () => {
    const f = cliFixture();
    put(`${f.config}/local/machine.yaml`, `workspace: ${f.home}\nagents: [claude]\n`);
    const r = f.run(["sync", "--all"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("домашний каталог");
  });
});

describe("CLI: sync --out — только своя песочница", () => {
  test("путь — от текущего каталога", () => {
    const f = cliFixture();
    mkdirSync(`${f.dir}/sub`);
    const r = f.run(["sync", "--global", "--out", "sb"], { cwd: `${f.dir}/sub` });
    expect(r.code).toBe(0);
    expect(existsSync(`${f.dir}/sub/sb/claude/home/.claude/CLAUDE.md`)).toBe(true);
  });

  test("непустой каталог не от miksy — отказ, ничего не удалено", () => {
    const f = cliFixture();
    put(`${f.dir}/precious/claude/keep.txt`, "keep");
    const r = f.run(["sync", "--global", "--out", `${f.dir}/precious`]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("песочниц");
    expect(readFileSync(`${f.dir}/precious/claude/keep.txt`, "utf8")).toBe("keep");
    expect(readdirSync(`${f.dir}/precious`)).toEqual(["claude"]);
  });

  test("пустой каталог и своя песочница — можно, повторно тоже", () => {
    const f = cliFixture();
    mkdirSync(`${f.dir}/empty`);
    expect(f.run(["sync", "--global", "--out", `${f.dir}/empty`]).code).toBe(0);
    expect(f.run(["sync", "--global", "--out", `${f.dir}/empty`]).code).toBe(0);
    expect(existsSync(`${f.dir}/empty/claude/home/.claude/CLAUDE.md`)).toBe(true);
  });

  test("--dry-run: ничего не создаётся", () => {
    const f = cliFixture();
    const r = f.run(["sync", "--global", "--out", `${f.dir}/sb`, "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(".claude/CLAUDE.md");
    expect(existsSync(`${f.dir}/sb`)).toBe(false);
  });
});

describe("CLI: разбор флагов", () => {
  test("неизвестный флаг — ошибка, ничего не записано", () => {
    const f = cliFixture();
    for (const bad of ["--dryrun", "--dry_run", "-n"]) {
      const r = f.run(["sync", "--global", bad]);
      expect(r.code).toBe(2);
      expect(r.err).toContain(bad);
    }
    expect(existsSync(`${f.home}/.claude/CLAUDE.md`)).toBe(false);
  });

  test("флаг чужой команды — ошибка", () => {
    const f = cliFixture();
    expect(f.run(["doctor", "--force"]).code).toBe(2);
    expect(f.run(["explain", "--all"]).code).toBe(2);
  });

  test("--flag=value", () => {
    const f = cliFixture();
    const r = f.run(["sync", "--global", "--dry-run", "--agent=codex"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(".codex/AGENTS.md");
    expect(r.out).not.toContain(".claude/CLAUDE.md");
    const out = f.run(["sync", "--global", `--out=${f.dir}/sb`]);
    expect(out.code).toBe(0);
    expect(existsSync(`${f.dir}/sb/claude/home/.claude/CLAUDE.md`)).toBe(true);
    expect(existsSync(`${f.home}/.claude/CLAUDE.md`)).toBe(false);
  });

  test("флаг без значения — ошибка, а не «все агенты»", () => {
    const f = cliFixture();
    for (const args of [["--agent"], ["--agent", "--dry-run"], ["--agent="], ["--out"]]) {
      const r = f.run(["sync", "--global", ...args]);
      expect(r.code).toBe(2);
      expect(r.err).toContain("значение");
    }
    expect(f.run(["sync", "--global", "--dry-run=yes"]).code).toBe(2);
    expect(existsSync(`${f.home}/.claude/CLAUDE.md`)).toBe(false);
  });

  test("лишние аргументы и несовместимые режимы — ошибка", () => {
    const f = cliFixture();
    expect(f.run(["sync", `${f.ws}/Org/p1`, "--all", "--dry-run"]).code).toBe(2);
    expect(f.run(["sync", "--global", "--all", "--dry-run"]).code).toBe(2);
    expect(f.run(["clean", "a", "b", "--dry-run"]).code).toBe(2);
    expect(f.run(["explain", "a", "b"]).code).toBe(2);
    expect(f.run(["sync", "--global", "--dry-run", "--dry-run"]).code).toBe(2);
  });

  test("--out — для всех агентов машины", () => {
    const f = cliFixture({ agents: ["claude", "codex"] });
    const r = f.run(["sync", "--global", "--out", `${f.dir}/sb`]);
    expect(r.code).toBe(0);
    expect(existsSync(`${f.dir}/sb/claude/home/.claude/CLAUDE.md`)).toBe(true);
    expect(existsSync(`${f.dir}/sb/codex/home/.codex/AGENTS.md`)).toBe(true);
  });
});
