// Окружение машины (src/environ.ts): несколько установок программ, переменные каталогов настроек
// агентов, конфигурация не рядом с движком — сообщения doctor («Справочно») и мастера setup
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunPlaces, environment, installs, opencodeMajor } from "../src/environ";
import { canonical } from "../src/paths";
import { cliFixture, CLI, put } from "./helpers";

const win = process.platform === "win32";
const os = win ? "windows" as const : process.platform === "darwin" ? "macos" as const : "linux" as const;
const exe = (name: string) => (win ? `${name}.exe` : name);
const sep = win ? ";" : ":";

function box() {
  const dir = canonical(mkdtempSync(join(tmpdir(), "environ-")));
  const home = `${dir}/home`;
  mkdirSync(home, { recursive: true });
  const prog = (where: string, name: string, text = "") => { put(`${dir}/${where}/${name}`, text); return `${dir}/${where}/${name}`; };
  const engine = `${dir}/engine/miksy`;
  mkdirSync(engine, { recursive: true });
  // Только то, что положил тест: PATH из каталогов песочницы, Bun — свой
  const bun = prog("bun1", exe("bun"));
  const input = (env: Record<string, string | undefined>, agents: string[] = ["claude", "codex", "opencode", "gemini"]) =>
    environment({ env, home, os, bun, agents, engine, config: `${dir}/config` });
  return { dir, home, prog, bun, engine, input, path: (...ds: string[]) => ds.map((d) => `${dir}/${d}`).join(sep) };
}

describe("окружение: несколько установок", () => {
  test("ничего лишнего — сообщений нет", () => {
    const b = box();
    b.prog("a", exe("node"));
    b.prog("a", exe("claude"));
    expect(b.input({ PATH: b.path("a", "bun1", "a") })).toEqual([]);
  });

  test("две установки в PATH — какая используется (первая) и где ещё; один каталог дважды — одна", () => {
    const b = box();
    const first = b.prog("p1", exe("claude"));
    const second = b.prog("p2", exe("claude"));
    b.prog("n1", exe("node"));
    const notes = b.input({ PATH: b.path("p1", "n1", "p1", "p2") });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toBe(`Claude Code: установок несколько — используется ${first} (первая в PATH), ещё: ${second}. Лучше оставить одну (агенты и терминал могут запускать разные; обновляются они по отдельности) — лишние удалите сами`);
    expect(installs(["claude"], { PATH: b.path("p1", "p2") }, os)).toEqual([first, second]);
  });

  test("Bun: используется тот, которым запущен miksy, — даже если в PATH другой; ~/.bun/bin вне PATH тоже считается", () => {
    const b = box();
    const other = b.prog("home/.bun/bin", exe("bun"));
    const notes = b.input({ PATH: b.path("x") });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toStartWith(`Bun: установок несколько — используется ${b.bun}, ещё: ~/.bun/bin/${exe("bun")}.`);
    expect(notes[0]).toContain("этот Bun запоминают команда miksy и обёртки MCP-серверов");
    expect(other).toContain(".bun/bin");
    // Вне PATH — только каталог официального установщика от HOME/BUN_INSTALL: Homebrew, scoop и т. п.
    // не ищутся (программу оттуда никто не запускает), результат не зависит от того, что стоит на машине
    expect(bunPlaces({ BUN_INSTALL: "/opt/bun" }, "/Users/u", "macos")).toEqual([join("/opt/bun", "bin", "bun"), join("/Users/u", ".bun", "bin", "bun")]);
    expect(bunPlaces({}, "C:/Users/u", "windows")).toEqual([join("C:/Users/u", ".bun", "bin", "bun.exe"), join("C:/Users/u", ".bun", "bin", "bun.exe")]);
  });

  test.if(win)("Windows: псевдонимы Microsoft\\WindowsApps (python.exe магазина) — не установки; .cmd и без расширения в одном каталоге — одна", () => {
    const b = box();
    b.prog("Microsoft/WindowsApps", "python.exe");
    b.prog("py", "python.exe");
    b.prog("npm", "opencode");
    b.prog("npm", "opencode.cmd", "node_modules\\@opencode\\cli\\bin\\opencode.exe %*");
    expect(b.input({ Path: b.path("Microsoft/WindowsApps", "py", "npm") })).toEqual([]);
  });

  test.if(!win)("ссылка на ту же программу (Homebrew) — одна установка", () => {
    const b = box();
    const real = b.prog("Cellar/node/22/bin", "node");
    mkdirSync(`${b.dir}/brew`, { recursive: true });
    symlinkSync(real, `${b.dir}/brew/node`);
    expect(b.input({ PATH: b.path("brew", "Cellar/node/22/bin") })).toEqual([]);
  });

  test("opencode: версия по пакету (opencode-ai — 1.x, @opencode/cli — 2.x), иначе неизвестна (opencode не запускается); 1.x — сообщение", () => {
    const b = box();
    const v1 = b.prog("o1", win ? "opencode.cmd" : "opencode", "#!/bin/sh\nexec node /usr/lib/node_modules/opencode-ai/bin/opencode \"$@\"\n");
    const v2 = b.prog("o2", win ? "opencode.cmd" : "opencode", "\"%dp0%\\node_modules\\@opencode\\cli\\bin\\opencode.exe\" %*\n");
    const bin = b.prog("o3", exe("opencode"));
    expect(opencodeMajor(v1)).toBe(1);
    expect(opencodeMajor(v2)).toBe(2);
    expect(opencodeMajor(bin)).toBeNull();
    const notes = b.input({ PATH: b.path("o1", "o2") });
    expect(notes[0]).toMatch(/^opencode: установок несколько — используется .*o1.* \(1\.x\) \(первая в PATH\), ещё: .*o2.* \(2\.x\)/);
    expect(notes[1]).toMatch(/^opencode .*o1.* — версия 1\.x, а miksy пишет настройки в формате opencode 2\.x: обновите opencode$/);
    expect(b.input({ PATH: b.path("o2") })).toEqual([]);
  });
});

