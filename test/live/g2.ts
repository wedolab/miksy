// Живая проверка фазы 2г-2: настоящий `miksy sync` / `trust` / `clean` в песочнице (временные HOME,
// USERPROFILE, CODEX_HOME, XDG_*, конфигурация miksy, искусственные секреты), затем агент. Настоящие
// конфиги агентов и miksy не читаются и не меняются. Не входит в bun test.
//   bun test/live/g2.ts approve  — одобрение серверов командного .mcp.json: claude mcp list (Pending /
//                                  Connected) по trust: true слоя, miksy trust --confirm, отказ
//                                  пользователя, clean
//   bun test/live/g2.ts blocks   — блоки инструкций Claude/Codex/Antigravity с правками «агента»:
//                                  дописанное после блока без LF, CRLF, удалённый файл, строка-маркер
//   bun test/live/g2.ts groups   — группы: правила группы не доставлены (повреждённые маркеры), неудачный
//                                  clean бывшей группы, exclude глубже ближайшей группы, группа-симлинк
//   bun test/live/g2.ts wrappers — длинные (1500 байт) и особые (" \ ' & % ! ^) значения: мост и {file:}
//                                  доставляют, helper/.cmd — по ограничениям; новые имена скриптов
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { env as boxEnv, lingering, record, results, run as runIn, type Box } from "./r1";

const win = process.platform === "win32";
const HERE = resolve(import.meta.dir);
const CLI = resolve(HERE, "..", "..", "src", "cli.ts");
const STUB = join(HERE, "stub.mjs").replaceAll("\\", "/");
const STUB_HTTP = join(HERE, "stub-http.ts").replaceAll("\\", "/");
const BUN = process.execPath.replaceAll("\\", "/");
const LONG = "jwt." + "A1b2C3d4".repeat(187); // 1500 байт: длиннее предела set /p
const QUOTE = `q"u\\o'te&%PATH%!x^y`;
const SPECIAL = 'p&a^s%s!w"o<r>d|x y=z';
const SECRETS: Record<string, string> = { G2_LONG: LONG, G2_QUOTE: QUOTE, G2_SPECIAL: SPECIAL, G2_TOKEN: "tok_G2-a1B2c3D4e5F6g7" };
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 12);
const put = (p: string, s: string) => { mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true }); writeFileSync(p, s); };
const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const git = (dir: string, ...args: string[]) => Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdout: "pipe", stderr: "pipe" });
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

