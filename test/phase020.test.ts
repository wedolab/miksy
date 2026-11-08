// Фаза 0.2.0, кроме корней (test/roots.test.ts): opencode 1.x от официального установщика, подсказка
// call_mcp_tool для Antigravity, PATH по содержимому rc-файла, идентификатор агента gemini → antigravity
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { antigravity, mcpHint } from "../adapters/antigravity";
import { environment, opencodeMajor } from "../src/environ";
import { canonical } from "../src/paths";
import { rcAddsDir } from "../src/setup";
import type { Machine, Resolved } from "../src/types";
import { cliFixture, put } from "./helpers";

const win = process.platform === "win32";
const os = win ? "windows" as const : process.platform === "darwin" ? "macos" as const : "linux" as const;
const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");

describe("opencode, поставленный официальным установщиком (~/.opencode/bin)", () => {
  test("рядом нет команды opencode2 — 1.x (установщик 1.x её не пишет), есть скрипт opencode2 — 2.x; opencode не запускается", () => {
    const dir = canonical(mkdtempSync(join(tmpdir(), "oc-")));
    const bin = `${dir}/home/.opencode/bin`;
    const exe = `${bin}/${win ? "opencode.exe" : "opencode"}`;
    // Не программа: если бы проверка её запустила, она бы упала
    put(exe, "not a program\n");
    const notes = () => environment({ env: { PATH: bin }, home: `${dir}/home`, os, bun: process.execPath, agents: ["opencode"], engine: `${dir}/engine`, config: `${dir}/config` });
    expect(opencodeMajor(exe)).toBe(1);
    expect(notes()).toEqual([`opencode ~/.opencode/bin/${win ? "opencode.exe" : "opencode"} — версия 1.x, а miksy пишет настройки в формате opencode 2.x: обновите opencode`]);
    // Установщик 2.x: команда совместимости opencode2 — скрипт, запускающий opencode рядом
    const shim = `${bin}/${win ? "opencode2.cmd" : "opencode2"}`;
    put(shim, win ? '@echo off\r\n"%~dp0opencode.exe" %*\r\nexit /b %errorlevel%\r\n' : '#!/bin/sh\nexec "$(dirname "$0")/opencode" "$@"\n');
    expect(opencodeMajor(exe)).toBe(2);
    expect(notes()).toEqual([]);
    // opencode2 — сама программа (так раньше ставили 2.x рядом с 1.x): opencode — 1.x
    put(shim, "x".repeat(8192));
    expect(opencodeMajor(exe)).toBe(1);
    // Другое место — по-прежнему неизвестно
    put(`${dir}/other/${win ? "opencode.exe" : "opencode"}`, "x");
    expect(opencodeMajor(`${dir}/other/${win ? "opencode.exe" : "opencode"}`)).toBeNull();
  });
});

describe("Antigravity: подсказка call_mcp_tool в правилах плагина", () => {
  const box = () => {
    const dir = canonical(mkdtempSync(join(tmpdir(), "agy-hint-")));
    put(`${dir}/rule.md`, "# Rule A\n");
    const machine: Machine = { home: `${dir}/home`, workspace: dir, os, vars: {} };
    const target = { scope: "project" as const, dir: `${dir}/p`, rel: "p" };
    const cfg = (instructions: boolean, mcp: string[]): Resolved => ({
      layers: ["workspace"], skills: [], notes: [],
      instructions: instructions ? [{ item: { file: "rule.md", path: `${dir}/rule.md` }, layer: "workspace" }] : [],
      mcp: mcp.map((name) => ({ item: { name, command: "npx", args: [name] }, layer: "workspace" })),
    });
    const rules = (c: Resolved) => antigravity.render(c, target, machine).files.find((f) => f.path === ".agents/plugins/miksy/rules/AGENTS.md")?.content;
    return { machine, cfg, rules };
  };

  test("у цели с MCP — подсказка с именами miksy_<имя> после правил; без MCP — нет; MCP без правил — файл правил с одной подсказкой", () => {
    const b = box();
    const withMcp = b.rules(b.cfg(true, ["gitlab", "context7"]))!;
    expect(withMcp).toContain("# Rule A\n\n## MCP-серверы проекта (Antigravity)");
    expect(withMcp).toContain("вызываются через `call_mcp_tool`, имя сервера — `miksy_<имя>`: `miksy_context7`, `miksy_gitlab`.");
    expect(mcpHint(["x"])).toContain("`miksy_x`");
    expect(b.rules(b.cfg(true, []))).not.toContain("call_mcp_tool");
    const onlyMcp = b.rules(b.cfg(false, ["context7"]))!;
    expect(onlyMcp).toContain(mcpHint(["context7"]));
    expect(onlyMcp).not.toContain("# Rule A");
    expect(b.rules(b.cfg(false, []))).toBeUndefined();
    // Глобальные правила (~/.gemini/GEMINI.md) — без подсказки: она о плагине проекта
    const global = antigravity.render(b.cfg(true, ["context7"]), { scope: "global" }, b.machine).files.find((f) => f.path === ".gemini/GEMINI.md");
    expect(global && "content" in global ? global.content : "").not.toContain("call_mcp_tool");
  });
});

