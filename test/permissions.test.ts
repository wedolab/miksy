import { expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { apply, plan } from "../src/apply";
import { emptyState, writeAtomic } from "../src/manifest";
import { ADAPTERS, renderFor } from "../src/registry";
import { cliFixture, put } from "./helpers";

test("R1: MCP-файлы секретны у всех адаптеров, own/JSON/TOML; значения секрета в них нет", () => {
  const f = cliFixture();
  const cfg = { layers: [], instructions: [], skills: [], notes: [], mcp: [{ layer: "x", item: { name: "s", command: "echo", env: { TOKEN: "${TOKEN}" } } }] };
  for (const adapter of Object.values(ADAPTERS)) for (const scope of ["global", "project"] as const) {
    const target = scope === "global" ? { scope } : { scope, dir: `${f.ws}/Org/p1`, rel: "Org/p1" };
    const machine = { home: f.home, workspace: f.ws, os: "linux" as const, vars: {} };
    const { result } = renderFor(adapter, { cfg, target, title: "test" }, machine, { TOKEN: "secret-value" });
    expect(result.files.some((x) => JSON.stringify(x).includes("secret-value"))).toBe(false);
    const mcp = result.files.filter((x) => x.mode === "merge" || x.mcp);
    expect(mcp.length).toBeGreaterThan(0);
    expect(mcp.every((x) => x.sensitive)).toBe(true);
    expect(result.secrets).toEqual(["TOKEN"]);
  }
});

test.skipIf(process.platform === "win32")("R1: новые и существующие файлы own/merge/TOML получают 0600, doctor видит 0644", () => {
  const f = cliFixture({ agents: ["claude", "codex", "opencode", "gemini"] });
  for (const layer of ["tree", "global"]) put(`${f.config}/layers/${layer}/mcp/s.yaml`, 'name: s\ncommand: echo\nenv: {TOKEN: "${TOKEN}"}\n');
  put(`${f.config}/local/secrets.env`, "TOKEN=opaque-test-secret\n");
  const paths = [`${f.home}/.claude.json`, `${f.home}/.codex/config.toml`, `${f.home}/.config/opencode/opencode.json`, `${f.home}/.gemini/config/mcp_config.json`, `${f.ws}/Org/p1/.codex/config.toml`, `${f.ws}/Org/p1/opencode.json`, `${f.ws}/Org/p1/.agents/plugins/miksy/mcp_config.json`];
  expect(f.run(["sync", "--global"]).code).toBe(0);
  expect(f.run(["sync", `${f.ws}/Org/p1`]).code).toBe(0);
  for (const p of paths) { expect(statSync(p).mode & 0o777).toBe(0o600); chmodSync(p, 0o644); }
  const report = f.run(["doctor"]);
  expect(report.out).toContain("права");
  expect(report.code).not.toBe(0);
  expect(f.run(["sync", "--global"]).code).toBe(0);
  expect(f.run(["sync", `${f.ws}/Org/p1`]).code).toBe(0);
  for (const p of paths) expect(statSync(p).mode & 0o777).toBe(0o600);
}, 60000);

test.skipIf(process.platform === "win32")("R1: setup создаёт local 0700, secrets.env 0600", () => {
  const f = cliFixture();
  expect(f.run(["setup", "--yes"]).code).toBe(0);
  expect(statSync(`${f.config}/local`).mode & 0o777).toBe(0o700);
  expect(statSync(`${f.config}/local/secrets.env`).mode & 0o777).toBe(0o600);
});
