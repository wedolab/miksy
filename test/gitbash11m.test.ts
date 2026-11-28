// Круг 11m: команда miksy в Git Bash на Windows. Рядом с miksy.cmd — sh-спутник «miksy» без расширения (LF): Git Bash,
// MSYS2 и Cygwin не используют PATHEXT. setup и update (setup без вопросов) создают и обновляют его, чужой не трогают;
// doctor и sync — нет спутника или он старый: проблема, если на машине есть bash; чужой — справка.
// Значения секретов — искусственные
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stableBun } from "../src/launch";
import { ourShim, shimCompanion, shimFiles, shimNotes, shimPath, shimState, shimText, windowsBash } from "../src/shim";
import { cliFixture, expectCode, put, restoreEnv } from "./helpers";

const WIN = process.platform === "win32";
const CLI = join(import.meta.dir, "..", "src", "cli.ts").replaceAll("\\", "/");

describe("спутник miksy.cmd для Git Bash", () => {
  test("Windows — два файла: miksy.cmd (CRLF) и miksy (sh, LF); macOS и Linux — один", () => {
    const files = shimFiles("windows", "C:/Users/Иван O'Neil/.bun/bin/bun.exe", "D:/ai/движок/src/cli.ts");
    expect(files.map((f) => f.name)).toEqual(["miksy.cmd", "miksy"]);
    const sh = files[1].text;
    expect(sh.startsWith("#!/bin/sh\n")).toBe(true);
    expect(sh).not.toContain("\r");
    expect(sh).toContain(`b='C:/Users/Иван O'\\''Neil/.bun/bin/bun.exe'`);
    expect(sh).toContain(`'D:/ai/движок/src/cli.ts' "$@"`);
    expect(sh).toContain("--no-env-file '--config=D:/ai/движок/src/bridge.bunfig.toml'");
    expect(ourShim(sh)).toBe(true);
    expect(files[0].text).toContain("\r\n");
    expect(shimFiles("macos", "/opt/bun", "/e/src/cli.ts").map((f) => f.name)).toEqual(["miksy"]);
    expect(shimCompanion("C:/u/.bun/bin/miksy.cmd")).toBe("C:/u/.bun/bin/miksy");
  });

  test("состояния спутника: свой нынешний, старый, чужой, нет", () => {
    const f = cliFixture();
    const sh = `${f.dir}/bin/miksy`;
    expect(shimState(sh)).toBe("missing");
    put(sh, shimText("macos", "C:/b/bun.exe", "D:/e/src/cli.ts"));
    expect(shimState(sh)).toBe("current");
    put(sh, shimText("macos", "C:/b/bun.exe", "D:/e/src/cli.ts", true));
    expect(shimState(sh)).toBe("legacy");
    put(sh, "#!/bin/sh\necho чужой\n");
    expect(shimState(sh)).toBe("foreign");
  });

  test("bash на Windows: PATH, рядом с git, обычные места; WSL-заглушка System32\\bash.exe — не bash", () => {
    const has = (set: string[]) => (p: string) => set.includes(p.replaceAll("/", "\\"));
    const env = (path: string, extra: Record<string, string> = {}) => ({ PATH: path, ...extra });
    expect(windowsBash(env("C:\\Windows\\System32"), has(["C:\\Windows\\System32\\bash.exe"]))).toBeNull();
    expect(windowsBash(env("D:\\Git\\cmd"), has(["D:\\Git\\cmd\\git.exe", "D:\\Git\\bin\\bash.exe"]))?.replaceAll("/", "\\")).toBe("D:\\Git\\bin\\bash.exe");
    expect(windowsBash(env("", { ProgramFiles: "C:\\Program Files" }), has(["C:\\Program Files\\Git\\bin\\bash.exe"]))?.replaceAll("/", "\\")).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
    expect(windowsBash(env("C:\\tools\\msys\\usr\\bin"), has(["C:\\tools\\msys\\usr\\bin\\bash.exe"]))?.replaceAll("/", "\\")).toBe("C:\\tools\\msys\\usr\\bin\\bash.exe");
    // MinGit (git без bash) — нет bash
    expect(windowsBash(env("C:\\MinGit\\cmd"), has(["C:\\MinGit\\cmd\\git.exe"]))).toBeNull();
  });

  test("doctor (shimNotes): нет спутника — проблема при bash, без bash — молчит; старый — проблема; чужой — справка", () => {
    const f = cliFixture();
    const saved = { ...process.env };
    try {
      process.env.MIKSY_CONFIG = f.config;
      const cmd = shimPath(f.home, "windows", {});
      put(cmd, shimText("windows", "C:/b/bun.exe", "D:/e/src/cli.ts"));
      const sh = shimCompanion(cmd);
      const bash = () => "C:/Program Files/Git/bin/bash.exe";
      const none = () => null;
      const reg = () => null;
      expect(shimNotes(f.home, "windows", false, { bash, registryPath: reg }).problems.join()).toContain(`в Git Bash команды miksy нет (${sh})`);
      expect(shimNotes(f.home, "windows", false, { bash: none, registryPath: reg })).toEqual({ problems: [], info: [] });
      put(sh, shimText("macos", "C:/b/bun.exe", "D:/e/src/cli.ts", true));
      expect(shimNotes(f.home, "windows", false, { bash, registryPath: reg }).problems.join()).toContain("в Git Bash команды miksy старого вида");
      put(sh, shimText("macos", "C:/b/bun.exe", "D:/e/src/cli.ts"));
      expect(shimNotes(f.home, "windows", false, { bash, registryPath: reg })).toEqual({ problems: [], info: [] });
      put(sh, "#!/bin/sh\necho чужой\n");
      const foreign = shimNotes(f.home, "windows", false, { bash, registryPath: reg });
      expect(foreign.problems).toEqual([]);
      expect(foreign.info.join()).toContain(`${sh} — не команда miksy`);
      // Чужая miksy.cmd — спутник не проверяется
      put(cmd, "@echo чужая\r\n");
      rmSync(sh);
      expect(shimNotes(f.home, "windows", false, { bash, registryPath: reg }).problems).toEqual([]);
    } finally {
      restoreEnv(saved);
    }
  });
});

