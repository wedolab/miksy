// Круг 10v: MCP проекта у Codex, opencode, Antigravity без путей машины — и для HTTP с секретом в заголовке (мост через
// «miksy mcp … --bridge»; helper Codex и {file:} opencode остались только в домашних конфигах). Codex вне терминала
// (macOS, Linux) — каталог команды miksy в ~/.codex/.env; doctor и sync — о команде miksy; подсказка, если файл
// переписала машина со старой версией miksy
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cliFixture, expectCode, mcpWrapper, put, said, withShim } from "./helpers";
import { hasTag, oldEngine, oldRunner } from "./fixes021b-helpers";
import { codex } from "../adapters/codex";
import { shimNotes, shimPath, shimText } from "../src/shim";
import type { Machine } from "../src/types";

const win = process.platform === "win32";
const OS = win ? "windows" : process.platform === "darwin" ? "macos" : "linux";
const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const NL = "\n";
const read = (p: string) => readFileSync(p, "utf8");
const FILES = [".codex/config.toml", "opencode.json", ".agents/plugins/miksy/mcp_config.json"];

// Машина: проект Org/p1, HTTP-сервер с секретом в заголовке (url — переменная машины: заглушка у каждой своя)
function machine(url = "https://example.invalid/mcp") {
  const f = cliFixture({ agents: ["codex", "opencode", "antigravity"], projects: ["Org/p1"] });
  put(`${f.config}/local/machine.yaml`, [`workspace: ${f.ws}`, "agents: [codex, opencode, antigravity]", ""].join(NL));
  put(`${f.config}/local/secrets.env`, "WEB_TOKEN=artificial-web-token-10v" + NL);
  put(`${f.config}/layers/tree/Org/p1/mcp/web.yaml`, ["name: web", `url: ${url}`, "headers:", "  Authorization: Bearer ${WEB_TOKEN}", ""].join(NL));
  put(`${f.home}/.miksy`, f.config + NL);
  return f;
}
const projectFiles = (dir: string) => Object.fromEntries(FILES.map((p) => [p, read(`${dir}/${p}`)]));
function agentEnv(home: string): Record<string, string> {
  const pick = (k: string) => (process.env[k] !== undefined ? { [k]: process.env[k]! } : {});
  return win ? { ...pick("PATH"), ...pick("PATHEXT"), ...pick("SYSTEMROOT"), ...pick("ComSpec"), ...pick("TEMP"), ...pick("TMP"), USERPROFILE: home } : { ...pick("PATH"), HOME: home };
}

