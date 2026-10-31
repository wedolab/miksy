// Живая проверка фазы 2г-1: настоящий `miksy sync` / `miksy trust` в песочнице (временные HOME,
// USERPROFILE, CODEX_HOME, XDG_*, конфигурация miksy, искусственные секреты), затем то, что записал
// miksy, запускают как агент или сам агент. Настоящие конфиги агентов и miksy не читаются и не
// меняются. Не входит в bun test.
//   bun test/live/g1.ts bridge   — мост Antigravity против заглушек: редирект, открытый SSE, 404 сессии,
//                                  202 на запрос, битый SSE; .env/bunfig/прокси каталога сессии; agy mcp list
//   bun test/live/g1.ts helper   — путь конфигурации со спецсимволами (Windows: кириллица, &, %, !;
//                                  macOS: ', $(), `, &), секрет CP: helper и обёртки у Claude и Codex
//   bun test/live/g1.ts trust    — доверие: хуки/командный конфиг без доверия; miksy trust --confirm;
//                                  Claude выполняет хук, Codex загружает командный конфиг только после
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { lingering, record, results, run as runIn, type Box } from "./r1";

const win = process.platform === "win32";
const HERE = resolve(import.meta.dir);
const CLI = resolve(HERE, "..", "..", "src", "cli.ts");
const STUB = join(HERE, "stub.mjs").replaceAll("\\", "/");
const BUN = process.execPath.replaceAll("\\", "/");
const TOK = "tok_G1-a1B2c3D4e5F6g7";
const CP = "65001 & echo PROBE-CP";
const SECRETS: Record<string, string> = { G1_TOKEN: TOK, CP, G1_CYR: "пароль-ёж-42" };
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 12);
const put = (p: string, s: string) => { mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true }); writeFileSync(p, s); };
const git = (dir: string, ...args: string[]) => Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdout: "pipe", stderr: "pipe" });

