// Экранирование в сгенерированных скриптах (Ф4, Ф5, Ф13): строка-команда helper-а выполняется той же
// строкой и тем же shell, что у агента (Claude — shell: true, Codex — sh -c / %COMSPEC% /Q /D /C "…");
// заголовок-комментарий sh; .cmd при включённом отложенном раскрытии; секрет CP и служебные переменные.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLauncher } from "../src/launch";
import { ENGINE } from "../src/load";
import type { Target } from "../src/adapter";
import { secretRef } from "../src/vars";

const win = process.platform === "win32";
const os = win ? "windows" : process.platform === "darwin" ? "macos" : "linux";
const TOK = "tok_A1b2-C3d4.E5f6_G7h8";
const CP = "65001 & echo PROBE-CP";
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function box(name: string, target: Target = { scope: "global" }) {
  const root = mkdtempSync(join(tmpdir(), "esc-")).replaceAll("\\", "/");
  roots.push(root);
  const local = `${root}/${name}/local`;
  mkdirSync(`${local}/secrets`, { recursive: true });
  writeFileSync(`${local}/secrets/TOK`, TOK + "\n");
  writeFileSync(`${local}/secrets/CP`, CP + "\n");
  const launcher = createLauncher({ os, local, agent: "codex", target, bun: process.execPath, engine: ENGINE });
  const materialize = () => {
    for (const f of launcher.files()) {
      if (f.mode !== "own") continue;
      const p = `${local}/${f.path}`;
      mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true });
      writeFileSync(p, f.content, { mode: 0o700 });
    }
  };
  return { root, local, launcher, materialize };
}

// Как агент выполняет строку-команду helper-а
function agentShell(cmd: string, cwd: string): { claude: string; codex: string } {
  const claude = spawnSync(cmd, { shell: true, cwd, encoding: "utf8" }).stdout;
  const codex = win
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/Q", "/D", "/C", `"${cmd}"`], { cwd, encoding: "utf8", windowsVerbatimArguments: true }).stdout
    : spawnSync("/bin/sh", ["-c", cmd], { cwd, encoding: "utf8" }).stdout;
  return { claude, codex };
}

const DIRS = win
  ? ["R&D конфиг", "100%PATH%x", "x!PATH!y", "c^d (1)", "a;b,c=d"]
  : ["o'brien cfg", "cfg $(touch PROBE)", "cfg `touch PROBE`", "R&D; touch PROBE", "x\"y"];

describe("helper: строка-команда для shell агента", () => {
  for (const dir of DIRS) test(`путь «${dir}» — данные, не код`, () => {
    const b = box(dir);
    const cmd = b.launcher.helper({ name: "h", url: "u", headers: { Authorization: `Bearer ${secretRef("TOK")}`, "X-Static": "a&b %PATH% !x! ^" } });
    b.materialize();
    const cwd = mkdtempSync(join(tmpdir(), "esc-cwd-"));
    roots.push(cwd);
    for (const [agent, out] of Object.entries(agentShell(cmd, cwd))) {
      expect({ agent, json: JSON.parse(out.trim().split(/\r?\n/).pop() || "null") }).toEqual({ agent, json: { Authorization: `Bearer ${TOK}`, "X-Static": "a&b %PATH% !x! ^" } });
    }
    expect(existsSync(join(cwd, "PROBE"))).toBe(false);
  }, 30000);

  test.skipIf(!win)("Windows: секрет CP не путается с сохранённой кодовой страницей; страница восстанавливается", () => {
    const b = box("п р конфиг");
    const cmd = b.launcher.helper({ name: "h", url: "u", headers: { "X-CP": secretRef("CP"), A: secretRef("TOK") } });
    b.materialize();
    // Как в launch.test.ts: страница консоли до и после вызова helper-а (путь с кириллицей — chcp 65001 внутри)
    const driver = `${b.root}/driver.cmd`;
    writeFileSync(driver, `@echo off\r\nchcp\r\ncall ${cmd}\r\nchcp\r\n`, "utf8");
    const r = Bun.spawnSync(["cmd.exe", "/d", "/c", driver], { stdout: "pipe", stderr: "pipe" });
    const out = r.stdout.toString();
    expect(out).not.toContain("PROBE-CP\r\n");
    const lines = out.split(/\r?\n/).filter(Boolean);
    expect(JSON.parse(lines[1])).toEqual({ "X-CP": CP, A: TOK });
    expect(lines[2]).toBe(lines[0]);
    expect(lines.length).toBe(3);
  }, 30000);
});

describe("обёртки: комментарий sh и отложенное раскрытие cmd", () => {
  test("перевод строки в имени каталога проекта и сервера не становится командой sh", () => {
    const dir = "/ws/Org/x\ntouch INJECTED #";
    const l = createLauncher({ os: "linux", local: "/c/local", agent: "claude", target: { scope: "project", dir, rel: "Org/x\ntouch INJECTED #", nested: false, git: true }, bun: "bun", engine: "/e" });
    l.stdio({ name: "s\ntouch INJECTED2 #", command: "echo", env: { A: secretRef("TOK") } });
    l.helper({ name: "h\ntouch INJECTED3 #", url: "u", headers: { A: secretRef("TOK") } });
    for (const f of l.files()) {
      const lines = (f as { content: string }).content.split("\n");
      expect(lines.filter((x) => /^\s*touch/.test(x))).toEqual([]);
    }
  });

  test.skipIf(!win)("Windows: .cmd-обёртка и helper не теряют ! при включённом отложенном раскрытии (/V:ON)", () => {
    const b = box("конфиг");
    const echo = `${b.root}/echo.ts`;
    writeFileSync(echo, `console.log(JSON.stringify({ argv: process.argv.slice(2), A: process.env.A ?? null }));`);
    const path = b.launcher.stdio({ name: "s", command: process.execPath, args: [echo, "a!b!c", `x!${secretRef("TOK")}`], env: { A: `!PATH! ${secretRef("TOK")}` } });
    const helper = b.launcher.helper({ name: "h", url: "u", headers: { A: `!x! ${secretRef("TOK")}` } });
    b.materialize();
    const r = Bun.spawnSync(["cmd.exe", "/V:ON", "/d", "/c", path], { stdout: "pipe", stderr: "pipe" });
    expect(JSON.parse(r.stdout.toString())).toEqual({ argv: ["a!b!c", `x!${TOK}`], A: `!PATH! ${TOK}` });
    const h = spawnSync("cmd.exe", ["/V:ON", "/Q", "/D", "/C", `"${helper}"`], { encoding: "utf8", windowsVerbatimArguments: true });
    expect(JSON.parse(h.stdout.trim())).toEqual({ A: `!x! ${TOK}` });
  }, 30000);
});
