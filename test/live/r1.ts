// Живая проверка фазы 2а (Р1, B′) у установленного агента: настоящий `miksy sync` в песочнице
// (временные HOME, workspace, конфигурация miksy, искусственные секреты), затем агент запускает
// то, что записал miksy: stdio-обёртки, helper заголовков / {file:} / мост. Настоящие конфиги
// агентов и miksy не читаются и не меняются. Не входит в bun test.
//   bun test/live/r1.ts <claude|codex|opencode|gemini>     (или из test/<агент>-live.ts)
// Проверяется: значения секретов не лежат ни в одном записанном файле; серверы стартуют и видят
// значения (заглушка пишет только длину и sha); HTTP-заглушка получает верный Authorization (и key
// в URL — через мост); после выхода агента серверы не остаются; на Windows у серверов нет окна.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const win = process.platform === "win32";
const HERE = resolve(import.meta.dir);
const CLI = resolve(HERE, "..", "..", "src", "cli.ts");
const STUB = join(HERE, "stub.mjs").replaceAll("\\", "/");
const STUB_HTTP = join(HERE, "stub-http.ts");
const BUN = process.execPath.replaceAll("\\", "/");

// Искусственные значения: спецсимволы cmd, пробел, кавычка, кириллица
export const SECRETS: Record<string, string> = {
  H2A_TOKEN: "tok_A1b2-C3d4.E5f6_G7h8",
  H2A_SPECIAL: 'p&a^s%s!w"o<r>d|x y=z',
  H2A_CYR: "пароль-ёж-42",
};
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const EXPECT: Record<string, string> = { ...SECRETS, H2A_BEARER: `Bearer ${SECRETS.H2A_TOKEN}` };

export type Box = { agent: string; root: string; home: string; ws: string; project: string; config: string; logs: string; port: number; http?: ReturnType<typeof Bun.spawn>; unknown?: { names: string[]; why: string } };
export const results: { item: string; ok: boolean | null; detail: unknown }[] = [];
export function record(item: string, ok: boolean | null, detail: unknown = "") {
  results.push({ item, ok, detail });
  console.log(`${ok === null ? "❓" : ok ? "✅" : "❌"} ${item}${detail === "" ? "" : ": " + (typeof detail === "string" ? detail : JSON.stringify(detail))}`);
}

export function env(box: Box, extra: Record<string, string> = {}): Record<string, string> {
  const e: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const k of Object.keys(SECRETS)) delete e[k];
  for (const k of ["CLAUDE_CONFIG_DIR", "MIKSY_CONFIG", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "ANTHROPIC_API_KEY"]) delete e[k];
  return { ...e, HOME: box.home, USERPROFILE: box.home, CODEX_HOME: join(box.home, ".codex"), MIKSY_CONFIG: box.config,
    XDG_CONFIG_HOME: join(box.home, ".config"), XDG_DATA_HOME: join(box.root, "xdg/data"), XDG_STATE_HOME: join(box.root, "xdg/state"),
    XDG_CACHE_HOME: join(box.root, "xdg/cache"), ...extra };
}