describe("HTTP с секретом в заголовке — мост через miksy mcp", () => {
  test("Codex, opencode, Antigravity: в файле проекта — miksy mcp … --bridge, без путей и {file:}; файлы одинаковы на двух машинах", () => {
    const a = machine(), b = machine();
    for (const f of [a, b]) expectCode(f.run(["sync", `${f.ws}/Org/p1`]), 0);
    const fa = projectFiles(`${a.ws}/Org/p1`);
    expect(projectFiles(`${b.ws}/Org/p1`)).toEqual(fa);
    expect(fa[".codex/config.toml"]).toContain('["mcp_servers"."web"]\n"command" = "miksy"\n"args" = ["mcp", "codex", "Org/p1", "web", "--bridge"]\n"env_vars" = ["MIKSY_CONFIG"]\n');
    expect(fa[".codex/config.toml"]).not.toContain("http_headers_helper");
    expect(JSON.parse(fa["opencode.json"]).mcp.web).toEqual({ type: "local", command: ["miksy", "mcp", "opencode", "Org/p1", "web", "--bridge"] });
    expect(JSON.parse(fa[".agents/plugins/miksy/mcp_config.json"]).mcpServers.web).toEqual({ command: "miksy", args: ["mcp", "antigravity", "Org/p1", "web", "--bridge"] });
    for (const text of Object.values(fa)) expect(text).not.toMatch(/\{file:|local[\\/]+run|artificial/);
  }, 60000);

  test("miksy mcp … --bridge в окружении как у Codex: запрос уходит на HTTP-сервер с заголовком из секрета, ответ — в stdout", async () => {
    let auth: string | null = null;
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
      const body = await req.json().catch(() => null) as { id?: unknown; method?: string } | null;
      auth = req.headers.get("authorization");
      if (body?.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "stub", version: "1" } } });
      return new Response(null, { status: 202 });
    } });
    try {
      const f = machine(`http://127.0.0.1:${server.port}/mcp`);
      expectCode(f.run(["sync", `${f.ws}/Org/p1`]), 0);
      const p = Bun.spawn([process.execPath, CLI, "mcp", "codex", "Org/p1", "web", "--bridge"], { cwd: `${f.ws}/Org/p1`, env: agentEnv(f.home), stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) + "\n");
      await p.stdin.flush();
      const reader = p.stdout.getReader();
      let out = "";
      while (!out.includes("\n")) { const { value, done } = await reader.read(); if (done) break; out += new TextDecoder().decode(value); }
      reader.releaseLock();
      p.stdin.end();
      await p.exited;
      expect({ id: JSON.parse(out.split("\n")[0]).id, auth }).toEqual({ id: 1, auth: "Bearer artificial-web-token-10v" });
    } finally { server.stop(true); }
  }, 60000);

  test("переход: v0.4.0 записал helper Codex и {file:} opencode с путями машины — новая версия переписывает без конфликтов", () => {
    if (!hasTag("v0.4.0")) return; // на стендах нет тегов
    const f = machine();
    const old = oldRunner(oldEngine("v0.4.0"), f);
    expectCode(old(["sync", `${f.ws}/Org/p1`]) as any, 0);
    expect(read(`${f.ws}/Org/p1/.codex/config.toml`)).toContain("http_headers_helper");
    expect(read(`${f.ws}/Org/p1/opencode.json`)).toContain("{file:");
    const r = f.run(["sync", `${f.ws}/Org/p1`]);
    expect({ code: r.code, conflict: /КОНФЛИКТ/.test(r.out) }, said(r)).toEqual({ code: 0, conflict: false });
    for (const p of FILES) expect(read(`${f.ws}/Org/p1/${p}`)).not.toMatch(/\{file:|http_headers_helper|local[\\/]+run/);
    expect(f.run(["sync", `${f.ws}/Org/p1`]).out).not.toMatch(/записать|обновление|КОНФЛИКТ/);
  }, 180000);

  test("файл переписала машина со старой версией (пути её обёрток) — конфликт с подсказкой обновить miksy там", () => {
    const f = machine();
    expectCode(f.run(["sync", `${f.ws}/Org/p1`]), 0);
    const cfg = `${f.ws}/Org/p1/opencode.json`;
    writeFileSync(cfg, read(cfg).replace('"miksy",', '"C:\\\\other\\\\miksy-config\\\\local\\\\run\\\\opencode\\\\p1-1234\\\\web-bridge-1.cmd",'));
    const r = f.run(["sync", `${f.ws}/Org/p1`]);
    expect(r.code).toBe(3);
    expect(r.out).toContain("похоже, его переписала другая машина со старой версией miksy (в файле — пути её обёрток): обновите miksy там (miksy update), а здесь --force вернёт запись без путей машины");
  }, 60000);
});

