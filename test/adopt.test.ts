import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromNative, layerDir, mcpYaml } from "../src/adopt";
import type { Machine } from "../src/types";

const machine: Machine = { workspace: "D:/work", os: "windows", home: "C:/Users/u", vars: { PYTHON: "C:/Py/python.exe" } };

describe("adopt: перевод MCP из формата агента", () => {
  test("Claude stdio: пути машины → переменные, токен → секрет", () => {
    const { server, secrets } = fromNative("dns", {
      type: "stdio",
      command: "C:\\Py\\python.exe",
      args: ["D:\\work\\Org\\dns\\server.py"],
      env: { DNS_TOKEN: "abc123", MODE: "prod" },
    }, "claude", machine, "Org");
    expect(server).toEqual({
      name: "dns",
      command: "${PYTHON}",
      args: ["${WORKSPACE}/Org/dns/server.py"],
      env: { DNS_TOKEN: "${ORG_DNS_TOKEN}", MODE: "prod" },
    });
    expect(secrets).toEqual({ ORG_DNS_TOKEN: "abc123" });
  });

  test("opencode: command-массив и environment", () => {
    const { server } = fromNative("x", { type: "local", command: ["npx", "-y", "pkg"], environment: { A: "1" } }, "opencode", machine, "workspace");
    expect(server).toEqual({ name: "x", command: "npx", args: ["-y", "pkg"], env: { A: "1" } });
  });

  test("Codex http: http_headers, Bearer → секрет, прочие поля → raw", () => {
    const { server, secrets } = fromNative("gh", {
      url: "https://api.example/mcp",
      http_headers: { Authorization: "Bearer ghp_secretvalue" },
      startup_timeout_sec: 30,
    }, "codex", machine, "Org/Team");
    expect(server.url).toBe("https://api.example/mcp");
    expect(server.headers).toEqual({ Authorization: "Bearer ${ORG_TEAM_GH_TOKEN}" });
    expect(secrets).toEqual({ ORG_TEAM_GH_TOKEN: "ghp_secretvalue" });
    expect(server.agents).toEqual({ codex: { raw: { startup_timeout_sec: 30 } } });
  });

  test("Gemini serverUrl; значение уже ссылкой не трогается", () => {
    const { server, secrets } = fromNative("r", { serverUrl: "https://x/mcp", headers: { "X-Key": "${KEY}" } }, "gemini", machine, "global");
    expect(server).toEqual({ name: "r", url: "https://x/mcp", headers: { "X-Key": "${KEY}" } });
    expect(secrets).toEqual({});
  });

  test("имя секрета не затирает чужое с другим значением", () => {
    const { secrets } = fromNative("s", { command: "x", env: { API_TOKEN: "new" } }, "claude", machine, "Org", { ORG_API_TOKEN: "old" });
    expect(secrets).toEqual({ ORG_API_TOKEN_2: "new" });
  });

  test("без command и url — ошибка", () => {
    expect(() => fromNative("bad", { type: "stdio" }, "claude", machine, "Org")).toThrow();
  });
});

describe("adopt: YAML и уровни", () => {
  test("YAML читается обратно тем же", () => {
    const s = { name: "a", command: "npx", args: ["-y", "p q"], env: { "K-1": "${V}" }, agents: { codex: { raw: { t: 30 } } } };
    expect(Bun.YAML.parse(mcpYaml(s as never, "коммент"))).toEqual(s);
  });

  test("уровень → каталог слоя", () => {
    const root = mkdtempSync(join(tmpdir(), "adopt-"));
    expect(layerDir("global", root)).toBe(join(root, "layers", "global"));
    expect(layerDir("workspace", root)).toBe(join(root, "layers", "tree"));
    expect(layerDir("Org/Team", root)).toBe(join(root, "layers", "tree", "Org", "Team"));
    expect(() => layerDir("Org/mcp", root)).toThrow();
  });
});
