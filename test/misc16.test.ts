// Мелкие пункты фазы 1.6: С16, С18, С19, С20, С24, С25, С26
import { expect, test } from "bun:test";
import { existsSync, rmSync, symlinkSync } from "node:fs";
import { gitEnv } from "../src/git";
import { homeDir } from "../src/paths";
import { ADAPTERS, renderFor } from "../src/registry";
import { compare } from "../src/sync";
import { cliFixture, put, expectCode } from "./helpers";

const none = { layers: [], instructions: [], skills: [], notes: [], mcp: [] };
const secretMcp = { layer: "x", item: { name: "s", command: "echo", env: { TOKEN: "${TOKEN}" } } };
const machineOf = (f: { home: string; ws: string }) => ({ home: f.home, workspace: f.ws, os: "linux" as const, vars: {} });

test("С16: сервер без секрета в проекте Codex/Antigravity записан через miksy, на этой машине — причина (круг 11b)", () => {
  const f = cliFixture();
  const target = { scope: "project" as const, dir: `${f.ws}/Org/p1`, rel: "Org/p1" };
  for (const id of ["codex", "antigravity"]) {
    const { result, skipped } = renderFor(ADAPTERS[id], { cfg: { ...none, mcp: [secretMcp] }, target, title: "t" }, machineOf(f), {});
    expect(skipped).toEqual([]);
    const reason = result.files.find((x) => x.base === "local" && x.path.endsWith(".json"));
    expect(reason?.mode === "own" && reason.content).toContain("не заданы переменные TOKEN");
    expect(result.files.some((x) => x.base === "local" && /\.(sh|cmd)$/.test(x.path))).toBe(false);
    const project = result.files.filter((x) => x.base === "project" && x.mode === "own").map((x) => (x.mode === "own" ? x.content : "")).join("\n");
    expect(project).toContain('"mcp"');
    expect(project).toContain("Org/p1");
  }
});

test("С18: compare маскирует старый секрет в пути URL по шаблону слоя", () => {
  const cfg = { ...none, mcp: [{ layer: "x", item: { name: "zap", url: "https://a.example.com/mcp/<secret:ZAP_KEY>/sse" } }] };
  const current = { instructionFiles: [], mcp: { zap: { source: "home", def: { type: "http", url: "https://a.example.com/mcp/oldZapPathKey987654/sse" } } } };
  const text = compare(ADAPTERS.claude, cfg, current, undefined, { ZAP_KEY: "newZapPathKey123456" }).join("\n");
  expect(text).not.toContain("oldZapPathKey987654");
  expect(text).toContain("<secret>");
  const same = { instructionFiles: [], mcp: { zap: { source: "home", def: { type: "http", url: "https://a.example.com/mcp/newZapPathKey123456/sse" } } } };
  expect(compare(ADAPTERS.claude, cfg, same, undefined, { ZAP_KEY: "newZapPathKey123456" }).join("\n")).toContain("= zap");
});

test("С19: пустой ~/.gemini/config/mcp_config.json — глобальные MCP пишутся (как в {})", () => {
  const f = cliFixture();
  put(`${f.home}/.gemini/config/mcp_config.json`, "");
  const cfg = { ...none, mcp: [{ layer: "x", item: { name: "plain", command: "echo" } }] };
  const { result } = renderFor(ADAPTERS.antigravity, { cfg, target: { scope: "global" }, title: "t" }, machineOf(f), {});
  expect(result.files.some((x) => x.path === ".gemini/config/mcp_config.json")).toBe(true);
  expect(result.warnings.join("\n")).not.toContain("не парсится");
});

test("С20: gitEnv убирает переменные репо и индекса, но оставляет GIT_CONFIG_*", () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { GIT_DIR: "/x", GIT_INDEX_FILE: "/y", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*" });
    const env = gitEnv() as Record<string, string | undefined>;
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_INDEX_FILE).toBeUndefined();
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("safe.directory");
  } finally { process.env = saved; }
});

test("С24: sync --out передаёт keep — own-файл с пропущенным сервером есть в песочнице", () => {
  const f = cliFixture({ agents: ["codex"] });
  const dir = `${f.ws}/Org/p1`;
  rmSync(`${f.config}/layers/tree/instructions`, { recursive: true });
  put(`${f.config}/layers/tree/mcp/s.yaml`, 'name: s\ncommand: echo\nenv: {TOKEN: "${TOKEN}"}\n');
  put(`${f.config}/local/secrets.env`, "TOKEN=opaque-test-secret\n");
  expectCode(f.run(["sync", dir]), 0);
  put(`${f.config}/local/secrets.env`, "");
  const out = `${f.dir}/sandbox`;
  expectCode(f.run(["sync", dir, "--out", out]), 0);
  expect(existsSync(`${out}/codex/project/.codex/config.toml`)).toBe(true);
}, 60000);

test("С25: нет map.yaml — сообщение «файла нет», а не «YAML не разбирается»", () => {
  const f = cliFixture();
  rmSync(`${f.config}/map.yaml`);
  const r = f.run(["sync", "--all", "--dry-run"]);
  expect(r.err).toContain("файла нет");
  expect(r.err).not.toContain("не разбирается");
});

test("С17: глобальный skill через ссылку ~/.claude — не «не от miksy»", () => {
  const f = cliFixture();
  put(`${f.config}/layers/global/skills/my-mine/SKILL.md`, "---\nname: my-mine\ndescription: x\n---\n");
  put(`${f.home}/dotfiles/claude/keep`, "");
  symlinkSync(`${f.home}/dotfiles/claude`, `${f.home}/.claude`, process.platform === "win32" ? "junction" : "dir");
  expectCode(f.run(["sync", "--global"]), 0);
  expect(f.run(["doctor"]).out).not.toContain("не от miksy");
}, 60000);

test("С26: битая ссылка в HOME — понятная ошибка про домашний каталог", () => {
  const f = cliFixture();
  const link = `${f.dir}/broken-home`;
  symlinkSync(`${f.dir}/missing`, link, process.platform === "win32" ? "junction" : "dir");
  const saved = { ...process.env };
  try {
    process.env.HOME = process.env.USERPROFILE = `${link}/sub`;
    expect(() => homeDir()).toThrow(/домашний каталог/);
  } finally { process.env = saved; }
});
