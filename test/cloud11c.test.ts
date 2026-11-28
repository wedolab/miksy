// Круг 11c: сервер, ненужный на этой машине, — miksy mcp off <имя> (mcp_off в local/machine.yaml). В файле проекта
// (Codex, opencode, Antigravity) он тихий пустой сервер, если и так идёт через miksy; Claude, домашние настройки и
// непереносимые цели его не пишут; sync о нём не предупреждает; doctor — справочно
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { ADAPTERS, renderFor } from "../src/registry";
import { merge } from "../src/resolve";
import { rewriteList } from "../src/machinefile";
import { cliFixture, expectCode, put, textFiles, withShim } from "./helpers";
import { git, yamlRoots } from "./rootshelp";
import type { Machine, Os } from "../src/types";

const AGENTS = ["codex", "opencode", "antigravity"];
const here: Os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) + "\n";
const list = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n";
const replies = (out: string) => out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
const snap = (dir: string) => Object.fromEntries(textFiles(dir).filter((p) => !p.includes("/.git/")).map((p) => [p.slice(dir.length), readFileSync(p, "utf8")]));
void tmpdir;

function twoMachines() {
  const A = cliFixture({ agents: AGENTS, projects: ["Org/a1"] });
  const B = cliFixture({ agents: AGENTS, projects: ["Org/b1"] });
  const cloud = `${A.dir}/cloud`;
  git(`${cloud}/Acme/app`);
  for (const f of [A, B]) {
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: cloud, tree: "Cloud" }])}agents: [${AGENTS.join(", ")}]\n`);
    put(`${f.config}/layers/tree/Cloud/mcp/gl.yaml`, "name: gl\ncommand: echo\nenv:\n  TOKEN: ${TOK}\n");
    put(`${f.config}/layers/tree/Cloud/mcp/plain.yaml`, "name: plain\ncommand: echo\n");
    // Сервер с именем off: запуск агентом miksy mcp <агент> <место> off — не команда miksy mcp off
    put(`${f.config}/layers/tree/Cloud/mcp/off.yaml`, "name: off\ncommand: echo\nenv:\n  TOKEN: ${TOK}\n");
  }
  put(`${A.config}/local/secrets.env`, "TOK=token_value_123456\n");
  return { A, B, app: `${cloud}/Acme/app` };
}

describe("11c: miksy mcp off/on", () => {
  test("B выключает gl: файл проекта тот же, sync молчит, miksy mcp — пустой сервер; on — снова причина", () => {
    const { A, B, app } = twoMachines();
    expectCode(A.run(["sync", app]), 0);
    const afterA = snap(app);
    const off = B.run(["mcp", "off", "gl"]);
    expectCode(off, 0);
    expect(off.out).toContain("Сервер gl будет выключен на этой машине");
    expect(off.out).toContain("Дальше: miksy sync --global и miksy sync --all");
    expect(off.out).not.toContain("справка: у gl");
    expect(readFileSync(`${B.config}/local/machine.yaml`, "utf8")).toContain("mcp_off:\n  - gl\n");
    const b = B.run(["sync", app]);
    expectCode(b, 0);
    expect(b.out).not.toContain("mcp gl");
    expect(b.out).toContain("mcp off: на этой машине не запустится");
    expect(snap(app)).toEqual(afterA);
    const r = B.run(["mcp", "codex", "Cloud/Acme/app", "gl"], { stdin: init + list });
    expect([r.code, r.err]).toEqual([0, ""]);
    expect(replies(r.out)[1].result).toEqual({ tools: [] });
    // Список выключенных; повтор — ничего не меняется
    expect(B.run(["mcp", "off"]).out).toContain("Выключены на этой машине (1): gl");
    expect(B.run(["mcp", "off", "gl"]).out).toContain("уже выключен");
    // on — снова причина
    expectCode(B.run(["mcp", "on", "gl"]), 0);
    expect(readFileSync(`${B.config}/local/machine.yaml`, "utf8")).not.toContain("mcp_off");
    expect(B.run(["sync", app]).out).toContain("mcp gl: на этой машине не запустится");
    expect(B.run(["mcp", "codex", "Cloud/Acme/app", "gl"], { stdin: init }).code).toBe(1);
    expect(B.run(["mcp", "off"]).out).toContain("Выключенных MCP-серверов на этой машине нет");
  }, 120000);

  test("сервер с именем off: запуск агентом идёт в miksy mcp, а не в команду; --dry-run ничего не пишет", () => {
    const { B, app } = twoMachines();
    expectCode(B.run(["sync", app]), 0);
    const r = B.run(["mcp", "codex", "Cloud/Acme/app", "off"], { stdin: init });
    expect(r.code).toBe(1);
    expect(r.err).toContain("MCP-сервер off на этой машине не запускается");
    const before = readFileSync(`${B.config}/local/machine.yaml`, "utf8");
    const d = B.run(["mcp", "off", "off", "--dry-run"]);
    expectCode(d, 0);
    expect(d.out).toContain("--dry-run: ничего не записано");
    expect(readFileSync(`${B.config}/local/machine.yaml`, "utf8")).toBe(before);
    expect(B.run(["mcp", "on"]).code).toBe(2);
    expect(B.run(["mcp", "x"]).code).toBe(2);
  }, 120000);

  test("сервер без секретов и переменных: в файле проекта как есть, команда и doctor об этом говорят", () => {
    const { B, app } = twoMachines();
    const off = B.run(["mcp", "off", "plain"]);
    expect(off.out).toContain("справка: у plain нет секретов и переменных");
    expect(off.out).toContain("exclude: [mcp.plain]");
    expectCode(B.run(["sync", app]), 0);
    expect(readFileSync(`${app}/.codex/config.toml`, "utf8")).toContain('"command" = "echo"');
    const doc = B.run(["doctor"]);
    expect(doc.out).toContain("Серверы, которые на этой машине не запустятся");
    expect(doc.out).toMatch(/plain {2}выключен \(miksy mcp off\), но без секретов и переменных записан в файл проекта как есть/);
    expect(doc.out).toMatch(/gl {2}не заданы переменные TOK .*miksy mcp off gl/);
  }, 120000);

  test("doctor: выключенного имени нет в слоях — проблема с подсказкой miksy mcp on; выключенный сервер — справочно", () => {
    const { B, app } = twoMachines();
    withShim(B);
    expectCode(B.run(["mcp", "off", "gl"]), 0);
    expectCode(B.run(["mcp", "off", "off"]), 0);
    expectCode(B.run(["sync", "--all"]), 0);
    expectCode(B.run(["sync", "--global"]), 0);
    const ok = B.run(["doctor"]);
    expect(ok.out).toMatch(/gl {2}выключен \(miksy mcp off\) — пустой сервер/);
    expect(ok.out).not.toContain("Выключен сервер, которого нет в слоях");
    expect(ok.code).toBe(0);
    const typo = B.run(["mcp", "off", "gk"]);
    expect(typo.out).toContain("предупреждение: сервера gk нет ни в одном слое");
    const bad = B.run(["doctor"]);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("Выключен сервер, которого нет в слоях (1)");
    expect(bad.out).toContain("mcp_off: gk — такого сервера нет ни в одном слое; снять отметку — miksy mcp on gk");
    void app;
  }, 120000);

  test("Claude и домашние настройки: выключенный сервер не пишется, без предупреждения и keep", () => {
    const f = cliFixture({ agents: ["claude", "codex"] });
    const layer = { name: "l1", dir: "", exclude: [], instructions: [], skills: [], mcp: [{ name: "sec", command: "echo", env: { TOKEN: "${TOK}" } }, { name: "p", command: "echo" }] } as any;
    const machine: Machine = { home: f.home, workspace: f.ws, os: here, vars: {}, mcpOff: ["sec", "p"] };
    const project = { scope: "project" as const, dir: `${f.ws}/Org/p1`, rel: "Org/p1" };
    for (const [adapter, target] of [[ADAPTERS.claude, project], [ADAPTERS.codex, { scope: "global" as const }], [ADAPTERS.claude, { scope: "global" as const }]] as const) {
      const r = renderFor(adapter, { cfg: merge([layer], here), target, title: "t" }, machine, {});
      expect(r.skipped).toEqual([]);
      expect(r.missing).toEqual([]);
      expect(r.result.keep ?? []).toEqual([]);
      expect(r.result.warnings.join("\n")).not.toMatch(/\bsec\b/);
      expect(r.cfg.mcp.map((s) => s.item.name)).toEqual([]);
    }
  });
});

describe("11c: правка mcp_off строками", () => {
  test("комментарии, BOM, CRLF и другие ключи — как были; пустой список убирает ключ", () => {
    const src = "workspace: D:/w\nmcp_off:\n  - a # почему\n  - b\nagents: [codex]\n";
    expect(rewriteList(src, "mcp_off", ["a"])).toBe("workspace: D:/w\nmcp_off:\n  - a # почему\nagents: [codex]\n");
    expect(rewriteList(src, "mcp_off", ["a", "b", "on"])).toBe("workspace: D:/w\nmcp_off:\n  - a # почему\n  - b\n  - \"on\"\nagents: [codex]\n");
    expect(rewriteList(src, "mcp_off", [])).toBe("workspace: D:/w\nagents: [codex]\n");
    expect(rewriteList("\uFEFFworkspace: D:/w\r\nmcp_off: [a, b] # мои\r\n", "mcp_off", ["b"])).toBe("\uFEFFworkspace: D:/w\r\nmcp_off: # мои\r\n  - b\r\n");
    expect(rewriteList("workspace: D:/w", "mcp_off", ["x"])).toBe("workspace: D:/w\nmcp_off:\n  - x\n");
    expect(rewriteList("workspace: D:/w\n", "mcp_off", [])).toBe("workspace: D:/w\n");
  });

  test("11c-2: имена-числа — в кавычках; ключ в кавычках находится; непонятная форма — отказ, а не второй ключ", () => {
    expect(rewriteList("workspace: D:/w\n", "mcp_off", ["123", "1e3", "0x1F", "07", "_a"])).toBe('workspace: D:/w\nmcp_off:\n  - "123"\n  - "1e3"\n  - "0x1F"\n  - "07"\n  - _a\n');
    expect(rewriteList('workspace: D:/w\n"mcp_off": [a]\n', "mcp_off", ["a", "b"])).toBe("workspace: D:/w\nmcp_off:\n  - a\n  - b\n");
    expect(rewriteList("workspace: D:/w\n'mcp_off':\n  - a\n", "mcp_off", [])).toBe("workspace: D:/w\n");
    expect(() => rewriteList("workspace: D:/w\n? mcp_off\n: [a]\n", "mcp_off", ["a", "b"])).toThrow("mcp_off не изменить строками");
  });

  test("11c-2: лишний аргумент — ошибка команды; mcp_off не того вида — подсказка исправить файл", () => {
    const f = cliFixture({ agents: ["codex"] });
    const extra = f.run(["mcp", "off", "gl", "лишнее"]);
    expect(extra.code).toBe(2);
    expect(extra.err).toContain("лишние аргументы для mcp: лишнее");
    put(`${f.config}/local/machine.yaml`, `workspace: ${f.ws}\nagents: [codex]\nmcp_off: gl\n`);
    const bad = f.run(["mcp", "off"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("mcp_off — список имён MCP-серверов");
    expect(bad.err).toContain("Исправьте эти строки в файлах вручную");
    expect(bad.err).not.toContain("miksy mcp");
  });
});
