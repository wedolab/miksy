// Обёртки секретов (src/launch.ts) и мост (src/bridge.ts): сгенерированные скрипты запускаются
// по-настоящему — sh на macOS/Linux, .cmd на Windows. Значения искусственные.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLauncher, deliver, DeliveryError } from "../src/launch";
import { ENGINE } from "../src/load";
import type { McpServer } from "../src/types";
import { secretRef } from "../src/vars";

const win = process.platform === "win32";
const os = win ? "windows" : process.platform === "darwin" ? "macos" : "linux";
const SECRETS: Record<string, string> = {
  TOK: "tok_A1b2-C3d4.E5f6_G7h8",
  SPECIAL: "p&a^s%s!w<r>d|x y=z(1)",
  CYR: "пароль-ёж-42",
  QUOTE: 'q"uo\\te',
};

// Каталог конфигурации с пробелом и кириллицей: пути в скриптах тоже проверяются
function box() {
  const root = mkdtempSync(join(tmpdir(), "launch-")).replaceAll("\\", "/");
  const local = `${root}/конфиг с пробелом/local`;
  mkdirSync(`${local}/secrets`, { recursive: true });
  for (const [n, v] of Object.entries(SECRETS)) writeFileSync(`${local}/secrets/${n}`, v + "\n");
  const echo = `${root}/echo.ts`;
  writeFileSync(echo, `const pick = (process.env.ECHO_VARS ?? "").split(",").filter(Boolean);
console.log(JSON.stringify({ argv: process.argv.slice(2), env: Object.fromEntries(pick.map((k) => [k, process.env[k] ?? null])), leaked: Object.keys(process.env).filter((k) => k.startsWith("h_")) }));`);
  const launcher = createLauncher({ os, local, agent: "claude", target: { scope: "global" }, bun: process.execPath, engine: ENGINE });
  // Записать сгенерированные скрипты на диск (в sync это делает apply)
  const materialize = () => {
    for (const f of launcher.files()) {
      if (f.mode !== "own") continue;
      const p = `${local}/${f.path}`;
      mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true });
      writeFileSync(p, f.content, { mode: 0o700 });
    }
  };
  return { root, local, echo, launcher, materialize };
}