// Песочница: каталог конфигурации — name (может содержать спецсимволы)
function sandbox(mode: string, agents: string[], configName = "config"): Box {
  mkdirSync(join(tmpdir(), "h2g1"), { recursive: true });
  const root = join(realpathSync(join(tmpdir(), "h2g1")), mode).replaceAll("\\", "/");
  if (!root.includes("/h2g1/")) throw new Error("unsafe sandbox path");
  rmSync(root, { recursive: true, force: true });
  const box: Box = { agent: mode, root, home: `${root}/home`, ws: `${root}/work`, project: `${root}/work/Org/proj`, config: `${root}/${configName}`, logs: `${root}/logs`, port: 0 };
  for (const d of [box.home, box.project, box.logs, `${root}/xdg/data`, `${root}/xdg/state`, `${root}/xdg/cache`]) mkdirSync(d, { recursive: true });
  Bun.spawnSync(["git", "init", "--quiet", box.project]);
  put(`${box.config}/map.yaml`, "global:\n  - { use: global }\nlayers: []\n");
  put(`${box.config}/layers/tree/instructions/00.md`, "# g1 workspace rule\n");
  put(`${box.config}/layers/global/instructions/00.md`, "# g1 global rule\n");
  put(`${box.config}/local/machine.yaml`, `workspace: ${box.ws}\nagents: [${agents.join(", ")}]\n`);
  put(`${box.config}/local/secrets.env`, Object.entries(SECRETS).map(([k, v]) => `${k}="${v.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join("\n") + "\n");
  return box;
}
const miksy = (box: Box, args: string[], label = args.join(" ")) => {
  const r = runIn(box, [process.execPath, CLI, ...args], box.root);
  writeFileSync(`${box.logs}/miksy-${label.replace(/[^a-z0-9]+/gi, "_")}.log`, r.out + r.err);
  if (Object.values(SECRETS).some((v) => (r.out + r.err).includes(v))) record(`вывод miksy ${label} без значений секретов`, false);
  return r;
};

// Агент — асинхронно: заглушки HTTP живут в этом же процессе (spawnSync заблокировал бы их)
async function agent(box: Box, args: string[], timeout = 240000, extra: Record<string, string> = {}) {
  const p = Bun.spawn(args, { cwd: box.project, env: { ...(await import("./r1")).env(box, extra), PWD: box.project }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(), timeout);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  return { code, out, err };
}

async function finish(box: Box) {
  await Bun.sleep(5000); // дочерние процессы агента завершаются не мгновенно
  const all = lingering(box);
  // codex app-server в свежем CODEX_HOME сам подтягивает каталог плагинов (git fetch openai/plugins в
  // .codex/.tmp/plugins-clone-*) — это не процессы miksy, их только завершаем
  const lines = win && all.length ? Bun.spawnSync(["powershell.exe", "-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "ProcessId=${all.map((l) => l.split(" ")[0]).join(" OR ProcessId=")}" | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }`], { stdout: "pipe" }).stdout.toString().split(/\r?\n/) : all;
  const codexPlugins = new Set(lines.filter((l) => l.includes("plugins-clone")).map((l) => l.trim().split(/\s+/)[0]));
  if (all.length) writeFileSync(`${box.logs}/lingering.txt`, lines.join("\n"));
  const left = all.filter((l) => !codexPlugins.has(l.trim().split(/\s+/)[0]));
  record("после проверок процессы песочницы не остались (кроме загрузки плагинов Codex)", left.length === 0, { left, codexPlugins: codexPlugins.size });
  for (const l of all) { try { process.kill(Number(l.trim().split(/\s+/)[0])); } catch {} }
  for (const l of left) { try { process.kill(Number(l.trim().split(/\s+/)[0])); } catch {} }
  const out = resolve(HERE, "..", "..", "out", "2g1");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `results-${box.agent}-${process.platform}.json`), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => r.ok === false).length;
  console.log(`\n${box.agent} (${process.platform}): ${results.length - failed} из ${results.length} без ошибок; песочница ${box.root}`);
  if (failed) process.exitCode = 1;
  else for (let i = 0; i < 10; i++) { try { rmSync(box.root, { recursive: true, force: true }); break; } catch { Bun.sleepSync(1000); } }
}

// ---- мост ----

const initMsg = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "g1", version: "1" } } };
const initResult = (id: unknown) => ({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "g1-stub", version: "1" } } });
const listResult = (id: unknown) => ({ jsonrpc: "2.0", id, result: { tools: [{ name: "http_auth_ok", description: "g1 probe", inputSchema: { type: "object", properties: {} } }] } });
const sse = (m: unknown) => `event: message\ndata: ${JSON.stringify(m)}\n\n`;

function stubs() {
  const seen: { path: string; method?: string; auth: boolean; session: string | null; http: string; version: string | null }[] = [];
  const leaked: (string | null)[] = [];
  let proxied = 0;
  const other = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) { leaked.push(req.headers.get("authorization")); return Response.json(listResult(2)); } });
  const proxy = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { proxied++; return new Response("proxy", { status: 502 }); } });
  let inits = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    const body = req.method === "POST" ? await req.json().catch(() => null) : null;
    const sid = req.headers.get("mcp-session-id");
    seen.push({ path, method: body?.method, auth: req.headers.get("authorization") === `Bearer ${TOK}`, session: sid, http: req.method, version: req.headers.get("mcp-protocol-version") });
    if (req.headers.get("authorization") !== `Bearer ${TOK}`) return new Response("no", { status: 401 });
    if (req.method === "DELETE") return new Response(null, { status: 200 });
    if (path === "/accepted") return new Response(null, { status: 202 });
    if (path === "/broken") return new Response("data: not-json\n\n", { headers: { "content-type": "text/event-stream" } });
    if (body?.id === undefined) return new Response(null, { status: 202 });
    if (path === "/redirect" && body.method !== "initialize") return new Response(null, { status: 307, headers: { location: `http://127.0.0.1:${other.port}/mcp` } });
    if (path === "/expire") {
      if (body.method === "initialize") { inits++; return Response.json(initResult(body.id), { headers: { "mcp-session-id": `s${inits}` } }); }
      if (sid === "s1") return new Response("gone", { status: 404 });
    }
    const msg = body.method === "initialize" ? initResult(body.id) : body.method === "tools/list" ? listResult(body.id) : { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "G1_OK" }] } };
    if (path === "/open") {
      const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse(msg))); } });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "mcp-session-id": "s-open" } });
    }
    return Response.json(msg, { headers: { "mcp-session-id": "s-ok" } });
  } });
  return { seen, leaked, proxied: () => proxied, inits: () => inits, server, other, proxy, stop: () => { server.stop(true); other.stop(true); proxy.stop(true); } };
}