export function run(box: Box, args: string[], cwd = box.project, timeout = 240000, extra: Record<string, string> = {}) {
  const r = Bun.spawnSync(args, { cwd, env: { ...env(box, extra), PWD: cwd }, stdout: "pipe", stderr: "pipe", timeout, stdin: "ignore" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const yaml = (o: Record<string, unknown>) => Object.entries(o).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n") + "\n";

// Песочница и miksy sync: глобальный слой — g_stdio, g_http, g_url; слой проекта — p_stdio, p_http
export function setup(agent: string, port: number, name = agent): Box {
  mkdirSync(join(tmpdir(), "h2a"), { recursive: true });
  const root = join(realpathSync(join(tmpdir(), "h2a")), name).replaceAll("\\", "/");
  if (!root.includes("/h2a/")) throw new Error("unsafe sandbox path");
  rmSync(root, { recursive: true, force: true });
  const box: Box = { agent, root, home: `${root}/home`, ws: `${root}/work`, project: `${root}/work/proj`, config: `${root}/config`, logs: `${root}/logs`, port };
  for (const d of [box.home, box.project, box.logs, `${root}/xdg/data`, `${root}/xdg/state`, `${root}/xdg/cache`]) mkdirSync(d, { recursive: true });
  Bun.spawnSync(["git", "init", "--quiet", box.project]);
  const put = (p: string, s: string) => { mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true }); writeFileSync(p, s); };
  const stdio = (name: string, vars: string[], env: Record<string, string>) =>
    `name: ${name}\ncommand: ${JSON.stringify(BUN)}\nargs: ${JSON.stringify([STUB, "--name", name, "--log", `${box.logs}/${name}.jsonl`, "--vars", vars.join(",")])}\nenv:\n` +
    Object.entries(env).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`).join("\n") + "\n";
  const http = (name: string, path: string) => yaml({ name, url: `http://127.0.0.1:${port}${path}` }) + 'headers:\n  Authorization: "Bearer ${H2A_TOKEN}"\n';
  put(`${box.config}/map.yaml`, "global:\n  - { use: global }\nlayers: []\n");
  put(`${box.config}/layers/global/mcp/g_stdio.yaml`, stdio("g_stdio", ["H2A_TOKEN", "H2A_SPECIAL", "H2A_CYR", "H2A_BEARER"],
    { H2A_TOKEN: "${H2A_TOKEN}", H2A_SPECIAL: "${H2A_SPECIAL}", H2A_CYR: "${H2A_CYR}", H2A_BEARER: "Bearer ${H2A_TOKEN}" }));
  put(`${box.config}/layers/global/mcp/g_http.yaml`, http("g_http", "/g"));
  put(`${box.config}/layers/global/mcp/g_url.yaml`, yaml({ name: "g_url", url: `http://127.0.0.1:${port}/u?key=\${H2A_TOKEN}` }) + 'headers:\n  Authorization: "Bearer ${H2A_TOKEN}"\n');
  put(`${box.config}/layers/tree/mcp/p_stdio.yaml`, stdio("p_stdio", ["H2A_TOKEN", "H2A_CYR"], { H2A_TOKEN: "${H2A_TOKEN}", H2A_CYR: "${H2A_CYR}" }));
  put(`${box.config}/layers/tree/mcp/p_http.yaml`, http("p_http", "/p"));
  put(`${box.config}/local/machine.yaml`, `workspace: ${box.ws}\nagents: [${agent}]\n`);
  put(`${box.config}/local/secrets.env`, Object.entries(SECRETS).map(([k, v]) => `${k}="${v.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join("\n") + "\n");
  box.http = Bun.spawn([process.execPath, STUB_HTTP, "--port", String(port), "--log", `${box.logs}/http.jsonl`,
    "--expect-sha", sha(`Bearer ${SECRETS.H2A_TOKEN}`).slice(0, 12), "--key-sha", sha(SECRETS.H2A_TOKEN).slice(0, 12)], { stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 50 && !readLog(`${box.logs}/http.jsonl`).some((e) => e.ev === "listen"); i++) Bun.sleepSync(100);

  for (const args of [["sync", "--global"], ["sync", box.project]]) {
    const r = run(box, [process.execPath, CLI, ...args], box.root);
    writeFileSync(`${box.logs}/miksy-${args[1] === "--global" ? "global" : "project"}.log`, r.out + r.err);
    record(`miksy ${args.join(" ").replace(box.project, "<проект>")}`, r.code === 0, r.code === 0 ? "" : (r.out + r.err).slice(-800));
    if (Object.values(SECRETS).some((v) => (r.out + r.err).includes(v))) record("вывод miksy без значений секретов", false);
  }
  record("значения секретов только в local/secrets.env и local/secrets/", leaks(box).length === 0, leaks(box));
  return box;
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.name === ".git" ? [] : e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]);
}
// Файлы с значениями секретов вне local/secrets.env и local/secrets/ (дом песочницы, workspace, local/)
export function leaks(box: Box): string[] {
  const files = [...walk(box.home), ...walk(box.ws), ...walk(`${box.config}/local`).filter((p) => !/\/local\/(secrets\.env|secrets\/|backups\/|state\/)/.test(p))];
  return files.filter((p) => {
    try {
      const text = readFileSync(p, "utf8");
      return Object.values(SECRETS).some((v) => text.includes(v) || text.includes(JSON.stringify(v).slice(1, -1)));
    } catch { return false; }
  }).map((p) => p.replace(box.root, "<песочница>"));
}

const readLog = (file: string): any[] => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

// stdio-заглушка: стартовала ли и дошли ли значения (сверка sha), окно консоли, родитель
export function stdio(box: Box, name: string) {
  const ev = readLog(`${box.logs}/${name}.jsonl`);
  const start = ev.find((e) => e.ev === "start");
  if (!start) return { started: false };
  const vars = Object.fromEntries(Object.entries(start.vars as Record<string, any>).map(([k, r]) =>
    [k, !r.present ? "missing" : r.sha === sha(EXPECT[k]).slice(0, 12) ? "ok" : `mismatch(len ${r.len})`]));
  return { started: true, vars, ok: Object.values(vars).every((v) => v === "ok"), methods: [...new Set(ev.filter((e) => e.ev === "rpc").map((e) => e.method))],
    parent: start.parent, grandparent: start.grandparent, console: start.console, pids: ev.filter((e) => e.ev === "start").map((e) => e.pid) };
}

// HTTP-заглушка по пути: запросы, Authorization, key в URL, какие методы
export function http(box: Box, path: string) {
  const ev = readLog(`${box.logs}/http.jsonl`).filter((e) => e.ev === "http" && e.path === path);
  return { requests: ev.length, authOk: ev.some((e) => e.auth?.ok), keyOk: path === "/u" ? ev.some((e) => e.key?.ok) : undefined,
    rpc: [...new Set(ev.map((e) => e.rpc).filter(Boolean))], ua: [...new Set(ev.map((e) => e.ua))] };
}

// Процессы песочницы, оставшиеся после выхода агента (серверы, мосты)
export function lingering(box: Box): string[] {
  const needle = box.root.replaceAll("/", win ? "\\" : "/");
  if (win) {
    const r = Bun.spawnSync(["powershell.exe", "-NoProfile", "-Command",
      "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine.Replace('/', '\\') -like ('*' + $env:H2A_NEEDLE + '*')) -and $_.Name -ne 'powershell.exe' } | ForEach-Object { \"$($_.ProcessId) $($_.Name)\" }"],
      { env: { ...process.env, H2A_NEEDLE: needle }, stdout: "pipe", stderr: "pipe" });
    return r.stdout.toString().split(/\r?\n/).filter(Boolean);
  }
  const r = Bun.spawnSync(["ps", "-axo", "pid=,command="], { stdout: "pipe" });
  return r.stdout.toString().split("\n").map((l) => l.trim()).filter((l) => l.includes(box.root) && !l.includes("ps -axo"));
}

export function finish(box: Box, file = `results-r1-${box.agent}-${process.platform}.json`) {
  box.http?.kill();
  const left = lingering(box).filter((l) => !l.startsWith(`${box.http?.pid} `));
  record("после выхода агента серверы и мосты не остались", left.length === 0, left);
  for (const l of left) { const pid = Number(l.trim().split(/\s+/)[0]); try { process.kill(pid); } catch {} }
  const out = resolve(HERE, "..", "..", "out", "2a");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, file), JSON.stringify(results, null, 2));
  appendFileSync(join(out, "live.log"), `${new Date().toISOString()} ${box.agent} ${process.platform}: ${results.filter((r) => r.ok === false).length} ❌, ${results.filter((r) => r.ok === null).length} ❓\n`);
  const failed = results.filter((r) => r.ok === false).length;
  console.log(`\n${box.agent} (${process.platform}): ${results.length - failed} из ${results.length} без ошибок; песочница ${box.root}`);
  if (failed) process.exitCode = 1;
  else {
    // Агент (Antigravity: language server) может ещё секунду держать каталог
    for (let i = 0; i < 10; i++) {
      try { rmSync(box.root, { recursive: true, force: true }); break; }
      catch { Bun.sleepSync(1000); }
    }
  }
}

// Окно консоли сервера (Windows): агент запускает с скрытой консолью — hwnd null
const noWindow = (s: ReturnType<typeof stdio>) => !win || !("console" in s) || !s.console || s.console.hwnd === null || s.console.visible === false;

export function checkStdio(box: Box, names: string[]) {
  for (const n of names) {
    if (box.unknown?.names.includes(n)) { record(`stdio ${n}: обёртка запущена, значения дошли`, null, box.unknown.why); continue; }
    const s = stdio(box, n);
    record(`stdio ${n}: обёртка запущена, значения дошли`, !!s.started && !!s.ok, s);
    if (s.started && win) record(`stdio ${n}: без окна консоли`, noWindow(s), s.console);
  }
}
export function checkHttp(box: Box, items: [string, string][]) {
  for (const [label, path] of items) {
    if (box.unknown?.names.includes(label)) { record(`HTTP ${label}: Authorization верны`, null, box.unknown.why); continue; }
    const h = http(box, path);
    record(`HTTP ${label}: Authorization${path === "/u" ? " и key в URL" : ""} верны`, h.authOk && (path !== "/u" || h.keyOk === true), h);
  }
}

// ---- агенты ----

async function claude(box: Box) {
  const e = env(box);
  const status = () => {
    const r = run(box, ["claude", "-p", "Reply with the single word OK.", "--model", "haiku", "--output-format", "stream-json", "--verbose", "--max-turns", "1"], box.project, 240000);
    const init = r.out.split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }).find((x) => x.subtype === "init");
    return { status: Object.fromEntries((init?.mcp_servers ?? []).map((s: any) => [s.name, s.status])), tools: (init?.tools ?? []) as string[], raw: init ? "" : (r.out + r.err).slice(0, 400) };
  };
  const cfgPath = `${box.home}/.claude.json`;
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  const key = Object.keys(cfg.projects ?? {}).find((k) => k.toLowerCase().replaceAll("\\", "/") === box.project.toLowerCase());
  record("Claude: miksy добавил доверие проекта", !!key && cfg.projects[key].hasTrustDialogAccepted === true, { key });
  const miksyLog = readFileSync(`${box.logs}/miksy-project.log`, "utf8");
  record("Claude: sync сообщает об установке доверия", miksyLog.includes("доверие Claude"));
  const st = status();
  console.log("   статусы:", JSON.stringify(st.status), st.raw);
  for (const [n, tool] of [["g_stdio", "probe"], ["p_stdio", "probe"], ["g_http", "http_auth_ok"], ["p_http", "http_auth_ok"], ["g_url", "http_auth_ok"]])
    record(`Claude: ${n} connected, инструмент ${tool}`, st.status[n] === "connected" && st.tools.includes(`mcp__${n}__${tool}`), st.status[n]);
  void e;
}

// Codex app-server: thread/start в проекте + mcpServerStatus/list — без модели
async function codexMcp(box: Box) {
  const p = Bun.spawn(["codex", "app-server"], { cwd: box.project, env: { ...env(box), PWD: box.project }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const pending = new Map<number, (v: any) => void>();
  let id = 0;
  const send = (method: string, params: unknown) => new Promise<any>((res) => {
    const i = ++id; pending.set(i, res);
    p.stdin.write(JSON.stringify({ id: i, method, params }) + "\n"); p.stdin.flush();
  });
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
    await send("initialize", { clientInfo: { name: "h2a", version: "1.0.0" } });
    p.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    const thread = await send("thread/start", { cwd: box.project, ephemeral: true });
    await Bun.sleep(10000);
    const list = await send("mcpServerStatus/list", { detail: "full", threadId: thread.result?.thread?.id });
    return (list.result?.data ?? []) as any[];
  } finally { clearTimeout(timer); p.stdin.end(); p.kill(); await p.exited; }
}

async function codex(box: Box) {
  const cfg = `${box.home}/.codex/config.toml`;
  const toml = readFileSync(cfg, "utf8");
  record("Codex: miksy добавил доверие проекта", Object.values((Bun.TOML.parse(toml) as any).projects ?? {}).some((p: any) => p.trust_level === "trusted"));
  const added = run(box, ["codex", "mcp", "add", "outside", "--", "echo", "outside"]);
  record("Codex: mcp add после sync", added.code === 0);
  const synced = run(box, [process.execPath, CLI, "sync", "--global"]);
  record("Codex: sync после mcp add без конфликта", synced.code === 0 && !synced.out.includes("КОНФЛИКТ"), synced.code === 0 ? "" : synced.out + synced.err);
  const updated = Bun.TOML.parse(readFileSync(cfg, "utf8")) as any;
  record("Codex: чужая таблица после повторного sync сохранена", updated.mcp_servers?.outside?.command === "echo");
  record("Codex: глобальный HTTP — http_headers_helper", /http_headers_helper/.test(toml));
  const list = await codexMcp(box);
  const by = Object.fromEntries(list.map((s) => [s.name, s]));
  console.log("   статусы:", JSON.stringify(Object.fromEntries(list.map((s) => [s.name, s.runtimeStatus ?? s.status]))));
  for (const [n, tool] of [["g_stdio", "probe"], ["p_stdio", "probe"], ["g_http", "http_auth_ok"], ["p_http", "http_auth_ok"], ["g_url", "http_auth_ok"]])
    record(`Codex: ${n}, инструмент ${tool}`, Object.keys(by[n]?.tools ?? {}).includes(tool), by[n] ? { status: by[n].runtimeStatus, err: by[n].toolsError } : "absent");
}

// opencode 2.x работает через фоновый сервис (`opencode serve --service`), который переживает CLI и
// держит MCP-серверы: в песочнице он свой (данные — в XDG песочницы), в конце его останавливаем.
// Первый `mcp list` после старта сервиса бывает пустым («No MCP servers configured») — повтор
async function opencode(box: Box) {
  let text = "";
  try {
    for (let i = 0; i < 3 && !/g_stdio/.test(text); i++) {
      const r = run(box, ["opencode", "mcp", "list"], box.project, 240000);
      text = (r.out + r.err).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
      if (!/g_stdio/.test(text)) await Bun.sleep(3000);
    }
  } finally {
    const s = run(box, ["opencode", "service", "stop"], box.project, 60000);
    // opencode 1.x подкоманды service нет (печатает справку) — молча
    if (s.code !== 0 && !/Unrecognized|unknown|Options:/i.test(s.out + s.err)) console.log("   opencode service stop:", (s.out + s.err).trim());
  }
  writeFileSync(`${box.logs}/opencode-mcp-list.txt`, text);
  const line = (n: string) => text.split("\n").find((l) => new RegExp(`\\b${n}\\b`).test(l))?.trim() ?? "absent";
  for (const n of ["g_stdio", "p_stdio", "g_http", "p_http", "g_url"])
    record(`opencode: ${n} connected`, /connected/i.test(line(n)) && !/fail|error|disconnected/i.test(line(n)), line(n));
  const oc = JSON.parse(readFileSync(`${box.project}/opencode.json`, "utf8"));
  record("opencode: форма mcp.<имя>, HTTP — {file:}", !!oc.mcp?.p_http && !oc.mcp.servers && /\{file:/.test(oc.mcp.p_http.headers?.Authorization ?? ""), oc.mcp?.p_http);
}

async function gemini(box: Box) {
  const model = process.env.AGY_MODEL ?? "gemini-3.8-flash-low";
  const plugin = JSON.parse(readFileSync(`${box.project}/.agents/plugins/miksy/mcp_config.json`, "utf8"));
  record("Antigravity: HTTP с секретом в плагине — мост (stdio)", !!plugin.mcpServers.p_http?.command && !plugin.mcpServers.p_http.url, plugin.mcpServers.p_http);
  const list = run(box, ["agy", "mcp", "list"], box.project, 120000);
  writeFileSync(`${box.logs}/agy-mcp-list.txt`, list.out + list.err);
  const p = run(box, ["agy", "-p", "Call the MCP tool http_auth_ok of every MCP server that has it, then list the names of all MCP servers available to you. Be brief.",
    "--model", model, "--dangerously-skip-permissions"], box.project, 300000);
  writeFileSync(`${box.logs}/agy-p.txt`, p.out + p.err);
  // В изолированном HOME agy без входа (macOS: вход не в связке ключей, а в ~) плагин проекта не грузит
  if (/Authentication required/i.test(p.out + p.err)) box.unknown = { names: ["p_stdio", "p_http"], why: "agy в песочнице без входа: плагин проекта не загружается (как в шаге 3б)" };
  console.log("   agy -p:", (p.out + p.err).trim().slice(0, 600));
  // Вызов инструмента через мост: модель вызвала http_auth_ok (ответ заглушки LIVE_HTTP_OK)
  const called = ["/g", "/p", "/u"].filter((path) => http(box, path).rpc.includes("tools/call"));
  record("Antigravity: вызов инструмента через мост (g_http, p_http, g_url)", p.code === 0 ? called.length === 3 : null, { called, code: p.code });
}

export async function main(agent: string, port = 4790 + ["claude", "codex", "opencode", "gemini"].indexOf(agent)) {
  const box = setup(agent, port);
  try {
    if (agent === "claude") await claude(box);
    else if (agent === "codex") await codex(box);
    else if (agent === "opencode") await opencode(box);
    else if (agent === "gemini") await gemini(box);
    else throw new Error(`неизвестный агент ${agent}`);
    await Bun.sleep(2000);
    checkStdio(box, ["g_stdio", "p_stdio"]);
    checkHttp(box, [["g_http", "/g"], ["p_http", "/p"], ["g_url (мост)", "/u"]]);
  } finally {
    finish(box);
  }
}

if (import.meta.main) await main(process.argv[2] ?? "");
