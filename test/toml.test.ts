import { canonical } from "../src/paths";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { apply, plan, verifyMerges } from "../src/apply";
import { emptyState } from "../src/manifest";
import { mcpTables, replaceTomlBlock, splitToml, TOML_BEGIN, TOML_END, tomlValue } from "../src/toml";
import type { RenderResult } from "../src/adapter";

const temp = mkdtempSync(join(tmpdir(), "toml-test-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const target = { scope: "global" as const };
function fixture(prefix = '# keep exactly\r\nmodel = "user-model" # own comment\r\n[features]\r\nshell_tool = true\r\n') {
  const home = mkdtempSync(join(temp, "home-"));
  mkdirSync(join(home, ".codex"));
  const path = join(home, ".codex/config.toml").replaceAll("\\", "/");
  writeFileSync(path, prefix);
  return { home, path, prefix, machine: { home, workspace: home, os: "windows" as const, vars: {} } };
}
const result = (data: Record<string, unknown>): RenderResult => ({ files: [
  { base: "home", path: ".codex/config.toml", mode: "merge", format: "toml", key: ["mcp_servers"], data },
], warnings: [] });
const empty: RenderResult = { files: [], warnings: [] };

describe("TOML block", () => {
  test("quoted keys, Windows paths, nested raw, Unicode, escaping roundtrip", () => {
    const servers = { 'a.b"c': { command: 'C:\\Program Files\\tool.exe', args: ['a\nb\t"c', 'Русский'], env: { 'a.b': 'token' }, enabled: false,
      tools: { read: { approval_mode: "prompt" } }, arbitrary: [{ k: "v" }] } };
    expect(Bun.TOML.parse(mcpTables(servers))).toEqual({ mcp_servers: servers });
    expect(Bun.TOML.parse(`developer_instructions = ${tomlValue("line 1\nline 2\r\n'quotes' \\")}`)).toEqual({ developer_instructions: "line 1\nline 2\r\n'quotes' \\" });
    expect(() => tomlValue(null)).toThrow();
    expect(() => tomlValue(Infinity)).toThrow();
  });

  test("sync, repeat, update, clean: external text byte-for-byte preserved", () => {
    const { path, machine, prefix } = fixture();
    const r = result({ one: { command: "bin", env: { TOKEN: "test-secret" } } });
    const { state } = apply(plan(r, target, machine, emptyState(), false), emptyState());
    const text = readFileSync(path, "utf8");
    expect(splitToml(text).outside).toBe(prefix);
    expect(Bun.TOML.parse(text).model).toBe("user-model");
    expect(verifyMerges(state)).toEqual([]);
    expect(plan(r, target, machine, state, false)).toEqual([]);
    // Пользователь изменил свой prefix после sync; обновление блока сохраняет его.
    writeFileSync(path, text.replace("user-model", "changed-model"));
    const { state: updated } = apply(plan(result({ two: { url: "https://example.com", http_headers: { Authorization: "Bearer value" } } }), target, machine, state, false), state);
    expect(Object.keys(Bun.TOML.parse(readFileSync(path, "utf8")).mcp_servers as object)).toEqual(["two"]);
    const { state: cleaned } = apply(plan(empty, target, machine, updated, false), updated);
    expect(readFileSync(path, "utf8")).toBe(prefix.replace("user-model", "changed-model"));
    expect(cleaned).toEqual(emptyState());
  });

  test("prefix without final newline is restored exactly", () => {
    const { path, machine, prefix } = fixture('model="x"');
    const { state } = apply(plan(result({ a: { command: "bin" } }), target, machine, emptyState(), false), emptyState());
    apply(plan(empty, target, machine, state, false), state);
    expect(readFileSync(path, "utf8")).toBe(prefix);
  });

  test("external name is always a conflict, even identical and --force", () => {
    const { path, machine, prefix } = fixture('[mcp_servers.same]\ncommand="bin"\n');
    for (const force of [false, true]) {
      const actions = plan(result({ same: { command: "bin" } }), target, machine, emptyState(), force);
      expect(actions).toEqual([expect.objectContaining({ kind: "conflict" })]);
      apply(actions, emptyState());
      expect(readFileSync(path, "utf8")).toBe(prefix);
    }
  });

  test("manual block edits are detected by sync, clean and verification", () => {
    const { path, machine } = fixture();
    const r = result({ a: { command: "bin" } });
    const { state } = apply(plan(r, target, machine, emptyState(), false), emptyState());
    writeFileSync(path, readFileSync(path, "utf8").replace('"bin"', '"edited"'));
    expect(plan(r, target, machine, state, false)[0].kind).toBe("conflict");
    expect(plan(empty, target, machine, state, false)[0].kind).toBe("conflict");
    expect(verifyMerges(state).length).toBeGreaterThan(0);
    const { state: forced } = apply(plan(r, target, machine, state, true), state);
    expect(verifyMerges(forced)).toEqual([]);
  });

  test("unowned block conflicts even with force; clean ignores unowned block", () => {
    const { path, machine } = fixture();
    writeFileSync(path, replaceTomlBlock(splitToml(readFileSync(path, "utf8")), { a: { command: "bin" } }));
    expect(plan(result({ a: { command: "bin" } }), target, machine, emptyState(), false)[0].kind).toBe("conflict");
    expect(plan(empty, target, machine, emptyState(), false)).toEqual([]);
    expect(plan(result({ a: { command: "bin" } }), target, machine, emptyState(), true).map((a) => a.kind)).toEqual(["conflict"]);
  });

  test("broken/duplicate markers, alien tables, string markers rejected; comment after block is fine", () => {
    const good = replaceTomlBlock(splitToml('model="x"\n'), { a: { command: "bin" } });
    expect(splitToml(good + "# trailing\n").after).toBe("# trailing\n");
    for (const text of [good + good, good.replace(TOML_END, ""),
      `\n${TOML_BEGIN}\n[features]\nx=true\n${TOML_END}\n`,
      `\n${TOML_BEGIN}\n[mcp_servers]\na={command="bin"}\n${TOML_END}\n`,
      `description='''\n${TOML_BEGIN}\n[mcp_servers.a]\ncommand="bin"\n${TOML_END}\n'''\n`]) {
      const { machine } = fixture(text);
      expect(plan(result({ b: { command: "new" } }), target, machine, emptyState(), true)[0].kind).toBe("conflict");
    }
  });

  test("inline closed parent table and malformed TOML do not get overwritten", () => {
    for (const prefix of ['mcp_servers = { existing = {command="bin"} }\n', 'secret="do-not-print\n']) {
      const { path, machine } = fixture(prefix);
      const actions = plan(result({ other: { command: "bin" } }), target, machine, emptyState(), true);
      expect(actions[0].kind).toBe("conflict");
      expect(JSON.stringify(actions)).not.toContain("do-not-print");
      expect(readFileSync(path, "utf8")).toBe(prefix);
    }
  });

  test("Codex дописал trust после блока: повтор без изменений, обновление и clean сохраняют хвост", () => {
    const { path, machine, prefix } = fixture();
    const { state } = apply(plan(result({ a: { command: "bin" } }), target, machine, emptyState(), false), emptyState());
    const tail = '[projects."D:\\\\work\\\\x"]\ntrust_level = "trusted"\n';
    writeFileSync(path, readFileSync(path, "utf8") + tail);
    expect(plan(result({ a: { command: "bin" } }), target, machine, state, false)).toEqual([]);
    expect(verifyMerges(state)).toEqual([]);
    const { state: updated } = apply(plan(result({ b: { command: "new" } }), target, machine, state, false), state);
    const text = readFileSync(path, "utf8");
    expect(text.endsWith(tail)).toBe(true);
    expect(Object.keys(Bun.TOML.parse(text).mcp_servers as object)).toEqual(["b"]);
    expect((Bun.TOML.parse(text).projects as Record<string, { trust_level: string }>)["D:\\work\\x"].trust_level).toBe("trusted");
    apply(plan(empty, target, machine, updated, false), updated);
    expect(readFileSync(path, "utf8")).toBe(prefix + tail);
  });

  test("clean при префиксе без перевода строки и хвосте после блока — строки не склеиваются", () => {
    const { path, machine } = fixture('model="x"');
    const { state } = apply(plan(result({ a: { command: "bin" } }), target, machine, emptyState(), false), emptyState());
    writeFileSync(path, readFileSync(path, "utf8") + '[projects.p]\ntrust_level="trusted"\n');
    apply(plan(empty, target, machine, state, false), state);
    expect(Bun.TOML.parse(readFileSync(path, "utf8"))).toEqual({ model: "x", projects: { p: { trust_level: "trusted" } } });
  });

  test("хвост без заголовка таблицы продолжил бы таблицу блока — конфликт", () => {
    const good = replaceTomlBlock(splitToml('model="x"\n'), { a: { command: "bin" } });
    for (const tail of ['model = "y"\n', "# comment\nenabled = false\n"]) {
      const { machine } = fixture(good + tail);
      expect(plan(result({ b: { command: "new" } }), target, machine, emptyState(), true)[0].kind).toBe("conflict");
    }
  });

  test("concurrent edit between plan and apply aborts without overwriting", () => {
    const { path, machine } = fixture();
    const actions = plan(result({ a: { command: "bin" } }), target, machine, emptyState(), false);
    writeFileSync(path, 'model="concurrent"\n');
    expect(() => apply(actions, emptyState())).toThrow("после планирования");
    expect(readFileSync(path, "utf8")).toBe('model="concurrent"\n');
  });
});
