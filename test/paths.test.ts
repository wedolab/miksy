import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, symlinkSync } from "node:fs";
import { canonical } from "../src/bounds";
import { apply, plan } from "../src/apply";
import { readFileSync } from "node:fs";
import { trackedBy } from "../src/git";
import { configRoot, containsProjects, loadMachine } from "../src/load";
import { emptyState, loadManifest, sha } from "../src/manifest";
import { targetId } from "../src/registry";
import { claude } from "../adapters/claude";
import { unsafeWorkspace } from "../src/setup";
import { cliFixture, put } from "./helpers";

function linked() {
  const f = cliFixture();
  const alias = `${f.dir}/alias`;
  symlinkSync(f.dir, alias, process.platform === "win32" ? "junction" : "dir");
  return { ...f, alias };
}

test("П1/П7: config, home и workspace канонические, backups под junction не проекты", () => {
  const f = linked();
  const saved = { ...process.env };
  try {
    process.env.MIKSY_CONFIG = `${f.alias}/config`;
    process.env.HOME = process.env.USERPROFILE = `${f.alias}/home`;
    put(`${f.config}/local/machine.yaml`, `workspace: ${JSON.stringify(`${f.alias}/ws`)}\n`);
    Bun.spawnSync(["git", "init", "--quiet", `${f.config}/local/backups/x/repo`]);
    expect(configRoot()).toBe(canonical(f.config));
    expect(loadMachine().home).toBe(canonical(f.home));
    expect(loadMachine().workspace).toBe(canonical(f.ws));
    expect(containsProjects(canonical(f.config))).toBe(false);
  } finally { process.env = saved; }
});

test("R4: git получает относительный путь между каноническими концами", () => {
  const f = linked();
  const p = `${f.ws}/Org/p1`;
  put(`${p}/tracked`, "team");
  Bun.spawnSync(["git", "-C", p, "add", "tracked"]);
  expect(trackedBy(`${f.alias}/ws/Org/p1/untracked`)).toBeNull();
  expect(trackedBy(`${f.alias}/ws/Org/p1/tracked`)).toBe(canonical(p));
});

test("П2: workspace через ссылку на домашний каталог опасен", () => {
  const f = linked();
  expect(unsafeWorkspace(`${f.alias}/home`, f.home)).toBe("домашний каталог");
});

test("П3: старые ключи manifest и targetId сходятся через junction", () => {
  const f = linked();
  const real = `${f.ws}/Org/p1`;
  const alias = `${f.alias}/ws/Org/p1`;
  put(`${real}/owned`, "x");
  const st = emptyState();
  st.files[`${alias}/owned`] = sha("x");
  const path = `${f.config}/manifest.json`;
  put(path, JSON.stringify({ version: 1, targets: { [`claude|${alias}`]: st } }));
  const id = targetId(claude, { scope: "project", dir: real, rel: "Org/p1" });
  expect(targetId(claude, { scope: "project", dir: alias, rel: "Org/p1" })).toBe(id);
  const loaded = loadManifest(path);
  expect(Object.keys(loaded.targets)).toEqual([id]);
  expect(Object.values(loaded.targets[id].files)).toEqual([sha("x")]);
  expect(Object.keys(loaded.targets[id].files)[0]).not.toContain("/alias/");
});

test("П3: clean через alias сохраняет exclude конфликтного файла", () => {
  const f = linked();
  const dir = `${f.alias}/ws/Org/p1`;
  const target = { scope: "project" as const, dir, rel: "Org/p1" };
  const machine = { home: f.home, workspace: f.ws, os: "linux" as const, vars: {} };
  const files = [{ base: "project" as const, path: "owned", mode: "own" as const, content: "old" }];
  const state = apply(plan({ files, warnings: [] }, target, machine, emptyState(), false), emptyState()).state;
  put(`${dir}/owned`, "manual");
  const actions = plan({ files: [], warnings: [] }, target, machine, state, false);
  apply(actions, state);
  expect(readFileSync(`${dir}/.git/info/exclude`, "utf8")).toContain("/owned");
});

test("П3: миграция alias объединяет имена merge и не вызывает записей", () => {
  const f = linked();
  const path = `${f.home}/mcp.json`;
  put(path, JSON.stringify({ mcp: { a: 1, b: 2 } }));
  chmodSync(path, 0o600); // файл с MCP закрыт, как после sync: проверяется только миграция
  const a = emptyState(), b = emptyState();
  a.merges[`${f.alias}/home/mcp.json`] = { '["mcp"]': ["a"] };
  b.merges[path] = { '["mcp"]': ["b"] };
  const file = `${f.config}/manifest.json`;
  put(file, JSON.stringify({ version: 1, targets: { [`claude|${f.alias}/ws/Org/p1`]: a, [`claude|${f.ws}/Org/p1`]: b } }));
  const states = Object.values(loadManifest(file).targets);
  expect(states).toHaveLength(1);
  const result = { warnings: [], files: [{ base: "home" as const, path: "mcp.json", mode: "merge" as const, format: "json" as const, key: ["mcp"], data: { a: 1, b: 2 } }] };
  const actions = plan(result, { scope: "global" }, { home: f.home, workspace: f.ws, os: "linux", vars: {} }, states[0], false);
  expect(actions).toEqual([]);
});
