// Команда выпуска bun run release (scripts/release.ts) на песочнице: репо владельца с bare-репо как
// удалённым; номер — по записи «Не выпущено» в CHANGELOG.md. gh в PATH нет — GitHub Release не создаётся
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { nextVersion, parseChangelog, releaseText, unreleasedTemplate } from "../src/changelog";
import { canonical } from "../src/paths";
import { put } from "./helpers";

const SCRIPT = join(import.meta.dir, "..", "scripts", "release.ts");
const ID = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (dir: string, ...a: string[]) => {
  const r = Bun.spawnSync(["git", "-C", dir, ...a], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...ID } });
  return { code: r.exitCode, out: r.stdout.toString().trim() };
};
// Дата выпуска — местная дата процесса: у скрипта и теста один пояс (UTC)
const TODAY = new Date().toISOString().slice(0, 10);
const LOG = `# Изменения miksy\n\nВступление.\n\n${unreleasedTemplate()}\n## 0.1.0 — 2026-11-01\n\n### Новое\n\n- первый выпуск\n`;

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
  git(dev, "remote", "add", "origin", bare);
  // PATH без каталогов с gh: пуш в bare идёт, GitHub Release — подсказкой. Только каталог git нельзя:
  // git из mingw64\bin (так его находит Git Bash) без остального PATH Git for Windows падает при push
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const gh = process.platform === "win32" ? "gh.exe" : "gh";
  const path = (process.env[key] ?? "").split(delimiter).filter((p) => p && !existsSync(join(p, gh))).join(delimiter);
  const run = (...args: string[]) => {
    const r = Bun.spawnSync([process.execPath, SCRIPT, ...args], {
      cwd: dev, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { ...process.env, ...ID, TZ: "UTC", [key]: path },
    });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  };
  const addLine = (section: string, line: string) => {
    const text = readFileSync(`${dev}/CHANGELOG.md`, "utf8");
    const at = text.indexOf(`### ${section}\n`, text.indexOf("## Не выпущено"));
    writeFileSync(`${dev}/CHANGELOG.md`, text.slice(0, at) + `### ${section}\n\n${line}\n` + text.slice(at + `### ${section}\n`.length));
    git(dev, "commit", "-q", "-am", `add ${section}`);
  };
  const version = () => JSON.parse(readFileSync(`${dev}/package.json`, "utf8")).version;
  return { dir, dev, bare, run, addLine, version };
}

