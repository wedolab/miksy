import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plan } from "../src/apply";
import { emptyState } from "../src/manifest";

// Группа home/Miksy содержит конфигурацию miksy (своё git-репо). Обёртки секретов лежат в
// local/ конфигурации — их владелец miksy, а не вложенное репо: проверка С3 их не касается
test("группа, внутри которой конфигурация miksy (git): обёртки local/ не конфликтуют", () => {
  const dir = mkdtempSync(join(tmpdir(), "grp-")).replaceAll("\\", "/");
  const cfg = `${dir}/miksy-config`;
  mkdirSync(`${cfg}/local`, { recursive: true });
  Bun.spawnSync(["git", "init", "--quiet", cfg]);
  const saved = process.env.MIKSY_CONFIG;
  process.env.MIKSY_CONFIG = cfg;
  try {
    const machine = { home: `${dir}/home`, workspace: dir, os: process.platform === "win32" ? "windows" as const : "macos" as const, vars: {} };
    mkdirSync(machine.home, { recursive: true });
    const result = { warnings: [], files: [{ base: "local" as const, path: "run/claude/g/context7.cmd", mode: "own" as const, content: "x", executable: true }] };
    const actions = plan(result, { scope: "project", dir, rel: "g" }, machine, emptyState(), false);
    expect(actions.filter((a) => a.kind === "conflict")).toEqual([]);
    expect(actions.some((a) => a.kind === "write" && a.abs.endsWith("/local/run/claude/g/context7.cmd"))).toBe(true);
  } finally {
    if (saved === undefined) delete process.env.MIKSY_CONFIG;
    else process.env.MIKSY_CONFIG = saved;
  }
});
