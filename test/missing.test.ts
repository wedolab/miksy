// Недостающий секрет: пропускается только сервер, которому он нужен; уже записанный — не удаляется
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { cliFixture, put } from "./helpers";

const servers = (home: string, dir: string) => {
  const cfg = JSON.parse(readFileSync(`${home}/.claude.json`, "utf8"));
  return Object.keys(cfg.projects?.[realpathSync.native(dir).replaceAll("\\", "/")]?.mcpServers ?? {}).sort();
};

describe("недостающий секрет", () => {
  test("пропущен только сервер без секрета, остальное записано; это не конфликт", () => {
    const f = cliFixture();
    put(`${f.config}/layers/tree/mcp/ctx.yaml`, "name: ctx\nurl: https://ctx/mcp\n");
    put(`${f.config}/layers/tree/mcp/gl.yaml`, "name: gl\ncommand: npx\nenv:\n  TOKEN: ${GL_TOKEN}\n");
    const r = f.run(["sync", `${f.ws}/Org/p1`]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("пропущен сервер gl");
    expect(r.out).toContain("GL_TOKEN");
    expect(r.out).not.toContain("КОНФЛИКТ");
    expect(r.out).not.toContain("ПРОПУЩЕН");
    expect(readFileSync(`${f.ws}/Org/p1/CLAUDE.local.md`, "utf8")).toContain("# workspace");
    expect(servers(f.home, `${f.ws}/Org/p1`)).toEqual(["ctx"]);
  }, 30000);

  test("секрет пропал после sync — записанный сервер остаётся как был", () => {
    const f = cliFixture();
    put(`${f.config}/layers/tree/mcp/gl.yaml`, "name: gl\ncommand: npx\nenv:\n  TOKEN: ${GL_TOKEN}\n");
    put(`${f.config}/local/secrets.env`, "GL_TOKEN=v1\n");
    expect(f.run(["sync", `${f.ws}/Org/p1`]).code).toBe(0);
    expect(servers(f.home, `${f.ws}/Org/p1`)).toEqual(["gl"]);
    put(`${f.config}/local/secrets.env`, "\n");
    const r = f.run(["sync", `${f.ws}/Org/p1`]);
    expect(r.out).toContain("пропущен сервер gl");
    expect(servers(f.home, `${f.ws}/Org/p1`)).toEqual(["gl"]);
    expect(f.run(["sync", `${f.ws}/Org/p1`, "--dry-run"]).out).not.toContain("- gl");
  }, 30000);

  test("сервер со skip для агента не требует секрета у этого агента", () => {
    const f = cliFixture();
    put(`${f.config}/layers/tree/mcp/gl.yaml`, "name: gl\ncommand: npx\nenv:\n  TOKEN: ${GL_TOKEN}\nagents:\n  claude: skip\n");
    const r = f.run(["sync", `${f.ws}/Org/p1`]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("GL_TOKEN");
  }, 30000);

  test("секрет в raw агента не подставляется: сервер пропущен с сообщением", () => {
    const f = cliFixture();
    put(`${f.config}/layers/tree/mcp/r.yaml`, "name: r\nurl: https://r/mcp\nagents:\n  claude:\n    raw:\n      headers:\n        X-Key: ${R_KEY}\n");
    put(`${f.config}/local/secrets.env`, "R_KEY=k1\n");
    const r = f.run(["sync", `${f.ws}/Org/p1`]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("agents.claude.raw не поддерживается");
    expect(existsSync(`${f.home}/.claude.json`) ? readFileSync(`${f.home}/.claude.json`, "utf8") : "").not.toContain("k1");
  }, 30000);
});

test("TOML-блок Codex: пропущенный сервер, записанный раньше, остаётся в блоке", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { apply, plan } = await import("../src/apply");
  const { emptyState } = await import("../src/manifest");
  const home = mkdtempSync(join(tmpdir(), "miss-toml-")).replaceAll("\\", "/");
  const machine = { workspace: home, os: "linux" as const, home, vars: {} };
  const file = (data: Record<string, unknown>, keep?: string[]) => ({
    warnings: [], ...(keep && { keep }),
    files: [{ base: "home" as const, path: ".codex/config.toml", mode: "merge" as const, format: "toml" as const, key: ["mcp_servers"], data }],
  });
  writeFileSync(`${home}/x`, "");
  const { state } = apply(plan(file({ gl: { command: "npx" }, ctx: { url: "u" } }), { scope: "global" }, machine, emptyState(), false), emptyState());
  const actions = plan(file({ ctx: { url: "u" } }, ["gl"]), { scope: "global" }, machine, state, false);
  expect(actions).toEqual([]);
});
