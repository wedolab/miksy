// Секреты: adopt ищет их в args, URL, строках подключения и raw; compare маскирует обе стороны;
// secrets.env экранирует значения; sync и doctor предупреждают о секретах открытым текстом в слоях
import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { adoptMcp, fromNative } from "../src/adopt";
import { loadSecrets } from "../src/load";
import type { Machine } from "../src/types";
import { cliFixture, put } from "./helpers";

const machine: Machine = { workspace: "D:/work", os: "windows", home: "C:/Users/u", vars: {} };
const win = process.platform === "win32";

describe("adopt: поиск секретов", () => {
  test("args: --flag=значение, --flag значение, строка подключения", () => {
    const { server, secrets } = fromNative("db", {
      command: "npx",
      args: ["--token=glpat-abcdefghij1234", "--api-key", "s3cr3tvalue42", "--db", "postgres://app:pa55word@h:5432/x", "--path", "C:/tools/x"],
    }, "claude", machine, "Org");
    const text = JSON.stringify(server);
    for (const v of ["glpat-abcdefghij1234", "s3cr3tvalue42", "pa55word"]) {
      expect(text).not.toContain(v);
      expect(Object.values(secrets)).toContain(v);
    }
    expect(server.args).toContain("--path");
    expect(server.args).toContain("C:/tools/x");
    expect(server.args!.find((a) => a.startsWith("postgres://"))).toMatch(/^postgres:\/\/app:\$\{[A-Z0-9_]+\}@h:5432\/x$/);
  });

  test("URL: user:pass@ и ?token=", () => {
    const { server, secrets } = fromNative("r", { url: "https://user:pw123456@host/mcp?token=abcdef123456&x=1" }, "claude", machine, "Org");
    expect(server.url).toMatch(/^https:\/\/user:\$\{[A-Z0-9_]+\}@host\/mcp\?token=\$\{[A-Z0-9_]+\}&x=1$/);
    expect(Object.values(secrets).sort()).toEqual(["abcdef123456", "pw123456"]);
  });

  test("env: строки подключения БД под несекретным именем", () => {
    const { server, secrets } = fromNative("e", {
      command: "x",
      env: { DATABASE_URL: "postgresql://app:hunter2pass@db/x", CONN: "Server=s;User Id=u;Password=Pa55w0rd!;", MODE: "prod" },
    }, "claude", machine, "Org");
    expect(JSON.stringify(server)).not.toContain("hunter2pass");
    expect(JSON.stringify(server)).not.toContain("Pa55w0rd!");
    expect(server.env!.MODE).toBe("prod");
    expect(Object.values(secrets).sort()).toEqual(["Pa55w0rd!", "hunter2pass"]);
  });

  test("raw агента: секреты тоже выносятся", () => {
    const { server, secrets } = fromNative("c", {
      url: "https://x/mcp",
      bearer_token: "sk-abcdefghijklmnop",
      env_http_headers: { "X-Api-Key": "k3y-value-123" },
      startup_timeout_sec: 30,
    }, "codex", machine, "Org");
    const raw = JSON.stringify(server.agents);
    expect(raw).not.toContain("sk-abcdefghijklmnop");
    expect(raw).not.toContain("k3y-value-123");
    expect(raw).toContain("30");
    expect(Object.values(secrets).sort()).toEqual(["k3y-value-123", "sk-abcdefghijklmnop"]);
  });

  test("подозрительное, но не распознанное — в списке «осталось открытым»", () => {
    const { open } = fromNative("o", { command: "x", args: ["--mode", "fast", "x9Fq2LmZ8vR4tY7wP1sD6gH3kJ5n"] }, "claude", machine, "Org");
    expect(open.join()).toContain("args[2]");
  });
});

