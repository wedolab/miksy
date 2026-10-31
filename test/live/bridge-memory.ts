// Замер памяти моста MCP stdio ↔ HTTP (src/bridge.ts) — приватная память процесса, не RSS.
// Windows: Private Working Set (физическая приватная память, столбец «Память» диспетчера задач) и
// Private Bytes (выделенная приватная, commit); macOS: phys_footprint (footprint/vmmap) и RSS.
// Мост запускается так же, как его запустит агент: обёрткой, которую записал miksy sync
// (песочница test/live/r1.ts), после initialize + tools/list к HTTP-заглушке. Для сравнения —
// пустой процесс Bun (bun -e "setInterval") того же запуска.
//   bun test/live/bridge-memory.ts [число мостов, по умолчанию 3]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { finish, record, setup } from "./r1";

const win = process.platform === "win32";
const n = Number(process.argv[2] ?? 3);
const box = setup("gemini", 4798, "brmem");
const cfg = JSON.parse(readFileSync(`${box.home}/.gemini/config/mcp_config.json`, "utf8"));
const wrapper: string = cfg.mcpServers.g_http.command;
const rpc = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mem", version: "1" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
].map((m) => JSON.stringify(m)).join("\n") + "\n";

type Mem = { pid: number; name: string; privateMB: number; commitMB?: number; rssMB: number };
const mb = (b: number) => Math.round((b / 1048576) * 10) / 10;

// Процессы по подстроке командной строки
function measure(needle: string): Mem[] {
  if (win) {
    const r = Bun.spawnSync(["powershell.exe", "-NoProfile", "-Command",
      "$perf = @{}; Get-CimInstance Win32_PerfRawData_PerfProc_Process | ForEach-Object { $perf[[int]$_.IDProcess] = $_.WorkingSetPrivate }; " +
      "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Replace('/', '\\').Contains($env:MEM_NEEDLE) -and $_.Name -ne 'powershell.exe' } | ForEach-Object { $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if ($p) { \"$($_.ProcessId)|$($_.Name)|$($perf[[int]$_.ProcessId])|$($p.PrivateMemorySize64)|$($p.WorkingSet64)\" } }"],
      { env: { ...process.env, MEM_NEEDLE: needle.replaceAll("/", "\\") }, stdout: "pipe" });
    return r.stdout.toString().split(/\r?\n/).filter(Boolean).map((l) => {
      const [pid, name, pws, priv, ws] = l.split("|");
      return { pid: Number(pid), name, privateMB: mb(Number(pws)), commitMB: mb(Number(priv)), rssMB: mb(Number(ws)) };
    });
  }
  const ps = Bun.spawnSync(["ps", "-axo", "pid=,rss=,command="], { stdout: "pipe" }).stdout.toString().split("\n")
    .map((l) => l.trim()).filter((l) => l.includes(needle) && !l.includes("ps -axo"));
  return ps.map((l) => {
    const [pid, rss] = l.split(/\s+/);
    let foot = NaN;
    const f = Bun.spawnSync(["footprint", "-p", pid], { stdout: "pipe", stderr: "pipe" }).stdout.toString();
    const m = f.match(/Footprint:\s*([\d.]+)\s*(KB|MB|GB)/i) ?? f.match(/phys_footprint:\s*([\d.]+)\s*(KB|MB|GB)/i);
    if (m) foot = Number(m[1]) * (m[2].toUpperCase() === "KB" ? 1 / 1024 : m[2].toUpperCase() === "GB" ? 1024 : 1);
    else {
      const v = Bun.spawnSync(["vmmap", "--summary", pid], { stdout: "pipe", stderr: "pipe" }).stdout.toString();
      const k = v.match(/Physical footprint:\s*([\d.]+)([KMG])/);
      if (k) foot = Number(k[1]) * (k[2] === "K" ? 1 / 1024 : k[2] === "G" ? 1024 : 1);
    }
    return { pid: Number(pid), name: "bun", privateMB: Math.round(foot * 10) / 10, rssMB: mb(Number(rss) * 1024) };
  });
}