const runScript = (path: string, env: Record<string, string> = {}, stdin?: string) => {
  const r = Bun.spawnSync(win ? ["cmd.exe", "/d", "/c", path] : [path], {
    env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe", stdin: stdin === undefined ? "ignore" : Buffer.from(stdin), timeout: 60000,
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};

// Строка-команда helper-а — так, как её выполняет агент: shell (Claude: shell: true; Codex: sh -c / cmd /C)
const runHelper = (cmd: string) => {
  const r = spawnSync(cmd, { shell: true, encoding: "utf8", timeout: 60000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

describe("обёртка stdio", () => {
  test("env целиком из секрета, составной env, секрет в аргументе, спецсимволы, кириллица, пробелы", () => {
    const b = box();
    const staticArgs = ["a b", "п р", "x&y", "x^y", "100%", "%PATH%", "a!b", "<>|", "(x)", "a=b;c,d", win ? "C:\\dir\\" : "/dir/"];
    const s: McpServer = {
      name: "srv",
      command: process.execPath,
      args: [b.echo, ...staticArgs, `--token=${secretRef("SPECIAL")}`, secretRef("CYR")],
      env: {
        ECHO_VARS: "WHOLE,QUOTED,PART,STATIC,CYRV",
        WHOLE: secretRef("TOK"),
        QUOTED: secretRef("QUOTE"), // целиком — любые символы (set /p, read -r)
        PART: `Bearer ${secretRef("SPECIAL")} !%x%`,
        STATIC: "a&b|c<d>e^f%g!h",
        CYRV: secretRef("CYR"),
      },
    };
    const path = b.launcher.stdio(s);
    b.materialize();
    const content = b.launcher.files()[0].mode === "own" ? (b.launcher.files()[0] as { content: string }).content : "";
    for (const v of Object.values(SECRETS)) expect(content).not.toContain(v);
    if (win) expect(content.split("\r\n")[0]).toBe("@chcp 65001 >nul");
    const r = runScript(path);
    expect(r.err).toBe("");
    const got = JSON.parse(r.out);
    expect(got.argv).toEqual([...staticArgs, `--token=${SECRETS.SPECIAL}`, SECRETS.CYR]);
    expect(got.env).toEqual({
      WHOLE: SECRETS.TOK, QUOTED: SECRETS.QUOTE, PART: `Bearer ${SECRETS.SPECIAL} !%x%`, STATIC: "a&b|c<d>e^f%g!h", CYRV: SECRETS.CYR,
    });
    // Внутренние копии секретов серверу не передаются
    expect(got.leaked).toEqual([]);
    rmSync(b.root, { recursive: true, force: true });
  }, 60000);

  test.skipIf(!win)("Windows: командный .cmd-сервер (как npx.cmd) получает те же аргументы", () => {
    const b = box();
    const inner = `${b.root}/inner server.cmd`;
    writeFileSync(inner, `@echo off\r\n"${process.execPath}" "${b.echo}" %*\r\n`);
    const args = ["a b", "п р", "x&y", "x^y", "100%", "a!b", "<>|"];
    const path = b.launcher.stdio({ name: "chain", command: inner, args: [...args, secretRef("SPECIAL")], env: { ECHO_VARS: "T", T: secretRef("CYR") } });
    b.materialize();
    const got = JSON.parse(runScript(path).out);
    expect(got.argv).toEqual([...args, SECRETS.SPECIAL]);
    expect(got.env).toEqual({ T: SECRETS.CYR });
    rmSync(b.root, { recursive: true, force: true });
  }, 60000);

  test("нет файла секрета: код ≠ 0, понятный текст в stderr, сервер не запускается", () => {
    const b = box();
    rmSync(`${b.local}/secrets/TOK`);
    const path = b.launcher.stdio({ name: "lost", command: process.execPath, args: [b.echo], env: { X: secretRef("TOK") } });
    b.materialize();
    const r = runScript(path);
    expect(r.code).not.toBe(0);
    expect(r.out).toBe("");
    expect(r.err).toContain("нет файла секрета");
    expect(r.err).toContain("TOK");
    rmSync(b.root, { recursive: true, force: true });
  }, 60000);

  test.skipIf(!win)("Windows: \" в аргументе или переменной обёртки — явный отказ, не искажение", () => {
    const b = box();
    expect(() => b.launcher.stdio({ name: "q", command: "x", args: ['{"a":1}', secretRef("TOK")] })).toThrow(DeliveryError);
    expect(() => b.launcher.stdio({ name: "q2", command: "x", env: { A: 'say "hi"', T: secretRef("TOK") } })).toThrow(DeliveryError);
  });

  test.skipIf(win)("macOS/Linux: \" в аргументах и переменных передаётся как есть", () => {
    const b = box();
    const path = b.launcher.stdio({ name: "q", command: process.execPath, args: [b.echo, '{"a":1}', "it's"], env: { ECHO_VARS: "A", A: `say "hi" $HOME \`x\` ${secretRef("TOK")}` } });
    b.materialize();
    const got = JSON.parse(runScript(path).out);
    expect(got.argv).toEqual(['{"a":1}', "it's"]);
    expect(got.env.A).toBe(`say "hi" $HOME \`x\` ${SECRETS.TOK}`);
  }, 60000);

  test("имя переменной окружения, недопустимое для обёртки, — отказ", () => {
    const b = box();
    expect(() => b.launcher.stdio({ name: "e", command: "x", env: { "A-B": secretRef("TOK") } })).toThrow(DeliveryError);
  });
});

describe("helper заголовков", () => {
  test("печатает JSON всех заголовков: секретные и статические", () => {
    const b = box();
    const cmd = b.launcher.helper({ name: "h", url: "https://x/mcp", headers: { Authorization: `Bearer ${secretRef("TOK")}`, "X-Static": "a&b %x% !^<>|", "X-Plain": secretRef("TOK") } });
    b.materialize();
    const r = runHelper(cmd);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ Authorization: `Bearer ${SECRETS.TOK}`, "X-Static": "a&b %x% !^<>|", "X-Plain": SECRETS.TOK });
  }, 60000);

  test("нет файла секрета — код ≠ 0, stdout пуст", () => {
    const b = box();
    rmSync(`${b.local}/secrets/TOK`);
    const cmd = b.launcher.helper({ name: "h", url: "https://x/mcp", headers: { Authorization: `Bearer ${secretRef("TOK")}` } });
    b.materialize();
    const r = runHelper(cmd);
    expect(r.code).not.toBe(0);
    expect(r.out.trim()).toBe("");
    expect(r.err).toMatch(/нет файла секрета|secret file missing/);
  }, 60000);

  test.skipIf(!win)("Windows: helper не меняет кодовую страницу консоли агента (Codex запускает его в своей)", () => {
    const ascii = createLauncher({ os, local: "C:/cfg/local", agent: "codex", target: { scope: "global" }, bun: "bun", engine: ENGINE });
    ascii.helper({ name: "h", url: "u", headers: { A: secretRef("TOK") } });
    const text = (ascii.files()[0] as { content: string }).content;
    expect(text).not.toContain("chcp");
    expect(/[^\x00-\x7f]/.test(text)).toBe(false);
    // Путь с кириллицей: chcp 65001 на время чтения, затем прежняя страница
    const b = box();
    const path = b.launcher.helper({ name: "h", url: "u", headers: { A: secretRef("TOK") } }).replace(/^"|"$/g, "");
    b.materialize();
    const driver = `${b.root}/driver.cmd`;
    writeFileSync(driver, `@echo off\r\nchcp\r\ncall "${path.replaceAll("/", "\\")}"\r\nchcp\r\n`, "utf8");
    const r = Bun.spawnSync(["cmd.exe", "/d", "/c", driver], { stdout: "pipe", stderr: "pipe" });
    const lines = r.stdout.toString().split(/\r?\n/).filter((l) => /\d/.test(l));
    expect(lines.length).toBe(3);
    expect(JSON.parse(lines[1]).A).toBe(SECRETS.TOK);
    expect(lines[2]).toBe(lines[0]);
  }, 60000);

  test("значение заголовка не ASCII — отказ", () => {
    const b = box();
    expect(() => b.launcher.helper({ name: "h", url: "u", headers: { A: "ключ" } })).toThrow(DeliveryError);
  });

  test("путь с пробелом — в кавычках (строка-команда для shell агента)", () => {
    const b = box();
    expect(b.launcher.helper({ name: "h", url: "u", headers: { A: secretRef("TOK") } })).toMatch(win ? /^".* .*"$/ : /^'.* .*'$/);
  });
});

describe("выбор доставки", () => {
  const l = createLauncher({ os, local: "/c/local", agent: "a", target: { scope: "global" }, bun: "bun", engine: "/e" });
  test("без секретов — как есть; stdio — обёртка; HTTP — helper/{file:}/мост; секрет в URL — мост", () => {
    expect(deliver({ name: "p", command: "x" }, l, "helper").kind).toBe("plain");
    expect(deliver({ name: "s", command: "x", env: { A: secretRef("T") } }, l, "helper").kind).toBe("stdio");
    expect(deliver({ name: "h", url: "u", headers: { A: secretRef("T") } }, l, "helper").kind).toBe("helper");
    expect(deliver({ name: "h", url: "u", headers: { A: `Bearer ${secretRef("T")}` } }, l, "file")).toEqual({ kind: "file", url: "u", headers: { A: "Bearer {file:/c/local/secrets/T}" } });
    expect(deliver({ name: "h", url: "u", headers: { A: secretRef("T") } }, l, "bridge").kind).toBe("stdio");
    expect(deliver({ name: "u", url: `https://x/?k=${secretRef("T")}` }, l, "helper").kind).toBe("stdio");
  });
  test("секрет без доставки — ошибка, а не значение", () => {
    expect(() => deliver({ name: "s", command: "x", env: { A: secretRef("T") } }, undefined, "helper")).toThrow(DeliveryError);
  });
});

// Заглушка Streamable HTTP MCP: проверяет Authorization, отвечает JSON или SSE
function stubServer(token: string, sse: boolean) {
  const seen: { auth: string | null; method?: string; session: string | null; version: string | null }[] = [];
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const body = req.method === "POST" ? await req.json().catch(() => null) : null;
      seen.push({ auth: req.headers.get("authorization"), method: body?.method, session: req.headers.get("mcp-session-id"), version: req.headers.get("mcp-protocol-version") });
      if (req.headers.get("authorization") !== `Bearer ${token}`) return new Response("no", { status: 401 });
      if (req.method === "DELETE") return new Response(null, { status: 200 });
      if (!body || body.id === undefined) return new Response(null, { status: 202 });
      const result = body.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "1" } }
        : body.method === "tools/list" ? { tools: [{ name: "ok_tool", inputSchema: { type: "object" } }] } : {};
      const msg = JSON.stringify({ jsonrpc: "2.0", id: body.id, result });
      const headers = { "mcp-session-id": "sess-1" };
      return sse
        ? new Response(`event: message\ndata: ${msg}\n\n`, { headers: { ...headers, "content-type": "text/event-stream" } })
        : new Response(msg, { headers: { ...headers, "content-type": "application/json" } });
    },
  });
  return { server, seen, url: `http://127.0.0.1:${server.port}/mcp` };
}

