// Живая проверка фазы 2д: настоящий `miksy sync` / `trust` в песочнице (временные HOME, USERPROFILE,
// CODEX_HOME, XDG_*, конфигурация miksy, искусственные секреты), затем то, что записал miksy,
// запускают как агент или сам агент. Настоящие конфиги агентов и miksy не читаются и не меняются.
// Не входит в bun test.
//   bun test/live/e2.ts trust   — Г1 (env .mcp.json после «да»), Г2 (каталог-ссылка .claude), Г3
//                                 (gitignored settings.json, ответы диалогов Claude, чужой конфиг
//                                 Codex), Г10 (exclude сразу после trust --confirm); claude mcp list
//   bun test/live/e2.ts bridge  — обёртки моста из sync --global против заглушек: открытый SSE на
//                                 уведомление, поздний 404, неудачное восстановление, id = секрет,
//                                 короткий секрет; agy mcp list
//   bun test/live/e2.ts migrate — настоящий переход 07e8180 → рабочее дерево: конфиги Codex правлены
//                                 вручную — старые обёртки сохранены и запускают сервер; после
//                                 разрешения — переключены и удалены
//   bun test/live/e2.ts backup  — бэкап ~/.claude.json с литералами (JSON разбирается, true/числа
//                                 целы, короткий — целой строкой); файл секрета пользователя не
//                                 захватывается; ссылка local/secrets на открытый каталог — отказ
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { env as boxEnv, lingering, record, results, run as runIn, type Box } from "./r1";

const win = process.platform === "win32";
const HERE = resolve(import.meta.dir);
const ENGINE = resolve(HERE, "..", "..");
const CLI = resolve(ENGINE, "src", "cli.ts");
const STUB = join(HERE, "stub.mjs").replaceAll("\\", "/");
const BUN = process.execPath.replaceAll("\\", "/");
const TOK = "tok_E2-a1B2c3D4e5F6g7";
const SECRETS: Record<string, string> = { E2_TOKEN: TOK, E2_NUM: "4242", E2_PIN: "abc" };
const put = (p: string, s: string) => { mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true }); writeFileSync(p, s); };
const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const git = (dir: string, ...args: string[]) => Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", `core.excludesFile=${tmpdir()}/no-global-ignore`, ...args], { stdout: "pipe", stderr: "pipe" });
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const commit = (dir: string, files: Record<string, string>) => { for (const [r, t] of Object.entries(files)) put(`${dir}/${r}`, t); git(dir, "add", "-f", ...Object.keys(files)); git(dir, "commit", "-q", "-m", "team"); };

function sandbox(mode: string, agents: string[], projects = ["Org/proj"]): Box {
  mkdirSync(join(tmpdir(), "h2e"), { recursive: true });
  const root = join(realpathSync(join(tmpdir(), "h2e")), mode).replaceAll("\\", "/");
  if (!root.includes("/h2e/")) throw new Error("unsafe sandbox path");
  rmSync(root, { recursive: true, force: true });
  const box: Box = { agent: mode, root, home: `${root}/home`, ws: `${root}/work`, project: `${root}/work/${projects[0]}`, config: `${root}/config`, logs: `${root}/logs`, port: 0 };
  for (const d of [box.home, box.logs, `${root}/xdg/data`, `${root}/xdg/state`, `${root}/xdg/cache`]) mkdirSync(d, { recursive: true });
  for (const p of projects) { mkdirSync(`${box.ws}/${p}`, { recursive: true }); Bun.spawnSync(["git", "init", "--quiet", `${box.ws}/${p}`]); }
  put(`${box.config}/map.yaml`, "global:\n  - { use: global }\nlayers: []\n");
  put(`${box.config}/layers/tree/instructions/00.md`, "# e2 workspace rule\n");
  put(`${box.config}/layers/global/instructions/00.md`, "# e2 global rule\n");
  put(`${box.config}/local/machine.yaml`, `workspace: ${box.ws}\nagents: [${agents.join(", ")}]\n`);
  put(`${box.config}/local/secrets.env`, Object.entries(SECRETS).map(([k, v]) => `${k}="${v}"`).join("\n") + "\n");
  return box;
}
const miksy = (box: Box, args: string[], label = args.join(" "), cli = CLI) => {
  const r = runIn(box, [process.execPath, cli, ...args], box.root);
  writeFileSync(`${box.logs}/miksy-${label.replace(/[^a-z0-9]+/gi, "_").slice(0, 60)}.log`, r.out + r.err);
  if ((r.out + r.err).includes(TOK)) record(`вывод miksy ${label} без значения секрета`, false);
  return r;
};

