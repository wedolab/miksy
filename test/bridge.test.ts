// Мост (src/bridge.ts) в отказных режимах — реальным запуском через обёртку, как его запускает агент:
// редирект, .env/bunfig.toml и прокси каталога сессии, утечки значений в stdout/stderr, открытый SSE,
// истёкшая сессия (404), 202 на запрос, битый и оборванный SSE, зависший сервер и EOF stdin.
// Значения искусственные.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLauncher } from "../src/launch";
import { ENGINE } from "../src/load";
import type { McpServer } from "../src/types";
import { secretRef } from "../src/vars";

const win = process.platform === "win32";
const os = win ? "windows" : process.platform === "darwin" ? "macos" : "linux";
const TOK = "tok_A1b2-C3d4.E5f6_G7h8";
const URLSECRET = "urlsecret-artificial-987654";
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function box() {
  const root = mkdtempSync(join(tmpdir(), "bridge-")).replaceAll("\\", "/");
  roots.push(root);
  const local = `${root}/конфиг с пробелом/local`;
  mkdirSync(`${local}/secrets`, { recursive: true });
  writeFileSync(`${local}/secrets/TOK`, TOK + "\n");
  writeFileSync(`${local}/secrets/U`, URLSECRET + "\n");
  const launcher = createLauncher({ os, local, agent: "gemini", target: { scope: "global" }, bun: process.execPath, engine: ENGINE });
  const bridge = (s: McpServer) => {
    const path = launcher.bridge(s);
    for (const f of launcher.files()) {
      if (f.mode !== "own") continue;
      const p = `${local}/${f.path}`;
      mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true });
      writeFileSync(p, f.content, { mode: 0o700 });
    }
    return path;
  };
  return { root, local, bridge };
}

