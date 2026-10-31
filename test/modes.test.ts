// Права файлов с секретами (фаза 1.6: С1, С6, С9, С10)
import { expect, test } from "bun:test";
import { chmodSync, statSync, unlinkSync, symlinkSync } from "node:fs";
import { apply, plan } from "../src/apply";
import { newBackupRun, runDir } from "../src/backup";
import { emptyState } from "../src/manifest";
import { ADAPTERS, renderFor } from "../src/registry";
import { cliFixture, put } from "./helpers";

const win = process.platform === "win32";
const none = { layers: [], instructions: [], skills: [], notes: [], mcp: [] };
const machineOf = (f: { home: string; ws: string }) => ({ home: f.home, workspace: f.ws, os: "linux" as const, vars: {} });
const secretMcp = { layer: "x", item: { name: "s", command: "echo", env: { TOKEN: "${TOKEN}" } } };

test("С1: значение secrets.env, не подставленное в MCP, не делает файл секретным", () => {
  const f = cliFixture();
  put(`${f.dir}/skill/SKILL.md`, "---\nname: db\n---\nDEBUG=1\n");
  put(`${f.dir}/skill/backup.sh`, "pg_dump -U postgres\n");
  const cfg = { ...none, skills: [{ layer: "x", item: { name: "db", dir: `${f.dir}/skill` } }] };
  const { result } = renderFor(ADAPTERS.claude, { cfg, target: { scope: "global" }, title: "t" }, machineOf(f), { PGUSER: "postgres", DEBUG: "1" });
  expect(result.files.length).toBe(2);
  expect(result.files.some((x) => x.sensitive)).toBe(false);
});

test("С1: реально подставленное значение секрета делает файл секретным", () => {
  const f = cliFixture();
  put(`${f.dir}/skill/SKILL.md`, "---\nname: db\n---\nкопия токена: opaque-secret-123\n");
  const cfg = { ...none, mcp: [secretMcp], skills: [{ layer: "x", item: { name: "db", dir: `${f.dir}/skill` } }] };
  const { result } = renderFor(ADAPTERS.claude, { cfg, target: { scope: "global" }, title: "t" }, machineOf(f), { TOKEN: "opaque-secret-123" });
  expect(result.files.find((x) => x.mode === "own")?.sensitive).toBe(true);
});

test.skipIf(win)("С1: исполняемый секретный файл — 0700, второй план пуст", () => {
  const f = cliFixture();
  const result = { warnings: [], files: [{ base: "home" as const, path: "s.sh", mode: "own" as const, content: "x", executable: true, sensitive: true }] };
  const state = apply(plan(result, { scope: "global" }, machineOf(f), emptyState(), false), emptyState()).state;
  expect(statSync(`${f.home}/s.sh`).mode & 0o777).toBe(0o700);
  expect(plan(result, { scope: "global" }, machineOf(f), state, false)).toEqual([]);
});

test.skipIf(win)("С9: закрытый от группы и остальных файл (exFAT даёт 0700) не переписывается", () => {
  const f = cliFixture();
  const result = { warnings: [], files: [{ base: "home" as const, path: "c.json", mode: "own" as const, content: "x", sensitive: true }] };
  const state = apply(plan(result, { scope: "global" }, machineOf(f), emptyState(), false), emptyState()).state;
  chmodSync(`${f.home}/c.json`, 0o700);
  expect(plan(result, { scope: "global" }, machineOf(f), state, false)).toEqual([]);
});

test.skipIf(win)("С1: исправление только прав — chmod без перезаписи и бэкапа", () => {
  const f = cliFixture();
  const result = { warnings: [], files: [{ base: "home" as const, path: "c.json", mode: "own" as const, content: "x", sensitive: true }] };
  const state = apply(plan(result, { scope: "global" }, machineOf(f), emptyState(), false), emptyState()).state;
  chmodSync(`${f.home}/c.json`, 0o644);
  const actions = plan(result, { scope: "global" }, machineOf(f), state, false);
  expect(actions.map((a) => a.kind)).toEqual(["chmod"]);
  newBackupRun();
  apply(actions, state);
  expect(runDir()).toBeNull();
  expect(statSync(`${f.home}/c.json`).mode & 0o777).toBe(0o600);
});

test.skipIf(win)("С1: права merge-файла — chmod, а не пустое «слить» с бэкапом", () => {
  const f = cliFixture();
  const result = { warnings: [], files: [{ base: "home" as const, path: "m.json", mode: "merge" as const, format: "json" as const, key: ["mcp"], data: { s: 1 }, sensitive: true }] };
  const state = apply(plan(result, { scope: "global" }, machineOf(f), emptyState(), false), emptyState()).state;
  chmodSync(`${f.home}/m.json`, 0o644);
  const actions = plan(result, { scope: "global" }, machineOf(f), state, false);
  expect(actions.map((a) => a.kind)).toEqual(["chmod"]);
});

test("С6: отказ по exclude не снимает sensitive с домашнего merge Claude", () => {
  const f = cliFixture();
  const dir = `${f.ws}/Org/p1`;
  const ex = `${dir}/.git/info/exclude`;
  unlinkSync(ex);
  put(`${dir}/outside-exclude`, "external\n");
  symlinkSync(`${dir}/outside-exclude`, ex, "file");
  const target = { scope: "project" as const, dir, rel: "Org/p1" };
  const cfg = { ...none, mcp: [secretMcp] };
  const { result } = renderFor(ADAPTERS.claude, { cfg, target, title: "t" }, machineOf(f), { TOKEN: "opaque-secret-123" });
  const actions = plan(result, target, machineOf(f), emptyState(), false, "claude");
  expect(actions.some((a) => a.kind === "conflict" && a.abs.includes("exclude"))).toBe(true);
  const merge = actions.find((a) => a.kind === "merge");
  expect(merge?.sensitive).toBe(true);
  if (!win) {
    apply(actions, emptyState());
    expect(statSync(`${f.home}/.claude.json`).mode & 0o777).toBe(0o600);
  }
});

for (const id of ["claude", "codex", "opencode"]) test.skipIf(win)(`С10: keep единственного MCP ${id} исправляет права глобального файла`, () => {
  const f = cliFixture();
  const cfg = { ...none, mcp: [secretMcp] };
  const t = { cfg, target: { scope: "global" as const }, title: "t" };
  const first = renderFor(ADAPTERS[id], t, machineOf(f), { TOKEN: "opaque-secret-123" });
  const state = apply(plan(first.result, t.target, machineOf(f), emptyState(), false, id), emptyState()).state;
  const path = id === "claude" ? `${f.home}/.claude.json` : id === "codex" ? `${f.home}/.codex/config.toml` : `${f.home}/.config/opencode/opencode.json`;
  chmodSync(path, 0o644);
  const second = renderFor(ADAPTERS[id], t, machineOf(f), {}, state);
  const actions = plan(second.result, t.target, machineOf(f), state, false, id);
  expect(actions.map((a) => a.kind)).toEqual(["chmod"]);
  apply(actions, state);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});