async function talk(box: Box, command: string, msgs: unknown[], open = 1500) {
  const p = Bun.spawn(win ? ["cmd.exe", "/d", "/c", command] : [command], { cwd: box.project, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...(await import("./r1")).env(box), HTTPS_PROXY: `http://127.0.0.1:${box.port}`, HTTP_PROXY: `http://127.0.0.1:${box.port}`, BUN_CONFIG_VERBOSE_FETCH: "curl" } });
  p.stdin.write(msgs.map((m) => JSON.stringify(m)).join("\n") + "\n");
  await p.stdin.flush();
  await Bun.sleep(open);
  p.stdin.end();
  let hung = false;
  const timer = setTimeout(() => { hung = true; p.kill(); }, 20000);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  clearTimeout(timer);
  const msgsOut = out.trim() ? out.trim().split("\n").map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } }) : [];
  return { out, err, hung, byId: (id: unknown) => msgsOut.find((m: any) => m.id === id), count: msgsOut.length };
}

async function bridge() {
  const s = stubs();
  const box = sandbox("bridge", ["gemini"]);
  box.port = s.proxy.port;
  try {
    const url = (path: string) => `http://localhost:${s.server.port}${path}`;
    for (const [name, path] of [["b_ok", "/ok"], ["b_redirect", "/redirect"], ["b_open", "/open"], ["b_expire", "/expire"], ["b_accepted", "/accepted"], ["b_broken", "/broken"]])
      put(`${box.config}/layers/global/mcp/${name}.yaml`, `name: ${name}\nurl: ${url(path)}\nheaders:\n  Authorization: "Bearer \${G1_TOKEN}"\n`);
    // Каталог, где агент открыл сессию: .env с прокси и bunfig с preload
    const marker = `${box.root}/PRELOAD_RAN`;
    writeFileSync(`${box.project}/.env`, `HTTPS_PROXY=http://127.0.0.1:${s.proxy.port}\nHTTP_PROXY=http://127.0.0.1:${s.proxy.port}\nBUN_CONFIG_VERBOSE_FETCH=curl\n`);
    writeFileSync(`${box.project}/bunfig.toml`, `preload = ["./evil.ts"]\n`);
    writeFileSync(`${box.project}/evil.ts`, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
    const r = miksy(box, ["sync", "--global"]);
    record("miksy sync --global", r.code === 0, r.code === 0 ? "" : (r.out + r.err).slice(-600));
    const cfg = JSON.parse(readFileSync(`${box.home}/.gemini/config/mcp_config.json`, "utf8")).mcpServers;
    const cmd = (n: string) => cfg[n]?.command as string;
    record("Antigravity: HTTP с секретом — мост (stdio)", Object.keys(cfg).length === 6 && Object.values(cfg).every((d: any) => d.command && !d.url), Object.keys(cfg));
    const script = readFileSync(cmd("b_ok"), "utf8");
    record("обёртка моста: --no-env-file, пустой --config, cd в local/secrets, сброс прокси/TLS", script.includes("--no-env-file") && script.includes("bridge.bunfig.toml") && /cd /.test(script) && /HTTPS_PROXY/.test(script), "");

    const list = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/list" });
    const inited = { jsonrpc: "2.0", method: "notifications/initialized" };
    const ok = await talk(box, cmd("b_ok"), [initMsg, inited, list(2)]);
    record("мост b_ok: initialize и tools/list, Authorization из файла секрета", ok.byId(2)?.result?.tools?.[0]?.name === "http_auth_ok" && s.seen.filter((x) => x.path === "/ok").every((x) => x.auth), ok.err.slice(0, 300));
    record(".env, bunfig.toml (preload) и прокси каталога сессии не подействовали", !existsSync(marker) && s.proxied() === 0, { preload: existsSync(marker), proxied: s.proxied() });
    const red = await talk(box, cmd("b_redirect"), [initMsg, inited, list(2)]);
    record("мост b_redirect: редирект не выполнен, заголовок не ушёл; на запрос — ошибка", s.leaked.length === 0 && /редирект/.test(red.byId(2)?.error?.message ?? ""), red.byId(2)?.error?.message);
    const open = await talk(box, cmd("b_open"), [initMsg, inited, list(2)]);
    const del = s.seen.find((x) => x.path === "/open" && x.http === "DELETE");
    record("мост b_open: открытый SSE не блокирует; выход после EOF; DELETE с версией протокола", open.byId(2)?.result?.tools?.length === 1 && !open.hung && del?.version === "2025-06-18", { hung: open.hung, del });
    const exp = await talk(box, cmd("b_expire"), [initMsg, inited, list(2), list(3)]);
    record("мост b_expire: 404 — повторный initialize (один), запросы получили ответ", exp.byId(2)?.result && exp.byId(3)?.result && s.inits() === 2, { inits: s.inits() });
    const acc = await talk(box, cmd("b_accepted"), [initMsg, inited]);
    record("мост b_accepted: 202 на запрос — ошибка «GET-поток»", /GET-пот/.test(acc.byId(1)?.error?.message ?? ""), acc.byId(1)?.error?.message);
    const brk = await talk(box, cmd("b_broken"), [initMsg]);
    record("мост b_broken: битый SSE — ошибка на запрос", !!brk.byId(1)?.error, brk.byId(1)?.error?.message);
    const all = [ok, red, open, exp, acc, brk].map((x) => x.out + x.err).join("\n");
    record("stdout/stderr мостов без значения секрета", !all.includes(TOK), "");
    // Сам агент: agy видит инструменты через мост, в том числе при открытом SSE
    const agy = await agent(box, ["agy", "mcp", "list"], 180000);
    writeFileSync(`${box.logs}/agy-mcp-list.txt`, agy.out + agy.err);
    const text = (agy.out + agy.err).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    const lineOf = (n: string) => text.split(/\r?\n/).find((l) => l.includes(n))?.trim() ?? "absent";
    if (agy.code !== 0 && /not found|не является|not recognized/i.test(agy.err)) record("agy mcp list", null, "agy не установлен");
    else {
      for (const n of ["b_ok", "b_open", "b_expire"]) record(`agy mcp list: ${n} в конфиге`, !/absent|fail|error|disconnected/i.test(lineOf(n)), lineOf(n));
    }
  } finally {
    s.stop();
    await finish(box);
  }
}

// ---- helper и обёртки при спецсимволах в пути конфигурации ----

const SPECIAL = win ? "конфиг R&D 100% x!y!z ^(1)" : "cfg o'brien $(touch PROBE) `touch PROBE` & x";

async function helper() {
  const seen: { path: string; auth: boolean; cp: boolean; method?: string }[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const path = new URL(req.url).pathname;
    const body = req.method === "POST" ? await req.json().catch(() => null) : null;
    seen.push({ path, auth: req.headers.get("authorization") === `Bearer ${TOK}`, cp: req.headers.get("x-cp") === CP, method: body?.method });
    if (req.headers.get("authorization") !== `Bearer ${TOK}` || req.headers.get("x-cp") !== CP) return new Response("no", { status: 401 });
    if (!body || body.id === undefined) return new Response(null, { status: 202 });
    return Response.json(body.method === "initialize" ? initResult(body.id) : body.method === "tools/list" ? listResult(body.id) : { jsonrpc: "2.0", id: body.id, result: {} });
  } });
  const box = sandbox("helper", ["claude", "codex"], SPECIAL);
  try {
    const stdio = (name: string) => `name: ${name}\ncommand: ${JSON.stringify(BUN)}\nargs: ${JSON.stringify([STUB, "--name", name, "--log", `${box.logs}/${name}.jsonl`, "--vars", "G1_TOKEN,CP,G1_CYR"])}\nenv:\n  G1_TOKEN: "\${G1_TOKEN}"\n  CP: "\${CP}"\n  G1_CYR: "\${G1_CYR}"\n`;
    const http = (name: string, p: string) => `name: ${name}\nurl: http://127.0.0.1:${server.port}${p}\nheaders:\n  Authorization: "Bearer \${G1_TOKEN}"\n  X-CP: "\${CP}"\n`;
    put(`${box.config}/layers/global/mcp/g_http.yaml`, http("g_http", "/g"));
    put(`${box.config}/layers/global/mcp/g_stdio.yaml`, stdio("g_stdio"));
    put(`${box.config}/layers/tree/mcp/p_http.yaml`, http("p_http", "/p"));
    put(`${box.config}/layers/tree/mcp/p_stdio.yaml`, stdio("p_stdio"));
    for (const args of [["sync", "--global"], ["sync", "--all", "--yes"]]) {
      const r = miksy(box, args);
      record(`miksy ${args.join(" ")} (путь конфигурации «${SPECIAL}»)`, r.code === 0, r.code === 0 ? "" : (r.out + r.err).slice(-800));
    }
    const claudeCfg = JSON.parse(readFileSync(`${box.home}/.claude.json`, "utf8"));
    const helperCmd = claudeCfg.mcpServers?.g_http?.headersHelper as string;
    record("helper — строка-команда с экранированием пути", win ? helperCmd.startsWith('"') && (!SPECIAL.includes("%") || helperCmd.includes('"^%"')) : helperCmd.startsWith("'"), helperCmd);
    // Claude: init-событие (без модели — статусы MCP до запроса)
    const c = await agent(box, ["claude", "-p", "Reply OK.", "--model", "haiku", "--output-format", "stream-json", "--verbose", "--max-turns", "1"], 240000, { MCP_SERVER_CONNECTION_BATCH_SIZE: "10" });
    const init = c.out.split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }).find((x) => x.subtype === "init");
    const st = Object.fromEntries((init?.mcp_servers ?? []).map((x: any) => [x.name, x.status]));
    writeFileSync(`${box.logs}/claude-init.json`, JSON.stringify(init ?? { raw: (c.out + c.err).slice(0, 2000) }, null, 2));
    for (const n of ["g_http", "p_http", "g_stdio", "p_stdio"]) record(`Claude: ${n} connected`, st[n] === "connected", st[n] ?? "absent");
    // Codex: app-server, mcpServerStatus/list
    const list = await codexStatus(box);
    const by = Object.fromEntries(list.map((x: any) => [x.name, x]));
    for (const n of ["g_http", "p_http", "g_stdio", "p_stdio"]) record(`Codex: ${n} — инструменты получены`, Object.keys(by[n]?.tools ?? {}).length > 0, by[n] ? { status: by[n].runtimeStatus, err: by[n].toolsError } : "absent");
    record("HTTP-заглушка: Authorization и X-CP (секрет CP) верны у всех запросов", seen.length > 0 && seen.every((x) => x.auth && x.cp), { n: seen.length, bad: seen.filter((x) => !x.auth || !x.cp).length });
    record("PROBE не создан (путь — данные, не код)", !existsSync(`${box.project}/PROBE`) && !existsSync(`${box.root}/PROBE`), "");
    const logs = ["g_stdio", "p_stdio"].map((n) => existsSync(`${box.logs}/${n}.jsonl`) ? readFileSync(`${box.logs}/${n}.jsonl`, "utf8") : "").join("\n");
    const starts = logs.split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.ev === "start");
    record("stdio-обёртки: значения дошли (sha)", starts.length > 0 && starts.every((e) => Object.entries(e.vars as Record<string, any>).every(([k, v]) => v.present && v.sha === sha(SECRETS[k]))), starts.map((e) => e.name));
  } finally {
    server.stop(true);
    await finish(box);
  }
}

