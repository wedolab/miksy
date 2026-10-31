import { canonical } from "../src/paths";
import { describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultWorkspace, expandPath, ourShim, referencedVars, shimText, unsafeWorkspace } from "../src/setup";
import { stableBun } from "../src/launch";
import { cliFixture } from "./helpers";

test("setup: переменные из MCP всех слоёв и где они нужны", () => {
  const root = mkdtempSync(join(tmpdir(), "miksy-setup-"));
  const put = (rel: string, content: string) => {
    mkdirSync(join(root, "layers", rel, ".."), { recursive: true });
    writeFileSync(join(root, "layers", rel), content);
  };
  put("tree/mcp/a.yaml", "name: a\ncommand: ${PYTHON}\nargs: [\"${WORKSPACE}/x.py\"]\n");
  put("tree/Org/mcp/b.yaml", "name: b\nurl: u\nheaders:\n  Authorization: Bearer ${ORG_TOKEN}\n");
  put("tree/Org/Team/mcp/c.yaml", "name: c\ncommand: npx\nenv:\n  T: ${ORG_TOKEN}\n");
  put("global/instructions/00.md", "# ${NOT_A_VAR}\n");
  const vars = referencedVars(root);
  expect([...vars.keys()].sort()).toEqual(["ORG_TOKEN", "PYTHON"]);
  expect([...vars.get("ORG_TOKEN")!].sort()).toEqual(["Org", "Org/Team"]);
  expect([...vars.get("PYTHON")!]).toEqual(["workspace"]);
});

describe("setup: workspace", () => {
  test("~ и относительные пути раскрываются в абсолютные", () => {
    expect(expandPath("~", "/Users/v", "/x")).toBe("/Users/v");
    expect(expandPath("~/Workspace", "/Users/v", "/x")).toBe("/Users/v/Workspace");
    expect(expandPath("ws/", "/Users/v", "/x")).toBe("/x/ws");
    expect(expandPath("/opt/ws", "/Users/v", "/x")).toBe("/opt/ws");
    expect(expandPath("~\\ai", "C:/Users/u", "D:/x")).toBe("C:/Users/u/ai");
    expect(expandPath("D:\\work", "C:/Users/u", "C:/x")).toBe("D:/work");
  });

  test("корень, домашний каталог и его родитель — опасные", () => {
    for (const p of ["/", "/Users", "/Users/v", "/Users/v/"]) expect(unsafeWorkspace(p, "/Users/v")).toBeTruthy();
    for (const p of ["C:/", "C:\\", "c:/users", "C:/Users/U"]) expect(unsafeWorkspace(p, "C:/Users/u")).toBeTruthy();
    expect(unsafeWorkspace("/Users/v/Workspace", "/Users/v")).toBeNull();
    expect(unsafeWorkspace("D:/work", "C:/Users/u")).toBeNull();
  });

  test("по умолчанию: папка-группа, каталог с проектами, плоская раскладка", () => {
    const root = mkdtempSync(join(tmpdir(), "ws-default-")).replaceAll("\\", "/");
    const home = `${root}/home`;
    const mk = (...ds: string[]) => ds.forEach((d) => mkdirSync(`${root}/${d}`, { recursive: true }));
    mk("home/ws/home/Miksy/miksy", "home/ws/home/Miksy/miksy-config", "home/ws/home/Miksy/.agents");
    expect(defaultWorkspace(`${home}/ws/home/Miksy/miksy`, home)).toBe(canonical(`${home}/ws`));
    mk("home/ws2/home/miksy", "home/ws2/home/other-project");
    expect(defaultWorkspace(`${home}/ws2/home/miksy`, home)).toBe(canonical(`${home}/ws2`));
    // ~/ai/miksy: на два уровня выше — сам ~, поэтому workspace — каталог движка
    mk("home/ai/miksy", "home/ai/proj");
    expect(defaultWorkspace(`${home}/ai/miksy`, home)).toBe(canonical(`${home}/ai`));
    // ~/miksy: безопасного варианта нет
    mk("home/miksy", "home/Documents");
    expect(defaultWorkspace(`${home}/miksy`, home)).toBeNull();
  });
});