async function finish(box: Box) {
  await Bun.sleep(3000);
  const all = lingering(box);
  const lines = win && all.length ? Bun.spawnSync(["powershell.exe", "-NoProfile", "-Command", `Get-CimInstance Win32_Process -Filter "ProcessId=${all.map((l) => l.split(" ")[0]).join(" OR ProcessId=")}" | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }`], { stdout: "pipe" }).stdout.toString().split(/\r?\n/) : all;
  const plugins = new Set(lines.filter((l) => l.includes("plugins-clone")).map((l) => l.trim().split(/\s+/)[0]));
  const left = all.filter((l) => !plugins.has(l.trim().split(/\s+/)[0]));
  record("после проверок процессы песочницы не остались", left.length === 0, left);
  for (const l of all) { try { process.kill(Number(l.trim().split(/\s+/)[0])); } catch {} }
  const out = resolve(ENGINE, "out", "2e");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `results-${box.agent}-${process.platform}.json`), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => r.ok === false).length;
  console.log(`\n${box.agent} (${process.platform}): ${results.length - failed} из ${results.length} без ошибок; песочница ${box.root}`);
  if (failed) process.exitCode = 1;
  else for (let i = 0; i < 10; i++) { try { rmSync(box.root, { recursive: true, force: true }); break; } catch { Bun.sleepSync(1000); } }
}

const claudeTrusted = (box: Box, dir: string) => {
  const p = JSON.parse(read(`${box.home}/.claude.json`) || "{}").projects ?? {};
  const key = Object.keys(p).find((k) => k.toLowerCase().replaceAll("\\", "/") === realpathSync.native(dir).replaceAll("\\", "/").toLowerCase());
  return key ? p[key].hasTrustDialogAccepted === true : false;
};
const codexTrusted = (box: Box) => /trust_level\s*=\s*"trusted"/.test(read(`${box.home}/.codex/config.toml`));

// ---- доверие и одобрение ----

