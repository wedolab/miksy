// Заглушка Anthropic API для живых проверок без входа (круг 12a, test/live/open-session.ts).
// bun stub-api.ts <порт> <файл release> <лог>: держит /v1/messages, пока нет файла release, потом отвечает «ok»
// (SSE); в лог — только время, метод и путь запроса (заголовки и ключ не пишет). Остальные пути — 404.
import { existsSync, appendFileSync } from "node:fs";
const [port, release, log] = [Number(process.argv[2]), process.argv[3], process.argv[4]];
const sse = (ev: string, d: object) => `event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`;
Bun.serve({ port, hostname: "127.0.0.1", idleTimeout: 0, async fetch(req) {
  const u = new URL(req.url);
  appendFileSync(log, `${Date.now()} ${req.method} ${u.pathname}\n`);
  if (req.method === "POST" && u.pathname === "/v1/messages") {
    const body: any = await req.json().catch(() => ({}));
    while (!existsSync(release)) await Bun.sleep(200);
    const model = body.model ?? "m";
    const usage = { input_tokens: 1, output_tokens: 1 };
    if (!body.stream) return Response.json({ id: "msg_1", type: "message", role: "assistant", model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage });
    const text = sse("message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage } })
      + sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
      + sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })
      + sse("content_block_stop", { type: "content_block_stop", index: 0 })
      + sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } })
      + sse("message_stop", { type: "message_stop" });
    return new Response(text, { headers: { "content-type": "text/event-stream" } });
  }
  return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
} });
console.log("ready");
