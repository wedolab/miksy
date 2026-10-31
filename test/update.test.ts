// miksy update на локальных git-репо в песочнице: «удалённый» репо — bare, движок пользователя — его
// клон (копия src/, adapters/, examples/ этого движка), релизы — теги vX.Y.Z и ветка stable в репо
// владельца (dev), отправленные в bare. Конфигурация, HOME и workspace — свои у каждого теста (cliFixture)
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ask } from "../src/ask";
import { runCommand } from "../src/commands";
import { ENGINE } from "../src/load";
import { canonical } from "../src/paths";
import { changesText, finishUpdate, update } from "../src/update";
import { cliFixture, put } from "./helpers";

const ID = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (dir: string, ...a: string[]) => {
  const r = Bun.spawnSync(["git", "-C", dir, ...a], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...ID } });
  if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};

const entry = (v: string, s: Record<string, string[]>) =>
  `## ${v} — 2026-11-0${v.split(".")[1]}\n\n${Object.entries(s).map(([k, l]) => `### ${k}\n\n${l.join("\n")}\n`).join("\n")}`;
const changelog = (...entries: string[]) => `# Изменения miksy\n\n## Не выпущено\n\n### Новое\n\n${entries.join("\n")}`;
const FIRST = entry("0.1.0", { "Новое": ["- первая версия"] });