async function trust() {
  const box = sandbox("trust", ["claude", "codex"], ["Org/mcp", "Org/link", "Org/ignored", "Org/dialog", "Org/codex"]);
  const P = (n: string) => `${box.ws}/Org/${n}`;
  try {
    const v = runIn(box, ["claude", "--version"], box.root);
    record("claude --version", v.code === 0, v.out.trim());
    const srv = (payload: string) => ({ command: BUN, args: [STUB, "--name", "team_echo", "--log", `${box.logs}/team_echo.jsonl`, "--vars", "PAYLOAD"], env: { PAYLOAD: payload } });
    commit(P("mcp"), { ".mcp.json": JSON.stringify({ mcpServers: { team_echo: srv("safe") } }, null, 2) });
    // Г2: .claude → agent-settings (ссылка в индексе)
    put(`${P("link")}/agent-settings/settings.json`, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo LINKED-HOOK" }] }] } }));
    symlinkSync(win ? `${P("link")}/agent-settings` : "agent-settings", `${P("link")}/.claude`, win ? "junction" : "dir");
    const blob = Bun.spawnSync(["git", "-C", P("link"), "hash-object", "-w", "--stdin"], { stdin: Buffer.from("agent-settings"), stdout: "pipe" }).stdout.toString().trim();
    git(P("link"), "update-index", "--add", "--cacheinfo", `120000,${blob},.claude`);
    git(P("link"), "add", "agent-settings/settings.json");
    git(P("link"), "commit", "-q", "-m", "link");
    // Г3: gitignored settings.json с хуком
    commit(P("ignored"), { ".gitignore": ".claude/settings.json\n" });
    put(`${P("ignored")}/.claude/settings.json`, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo IGNORED-HOOK" }] }] } }));
    // Г3 (Codex): чужой неотслеживаемый конфиг
    put(`${P("codex")}/.codex/config.toml`, 'notify = ["echo", "FOREIGN-NOTIFY"]\nsandbox_mode = "danger-full-access"\n');

    const s1 = miksy(box, ["sync", "--all", "--yes"], "sync1");
    // Единственный конфликт — чужой .codex/config.toml (miksy его не перезаписывает)
    const conflicts = s1.out.split("\n").filter((l) => l.includes("КОНФЛИКТ"));
    record("sync --all: код 3, единственный конфликт — чужой конфиг Codex", s1.code === 3 && conflicts.length === 1 && conflicts[0].includes("Org/codex/.codex/config.toml"), conflicts);
    record("Г2: хук за ссылкой .claude — нет доверия, в блоке решения", !claudeTrusted(box, P("link")) && s1.out.includes("LINKED-HOOK"), "");
    record("Г3: gitignored .claude/settings.json — нет доверия, в блоке решения", !claudeTrusted(box, P("ignored")) && s1.out.includes("IGNORED-HOOK"), "");
    record("Г3: чужой .codex/config.toml — в блоке решения со значением sandbox_mode", s1.out.includes("FOREIGN-NOTIFY") && s1.out.includes("danger-full-access"), "");
    record("Г1: показ — env со значением и путь файла", s1.out.includes('"PAYLOAD":"safe"') && /полное содержимое .* в файлах: .*Org\/mcp\/\.mcp\.json/.test(s1.out), "");
    record("Г3: обычный проект без чужих настроек — доверие Claude", claudeTrusted(box, P("dialog")), "");

    // Г10: --confirm — файл одобрений сразу под exclude
    const t = miksy(box, ["trust", P("mcp"), "--confirm"], "confirm");
    const local = () => JSON.parse(read(`${P("mcp")}/.claude/settings.local.json`) || "{}");
    record("trust --confirm: доверие и одобрение", t.code === 0 && claudeTrusted(box, P("mcp")) && local().enabledMcpjsonServers?.includes("team_echo"), local());
    record("Г10: сразу после --confirm — check-ignore и чистый git status", git(P("mcp"), "check-ignore", "-q", ".claude/settings.local.json").exitCode === 0 && !git(P("mcp"), "status", "--porcelain", "--untracked-files=all").stdout.toString().includes("settings.local"), "");
    const list1 = strip(runIn(box, ["claude", "mcp", "list"], P("mcp")).out);
    writeFileSync(`${box.logs}/mcp-list-1.txt`, list1);
    record("claude mcp list: team_echo Connected", /team_echo:.*Connected/i.test(list1), list1.split("\n").find((l) => l.startsWith("team_echo")));

    // Г1: команда сменила только env
    commit(P("mcp"), { ".mcp.json": JSON.stringify({ mcpServers: { team_echo: srv("other-code") } }, null, 2) });
    const s2 = miksy(box, ["sync", "--all", "--yes"], "sync-env");
    record("Г1: изменён env — снова «нужно решение», доверие и одобрение сняты", /Нужно решение/.test(s2.out) && s2.out.includes("other-code") && !claudeTrusted(box, P("mcp")) && !local().enabledMcpjsonServers?.length, "");
    const list2 = strip(runIn(box, ["claude", "mcp", "list"], P("mcp")).out);
    record("claude mcp list после смены env: team_echo не Connected", !/team_echo:.*Connected/i.test(list2), list2.split("\n").find((l) => l.startsWith("team_echo")));
    record("Г10: --deny нет, но одобрения сняты — строки settings.local.json в exclude нет", !read(`${P("mcp")}/.git/info/exclude`).includes("settings.local.json"), "");

    // Г3: Claude записал ответы диалогов в доверенном проекте — доверие остаётся
    put(`${P("dialog")}/.claude/settings.local.json`, JSON.stringify({ permissions: { allow: ["Bash(npm test:*)"], additionalDirectories: ["../shared"] } }));
    const s3 = miksy(box, ["sync", P("dialog")], "sync-dialog");
    record("Г3: ответы диалогов Claude в доверенном проекте — не «нужно решение», доверие на месте", !/Нужно решение/.test(s3.out) && claudeTrusted(box, P("dialog")), "");
    put(`${P("dialog")}/.claude/settings.local.json`, JSON.stringify({ permissions: { allow: ["Bash(npm test:*)"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "echo LOCAL-HOOK" }] }] } }));
    const s4 = miksy(box, ["sync", P("dialog")], "sync-dialog-hook");
    record("Г3: хук в settings.local.json — «нужно решение», своё доверие снято", /Нужно решение/.test(s4.out) && s4.out.includes("LOCAL-HOOK") && !claudeTrusted(box, P("dialog")), "");
  } finally { await finish(box); }
}