function sandbox(mode: string, agents: string[]): Box {
  mkdirSync(join(tmpdir(), "h2g2"), { recursive: true });
  const root = join(realpathSync(join(tmpdir(), "h2g2")), mode).replaceAll("\\", "/");
  if (!root.includes("/h2g2/")) throw new Error("unsafe sandbox path");
  rmSync(root, { recursive: true, force: true });
  const box: Box = { agent: mode, root, home: `${root}/home`, ws: `${root}/work`, project: `${root}/work/Org/proj`, config: `${root}/config`, logs: `${root}/logs`, port: 0 };
  for (const d of [box.home, box.project, box.logs, `${root}/xdg/data`, `${root}/xdg/state`, `${root}/xdg/cache`]) mkdirSync(d, { recursive: true });
  Bun.spawnSync(["git", "init", "--quiet", box.project]);
  put(`${box.config}/map.yaml`, "global:\n  - { use: global }\nlayers: []\n");
  put(`${box.config}/layers/tree/instructions/00.md`, "# g2 workspace rule\n");
  put(`${box.config}/layers/global/instructions/00.md`, "# g2 global rule\n");
  put(`${box.config}/local/machine.yaml`, `workspace: ${box.ws}\nagents: [${agents.join(", ")}]\n`);
  put(`${box.config}/local/secrets.env`, Object.entries(SECRETS).map(([k, v]) => `${k}="${v.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join("\n") + "\n");
  return box;
}
const miksy = (box: Box, args: string[], label = args.join(" ")) => {
  const r = runIn(box, [process.execPath, CLI, ...args], box.root);
  writeFileSync(`${box.logs}/miksy-${label.replace(/[^a-z0-9]+/gi, "_").slice(0, 60)}.log`, r.out + r.err);
  if (Object.values(SECRETS).some((v) => (r.out + r.err).includes(v))) record(`вывод miksy ${label} без значений секретов`, false);
  return r;
};

async function finish(box: Box) {
  await Bun.sleep(3000);
  const left = lingering(box);
  record("после проверок процессы песочницы не остались", left.length === 0, left);
  for (const l of left) { try { process.kill(Number(l.trim().split(/\s+/)[0])); } catch {} }
  const out = resolve(HERE, "..", "..", "out", "2g2");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `results-${box.agent}-${process.platform}.json`), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => r.ok === false).length;
  console.log(`\n${box.agent} (${process.platform}): ${results.length - failed} из ${results.length} без ошибок; песочница ${box.root}`);
  if (failed) process.exitCode = 1;
  else for (let i = 0; i < 10; i++) { try { rmSync(box.root, { recursive: true, force: true }); break; } catch { Bun.sleepSync(1000); } }
}

// ---- одобрение серверов .mcp.json ----

function mcpList(box: Box, dir = box.project) {
  const r = runIn(box, ["claude", "mcp", "list"], dir, 240000);
  const text = strip(r.out + r.err);
  writeFileSync(`${box.logs}/claude-mcp-list-${results.length}.txt`, text);
  return (n: string) => {
    const l = text.split(/\r?\n/).find((x) => x.startsWith(`${n}:`)) ?? "absent";
    return /Connected/i.test(l) ? "connected" : /Pending/i.test(l) ? "pending" : /reject|disabled/i.test(l) ? "rejected" : l.slice(-60);
  };
}

async function approve() {
  const box = sandbox("approve", ["claude"]);
  try {
    const v = runIn(box, ["claude", "--version"], box.root);
    record("claude --version", v.code === 0, v.out.trim());
    const srv = (name: string) => ({ command: BUN, args: [STUB, "--name", name, "--log", `${box.logs}/${name}.jsonl`, "--vars", ""] });
    put(`${box.project}/.mcp.json`, JSON.stringify({ mcpServers: { team_echo: srv("team_echo"), team_two: srv("team_two") } }, null, 2));
    git(box.project, "add", ".mcp.json");
    git(box.project, "commit", "-q", "-m", "team mcp");
    const local = () => (existsSync(`${box.project}/.claude/settings.local.json`) ? JSON.parse(read(`${box.project}/.claude/settings.local.json`)) : {});
    const status0 = mcpList(box);
    record("до miksy: серверы .mcp.json — Pending approval", status0("team_echo") === "pending", status0("team_echo"));

    // 1. trust: true в слое — одобрение автоматически
    put(`${box.config}/layers/tree/Org/layer.yaml`, "trust: { claude: true }\n");
    const s1 = miksy(box, ["sync", "--all", "--yes"], "sync-layer");
    record("sync с trust: true: код 0, одобрение в .claude/settings.local.json", s1.code === 0 && JSON.stringify([...(local().enabledMcpjsonServers ?? [])].sort()) === '["team_echo","team_two"]', local());
    record("файл одобрений скрыт .git/info/exclude, git status чист", /settings\.local\.json/.test(read(`${box.project}/.git/info/exclude`)) && !git(box.project, "status", "--porcelain").stdout.toString().includes("settings.local"), "");
    const st1 = mcpList(box);
    record("claude mcp list: team_echo и team_two — Connected", st1("team_echo") === "connected" && st1("team_two") === "connected", { team_echo: st1("team_echo"), team_two: st1("team_two") });

    // 2. Слой больше не разрешает — своё одобрение и доверие сняты, нужно решение
    rmSync(`${box.config}/layers/tree/Org/layer.yaml`);
    const s2 = miksy(box, ["sync", "--all", "--yes"], "sync-nolayer");
    record("без слоя: одобрение снято, блок «Нужно решение» с командами серверов", !local().enabledMcpjsonServers?.length && /Нужно решение/.test(s2.out) && s2.out.includes("stub.mjs"), local());
    const st2 = mcpList(box);
    record("claude mcp list: снова не Connected", st2("team_echo") !== "connected", st2("team_echo"));

    // 3. Решение пользователя
    const t = miksy(box, ["trust", box.project, "--confirm"], "trust-confirm");
    record("miksy trust --confirm: доверие и одобрение", t.code === 0 && local().enabledMcpjsonServers?.length === 2, local());
    const st3 = mcpList(box);
    record("claude mcp list после --confirm: Connected", st3("team_echo") === "connected", st3("team_echo"));

    // 4. Пользователь отклонил team_two сам — miksy его не возвращает
    const doc = local();
    doc.disabledMcpjsonServers = ["team_two"];
    put(`${box.project}/.claude/settings.local.json`, JSON.stringify(doc, null, 2));
    miksy(box, ["sync", "--all", "--yes"], "sync-rejected");
    const after = local();
    record("отклонённый пользователем не одобряется, остаётся в disabled", !after.enabledMcpjsonServers.includes("team_two") && after.disabledMcpjsonServers.includes("team_two") && after.enabledMcpjsonServers.includes("team_echo"), after);
    const st4 = mcpList(box);
    record("claude mcp list: team_echo Connected, team_two не Connected", st4("team_echo") === "connected" && st4("team_two") !== "connected", { team_echo: st4("team_echo"), team_two: st4("team_two") });

    // 5. clean — своё снято, чужое решение осталось
    const c = miksy(box, ["clean", "--all"], "clean");
    const cl = local();
    record("clean: своё одобрение снято, disabled пользователя на месте", c.code === 0 && !(cl.enabledMcpjsonServers ?? []).includes("team_echo") && cl.disabledMcpjsonServers?.includes("team_two"), cl);
  } finally { await finish(box); }
}

// ---- блоки инструкций ----

async function blocks() {
  const box = sandbox("blocks", ["claude", "codex", "gemini"]);
  try {
    const files = { claude: `${box.home}/.claude/CLAUDE.md`, codex: `${box.home}/.codex/AGENTS.md`, gemini: `${box.home}/.gemini/GEMINI.md` };
    put(`${box.config}/layers/global/instructions/10-miksy.md`, "# про miksy\n```\n<!-- miksy:begin инструкции -->\n<!-- miksy:end -->\n```\n");
    for (const f of Object.values(files)) put(f, "моя память без LF");
    const s1 = miksy(box, ["sync", "--global"], "sync1");
    record("sync: код 0, блок во всех трёх файлах", s1.code === 0 && Object.values(files).every((f) => read(f).includes("<!-- miksy:begin")), s1.code);
    const s2 = miksy(box, ["sync", "--global"], "sync2");
    record("строка-маркер в правилах: повторный sync — без конфликта", s2.code === 0 && !/КОНФЛИКТ/.test(s2.out), s2.out.slice(-300));
    // «агент» дописал в конец (Claude Edit, Gemini «запомни»)
    for (const f of Object.values(files)) writeFileSync(f, read(f) + "MEMORY from agent\n");
    const s3 = miksy(box, ["sync", "--global"], "sync3");
    record("дописанное после блока: sync без конфликта, текст на месте", s3.code === 0 && Object.values(files).every((f) => read(f).endsWith("MEMORY from agent\n")), "");
    // редактор пересохранил с CRLF
    writeFileSync(files.claude, read(files.claude).replaceAll("\n", "\r\n"));
    const s4 = miksy(box, ["sync", "--global"], "sync-crlf");
    record("CRLF: не конфликт, файл не переписан", s4.code === 0 && !/КОНФЛИКТ/.test(s4.out) && !/CLAUDE\.md \(обновить\)/.test(s4.out) && read(files.claude).includes("\r\n<!-- miksy:end -->\r\n"), s4.out.slice(-300));
    // удалённый файл
    rmSync(files.codex);
    const s5 = miksy(box, ["sync", "--global"], "sync-deleted");
    record("удалённый файл Codex пишется заново", s5.code === 0 && read(files.codex).includes("<!-- miksy:begin"), s5.code);
    const c = miksy(box, ["clean", "--global"], "clean");
    record("clean: код 0", c.code === 0, c.out.slice(-300));
    record("clean Antigravity: «без LF» + дописанное — не склеены", read(files.gemini) === "моя память без LF\nMEMORY from agent\n", JSON.stringify(read(files.gemini)));
    record("clean Claude (CRLF): чужой текст сохранён, без лишнего \\r", read(files.claude) === "моя память без LF\r\nMEMORY from agent\r\n", JSON.stringify(read(files.claude)));
    record("clean Codex (удалённый и записанный заново): файла нет", !existsSync(files.codex), read(files.codex));
    // только пробелы вне блока
    put(files.claude, " \t\n\n");
    miksy(box, ["sync", "--global"], "sync-ws");
    miksy(box, ["clean", "--global"], "clean-ws");
    record("clean: пробелы вне блока — файл остаётся как был", read(files.claude) === " \t\n\n", JSON.stringify(read(files.claude)));
  } finally { await finish(box); }
}

// ---- группы ----

async function groups() {
  const box = sandbox("groups", ["claude", "opencode"]);
  try {
    const ws = box.ws;
    for (const p of ["Org/p1", "Corp/US/infra", "Team/platform", "Team/platform/child"]) { mkdirSync(`${ws}/${p}`, { recursive: true }); Bun.spawnSync(["git", "init", "--quiet", `${ws}/${p}`]); }
    const L = (rel: string, f: string, s: string) => put(`${box.config}/layers/tree/${rel}/${f}`, s);
    L("Org", "layer.yaml", "target: true\n"); L("Org", "instructions/10.md", "# rule ORG_RULE\n"); L("Org", "skills/s/SKILL.md", "---\nname: s\ndescription: d\n---\n");
    L("Corp", "layer.yaml", "target: true\n"); L("Corp", "instructions/10-corp.md", "# rule corp\n");
    L("Corp/US", "layer.yaml", "target: true\nexclude: [instructions.10-corp.md]\n"); L("Corp/US", "instructions/10-us.md", "# rule us\n");
    L("Team/platform", "layer.yaml", "target: true\n"); L("Team/platform", "instructions/10.md", "# rule platform\n");
    put(`${ws}/Org/CLAUDE.local.md`, "чужое\n<!-- miksy:end -->\n");
    put(`${ws}/Team/platform/CLAUDE.local.md`, "team\n"); put(`${ws}/Team/platform/.claude/rules/team.md`, "team\n");
    git(`${ws}/Team/platform`, "add", "CLAUDE.local.md", ".claude/rules/team.md");
    mkdirSync(`${box.root}/outside/Linked`, { recursive: true });
    symlinkSync(`${box.root}/outside/Linked`, `${ws}/Linked`, win ? "junction" : "dir");
    L("Linked", "layer.yaml", "target: true\n");

    const dry = miksy(box, ["sync", "--all", "--dry-run", "--yes"], "dry");
    record("dry-run: о группах этого же запуска с правилами не предупреждает (Corp)", !/группа Corp выше не получила/.test(dry.out), "");
    const s = miksy(box, ["sync", "--all", "--yes"], "sync-all");
    record("Org: маркеры повреждены — skill доставлен, правил нет (конфликт)", existsSync(`${ws}/Org/.claude/skills/s/SKILL.md`) && /КОНФЛИКТ/.test(s.out), "");
    record("Org/p1 получил правила группы и предупреждение", read(`${ws}/Org/p1/CLAUDE.local.md`).includes("ORG_RULE") && /группа Org выше не получила правила Claude/.test(s.out), "");
    const child = read(`${ws}/Team/platform/child/CLAUDE.local.md`);
    record("Team/platform: команда версионирует файлы правил — child получил полную цепочку", child.includes("g2 workspace rule") && child.includes("rule platform"), child.slice(0, 200));
    const infra = miksy(box, ["sync", `${ws}/Corp/US/infra`], "infra");
    record("exclude правила Corp у Corp/US — предупреждение и у Corp/US/infra", /exclude instructions\.10-corp\.md не действует для claude: приходит из файлов группы Corp/.test(infra.out), "");
    record("группа-симлинк: причина — симлинк", /цель Linked \(target: true\): .*симлинк/.test(s.out), "");
    // opencode в группе: правила по-прежнему полной цепочкой
    record("opencode: Org/p1 — полная цепочка в .opencode/miksy.md", read(`${ws}/Org/p1/.opencode/miksy.md`).includes("ORG_RULE"), "");

    // Бывшая группа с правленым блоком: неудачный clean не теряет отметку
    const corpBlock = `${ws}/Corp/CLAUDE.local.md`;
    writeFileSync(corpBlock, read(corpBlock).replace("# rule corp", "# rule corp (правка)"));
    rmSync(`${box.config}/layers/tree/Corp/layer.yaml`);
    const f1 = miksy(box, ["sync", "--all", "--yes"], "former1");
    const f2 = miksy(box, ["sync", "--all", "--yes"], "former2");
    record("бывшая группа: clean с конфликтом, второй sync --all снова её находит", f1.code === 3 && f2.code === 3 && /пометка группы снята: Corp/.test(f2.out), { f1: f1.code, f2: f2.code });
    const d = miksy(box, ["doctor"], "doctor");
    record("doctor: «Снята пометка группы» Corp", /Снята пометка группы[\s\S]*Corp/.test(d.out), "");
  } finally { await finish(box); }
}

// ---- обёртки с длинными и особыми значениями ----

async function talk(box: Box, command: string) {
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "g2", version: "1" } } };
  const p = Bun.spawn(win ? ["cmd.exe", "/d", "/c", command] : [command], { cwd: box.project, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: boxEnv(box) });
  p.stdin.write([init, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 2, method: "tools/list" }].map((m) => JSON.stringify(m)).join("\n") + "\n");
  await p.stdin.flush();
  await Bun.sleep(2500);
  p.stdin.end();
  const timer = setTimeout(() => p.kill(), 20000);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  clearTimeout(timer);
  const msgs = out.trim().split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  return { ok: msgs.find((m: any) => m.id === 2)?.result?.tools?.[0]?.name === "http_auth_ok", out, err };
}

async function wrappers() {
  const box = sandbox("wrappers", ["claude", "opencode", "gemini"]);
  const ports = { long: 4931, quote: 4932 };
  const stubs = Object.entries(ports).map(([k, port]) => Bun.spawn([process.execPath, STUB_HTTP, "--port", String(port), "--log", `${box.logs}/http-${k}.jsonl`,
    "--expect-sha", sha(`Bearer ${k === "long" ? LONG : QUOTE}`)], { stdout: "ignore", stderr: "ignore" }));
  try {
    await Bun.sleep(1500);
    const http = (name: string, port: number, secret: string) => put(`${box.config}/layers/global/mcp/${name}.yaml`, `name: ${name}\nurl: http://127.0.0.1:${port}/mcp\nheaders:\n  Authorization: "Bearer \${${secret}}"\n`);
    http("h_long", ports.long, "G2_LONG");
    http("h_quote", ports.quote, "G2_QUOTE");
    const stdio = (name: string, vars: Record<string, string>) => put(`${box.config}/layers/global/mcp/${name}.yaml`,
      `name: ${name}\ncommand: ${JSON.stringify(BUN)}\nargs: ${JSON.stringify([STUB, "--name", name, "--log", `${box.logs}/${name}.jsonl`, "--vars", Object.keys(vars).join(",")])}\nenv:\n` +
      Object.entries(vars).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`).join("\n") + "\n");
    stdio("s_special", { G2_SPECIAL: "${G2_SPECIAL}", G2_TOKEN: "${G2_TOKEN}" });
    stdio("s_long", { G2_LONG: "${G2_LONG}" });
    const s = miksy(box, ["sync", "--global"], "sync");
    record("sync --global: код 0", s.code === 0, s.out.slice(-400));
    const claudeCfg = JSON.parse(read(`${box.home}/.claude.json`)).mcpServers ?? {};
    const oc = JSON.parse(read(`${box.home}/.config/opencode/opencode.json`)).mcp ?? {};
    const ag = JSON.parse(read(`${box.home}/.gemini/config/mcp_config.json`)).mcpServers ?? {};
    record("имена скриптов: <сервер>-<способ>-<хеш>", /s_special-stdio-[0-9a-f]{8}\.(cmd|sh)$/.test(claudeCfg.s_special?.command ?? "") && /h_long-bridge-[0-9a-f]{8}\.(cmd|sh)$/.test(ag.h_long?.command ?? ""), { claude: claudeCfg.s_special?.command, gemini: ag.h_long?.command });
    // Claude helper: " и \ — пропуск везде; 1500 байт — пропуск только на Windows (set /p)
    record(`Claude helper: h_quote пропущен, h_long ${win ? "пропущен (Windows set /p)" : "доставлен"}`, !claudeCfg.h_quote && (win ? !claudeCfg.h_long : !!claudeCfg.h_long?.headersHelper), Object.keys(claudeCfg));
    record(`stdio s_long: ${win ? "пропущен (.cmd)" : "доставлен (sh)"}`, win ? !claudeCfg.s_long : !!claudeCfg.s_long, Object.keys(claudeCfg));
    record("opencode {file:} и мост Antigravity: h_long и h_quote доставлены", !!oc.h_long && !!oc.h_quote && !!ag.h_long && !!ag.h_quote, { oc: Object.keys(oc), ag: Object.keys(ag) });
    for (const n of ["h_long", "h_quote"]) {
      const t = await talk(box, ag[n].command);
      record(`мост ${n}: заголовок дошёл (tools/list через заглушку)`, t.ok, t.err.slice(0, 300));
    }
    const list = mcpList(box, box.home);
    record("claude mcp list: s_special Connected", list("s_special") === "connected", list("s_special"));
    if (!win) record("claude mcp list: h_long (helper, 1500 байт) Connected", list("h_long") === "connected", list("h_long"));
    // opencode на Windows — npm-ярлык opencode.cmd: запуск через cmd
    const oc1 = Bun.which("opencode") ?? "opencode";
    const ocArgv = (...a: string[]) => (/\.(cmd|bat)$/i.test(oc1) ? ["cmd.exe", "/d", "/c", oc1, ...a] : [oc1, ...a]);
    // Свой порт сервиса песочницы: порт по умолчанию может держать настоящий сервис пользователя
    const port = runIn(box, ocArgv("service", "set", "port", "28977"), box.home, 60000);
    writeFileSync(`${box.logs}/opencode-port.txt`, port.out + port.err);
    let text = "";
    try {
      for (let i = 0; i < 3 && !/h_long/.test(text); i++) {
        const r = runIn(box, ocArgv("mcp", "list"), box.home, 240000);
        text = strip(r.out + r.err);
        if (!/h_long/.test(text)) await Bun.sleep(3000);
      }
    } finally { runIn(box, ocArgv("service", "stop"), box.home, 60000); }
    writeFileSync(`${box.logs}/opencode-mcp-list.txt`, text);
    const line = (n: string) => text.split("\n").find((l) => new RegExp(`\\b${n}\\b`).test(l))?.trim() ?? "absent";
    for (const n of ["h_long", "h_quote"]) record(`opencode mcp list: ${n} connected ({file:})`, /connected/i.test(line(n)) && !/fail|error|disconnected/i.test(line(n)), line(n));
  } finally {
    for (const p of stubs) p.kill();
    await finish(box);
  }
}

const mode = process.argv[2];
const modes: Record<string, () => Promise<void>> = { approve, blocks, groups, wrappers };
if (!modes[mode]) { console.log("bun test/live/g2.ts approve|blocks|groups|wrappers"); process.exit(2); }
await modes[mode]();