// setup пишет команду для ОС, на которой запущен: спутник — только на Windows
describe.skipIf(!WIN)("Windows: setup создаёт и обновляет спутник, чужой не трогает", () => {
  const fixture = () => {
    const f = cliFixture();
    const bunDir = `${f.dir}/bun-install`;
    mkdirSync(`${bunDir}/bin`, { recursive: true });
    const env = { ...process.env, MIKSY_CONFIG: f.config, HOME: f.home, USERPROFILE: f.home, BUN_INSTALL: bunDir };
    const setup = () => {
      const r = Bun.spawnSync([process.execPath, CLI, "setup", "--yes"], { cwd: f.dir, env, stdout: "pipe", stderr: "pipe" });
      return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
    };
    return { ...f, bunDir, env, setup, cmd: `${bunDir}/bin/miksy.cmd`, sh: `${bunDir}/bin/miksy` };
  };
  const body = () => shimFiles("windows", stableBun(process.execPath).replaceAll("\\", "/"), CLI)[1].text;

  test("создаёт оба файла; старый спутник обновляет; чужой не трогает", () => {
    const f = fixture();
    const first = f.setup();
    expectCode(first, 0);
    expect(existsSync(f.cmd)).toBe(true);
    expect(readFileSync(f.sh, "utf8")).toBe(body());
    expect(first.out).toContain("команда miksy для Git Bash создана");
    // Повторный setup (как update) — без изменений и без строки
    const again = f.setup();
    expect(again.out).not.toContain("команда miksy для Git Bash");
    // Старый вид — обновляется
    writeFileSync(f.sh, shimText("macos", "C:/old/bun.exe", "D:/old/src/cli.ts", true));
    expect(f.setup().out).toContain("команда miksy для Git Bash обновлена");
    expect(readFileSync(f.sh, "utf8")).toBe(body());
    // Чужой — не трогается
    writeFileSync(f.sh, "#!/bin/sh\necho чужой\n");
    expect(f.setup().out).toContain("уже есть и не от miksy — не трогаю: в Git Bash по имени miksy найдётся он");
    expect(readFileSync(f.sh, "utf8")).toBe("#!/bin/sh\necho чужой\n");
  });

  // Живая проверка: Git Bash находит спутник, аргументы и труба — без искажений; cmd и PowerShell берут miksy.cmd
  const bash = windowsBash();
  test.skipIf(!bash)("Git Bash: miksy --version, аргумент с пробелом, труба miksy secret байт в байт, код возврата", () => {
    const f = fixture();
    expectCode(f.setup(), 0);
    const value = ["git", "bash", "11m", "Zx8"].join("-");
    put(`${f.config}/layers/global/layer.yaml`, "exclude: [skill.miksy]\nskill_secrets: [GB_KEY]\n");
    put(`${f.config}/local/secrets.env`, `GB_KEY=${value}\n`);
    // Утилиты bash (od, tr) — рядом с ним: Git\usr\bin при Git\bin\bash.exe, та же папка у MSYS2 и Cygwin. bash -c
    // (не вход) берёт PATH как есть, а в PATH PowerShell или cmd их обычно нет — тест должен проходить и при запуске оттуда
    const tools = [dirname(bash!), join(dirname(bash!), "..", "usr", "bin")].filter((d) => existsSync(join(d, "od.exe")));
    const path = [`${f.bunDir}/bin`, ...tools, f.env.PATH ?? f.env.Path ?? ""].join(";");
    const env = { ...f.env, PATH: path, Path: path };
    const run = (script: string) => {
      const r = Bun.spawnSync([bash!, "-c", script], { cwd: f.dir, env, stdout: "pipe", stderr: "pipe" });
      return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
    };
    const where = run("command -v miksy");
    expect(where.out.trim().endsWith("/miksy")).toBe(true);
    const v = run("miksy --version");
    expectCode(v, 0);
    expect(v.out).toMatch(/\d+\.\d+\.\d+/);
    // Аргумент с пробелом доходит одним: каталога нет — ошибка называет его целиком
    const spaced = run(`miksy explain '${f.dir}/нет такой папки'`);
    expect(spaced.err).toContain("нет такой папки: каталога нет");
    // Труба: байты значения, без CR и перевода строки
    const pipe = run("miksy secret GB_KEY | od -An -tx1 | tr -d ' \\n'");
    expectCode(pipe, 0);
    expect(pipe.out.trim()).toBe(Buffer.from(value).toString("hex"));
    // Код возврата сохраняется
    expect(run("miksy secret НЕТ_ТАКОГО; echo rc=$?").out).toContain("rc=2");
    expect(run("miksy secret NOPE >/dev/null 2>&1; echo rc=$?").out).toContain("rc=1");
    // cmd и PowerShell по-прежнему запускают miksy.cmd: sh-скрипт cmd выполнить не смог бы (`where` показывает файл без
    // расширения первым, но запуск идёт по PATHEXT)
    const cmd = Bun.spawnSync(["cmd", "/d", "/c", "miksy --version"], { cwd: f.dir, env, stdout: "pipe", stderr: "pipe" });
    expect(cmd.exitCode).toBe(0);
    expect(cmd.stdout.toString()).toMatch(/\d+\.\d+\.\d+/);
    const ps = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", "(Get-Command miksy).Source; miksy --version"], { cwd: f.dir, env, stdout: "pipe", stderr: "pipe" });
    const psOut = ps.stdout.toString().trim().split(/\r?\n/);
    expect(psOut[0].toLowerCase()).toEndWith("miksy.cmd");
    expect(psOut[1]).toMatch(/\d+\.\d+\.\d+/);
  }, 60000);
});
