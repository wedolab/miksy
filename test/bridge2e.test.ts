// Мост, фаза 2д (§4d: Г4, Г5): уведомление с открытым SSE не держит барьер; поздний 404 старой сессии
// ждёт текущего восстановления; неудачное восстановление повторяется (с ограничением частоты);
// маскировка — по строкам до сериализации, id и служебные поля JSON-RPC не трогаются. Запуск — через
// обёртку, как у агента. Значения искусственные.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLauncher } from "../src/launch";
import { ENGINE } from "../src/load";
import type { McpServer } from "../src/types";
import { secretRef } from "../src/vars";

const win = process.platform === "win32";
const os = win ? "windows" : process.platform === "darwin" ? "macos" : "linux";
const roots: string[] = [];
afterAll(() => { for (const r of roots) try { rmSync(r, { recursive: true, force: true }); } catch { /* занят зависшим мостом (Windows) */ } });

function box(secrets: Record<string, string> = { TOK: "tok_A1b2-C3d4.E5f6_G7h8" }) {
  const root = mkdtempSync(join(tmpdir(), "bridge2e-")).replaceAll("\\", "/");
  roots.push(root);
  const local = `${root}/local`;
  mkdirSync(`${local}/secrets`, { recursive: true });
  for (const [n, v] of Object.entries(secrets)) writeFileSync(`${local}/secrets/${n}`, v + "\n");
  const launcher = createLauncher({ os, local, agent: "gemini", target: { scope: "global" }, bun: process.execPath, engine: ENGINE });
  return (s: McpServer) => {
    const path = launcher.bridge(s);
    for (const f of launcher.files()) {
      if (f.mode !== "own") continue;
      const p = `${local}/${f.path}`;
      mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true });
      writeFileSync(p, f.content, { mode: 0o700 });
    }
    return path;
  };
}

const initMsg = (id: unknown = 1) => ({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
const inited = { jsonrpc: "2.0", method: "notifications/initialized" };
const list = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/list" });
const initResult = (id: unknown) => ({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "1" } } });
const listResult = (id: unknown) => ({ jsonrpc: "2.0", id, result: { tools: [{ name: "ok_tool", inputSchema: { type: "object" } }] } });
const enc = new TextEncoder();
const event = (m: unknown) => enc.encode(`event: message\ndata: ${JSON.stringify(m)}\n\n`);

// Сессия агента: сообщения можно слать с паузами; lines — всё, что мост написал в stdout (по мере прихода)
function agent(path: string, args: string[] = []) {
  const p = Bun.spawn(win ? ["cmd.exe", "/d", "/c", path, ...args] : [path, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const lines: { at: number; msg: any }[] = [];
  const started = Date.now();
  const reading = (async () => {
    let buf = "";
    const dec = new TextDecoder();
    for await (const chunk of p.stdout) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const l = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (l) lines.push({ at: Date.now() - started, msg: (() => { try { return JSON.parse(l); } catch { return { raw: l }; } })() });
      }
    }
  })();
  return {
    lines,
    send(...msgs: unknown[]) { p.stdin.write(msgs.map((m) => JSON.stringify(m)).join("\n") + "\n"); p.stdin.flush(); },
    byId: (id: unknown) => lines.find((l) => l.msg.id === id),
    async until(id: unknown, ms = 10000) { const end = Date.now() + ms; while (!lines.some((l) => l.msg.id === id) && Date.now() < end) await Bun.sleep(20); return lines.find((l) => l.msg.id === id); },
    async close() {
      p.stdin.end();
      const timer = setTimeout(() => p.kill(), 15000);
      const err = await new Response(p.stderr).text();
      await reading;
      await p.exited;
      clearTimeout(timer);
      return err;
    },
  };
}