// ---- мост ----

async function talk(path: string, box: Box, steps: (unknown | number)[]) {
  const p = Bun.spawn(win ? ["cmd.exe", "/d", "/c", path] : [path], { cwd: box.project, env: { ...boxEnv(box), PWD: box.project }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const lines: any[] = [];
  const reading = (async () => {
    let buf = "";
    const dec = new TextDecoder();
    for await (const c of p.stdout) {
      buf += dec.decode(c, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) { try { lines.push(JSON.parse(l)); } catch { lines.push({ raw: l }); } } }
    }
  })();
  for (const s of steps) {
    if (typeof s === "number") { await Bun.sleep(s); continue; }
    p.stdin.write(JSON.stringify(s) + "\n");
    p.stdin.flush();
  }
  await Bun.sleep(1500);
  p.stdin.end();
  const timer = setTimeout(() => p.kill(), 20000);
  const err = await new Response(p.stderr).text();
  await reading;
  await p.exited;
  clearTimeout(timer);
  return { lines, err, byId: (id: unknown) => lines.find((l) => l.id === id) };
}

async function bridge() {
  const box = sandbox("bridge", ["gemini"]);
  const enc = new TextEncoder();
  const ev = (m: unknown) => enc.encode(`event: message\ndata: ${JSON.stringify(m)}\n\n`);
  const initResult = (id: unknown) => ({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "e2", version: "1" } } });
  const listResult = (id: unknown) => ({ jsonrpc: "2.0", id, result: { tools: [{ name: "e2_tool", inputSchema: { type: "object" } }] } });
  const state = { lateInits: 0, lateReady: false, failInits: 0, log: [] as string[] };
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    const body = req.method === "POST" ? await req.json().catch(() => null) : null;
    const sid = req.headers.get("mcp-session-id");
    if (req.method === "DELETE") return new Response(null, { status: 200 });
    state.log.push(`${path} ${body?.method}#${body?.id ?? "-"}@${sid ?? "-"}`);
    if (path === "/notify") {
      if (body?.method === "initialize") return Response.json(initResult(body.id), { headers: { "mcp-session-id": "n1" } });
      if (body?.id === undefined) return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(": open\n\n")); } }), { headers: { "content-type": "text/event-stream" } });
      return Response.json(listResult(body.id));
    }
    if (path === "/late") {
      if (body?.method === "initialize") {
        state.lateInits++;
        if (state.lateInits === 1) return Response.json(initResult(body.id), { headers: { "mcp-session-id": "s1" } });
        return new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(": started\n\n")); setTimeout(() => { c.enqueue(ev(initResult(body.id))); c.close(); }, 300); } }), { headers: { "content-type": "text/event-stream", "mcp-session-id": "s2" } });
      }
      if (sid === "s1" && body?.id !== undefined) { if (body.id === 3) await Bun.sleep(100); return new Response("gone", { status: 404 }); }
      if (body?.method === "notifications/initialized") { if (sid === "s2") state.lateReady = true; return new Response(null, { status: 202 }); }
      if (sid === "s2" && !state.lateReady) return new Response("not initialized", { status: 409 });
      return Response.json(listResult(body.id));
    }
    if (path === "/fail") {
      if (body?.method === "initialize") { state.failInits++; return state.failInits === 2 ? new Response("down", { status: 500 }) : Response.json(initResult(body.id), { headers: { "mcp-session-id": `f${state.failInits}` } }); }
      if (sid === "f1" && body?.id !== undefined) return new Response("gone", { status: 404 });
      if (body?.id === undefined) return new Response(null, { status: 202 });
      return Response.json(listResult(body.id));
    }
    // /echo: эхо заголовков в строках ответа
    if (body?.method === "initialize") return Response.json(initResult(body.id));
    if (body?.id === undefined) return new Response(null, { status: 202 });
    return Response.json({ jsonrpc: "2.0", id: body.id, result: { pin: req.headers.get("x-pin"), num: req.headers.get("x-num"), text: `token ${req.headers.get("authorization")}`, count: 4242 } });
  } });
  try {
    const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
    for (const [n, p] of [["e_notify", "/notify"], ["e_late", "/late"], ["e_fail", "/fail"]])
      put(`${box.config}/layers/global/mcp/${n}.yaml`, `name: ${n}\nurl: ${url(p)}\nheaders:\n  Authorization: "Bearer \${E2_TOKEN}"\n`);
    put(`${box.config}/layers/global/mcp/e_echo.yaml`, `name: e_echo\nurl: ${url("/echo")}\nheaders:\n  Authorization: "Bearer \${E2_TOKEN}"\n  X-Pin: "\${E2_PIN}"\n  X-Num: "\${E2_NUM}"\n`);
    const r = miksy(box, ["sync", "--global"]);
    record("miksy sync --global: код 0; предупреждение о коротком секрете E2_PIN", r.code === 0 && /секрет E2_PIN короче 4 символов/.test(r.out), r.code === 0 ? "" : (r.out + r.err).slice(-500));
    const cfg = JSON.parse(read(`${box.home}/.gemini/config/mcp_config.json`)).mcpServers;
    const cmd = (n: string) => cfg[n]?.command as string;
    const init = (id: unknown = 1) => ({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2", version: "1" } } });
    const inited = { jsonrpc: "2.0", method: "notifications/initialized" };
    const list = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/list" });

    const t0 = Date.now();
    const n = await talk(cmd("e_notify"), box, [init(), inited, list(2)]);
    record("Г4: открытый SSE на initialized — tools/list отвечен сразу", n.byId(2)?.result?.tools?.[0]?.name === "e2_tool" && Date.now() - t0 < 15000, { ms: Date.now() - t0 });
    const l = await talk(cmd("e_late"), box, [init(), inited, list(2), list(3)]);
    record("Г4: поздний 404 ждёт восстановления — оба запроса с результатом, 409 не было", l.byId(2)?.result && l.byId(3)?.result && state.lateInits === 2, { inits: state.lateInits, e2: l.byId(2)?.error?.message, e3: l.byId(3)?.error?.message });
    const f = await talk(cmd("e_fail"), box, [init(), inited, list(2), 6000, list(3)]);
    record("Г4: неудачное восстановление — ошибка, через 5 с новая попытка — результат", !!f.byId(2)?.error && f.byId(3)?.result?.tools?.length === 1 && state.failInits === 3, { inits: state.failInits });
    const e = await talk(cmd("e_echo"), box, [init(4242), inited, list(2)]);
    record("Г5: id 4242 (= E2_NUM) не тронут; строки маскированы; число 4242 цело", e.byId(4242)?.result?.serverInfo?.name === "e2" && e.byId(2)?.result?.pin === "<secret:E2_PIN>" && e.byId(2)?.result?.num === "<secret:E2_NUM>" && e.byId(2)?.result?.count === 4242 && e.byId(2)?.result?.text === "token Bearer <secret:E2_TOKEN>", e.byId(2)?.result);
    record("stdout/stderr мостов без значения токена", ![n, l, f, e].some((x) => JSON.stringify(x.lines).includes(TOK) || x.err.includes(TOK)), "");
    const agy = Bun.spawnSync(["agy", "mcp", "list"], { cwd: box.project, env: { ...boxEnv(box), PWD: box.project }, stdout: "pipe", stderr: "pipe", timeout: 180000 });
    const text = strip(agy.stdout.toString() + agy.stderr.toString());
    writeFileSync(`${box.logs}/agy-mcp-list.txt`, text);
    if (agy.exitCode === null || /not found|not recognized/i.test(text)) record("agy mcp list", null, "agy не запустился");
    else record("agy mcp list: мосты в конфиге (e_notify, e_echo)", ["e_notify", "e_echo"].every((x) => text.includes(x)) && !/e_notify.*(fail|error)/i.test(text), text.split("\n").filter((x) => /e_/.test(x)).join(" | "));
  } finally {
    server.stop(true);
    await finish(box);
  }
}

// ---- миграция скриптов с 07e8180 ----

async function migrate() {
  const box = sandbox("migrate", ["codex", "claude"]);
  try {
    const old = `${box.root}/engine-07e8180`;
    mkdirSync(old, { recursive: true });
    const tar = `${box.root}/old.tar`;
    const a = Bun.spawnSync(["git", "-C", ENGINE, "archive", "--format=tar", "-o", tar, "07e8180"]);
    const x = Bun.spawnSync(["tar", "-xf", tar, "-C", old]);
    record("движок 07e8180 из git archive", a.exitCode === 0 && x.exitCode === 0 && existsSync(`${old}/src/cli.ts`), "");
    const stdio = (n: string) => `name: ${n}\ncommand: ${BUN}\nargs: [${JSON.stringify(STUB)}, --name, ${n}, --log, ${JSON.stringify(`${box.logs}/${n}.jsonl`)}, --vars, TOKEN]\nenv:\n  TOKEN: \${E2_TOKEN}\n`;
    put(`${box.config}/layers/tree/Org/mcp/p_srv.yaml`, stdio("p_srv"));
    put(`${box.config}/layers/global/mcp/g_srv.yaml`, stdio("g_srv"));
    const o1 = miksy(box, ["sync", "--global"], "old-global", `${old}/src/cli.ts`);
    const o2 = miksy(box, ["sync", box.project], "old-project", `${old}/src/cli.ts`);
    record("старый движок: sync --global и проекта — код 0", o1.code === 0 && o2.code === 0, [o1.code, o2.code]);
    const runDir = `${box.config}/local/run`;
    const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name).replaceAll("\\", "/")])) : []);
    const legacy = walk(runDir).filter((p) => /\/(p_srv|g_srv)\.(sh|cmd)$/.test(p));
    record("старые обёртки p_srv/g_srv (codex и claude)", legacy.length === 4, legacy.map((p) => p.slice(runDir.length)));
    // Ручные правки: проектный конфиг Codex и таблица глобального TOML
    const pcfg = `${box.project}/.codex/config.toml`, gcfg = `${box.home}/.codex/config.toml`;
    put(pcfg, read(pcfg) + "# user edit\n");
    put(gcfg, read(gcfg).replace(/^(\["?mcp_servers"?\."?g_srv"?\]\r?\n)/m, "$1startup_timeout_sec = 20\n"));
    const n1 = miksy(box, ["sync", "--global"], "new-global");
    const n2 = miksy(box, ["sync", box.project], "new-project");
    record("новый движок: конфликты конфигов Codex (код 3)", n1.code === 3 && n2.code === 3, [n1.code, n2.code]);
    const codexOld = legacy.filter((p) => p.includes("/codex/"));
    const claudeOld = legacy.filter((p) => p.includes("/claude/"));
    record("Г6: старые обёртки Codex сохранены (конфиги на них ссылаются)", codexOld.every(existsSync), codexOld.map(existsSync));
    record("старые обёртки Claude (конфиг переключён) удалены", claudeOld.every((p) => !existsSync(p)), claudeOld.map(existsSync));
    // Старая обёртка запускает сервер: initialize → ответ заглушки
    const w = codexOld.find((p) => p.includes("/global/"))!;
    const p = Bun.spawn(win ? ["cmd.exe", "/d", "/c", w] : [w], { env: boxEnv(box), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2", version: "1" } } }) + "\n");
    p.stdin.flush();
    await Bun.sleep(4000);
    p.stdin.end();
    const out = await new Response(p.stdout).text();
    await p.exited;
    record("старая обёртка g_srv (Codex) запускает сервер: ответ на initialize", /"id":1/.test(out) && /result/.test(out), out.slice(0, 200));
    const codexList = Bun.spawnSync(["codex", "mcp", "list"], { cwd: box.project, env: { ...boxEnv(box), PWD: box.project }, stdout: "pipe", stderr: "pipe", timeout: 120000 });
    const cl = strip(codexList.stdout.toString() + codexList.stderr.toString());
    writeFileSync(`${box.logs}/codex-mcp-list.txt`, cl);
    // codex mcp list показывает глобальные серверы (проектные — нет): g_srv — на сохранённую обёртку
    const gLine = cl.split("\n").find((l) => l.startsWith("g_srv")) ?? "";
    record("codex mcp list: g_srv — команда на сохранённую старую обёртку, enabled", /g_srv\.(sh|cmd)/.test(gLine) && /enabled/.test(gLine) && codexOld.every(existsSync), gLine.trim());
    // Конфликты разрешены: правки убраны
    put(pcfg, read(pcfg).replace("# user edit\n", ""));
    put(gcfg, read(gcfg).replace("startup_timeout_sec = 20\n", ""));
    const f1 = miksy(box, ["sync", "--global"], "fixed-global");
    const f2 = miksy(box, ["sync", box.project], "fixed-project");
    record("после разрешения: код 0, конфиги на новых обёртках, старые удалены", f1.code === 0 && f2.code === 0 && /g_srv-stdio-[0-9a-f]{8}/.test(read(gcfg)) && /p_srv-stdio-[0-9a-f]{8}/.test(read(pcfg)) && codexOld.every((p) => !existsSync(p)), [f1.code, f2.code]);
  } finally { await finish(box); }
}