describe("Codex вне терминала: каталог команды miksy в ~/.codex/.env (macOS, Linux)", () => {
  const render = (home: string, os: Machine["os"]) => codex.render({ layers: [], instructions: [], skills: [], notes: [], mcp: [] } as any, { scope: "global" }, { home, workspace: `${home}/ws`, os, vars: {} });
  const setShim = (home: string, os: Machine["os"]) => put(shimPath(home, os, {}), shimText(os, "/opt/bun", "/e/src/cli.ts"));

  test("есть команда miksy — блок PATH; ~/.codex/.env со своими строками — не трогается, подсказка; Windows и без команды — ничего", () => {
    const f = cliFixture();
    expect(render(f.home, "macos").files.filter((x) => x.path === ".codex/.env")).toEqual([]);
    setShim(f.home, "macos");
    const env = render(f.home, "macos").files.find((x) => x.path === ".codex/.env");
    expect(env).toMatchObject({ base: "home", mode: "own", block: true, content: `PATH="${f.home}/.bun/bin:\${PATH}"\n` });
    setShim(f.home, "windows");
    expect(render(f.home, "windows").files.some((x) => x.path === ".codex/.env")).toBe(false);
    put(`${f.home}/.codex/.env`, "OPENAI_API_KEY=artificial\n");
    const own = render(f.home, "macos");
    expect(own.files.some((x) => x.path === ".codex/.env")).toBe(false);
    expect(own.advice?.join("\n")).toContain(`~/.codex/.env — ваш файл, miksy его не меняет. Допишите в него строку: PATH="${f.home}/.bun/bin:\${PATH}"`);
  });

  test.skipIf(win)("sync --global пишет блок с маркерами «#», clean --global его убирает", () => {
    const f = cliFixture({ agents: ["codex"] });
    withShim(f);
    expectCode(f.run(["sync", "--global"]), 0);
    const text = read(`${f.home}/.codex/.env`);
    expect(text).toBe(`# miksy:begin (сгенерировано miksy — не править)\nPATH="${f.home}/.bun/bin:\${PATH}"\n# miksy:end\n`);
    expect(f.run(["sync", "--global"]).out).not.toMatch(/записать|обновление/);
    expectCode(f.run(["clean", "--global"]), 0);
    expect(existsSync(`${f.home}/.codex/.env`)).toBe(false);
  }, 60000);
});

describe("doctor и sync — о команде miksy", () => {
  test("нет команды, а MCP проекта запускает она — проблема; есть — нет; старый вид — проблема в doctor и предупреждение в sync", () => {
    const f = machine();
    expectCode(f.run(["sync", "--all", "--yes"]), 0);
    expectCode(f.run(["sync", "--global"]), 0);
    const missing = f.run(["doctor"]);
    expect(missing.out).toContain("Команда miksy (1) — ею агенты запускают MCP-серверы проектов");
    expect(missing.out).toContain("команды miksy нет (");
    expect(missing.out).toContain("— выполните miksy setup (создаст её)");
    const shim = withShim(f);
    expect(f.run(["doctor"]).out).not.toContain("Команда miksy (1) — ею агенты");
    // Старый вид (до 10u-2): движок обновили git pull без update или setup
    writeFileSync(shim, shimText(OS, process.execPath.replaceAll("\\", "/"), CLI.replaceAll("\\", "/"), true));
    const legacy = f.run(["doctor"]);
    expect(legacy.out).toContain("старого вида: она читает .env и bunfig.toml папки, в которой её запускают (агенты — в папке проекта), — выполните miksy setup --yes");
    const s = f.run(["sync", `${f.ws}/Org/p1`]);
    expect(s.out).toContain("предупреждение: команда miksy (");
    expect(s.out).toContain("— выполните miksy setup --yes");
  }, 120000);

  test("каталог команды не в PATH для программ вне терминала — справочно, с тем, что сделать", () => {
    const f = cliFixture();
    put(shimPath(f.home, "windows", {}), shimText("windows", "C:/b/bun.exe", "D:/e/src/cli.ts"));
    put(shimPath(f.home, "macos", {}), shimText("macos", "/opt/bun", "/e/src/cli.ts"));
    const dir = `${f.home}/.bun/bin`;
    expect(shimNotes(f.home, "windows", true, { registryPath: () => "C:\\Windows;C:\\other" }).info.join()).toContain(`каталога команды miksy ${dir} нет в PATH пользователя`);
    expect(shimNotes(f.home, "windows", true, { registryPath: () => `C:\\Windows;${dir.replaceAll("/", "\\")}\\` }).info).toEqual([]);
    expect(shimNotes(f.home, "macos", true).info.join()).toContain("не прописан в PATH оболочки");
    put(`${f.home}/.zshrc`, 'export BUN_INSTALL="$HOME/.bun"\nexport PATH="$BUN_INSTALL/bin:$PATH"\n');
    expect(shimNotes(f.home, "macos", true).info).toEqual([]);
    // MCP проектов не запускаются командой miksy — о PATH и отсутствии команды молчит
    rmSync(shimPath(f.home, "macos", {}));
    expect(shimNotes(f.home, "macos", false)).toEqual({ problems: [], info: [] });
  });
});