describe("окружение: каталоги настроек агентов и конфигурация", () => {
  test("переменная уводит каталог агента — агент не увидит настройки miksy; стандартное значение и чужой агент — молча", () => {
    const b = box();
    const notes = b.input({ PATH: "", CODEX_HOME: `${b.dir}/codex-home`, CLAUDE_CONFIG_DIR: `${b.home}/.claude`, XDG_CONFIG_HOME: `${b.dir}/xdg`, OPENCODE_CONFIG: `${b.dir}/oc.json`, GEMINI_CLI_HOME: `${b.dir}/g` }, ["codex", "opencode"]);
    expect(notes).toEqual([
      `CODEX_HOME=${b.dir}/codex-home: Codex читает настройки из ${b.dir}/codex-home, а miksy пишет в стандартный ~/.codex — настройки miksy агент не увидит`,
      `XDG_CONFIG_HOME=${b.dir}/xdg: opencode читает настройки из ${b.dir}/xdg/opencode, а miksy пишет в стандартный ~/.config/opencode — настройки miksy агент не увидит`,
      `OPENCODE_CONFIG=${b.dir}/oc.json: opencode читает этот конфиг поверх ~/.config/opencode — его ключи перекрывают настройки miksy`,
    ]);
    expect(b.input({ PATH: "", XDG_CONFIG_HOME: `${b.home}/.config`, CODEX_HOME: `${b.home}/.codex` })).toEqual([]);
  });

  test("MIKSY_CONFIG, а рядом с движком другая конфигурация — какая используется", () => {
    const b = box();
    put(`${b.dir}/engine/miksy-config/map.yaml`, "global: []\n");
    mkdirSync(`${b.dir}/config`, { recursive: true });
    expect(b.input({ PATH: "", MIKSY_CONFIG: `${b.dir}/config` })).toEqual([
      `конфигурация: используется ${b.dir}/config (MIKSY_CONFIG); рядом с движком есть другая — ${b.dir}/engine/miksy-config, она не используется`,
    ]);
    // Без MIKSY_CONFIG и ~/.miksy берётся соседняя — сообщать нечего
    expect(b.input({ PATH: "" })).toEqual([]);
  });

  test("doctor: «Окружение» в «Справочно», не проблема", () => {
    const f = cliFixture({ agents: ["codex"] });
    const run = (extra: Record<string, string>) => {
      const r = Bun.spawnSync([process.execPath, CLI, "doctor"], { cwd: f.dir, stdout: "pipe", stderr: "pipe",
        env: { ...process.env, MIKSY_CONFIG: f.config, HOME: f.home, USERPROFILE: f.home, ...extra } });
      return { code: r.exitCode, out: r.stdout.toString() };
    };
    const before = run({});
    const r = run({ CODEX_HOME: `${f.dir}/elsewhere` });
    expect(r.out).toMatch(/Справочно:[\s\S]*Окружение \(\d+\) — только сведения, miksy здесь ничего не меняет:\n(  .*\n)*  CODEX_HOME=.*elsewhere: Codex читает настройки из/);
    expect(r.code).toBe(before.code);
    expect(r.out.match(/Проблем: \d+|Всё синхронизировано/)?.[0]).toBe(before.out.match(/Проблем: \d+|Всё синхронизировано/)?.[0]);
  }, 60000);
});
