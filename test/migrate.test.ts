// Миграция учёта (фаза 1.6, С5): одно отображение старый→новый, конфликт хешей — одной записи
import { expect, test } from "bun:test";
import { existsSync, readFileSync, renameSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import { apply, plan } from "../src/apply";
import { canonical } from "../src/paths";
import { canonicalState, emptyState, loadManifest, saveManifest, sha, UNKNOWN_HASH } from "../src/manifest";
import { cliFixture, put } from "./helpers";

const dirLink = process.platform === "win32" ? "junction" : "dir";
const nothing = { files: [], warnings: [] };

test("С5(а): после переезда родителя ссылка остаётся под ключом файла — цель живой ссылки не удаляется", () => {
  const f = cliFixture();
  const machine = { home: f.home, workspace: f.ws, os: "linux" as const, vars: {} };
  put(`${f.home}/old/data`, "owned");
  symlinkSync(`${f.home}/old/data`, `${f.home}/logical`, "file");
  const st = emptyState();
  st.files[`${f.home}/logical`] = sha("owned");
  const first = canonicalState(st);
  renameSync(`${f.home}/old`, `${f.home}/new`);
  symlinkSync(`${f.home}/new`, `${f.home}/old`, dirLink);
  const second = canonicalState(JSON.parse(JSON.stringify(first)));
  const key = canonical(`${f.home}/new/data`);
  expect(Object.keys(second.files)).toEqual([key]);
  expect(Object.keys(second.links ?? {})).toEqual([key]);
  const actions = plan(nothing, { scope: "global" }, machine, second, false);
  expect(actions.some((a) => a.kind === "delete")).toBe(false);
  apply(actions, second);
  expect(readFileSync(`${f.home}/new/data`, "utf8")).toBe("owned");
});

test("С5(в): разные хеши одного пути — «хеш неизвестен» для записи, остальной учёт работает", () => {
  const f = cliFixture({ projects: ["Org/a"] });
  const a = `${f.ws}/Org/a`;
  symlinkSync(a, `${f.ws}/Org/b`, dirLink);
  put(`${a}/CLAUDE.local.md`, "current");
  const sa = emptyState(), sb = emptyState(), g = emptyState();
  sa.files[`${a}/CLAUDE.local.md`] = sha("v1");
  sb.files[`${f.ws}/Org/b/CLAUDE.local.md`] = sha("v2");
  put(`${f.home}/x`, "x");
  g.files[`${f.home}/x`] = sha("x");
  const path = `${f.config}/m.json`;
  put(path, JSON.stringify({ version: 1, targets: { [`claude|${a}`]: sa, [`claude|${f.ws}/Org/b`]: sb, "claude|global": g } }));
  const m = loadManifest(path);
  const st = m.targets[`claude|${canonical(a)}`];
  expect(st.files[canonical(`${a}/CLAUDE.local.md`)]).toBe(UNKNOWN_HASH);
  expect(Object.values(m.targets["claude|global"].files)).toEqual([sha("x")]);
  const target = { scope: "project" as const, dir: a, rel: "Org/a" };
  const machine = { home: f.home, workspace: f.ws, os: "linux" as const, vars: {} };
  const result = { warnings: [], files: [{ base: "project" as const, path: "CLAUDE.local.md", mode: "own" as const, content: "new" }] };
  const actions = plan(result, target, machine, st, false, "claude");
  expect(actions.find((x) => x.abs.endsWith("CLAUDE.local.md"))?.kind).toBe("conflict");
  expect(plan(result, target, machine, st, true, "claude").some((x) => x.kind === "write")).toBe(true);
  // Запись, совпадающая с диском, выигрывает
  sb.files[`${f.ws}/Org/b/CLAUDE.local.md`] = sha("current");
  put(path, JSON.stringify({ version: 1, targets: { [`claude|${a}`]: sa, [`claude|${f.ws}/Org/b`]: sb } }));
  expect(loadManifest(path).targets[`claude|${canonical(a)}`].files[canonical(`${a}/CLAUDE.local.md`)]).toBe(sha("current"));
});

test("С5(б): alias, который теперь ведёт в другое репо, не защищает исходный файл", () => {
  const f = cliFixture();
  const repo = `${f.dir}/repo`, other = `${f.dir}/other`, alias = `${f.dir}/alias`;
  put(`${repo}/owned`, "old");
  put(`${other}/owned`, "team");
  Bun.spawnSync(["git", "init", "--quiet", other]);
  Bun.spawnSync(["git", "-C", other, "add", "owned"]);
  symlinkSync(repo, alias, dirLink);
  const st = emptyState();
  st.files[`${alias}/owned`] = sha("old");
  const prev = canonicalState(st);
  expect(prev.aliases?.[canonical(`${repo}/owned`)]).toBeDefined();
  if (process.platform === "win32") rmdirSync(alias); else unlinkSync(alias);
  symlinkSync(other, alias, dirLink);
  const result = { warnings: [], files: [{ base: "home" as const, path: "owned", mode: "own" as const, content: "new" }] };
  const actions = plan(result, { scope: "global" }, { home: repo, workspace: f.ws, os: "linux", vars: {} }, prev, false);
  expect(actions.map((x) => x.kind)).toEqual(["write"]);
});

test("С5(г): delete чистит aliases и links удалённого файла", () => {
  const f = cliFixture();
  const machine = { home: f.home, workspace: f.ws, os: "linux" as const, vars: {} };
  put(`${f.home}/real/keep`, "k");
  symlinkSync(`${f.home}/real`, `${f.home}/via`, dirLink);
  const result = { warnings: [], files: [{ base: "home" as const, path: "via/a", mode: "own" as const, content: "x" }] };
  const state = apply(plan(result, { scope: "global" }, machine, emptyState(), false), emptyState()).state;
  expect(Object.keys(state.aliases ?? {})).toEqual([canonical(`${f.home}/real/a`)]);
  const after = apply(plan(nothing, { scope: "global" }, machine, state, false), state).state;
  expect(existsSync(`${f.home}/real/a`)).toBe(false);
  expect(after.aliases).toBeUndefined();
  expect(after.links).toBeUndefined();
});

test("С5: перед записью учёта — копия manifest.json.bak", () => {
  const f = cliFixture();
  const path = `${f.config}/local/state/manifest.json`;
  put(path, JSON.stringify({ version: 1, targets: {} }));
  saveManifest({ version: 1, targets: { "claude|global": emptyState() } }, path);
  expect(JSON.parse(readFileSync(`${path}.bak`, "utf8")).targets).toEqual({});
});
