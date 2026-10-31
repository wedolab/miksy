import { canonical } from "../src/paths";
// Бэкапы: одна метка на запуск, одна копия файла за запуск, ротация, права 0700/0600
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RenderResult, Target } from "../src/adapter";
import { apply, plan } from "../src/apply";
import { KEEP_RUNS, newBackupRun } from "../src/backup";
import { emptyState } from "../src/manifest";

const win = process.platform === "win32";
let config: string;
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.MIKSY_CONFIG;
  config = mkdtempSync(join(tmpdir(), "backup-cfg-")).replaceAll("\\", "/");
  process.env.MIKSY_CONFIG = config;
  newBackupRun();
});
afterEach(() => {
  process.env.MIKSY_CONFIG = saved;
});

const runs = () => readdirSync(`${config}/local/backups`).filter((d) => /^\d{4}-/.test(d)).sort();

function home() {
  const h = mkdtempSync(join(tmpdir(), "backup-home-")).replaceAll("\\", "/");
  writeFileSync(`${h}/.claude.json`, JSON.stringify({ original: true }));
  return h;
}
const merge = (h: string, n: string): RenderResult => ({
  warnings: [],
  files: [{ base: "home", path: ".claude.json", mode: "merge", format: "json", key: ["projects", `/p/${n}`, "mcpServers"], data: { a: { url: n } } }],
});

describe("бэкапы", () => {
  test("несколько целей за запуск: одна метка, одна копия файла — исходная", () => {
    const h = home();
    const m = { workspace: "/ws", os: "linux" as const, home: h, vars: {} };
    const g: Target = { scope: "global" };
    apply(plan(merge(h, "one"), g, m, emptyState(), false), emptyState());
    apply(plan(merge(h, "two"), g, m, emptyState(), false), emptyState());
    expect(runs()).toHaveLength(1);
    const copies: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name)) : copies.push(join(d, e.name));
    };
    walk(`${config}/local/backups/${runs()[0]}`);
    expect(copies).toHaveLength(1);
    expect(JSON.parse(readFileSync(copies[0], "utf8"))).toEqual({ original: true });
  });

  test("ротация: остаются последние запуски, чужие каталоги не трогаются", () => {
    const b = `${config}/local/backups`;
    for (let i = 0; i < KEEP_RUNS + 5; i++) mkdirSync(`${b}/2020-01-01T00-00-${String(i).padStart(2, "0")}-000Z`, { recursive: true });
    mkdirSync(`${b}/manual-removed`, { recursive: true });
    const h = home();
    apply(plan(merge(h, "x"), { scope: "global" }, { workspace: "/ws", os: "linux", home: h, vars: {} }, emptyState(), false), emptyState());
    const left = runs();
    expect(left).toHaveLength(KEEP_RUNS);
    expect(left).not.toContain("2020-01-01T00-00-00-000Z");
    expect(left.at(-1)!.startsWith("2020")).toBe(false);
    expect(readdirSync(b)).toContain("manual-removed");
  });

  test.skipIf(win)("права: каталоги 0700, файлы 0600", () => {
    const h = home();
    apply(plan(merge(h, "x"), { scope: "global" }, { workspace: "/ws", os: "linux", home: h, vars: {} }, emptyState(), false), emptyState());
    const run = `${config}/local/backups/${runs()[0]}`;
    expect(statSync(`${config}/local/backups`).mode & 0o777).toBe(0o700);
    expect(statSync(run).mode & 0o777).toBe(0o700);
    const file = join(run, canonical(h).replace(/^\/+/, ""), ".claude.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