describe("setup: команда miksy", () => {
  const shimName = process.platform === "win32" ? "miksy.cmd" : "miksy";
  const setupFixture = () => {
    const f = cliFixture();
    const bun = `${f.dir}/bun-install`;
    mkdirSync(`${bun}/bin`, { recursive: true });
    const run = () => {
      const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "setup", "--yes"], {
        cwd: f.dir,
        env: { ...process.env, MIKSY_CONFIG: f.config, HOME: f.home, USERPROFILE: f.home, BUN_INSTALL: bun },
        stdout: "pipe",
        stderr: "pipe",
      });
      return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
    };
    return { ...f, shim: `${bun}/bin/${shimName}`, run };
  };

  test("BUN_INSTALL: команда создаётся в его bin, а не в ~/.bun", () => {
    const f = setupFixture();
    mkdirSync(`${f.home}/.bun/bin`, { recursive: true });
    expect(f.run().code).toBe(0);
    expect(existsSync(f.shim)).toBe(true);
    expect(existsSync(`${f.home}/.bun/bin/${shimName}`)).toBe(false);
  });

  test("чужая команда miksy не перезаписывается", () => {
    const f = setupFixture();
    writeFileSync(f.shim, "echo another tool\n");
    const r = f.run();
    expect(r.code).toBe(0);
    expect(readFileSync(f.shim, "utf8")).toBe("echo another tool\n");
    expect(r.out).toContain("не от miksy");
  });

  test("machine.yaml уже есть — показан его workspace, а не предложенный по умолчанию", () => {
    const f = setupFixture();
    const r = f.run();
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Workspace: ${f.ws}  (из local/machine.yaml)`);
  });

  test("своя команда со старым путём движка обновляется", () => {
    const f = setupFixture();
    const old = process.platform === "win32" ? `@bun "D:/old/miksy/src/cli.ts" %*\r\n` : `#!/bin/sh\nexec bun "/old/miksy/src/cli.ts" "$@"\n`;
    writeFileSync(f.shim, old);
    expect(f.run().code).toBe(0);
    expect(readFileSync(f.shim, "utf8")).not.toBe(old);
    expect(readFileSync(f.shim, "utf8")).toContain("src/cli.ts");
  });
});