describe("adopt: план и подтверждение", () => {
  const fixture = () => {
    const f = cliFixture();
    put(`${f.home}/.claude.json`, JSON.stringify({ mcpServers: { gl: { type: "stdio", command: "npx", args: ["--token=glpat-abcdefghij1234"] } } }));
    return f;
  };

  test("без терминала и без --yes — отказ, ничего не записано; план без значения секрета", () => {
    const f = fixture();
    const r = f.run(["adopt", "--global", "gl", "--to", "workspace"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--yes");
    expect(r.out).toContain("mcp/gl.yaml");
    expect(r.out + r.err).not.toContain("glpat-abcdefghij1234");
    expect(() => readFileSync(`${f.config}/layers/tree/mcp/gl.yaml`)).toThrow();
  });

  test("--dry-run — только план; --yes — запись", () => {
    const f = fixture();
    expect(f.run(["adopt", "--global", "gl", "--to", "workspace", "--dry-run"]).code).toBe(0);
    expect(() => readFileSync(`${f.config}/layers/tree/mcp/gl.yaml`)).toThrow();
    const r = f.run(["adopt", "--global", "gl", "--to", "workspace", "--yes"]);
    expect(r.code).toBe(0);
    expect(readFileSync(`${f.config}/layers/tree/mcp/gl.yaml`, "utf8")).not.toContain("glpat-");
    expect(loadSecrets(f.config)).toEqual({ WORKSPACE_GL_TOKEN: "glpat-abcdefghij1234" });
  });
});

describe("secrets.env: запись", () => {
  test("значение с переводом строки и кавычками не ломает файл", () => {
    const f = cliFixture();
    put(`${f.config}/local/secrets.env`, "BEFORE=1\n");
    adoptMcp({ name: "m", command: "x", env: { A: "${MULTI}", B: "${QUOTE}" } }, { MULTI: "line1\nline2=x\nAFTER=evil", QUOTE: 'a"b\\c #d' }, "workspace", "c", f.config);
    put(`${f.config}/local/secrets.env`, readFileSync(`${f.config}/local/secrets.env`, "utf8") + "LAST=2\n");
    expect(loadSecrets(f.config)).toEqual({ BEFORE: "1", MULTI: "line1\nline2=x\nAFTER=evil", QUOTE: 'a"b\\c #d', LAST: "2" });
  });

  test.skipIf(win)("новый secrets.env — 0600", () => {
    const f = cliFixture();
    adoptMcp({ name: "m", command: "x", env: { A: "${S}" } }, { S: "v" }, "workspace", "c", f.config);
    expect(statSync(`${f.config}/local/secrets.env`).mode & 0o777).toBe(0o600);
  });
});

describe("sync --out: compare маскирует обе стороны", () => {
  test("секрет в текущем определении агента не печатается", () => {
    const f = cliFixture();
    put(`${f.home}/.claude.json`, JSON.stringify({ mcpServers: { gl: { type: "stdio", command: "npx", args: ["--token=glpat-current-secret1"], env: {} } } }));
    put(`${f.config}/layers/global/mcp/gl.yaml`, "name: gl\ncommand: npx\nargs: [\"--token=${GL}\"]\n");
    put(`${f.config}/local/secrets.env`, "GL=glpat-layer-secret22\n");
    const r = f.run(["sync", "--global", "--out", "sb"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("gl");
    expect(r.out).not.toContain("glpat-current-secret1");
    expect(r.out).not.toContain("glpat-layer-secret22");
  });
});

describe("секреты открытым текстом в слоях", () => {
  test("sync и doctor предупреждают, значение не печатают", () => {
    const f = cliFixture();
    put(`${f.config}/layers/tree/Org/mcp/gl.yaml`, "name: gl\ncommand: npx\nenv:\n  GITLAB_TOKEN: glpat-literal-value99\n");
    const s = f.run(["sync", "--global", "--dry-run"]);
    expect(s.out).toContain("открытым текстом");
    expect(s.out).toContain("Org/mcp/gl.yaml");
    expect(s.out).not.toContain("glpat-literal-value99");
    const d = f.run(["doctor"]);
    expect(d.code).toBe(1);
    expect(d.out).toContain("открытым текстом");
    expect(d.out).not.toContain("glpat-literal-value99");
  });
});
