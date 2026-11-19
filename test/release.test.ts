// Команда выпуска bun run release (scripts/release.ts) на песочнице: репо владельца с bare-репо как
// удалённым; номер — по записи «Не выпущено» в CHANGELOG.md. gh в PATH нет — GitHub Release не создаётся.
// origin записан адресом GitHub (по нему release узнаёт владельца и репо), git ведёт его в bare-репо (insteadOf);
// ответ GitHub о проверке — из файла MIKSY_RELEASE_CI_FAKE (круг 10g: сети в тестах нет). run пушит текущую ветку
// перед запуском — как владелец, который запушил коммит и дождался проверки; runHere — без пуша
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { nextVersion, parseChangelog, releaseText } from "../src/changelog";
import { canonical } from "../src/paths";
import { put, expectCode, said } from "./helpers";

const SCRIPT = join(import.meta.dir, "..", "scripts", "release.ts");
const ID = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (dir: string, ...a: string[]) => {
  const r = Bun.spawnSync(["git", "-C", dir, ...a], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...ID } });
  return { code: r.exitCode, out: r.stdout.toString().trim() };
};
// Дата выпуска — местная дата процесса: у скрипта и теста один пояс (UTC)
const TODAY = new Date().toISOString().slice(0, 10);
// Пустой заготовки «Не выпущено» нет: запись появляется с первой строкой (круг 10a)
const GH = "https://github.com/t/miksy.git";
const job = (name: string, status: string, conclusion: string | null) => ({ name, status, conclusion, html_url: `https://github.com/t/miksy/actions/runs/1/job/${name.length}` });
const GREEN = { runs: [job("test (ubuntu-latest)", "completed", "success"), job("test (macos-latest)", "completed", "success"), job("test (windows-latest)", "completed", "success")] };
const LOG = `# Изменения miksy\n\nВступление.\n\n## 0.1.0 — 2026-11-01\n\n### Новое\n\n- первый выпуск\n`;

function repo() {
  const dir = canonical(mkdtempSync(join(tmpdir(), "release-")));
  const dev = `${dir}/dev`;
  put(`${dev}/package.json`, `{\n  "name": "miksy",\n  "version": "0.1.0",\n  "private": true\n}\n`);
  put(`${dev}/CHANGELOG.md`, LOG);
  put(`${dev}/.gitattributes`, "* text=auto eol=lf\n");
  git(dev, "init", "-q");
  git(dev, "symbolic-ref", "HEAD", "refs/heads/main");
  git(dev, "add", "-A");
  git(dev, "commit", "-q", "-m", "engine");
  const bare = `${dir}/miksy.git`;
  Bun.spawnSync(["git", "init", "-q", "--bare", bare]);
  git(dev, "remote", "add", "origin", GH);
  git(dev, "config", `url.${bare}.insteadOf`, GH);
  const ci = `${dir}/ci.json`;
  const answer = (a: unknown) => writeFileSync(ci, JSON.stringify(a));
  answer(GREEN);
  // PATH без каталогов с gh: пуш в bare идёт, GitHub Release — подсказкой. Только каталог git нельзя:
  // git из mingw64\bin (так его находит Git Bash) без остального PATH Git for Windows падает при push.
  // На Linux gh и git лежат вместе (/usr/bin) — git тогда через ссылку из отдельного каталога
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const win = process.platform === "win32";
  const dirs = (process.env[key] ?? "").split(delimiter).filter((p) => p && !existsSync(join(p, win ? "gh.exe" : "gh")));
  if (!win) {
    mkdirSync(`${dir}/bin`);
    symlinkSync(Bun.which("git")!, `${dir}/bin/git`);
    dirs.unshift(`${dir}/bin`);
  }
  const path = dirs.join(delimiter);
  const runHere = (...args: string[]) => {
    const r = Bun.spawnSync([process.execPath, SCRIPT, ...args], {
      cwd: dev, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { ...process.env, ...ID, TZ: "UTC", [key]: path, MIKSY_RELEASE_CI_FAKE: ci },
    });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  };
  const run = (...args: string[]) => { git(dev, "push", "-q", "origin", "HEAD"); return runHere(...args); };
  // Как по RELEASING.md: нет «Не выпущено» — создать над последней версией; раздел — в её начало
  const addLine = (section: string, line: string) => {
    let text = readFileSync(`${dev}/CHANGELOG.md`, "utf8");
    if (!text.includes("## Не выпущено\n")) { const at = text.indexOf("\n## ") + 1; text = `${text.slice(0, at)}## Не выпущено\n\n${text.slice(at)}`; }
    const at = text.indexOf("## Не выпущено\n") + "## Не выпущено\n\n".length;
    writeFileSync(`${dev}/CHANGELOG.md`, `${text.slice(0, at)}### ${section}\n\n${line}\n\n${text.slice(at)}`);
    git(dev, "commit", "-q", "-am", `add ${section}`);
  };
  const version = () => JSON.parse(readFileSync(`${dev}/package.json`, "utf8")).version;
  return { dir, dev, bare, run, runHere, answer, addLine, version };
}

