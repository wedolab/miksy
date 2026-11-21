// Круг 10u: MCP проекта у Codex, opencode, Antigravity — без путей машины в папке проекта. В файл проекта идёт
// «miksy mcp <агент> <место> <сервер>», обёртку своей машины команда находит сама (src/mcprun.ts). Одна папка
// проекта на двух машинах — одинаковые файлы; вторая машина берёт их под учёт молча
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { cliFixture, expectCode, mcpWrapper, put, said } from "./helpers";
import { hasTag, oldEngine, oldRunner } from "./fixes021b-helpers";
import { placeSlug, portableName } from "../src/launch";
import { shimText } from "../src/setup";

const win = process.platform === "win32";
const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const NL = "\n";
const read = (p: string) => readFileSync(p, "utf8");
const FILES = [".codex/config.toml", "opencode.json", ".agents/plugins/miksy/mcp_config.json", ".agents/plugins/miksy/rules/AGENTS.md", ".opencode/miksy.md"];

// Заглушка stdio-сервера: pid — в файл, на каждую строку stdin — ответ с TOKEN и cwd; конец stdin — выход
const STUB = [
  "const { writeFileSync } = require('node:fs');",
  "writeFileSync(process.argv[2], String(process.pid));",
  "let buf = '';",
  "process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); process.stdout.write('echo:' + line + ':' + (process.env.TOKEN ?? '-') + '\\n'); } });",
  "process.stdin.on('end', () => process.exit(0));",
  "",
].join(NL);

// Машина: свой дом и конфигурация, проект Org/p1; у проекта — сервер без переменных, сервер с переменной машины,
// сервер с секретом и заглушка (Bun и путь заглушки — переменные машины, TOKEN — секрет)
function machine(o: { agents?: string[] } = {}) {
  const agents = o.agents ?? ["codex", "opencode", "antigravity"];
  const f = cliFixture({ agents, projects: ["Org/p1"] });
  const L = `${f.config}/layers/tree/Org/p1`;
  put(`${f.dir}/tools/stub.cjs`, STUB);
  put(`${f.config}/local/machine.yaml`, [`workspace: ${f.ws}`, `agents: [${agents.join(", ")}]`, "vars:", `  BUN: "${process.execPath.replaceAll("\\", "/")}"`, `  TOOLS: "${f.dir}/tools"`, ""].join(NL));
  put(`${f.config}/local/secrets.env`, "TOKEN=artificial-token-10u" + NL);
  put(`${L}/mcp/plain.yaml`, ["name: plain", "command: npx", 'args: ["-y", "pkg"]', ""].join(NL));
  put(`${L}/mcp/ws.yaml`, ["name: ws", "command: node", 'args: ["${WORKSPACE}/Org/p1/tool.js", "${HOME}/x"]', ""].join(NL));
  put(`${L}/mcp/sec.yaml`, ["name: sec", "command: npx", 'args: ["srv"]', "env:", "  API: ${TOKEN}", ""].join(NL));
  put(`${L}/mcp/echo.yaml`, ["name: echo", "command: ${BUN}", 'args: ["${TOOLS}/stub.cjs", "${TOOLS}/pid"]', "env:", "  TOKEN: ${TOKEN}", ""].join(NL));
  put(`${f.home}/.miksy`, f.config + NL);
  return f;
}
const projectFiles = (dir: string) => Object.fromEntries(FILES.filter((p) => existsSync(`${dir}/${p}`)).map((p) => [p, read(`${dir}/${p}`)]));

// Окружение, какое Codex даёт stdio-серверу: базовый список, без HOME (Windows) и без MIKSY_CONFIG
function agentEnv(home: string): Record<string, string> {
  const pick = (k: string) => (process.env[k] !== undefined ? { [k]: process.env[k]! } : {});
  return win
    ? { ...pick("PATH"), ...pick("PATHEXT"), ...pick("SYSTEMROOT"), ...pick("ComSpec"), ...pick("TEMP"), ...pick("TMP"), USERPROFILE: home }
    : { ...pick("PATH"), HOME: home };
}