// Команда miksy запускает Bun, которым её создал setup: на машине с двумя Bun (Homebrew и ~/.bun/bin)
// sync из команды пишет обёрткам моста тот же Bun, что и прошлый раз
describe("setup: команда miksy запоминает Bun", () => {
  const win = process.platform === "win32";
  const os = win ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  const shimName = win ? "miksy.cmd" : "miksy";
  const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts").replaceAll("\\", "/");
  const fixture = () => {
    const f = cliFixture();
    const bunDir = `${f.dir}/bun-install`;
    mkdirSync(`${bunDir}/bin`, { recursive: true });
    const env = { ...process.env, MIKSY_CONFIG: f.config, HOME: f.home, USERPROFILE: f.home, BUN_INSTALL: bunDir };
    const setup = () => Bun.spawnSync([process.execPath, CLI_PATH, "setup", "--yes"], { cwd: f.dir, env, stdout: "pipe", stderr: "pipe" });
    const shim = `${bunDir}/bin/${shimName}`;
    // Запуск команды, как из оболочки пользователя
    const call = (...args: string[]) => {
      if (!win) chmodSync(shim, 0o755);
      const r = Bun.spawnSync(win ? ["cmd.exe", "/d", "/c", shim, ...args] : [shim, ...args], { cwd: f.dir, env, stdout: "pipe", stderr: "pipe" });
      return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
    };
    return { ...f, setup, shim, call };
  };

  test("команда создаётся с путём Bun без версии и запускает его; код выхода — как у miksy", () => {
    const f = fixture();
    expect(f.setup().exitCode).toBe(0);
    const text = readFileSync(f.shim, "utf8");
    expect(text).toBe(shimText(os, stableBun(process.execPath).replaceAll("\\", "/"), CLI_PATH));
    expect(ourShim(text)).toBe(true);
    const ok = f.call("help");
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("miksy sync");
    expect(ok.err).toBe("");
    expect(f.call("sync", "--нет-такого").code).toBe(2);
  });

  test("Bun пропал — bun из PATH с предупреждением", () => {
    const f = fixture();
    writeFileSync(f.shim, shimText(os, `${f.dir}/нет-bun/bin/${win ? "bun.exe" : "bun"}`, CLI_PATH));
    const r = f.call("help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("miksy sync");
    expect(r.err).toMatch(win ? /Bun ".*bun\.exe" not found - running bun from PATH/ : /нет Bun .*нет-bun.* — запускаю bun из PATH/);
    expect(f.call("sync", "--нет-такого").code).toBe(2);
  });

  test("прежний формат (bun из PATH) и другой Bun — своя команда, обновляется; похожая чужая — нет", () => {
    const f = fixture();
    const now = shimText(os, stableBun(process.execPath).replaceAll("\\", "/"), CLI_PATH);
    // Прежний формат с текущим движком
    writeFileSync(f.shim, win ? `@bun "${CLI_PATH}" %*\r\n` : `#!/bin/sh\nexec bun "${CLI_PATH}" "$@"\n`);
    expect(f.setup().stdout.toString()).toContain("команда miksy обновлена");
    expect(readFileSync(f.shim, "utf8")).toBe(now);
    // Новый формат, но другой Bun (был Homebrew, стал ~/.bun/bin)
    writeFileSync(f.shim, shimText(os, "/opt/homebrew/bin/bun", CLI_PATH));
    f.setup();
    expect(readFileSync(f.shim, "utf8")).toBe(now);
    // Повтор — без изменений и без сообщения об обновлении
    expect(f.setup().stdout.toString()).not.toContain("обновлена");
    // Своя команда с дописанной строкой — уже не своя
    const edited = now + (win ? "echo hi\r\n" : "echo hi\n");
    writeFileSync(f.shim, edited);
    expect(f.setup().stdout.toString()).toContain("не от miksy");
    expect(readFileSync(f.shim, "utf8")).toBe(edited);
  });

  test.if(win)("Windows: Bun в каталоге с кириллицей — команда находит его, код выхода сохраняется", () => {
    const f = fixture();
    const bun = `${f.dir}/Пользователь/bun.exe`;
    mkdirSync(`${f.dir}/Пользователь`);
    try { linkSync(process.execPath, bun); } catch { copyFileSync(process.execPath, bun); }
    writeFileSync(f.shim, shimText(os, bun, CLI_PATH));
    const ok = f.call("help");
    expect(ok.err).toBe("");
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("miksy sync");
    expect(f.call("sync", "--нет-такого").code).toBe(2);
  });

  test("путь с не-ASCII — .cmd под chcp 65001 с возвратом страницы; sh — в кавычках", () => {
    const text = shimText("windows", "C:/Users/Иван/.bun/bin/bun.exe", "D:/ai/miksy%x/src/cli.ts");
    expect(text).toContain("chcp 65001 >nul");
    expect(text).toContain('"C:\\Users\\Иван\\.bun\\bin\\bun.exe" "D:/ai/miksy%%x/src/cli.ts" %*');
    expect(text).toContain("exit /b %miksy_rc%");
    expect(ourShim(text)).toBe(true);
    expect(shimText("windows", "C:/b/bun.exe", "D:/cli.ts")).not.toContain("chcp");
    const sh = shimText("macos", "/Users/it's/.bun/bin/bun", "/w/src/cli.ts");
    expect(sh).toContain("b='/Users/it'\\''s/.bun/bin/bun'");
    expect(ourShim(sh)).toBe(true);
  });
});

// Окружение — та же сводка, что в doctor: и в мастере, и в setup --yes
test("setup: несколько установок программы — сообщение, что используется", () => {
  const f = cliFixture();
  const win = process.platform === "win32";
  for (const d of ["n1", "n2"]) { mkdirSync(`${f.dir}/${d}`, { recursive: true }); writeFileSync(`${f.dir}/${d}/${win ? "node.exe" : "node"}`, ""); }
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "setup", "--yes"], {
    cwd: f.dir, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, MIKSY_CONFIG: f.config, HOME: f.home, USERPROFILE: f.home, BUN_INSTALL: `${f.dir}/bun-install`,
      [key]: [`${f.dir}/n1`, `${f.dir}/n2`, process.env[key]].join(win ? ";" : ":") },
  });
  expect(r.exitCode).toBe(0);
  expect(r.stdout.toString()).toContain(`• Node.js: установок несколько — используется ${f.dir}/n1/${win ? "node.exe" : "node"} (первая в PATH), ещё: ${f.dir}/n2/`);
});
