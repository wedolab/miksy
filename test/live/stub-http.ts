// Заглушка Streamable HTTP MCP для живых проверок (bun).
// bun stub-http.ts --port <порт> --log <файл> --expect-sha <sha256[0:12] ожидаемого "Bearer <токен>"> [--key-sha <sha256[0:12] параметра key>]
// Значения заголовка и параметра не пишет: только наличие, длину, sha256[0:12], совпадение.
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";

const arg = (k: string, d = "") => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const port = Number(arg("--port", "4711"));
const logFile = arg("--log");
const expect = arg("--expect-sha");
const keySha = arg("--key-sha");
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 12);
const log = (o: object) => { if (logFile) appendFileSync(logFile, JSON.stringify({ t: Date.now(), ...o }) + "\n"); };

Bun.serve({
  port, hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const auth = req.headers.get("authorization");
    const key = url.searchParams.get("key");
    const a = auth === null ? { present: false } : { present: true, len: auth.length, ok: sha(auth) === expect };
    const k = key === null ? undefined : { len: key.length, ok: sha(key) === keySha };
    let method: string | undefined; let body: any;
    if (req.method === "POST") { try { body = await req.json(); method = body?.method; } catch {} }
    log({ ev: "http", m: req.method, path: url.pathname, rpc: method, auth: a, ...(k && { key: k }), ua: (req.headers.get("user-agent") ?? "").slice(0, 60) });
    if (url.pathname.startsWith("/.well-known")) return new Response("not found", { status: 404 });
    if (!a.present || !(a as any).ok || (keySha && url.pathname === "/u" && !k?.ok)) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
    if (req.method === "GET") return new Response("method not allowed", { status: 405 });
    if (req.method === "DELETE") return new Response(null, { status: 200 });
    if (!body || body.id === undefined) return new Response(null, { status: 202 });
    const reply = (result: object) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
      { headers: { "content-type": "application/json", "mcp-session-id": "live-session" } });
    if (method === "initialize")
      return reply({ protocolVersion: body.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "live-http", version: "1.0.0" } });
    if (method === "tools/list")
      return reply({ tools: [{ name: "http_auth_ok", description: "live http probe: Authorization accepted", inputSchema: { type: "object", properties: {} } }] });
    if (method === "tools/call") return reply({ content: [{ type: "text", text: "LIVE_HTTP_OK" }] });
    if (method === "ping") return reply({});
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "not found" } }), { headers: { "content-type": "application/json" } });
  },
});
log({ ev: "listen", port });
console.log(`live http stub on ${port}`);