// Круг 10v-2 (рецензия 10v)
// Файлы каталога (рекурсивно), где есть текст
function withText(dir: string, text: string): string[] {
  const { readdirSync, statSync } = require("node:fs");
  const out: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d)) { const p = `${d}/${e}`; if (statSync(p).isDirectory()) walk(p); else if (read(p).includes(text)) out.push(p); } };
  if (existsSync(dir)) walk(dir);
  return out;
}
describe("10v-2: ключи в .env не копируются, путь команды устойчив", () => {
  test("файл .env (ключи пользователя) не копируется ни в бэкап запуска, ни в оригиналы", () => {
    const f = cliFixture();
    const env = `${f.home}/.codex/.env`, other = `${f.home}/notes.txt`;
    put(env, "OPENAI_API_KEY=artificial-user-key-10v2\n");
    put(other, "x\n");
    const { backup, neverCopied, newBackupRun, runDir } = require("../src/backup");
    newBackupRun();
    backup(env, f.config);
    backup(other, f.config);
    expect([neverCopied(env), neverCopied(`${f.home}/a/.env.local`), neverCopied(`${f.home}/prod.env`), neverCopied(other)]).toEqual([true, true, true, false]);
    expect(runDir()).not.toBeNull();
    expect(withText(`${f.config}/local`, "artificial-user-key")).toEqual([]);
    expect(withText(`${f.config}/local/backups`, "x\n").length).toBe(1); // обычный файл скопирован
  });

  test.skipIf(win)("miksy записал блок в ~/.codex/.env, пользователь дописал ключ: смена блока и clean --global — ключа нет ни в одном файле local/backups, строки пользователя целы", () => {
    const f = cliFixture({ agents: ["codex"] });
    withShim(f);
    expectCode(f.run(["sync", "--global"]), 0);
    const env = `${f.home}/.codex/.env`;
    writeFileSync(env, read(env) + "OPENAI_API_KEY=artificial-user-key-10v2\n");
    // Команда переехала (другой каталог Bun) — блок меняется
    const moved = `${f.dir}/bun2/bin/miksy`;
    put(moved, read(shimPath(f.home, "macos", {})));
    put(`${f.config}/local/state/miksy-command`, moved + "\n");
    expectCode(f.run(["sync", "--global"]), 0);
    expect(read(env)).toContain(`PATH="${f.dir}/bun2/bin:\${PATH}"`);
    expectCode(f.run(["clean", "--global", "--force"]), 0);
    expect(read(env)).toBe("OPENAI_API_KEY=artificial-user-key-10v2\n");
    expect(withText(`${f.config}/local`, "artificial-user-key")).toEqual([]);
  }, 90000);

  test("путь команды: записанный setup — главный; иначе ~/.bun/bin, затем $BUN_INSTALL/bin — не по окружению запуска", () => {
    const f = cliFixture();
    const home = `${f.home}/.bun/bin/${win ? "miksy.cmd" : "miksy"}`, custom = `${f.dir}/custom/bin/${win ? "miksy.cmd" : "miksy"}`;
    put(custom, "x");
    // Команда только в BUN_INSTALL — найдётся по нему; без него — путь по умолчанию (её нет)
    expect(shimPath(f.home, OS, { BUN_INSTALL: `${f.dir}/custom` })).toBe(custom);
    put(home, "x");
    // Есть в ~/.bun/bin — она, с BUN_INSTALL и без
    expect([shimPath(f.home, OS, { BUN_INSTALL: `${f.dir}/custom` }), shimPath(f.home, OS, {})]).toEqual([home, home]);
  });

  test("doctor: список агентов — из адаптеров, MCP проектов которых запускает команда; fish — config.fish", () => {
    const f = machine();
    expectCode(f.run(["sync", "--all", "--yes"]), 0);
    expect(f.run(["doctor"]).out).toContain("а ею Codex, opencode, Antigravity запускают MCP-серверы проектов (miksy mcp)");
    const g = cliFixture();
    put(shimPath(g.home, "macos", {}), shimText("macos", "/opt/bun", "/e/src/cli.ts"));
    expect(shimNotes(g.home, "macos", true).info).toHaveLength(1);
    put(`${g.home}/.config/fish/config.fish`, "fish_add_path ~/.bun/bin\n");
    expect(shimNotes(g.home, "macos", true).info).toEqual([]);
  }, 60000);
});