const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
const inited = { jsonrpc: "2.0", method: "notifications/initialized" };
const list = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/list" });
const initResult = (id: unknown) => ({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "1" } } });
const listResult = (id: unknown) => ({ jsonrpc: "2.0", id, result: { tools: [{ name: "ok_tool", inputSchema: { type: "object" } }] } });
const sse = (...msgs: unknown[]) => msgs.map((m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`).join("");

// Запуск обёртки моста: сообщения в stdin; open — сколько мс держать stdin открытым после записи.
// kill — страховка: мост, не завершившийся сам, убивается (тест это видит по hung)
async function run(path: string, msgs: unknown[], o: { open?: number; kill?: number; cwd?: string; env?: Record<string, string>; args?: string[] } = {}) {
  const p = Bun.spawn(win ? ["cmd.exe", "/d", "/c", path, ...(o.args ?? [])] : [path, ...(o.args ?? [])], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe", cwd: o.cwd, env: { ...process.env, ...o.env },
  });
  p.stdin.write(msgs.map((m) => JSON.stringify(m)).join("\n") + "\n");
  await p.stdin.flush();
  if (o.open) await Bun.sleep(o.open);
  p.stdin.end();
  const started = Date.now();
  let hung = false;
  const timer = setTimeout(() => { hung = true; p.kill(); }, o.kill ?? 20000);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  clearTimeout(timer);
  const msgsOut = out.trim() ? out.trim().split("\n").map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } }) : [];
  return { out, err, msgs: msgsOut, hung, ms: Date.now() - started, byId: (id: unknown) => msgsOut.find((m: any) => m.id === id) };
}

describe("мост: безопасность", () => {
  test("редирект не выполняется: секретный заголовок не уходит на другой origin, на запрос — ошибка", async () => {
    const b = box();
    const got: (string | null)[] = [];
    const other = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) { got.push(req.headers.get("x-api-key")); return Response.json(listResult(2)); } });
    const main = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
      const body = await req.json().catch(() => null);
      if (body?.method === "initialize") return Response.json(initResult(body.id));
      if (body?.id === undefined) return new Response(null, { status: 202 });
      return new Response(null, { status: 307, headers: { location: `http://127.0.0.1:${other.port}/mcp` } });
    } });
    try {
      const path = b.bridge({ name: "r", url: `http://127.0.0.1:${main.port}/mcp`, headers: { "X-Api-Key": secretRef("TOK") } });
      const r = await run(path, [init, inited, list(2)]);
      expect(got).toEqual([]);
      expect(r.byId(2)?.error?.message).toContain("редирект");
      expect(r.out + r.err).not.toContain(TOK);
    } finally { main.stop(true); other.stop(true); }
  }, 30000);

  test(".env, bunfig.toml (preload) и прокси каталога сессии в мост не попадают", async () => {
    const b = box();
    let proxied = 0;
    const proxy = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { proxied++; return new Response("proxy", { status: 502 }); } });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
      const body = await req.json().catch(() => null);
      if (body?.id === undefined) return new Response(null, { status: 202 });
      return Response.json(body.method === "initialize" ? initResult(body.id) : listResult(body.id));
    } });
    // Каталог «проекта», где агент открыл сессию: .env с прокси, bunfig с preload
    const project = `${b.root}/project`;
    mkdirSync(project, { recursive: true });
    const marker = `${b.root}/PRELOAD_RAN`;
    writeFileSync(`${project}/.env`, `HTTP_PROXY=http://127.0.0.1:${proxy.port}\nhttp_proxy=http://127.0.0.1:${proxy.port}\nBUN_CONFIG_VERBOSE_FETCH=curl\n`);
    writeFileSync(`${project}/bunfig.toml`, `preload = ["./evil.ts"]\n`);
    writeFileSync(`${project}/evil.ts`, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
    try {
      // Сервер — не на loopback-имени, иначе Bun обходит прокси для 127.0.0.1 и проверка ничего не скажет
      const path = b.bridge({ name: "e", url: `http://localhost:${server.port}/mcp`, headers: { Authorization: `Bearer ${secretRef("TOK")}` } });
      const r = await run(path, [init, inited, list(2)], { cwd: project, env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`, BUN_OPTIONS: `--preload ${project}/evil.ts` } });
      expect(existsSync(marker)).toBe(false);
      expect(proxied).toBe(0);
      expect(r.byId(2)?.result?.tools?.[0]?.name).toBe("ok_tool");
      expect(r.out + r.err).not.toContain(TOK);
    } finally { proxy.stop(true); server.stop(true); }
  }, 30000);

  test("обрыв SSE при секрете в URL: значения нет в stdout/stderr, на запрос — ошибка", async () => {
    const b = box();
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
      const body = await req.json().catch(() => null);
      if (body?.id === undefined) return new Response(null, { status: 202 });
      if (body.method === "initialize") return Response.json(initResult(body.id));
      // Поток: одно уведомление, затем обрыв соединения (сервер закрывает сокеты)
      const stream = new ReadableStream({ start(c) {
        c.enqueue(new TextEncoder().encode(sse({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })));
        setTimeout(() => server.stop(true), 50);
      } });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    } });
    try {
      const path = b.bridge({ name: "u", url: `http://127.0.0.1:${server.port}/mcp?key=${secretRef("U")}&x=1` });
      const r = await run(path, [init, inited, list(2)]);
      expect(r.out + r.err).not.toContain(URLSECRET);
      expect(r.out + r.err).not.toContain(encodeURIComponent(URLSECRET));
      expect(r.byId(2)?.error).toBeTruthy();
      expect(r.hung).toBe(false);
    } finally { server.stop(true); }
  }, 30000);

  // Без DNS: имя .invalid резолвер машины может искать дольше, чем мост ждёт после EOF stdin (Windows
  // — около 11 с). Запрос уходит через локальный прокси из env сервера: прокси получает CONNECT
  // с настоящим именем хоста и рвёт соединение — ошибка соединения, сеть машины не участвует
  test("секрет в имени хоста: текст ошибки — по шаблону, без значения", async () => {
    const b = box();
    const seen: string[] = [];
    const proxy = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: {
      data(s, d) { seen.push(d.toString().split("\r\n")[0]); s.end(); },
    } });
    try {
      const path = b.bridge({ name: "h", url: `https://${secretRef("U")}.invalid/mcp`, env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` } });
      const r = await run(path, [init]);
      expect(seen[0]).toBe(`CONNECT ${URLSECRET}.invalid:443 HTTP/1.1`);
      expect(r.out + r.err).not.toContain(URLSECRET);
      expect(r.byId(1)?.error?.message).toContain("<secret:U>.invalid");
    } finally { proxy.stop(true); }
  }, 30000);
});

describe("мост: ответ на каждый запрос", () => {
  test("открытый SSE после ответа: барьер initialize снимает ответ, поток не блокирует запросы; EOF — выход и DELETE с версией протокола", async () => {
    const b = box();
    const seen: { method?: string; http: string; version: string | null }[] = [];
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, async fetch(req) {
      const body = req.method === "POST" ? await req.json().catch(() => null) : null;
      seen.push({ method: body?.method, http: req.method, version: req.headers.get("mcp-protocol-version") });
      if (req.method === "DELETE") return new Response(null, { status: 200 });
      if (body?.id === undefined) return new Response(null, { status: 202 });
      const msg = body.method === "initialize" ? initResult(body.id) : listResult(body.id);
      // Ответ отдан, поток не закрывается
      const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse(msg))); } });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "mcp-session-id": "s-open" } });
    } });
    try {
      const path = b.bridge({ name: "o", url: `http://127.0.0.1:${server.port}/mcp`, headers: { Authorization: `Bearer ${secretRef("TOK")}` } });
      const r = await run(path, [init, inited, list(2)], { open: 1500, kill: 15000 });
      expect(r.byId(1)?.result?.serverInfo?.name).toBe("stub");
      expect(r.byId(2)?.result?.tools?.[0]?.name).toBe("ok_tool");
      expect(r.hung).toBe(false);
      const del = seen.find((s) => s.http === "DELETE");
      expect(del?.version).toBe("2025-06-18");
    } finally { server.stop(true); }
  }, 30000);

  test("404 на запрос с сессией: повторный initialize (один на параллельные запросы), затем исходный запрос", async () => {
    const b = box();
    let inits = 0;
    let initialized = 0;
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
      const body = await req.json().catch(() => null);
      const sid = req.headers.get("mcp-session-id");
      if (body?.method === "initialize") { inits++; return Response.json(initResult(body.id), { headers: { "mcp-session-id": `s${inits}` } }); }
      if (sid === "s1") return new Response("gone", { status: 404 });
      if (body?.method === "notifications/initialized") { initialized++; return new Response(null, { status: 202 }); }
      if (body?.id === undefined) return new Response(null, { status: 202 });
      return Response.json(listResult(body.id));
    } });
    try {
      const path = b.bridge({ name: "s", url: `http://127.0.0.1:${server.port}/mcp`, headers: { Authorization: `Bearer ${secretRef("TOK")}` } });
      const r = await run(path, [init, list(2), list(3)]);
      expect(r.byId(2)?.result?.tools?.[0]?.name).toBe("ok_tool");
      expect(r.byId(3)?.result?.tools?.[0]?.name).toBe("ok_tool");
      expect(inits).toBe(2);
      expect(initialized).toBe(1);
      // Ответ на служебный initialize агенту не показывается
      expect(r.msgs.filter((m: any) => m.result?.serverInfo).length).toBe(1);
    } finally { server.stop(true); }
  }, 30000);

  test("202 на запрос с id — ошибка JSON-RPC (GET-поток мост не поддерживает); уведомление — молча", async () => {
    const b = box();
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { return new Response(null, { status: 202 }); } });
    try {
      const path = b.bridge({ name: "a", url: `http://127.0.0.1:${server.port}/mcp`, headers: { Authorization: `Bearer ${secretRef("TOK")}` } });
      const r = await run(path, [init, inited]);
      expect(r.byId(1)?.error?.message).toContain("GET-поток");
      expect(r.msgs.length).toBe(1);
    } finally { server.stop(true); }
  }, 30000);

  test("битый SSE (не JSON, затем конец потока) — ошибка на запрос, а не молчание", async () => {
    const b = box();
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() {
      return new Response("data: not-json\n\n", { headers: { "content-type": "text/event-stream" } });
    } });
    try {
      const path = b.bridge({ name: "x", url: `http://127.0.0.1:${server.port}/mcp`, headers: { Authorization: `Bearer ${secretRef("TOK")}` } });
      const r = await run(path, [init]);
      expect(r.byId(1)?.error).toBeTruthy();
    } finally { server.stop(true); }
  }, 30000);

  test("сервер не отвечает: таймаут — ошибка на запрос; после EOF stdin мост выходит сам", async () => {
    const b = box();
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch() { return new Promise<Response>(() => {}); } });
    try {
      const path = b.bridge({ name: "t", url: `http://127.0.0.1:${server.port}/mcp`, headers: { Authorization: `Bearer ${secretRef("TOK")}` } });
      const answered = await run(path, [init], { open: 3500, args: ["--timeout", "2"] });
      expect(answered.byId(1)?.error?.message).toContain("не ответил");
      const quit = await run(path, [init], { kill: 15000 });
      expect(quit.hung).toBe(false);
    } finally { server.stop(true); }
  }, 40000);
});