describe("Г4: мост — уведомления и восстановление сессии", () => {
  test("notifications/initialized с открытым SSE-ответом не держит следующие запросы", async () => {
    const make = box();
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, async fetch(req) {
      const body = await req.json().catch(() => null);
      if (req.method === "DELETE") return new Response(null, { status: 200 });
      if (body?.method === "initialize") return Response.json(initResult(body.id), { headers: { "mcp-session-id": "s1" } });
      // Уведомление: 200 и поток без конца
      if (body?.id === undefined) return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(": keepalive\n\n")); } }), { headers: { "content-type": "text/event-stream" } });
      return Response.json(listResult(body.id));
    } });
    try {
      const a = agent(make({ name: "n", url: `http://127.0.0.1:${server.port}/mcp`, headers: { Authorization: `Bearer ${secretRef("TOK")}` } }), ["--timeout", "60"]);
      a.send(initMsg(), inited, list(2));
      const got = await a.until(2, 5000);
      expect(got?.msg.result?.tools?.[0]?.name).toBe("ok_tool");
      await a.close();
    } finally { server.stop(true); }
  }, 40000);

  test("поздний 404 старой сессии ждёт конца повторного initialize и initialized", async () => {
    const make = box();
    let inits = 0, ready = false;
    const log: string[] = [];
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, async fetch(req) {
      const body = await req.json().catch(() => null);
      const sid = req.headers.get("mcp-session-id");
      if (req.method === "DELETE") return new Response(null, { status: 200 });
      log.push(`${body?.method}#${body?.id ?? "-"}@${sid ?? "-"}`);
      if (body?.method === "initialize") {
        inits++;
        if (inits === 1) return Response.json(initResult(body.id), { headers: { "mcp-session-id": "s1" } });
        // Повторный: заголовок сессии сразу, результат — через 300 мс
        return new Response(new ReadableStream({ start(c) {
          c.enqueue(enc.encode(": started\n\n"));
          setTimeout(() => { c.enqueue(event(initResult(body.id))); c.close(); }, 300);
        } }), { headers: { "content-type": "text/event-stream", "mcp-session-id": "s2" } });
      }
      if (sid === "s1" && body?.id !== undefined) {
        if (body.id === 3) await Bun.sleep(100);
        return new Response("gone", { status: 404 });
      }
      if (body?.method === "notifications/initialized") { if (sid === "s2") ready = true; return new Response(null, { status: 202 }); }
      if (sid === "s2" && !ready) return new Response("not initialized", { status: 409 });
      return Response.json(listResult(body.id));
    } });
    try {
      const a = agent(make({ name: "l", url: `http://127.0.0.1:${server.port}/mcp`, headers: { Authorization: `Bearer ${secretRef("TOK")}` } }));
      a.send(initMsg(), inited, list(2), list(3));
      const two = await a.until(2), three = await a.until(3);
      await a.close();
      expect(two?.msg.result?.tools?.[0]?.name).toBe("ok_tool");
      expect(three?.msg.result?.tools?.[0]?.name).toBe("ok_tool");
      expect(inits).toBe(2);
      expect(log.filter((l) => l.endsWith("@s2") && l.startsWith("tools/list")).length).toBe(2);
    } finally { server.stop(true); }
  }, 40000);

  test("неудачное восстановление не кешируется навсегда: следующий 404 после паузы — новая попытка", async () => {
    const make = box();
    let inits = 0;
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, async fetch(req) {
      const body = await req.json().catch(() => null);
      const sid = req.headers.get("mcp-session-id");
      if (req.method === "DELETE") return new Response(null, { status: 200 });
      if (body?.method === "initialize") {
        inits++;
        if (inits === 2) return new Response("down", { status: 500 });
        return Response.json(initResult(body.id), { headers: { "mcp-session-id": `s${inits}` } });
      }
      if (sid === "s1" && body?.id !== undefined) return new Response("gone", { status: 404 });
      if (body?.id === undefined) return new Response(null, { status: 202 });
      return Response.json(listResult(body.id));
    } });
    try {
      const a = agent(make({ name: "f", url: `http://127.0.0.1:${server.port}/mcp`, headers: { Authorization: `Bearer ${secretRef("TOK")}` } }));
      a.send(initMsg(), inited, list(2));
      expect((await a.until(2))?.msg.error).toBeTruthy();
      await Bun.sleep(6000);
      a.send(list(3));
      const three = await a.until(3);
      await a.close();
      expect(three?.msg.result?.tools?.[0]?.name).toBe("ok_tool");
      expect(inits).toBe(3);
    } finally { server.stop(true); }
  }, 40000);
});

describe("Г5: мост — маскировка без порчи JSON-RPC", () => {
  test("числовой id, совпавший с секретом, не меняется; короткое значение в строке ответа маскируется", async () => {
    const make = box({ NUM: "1234", PIN: "abc", TOK: "tok_A1b2-C3d4.E5f6_G7h8" });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
      const body = await req.json().catch(() => null);
      if (req.method === "DELETE") return new Response(null, { status: 200 });
      if (body?.method === "initialize") return Response.json(initResult(body.id));
      if (body?.id === undefined) return new Response(null, { status: 202 });
      // Эхо заголовков в строках результата
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { pin: req.headers.get("x-pin"), num: req.headers.get("x-num"), text: `token is ${req.headers.get("x-tok")}`, count: 1234 } });
    } });
    try {
      const a = agent(make({ name: "m", url: `http://127.0.0.1:${server.port}/mcp`, headers: { "X-Pin": secretRef("PIN"), "X-Num": secretRef("NUM"), "X-Tok": secretRef("TOK") } }));
      a.send(initMsg(1234), inited, list(2));
      const init = await a.until(1234), two = await a.until(2);
      await a.close();
      expect(init?.msg.result?.serverInfo?.name).toBe("stub");
      expect(two?.msg.result).toEqual({ pin: "<secret:PIN>", num: "<secret:NUM>", text: "token is <secret:TOK>", count: 1234 });
      expect(a.lines.some((l) => l.msg.raw)).toBe(false);
    } finally { server.stop(true); }
  }, 40000);
});