describe("файл проекта без путей машины", () => {
  test("Codex, opencode, Antigravity: секрет и переменные машины — через «miksy mcp», остальное как есть; файлы одинаковы на машинах с разными путями (и ОС)", () => {
    const a = machine(), b = machine();
    for (const f of [a, b]) expectCode(f.run(["sync", `${f.ws}/Org/p1`]), 0);
    const fa = projectFiles(`${a.ws}/Org/p1`), fb = projectFiles(`${b.ws}/Org/p1`);
    expect(Object.keys(fa).sort()).toEqual([...FILES].sort());
    expect(fb).toEqual(fa);
    for (const [p, text] of Object.entries(fa)) expect({ p, dir: text.includes(a.dir) || text.includes(a.dir.replaceAll("/", "\\\\")) }).toEqual({ p, dir: false });
    // Текст файлов — один и тот же на Windows, macOS и Linux (ожидание без зависимостей от ОС)
    expect(fa[".codex/config.toml"]).toBe([
      "# Сгенерировано miksy. Не править вручную — изменения вносить в конфигурацию miksy (слои).",
      'developer_instructions = "# workspace"',
      "",
      '["mcp_servers"."echo"]', '"command" = "miksy"', '"args" = ["mcp", "codex", "Org/p1", "echo"]', '"env_vars" = ["MIKSY_CONFIG"]', "",
      '["mcp_servers"."plain"]', '"command" = "npx"', '"args" = ["-y", "pkg"]', "",
      '["mcp_servers"."sec"]', '"command" = "miksy"', '"args" = ["mcp", "codex", "Org/p1", "sec"]', '"env_vars" = ["MIKSY_CONFIG"]', "",
      '["mcp_servers"."ws"]', '"command" = "miksy"', '"args" = ["mcp", "codex", "Org/p1", "ws"]', '"env_vars" = ["MIKSY_CONFIG"]', "",
    ].join(NL));
    const oc = JSON.parse(fa["opencode.json"]).mcp;
    expect(oc).toEqual({
      echo: { type: "local", command: ["miksy", "mcp", "opencode", "Org/p1", "echo"] },
      plain: { type: "local", command: ["npx", "-y", "pkg"] },
      sec: { type: "local", command: ["miksy", "mcp", "opencode", "Org/p1", "sec"] },
      ws: { type: "local", command: ["miksy", "mcp", "opencode", "Org/p1", "ws"] },
    });
    expect(JSON.parse(fa[".agents/plugins/miksy/mcp_config.json"]).mcpServers.sec).toEqual({ command: "miksy", args: ["mcp", "antigravity", "Org/p1", "sec"] });
    // Обёртки — у каждой машины в своей конфигурации, по месту проекта; путь заглушки — свой у машины
    for (const f of [a, b]) for (const agent of ["codex", "opencode", "antigravity"]) {
      const w = mcpWrapper(f.config, { agent, place: "Org/p1", server: "echo" });
      expect(read(w)).toContain(`${f.dir}/tools/stub.cjs`);
    }
  }, 120000);

  test("одна папка проекта на двух машинах: вторая берёт файлы первой под учёт молча, первая потом ничего не меняет", () => {
    const a = machine(), b = machine();
    // Папка с проектами — общая: workspace машины B — ссылка на папку машины A (облако, NAS — другой путь к той же папке)
    rmSync(b.ws, { recursive: true, force: true });
    symlinkSync(a.ws, b.ws, win ? "junction" : "dir");
    expectCode(a.run(["sync", `${a.ws}/Org/p1`]), 0);
    const before = projectFiles(`${a.ws}/Org/p1`);
    const rb = b.run(["sync", `${b.ws}/Org/p1`]);
    expect({ code: rb.code, conflict: /КОНФЛИКТ|конфликт/.test(rb.out) }, said(rb)).toEqual({ code: 0, conflict: false });
    expect(projectFiles(`${a.ws}/Org/p1`)).toEqual(before);
    const ledgerB = JSON.parse(read(`${b.config}/local/state/manifest.json`));
    const files = Object.values<any>(ledgerB.targets).flatMap((t) => Object.keys(t.files ?? {}));
    expect(files.some((p) => p.endsWith("/.codex/config.toml"))).toBe(true);
    // Обе машины: повторный sync — без изменений; файлы не перетягиваются
    for (const f of [a, b]) {
      const again = f.run(["sync", `${f.ws}/Org/p1`]);
      expectCode(again, 0);
      expect(again.out).not.toMatch(/записать|обновление|КОНФЛИКТ/);
    }
    expect(projectFiles(`${a.ws}/Org/p1`)).toEqual(before);
  }, 120000);

  test("имя сервера или путь проекта со знаками, которые не передать команде miksy, — путь этой машины и предупреждение: на второй машине конфликт, переименуйте", () => {
    expect(["Org/p1", "Клиенты/Проект 1", "a.b_c-d/e+f,g@h"].filter(portableName)).toHaveLength(3);
    expect(["a%b", "a^b", "a!b", 'a"b', "a'b", "a$b", "a`b", "-a", "a\\b", "a&b"].filter(portableName)).toEqual([]);
    const f = machine({ agents: ["codex"] });
    put(`${f.config}/layers/tree/Org/p1/mcp/odd.yaml`, ["name: odd$x", "command: npx", "env:", "  API: ${TOKEN}", ""].join(NL));
    const r = f.run(["sync", `${f.ws}/Org/p1`]);
    expectCode(r, 0);
    expect(r.out).toContain("mcp odd$x: имя сервера содержит знаки, которые нельзя передать команде miksy");
    expect(r.out).toContain("там будет конфликт файлов miksy. Чтобы его не было, переименуйте сервер в слое");
    const toml = read(`${f.ws}/Org/p1/.codex/config.toml`);
    expect(toml.replaceAll("\\\\", "/")).toContain("/local/run/codex/");
    expect(toml).toContain('"args" = ["mcp", "codex", "Org/p1", "sec"]');
  }, 60000);

  test("переход: файлы v0.4.0 (пути машины) — первый sync новой версией переписывает свои без конфликтов", () => {
    if (!hasTag("v0.4.0")) return; // на стендах нет тегов
    const f = machine();
    const old = oldRunner(oldEngine("v0.4.0"), f);
    expectCode(old(["sync", `${f.ws}/Org/p1`]) as any, 0);
    expect(read(`${f.ws}/Org/p1/.codex/config.toml`).replaceAll("\\\\", "/")).toContain("/local/run/codex/");
    const r = f.run(["sync", `${f.ws}/Org/p1`]);
    expect({ code: r.code, conflict: /КОНФЛИКТ/.test(r.out) }, said(r)).toEqual({ code: 0, conflict: false });
    for (const p of FILES.slice(0, 3)) expect(read(`${f.ws}/Org/p1/${p}`)).toContain("miksy");
    expect(read(`${f.ws}/Org/p1/.codex/config.toml`)).not.toContain("local");
    // Прежние обёртки (каталог по абсолютному пути) убраны, новые — по месту проекта; doctor проекту ничего не предлагает
    for (const agent of ["codex", "opencode", "antigravity"]) expect(readdirSync(`${f.config}/local/run/${agent}`)).toEqual([placeSlug("Org/p1")]);
    expect(f.run(["doctor"]).out).not.toContain("Org/p1");
    expect(f.run(["sync", `${f.ws}/Org/p1`]).out).not.toMatch(/записать|обновление|КОНФЛИКТ/);
  }, 180000);
});