async function codexStatus(box: Box): Promise<any[]> {
  const p = Bun.spawn(["codex", "app-server"], { cwd: box.project, env: { ...(await import("./r1")).env(box), PWD: box.project }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const pending = new Map<number, (v: any) => void>();
  let id = 0;
  // Ответа может не быть (app-server ждёт подтверждения) — не дольше 60 с на запрос
  const send = (method: string, params: unknown) => Promise.race([
    new Promise<any>((res) => { const i = ++id; pending.set(i, res); p.stdin.write(JSON.stringify({ id: i, method, params }) + "\n"); p.stdin.flush(); }),
    Bun.sleep(60000).then(() => ({ timeout: method })),
  ]);
  (async () => {
    let buf = "";
    for await (const chunk of p.stdout) {
      buf += new TextDecoder().decode(chunk);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
      }
    }
  })();
  const timer = setTimeout(() => p.kill(), 120000);
  try {
    await send("initialize", { clientInfo: { name: "g1", version: "1.0.0" } });
    p.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    const thread = await send("thread/start", { cwd: box.project, ephemeral: true });
    await Bun.sleep(10000);
    const list = await send("mcpServerStatus/list", { detail: "full", threadId: thread.result?.thread?.id });
    return list.result?.data ?? [];
  } finally { clearTimeout(timer); p.stdin.end(); p.kill(); await p.exited; }
}

// ---- доверие ----

async function trust() {
  // Различитель доверия Claude — headersHelper проектного HTTP-сервера: Claude выполняет его только в
  // доверенном проекте (в том числе в -p). Хуки проекта claude -p выполняет и без доверия (2.1.310)
  let helperCalls = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const body = req.method === "POST" ? await req.json().catch(() => null) : null;
    if (req.headers.get("authorization") !== `Bearer ${TOK}`) return new Response("no", { status: 401 });
    helperCalls++;
    if (!body || body.id === undefined) return new Response(null, { status: 202 });
    return Response.json(body.method === "initialize" ? initResult(body.id) : body.method === "tools/list" ? listResult(body.id) : { jsonrpc: "2.0", id: body.id, result: {} });
  } });
  const box = sandbox("trust", ["claude", "codex"]);
  put(`${box.config}/layers/tree/mcp/p_http.yaml`, `name: p_http\nurl: http://127.0.0.1:${server.port}/p\nheaders:\n  Authorization: "Bearer \${G1_TOKEN}"\n`);
  try {
    const marker = `${box.root}/HOOK_RAN`;
    // Команда закоммитила хук Claude и свой .codex/config.toml со stdio-сервером
    put(`${box.project}/.claude/settings.json`, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `${JSON.stringify(BUN)} -e "require('fs').writeFileSync(${JSON.stringify(marker).replaceAll('"', '\\"')}, 'ran')"` }] }] } }, null, 2));
    put(`${box.project}/.codex/config.toml`, `[mcp_servers.team]\ncommand = ${JSON.stringify(BUN)}\nargs = ${JSON.stringify([STUB, "--name", "team", "--log", `${box.logs}/team.jsonl`])}\n`);
    git(box.project, "add", ".");
    git(box.project, "commit", "-q", "-m", "team settings");
    const s1 = miksy(box, ["sync", "--all", "--yes"], "sync-1");
    const claudeTrusted = () => existsSync(`${box.home}/.claude.json`) && Object.entries(JSON.parse(readFileSync(`${box.home}/.claude.json`, "utf8")).projects ?? {}).some(([k, v]: [string, any]) => k.toLowerCase().replaceAll("\\", "/") === box.project.toLowerCase() && v.hasTrustDialogAccepted === true);
    const codexTrusted = () => existsSync(`${box.home}/.codex/config.toml`) && Object.values((Bun.TOML.parse(readFileSync(`${box.home}/.codex/config.toml`, "utf8")) as any).projects ?? {}).some((v: any) => v.trust_level === "trusted");
    record("sync без терминала: доверия Claude и Codex нет", s1.code === 0 && !claudeTrusted() && !codexTrusted(), { code: s1.code });
    record("sync: блок «Нужно решение пользователя» с командой хука и сервером Codex, текст для агента", /Нужно решение пользователя/.test(s1.out) && s1.out.includes("HOOK_RAN") && s1.out.includes("MCP team") && /не подтверждай доверие сам/.test(s1.out), "");
    const d1 = miksy(box, ["doctor"], "doctor-1");
    record("doctor: блок решения, код 1", d1.code === 1 && /Нужно решение пользователя/.test(d1.out), { code: d1.code });
    const claudeRun = async () => {
      const c = await agent(box, ["claude", "-p", "Reply OK.", "--model", "haiku", "--output-format", "stream-json", "--verbose", "--max-turns", "1"]);
      const init = c.out.split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }).find((x) => x.subtype === "init");
      return Object.fromEntries((init?.mcp_servers ?? []).map((x: any) => [x.name, x.status]));
    };
    const st1 = await claudeRun();
    record("Claude без доверия: headersHelper проекта не выполнен (p_http не connected)", st1.p_http !== "connected" && helperCalls === 0, st1.p_http ?? "absent");
    record("Claude -p выполняет хук проекта и без доверия (наблюдение, не проверка miksy)", null, { hookRan: existsSync(marker) });
    rmSync(marker, { force: true });
    const team1 = (await codexStatus(box)).find((x: any) => x.name === "team");
    record("Codex без доверия: командный сервер не загружен", !team1, team1 ? "загружен" : "");
    const noFlag = miksy(box, ["trust", box.project], "trust-noflag");
    record("miksy trust без терминала и без --confirm — отказ (код 2)", noFlag.code === 2, noFlag.err.trim().slice(0, 200));
    const t = miksy(box, ["trust", box.project, "--confirm"], "trust-confirm");
    record("miksy trust --confirm: доверие Claude и Codex поставлено, решение в local/trust.json", t.code === 0 && claudeTrusted() && codexTrusted() && existsSync(`${box.config}/local/trust.json`), { code: t.code });
    const st2 = await claudeRun();
    record("Claude с доверием: headersHelper выполнен, p_http connected (доверие действует)", st2.p_http === "connected" && helperCalls > 0, st2.p_http ?? "absent");
    const team2 = (await codexStatus(box)).find((x: any) => x.name === "team");
    record("Codex с доверием: командный сервер загружен", !!team2, team2 ? team2.runtimeStatus : "absent");
    const s2 = miksy(box, ["sync", "--all", "--yes"], "sync-2");
    record("повторный sync: не спрашивает, доверие на месте", !/Нужно решение пользователя/.test(s2.out) && claudeTrusted() && codexTrusted(), "");
    // Команда изменила хук — доверие miksy снято до нового решения
    put(`${box.project}/.claude/settings.json`, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo changed" }] }] } }));
    git(box.project, "commit", "-q", "-am", "change hook");
    const s3 = miksy(box, ["sync", "--all", "--yes"], "sync-3");
    record("хук изменён: доверие Claude снято, снова нужно решение; Codex — без изменений", /Нужно решение пользователя/.test(s3.out) && s3.out.includes("echo changed") && !claudeTrusted() && codexTrusted(), "");
    const deny = miksy(box, ["trust", box.project, "--deny", "--agent", "claude"], "trust-deny");
    const s4 = miksy(box, ["sync", "--all", "--yes"], "sync-4");
    const d4 = miksy(box, ["doctor"], "doctor-4");
    record("--deny: не предлагается в sync, в doctor — справочно", deny.code === 0 && !/Нужно решение пользователя/.test(s4.out) && /Доверие отклонено пользователем/.test(d4.out) && !claudeTrusted(), "");
    const c = miksy(box, ["clean", "--all"], "clean");
    record("clean: доверие, поставленное miksy, снято", c.code === 0 && !codexTrusted() && !claudeTrusted(), "");
  } finally {
    server.stop(true);
    await finish(box);
  }
}

