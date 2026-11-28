// Стартовые скрипты install.sh (macOS/Linux) и install.ps1 (Windows) в песочнице: свой HOME, PATH без
// Bun; установщик Bun подменён (поддельные curl / powershell кладут поддельный bun, который только
// записывает, с чем его запустили), движок клонируется из локального bare-репо (MIKSY_REPO)
import { describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { canonical } from "../src/paths";
import { put, expectCode } from "./helpers";

const ROOT = resolve(import.meta.dir, "..");
const win = process.platform === "win32";

// Движок в bare-репо: src/cli.ts и сами скрипты
function sandbox(o: { stable?: boolean } = {}) {
  const dir = canonical(mkdtempSync(join(tmpdir(), "install-")));
  const home = `${dir}/home`;
  mkdirSync(home, { recursive: true });
  const src = `${dir}/engine-src`;
  put(`${src}/src/cli.ts`, "// движок\n");
  copyFileSync(join(ROOT, "install.sh"), `${src}/install.sh`);
  copyFileSync(join(ROOT, "install.ps1"), `${src}/install.ps1`);
  const git = (...a: string[]) => Bun.spawnSync(["git", ...a], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git("-C", src, "init", "-q");
  git("-C", src, "add", "-A");
  git("-C", src, "commit", "-q", "-m", "engine");
  // Ветка stable (релиз) с меткой RELEASE; ветка по умолчанию остаётся прежней
  if (o.stable) {
    git("-C", src, "checkout", "-q", "-b", "stable");
    put(`${src}/RELEASE`, "stable\n");
    git("-C", src, "add", "-A");
    git("-C", src, "commit", "-q", "-m", "release");
    git("-C", src, "checkout", "-q", "-");
  }
  const bare = `${dir}/miksy.git`;
  git("clone", "-q", "--bare", src, bare);
  // Скрипт, скачанный отдельно (не из клона)
  const dl = `${dir}/dl`;
  mkdirSync(dl, { recursive: true });
  return { dir, home, bare, dl, bin: `${dir}/bin` };
}

describe.skipIf(win)("install.sh", () => {
  const fakes = (bin: string) => {
    // Официальный установщик: curl -fsSL https://bun.sh/install | bash → скрипт, который кладёт bun
    put(`${bin}/curl`, `#!/bin/sh
echo "$*" >> "$HOME/curl-args"
cat <<'EOF'
mkdir -p "$HOME/.bun/bin"
cat > "$HOME/.bun/bin/bun" <<'EOB'
#!/bin/sh
if [ "$1" = "--version" ]; then echo 1.4.3; exit 0; fi
echo "$(pwd) $*" > "$HOME/bun-args"
EOB
chmod +x "$HOME/.bun/bin/bun"
EOF
`);
    chmodSync(`${bin}/curl`, 0o755);
  };
  const run = (f: ReturnType<typeof sandbox>, script: string, stdin: string, repo = f.bare) => {
    const r = Bun.spawnSync(["/bin/sh", script, "--yes"], {
      cwd: f.dir, stdin: Buffer.from(stdin), stdout: "pipe", stderr: "pipe",
      // git установщика не читает настройки машины (test/preload.ts)
      env: { HOME: f.home, PATH: `${f.bin}:/usr/bin:/bin:/usr/sbin:/sbin`, MIKSY_REPO: repo, SHELL: "/bin/zsh", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: `${f.home}/.gitconfig` },
    });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  };

  test("нет Bun — официальный установщик после «y», клон движка, мастер с аргументами", () => {
    const f = sandbox();
    fakes(f.bin);
    copyFileSync(join(ROOT, "install.sh"), `${f.dl}/install.sh`);
    const r = run(f, `${f.dl}/install.sh`, "y\n\n");
    expectCode(r, 0);
    expect(r.out).toContain("curl -fsSL https://bun.sh/install | bash");
    expect(readFileSync(`${f.home}/curl-args`, "utf8")).toContain("https://bun.sh/install");
    const dest = `${f.home}/Projects/miksy`;
    // Не склонирован — в сообщении теста вывод install.sh (иначе причину не видно)
    expect(existsSync(`${dest}/src/cli.ts`) ? "" : `движок не склонирован; вывод install.sh:\n${r.out}`).toBe("");
    expect(readFileSync(`${f.home}/bun-args`, "utf8").trim()).toBe(`${canonical(dest)} src/cli.ts setup --yes`);

    // Повтор из клона: Bun уже в ~/.bun (не в PATH) — подхвачен, вопросов нет
    const again = run(f, `${dest}/install.sh`, "");
    expectCode(again, 0);
    expect(again.out).not.toContain("Куда скачать");
    expect(again.out).toContain("✓ git, Bun 1.4.3");
  }, 120000);

  // Терминал — через script (псевдотерминал): bash 4+ читает ответ с построчным редактированием, путь по
  // умолчанию уже в строке — «X» дописывается к нему. Без bash 4+ (macOS /bin/bash 3.2) или script — пропуск
  const bash = Bun.which("bash");
  const pty = Bun.which("script");
  const bash4 = !!bash && Number(Bun.spawnSync([bash, "-c", "echo ${BASH_VERSINFO[0]}"]).stdout.toString().trim()) >= 4;
  test.if(!!pty && bash4)("bash с терминалом: «Куда скачать» — путь по умолчанию в строке, его можно править (read -e -i)", () => {
    const f = sandbox();
    put(`${f.bin}/bun`, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.4.3; exit 0; fi\necho "$(pwd) $*" > "$HOME/bun-args"\n`);
    chmodSync(`${f.bin}/bun`, 0o755);
    copyFileSync(join(ROOT, "install.sh"), `${f.dl}/install.sh`);
    const argv = process.platform === "darwin"
      ? [pty!, "-q", "/dev/null", bash!, `${f.dl}/install.sh`, "--yes"]
      : [pty!, "-qec", `${bash} ${f.dl}/install.sh --yes`, "/dev/null"];
    const r = Bun.spawnSync(argv, {
      cwd: f.dir, stdin: Buffer.from("X\r"), stdout: "pipe", stderr: "pipe",
      env: { HOME: f.home, PATH: `${f.bin}:/usr/bin:/bin:/usr/sbin:/sbin`, MIKSY_REPO: f.bare, SHELL: bash!, TERM: "xterm" },
    });
    expect(existsSync(`${f.home}/Projects/miksyX/src/cli.ts`) ? "" : `не склонирован в ~/Projects/miksyX; вывод:\n${r.stdout}${r.stderr}`).toBe("");
  }, 60000);

  test("две установки Bun (PATH и ~/.bun/bin) — какая используется, совет оставить одну; ничего не удаляется", () => {
    const f = sandbox();
    fakes(f.bin);
    const fake = "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 1.4.3; exit 0; fi\necho \"$(pwd) $*\" > \"$HOME/bun-args\"\n";
    put(`${f.bin}/bun`, fake);
    chmodSync(`${f.bin}/bun`, 0o755);
    put(`${f.home}/.bun/bin/bun`, fake);
    chmodSync(`${f.home}/.bun/bin/bun`, 0o755);
    copyFileSync(join(ROOT, "install.sh"), `${f.dl}/install.sh`);
    const r = run(f, `${f.dl}/install.sh`, "\n");
    expectCode(r, 0);
    expect(r.out).toContain(`Внимание: на машине несколько установок Bun — используется ${f.bin}/bun:`);
    expect(r.out).toContain(`  ${f.bin}/bun  ← используется`);
    expect(r.out).toContain(`  ${f.home}/.bun/bin/bun\n`);
    expect(r.out).toContain("Лучше оставить одну");
    expect(existsSync(`${f.home}/.bun/bin/bun`) && existsSync(`${f.bin}/bun`)).toBe(true);
    // Ссылка на тот же файл — одна установка
    const one = sandbox();
    fakes(one.bin);
    put(`${one.home}/.bun/bin/bun`, fake);
    chmodSync(`${one.home}/.bun/bin/bun`, 0o755);
    mkdirSync(one.bin, { recursive: true });
    symlinkSync(`${one.home}/.bun/bin/bun`, `${one.bin}/bun`);
    copyFileSync(join(ROOT, "install.sh"), `${one.dl}/install.sh`);
    expect(run(one, `${one.dl}/install.sh`, "\n").out).not.toContain("несколько установок Bun");
  }, 60000);

  test("в репо есть ветка stable — клон на ней (последний релиз); без неё — ветка по умолчанию", () => {
    const f = sandbox({ stable: true });
    fakes(f.bin);
    copyFileSync(join(ROOT, "install.sh"), `${f.dl}/install.sh`);
    const r = run(f, `${f.dl}/install.sh`, "y\n\n");
    expectCode(r, 0);
    const dest = `${f.home}/Projects/miksy`;
    const head = Bun.spawnSync(["git", "-C", dest, "symbolic-ref", "--short", "HEAD"]).stdout.toString().trim();
    expect(head === "stable" ? head : `${head}; вывод install.sh:\n${r.out}`).toBe("stable");
    expect(existsSync(`${dest}/RELEASE`)).toBe(true);
    expect(r.out).toContain("ветка stable");
    const plain = sandbox();
    fakes(plain.bin);
    copyFileSync(join(ROOT, "install.sh"), `${plain.dl}/install.sh`);
    expect(run(plain, `${plain.dl}/install.sh`, "y\n\n").out).not.toContain("ветка stable");
    expect(Bun.spawnSync(["git", "-C", `${plain.home}/Projects/miksy`, "symbolic-ref", "--short", "HEAD"]).stdout.toString().trim()).not.toBe("stable");
  }, 120000);

  test("отказ от установки Bun — выход без изменений; ошибка клона — подсказка про доступ", () => {
    const f = sandbox();
    fakes(f.bin);
    copyFileSync(join(ROOT, "install.sh"), `${f.dl}/install.sh`);
    const no = run(f, `${f.dl}/install.sh`, "\n");
    expectCode(no, 1);
    expect(existsSync(`${f.home}/.bun`)).toBe(false);
    const bad = run(f, `${f.dl}/install.sh`, "y\n\n", `${f.dir}/nope.git`);
    expectCode(bad, 1);
    expect(bad.out).toContain("gh auth login");
    expect(bad.out).toContain("MIKSY_REPO=git@github.com:");
  }, 60000);

  // Круг 10f: минимум Bun 1.4.3 — на 1.4.2 установщик отказывает и подсказывает bun upgrade, движок не качает
  test("Bun 1.4.2 — отказ с подсказкой bun upgrade, движок не скачан", () => {
    const f = sandbox();
    put(`${f.bin}/bun`, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.4.2; exit 0; fi\necho "$(pwd) $*" > "$HOME/bun-args"\n`);
    chmodSync(`${f.bin}/bun`, 0o755);
    copyFileSync(join(ROOT, "install.sh"), `${f.dl}/install.sh`);
    const r = run(f, `${f.dl}/install.sh`, "\n");
    expectCode(r, 1);
    expect(r.out).toContain("Bun 1.4.2 старше 1.4.3 — обновите: bun upgrade");
    expect(existsSync(`${f.home}/Projects/miksy`) || existsSync(`${f.home}/bun-args`)).toBe(false);
  }, 60000);
});

// Запуск PowerShell на раннерах GitHub Windows медленный: один запуск install.ps1 — до ~75 с, а на медленном раннере в
// полтора-два раза дольше (круг 10o: тест с двумя запусками шёл 104–148 с при пределе 180 с и на 5356efa его превысил —
// весь прогон был в 1,5 раза медленнее; локально все пять тестов — 19 с). Предел одного запуска — PS_LIMIT: он
// срабатывает раньше предела теста (TEST_LIMIT — два запуска и запас), и в ошибке — что install.ps1 успел напечатать
const PS_LIMIT = 150_000;
const TEST_LIMIT = 2 * PS_LIMIT + 30_000;
const SYS = process.env.SystemRoot ?? "C:\\Windows";
const PS_MODULES = `${SYS}\\System32\\WindowsPowerShell\\v1.0\\Modules`;
// Окружение install.ps1 (круг 12e). Урезан нарочно только PATH: в нём нет Bun (и нет программ машины) — install.ps1 должен
// найти Bun сам или предложить установщик; программы теста (поддельные powershell.cmd, bun) — в bin песочницы. Остальное —
// как у обычного пользователя, но в песочнице:
// - USERPROFILE, HOME — дом песочницы: туда install.ps1 ставит Bun (~\.bun) и скачивает движок (~\Projects);
// - LOCALAPPDATA, APPDATA — папки данных пользователя: без них PowerShell 5.1 не может хранить свои кеши (разбор модулей
//   и т. п.), а у пользователя они всегда есть; в песочнице — чтобы не писать в настоящий профиль;
// - TEMP, TMP — временные файлы PowerShell и git — тоже в песочнице;
// - PSModulePath — только системные модули (там все командлеты install.ps1 — проверяет тест ниже). Без него PowerShell
//   берёт модули и из «Документов» настоящего пользователя (путь — из реестра, не из USERPROFILE), а на раннерах GitHub
//   — ещё и сотни установленных модулей. Папку Program Files\WindowsPowerShell\Modules PowerShell 5.1 добавляет сам, её
//   не убрать;
// - SystemRoot, PATHEXT — без них Windows-программы и поиск .cmd не работают;
// - GIT_CONFIG_NOSYSTEM, GIT_CONFIG_GLOBAL — git без настроек машины.
const psEnv = (home: string, bin: string): Record<string, string> => {
  const local = `${home}\\AppData\\Local`, roaming = `${home}\\AppData\\Roaming`, temp = `${home}\\AppData\\Local\\Temp`;
  for (const d of [local, roaming, temp]) mkdirSync(d, { recursive: true });
  return {
    USERPROFILE: home, HOME: home, LOCALAPPDATA: local, APPDATA: roaming, TEMP: temp, TMP: temp, PSModulePath: PS_MODULES,
    SystemRoot: SYS, PATHEXT: ".COM;.EXE;.BAT;.CMD", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: `${home}/.gitconfig`,
    PATH: [bin.replaceAll("/", "\\"), `${SYS}\\System32`, `${SYS}\\System32\\WindowsPowerShell\\v1.0`, dirname(Bun.which("git") ?? "C:\\git\\git.exe")].join(";"),
  };
};
describe.skipIf(!win)("install.ps1", () => {
  const fakes = (f: ReturnType<typeof sandbox>) => {
    // Официальный установщик: powershell -c "irm bun.sh/install.ps1 | iex" → кладёт bun.cmd
    put(`${f.dir}/fakebun.cmd`, `@echo off\r\nif "%~1"=="--version" (echo 1.4.3& exit /b 0)\r\necho %CD% %*> "%USERPROFILE%\\bun-args"\r\n`);
    put(`${f.bin}/powershell.cmd`, `@echo off\r\necho %*>> "%USERPROFILE%\\ps-args"\r\nmkdir "%USERPROFILE%\\.bun\\bin" 2>nul\r\ncopy /y "${f.dir.replaceAll("/", "\\")}\\fakebun.cmd" "%USERPROFILE%\\.bun\\bin\\bun.cmd" >nul\r\n`);
  };
  const run = (f: ReturnType<typeof sandbox>, script: string, stdin: string, repo = f.bare) => {
    const r = Bun.spawnSync([`${SYS}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "--yes"], {
      cwd: f.dir, stdin: Buffer.from(stdin), stdout: "pipe", stderr: "pipe", env: { ...psEnv(f.home, f.bin), MIKSY_REPO: repo }, timeout: PS_LIMIT,
    });
    const out = r.stdout.toString() + r.stderr.toString();
    return { code: r.exitCode, out: r.exitedDueToTimeout ? `${out}\n(install.ps1 остановлен: не закончил за ${PS_LIMIT / 1000} с — выше всё, что он успел напечатать)` : out };
  };

  test("нет Bun — официальный установщик после «y», клон движка, мастер с аргументами", () => {
    const f = sandbox();
    fakes(f);
    copyFileSync(join(ROOT, "install.ps1"), `${f.dl}/install.ps1`);
    const r = run(f, `${f.dl}/install.ps1`, "y\r\n\r\n");
    expectCode(r, 0);
    expect(readFileSync(`${f.home}/ps-args`, "utf8")).toContain("irm bun.sh/install.ps1 | iex");
    const dest = `${f.home}/Projects/miksy`;
    expect(existsSync(`${dest}/src/cli.ts`)).toBe(true);
    expect(readFileSync(`${f.home}/bun-args`, "utf8").trim().toLowerCase()).toBe(`${dest.replaceAll("/", "\\")} src/cli.ts setup "--yes"`.toLowerCase());

    const again = run(f, `${dest}/install.ps1`, "");
    expect(again.code === 0 ? "" : `код ${again.code}; вывод install.ps1:
${again.out}`).toBe("");
    expect(again.out).toContain("1.4.3");
    expect(existsSync(`${f.home}/ps-args`) && readFileSync(`${f.home}/ps-args`, "utf8").split("\n").filter(Boolean).length).toBe(1);
  }, TEST_LIMIT);

  test("две установки Bun (PATH и ~/.bun/bin) — какая используется, совет оставить одну; ничего не удаляется", () => {
    const f = sandbox();
    fakes(f);
    copyFileSync(`${f.dir}/fakebun.cmd`, `${f.bin}/bun.cmd`);
    put(`${f.home}/.bun/bin/bun.cmd`, readFileSync(`${f.dir}/fakebun.cmd`, "utf8"));
    copyFileSync(join(ROOT, "install.ps1"), `${f.dl}/install.ps1`);
    const r = run(f, `${f.dl}/install.ps1`, "\r\n");
    expectCode(r, 0);
    const used = `${f.bin}/bun.cmd`.replaceAll("/", "\\");
    expect(r.out).toContain(`Внимание: на машине несколько установок Bun — используется ${used}:`);
    expect(r.out).toContain(`  ${used}  ← используется`);
    expect(r.out).toContain(`  ${f.home.replaceAll("/", "\\")}\\.bun\\bin\\bun.cmd\n`.replace("\n", ""));
    expect(r.out).toContain("Лучше оставить одну");
    expect(existsSync(`${f.home}/.bun/bin/bun.cmd`) && existsSync(`${f.bin}/bun.cmd`)).toBe(true);
    expect(existsSync(`${f.home}/ps-args`)).toBe(false);
    // Одна установка — без предупреждения
    const one = sandbox();
    fakes(one);
    copyFileSync(`${one.dir}/fakebun.cmd`, `${one.bin}/bun.cmd`);
    copyFileSync(join(ROOT, "install.ps1"), `${one.dl}/install.ps1`);
    expect(run(one, `${one.dl}/install.ps1`, "\r\n").out).not.toContain("несколько установок Bun");
  }, TEST_LIMIT);

  test("в репо есть ветка stable — клон на ней (последний релиз); без неё — ветка по умолчанию", () => {
    const f = sandbox({ stable: true });
    fakes(f);
    copyFileSync(join(ROOT, "install.ps1"), `${f.dl}/install.ps1`);
    const r = run(f, `${f.dl}/install.ps1`, "y\r\n\r\n");
    expectCode(r, 0);
    const dest = `${f.home}/Projects/miksy`;
    expect(Bun.spawnSync(["git", "-C", dest, "symbolic-ref", "--short", "HEAD"]).stdout.toString().trim()).toBe("stable");
    expect(existsSync(`${dest}/RELEASE`)).toBe(true);
    expect(r.out).toContain("ветка stable");
    const plain = sandbox();
    fakes(plain);
    copyFileSync(join(ROOT, "install.ps1"), `${plain.dl}/install.ps1`);
    expect(run(plain, `${plain.dl}/install.ps1`, "y\r\n\r\n").out).not.toContain("ветка stable");
    expect(Bun.spawnSync(["git", "-C", `${plain.home}/Projects/miksy`, "symbolic-ref", "--short", "HEAD"]).stdout.toString().trim()).not.toBe("stable");
  }, TEST_LIMIT);

  test("отказ от установки Bun — выход без изменений; ошибка клона — подсказка про доступ", () => {
    const f = sandbox();
    fakes(f);
    copyFileSync(join(ROOT, "install.ps1"), `${f.dl}/install.ps1`);
    const no = run(f, `${f.dl}/install.ps1`, "\r\n");
    expectCode(no, 1);
    expect(existsSync(`${f.home}/.bun`)).toBe(false);
    const bad = run(f, `${f.dl}/install.ps1`, "y\r\n\r\n", `${f.dir}/nope.git`);
    expectCode(bad, 1);
    expect(bad.out).toContain("gh auth login");
  }, TEST_LIMIT);

  // Круг 10f: минимум Bun 1.4.3 — на 1.4.2 установщик отказывает и подсказывает bun upgrade, движок не качает
  test("Bun 1.4.2 — отказ с подсказкой bun upgrade, движок не скачан", () => {
    const f = sandbox();
    put(`${f.bin}/bun.cmd`, `@echo off\r\nif "%~1"=="--version" (echo 1.4.2& exit /b 0)\r\necho %CD% %*> "%USERPROFILE%\\bun-args"\r\n`);
    copyFileSync(join(ROOT, "install.ps1"), `${f.dl}/install.ps1`);
    const r = run(f, `${f.dl}/install.ps1`, "\r\n");
    expectCode(r, 1);
    expect(r.out).toContain("Bun 1.4.2 старше 1.4.3 — обновите: bun upgrade");
    expect(existsSync(`${f.home}/Projects/miksy`) || existsSync(`${f.home}/bun-args`)).toBe(false);
  }, TEST_LIMIT);

  // Круг 12e: тесты выше дают install.ps1 только системные модули (PSModulePath). Команда не оттуда (например, из
  // модуля, поставленного отдельно) у пользователя бы работала, а в тесте — нет, или наоборот: этот тест называет её.
  // Разбор скрипта PowerShell (все вызовы команд) и Get-Command для каждой в том же окружении
  test("install.ps1 вызывает только системные командлеты, свои функции и git, bun, powershell", () => {
    const f = sandbox();
    const probe = `${f.dir}/probe.ps1`;
    put(probe, [
      "param([string]$Script)",
      "$ast = [System.Management.Automation.Language.Parser]::ParseFile($Script, [ref]$null, [ref]$null)",
      "$own = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) | ForEach-Object { $_.Name }",
      "$names = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true) | ForEach-Object { $_.GetCommandName() } | Where-Object { $_ } | Sort-Object -Unique",
      "foreach ($n in $names) {",
      "  if ($own -contains $n -or @('git', 'bun', 'powershell') -contains $n) { continue }",
      "  $c = Get-Command $n -CommandType Cmdlet,Function,Alias -ErrorAction SilentlyContinue | Select-Object -First 1",
      "  if (-not $c) { \"$n : not found\"; continue }",
      "  $base = if ($c.Module) { $c.Module.ModuleBase } else { $PSHOME }",
      "  if (-not $base.StartsWith($PSHOME, [StringComparison]::OrdinalIgnoreCase)) { \"$n : $base\" }",
      "}",
    ].join("\r\n"));
    const r = Bun.spawnSync([`${SYS}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", probe, join(ROOT, "install.ps1")], {
      cwd: f.dir, stdout: "pipe", stderr: "pipe", env: psEnv(f.home, f.bin), timeout: PS_LIMIT,
    });
    expect({ code: r.exitCode, outside: r.stdout.toString().trim(), err: r.stderr.toString().trim() }).toEqual({ code: 0, outside: "", err: "" });
  }, TEST_LIMIT);

  // ВРЕМЕННО (круг 12e, убрать после замеров на GitHub): сколько стоит один запуск PowerShell с поиском отсутствующей
  // команды — как в install.ps1 — в прежнем урезанном окружении, в новом (psEnv) и в полном окружении раннера. Печатает
  // строку «12e-замер» в вывод; на отказ не влияет
  test.skipIf(!process.env.GITHUB_ACTIONS)("12e-замер: запуск PowerShell в трёх окружениях", () => {
    const f = sandbox();
    const ps = `${SYS}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    const cmd = "if (-not (Get-Command bunxx -ErrorAction SilentlyContinue)) { Test-Path C:\\ | Out-Null }; exit 0";
    const old = { USERPROFILE: f.home, HOME: f.home, SystemRoot: SYS, PATHEXT: ".COM;.EXE;.BAT;.CMD", PATH: `${SYS}\\System32` };
    const time = (env: Record<string, string>) => { const s = performance.now(); Bun.spawnSync([ps, "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", cmd], { env, stdout: "pipe", stderr: "pipe", timeout: PS_LIMIT }); return Math.round(performance.now() - s); };
    const count = (d: string) => { try { return readdirSync(d).length; } catch { return -1; } };
    const pf = `${process.env.ProgramFiles ?? "C:\\Program Files"}\\WindowsPowerShell\\Modules`;
    console.log(`12e-замер: прежнее ${time(old)} мс, прежнее повторно ${time(old)} мс, новое ${time(psEnv(f.home, f.bin))} мс, ` +
      `новое повторно ${time(psEnv(f.home, f.bin))} мс, полное ${time(process.env as Record<string, string>)} мс; модулей в ${pf}: ${count(pf)}`);
  }, 4 * PS_LIMIT);
});