const rpc = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
].map((m) => JSON.stringify(m)).join("\n") + "\n";

describe("мост stdio ↔ HTTP", () => {
  for (const sse of [false, true]) test(`initialize и tools/list через обёртку, Authorization из файла секрета (${sse ? "SSE" : "JSON"})`, async () => {
    const b = box();
    const stub = stubServer(SECRETS.TOK, sse);
    try {
      const path = b.launcher.bridge({ name: "remote", url: stub.url, headers: { Authorization: `Bearer ${secretRef("TOK")}` } });
      b.materialize();
      const content = (b.launcher.files()[0] as { content: string }).content;
      expect(content).not.toContain(SECRETS.TOK);
      const p = Bun.spawn(win ? ["cmd.exe", "/d", "/c", path] : [path], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      p.stdin.write(rpc);
      p.stdin.end();
      const out = await new Response(p.stdout).text();
      await p.exited;
      const msgs = out.trim().split("\n").map((l) => JSON.parse(l));
      expect(msgs.find((m) => m.id === 1)?.result?.serverInfo?.name).toBe("stub");
      expect(msgs.find((m) => m.id === 2)?.result?.tools?.[0]?.name).toBe("ok_tool");
      expect(stub.seen.every((s) => s.auth === `Bearer ${SECRETS.TOK}`)).toBe(true);
      // Сессия и версия протокола — на запросах после initialize
      expect(stub.seen.find((s) => s.method === "tools/list")).toMatchObject({ session: "sess-1", version: "2025-06-18" });
    } finally {
      stub.server.stop(true);
      rmSync(b.root, { recursive: true, force: true });
    }
  }, 60000);

  test("401 — ответ JSON-RPC с ошибкой (агент видит причину), значение токена не печатается", async () => {
    const b = box();
    const stub = stubServer("другой-токен", false);
    try {
      const path = b.launcher.bridge({ name: "remote", url: stub.url, headers: { Authorization: `Bearer ${secretRef("TOK")}` } });
      b.materialize();
      const p = Bun.spawn(win ? ["cmd.exe", "/d", "/c", path] : [path], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      p.stdin.write(rpc);
      p.stdin.end();
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      await p.exited;
      const first = JSON.parse(out.trim().split("\n")[0]);
      expect(first.id).toBe(1);
      expect(first.error.message).toContain("HTTP 401");
      expect(out + err).not.toContain(SECRETS.TOK);
    } finally {
      stub.server.stop(true);
      rmSync(b.root, { recursive: true, force: true });
    }
  }, 60000);

  test("секрет в URL — мост подставляет его из файла", async () => {
    const b = box();
    let query: string | null = null;
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
      query = new URL(req.url).searchParams.get("key");
      const body = await req.json();
      if (body.id === undefined) return new Response(null, { status: 202 });
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "u", version: "1" } } });
    } });
    try {
      const path = b.launcher.bridge({ name: "q", url: `http://127.0.0.1:${server.port}/mcp?key=${secretRef("TOK")}` });
      b.materialize();
      const p = Bun.spawn(win ? ["cmd.exe", "/d", "/c", path] : [path], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      p.stdin.write(rpc.split("\n")[0] + "\n");
      p.stdin.end();
      const out = await new Response(p.stdout).text();
      await p.exited;
      expect(JSON.parse(out.trim()).result.serverInfo.name).toBe("u");
      expect(query).toBe(SECRETS.TOK);
    } finally {
      server.stop(true);
      rmSync(b.root, { recursive: true, force: true });
    }
  }, 60000);
});