// Псевдотерминал (Python pty): команда видит терминал, ответы — по одному на каждый «[y/N]»
const PTY = `import os, pty, sys, select
answers = [a for a in sys.argv[1].split(",") if a]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[2], sys.argv[2:])
out, i = b"", 0
while True:
    r, _, _ = select.select([fd], [], [], 240)
    if not r: break
    try: data = os.read(fd, 4096)
    except OSError: break
    if not data: break
    out += data
    if out.count(b"[y/N]") > i and i < len(answers):
        os.write(fd, (answers[i] + "\\n").encode()); i += 1
os.waitpid(pid, 0)
sys.stdout.buffer.write(out)
`;
const inPty = (box: Box, env: Record<string, string>, answers: string[], args: string[]) =>
  Bun.spawnSync(["python3", "-c", PTY, answers.join(","), ...args], { cwd: box.root, env, stdout: "pipe", stderr: "pipe", timeout: 300000 }).stdout.toString();

// Вопросы в терминале (macOS/Linux): ручной sync --yes всё равно спрашивает; y — Claude, n — Codex;
// ответы запоминаются
async function tty() {
  const box = sandbox("tty", ["claude", "codex"]);
  try {
    put(`${box.project}/.claude/settings.json`, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo tty-hook" }] }] } }));
    put(`${box.project}/.codex/config.toml`, `[mcp_servers.team]\ncommand = "team-server"\n`);
    git(box.project, "add", ".");
    git(box.project, "commit", "-q", "-m", "team settings");
    const e = (await import("./r1")).env(box);
    const out = inPty(box, e, ["y", "n"], [process.execPath, CLI, "sync", "--all", "--yes"]);
    writeFileSync(`${box.logs}/tty-sync.log`, out);
    const decisions = existsSync(`${box.config}/local/trust.json`) ? Object.values(JSON.parse(readFileSync(`${box.config}/local/trust.json`, "utf8")).decisions)[0] as any : {};
    record("sync --yes в терминале спрашивает о доверии (Claude и Codex) и показывает хук", (out.match(/\[y\/N\]/g) ?? []).length === 2 && out.includes("tty-hook") && out.includes("team-server"), "");
    record("ответы записаны: Claude — yes, Codex — no", decisions?.claude?.answer === "yes" && decisions?.codex?.answer === "no", decisions);
    const cl = existsSync(`${box.home}/.claude.json`) ? JSON.parse(readFileSync(`${box.home}/.claude.json`, "utf8")).projects ?? {} : {};
    const cx = existsSync(`${box.home}/.codex/config.toml`) ? (Bun.TOML.parse(readFileSync(`${box.home}/.codex/config.toml`, "utf8")) as any).projects ?? {} : {};
    record("доверие: Claude поставлено, Codex — нет", Object.values(cl).some((v: any) => v.hasTrustDialogAccepted === true) && !Object.values(cx).some((v: any) => v.trust_level === "trusted"), "");
    const again = inPty(box, e, [], [process.execPath, CLI, "sync", "--all", "--yes"]);
    writeFileSync(`${box.logs}/tty-sync-2.log`, again);
    record("повторный sync в терминале не спрашивает", again.includes("Готово") && !/\[y\/N\]/.test(again), "");
  } finally {
    await finish(box);
  }
}

const mode = process.argv[2] ?? "";
if (mode === "bridge") await bridge();
else if (mode === "helper") await helper();
else if (mode === "trust") await trust();
else if (mode === "tty") await tty();
else { console.error("bun test/live/g1.ts bridge|helper|trust|tty"); process.exit(2); }