describe("bun run release", () => {
  test("первый выпуск: версия из package.json без тега — тег, stable, дата в CHANGELOG; без --push — только подсказка", () => {
    const r = repo();
    const dry = r.run("--dry-run");
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("Выпуск miksy 0.1.0 (первый");
    expect(dry.out).toContain("- первый выпуск");
    expect(dry.out).toContain("--dry-run: ничего не изменено");
    expect(git(r.dev, "tag").out).toBe("");
    const no = r.run();
    expect(no.code).toBe(1);
    expect(no.out).toContain("Без терминала — только с --yes");
    expect(git(r.dev, "tag").out).toBe("");

    const yes = r.run("--yes");
    expect(yes.code).toBe(0);
    expect(git(r.dev, "tag").out).toBe("v0.1.0");
    expect(git(r.dev, "rev-parse", "stable").out).toBe(git(r.dev, "rev-parse", "v0.1.0^{commit}").out);
    expect(git(r.dev, "symbolic-ref", "--short", "HEAD").out).toBe("main");
    expect(readFileSync(`${r.dev}/CHANGELOG.md`, "utf8")).toContain(`## 0.1.0 — ${TODAY}`);
    expect(yes.out).toContain("Не отправлено");
    expect(yes.out).toContain("git push --atomic origin main stable v0.1.0");
    expect(git(r.bare, "tag").out).toBe("");
    // Повтор — выпускать нечего
    const again = r.run("--yes");
    expect(again.code).toBe(1);
    expect(again.out).toContain("выпускать нечего");
  }, 60000);

  test("номер по «Не выпущено»: Исправлено → PATCH, Новое и Ломает (0.x) → MINOR; --push — main, stable и тег в удалённый репо", () => {
    const r = repo();
    expect(r.run("--yes").code).toBe(0); // 0.1.0
    r.addLine("Исправлено", "- поправлено X");
    const fix = r.run("--yes");
    expect(fix.code).toBe(0);
    expect(r.version()).toBe("0.1.1");
    expect(git(r.dev, "log", "-1", "--format=%s").out).toBe("Release 0.1.1");
    const text = readFileSync(`${r.dev}/CHANGELOG.md`, "utf8");
    const entries = parseChangelog(text).entries;
    expect(entries.map((e) => e.version)).toEqual([null, "0.1.1", "0.1.0"]);
    expect(entries[0].sections).toEqual({ "Новое": [], "Исправлено": [], "Ломает": [], "После обновления": [] });
    expect(entries[1]).toMatchObject({ date: TODAY, sections: { "Исправлено": ["- поправлено X"] } });
    // Аннотация тега — текст записи (для gh release create --notes-from-tag), «###» не вырезаны
    expect(git(r.dev, "tag", "-l", "--format=%(contents)", "v0.1.1").out).toBe("### Исправлено\n\n- поправлено X");
    expect(fix.out).toContain('gh release create v0.1.1 --title "miksy 0.1.1" --notes-from-tag');
    expect(text).toStartWith("# Изменения miksy\n\nВступление.\n\n## Не выпущено\n");
    expect(text).not.toMatch(/## 0\.1\.1[\s\S]*### Новое[\s\S]*## 0\.1\.0/); // пустые разделы в выпуск не попадают

    r.addLine("Новое", "- команда Y");
    r.addLine("Ломает", "- формат Z");
    const minor = r.run("--yes", "--push");
    expect(minor.code).toBe(0);
    expect(r.version()).toBe("0.2.0");
    expect(git(r.bare, "tag").out).toBe("v0.2.0"); // отправлен тег этого выпуска (прежние не отправлялись)
    expect(git(r.bare, "rev-parse", "stable").out).toBe(git(r.dev, "rev-parse", "v0.2.0^{commit}").out);
    expect(git(r.bare, "rev-parse", "main").out).toBe(git(r.dev, "rev-parse", "HEAD").out);
    expect(minor.out).toContain("gh не найден");
  }, 60000);

  test("отказы: незакоммиченные изменения, не та ветка, stable не в истории main, неизвестный аргумент", () => {
    const r = repo();
    expect(r.run("--yes").code).toBe(0);
    r.addLine("Исправлено", "- x");
    writeFileSync(`${r.dev}/package.json`, readFileSync(`${r.dev}/package.json`, "utf8") + " ");
    const dirty = r.run("--yes");
    expect(dirty.code).toBe(1);
    expect(dirty.out).toContain("незакоммиченные изменения");
    expect(r.run("--dry-run").code).toBe(0); // показать можно и с правками
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
    expect(behind.code).toBe(1);
    expect(behind.out).toContain("git merge stable");
    expect(r.version()).toBe("0.1.0");
    expect(r.run("--force").code).toBe(2);
  }, 60000);

  test("срочное исправление с ветки stable: выпуск на ней, подсказка слить в main", () => {
    const r = repo();
    expect(r.run("--yes").code).toBe(0);
    git(r.dev, "checkout", "-q", "stable");
    r.addLine("Исправлено", "- срочно");
    const out = r.run("--yes");
    expect(out.code).toBe(0);
    expect(r.version()).toBe("0.1.1");
    expect(git(r.dev, "rev-parse", "stable").out).toBe(git(r.dev, "rev-parse", "v0.1.1^{commit}").out);
    expect(out.out).toContain("git push --atomic origin stable v0.1.1");
    expect(out.out).toContain("git merge stable");
  }, 60000);
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
    const text = `${LOG.replace("### Исправлено\n", "### Исправлено\n\n- y\n")}`;
    const out = releaseText(text, "0.1.1", "2026-12-01");
    expect(out).toContain("## 0.1.1 — 2026-12-01\n\n### Исправлено\n\n- y\n\n## 0.1.0 — 2026-11-01\n\n### Новое\n\n- первый выпуск\n");
    expect(out.indexOf("## Не выпущено")).toBeLessThan(out.indexOf("## 0.1.1"));
    expect(parseChangelog(out).entries.map((x) => x.version)).toEqual([null, "0.1.1", "0.1.0"]);
  });
});
