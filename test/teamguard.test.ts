import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync } from "node:fs";
import { plan, apply } from "../src/apply";
import { emptyState, loadManifest, sha } from "../src/manifest";
import { cliFixture, put } from "./helpers";

function fixture() {
  const f = cliFixture();
  const dir = `${f.ws}/Org/p1`;
  const machine = { workspace: f.ws, home: f.home, os: "linux" as const, vars: {} };
  const target = { scope: "project" as const, dir, rel: "Org/p1" };
  const make = (path: string) => plan({ warnings: [], files: [{ base: "project", path, mode: "own", content: "personal" }] }, target, machine, emptyState(), true);
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args]);
  return { ...f, dir, make, git };
}

test("R3: неотслеживаемый симлинк на файл команды — конфликт даже force", () => {
  const f = fixture();
  put(`${f.dir}/team.md`, "team");
  f.git("add", "team.md");
  symlinkSync(`${f.dir}/team.md`, `${f.dir}/CLAUDE.local.md`, "file");
  const actions = f.make("CLAUDE.local.md");
  expect(actions.some((a) => a.kind === "conflict")).toBe(true);
  apply(actions, emptyState());
  expect(readFileSync(`${f.dir}/team.md`, "utf8")).toBe("team");
});

test("П4: отслеживаемая ссылка-каталог не канал доставки личных skills", () => {
  const f = fixture();
  mkdirSync(`${f.dir}/.agents/skills`, { recursive: true });
  mkdirSync(`${f.dir}/.claude`);
  symlinkSync(`${f.dir}/.agents/skills`, `${f.dir}/.claude/skills`, process.platform === "win32" ? "junction" : "dir");
  // Индекс симлинка, включая Windows с core.symlinks=false.
  const blob = f.git("hash-object", "-w", "--stdin");
  f.git("update-index", "--add", "--cacheinfo", `120000,${blob.stdout.toString().trim()},.claude/skills`);
  const actions = f.make(".claude/skills/personal/SKILL.md");
  expect(actions.some((a) => a.kind === "conflict")).toBe(true);
  apply(actions, emptyState());
  expect(existsSync(`${f.dir}/.agents/skills/personal/SKILL.md`)).toBe(false);
});

test("R3: GIT_INDEX_FILE чужого репо не отключает защиту", () => {
  const f = fixture();
  put(`${f.dir}/CLAUDE.local.md`, "team");
  f.git("add", "CLAUDE.local.md");
  const saved = process.env.GIT_INDEX_FILE;
  process.env.GIT_INDEX_FILE = `${f.dir}/unrelated-index`;
  try { expect(f.make("CLAUDE.local.md").some((a) => a.kind === "conflict")).toBe(true); }
  finally { if (saved === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = saved; }
});

test("П6: exclude через внешний симлинк — конфликт, внешний файл неизменен", () => {
  const f = fixture();
  const ex = `${f.dir}/.git/info/exclude`;
  unlinkSync(ex);
  put(`${f.dir}/outside-exclude`, "external\n");
  symlinkSync(`${f.dir}/outside-exclude`, ex, "file");
  const actions = f.make("CLAUDE.local.md");
  expect(actions.some((a) => a.kind === "conflict" && a.abs.includes("exclude"))).toBe(true);
  apply(actions, emptyState());
  expect(readFileSync(`${f.dir}/outside-exclude`, "utf8")).toBe("external\n");
});

test("R3/С23: совпадение регистром — конфликт, если это не два разных существующих файла", () => {
  const f = fixture();
  put(`${f.dir}/Opencode.json`, "team");
  f.git("add", "Opencode.json");
  // Регистрозависимая ФС: opencode.json ещё нет — отдельного файла нет, конфликт (безопасная сторона)
  expect(f.make("opencode.json").some((a) => a.kind === "conflict")).toBe(true);
  if (!existsSync(`${f.dir}/opencode.json`)) {
    put(`${f.dir}/opencode.json`, "mine");
    expect(f.make("opencode.json").some((a) => a.kind === "conflict")).toBe(false);
  }
});

test("С23: отслеживаемый файл в другом регистре, удалённый из рабочей копии, — конфликт даже force", () => {
  const f = fixture();
  put(`${f.dir}/Opencode.json`, "team");
  f.git("add", "Opencode.json");
  unlinkSync(`${f.dir}/Opencode.json`);
  const actions = f.make("opencode.json");
  expect(actions.some((a) => a.kind === "conflict")).toBe(true);
  expect(actions.some((a) => a.kind === "write")).toBe(false);
});

test("битая ссылка секретного конфига — конфликт цели, не падение планировщика", () => {
  const f = fixture();
  symlinkSync(`${f.dir}/missing`, `${f.dir}/config`, "file");
  const actions = plan({ warnings: [], files: [{ base: "project", path: "config", mode: "own", content: "artificial", sensitive: true }] },
    { scope: "project", dir: f.dir, rel: "p" }, { home: f.home, workspace: f.ws, os: "linux", vars: {} }, emptyState(), false);
  expect(actions.some((a) => a.kind === "conflict")).toBe(true);
  expect(actions.some((a) => a.kind === "write")).toBe(false);
});

test("R3: TOML проверяет логическую ссылку команды до канонизации ключа учёта", () => {
  const f = fixture();
  put(`${f.dir}/personal.toml`, "# personal\n");
  symlinkSync(`${f.dir}/personal.toml`, `${f.dir}/config.toml`, "file");
  const blob = f.git("hash-object", "-w", "--stdin");
  f.git("update-index", "--add", "--cacheinfo", `120000,${blob.stdout.toString().trim()},config.toml`);
  const actions = plan({ warnings: [], files: [{ base: "home", path: "config.toml", mode: "merge", format: "toml", key: ["mcp_servers"], data: { s: { command: "echo" } } }] },
    { scope: "global" }, { home: f.dir, workspace: f.ws, os: "linux", vars: {} }, emptyState(), true);
  expect(actions.some((a) => a.kind === "conflict")).toBe(true);
  expect(actions.some((a) => a.kind === "toml")).toBe(false);
  apply(actions, emptyState());
  expect(readFileSync(`${f.dir}/personal.toml`, "utf8")).toBe("# personal\n");
});

test("П3/П4: миграция учёта сохраняет защиту логического пути при clean", () => {
  const f = fixture();
  put(`${f.dir}/physical/personal/SKILL.md`, "old");
  symlinkSync(`${f.dir}/physical`, `${f.dir}/logical`, process.platform === "win32" ? "junction" : "dir");
  const blob = f.git("hash-object", "-w", "--stdin");
  f.git("update-index", "--add", "--cacheinfo", `120000,${blob.stdout.toString().trim()},logical`);
  const st = emptyState();
  st.files[`${f.dir}/logical/personal/SKILL.md`] = sha("old");
  const manifest = `${f.config}/old.json`;
  put(manifest, JSON.stringify({ version: 1, targets: { [`claude|${f.dir}`]: st } }));
  const prev = Object.values(loadManifest(manifest).targets)[0];
  const actions = plan({ warnings: [], files: [] }, { scope: "project", dir: f.dir, rel: "p" },
    { home: f.home, workspace: f.ws, os: "linux", vars: {} }, prev, true);
  expect(actions.some((a) => a.kind === "conflict")).toBe(true);
  expect(actions.some((a) => a.kind === "delete")).toBe(false);
  apply(actions, prev);
  expect(readFileSync(`${f.dir}/physical/personal/SKILL.md`, "utf8")).toBe("old");
});
