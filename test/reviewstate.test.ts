import { expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { apply, plan } from "../src/apply";
import { canonical } from "../src/paths";
import { emptyState, sha } from "../src/manifest";
import { ADAPTERS, renderFor } from "../src/registry";
import { compare } from "../src/sync";
import { cliFixture, put } from "./helpers";

for (const id of ["codex", "opencode", "antigravity"]) for (const last of [false, true]) test(`R2: ${id} keep own, последний=${last}`, () => {
  const f = cliFixture();
  const target = { scope: "project" as const, dir: `${f.ws}/Org/p1`, rel: "Org/p1" };
  const machine = { home: f.home, workspace: f.ws, os: "linux" as const, vars: {} };
  const cfg = { layers: [], instructions: [], skills: [], notes: [], mcp: [
    { layer: "x", item: { name: "secret", command: "echo", env: { TOKEN: "${TOKEN}" } } },
    ...(!last ? [{ layer: "x", item: { name: "plain", command: "echo", args: ["old"] } }] : []),
  ] };
  const adapter = ADAPTERS[id];
  const first = renderFor(adapter, { target, cfg, title: "t" }, machine, { TOKEN: "artificial-value" });
  const state = apply(plan(first.result, target, machine, emptyState(), false, id), emptyState()).state;
  if (!last) cfg.mcp[1].item.args = ["new"];
  const second = renderFor(adapter, { target, cfg, title: "t" }, machine, {}, state);
  const next = apply(plan(second.result, target, machine, state, false, id), state).state;
  const path = id === "codex" ? ".codex/config.toml" : id === "opencode" ? "opencode.json" : ".agents/plugins/miksy/mcp_config.json";
  const text = readFileSync(`${target.dir}/${path}`, "utf8");
  // Пропущенный сервер остаётся обёрткой (значения в конфиге нет), обёртка — на месте
  expect(text).not.toContain("artificial-value");
  const wrapper = (text.replace(/\\+/g, "/").match(/[^"' [\]]*local\/run\/[^"' [\]]+/) ?? [])[0];
  expect(wrapper).toBeDefined();
  expect(existsSync(wrapper!)).toBe(true);
  if (!last) { expect(text).toContain("new"); expect(text).not.toContain('"old"'); }
  expect(plan(second.result, target, machine, next, false, id)).toEqual([]);
});

test("Н2: перенос ручной правки в слой обновляет учёт без перезаписи", () => {
  const f = cliFixture();
  const path = canonical(`${f.home}/owned`);
  put(path, "new");
  const prev = emptyState(); prev.files[path] = sha("old");
  const result = { warnings: [], files: [{ base: "home" as const, path: "owned", mode: "own" as const, content: "new" }] };
  const machine = { home: f.home, workspace: f.ws, os: "linux" as const, vars: {} };
  const actions = plan(result, { scope: "global" }, machine, prev, false);
  expect(actions.some((a) => a.kind === "write")).toBe(false);
  expect(apply(actions, prev).state.files[path]).toBe(sha("new"));
});

test("Н3: конфликтный чужой файл не скрывается exclude", () => {
  const f = cliFixture();
  put(`${f.ws}/Org/p1/CLAUDE.local.md`, "<!-- miksy:begin инструкции -->\nmine\n<!-- miksy:end -->\n");
  const r = f.run(["sync", `${f.ws}/Org/p1`]);
  expect(r.code).toBe(3);
  expect(readFileSync(`${f.ws}/Org/p1/.git/info/exclude`, "utf8")).not.toContain("/CLAUDE.local.md");
});

test("R5/Н4: compare маскирует старые args и массив command opencode", () => {
  for (const id of ["claude", "opencode"]) {
    const old = "oldOpaqueCredential123";
    const def = id === "opencode" ? { command: ["echo", "--token", old] } : { command: "echo", args: ["--token", old] };
    const cfg = { layers: [], instructions: [], skills: [], notes: [], mcp: [{ layer: "x", item: { name: "s", command: "other", args: ["--token", "<secret:TOKEN>"] } }] };
    const text = compare(ADAPTERS[id], cfg, { instructionFiles: [], mcp: { s: { source: "home", def } } }).join("\n");
    expect(text).not.toContain(old);
  }
});

test.skipIf(process.platform === "win32")("Н1: сбой записи JSON оставляет прежний учёт", () => {
  const f = cliFixture();
  const path = `${f.home}/mcp.json`;
  put(path, JSON.stringify({ mcp: { s: { command: "echo" } } }));
  const prev = emptyState(); prev.merges[canonical(path)] = { '["mcp"]': ["s"] };
  const machine = { home: f.home, workspace: f.ws, os: "linux" as const, vars: {} };
  const actions = plan({ files: [], warnings: [] }, { scope: "global" }, machine, prev, false);
  chmodSync(f.home, 0o500);
  try {
    let error: any;
    try { apply(actions, prev); } catch (e) { error = e; }
    expect(error).toBeDefined();
    expect(error.partialState.merges).toEqual(prev.merges);
    expect(JSON.parse(readFileSync(path, "utf8")).mcp.s).toBeDefined();
  } finally { chmodSync(f.home, 0o700); }
});