describe("PATH в rc-файле оболочки", () => {
  test("строки установщика Bun ($BUN_INSTALL/bin), $HOME, ~, fish_add_path — каталог уже прописан; комментарий и чужой каталог — нет", () => {
    const home = "/home/u", dir = "/home/u/.bun/bin";
    expect(rcAddsDir('# bun\nexport BUN_INSTALL="$HOME/.bun"\nexport PATH="$BUN_INSTALL/bin:$PATH"\n', dir, home)).toBe(true);
    expect(rcAddsDir('export PATH="${HOME}/.bun/bin:$PATH"\n', dir, home)).toBe(true);
    expect(rcAddsDir("PATH=~/.bun/bin/:$PATH\n", dir, home)).toBe(true);
    expect(rcAddsDir("fish_add_path /home/u/.bun/bin\n", dir, home)).toBe(true);
    expect(rcAddsDir('# export PATH="$HOME/.bun/bin:$PATH"\nexport PATH="$HOME/bin:$PATH"\n', dir, home)).toBe(false);
    // Переменная не задана в файле — неизвестно, куда ведёт
    expect(rcAddsDir('export PATH="$BUN_INSTALL/bin:$PATH"\n', dir, home)).toBe(false);
  });
});

// Учёт и файлы, какими их оставил бы движок до 0.2.0 (агент gemini): из записанного новым движком —
// записи учёта gemini|…, обёртки в local/run/gemini/, блок miksy:gemini в .git/info/exclude
function asBefore020(f: ReturnType<typeof cliFixture>) {
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const swap = (s: string) => s.replaceAll("/local/run/antigravity/", "/local/run/gemini/").replaceAll("\\\\local\\\\run\\\\antigravity\\\\", "\\\\local\\\\run\\\\gemini\\\\");
  const state = `${f.config}/local/state/manifest.json`;
  const manifest = JSON.parse(read(state));
  const files = [`${f.ws}/Org/p1/.agents/plugins/miksy/mcp_config.json`, `${f.home}/.gemini/config/mcp_config.json`, `${f.home}/.gemini/antigravity-ide/mcp_config.json`];
  for (const p of files) writeFileSync(p, swap(read(p)));
  renameSync(`${f.config}/local/run/antigravity`, `${f.config}/local/run/gemini`);
  const targets: Record<string, any> = {};
  for (const [id, st] of Object.entries<any>(manifest.targets)) {
    const files2: Record<string, string> = {};
    for (const [p, h] of Object.entries<string>(st.files)) {
      const q = swap(p);
      files2[q] = files.includes(p) ? sha(read(p)) : h;
    }
    targets[id.replace(/^antigravity\|/, "gemini|")] = { ...st, files: files2 };
  }
  writeFileSync(state, JSON.stringify({ ...manifest, targets }, null, 2));
  const ex = `${f.ws}/Org/p1/.git/info/exclude`;
  writeFileSync(ex, read(ex).replaceAll("miksy:antigravity", "miksy:gemini"));
  put(`${f.config}/local/machine.yaml`, read(`${f.config}/local/machine.yaml`).replace("antigravity", "gemini"));
}

describe("агент antigravity (прежнее имя gemini — синоним)", () => {
  test("старая конфигурация и учёт: sync после обновления не считает записанное чужим, переносит учёт, обёртки и блок exclude; doctor подсказывает", () => {
    const f = cliFixture({ agents: ["antigravity"] });
    put(`${f.config}/layers/global/mcp/s.yaml`, "name: s\ncommand: echo\nenv:\n  T: ${TOK}\n");
    put(`${f.config}/layers/tree/mcp/p.yaml`, "name: p\ncommand: echo\nenv:\n  T: ${TOK}\n");
    put(`${f.config}/layers/tree/mcp/skipped.yaml`, "name: skipped\ncommand: echo\nagents:\n  gemini: skip\n");
    put(`${f.config}/local/secrets.env`, "TOK=artificial-token-1234\n");
    expect(f.run(["sync", "--global"]).code).toBe(0);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(f.run(["doctor"]).out).toContain("Всё синхронизировано");
    // agents: { gemini: skip } в слое — тот же агент
    expect(JSON.parse(read(`${f.ws}/Org/p1/.agents/plugins/miksy/mcp_config.json`)).mcpServers.skipped).toBeUndefined();
    asBefore020(f);

    const d = f.run(["doctor"]);
    expect(d.out).not.toContain("создан не miksy");
    expect(d.out).not.toContain("Конфликты первого sync");
    expect(d.out).toContain("Устарело");
    expect(d.out).toContain("Прежнее имя агента (2) — работает, но лучше переименовать: gemini теперь antigravity");
    expect(d.out).toContain("local/machine.yaml: agents — gemini → antigravity");
    expect(d.out).toContain("layers/tree/mcp/skipped.yaml: agents.gemini → agents.antigravity");

    for (const args of [["--global"], ["--all", "--yes"]]) {
      const r = f.run(["sync", ...args]);
      expect(r.code).toBe(0);
      expect(r.out).not.toMatch(/КОНФЛИКТ/);
    }
    const manifest = JSON.parse(read(`${f.config}/local/state/manifest.json`));
    expect(Object.keys(manifest.targets).some((id) => id.startsWith("gemini|"))).toBe(false);
    expect(Object.keys(manifest.targets).filter((id) => id.startsWith("antigravity|")).length).toBe(2);
    expect(existsSync(`${f.config}/local/run/gemini`)).toBe(false);
    expect(readdirSync(`${f.config}/local/run/antigravity`).length).toBeGreaterThan(0);
    expect(read(`${f.ws}/Org/p1/.agents/plugins/miksy/mcp_config.json`)).toMatch(/run[\\/]+antigravity/);
    expect(read(`${f.home}/.gemini/config/mcp_config.json`)).toMatch(/run[\\/]+antigravity/);
    const ex = read(`${f.ws}/Org/p1/.git/info/exclude`);
    expect(ex).toContain("# >>> miksy:antigravity");
    expect(ex).not.toContain("miksy:gemini");
    const after = f.run(["doctor"]).out;
    expect(after).toContain("Всё синхронизировано");
    // --agent gemini — тот же агент
    expect(f.run(["sync", "--all", "--agent", "gemini", "--dry-run"]).out).toContain("Org/p1: изменений нет");
  }, 120000);
});