describe("miksy mcp: запуск обёртки этой машины", () => {
  const spawnMcp = (f: ReturnType<typeof machine>, args: string[], env = agentEnv(f.home), cmd = [process.execPath, CLI]) =>
    Bun.spawn([...cmd, "mcp", ...args], { cwd: `${f.ws}/Org/p1`, env, stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });

  test("окружение как у Codex (без HOME и MIKSY_CONFIG): находит конфигурацию по ~/.miksy, секрет и переменные доходят, stdin/stdout — сквозные, код выхода — сервера", async () => {
    const f = machine({ agents: ["codex"] });
    expectCode(f.run(["sync", `${f.ws}/Org/p1`]), 0);
    const p = spawnMcp(f, ["codex", "Org/p1", "echo"]);
    p.stdin.write("ping\n");
    p.stdin.flush();
    const reader = p.stdout.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    p.stdin.end();
    reader.releaseLock();
    const code = await p.exited;
    expect({ first, code, err: await new Response(p.stderr).text() }).toEqual({ first: "echo:ping:artificial-token-10u\n", code: 0, err: "" });
  }, 60000);

  test("нет обёртки, нет конфигурации, неверный вызов — одна строка в stderr: что сделать; коды 1 и 2", async () => {
    const f = machine({ agents: ["codex"] });
    expectCode(f.run(["sync", `${f.ws}/Org/p1`]), 0);
    const run = async (args: string[], env = agentEnv(f.home)) => {
      const p = spawnMcp(f, args, env);
      p.stdin.end();
      return { code: await p.exited, err: await new Response(p.stderr).text() };
    };
    const none = await run(["codex", "Org/other", "echo"]);
    expect(none).toEqual({ code: 1, err: "miksy: на этой машине не записан запуск MCP-сервера echo (codex, проект Org/other) — выполните miksy sync в папке проекта или miksy sync --all\n" });
    const empty = `${f.dir}/empty`;
    mkdirSync(empty);
    const noConfig = await run(["codex", "Org/p1", "echo"], { ...agentEnv(f.home), MIKSY_CONFIG: empty });
    expect(noConfig.code).toBe(1);
    expect(noConfig.err).toMatch(/^miksy: конфигурация miksy не найдена .*MCP-сервер echo не запущен\n$/);
    const bad = await run(["codex", "Org/p1"]);
    expect(bad.code).toBe(2);
    expect(bad.err.split("\n").filter(Boolean)).toHaveLength(1);
    // Каталог обёрток — по месту проекта, одинаково на всех машинах
    expect(existsSync(`${f.config}/local/run/codex/${placeSlug("Org/p1")}`)).toBe(true);
  }, 60000);

  // Агент запускает команду miksy (miksy.cmd на Windows — через cmd.exe): цепочка miksy → Bun → обёртка → сервер.
  // Агент закрыл stdin (обычная остановка) или его процесс снят и ОС закрыла его концы канала — сервер завершается,
  // процессов не остаётся. Время до первого ответа — для доклада (через miksy и обёртку напрямую)
  test("цепочка через команду miksy: после закрытия stdin и после снятия процесса сервер не остаётся; время старта", async () => {
    const f = machine({ agents: ["codex"] });
    expectCode(f.run(["sync", `${f.ws}/Org/p1`]), 0);
    const shim = `${f.dir}/bin/${win ? "miksy.cmd" : "miksy"}`;
    put(shim, shimText(win ? "windows" : "macos", process.execPath, CLI.replaceAll("\\", "/")));
    if (!win) Bun.spawnSync(["chmod", "+x", shim]);
    const viaShim = win ? ["cmd.exe", "/d", "/c", shim] : [shim];
    const pidFile = `${f.dir}/tools/pid`;
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const gone = async (pid: number) => { for (let i = 0; i < 100 && alive(pid); i++) await Bun.sleep(100); return !alive(pid); };
    const firstReply = async (p: ReturnType<typeof spawnMcp>) => {
      const t0 = performance.now();
      p.stdin.write("x\n");
      p.stdin.flush();
      const reader = p.stdout.getReader();
      const text = new TextDecoder().decode((await reader.read()).value);
      reader.releaseLock();
      return { text, ms: Math.round(performance.now() - t0) };
    };
    const times: Record<string, number> = {};
    for (const how of ["stdin", "kill"] as const) {
      rmSync(pidFile, { force: true });
      const t0 = performance.now();
      const p = Bun.spawn([...viaShim, "mcp", "codex", "Org/p1", "echo"], { cwd: `${f.ws}/Org/p1`, env: agentEnv(f.home), stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
      const r = await firstReply(p);
      times[`miksy (${how})`] = Math.round(performance.now() - t0);
      expect(r.text).toBe("echo:x:artificial-token-10u\n");
      const pid = Number(read(pidFile));
      if (how === "kill") p.kill();
      p.stdin.end();
      expect({ how, gone: await gone(pid) }).toEqual({ how, gone: true });
      await p.exited;
    }
    // Для сравнения: обёртка напрямую (как до 10u)
    rmSync(pidFile, { force: true });
    const w = mcpWrapper(f.config, { agent: "codex", place: "Org/p1", server: "echo" });
    const t0 = performance.now();
    const direct = Bun.spawn(win ? ["cmd.exe", "/d", "/c", w] : [w], { env: agentEnv(f.home), stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
    await firstReply(direct);
    times["обёртка напрямую"] = Math.round(performance.now() - t0);
    direct.stdin.end();
    await direct.exited;
    console.log(`10u: время до первого ответа заглушки, мс: ${JSON.stringify(times)}`);
    expect(times["miksy (stdin)"]).toBeLessThan(5000);
  }, 120000);
});

// Круг 10u-2 (рецензия 10u)
describe("10u-2: ярлык miksy, особые пути, без регрессий", () => {
  // Чужая папка: bunfig.toml с preload (дописывает в метку argv процесса) и .env, подменяющий MIKSY_CONFIG. Сервер-
  // заглушка сам — Bun в папке проекта и preload читает (как любой Bun-сервер, и до 10u); важно, что не процесс miksy
  const ranInMiksy = (evil: string) => existsSync(`${evil}/PRELOAD-RAN`) && read(`${evil}/PRELOAD-RAN`).includes("cli.ts");
  const hostile = (dir: string, evil: string) => {
    put(`${dir}/bunfig.toml`, 'preload = ["./evil.ts"]\n');
    put(`${dir}/evil.ts`, `require("node:fs").appendFileSync(${JSON.stringify(`${evil}/PRELOAD-RAN`)}, process.argv.join(" ") + "\\n");\n`);
    put(`${dir}/.env`, `MIKSY_CONFIG=${evil}\n`);
    mkdirSync(evil, { recursive: true });
  };
  const shimIn = (f: { dir: string }, legacy = false) => {
    const shim = `${f.dir}/bin${legacy ? "-old" : ""}/${win ? "miksy.cmd" : "miksy"}`;
    put(shim, shimText(win ? "windows" : "macos", process.execPath, CLI.replaceAll("\\", "/"), legacy));
    if (!win) Bun.spawnSync(["chmod", "+x", shim]);
    return win ? ["cmd.exe", "/d", "/c", shim] : [shim];
  };

  test("ярлык не читает .env и bunfig.toml папки запуска — ни у miksy mcp, ни у обычной команды; прежний ярлык читал", async () => {
    const f = machine({ agents: ["codex"] });
    expectCode(f.run(["sync", `${f.ws}/Org/p1`]), 0);
    const proj = `${f.ws}/Org/p1`, evil = `${f.dir}/evil`;
    hostile(proj, evil);
    // miksy mcp из папки проекта (как агент): ответ настоящей обёртки, preload не выполнен
    const p = Bun.spawn([...shimIn(f), "mcp", "codex", "Org/p1", "echo"], { cwd: proj, env: agentEnv(f.home), stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
    p.stdin.write("hi\n");
    p.stdin.flush();
    const reader = p.stdout.getReader();
    const reply = new TextDecoder().decode((await reader.read()).value);
    reader.releaseLock();
    p.stdin.end();
    expect({ reply, code: await p.exited, preload: ranInMiksy(evil) }).toEqual({ reply: "echo:hi:artificial-token-10u\n", code: 0, preload: false });
    // Обычная команда в той же папке: конфигурация — по ~/.miksy, не из .env
    const doc = Bun.spawnSync([...shimIn(f), "doctor"], { cwd: proj, env: agentEnv(f.home), stdout: "pipe", stderr: "pipe", windowsHide: true });
    const out = doc.stdout.toString() + doc.stderr.toString();
    expect({ evil: out.includes(evil), preload: ranInMiksy(evil) }).toEqual({ evil: false, preload: false });
    expect(out).toContain("miksy doctor");
    // Контроль: ярлык формата 0.4.0 их читал (опыт рецензента)
    const old = Bun.spawnSync([...shimIn(f, true), "--version"], { cwd: proj, env: agentEnv(f.home), stdout: "pipe", stderr: "pipe", windowsHide: true });
    expect({ code: old.exitCode, preload: ranInMiksy(evil) }).toEqual({ code: 0, preload: true });
  }, 60000);

  test("путь конфигурации с & ^ % ! — miksy mcp запускает обёртку", async () => {
    const f = machine({ agents: ["codex"] });
    const odd = `${f.dir}/cfg & ^x %OS% !y`;
    renameSync(f.config, odd);
    put(`${f.home}/.miksy`, odd + NL);
    const env = { ...process.env, MIKSY_CONFIG: odd, HOME: f.home, USERPROFILE: f.home };
    const s = Bun.spawnSync([process.execPath, CLI, "sync", `${f.ws}/Org/p1`], { cwd: f.dir, env, stdout: "pipe", stderr: "pipe" });
    expect({ code: s.exitCode, err: s.stderr.toString() }).toEqual({ code: 0, err: "" });
    const p = Bun.spawn([process.execPath, CLI, "mcp", "codex", "Org/p1", "echo"], { cwd: `${f.ws}/Org/p1`, env: agentEnv(f.home), stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
    p.stdin.write("odd\n");
    p.stdin.flush();
    const reader = p.stdout.getReader();
    const reply = new TextDecoder().decode((await reader.read()).value);
    reader.releaseLock();
    p.stdin.end();
    expect({ reply, code: await p.exited, err: await new Response(p.stderr).text() }).toEqual({ reply: "echo:odd:artificial-token-10u\n", code: 0, err: "" });
  }, 60000);

  test("сервер с переменной машины без секрета, аргумент с кавычкой: Windows — как в 0.4.0 (значения машины) с предупреждением, macOS и Linux — через miksy", () => {
    const f = machine({ agents: ["codex"] });
    put(`${f.config}/layers/tree/Org/p1/mcp/json.yaml`, ["name: json", "command: node", `args: ['{"a":1}', "\${TOOLS}/j.js"]`, ""].join(NL));
    const r = f.run(["sync", `${f.ws}/Org/p1`]);
    expectCode(r, 0);
    const toml = read(`${f.ws}/Org/p1/.codex/config.toml`);
    const part = toml.slice(toml.indexOf('["mcp_servers"."json"]'));
    if (win) {
      expect(part).toContain(`"command" = "node"`);
      expect(part).toContain(`${f.dir}/tools/j.js`);
      expect(r.out).toContain("mcp json:");
      expect(r.out).toContain("сервер записан в файл проекта со значениями этой машины, как раньше");
    } else expect(part).toContain('"args" = ["mcp", "codex", "Org/p1", "json"]');
  }, 60000);

  test("место в дереве есть у двух корней — пути этой машины и предупреждение (каталог обёрток не общий)", () => {
    const f = machine({ agents: ["codex"] });
    const drive = `${f.dir}/drive`;
    for (const d of [`${f.ws}/Clients/Acme`, `${drive}/Acme`, `${drive}/Solo`]) { mkdirSync(d, { recursive: true }); Bun.spawnSync(["git", "init", "-q", d]); }
    put(`${f.config}/layers/tree/mcp/sec.yaml`, ["name: sec", "command: npx", "env:", "  API: ${TOKEN}", ""].join(NL));
    put(`${f.config}/local/machine.yaml`, `workspace:\n  - "${f.ws}"\n  - { path: "${drive}", tree: "Clients" }\nagents: [codex]\n`);
    const r = f.run(["sync", "--all", "--yes"]);
    expectCode(r, 0);
    expect(r.out).toContain("место проекта «Clients/Acme» в дереве слоёв есть у двух корней");
    for (const d of [`${f.ws}/Clients/Acme`, `${drive}/Acme`]) expect(read(`${d}/.codex/config.toml`).replaceAll("\\\\", "/")).toContain("/local/run/codex/");
    // Место только одного корня — переносимо
    expect(read(`${drive}/Solo/.codex/config.toml`)).toContain('"args" = ["mcp", "codex", "Clients/Solo", "sec"]');
  }, 60000);

  test("--headers не принимается (helper Codex — в 10v)", async () => {
    const f = machine({ agents: ["codex"] });
    const p = Bun.spawn([process.execPath, CLI, "mcp", "codex", "Org/p1", "echo", "--headers"], { env: agentEnv(f.home), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    p.stdin.end();
    expect({ code: await p.exited, out: await new Response(p.stdout).text() }).toEqual({ code: 2, out: "" });
  });
});