// ---- бэкапы, файлы секретов, ссылка local/secrets ----

async function backup() {
  const box = sandbox("backup", ["claude"]);
  try {
    put(`${box.config}/local/secrets.env`, `E2_TOKEN="${TOK}"\nE2_PIN="abc"\nE2_BOOL="true"\nE2_USER="user_value_12345"\n`);
    // ~/.claude.json пользователя с литералами
    put(`${box.home}/.claude.json`, JSON.stringify({ x: { enabled: true, pin: "abc", tok: TOK, n: 1234 }, projects: {} }, null, 2));
    // Файл секрета, положенный пользователем заранее
    put(`${box.config}/local/secrets/E2_USER`, "user_value_12345\n");
    put(`${box.config}/layers/global/mcp/srv.yaml`, `name: srv\ncommand: ${BUN}\nargs: [${JSON.stringify(STUB)}]\nenv:\n  A: \${E2_TOKEN}\n  B: \${E2_USER}\n`);
    const s = miksy(box, ["sync", "--global"], "sync");
    record("sync --global: код 0", s.code === 0, s.code);
    const runs = readdirSync(`${box.config}/local/backups`).filter((d) => /^\d{4}-/.test(d));
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    const copy = runs.flatMap((r) => walk(join(`${box.config}/local/backups`, r))).find((p) => p.endsWith(".claude.json"));
    let doc: any = null;
    try { doc = JSON.parse(read(copy ?? "")); } catch {}
    record("Г5: копия ~/.claude.json разбирается; true и 1234 целы; abc и токен — метки", doc?.x?.enabled === true && doc?.x?.n === 1234 && doc?.x?.pin === "<secret:E2_PIN>" && doc?.x?.tok === "<secret:E2_TOKEN>", doc?.x);
    const m = JSON.parse(read(`${box.config}/local/state/manifest.json`));
    record("Г8: файл E2_USER пользователя не в secretFiles; E2_TOKEN — в нём", !m.secretFiles.includes("E2_USER") && m.secretFiles.includes("E2_TOKEN"), m.secretFiles);
    rmSync(`${box.config}/layers/global/mcp/srv.yaml`);
    miksy(box, ["sync", "--global"], "sync-removed");
    record("Г8: сервер убран — свой E2_TOKEN удалён, E2_USER пользователя остался", !existsSync(`${box.config}/local/secrets/E2_TOKEN`) && read(`${box.config}/local/secrets/E2_USER`) === "user_value_12345\n", "");
    // Г11: local/secrets — ссылка на открытый каталог
    const vault = `${box.root}/vault`;
    mkdirSync(vault, { recursive: true });
    rmSync(`${box.config}/local/secrets`, { recursive: true, force: true });
    if (!win) chmodSync(vault, 0o755);
    const acl = () => (win ? Bun.spawnSync(["icacls", vault.replaceAll("/", "\\")], { stdout: "pipe" }).stdout.toString() : (statSync(vault).mode & 0o777).toString(8));
    const before = acl();
    symlinkSync(vault, `${box.config}/local/secrets`, win ? "junction" : "dir");
    put(`${box.config}/layers/global/mcp/srv.yaml`, `name: srv\ncommand: ${BUN}\nargs: [${JSON.stringify(STUB)}]\nenv:\n  A: \${E2_TOKEN}\n`);
    const g = miksy(box, ["sync", "--global"], "sync-link");
    record("Г11: ссылка local/secrets на открытый каталог — отказ «закройте вручную», права цели те же, значения не записаны", /local\/secrets — ссылка на .*закройте вручную/.test(g.out) && acl() === before && !existsSync(`${vault}/E2_TOKEN`), { before, after: acl() });
  } finally { await finish(box); }
}

const mode = process.argv[2];
const modes: Record<string, () => Promise<void>> = { trust, bridge, migrate, backup };
if (!modes[mode]) { console.log("bun test/live/e2.ts trust|bridge|migrate|backup"); process.exit(2); }
await modes[mode]();
