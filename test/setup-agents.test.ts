// setup и агенты: команда в PATH или только каталог настроек; новый агент при повторном setup
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cliFixture, put } from "./helpers";
import { detectAgents } from "../src/setup";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const win = process.platform === "win32";

// Поддельная команда агента в отдельном каталоге PATH
function fakeCommand(dir: string, name: string) {
  const file = win ? `${dir}/${name}.cmd` : `${dir}/${name}`;
  put(file, win ? "@echo off\r\n" : "#!/bin/sh\n");
  if (!win) chmodSync(file, 0o755);
}

function setup(f: ReturnType<typeof cliFixture>, path: string) {
  const r = Bun.spawnSync([process.execPath, CLI, "setup", "--yes"], {
    cwd: f.dir,
    env: { ...process.env, MIKSY_CONFIG: f.config, HOME: f.home, USERPROFILE: f.home, BUN_INSTALL: `${f.dir}/bun`, PATH: path },
    stdout: "pipe",
    stderr: "pipe",
  });
  return r.stdout.toString() + r.stderr.toString();
}

describe("setup: какие агенты настраивать", () => {
  test("detectAgents: команда в PATH — найден; нет команды, но есть каталог настроек — отдельно", () => {
    const f = cliFixture();
    mkdirSync(`${f.home}/.claude`, { recursive: true });
    mkdirSync(`${f.home}/.config/opencode`, { recursive: true });
    const which = (c: string) => (c === "codex" ? "/bin/codex" : null);
    const r = detectAgents(f.home, which);
    expect(r.inPath).toEqual(["codex"]);
    expect(r.dirOnly.map((d) => d.id)).toEqual(["claude", "opencode"]);
    expect(r.dirOnly[0].dir).toContain(".claude");
  });

  test("агент только с каталогом настроек: без вопроса (--yes) не добавляется, подсказка — как добавить", () => {
    const f = cliFixture();
    rmSync(`${f.config}/local/machine.yaml`);
    mkdirSync(`${f.home}/.claude`, { recursive: true });
    const out = setup(f, "");
    expect(out).toMatch(/claude: команды нет в PATH, но есть .*\.claude/);
    expect(readFileSync(`${f.config}/local/machine.yaml`, "utf8")).toMatch(/^agents: \[\]$/m);
  }, 30000);

  test("повторный setup: новый агент в PATH добавляется в agents, остальное в machine.yaml не меняется", () => {
    const f = cliFixture({ agents: ["claude"] });
    const machine = `${f.config}/local/machine.yaml`;
    put(machine, readFileSync(machine, "utf8") + "# моя заметка\nvars:\n  CUSTOM: \"x\"\n");
    const before = readFileSync(machine, "utf8");
    const bin = `${f.dir}/bin`;
    fakeCommand(bin, "claude");
    fakeCommand(bin, "codex");
    const out = setup(f, bin);
    expect(out).toContain("codex");
    const after = readFileSync(machine, "utf8");
    expect(after).toMatch(/^agents: \[claude, codex\]$/m);
    expect(after.replace(/^agents: .*$/m, "")).toBe(before.replace(/^agents: .*$/m, ""));
  }, 30000);
});
