// Круг 11b: файл проекта не зависит от того, что есть на машине. У Codex, opencode и Antigravity (MCP в файле проекта,
// «miksy mcp …») сервер без секрета или переменной, с недоставляемым значением или только для другой ОС не пропускается:
// он в файле проекта, а на этой машине вместо обёртки — причина. miksy mcp отвечает агенту ошибкой JSON-RPC на
// initialize с этой причиной (код 1) или, для другой ОС, — пустым сервером
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { ADAPTERS, renderFor } from "../src/registry";
import { cliFixture, expectCode, put, textFiles } from "./helpers";
import { git, yamlRoots } from "./rootshelp";
import type { Os } from "../src/types";

const gitx = (dir: string, ...args: string[]) => Bun.spawnSync(["git", "-C", dir, "-c", `core.excludesFile=${tmpdir()}/no-global-ignore`, ...args],
  { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
const status = (dir: string) => gitx(dir, "status", "--porcelain", "--untracked-files=all").stdout.toString().trim();
const snap = (dir: string) => Object.fromEntries(textFiles(dir).filter((p) => !p.includes("/.git/")).map((p) => [p.slice(dir.length), readFileSync(p, "utf8")]));
const changes = (out: string) => out.split("\n").filter((l) => /^\s{2}(записать|обновить|удалить|взять под учёт|снять с учёта|восстановить|блок|КОНФЛИКТ|\.git\/info|слить)/.test(l));
const AGENTS = ["codex", "opencode", "antigravity"];
const here: Os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
const other: Os = here === "linux" ? "macos" : "linux";
const runDir = (config: string): string[] => {
  const walk = (d: string): string[] => !existsSync(d) ? [] : readdirSync(d).flatMap((n) => statSync(`${d}/${n}`).isDirectory() ? walk(`${d}/${n}`) : [`${d}/${n}`]);
  return walk(`${config}/local/run`);
};
const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) + "\n";
const replies = (out: string) => out.split("\n").filter(Boolean).map((l) => JSON.parse(l));

// Две машины, одна общая папка; слои у обеих одинаковые, секрет TOK — только у A
function twoMachines() {
  const A = cliFixture({ agents: AGENTS, projects: ["Org/a1"] });
  const B = cliFixture({ agents: AGENTS, projects: ["Org/b1"] });
  const cloud = `${A.dir}/cloud`;
  git(`${cloud}/Acme/app`);
  for (const f of [A, B]) {
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: cloud, tree: "Cloud" }])}agents: [${AGENTS.join(", ")}]\n`);
    put(`${f.config}/layers/tree/Cloud/mcp/gl.yaml`, "name: gl\ncommand: echo\nenv:\n  TOKEN: ${TOK}\n");
    put(`${f.config}/layers/tree/Cloud/mcp/web.yaml`, "name: web\nurl: https://example.invalid/mcp\nheaders:\n  Authorization: Bearer ${TOK}\n");
    put(`${f.config}/layers/tree/Cloud/mcp/plain.yaml`, "name: plain\ncommand: echo\n");
    put(`${f.config}/layers/tree/Cloud/mcp/elsewhere.yaml`, `name: elsewhere\ncommand: echo\nos: [${other}]\n`);
  }
  put(`${A.config}/local/secrets.env`, "TOK=token_value_123456\n");
  return { A, B, app: `${cloud}/Acme/app` };
}

describe("11b: серверы в файле проекта независимо от машины", () => {
  test("секрет только у A: файлы проекта одинаковы, git чист, повтор без изменений; у B вместо обёрток — причины", () => {
    const { A, B, app } = twoMachines();
    const a1 = A.run(["sync", app]);
    expect(a1.code).toBe(0);
    const afterA = snap(app);
    const b1 = B.run(["sync", app]);
    expect(b1.code).toBe(0);
    expect(snap(app)).toEqual(afterA);
    expect(status(app)).toBe("");
    expect(b1.out).toContain("mcp gl: на этой машине не запустится — не заданы переменные TOK");
    expect(b1.out).not.toContain("пропущен сервер");
    // Сервер другой ОС — молча (пустой сервер)
    expect(b1.out).not.toMatch(/mcp elsewhere: на этой машине/);
    const a2 = A.run(["sync", app]);
    const b2 = B.run(["sync", app]);
    expect([a2.code, b2.code]).toEqual([0, 0]);
    expect(changes(a2.out)).toEqual([]);
    expect(changes(b2.out)).toEqual([]);
    expect(snap(app)).toEqual(afterA);
    // Все четыре сервера — в файле Codex через miksy (plain — как есть)
    const codex = afterA["/.codex/config.toml"];
    for (const s of ["gl", "web", "elsewhere"]) expect(codex).toContain(`"mcp", "codex", "Cloud/Acme/app", "${s}"`);
    expect(codex).toContain('"plain"');
    // У A — обёртки (gl, web) и причина только для другой ОС; у B — причины, обёрток gl и web нет
    const a = runDir(A.config).map((p) => p.slice(p.lastIndexOf("/") + 1));
    const b = runDir(B.config).map((p) => p.slice(p.lastIndexOf("/") + 1));
    expect(a.filter((n) => /^gl-stdio-.*\.(sh|cmd)$/.test(n)).length).toBe(3);
    expect(a.filter((n) => n.endsWith(".json")).every((n) => n.startsWith("elsewhere-"))).toBe(true);
    expect(b.filter((n) => /^(gl|web)-.*\.(sh|cmd)$/.test(n))).toEqual([]);
    expect(b.filter((n) => /^(gl|web)-.*\.json$/.test(n)).length).toBe(6);
  }, 120000);

  test("miksy mcp: причина — ошибкой JSON-RPC на initialize и в stderr, код 1; другая ОС — пустой сервер", () => {
    const { B, app } = twoMachines();
    expectCode(B.run(["sync", app]), 0);
    for (const [args, kind] of [[["gl"], "stdio"], [["web", "--bridge"], "bridge"]] as const) {
      const r = B.run(["mcp", "codex", "Cloud/Acme/app", ...args], { stdin: init });
      expect([r.code, kind]).toEqual([1, kind]);
      expect(r.err).toContain(`miksy: MCP-сервер ${args[0]} на этой машине не запускается: не заданы переменные TOK`);
      const [reply] = replies(r.out);
      expect(reply.id).toBe(1);
      expect(reply.error.code).toBe(-32000);
      expect(reply.error.message).toContain("не заданы переменные TOK");
    }
    const list = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n";
    const note = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n";
    const r = B.run(["mcp", "opencode", "Cloud/Acme/app", "elsewhere"], { stdin: init + note + list });
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    const [hello, tools] = replies(r.out);
    expect(hello.result.protocolVersion).toBe("2025-06-18");
    expect(hello.result.capabilities.tools).toEqual({});
    expect(tools).toEqual({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
  }, 120000);

  test("секрет появился у B — обёртки вместо причин, файл проекта тот же; пропал — снова причина", () => {
    const { A, B, app } = twoMachines();
    expectCode(A.run(["sync", app]), 0);
    const before = snap(app);
    expectCode(B.run(["sync", app]), 0);
    put(`${B.config}/local/secrets.env`, "TOK=token_value_123456\n");
    const b2 = B.run(["sync", app]);
    expect(b2.code).toBe(0);
    expect(changes(b2.out).filter((l) => !l.includes("/local/"))).toEqual([]);
    expect(snap(app)).toEqual(before);
    const names = () => runDir(B.config).map((p) => p.slice(p.lastIndexOf("/") + 1));
    expect(names().filter((n) => /^(gl|web)-.*\.json$/.test(n))).toEqual([]);
    expect(names().filter((n) => /^gl-stdio-.*\.(sh|cmd)$/.test(n)).length).toBe(3);
    put(`${B.config}/local/secrets.env`, "");
    expectCode(B.run(["sync", app]), 0);
    expect(snap(app)).toEqual(before);
    expect(names().filter((n) => /^(gl|web)-.*\.(sh|cmd)$/.test(n))).toEqual([]);
    expect(status(app)).toBe("");
  }, 120000);

  test("файл проекта одинаков на Windows, macOS и Linux при серверах с os: (порядок по слоям)", () => {
    const f = cliFixture();
    const target = { scope: "project" as const, dir: `${f.ws}/Org/p1`, rel: "Org/p1" };
    const s = (name: string, os?: Os[]) => ({ name, command: "echo", ...(os && { os }) });
    const layers = [
      { name: "l1", dir: "", exclude: [], instructions: [], skills: [], mcp: [s("mac", ["macos"]), s("all")] },
      { name: "l2", dir: "", exclude: [], instructions: [], skills: [], mcp: [s("win", ["windows"]), s("mac", ["macos", "linux"])] },
    ];
    const { merge } = require("../src/resolve") as typeof import("../src/resolve");
    const texts = (["windows", "macos", "linux"] as Os[]).map((os) => {
      const machine = { home: f.home, workspace: f.ws, os, vars: {} };
      const { result } = renderFor(ADAPTERS.codex, { cfg: merge(layers, os), target, title: "t" }, machine, {});
      return result.files.find((x) => x.path === ".codex/config.toml" && x.mode === "own")!;
    }).map((x) => (x.mode === "own" ? x.content : ""));
    expect(texts[1]).toBe(texts[0]);
    expect(texts[2]).toBe(texts[0]);
    expect(texts[0].indexOf('"mac"')).toBeLessThan(texts[0].indexOf('"all"'));
    expect(texts[0].indexOf('"all"')).toBeLessThan(texts[0].indexOf('"win"'));
  });

  test("HTTP с переменной машины в url — мостом через miksy, путь машины в файл проекта не попадает", () => {
    const f = cliFixture({ agents: ["codex"] });
    const dir = `${f.ws}/Org/p1`;
    put(`${f.config}/layers/tree/Org/mcp/loc.yaml`, "name: loc\nurl: https://example.invalid/${WORKSPACE}/mcp\n");
    expectCode(f.run(["sync", dir]), 0);
    const text = readFileSync(`${dir}/.codex/config.toml`, "utf8");
    expect(text).toContain('"mcp", "codex", "Org/p1", "loc", "--bridge"');
    expect(text).not.toContain(f.ws);
  }, 60000);
});

describe("11b-2: поправки рецензии", () => {
  const { merge } = require("../src/resolve") as typeof import("../src/resolve");
  const layer = (name: string, mcp: object[]) => ({ name, dir: "", exclude: [], instructions: [], skills: [], mcp }) as any;
  const codexFile = (f: ReturnType<typeof cliFixture>, layers: any[], os: Os, secrets: Record<string, string> = {}, rel = "Org/p1") => {
    const target = { scope: "project" as const, dir: `${f.ws}/${rel}`, rel };
    const machine = { home: f.home, workspace: f.ws, os, vars: {} };
    const r = renderFor(ADAPTERS.codex, { cfg: merge(layers, os), target, title: "t" }, machine, secrets);
    const file = r.result.files.find((x) => x.path === ".codex/config.toml" && x.mode === "own");
    return { ...r, text: file?.mode === "own" ? file.content : "" };
  };

  test("п. 1: сервер своей ОС, который обёртка .cmd не передаёт (\" в аргументе), — как есть, с заметкой", () => {
    const f = cliFixture();
    const r = codexFile(f, [layer("l1", [{ name: "q", command: "echo", args: ['a"b'], os: ["windows"] }])], "windows");
    expect(r.text).toContain('"command" = "echo"');
    expect(r.text).toContain('a\\"b');
    expect(r.result.warnings.join("\n")).toContain("mcp q:");
    expect(r.result.warnings.join("\n")).toContain("сервер записан в файл проекта как есть");
  });

  test("п. 2: одно имя без os: в одном слое и с os: в другом — файл одинаков на всех ОС", () => {
    const f = cliFixture();
    const layers = [layer("l1", [{ name: "x", command: "echo" }]), layer("l2", [{ name: "x", command: "echo", args: ["mac"], os: ["macos"] }])];
    const texts = (["windows", "macos", "linux"] as Os[]).map((os) => codexFile(f, layers, os).text);
    expect(texts[0]).toContain('"mcp", "codex", "Org/p1", "x"');
    expect(texts[1]).toBe(texts[0]);
    expect(texts[2]).toBe(texts[0]);
  });

  test("п. 3: непереносимый проект (папка «p (1)») — как раньше: без секрета — пропуск и keep, другой ОС — нет, своей ОС — как есть", () => {
    const f = cliFixture();
    const layers = [layer("l1", [
      { name: "sec", command: "echo", env: { TOKEN: "${TOK}" } },
      { name: "mine", command: "echo", os: [here] },
      { name: "theirs", command: "echo", os: [other] },
    ])];
    const r = codexFile(f, layers, here, {}, "Org/p (1)");
    expect(r.skipped.map((s) => s.name)).toEqual(["sec"]);
    expect(r.result.keep).toEqual(["sec"]);
    expect(r.result.warnings.join("\n")).toContain("пропущен сервер sec");
    expect(r.result.warnings.join("\n")).not.toContain("theirs");
    expect(r.text).not.toContain("theirs");
    expect(r.text).toContain('"command" = "echo"');
    expect(r.result.files.some((x) => x.base === "local" && x.path.endsWith(".json"))).toBe(false);
  });

  test("п. 5: HTTP без секретов и переменных с os: — как есть на любой ОС (вход агента в сервер сохраняется)", () => {
    const f = cliFixture();
    const layers = [layer("l1", [{ name: "web", url: "https://example.invalid/mcp", os: ["macos"] }, { name: "e", command: "echo" }])];
    const texts = (["windows", "macos", "linux"] as Os[]).map((os) => codexFile(f, layers, os).text);
    expect(texts[0]).toContain('"url" = "https://example.invalid/mcp"');
    expect(texts[1]).toBe(texts[0]);
    expect(texts[2]).toBe(texts[0]);
  });

  test("11b-3: одно имя — stdio для windows и HTTP для macos, или два разных HTTP — через miksy, файл одинаков на всех ОС", () => {
    const f = cliFixture();
    const cases = [
      [layer("l1", [{ name: "y", command: "echo", os: ["windows"] }]), layer("l2", [{ name: "y", url: "https://example.invalid/mcp", os: ["macos"] }])],
      [layer("l1", [{ name: "y", url: "https://a.invalid/mcp", os: ["windows"] }, { name: "y", url: "https://b.invalid/mcp", os: ["macos", "linux"] }])],
    ];
    for (const layers of cases) {
      const texts = (["windows", "macos", "linux"] as Os[]).map((os) => codexFile(f, layers, os).text);
      expect(texts[0]).toContain('"mcp", "codex", "Org/p1", "y"');
      expect(texts[0]).not.toContain("example.invalid");
      expect(texts[1]).toBe(texts[0]);
      expect(texts[2]).toBe(texts[0]);
    }
    // Одинаковое HTTP-определение в двух слоях для разных ОС — как есть
    const same = [layer("l1", [{ name: "y", url: "https://a.invalid/mcp", os: ["windows"] }]), layer("l2", [{ url: "https://a.invalid/mcp", name: "y", os: ["macos"] }])];
    const texts = (["windows", "macos", "linux"] as Os[]).map((os) => codexFile(f, same, os).text);
    expect(texts[0]).toContain('"url" = "https://a.invalid/mcp"');
    expect(texts[1]).toBe(texts[0]);
    expect(texts[2]).toBe(texts[0]);
  });

  test("raw агента с ${HOME} у сервера без секрета — как у работающего (файл тот же)", () => {
    const f = cliFixture();
    const layers = [layer("l1", [{ name: "sec", command: "echo", env: { TOKEN: "${TOK}" }, agents: { codex: { raw: { cwd: "${HOME}/w" } } } }])];
    const off = codexFile(f, layers, here);
    const on = codexFile(f, layers, here, { TOK: "token_value_123456" });
    expect(off.text).toContain(`${f.home}/w`);
    expect(off.text).toBe(on.text);
  });

  test("miksy mcp: последнее сообщение без перевода строки, ответы агента и пакет; причина и обёртка — верит более свежей", () => {
    const { B, app } = twoMachines();
    expectCode(B.run(["sync", app]), 0);
    const answer = JSON.stringify({ jsonrpc: "2.0", id: 7, result: {} }) + "\n";
    const batch = JSON.stringify([{ jsonrpc: "2.0", id: 8, method: "ping" }]) + "\n";
    const r = B.run(["mcp", "codex", "Cloud/Acme/app", "elsewhere"], { stdin: answer + batch + init.trimEnd() });
    expect(r.code).toBe(0);
    const out = replies(r.out);
    expect(out.map((m) => m.id)).toEqual([null, 1]);
    expect(out[0].error.code).toBe(-32600);
    expect(out[1].result.serverInfo.name).toBe("miksy");
    // Отказ: ответ агента не считается запросом — ошибка уходит на initialize
    const g = B.run(["mcp", "codex", "Cloud/Acme/app", "gl"], { stdin: answer + init.trimEnd() });
    expect([g.code, replies(g.out).map((m) => m.id)]).toEqual([1, [1]]);
    // Обёртка свежее причины (sync не смог удалить причину) — запускается обёртка
    const json = runDir(B.config).find((p) => /\/codex\/.*\/gl-stdio-.*\.json$/.test(p))!;
    const win = process.platform === "win32";
    const wrapper = json.replace(/\.json$/, win ? ".cmd" : ".sh");
    put(wrapper, win ? "@echo wrapper-ran\r\n" : "#!/bin/sh\necho wrapper-ran\n");
    if (!win) chmodSync(wrapper, 0o755);
    const past = new Date(Date.now() - 60000);
    utimesSync(json, past, past);
    const w = B.run(["mcp", "codex", "Cloud/Acme/app", "gl"], { stdin: "" });
    expect([w.code, w.out.trim()]).toEqual([0, "wrapper-ran"]);
    // Причина свежее — отказ
    utimesSync(wrapper, new Date(Date.now() - 120000), new Date(Date.now() - 120000));
    expect(B.run(["mcp", "codex", "Cloud/Acme/app", "gl"], { stdin: init }).code).toBe(1);
    // 11b-3: без --bridge, а на машине записан только мост (HTTP-вариант имени) — берётся он
    const web = B.run(["mcp", "codex", "Cloud/Acme/app", "web"], { stdin: init });
    expect(web.code).toBe(1);
    expect(web.err).toContain("MCP-сервер web на этой машине не запускается");
  }, 120000);
});