// Репо владельца (dev, ветка main, релиз v0.1.0 и stable на нём), удалённый bare и клон пользователя
function repos(o: { stable?: boolean; userBranch?: string } = {}) {
  const dir = canonical(mkdtempSync(join(tmpdir(), "update-")));
  const dev = `${dir}/dev`;
  for (const d of ["src", "adapters", "examples"]) cpSync(join(ENGINE, d), `${dev}/${d}`, { recursive: true });
  put(`${dev}/package.json`, JSON.stringify({ name: "miksy", version: "0.1.0" }, null, 2) + "\n");
  put(`${dev}/CHANGELOG.md`, changelog(FIRST));
  put(`${dev}/.gitattributes`, "* text=auto eol=lf\n");
  git(dev, "init", "-q");
  git(dev, "symbolic-ref", "HEAD", "refs/heads/main");
  git(dev, "add", "-A");
  git(dev, "commit", "-q", "-m", "engine 0.1.0");
  if (o.stable !== false) {
    git(dev, "tag", "-a", "v0.1.0", "-m", "miksy 0.1.0");
    git(dev, "branch", "stable");
  }
  const bare = `${dir}/miksy.git`;
  Bun.spawnSync(["git", "clone", "-q", "--bare", dev, bare]);
  git(dev, "remote", "add", "origin", bare);
  const user = `${dir}/user`;
  const branch = o.userBranch ?? (o.stable === false ? "main" : "stable");
  Bun.spawnSync(["git", "clone", "-q", "-b", branch, bare, user]);
  // Выпуск в dev: версия, запись CHANGELOG, код (patch — правка файла движка), тег, stable → отправка
  const release = (v: string, s: Record<string, string[]>, patch?: (dev: string) => void) => {
    const log = readFileSync(`${dev}/CHANGELOG.md`, "utf8").replace(/(## Не выпущено\n\n### Новое\n\n)/, `$1${entry(v, s)}\n`);
    writeFileSync(`${dev}/CHANGELOG.md`, log);
    writeFileSync(`${dev}/package.json`, JSON.stringify({ name: "miksy", version: v }, null, 2) + "\n");
    patch?.(dev);
    git(dev, "add", "-A");
    git(dev, "commit", "-q", "-m", `Release ${v}`);
    git(dev, "tag", "-a", `v${v}`, "-m", `miksy ${v}`);
    git(dev, "branch", "-f", "stable", "HEAD");
    git(dev, "push", "-q", "origin", "main", "stable", `v${v}`);
  };
  const devCommit = (file: string) => {
    put(`${dev}/${file}`, "x\n");
    git(dev, "add", "-A");
    git(dev, "commit", "-q", "-m", `dev ${file}`);
    git(dev, "push", "-q", "origin", "main");
  };
  const f = cliFixture();
  // CLI клона пользователя с конфигурацией и HOME песочницы
  const run = (args: string[]) => {
    const r = Bun.spawnSync([process.execPath, `${user}/src/cli.ts`, ...args], {
      cwd: dir, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { ...process.env, ...ID, MIKSY_CONFIG: f.config, HOME: f.home, USERPROFILE: f.home },
    });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  };
  const head = () => git(user, "rev-parse", "HEAD");
  const branchOf = () => git(user, "symbolic-ref", "--short", "HEAD");
  return { dir, dev, bare, user, f, run, release, devCommit, head, branchOf };
}

// Новый код в выпуске: заголовок шагов после обновления с меткой — видно, что их выполнил новый движок
const NEW_CODE = (dev: string) => {
  const p = `${dev}/src/update.ts`;
  writeFileSync(p, readFileSync(p, "utf8").replace("── После обновления (шаги miksy", "── После обновления [новый код] (шаги miksy"));
};

describe("miksy update — ветка stable", () => {
  test("новой версии нет — «у вас последняя версия», ничего не меняется", () => {
    const r = repos();
    const before = r.head();
    const out = r.run(["update"]);
    expect(out.code).toBe(0);
    expect(out.out).toContain("У вас последняя версия: 0.1.0");
    expect(r.head()).toBe(before);
    expect(r.run(["update", "--check"]).out).toContain("У вас последняя версия: 0.1.0");
  }, 60000);

  test("--check только сообщает о новой версии и ничего не меняет в репо (без fetch)", () => {
    const r = repos();
    r.release("0.2.0", { "Новое": ["- новая команда"] });
    const refs = () => git(r.user, "for-each-ref", "--format=%(refname) %(objectname)");
    const before = refs();
    const out = r.run(["update", "--check"]);
    expect(out.code).toBe(0);
    expect(out.out).toContain("Есть новая версия: 0.2.0; у вас 0.1.0");
    expect(refs()).toBe(before);
    expect(git(r.user, "tag")).toBe("v0.1.0");
  }, 60000);

  test("без терминала — изменения с «Ломает» и «После обновления», обновление только с --yes; затем новым кодом setup, doctor, план", () => {
    const r = repos();
    r.release("0.2.0", { "Новое": ["- команда X"], "Ломает": ["- ключ foo в layer.yaml переименован в bar"], "После обновления": ["- miksy sync --all"] }, NEW_CODE);
    r.release("0.2.1", { "Исправлено": ["- ошибка Y"] });
    const before = r.head();
    const no = r.run(["update"]);
    expect(no.code).toBe(1);
    expect(no.out).toContain("Новая версия: 0.2.1; у вас 0.1.0");
    expect(no.out).toContain("## 0.2.1");
    expect(no.out).toContain("## 0.2.0");
    expect(no.out).not.toContain("## 0.1.0");
    expect(no.out).toMatch(/ВНИМАНИЕ — ломает[^\n]*\n  0\.2\.0: - ключ foo в layer\.yaml переименован в bar/);
    expect(no.out).toMatch(/После обновления нужно:\n  0\.2\.0: - miksy sync --all/);
    expect(no.out).toContain("только с --yes");
    expect(r.head()).toBe(before);

    const yes = r.run(["update", "--yes"]);
    expect(yes.code).toBe(0);
    expect(r.head()).toBe(git(r.bare, "rev-parse", "stable"));
    expect(r.branchOf()).toBe("stable");
    expect(yes.out).toContain("✓ движок обновлён: 0.1.0 → 0.2.1");
    // Шаги после обновления — новый код (метка из выпуска 0.2.0)
    expect(yes.out).toContain("── После обновления [новый код] (шаги miksy 0.2.1)");
    expect(yes.out).toMatch(/После обновления нужно \(CHANGELOG\):\n  0\.2\.0: - miksy sync --all/);
    expect(yes.out).toContain("miksy doctor — версия 0.2.1; агенты:");
    expect(yes.out).toMatch(/глобально: создать \d+/);
    expect(yes.out).toContain("Записать настройки агентам (агенту — после «да» пользователя): miksy sync --global и miksy sync --all");
    // setup --yes: команда miksy создана из обновлённого движка; агентам ничего не записано
    const shim = `${r.f.home}/.bun/bin/${process.platform === "win32" ? "miksy.cmd" : "miksy"}`;
    expect(readFileSync(shim, "utf8")).toContain(`${r.user}/src/cli.ts`);
    expect(existsSync(`${r.f.config}/local/state/manifest.json`)).toBe(false);
    expect(existsSync(`${r.f.home}/.claude/CLAUDE.md`)).toBe(false);
    expect(r.run(["--version"]).out.trim()).toBe("miksy 0.2.1");
  }, 120000);

  test("незакоммиченные правки в движке — отказ, правки и HEAD на месте", () => {
    const r = repos();
    r.release("0.2.0", { "Новое": ["- x"] });
    const before = r.head();
    const file = `${r.user}/src/explain.ts`;
    writeFileSync(file, readFileSync(file, "utf8") + "\n// моя правка\n");
    const out = r.run(["update", "--yes"]);
    expect(out.code).toBe(1);
    expect(out.out).toContain("незакоммиченные правки");
    expect(out.out).toContain("src/explain.ts");
    expect(out.out).toContain("stash");
    expect(r.head()).toBe(before);
    expect(readFileSync(file, "utf8")).toContain("// моя правка");
    // --check с правками работает и предупреждает
    expect(r.run(["update", "--check"]).out).toContain("незакоммиченные правки");
  }, 60000);

  test("не fast-forward (свой коммит в stable) — отказ с объяснением, ничего не перезаписано", () => {
    const r = repos();
    r.release("0.2.0", { "Новое": ["- x"] });
    put(`${r.user}/mine.txt`, "моё\n");
    git(r.user, "add", "-A");
    git(r.user, "commit", "-q", "-m", "mine");
    const before = r.head();
    const out = r.run(["update", "--yes"]);
    expect(out.code).toBe(1);
    expect(out.out).toContain("разошлась с origin/stable");
    expect(out.out).toContain("branch stable-mine");
    expect(r.head()).toBe(before);
    expect(existsSync(`${r.user}/mine.txt`)).toBe(true);
  }, 60000);

  test("detached HEAD, чужая ветка, --main не на main — отказ", () => {
    const r = repos();
    git(r.user, "checkout", "-q", "--detach");
    expect(r.run(["update"]).out).toContain("detached HEAD");
    git(r.user, "checkout", "-q", "-b", "feature");
    expect(r.run(["update"]).out).toContain("движок на ветке feature");
    git(r.user, "checkout", "-q", "stable");
    expect(r.run(["update", "--main"]).out).toContain("--main — обновление ветки разработки main");
    expect(r.run(["update", "--check", "--yes"]).code).toBe(2);
  }, 60000);

  test("движок не git-клон — отказ", () => {
    const r = repos();
    const copy = `${r.dir}/copy`;
    for (const d of ["src", "adapters"]) cpSync(`${r.user}/${d}`, `${copy}/${d}`, { recursive: true });
    cpSync(`${r.user}/package.json`, `${copy}/package.json`);
    const out = Bun.spawnSync([process.execPath, `${copy}/src/cli.ts`, "update"], { stdout: "pipe", stderr: "pipe",
      env: { ...process.env, MIKSY_CONFIG: r.f.config, HOME: r.f.home, USERPROFILE: r.f.home } });
    expect(out.exitCode).toBe(1);
    expect(out.stderr.toString()).toContain("не git-клон");
    // Сбой самого git (здесь — испорченная настройка в окружении) — его сообщение, а не «не git-клон»
    const broken = Bun.spawnSync([process.execPath, `${r.user}/src/cli.ts`, "update", "--check"], { stdout: "pipe", stderr: "pipe",
      env: { ...process.env, MIKSY_CONFIG: r.f.config, HOME: r.f.home, USERPROFILE: r.f.home, GIT_CONFIG_COUNT: "1" } });
    expect(broken.exitCode).toBe(1);
    expect(broken.stderr.toString()).toContain("git в каталоге движка не работает");
    expect(Bun.spawnSync([process.execPath, `${copy}/src/cli.ts`, "--version"]).stdout.toString().trim()).toBe("miksy 0.1.0");
  }, 60000);
});

describe("miksy update — ветка main (тестеры, склонировавшие main)", () => {
  test("stable есть — объяснение и переход только с --yes; после перехода — ветка stable, не detached", () => {
    const r = repos({ userBranch: "main" });
    r.release("0.2.0", { "Новое": ["- x"] }, NEW_CODE);
    r.devCommit("unreleased.txt");
    const no = r.run(["update"]);
    expect(no.code).toBe(1);
    expect(no.out).toContain("ветке разработки main");
    expect(no.out).toContain("Перейти на stable: 0.1.0 → 0.2.0");
    expect(no.out).toContain("только с --yes");
    expect(r.branchOf()).toBe("main");
    expect(r.run(["update", "--check"]).out).toContain("Последний релиз — 0.2.0 (ветка stable)");

    const yes = r.run(["update", "--yes"]);
    expect(yes.code).toBe(0);
    expect(r.branchOf()).toBe("stable");
    expect(r.head()).toBe(git(r.bare, "rev-parse", "stable"));
    expect(git(r.user, "rev-parse", "--abbrev-ref", "stable@{upstream}")).toBe("origin/stable");
    expect(existsSync(`${r.user}/unreleased.txt`)).toBe(false);
    expect(yes.out).toContain("[новый код]");
    // Дальше — обычное обновление stable
    r.release("0.2.1", { "Исправлено": ["- y"] });
    expect(r.run(["update", "--yes"]).out).toContain("0.2.0 → 0.2.1");
  }, 120000);

  test("локальные правки на main — переход не начинается", () => {
    const r = repos({ userBranch: "main" });
    writeFileSync(`${r.user}/package.json`, readFileSync(`${r.user}/package.json`, "utf8") + "\n");
    const out = r.run(["update", "--yes"]);
    expect(out.code).toBe(1);
    expect(out.out).toContain("незакоммиченные правки");
    expect(r.branchOf()).toBe("main");
  }, 60000);

  test("stable ещё нет — остаться на main; --main обновляет main fast-forward", () => {
    const r = repos({ stable: false });
    const out = r.run(["update"]);
    expect(out.code).toBe(0);
    expect(out.out).toContain("ещё нет ветки stable");
    expect(r.run(["update", "--check"]).out).toContain("Релизов (ветки stable) в удалённом репо ещё нет");
    r.devCommit("next.txt");
    expect(r.run(["update", "--check"]).out).toContain("В main есть новые коммиты");
    const before = r.head();
    const main = r.run(["update", "--main", "--yes"]);
    expect(main.code).toBe(0);
    expect(r.head()).not.toBe(before);
    expect(r.head()).toBe(git(r.bare, "rev-parse", "main"));
    expect(r.branchOf()).toBe("main");
    expect(r.run(["update", "--main"]).out).toContain("У вас последняя версия");
  }, 120000);
});

// Вопросы в терминале: сценарий ответов, шаги после обновления — заглушка (в процессе теста)
const answers = (list: boolean[], asked: string[]): Ask => ({
  yes: (q) => { asked.push(q); const a = list.shift(); if (a === undefined) throw new Error(`лишний вопрос: ${q}`); return a; },
  choose: () => null,
  line: () => null,
});

describe("miksy update — вопросы [y/N]", () => {
  test("«нет» — движок не изменён; «да» — обновлён, шаги после обновления с прежней версией", () => {
    const r = repos();
    r.release("0.2.0", { "Новое": ["- x"] });
    const before = r.head();
    const asked: string[] = [];
    const out: string[] = [];
    const finished: string[] = [];
    const opts = { engine: r.user, yes: false, check: false, main: false, log: (s = "") => out.push(s), finish: (e: string, from: string) => { finished.push(from); return 0; } };
    expect(update({ ...opts, ask: answers([false], asked) })).toBe(1);
    expect(asked).toEqual(["Обновить движок до 0.2.0?"]);
    expect(out.join("\n")).toContain("Отменено, движок не изменён.");
    expect(r.head()).toBe(before);
    expect(finished).toEqual([]);
    expect(update({ ...opts, ask: answers([true], asked) })).toBe(0);
    expect(r.head()).toBe(git(r.bare, "rev-parse", "stable"));
    expect(finished).toEqual(["0.1.0"]);
  }, 60000);
});

describe("шаги после обновления (update --finish)", () => {
  let saved: Record<string, string | undefined> = {};
  beforeEach(() => { saved = { ...process.env }; });
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });

  test("в терминале — вопрос «Записать настройки агентам?»: «да» — sync --global и --all, «нет» — подсказка", () => {
    const r = repos();
    Object.assign(process.env, { MIKSY_CONFIG: r.f.config, HOME: r.f.home, USERPROFILE: r.f.home, BUN_INSTALL: `${r.dir}/bun` });
    const out: string[] = [];
    const asked: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
    try {
      expect(finishUpdate({ from: "0.1.0", ask: answers([false], asked), run: runCommand, engine: r.user, log: (s = "") => out.push(s) })).toBe(0);
      expect(out.join("\n")).toContain("Не записано. Позже: miksy sync --global и miksy sync --all");
      expect(existsSync(`${r.f.home}/.claude/CLAUDE.md`)).toBe(false);
      expect(finishUpdate({ from: "0.1.0", ask: answers([true], asked), run: runCommand, engine: r.user, log: (s = "") => out.push(s) })).toBe(0);
    } finally { console.log = orig; }
    expect(asked.every((q) => /Записать настройки агентам/.test(q))).toBe(true);
    expect(out.join("\n")).toContain("$ miksy sync --global");
    expect(readFileSync(`${r.f.home}/.claude/CLAUDE.md`, "utf8")).toContain("# global");
    // Настройки уже записаны — повторно не спрашивает
    out.length = 0;
    expect(finishUpdate({ from: "0.1.0", ask: answers([], asked), run: runCommand, engine: r.user, log: (s = "") => out.push(s) })).toBe(0);
    expect(out.join("\n")).toContain("Записывать агентам нечего");
  }, 120000);
});

describe("изменения между версиями (CHANGELOG)", () => {
  const text = changelog(
    entry("0.3.0", { "Ломает": ["- формат X"], "После обновления": ["- miksy sync --global"] }),
    entry("0.2.0", { "Исправлено": ["- Y"] }),
    FIRST,
  );
  test("записи (from, to] от новой к старой; «Ломает» и «После обновления» отдельно", () => {
    const lines = changesText(text, "0.1.0", "0.3.0").join("\n");
    expect(lines.indexOf("## 0.3.0")).toBeLessThan(lines.indexOf("## 0.2.0"));
    expect(lines).not.toContain("## 0.1.0");
    expect(lines).toContain("ВНИМАНИЕ — ломает (прочитайте до обновления):\n  0.3.0: - формат X");
    expect(lines).toContain("После обновления нужно:\n  0.3.0: - miksy sync --global");
    expect(changesText(text, "0.2.0", "0.2.0").join("\n")).toContain("записей в CHANGELOG.md для этих версий нет");
    expect(changesText(null, "0.1.0", "0.2.0")[0]).toContain("CHANGELOG.md в новой версии нет");
    expect(changesText("## странно\n", "0.1.0", "0.2.0")[0]).toContain("не разбирается");
  });
});
