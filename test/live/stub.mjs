// Заглушка stdio MCP для живых проверок (шаг 3б, фаза 2а). Работает в bun и node.
// Аргументы: --name <имя> --log <файл jsonl> --vars A,B,C
// Значения переменных не печатает и не пишет: только наличие, длину, sha256[0:12].
// Инструменты: probe + по одному на переменную: <var>_len<N>_<sha8> или <var>_missing.
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const arg = (k, d = "") => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const name = arg("--name", "stub");
const logFile = arg("--log");
const vars = arg("--vars").split(",").filter(Boolean);
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const log = (o) => { if (logFile) appendFileSync(logFile, JSON.stringify({ t: Date.now(), name, pid: process.pid, ...o }) + "\n"); };

const report = Object.fromEntries(vars.map((v) => {
  const val = process.env[v];
  return [v, val === undefined ? { present: false } : { present: true, len: [...val].length, sha: sha(val).slice(0, 12) }];
}));
const toolName = (v) => {
  const r = report[v];
  return (r.present ? `${v}_len${r.len}_${r.sha.slice(0, 8)}` : `${v}_missing`).toLowerCase().slice(0, 60);
};

let consoleInfo = null;
if (process.platform === "win32" && typeof Bun !== "undefined") {
  try {
    const { dlopen, FFIType } = await import("bun:ffi");
    const k = dlopen("kernel32.dll", { GetConsoleWindow: { args: [], returns: FFIType.ptr } });
    const u = dlopen("user32.dll", { IsWindowVisible: { args: [FFIType.ptr], returns: FFIType.i32 } });
    const hwnd = k.symbols.GetConsoleWindow();
    consoleInfo = { hwnd: hwnd ? String(hwnd) : null, visible: hwnd ? u.symbols.IsWindowVisible(hwnd) !== 0 : false };
  } catch (e) { consoleInfo = { error: String(e) }; }
}
let parent = null;
if (process.platform === "win32") {
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-Command",
      `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${process.ppid}"; $g=if($p){Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)"}; "$($p.Name)|$($g.Name)|$($g.ParentProcessId)"`],
      { encoding: "utf8", windowsHide: true, timeout: 8000 }).trim().split("|");
    parent = { parent: out[0], grandparent: out[1], ggpid: out[2] };
  } catch (e) { parent = { error: String(e).slice(0, 200) }; }
} else {
  try { parent = { parent: execFileSync("ps", ["-o", "comm=", "-p", String(process.ppid)], { encoding: "utf8" }).trim() }; } catch {}
}
log({ ev: "start", runtime: typeof Bun !== "undefined" ? "bun" : "node", ppid: process.ppid, cwd: process.cwd(), argv: process.argv.slice(2), vars: report, console: consoleInfo, ...parent });

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    log({ ev: "rpc", method: m.method });
    if (m.id === undefined) continue;
    if (m.method === "initialize") {
      send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: `h3b-${name}`, version: "1.0.0" } } });
    } else if (m.method === "tools/list") {
      const tools = [{ name: "probe", description: `h3b probe ${name}: ${JSON.stringify(report)}`, inputSchema: { type: "object", properties: {} } },
        ...vars.map((v) => ({ name: toolName(v), description: `h3b var ${v}`, inputSchema: { type: "object", properties: {} } }))];
      send({ jsonrpc: "2.0", id: m.id, result: { tools } });
    } else if (m.method === "tools/call") {
      send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `H3B_PROBE_OK ${name} ${JSON.stringify(report)}` }] } });
    } else if (m.method === "ping") {
      send({ jsonrpc: "2.0", id: m.id, result: {} });
    } else {
      send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } });
    }
  }
});
process.stdin.on("end", () => { log({ ev: "stdin-end" }); process.exit(0); });