const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : NaN);
const summary = (list: Mem[]) => {
  const buns = list.filter((m) => /bun/i.test(m.name));
  const cmd = list.filter((m) => /cmd/i.test(m.name));
  return { count: buns.length, privateMB: avg(buns.map((m) => m.privateMB)), ...(win && { commitMB: avg(buns.map((m) => m.commitMB!)) }),
    rssMB: avg(buns.map((m) => m.rssMB)), ...(cmd.length && { cmdPrivateMB: avg(cmd.map((m) => m.privateMB)) }) };
};

// Пустой Bun для сравнения: столько же памяти стоит любой процесс Bun
const marker = `brmem-idle-${process.pid}`;
const idleBun = Bun.spawn([process.execPath, "-e", `setInterval(() => {}, 1000) // ${marker}`], { stdout: "ignore" });
await Bun.sleep(2000);
const baseline = summary(measure(marker));
idleBun.kill();

async function bridges(smol: boolean) {
  const cmd = smol ? (() => {
    // Тот же мост с bun --smol (меньше куча): копия обёртки с флагом
    const text = readFileSync(wrapper, "utf8").replace(/(bun(\.exe)?["']?)( )/i, "$1 --smol$3");
    const p = wrapper.replace(/(\.(cmd|sh))$/, "-smol$1");
    writeFileSync(p, text, { mode: 0o700 });
    return p;
  })() : wrapper;
  const procs = Array.from({ length: n }, () => {
    const p = Bun.spawn(win ? ["cmd.exe", "/d", "/c", cmd] : [cmd], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    p.stdin.write(rpc);
    return p;
  });
  const readFirst = async (p: (typeof procs)[number]) => {
    const reader = p.stdout.getReader();
    let text = "";
    const until = Date.now() + 20000;
    while (Date.now() < until && (text.match(/\n/g) ?? []).length < 2) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    return text;
  };
  const outs = await Promise.all(procs.map(readFirst));
  record(`мосты${smol ? " --smol" : ""} (${n}) ответили на initialize и tools/list`, outs.every((o) => o.includes('"id":1') && o.includes("http_auth_ok")));
  await Bun.sleep(3000);
  const needle = `${box.root}/`;
  const pick = (list: Mem[]) => list.filter((m) => !/stub-http/.test(m.name));
  // Родитель моста на Windows — cmd.exe обёртки (его командная строка — путь к …-bridge.cmd)
  const parents = () => (win ? summary(measure("-bridge")).cmdPrivateMB : undefined);
  const idle = { ...summary(pick(measure("bridge.ts"))), ...(win && { cmdPrivateMB: parents() }) };
  for (const p of procs) for (let i = 0; i < 50; i++) p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 100 + i, method: "tools/call", params: { name: "http_auth_ok", arguments: {} } }) + "\n");
  await Bun.sleep(5000);
  const busy = { ...summary(pick(measure("bridge.ts"))), ...(win && { cmdPrivateMB: parents() }) };
  for (const p of procs) p.stdin.end();
  await Promise.all(procs.map((p) => p.exited));
  void needle;
  return { idle, afterCalls: busy };
}

const plain = await bridges(false);
const smol = await bridges(true);
const result = { platform: process.platform, bun: Bun.version, n, baselineIdleBun: baseline, bridge: plain, bridgeSmol: smol };
console.log(JSON.stringify(result, null, 2));
record("замер получен", plain.idle.count === n && Number.isFinite(plain.idle.privateMB), { bridge: plain.idle.privateMB, smol: smol.idle.privateMB, bun: baseline.privateMB });
const out = resolve(import.meta.dir, "..", "..", "out", "2a");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, `bridge-memory-${process.platform}.json`), JSON.stringify(result, null, 2));
finish(box, `results-bridge-memory-${process.platform}.json`);