describe("bun run release", () => {
  test("первый выпуск: версия из package.json без тега — тег, stable, дата в CHANGELOG; без --push — только подсказка", () => {
    const r = repo();
    const dry = r.run("--dry-run");
    expectCode(dry, 0);
    expect(dry.out).toContain("Выпуск miksy 0.1.0 (первый");
    expect(dry.out).toContain("- первый выпуск");
    expect(dry.out).toContain("--dry-run: ничего не изменено");
    expect(git(r.dev, "tag").out).toBe("");
    const no = r.run();
    expectCode(no, 1);
    expect(no.out).toContain("Без терминала — только с --yes");
    expect(git(r.dev, "tag").out).toBe("");

    const yes = r.run("--yes");
    expectCode(yes, 0);
    expect(git(r.dev, "tag").out).toBe("v0.1.0");
    expect(git(r.dev, "rev-parse", "stable").out).toBe(git(r.dev, "rev-parse", "v0.1.0^{commit}").out);
    expect(git(r.dev, "symbolic-ref", "--short", "HEAD").out).toBe("main");
    expect(readFileSync(`${r.dev}/CHANGELOG.md`, "utf8")).toContain(`## 0.1.0 — ${TODAY}`);
    expect(yes.out).toContain("Не отправлено");
    expect(yes.out).toContain("git push --atomic origin main stable v0.1.0");
    expect(git(r.bare, "tag").out).toBe("");
    // Повтор — выпускать нечего
    const again = r.run("--yes");
    expectCode(again, 1);
    expect(again.out).toContain("выпускать нечего");
  }, 60000);

  test("номер по «Не выпущено»: Исправлено → PATCH, Новое и Ломает (0.x) → MINOR; --push — main, stable и тег в удалённый репо", () => {
    const r = repo();
    expectCode(r.run("--yes"), 0); // 0.1.0
    r.addLine("Исправлено", "- поправлено X");
    const fix = r.run("--yes");
    expectCode(fix, 0);
    expect(r.version()).toBe("0.1.1");
    expect(git(r.dev, "log", "-1", "--format=%s").out).toBe("Release 0.1.1");
    const text = readFileSync(`${r.dev}/CHANGELOG.md`, "utf8");
    const entries = parseChangelog(text).entries;
    // Новой пустой «Не выпущено» нет — сверху выпущенная версия
    expect(entries.map((e) => e.version)).toEqual(["0.1.1", "0.1.0"]);
    expect(entries[0]).toMatchObject({ date: TODAY, sections: { "Исправлено": ["- поправлено X"] } });
    // Аннотация тега — текст записи (для gh release create --notes-from-tag), «###» не вырезаны
    expect(git(r.dev, "tag", "-l", "--format=%(contents)", "v0.1.1").out).toBe("### Исправлено\n\n- поправлено X");
    expect(fix.out).toContain('gh release create v0.1.1 --title "miksy 0.1.1" --notes-from-tag');
    expect(text).toStartWith(`# Изменения miksy\n\nВступление.\n\n## 0.1.1 — ${TODAY}\n`);
    // Выпущено, новых строк нет — выпускать нечего
    const none = r.run("--yes");
    expect({ code: none.code, nothing: none.out.includes("выпускать нечего") }, said(none)).toEqual({ code: 1, nothing: true });
    expect(text).not.toMatch(/## 0\.1\.1[\s\S]*### Новое[\s\S]*## 0\.1\.0/); // пустые разделы в выпуск не попадают

    r.addLine("Новое", "- команда Y");
    r.addLine("Ломает", "- формат Z");
    const minor = r.run("--yes", "--push");
    expectCode(minor, 0);
    expect(r.version()).toBe("0.2.0");
    expect(git(r.bare, "tag").out).toBe("v0.2.0"); // отправлен тег этого выпуска (прежние не отправлялись)
    expect(git(r.bare, "rev-parse", "stable").out).toBe(git(r.dev, "rev-parse", "v0.2.0^{commit}").out);
    expect(git(r.bare, "rev-parse", "main").out).toBe(git(r.dev, "rev-parse", "HEAD").out);
    expect(minor.out).toContain("gh не найден");
  }, 60000);

  test("отказы: незакоммиченные изменения, не та ветка, stable не в истории main, неизвестный аргумент", () => {
    const r = repo();
    expectCode(r.run("--yes"), 0);
    r.addLine("Исправлено", "- x");
    writeFileSync(`${r.dev}/package.json`, readFileSync(`${r.dev}/package.json`, "utf8") + " ");
    const dirty = r.run("--yes");
    expectCode(dirty, 1);
    expect(dirty.out).toContain("незакоммиченные изменения");
    expectCode(r.run("--dry-run"), 0); // показать можно и с правками
    git(r.dev, "checkout", "--", "package.json");
    git(r.dev, "checkout", "-q", "-b", "feature");
    expect(r.run("--yes").out).toContain("выпуск — с ветки main");
    git(r.dev, "checkout", "-q", "main");
    // stable ушла вперёд мимо main (исправление на stable не слито в main)
    git(r.dev, "checkout", "-q", "stable");
    put(`${r.dev}/hotfix.txt`, "x\n");
    git(r.dev, "add", "-A");
    git(r.dev, "commit", "-q", "-m", "hotfix");
    git(r.dev, "checkout", "-q", "main");
    const behind = r.run("--yes");
    expectCode(behind, 1);
    expect(behind.out).toContain("git merge stable");
    expect(r.version()).toBe("0.1.0");
    expectCode(r.run("--force"), 2);
  }, 60000);

  test("срочное исправление с ветки stable: выпуск на ней, подсказка слить в main", () => {
    const r = repo();
    expectCode(r.run("--yes"), 0);
    git(r.dev, "checkout", "-q", "stable");
    r.addLine("Исправлено", "- срочно");
    const out = r.run("--yes");
    expectCode(out, 0);
    expect(r.version()).toBe("0.1.1");
    expect(git(r.dev, "rev-parse", "stable").out).toBe(git(r.dev, "rev-parse", "v0.1.1^{commit}").out);
    expect(out.out).toContain("git push --atomic origin stable v0.1.1");
    expect(out.out).toContain("git merge stable");
  }, 60000);
});

// Круг 10g: выпуск — только при зелёной проверке GitHub последнего коммита; ответ GitHub подменён файлом
describe("bun run release: проверка GitHub", () => {
  const refused = (r: ReturnType<typeof repo>, ...args: string[]) => {
    const head = git(r.dev, "rev-parse", "HEAD").out;
    const out = r.run("--yes", ...args);
    // Отказ до записей: ни тега, ни коммита выпуска, version прежний
    expect({ code: out.code, tag: git(r.dev, "tag").out, head: git(r.dev, "rev-parse", "HEAD").out }, said(out)).toEqual({ code: 1, tag: "", head });
    return out.out;
  };

  test("зелёная — выпуск идёт, в выводе ссылка на проверку коммита", () => {
    const r = repo();
    const sha = git(r.dev, "rev-parse", "HEAD").out;
    const out = r.run("--yes");
    expectCode(out, 0);
    expect(out.out).toContain("Проверка: проверка GitHub зелёная (test (ubuntu-latest), test (macos-latest), test (windows-latest))");
    expect(out.out).toContain(`https://github.com/t/miksy/commit/${sha}/checks`);
    // Подменённый ответ GitHub не выдаётся за настоящий: строка о подмене — и при выпуске, и при отказе
    expect(out.out).toContain("Внимание: ответ GitHub подменён (MIKSY_RELEASE_CI_FAKE) — только для тестов.");
    r.addLine("Исправлено", "- x");
    r.answer({ runs: [] });
    expect(r.run("--yes").out).toContain("ответ GitHub подменён (MIKSY_RELEASE_CI_FAKE)");
  }, 60000);

  test("идёт, упала, отменена, запусков нет, сеть недоступна — отказ с причиной; --dry-run — строка «Выпуск сейчас откажет»", () => {
    const r = repo();
    r.answer({ runs: [job("test (ubuntu-latest)", "completed", "success"), job("test (macos-latest)", "in_progress", null), job("test (macos-latest)", "queued", null)] });
    expect(refused(r)).toContain("проверка GitHub ещё идёт (test (macos-latest)) — повторите позже: https://github.com/t/miksy/commit/");
    const dry = r.run("--dry-run");
    expectCode(dry, 0);
    expect(dry.out).toContain("Выпуск сейчас откажет: проверка GitHub ещё идёт");
    expect(dry.out).toContain("--dry-run: ничего не изменено");

    r.answer({ runs: [job("test (ubuntu-latest)", "completed", "success"), job("test (macos-latest)", "completed", "failure"), job("test (windows-latest)", "completed", "cancelled"), job("lint", "completed", "skipped")] });
    const failed = refused(r);
    expect(failed).toContain("проверка GitHub не прошла: test (macos-latest) — failure; test (windows-latest) — cancelled");
    expect(failed).not.toContain("lint");

    r.answer({ runs: [] });
    expect(refused(r)).toContain("у коммита нет запусков проверки GitHub");
    r.answer({ error: "GitHub недоступен (сеть) — проверьте сеть и повторите" });
    expect(refused(r)).toContain("статус проверки GitHub не узнать: GitHub недоступен");
  }, 60000);

  test("коммит не в origin/main — отказ «сначала запушьте»; origin не GitHub — отказ; --skip-ci — выпуск со строкой о пропуске", () => {
    const r = repo();
    // Ветки main в origin ещё нет — тоже «сначала запушьте», а не сбой сети
    expect(r.runHere("--yes").out).toContain("ещё не в origin/main — сначала запушьте");
    git(r.dev, "push", "-q", "origin", "main");
    git(r.dev, "commit", "-q", "--allow-empty", "-m", "local");
    const head = git(r.dev, "rev-parse", "--short", "HEAD").out;
    const local = r.runHere("--yes");
    expectCode(local, 1);
    expect(local.out).toContain(`коммит ${head} ещё не в origin/main — сначала запушьте его (git push origin main)`);
    expect(git(r.dev, "tag").out).toBe("");
    expect(r.runHere("--dry-run").out).toContain("Выпуск сейчас откажет: коммит");

    r.answer({ runs: [job("test (ubuntu-latest)", "completed", "failure")] });
    const skipped = r.runHere("--yes", "--skip-ci");
    expectCode(skipped, 0);
    expect(skipped.out).toContain("Внимание: проверка GitHub пропущена (--skip-ci).");
    expect(git(r.dev, "tag").out).toBe("v0.1.0");

    git(r.dev, "remote", "set-url", "origin", r.bare);
    r.addLine("Исправлено", "- x");
    const other = r.run("--yes");
    expectCode(other, 1);
    expect(other.out).toContain("origin — не GitHub");
  }, 60000);
});

describe("проверка GitHub: адрес, запрос, вердикт (scripts/ci.ts)", () => {
  test("владелец и репо из адреса origin", async () => {
    const { githubSlug } = await import("../scripts/ci");
    for (const u of ["https://github.com/wedolab/miksy.git", "https://github.com/wedolab/miksy", "git@github.com:wedolab/miksy.git", "ssh://git@github.com/wedolab/miksy.git", "https://github.com/wedolab/miksy/"])
      expect(githubSlug(u)).toEqual({ owner: "wedolab", repo: "miksy" });
    expect(githubSlug("https://gitlab.com/wedolab/miksy.git")).toBeNull();
    expect(githubSlug("/tmp/miksy.git")).toBeNull();
  });

  test("запрос: gh (вошёл) — без сети; gh нет или не вошёл — публичный API; лимит, 404, сеть — понятная причина", async () => {
    const { checkRuns } = await import("../scripts/ci");
    const slug = { owner: "o", repo: "r" };
    const body = { total_count: 1, check_runs: [{ name: "test", status: "completed", conclusion: "success" }] };
    const calls: string[] = [];
    const http = (status: number, json: unknown) => async (url: string) => { calls.push(url); return { status, json }; };
    const viaGh = await checkRuns(slug, "abc", { gh: () => ({ code: 0, out: JSON.stringify(body) }), http: http(500, null) });
    expect({ viaGh, calls }).toEqual({ viaGh: { runs: body.check_runs }, calls: [] });
    expect(await checkRuns(slug, "abc", { gh: () => null, http: http(200, body) })).toEqual({ runs: body.check_runs });
    expect(calls).toEqual(["https://api.github.com/repos/o/r/commits/abc/check-runs?per_page=100"]);
    expect(await checkRuns(slug, "abc", { gh: () => ({ code: 4, out: "" }), http: http(200, body) })).toEqual({ runs: body.check_runs });
    const err = async (deps: Parameters<typeof checkRuns>[2]) => { const r = await checkRuns(slug, "abc", deps); return "error" in r ? r.error : ""; };
    expect(await err({ gh: () => null, http: http(403, {}) })).toContain("лимит запросов без входа");
    expect(await err({ gh: () => null, http: http(404, {}) })).toContain("репо закрытый?");
    expect(await err({ gh: () => null, http: async () => { throw new Error("connect ECONNREFUSED"); } })).toContain("GitHub недоступен (connect ECONNREFUSED)");
  });
});

describe("CHANGELOG: номер и запись выпуска", () => {
  const e = (sections: Record<string, string[]>) => ({ version: null, sections, loose: [] });
  test("SemVer: 0.x — Ломает/Новое → MINOR; с 1.0 — Ломает → MAJOR; пусто — нечего", () => {
    expect(nextVersion("0.4.2", e({ "Ломает": ["- a"] }))).toBe("0.5.0");
    expect(nextVersion("0.4.2", e({ "Новое": ["- a"] }))).toBe("0.5.0");
    expect(nextVersion("0.4.2", e({ "Исправлено": ["- a"] }))).toBe("0.4.3");
    expect(nextVersion("1.4.2", e({ "Ломает": ["- a"], "Новое": ["- b"] }))).toBe("2.0.0");
    expect(nextVersion("1.4.2", e({ "Новое": ["- b"] }))).toBe("1.5.0");
    expect(nextVersion("1.4.2", e({ "Новое": [], "Исправлено": [""] }))).toBeNull();
  });

  test("разбор: непонятный заголовок или раздел — ошибка с номером строки; выпуск сохраняет остальной текст", () => {
    expect(() => parseChangelog("# x\n\n## Новая версия\n")).toThrow("строка 3");
    expect(() => parseChangelog("## Не выпущено\n\n### Прочее\n")).toThrow("раздел «Прочее»");
    // Пустые разделы «Новое», «Ломает» в выпуск не попадают; новой пустой «Не выпущено» нет
    const text = LOG.replace("## 0.1.0", "## Не выпущено\n\n### Новое\n\n### Исправлено\n\n- y\n\n### Ломает\n\n## 0.1.0");
    const out = releaseText(text, "0.1.1", "2026-12-01");
    expect(out).toBe("# Изменения miksy\n\nВступление.\n\n## 0.1.1 — 2026-12-01\n\n### Исправлено\n\n- y\n\n## 0.1.0 — 2026-11-01\n\n### Новое\n\n- первый выпуск\n");
    expect(parseChangelog(out).entries.map((x) => x.version)).toEqual(["0.1.1", "0.1.0"]);
  });
});
