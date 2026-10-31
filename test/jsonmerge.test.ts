import { canonical } from "../src/paths";
// JSON-merge: файл изменился между планом и записью — повтор плана или конфликт; битый JSON — конфликт цели
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RenderResult, Target } from "../src/adapter";
import { apply, applyPlanned, plan, verifyMerges } from "../src/apply";
import { emptyState } from "../src/manifest";
import { cliFixture, put } from "./helpers";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "jm-")).replaceAll("\\", "/");
  mkdirSync(`${home}/p/.git/info`, { recursive: true });
  const machine = { workspace: home, os: "linux" as const, home, vars: {} };
  const target: Target = { scope: "project", dir: `${home}/p`, rel: "p" };
  return { home, machine, target, cfg: `${home}/.claude.json` };
}
const result = (data: Record<string, unknown>): RenderResult => ({
  warnings: [],
  files: [
    { base: "project", path: "CLAUDE.local.md", mode: "own", content: "x\n" },
    { base: "home", path: ".claude.json", mode: "merge", format: "json", key: ["mcpServers"], data },
  ],
});

describe("JSON-merge", () => {
  test("битый JSON — конфликт этого файла, остальное планируется", () => {
    const f = fixture();
    writeFileSync(f.cfg, "{ broken");
    const actions = plan(result({ a: { url: "u" } }), f.target, f.machine, emptyState(), false);
    expect(actions.find((a) => a.abs === canonical(f.cfg))).toMatchObject({ kind: "conflict", why: expect.stringContaining("JSON") });
    expect(actions.some((a) => a.kind === "write")).toBe(true);
    apply(actions, emptyState());
    expect(readFileSync(f.cfg, "utf8")).toBe("{ broken");
  });

  test("verifyMerges на битом файле не падает", () => {
    const f = fixture();
    writeFileSync(f.cfg, "{ broken");
    expect(verifyMerges({ ...emptyState(), merges: { [f.cfg]: { '["mcpServers"]': ["a"] } } })[0]).toContain("JSON");
  });

  test("файл изменился между планом и записью: чужой ключ с тем же именем не перезаписывается", () => {
    const f = fixture();
    writeFileSync(f.cfg, "{}");
    const actions = plan(result({ a: { url: "miksy" } }), f.target, f.machine, emptyState(), false);
    writeFileSync(f.cfg, JSON.stringify({ mcpServers: { a: { url: "user" } } }));
    expect(() => apply(actions, emptyState())).toThrow("изменился");
    expect(JSON.parse(readFileSync(f.cfg, "utf8")).mcpServers.a.url).toBe("user");
  });

  test("applyPlanned: после изменения файла план повторяется", () => {
    const f = fixture();
    writeFileSync(f.cfg, "{}");
    let calls = 0;
    const { state } = applyPlanned((prev) => {
      const actions = plan(result({ a: { url: "miksy" } }), f.target, f.machine, prev, false);
      // Сессия агента дописала свой ключ сразу после первого плана
      if (calls++ === 0) writeFileSync(f.cfg, JSON.stringify({ other: 1 }));
      return actions;
    }, emptyState());
    expect(calls).toBe(2);
    expect(JSON.parse(readFileSync(f.cfg, "utf8"))).toEqual({ other: 1, mcpServers: { a: { url: "miksy" } } });
    expect(state.merges[canonical(f.cfg)]).toEqual({ '["mcpServers"]': ["a"] });
  });

  test("sync --all: битый ~/.claude.json — конфликт, остальные проекты синхронизированы", () => {
    const fx = cliFixture({ projects: ["Org/p1", "Org/p2"] });
    put(`${fx.config}/layers/tree/mcp/ctx.yaml`, "name: ctx\nurl: https://ctx/mcp\n");
    put(`${fx.home}/.claude.json`, "{ broken");
    const r = fx.run(["sync", "--all", "--yes"]);
    expect(r.code).toBe(3);
    expect(r.out).toContain("JSON");
    expect(existsSync(`${fx.ws}/Org/p1/CLAUDE.local.md`)).toBe(true);
    expect(existsSync(`${fx.ws}/Org/p2/CLAUDE.local.md`)).toBe(true);
    expect(readFileSync(`${fx.home}/.claude.json`, "utf8")).toBe("{ broken");
  }, 30000);
});
