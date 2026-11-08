// Стартовые скрипты install.sh (macOS/Linux) и install.ps1 (Windows) в песочнице: свой HOME, PATH без
// Bun; установщик Bun подменён (поддельные curl / powershell кладут поддельный bun, который только
// записывает, с чем его запустили), движок клонируется из локального bare-репо (MIKSY_REPO)
import { describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { canonical } from "../src/paths";
import { put } from "./helpers";

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
if [ "$1" = "--version" ]; then echo 1.3.14; exit 0; fi
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
    expect(r.code).toBe(0);
    expect(r.out).toContain("curl -fsSL https://bun.sh/install | bash");
    expect(readFileSync(`${f.home}/curl-args`, "utf8")).toContain("https://bun.sh/install");
    const dest = `${f.home}/Projects/miksy`;
    // Не склонирован — в сообщении теста вывод install.sh (иначе причину не видно)
    expect(existsSync(`${dest}/src/cli.ts`) ? "" : `движок не склонирован; вывод install.sh:\n${r.out}`).toBe("");
    expect(readFileSync(`${f.home}/bun-args`, "utf8").trim()).toBe(`${canonical(dest)} src/cli.ts setup --yes`);

    // Повтор из клона: Bun уже в ~/.bun (не в PATH) — подхвачен, вопросов нет
    const again = run(f, `${dest}/install.sh`, "");
    expect(again.code).toBe(0);
    expect(again.out).not.toContain("Куда скачать");
    expect(again.out).toContain("✓ git, Bun 1.3.14");
  }, 60000);

  // Терминал — через script (псевдотерминал): bash 4+ читает ответ с построчным редактированием, путь по
  // умолчанию уже в строке — «X» дописывается к нему. Без bash 4+ (macOS /bin/bash 3.2) или script — пропуск
  const bash = Bun.which("bash");
  const pty = Bun.which("script");
  const bash4 = !!bash && Number(Bun.spawnSync([bash, "-c", "echo ${BASH_VERSINFO[0]}"]).stdout.toString().trim()) >= 4;
  test.if(!!pty && bash4)("bash с терминалом: «Куда скачать» — путь по умолчанию в строке, его можно править (read -e -i)", () => {
    const f = sandbox();
    put(`${f.bin}/bun`, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.3.14; exit 0; fi\necho "$(pwd) $*" > "$HOME/bun-args"\n`);
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
    const fake = "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 1.3.14; exit 0; fi\necho \"$(pwd) $*\" > \"$HOME/bun-args\"\n";
    put(`${f.bin}/bun`, fake);
    chmodSync(`${f.bin}/bun`, 0o755);
    put(`${f.home}/.bun/bin/bun`, fake);
    chmodSync(`${f.home}/.bun/bin/bun`, 0o755);
    copyFileSync(join(ROOT, "install.sh"), `${f.dl}/install.sh`);
    const r = run(f, `${f.dl}/install.sh`, "\n");
    expect(r.code).toBe(0);
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
    expect(r.code).toBe(0);
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
  }, 60000);

  test("отказ от установки Bun — выход без изменений; ошибка клона — подсказка про доступ", () => {
    const f = sandbox();
    fakes(f.bin);
    copyFileSync(join(ROOT, "install.sh"), `${f.dl}/install.sh`);
    const no = run(f, `${f.dl}/install.sh`, "\n");
    expect(no.code).toBe(1);
    expect(existsSync(`${f.home}/.bun`)).toBe(false);
    const bad = run(f, `${f.dl}/install.sh`, "y\n\n", `${f.dir}/nope.git`);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("gh auth login");
    expect(bad.out).toContain("MIKSY_REPO=git@github.com:");
  }, 60000);
});

// Запуск PowerShell на раннерах GitHub Windows — до ~50 с на тест: лимит с запасом
describe.skipIf(!win)("install.ps1", () => {
  const fakes = (f: ReturnType<typeof sandbox>) => {
    // Официальный установщик: powershell -c "irm bun.sh/install.ps1 | iex" → кладёт bun.cmd
    put(`${f.dir}/fakebun.cmd`, `@echo off\r\nif "%~1"=="--version" (echo 1.3.14& exit /b 0)\r\necho %CD% %*> "%USERPROFILE%\\bun-args"\r\n`);
    put(`${f.bin}/powershell.cmd`, `@echo off\r\necho %*>> "%USERPROFILE%\\ps-args"\r\nmkdir "%USERPROFILE%\\.bun\\bin" 2>nul\r\ncopy /y "${f.dir.replaceAll("/", "\\")}\\fakebun.cmd" "%USERPROFILE%\\.bun\\bin\\bun.cmd" >nul\r\n`);
  };
  const run = (f: ReturnType<typeof sandbox>, script: string, stdin: string, repo = f.bare) => {
    const sys = process.env.SystemRoot ?? "C:\\Windows";
    const git = dirname(Bun.which("git")!);
    const r = Bun.spawnSync([`${sys}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "--yes"], {
      cwd: f.dir, stdin: Buffer.from(stdin), stdout: "pipe", stderr: "pipe",
      env: { USERPROFILE: f.home, HOME: f.home, SystemRoot: sys, PATHEXT: ".COM;.EXE;.BAT;.CMD", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: `${f.home}/.gitconfig`,
        PATH: [f.bin.replaceAll("/", "\\"), `${sys}\\System32`, `${sys}\\System32\\WindowsPowerShell\\v1.0`, git].join(";"), MIKSY_REPO: repo },
    });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  };

  test("нет Bun — официальный установщик после «y», клон движка, мастер с аргументами", () => {
    const f = sandbox();
    fakes(f);
    copyFileSync(join(ROOT, "install.ps1"), `${f.dl}/install.ps1`);
    const r = run(f, `${f.dl}/install.ps1`, "y\r\n\r\n");
    expect(r.code).toBe(0);
    expect(readFileSync(`${f.home}/ps-args`, "utf8")).toContain("irm bun.sh/install.ps1 | iex");
    const dest = `${f.home}/Projects/miksy`;
    expect(existsSync(`${dest}/src/cli.ts`)).toBe(true);
    expect(readFileSync(`${f.home}/bun-args`, "utf8").trim().toLowerCase()).toBe(`${dest.replaceAll("/", "\\")} src/cli.ts setup "--yes"`.toLowerCase());

    const again = run(f, `${dest}/install.ps1`, "");
    expect(again.code === 0 ? "" : `код ${again.code}; вывод install.ps1:
${again.out}`).toBe("");
    expect(again.out).toContain("1.3.14");
    expect(existsSync(`${f.home}/ps-args`) && readFileSync(`${f.home}/ps-args`, "utf8").split("\n").filter(Boolean).length).toBe(1);
  }, 180000);

  test("две установки Bun (PATH и ~/.bun/bin) — какая используется, совет оставить одну; ничего не удаляется", () => {
    const f = sandbox();
    fakes(f);
    copyFileSync(`${f.dir}/fakebun.cmd`, `${f.bin}/bun.cmd`);
    put(`${f.home}/.bun/bin/bun.cmd`, readFileSync(`${f.dir}/fakebun.cmd`, "utf8"));
    copyFileSync(join(ROOT, "install.ps1"), `${f.dl}/install.ps1`);
    const r = run(f, `${f.dl}/install.ps1`, "\r\n");
    expect(r.code).toBe(0);
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
  }, 180000);

  test("в репо есть ветка stable — клон на ней (последний релиз); без неё — ветка по умолчанию", () => {
    const f = sandbox({ stable: true });
    fakes(f);
    copyFileSync(join(ROOT, "install.ps1"), `${f.dl}/install.ps1`);
    const r = run(f, `${f.dl}/install.ps1`, "y\r\n\r\n");
    expect(r.code).toBe(0);
    const dest = `${f.home}/Projects/miksy`;
    expect(Bun.spawnSync(["git", "-C", dest, "symbolic-ref", "--short", "HEAD"]).stdout.toString().trim()).toBe("stable");
    expect(existsSync(`${dest}/RELEASE`)).toBe(true);
    expect(r.out).toContain("ветка stable");
    const plain = sandbox();
    fakes(plain);
    copyFileSync(join(ROOT, "install.ps1"), `${plain.dl}/install.ps1`);
    expect(run(plain, `${plain.dl}/install.ps1`, "y\r\n\r\n").out).not.toContain("ветка stable");
    expect(Bun.spawnSync(["git", "-C", `${plain.home}/Projects/miksy`, "symbolic-ref", "--short", "HEAD"]).stdout.toString().trim()).not.toBe("stable");
  }, 180000);

  test("отказ от установки Bun — выход без изменений; ошибка клона — подсказка про доступ", () => {
    const f = sandbox();
    fakes(f);
    copyFileSync(join(ROOT, "install.ps1"), `${f.dl}/install.ps1`);
    const no = run(f, `${f.dl}/install.ps1`, "\r\n");
    expect(no.code).toBe(1);
    expect(existsSync(`${f.home}/.bun`)).toBe(false);
    const bad = run(f, `${f.dl}/install.ps1`, "y\r\n\r\n", `${f.dir}/nope.git`);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("gh auth login");
  }, 180000);
});
