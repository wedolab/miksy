// Запись файлов: права, симлинки, временный файл, отказ при неудачной замене, +x у скриптов skills
import { describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claude } from "../adapters/claude";
import { apply, plan } from "../src/apply";
import { emptyState, fileMode, writeAtomic } from "../src/manifest";
import type { Machine, Resolved } from "../src/types";

const win = process.platform === "win32";
const dir = () => mkdtempSync(join(tmpdir(), "write-")).replaceAll("\\", "/");

test("fileMode: существующие права сохраняются, +x — где есть чтение", () => {
  expect(fileMode(undefined, false)).toBeUndefined();
  expect(fileMode(undefined, true)).toBe(0o755);
  expect(fileMode(0o600, false)).toBe(0o600);
  expect(fileMode(0o600, true)).toBe(0o700);
  expect(fileMode(0o644, true)).toBe(0o755);
});

describe("writeAtomic", () => {
  test("занятое имя временного файла не мешает записи", () => {
    const d = dir();
    mkdirSync(`${d}/a.json.miksy-tmp`);
    writeAtomic(`${d}/a.json`, "{}");
    expect(readFileSync(`${d}/a.json`, "utf8")).toBe("{}");
  });

  test("симлинк на файл: пишем в цель, ссылка остаётся ссылкой", () => {
    const d = dir();
    mkdirSync(`${d}/dotfiles`);
    writeFileSync(`${d}/dotfiles/CLAUDE.md`, "old");
    symlinkSync(`${d}/dotfiles/CLAUDE.md`, `${d}/CLAUDE.md`, "file");
    writeAtomic(`${d}/CLAUDE.md`, "new");
    expect(lstatSync(`${d}/CLAUDE.md`).isSymbolicLink()).toBe(true);
    expect(readFileSync(`${d}/dotfiles/CLAUDE.md`, "utf8")).toBe("new");
  });

  test("битый симлинк — отказ, а не замена ссылки файлом", () => {
    const d = dir();
    symlinkSync(`${d}/missing.md`, `${d}/link.md`, "file");
    expect(() => writeAtomic(`${d}/link.md`, "x")).toThrow("симлинк");
    expect(lstatSync(`${d}/link.md`).isSymbolicLink()).toBe(true);
  });

  test.skipIf(win)("права существующего файла сохраняются (0600)", () => {
    const d = dir();
    writeFileSync(`${d}/.claude.json`, "{}");
    chmodSync(`${d}/.claude.json`, 0o600);
    writeAtomic(`${d}/.claude.json`, '{"a":1}');
    expect(statSync(`${d}/.claude.json`).mode & 0o777).toBe(0o600);
  });

  // Файл, открытый другим процессом без FILE_SHARE_DELETE: rename невозможен, а прямая запись прошла бы
  const hold = async (path: string, ms: number) => {
    const ps = `$f=[System.IO.File]::Open($env:HOLD_PATH,'Open','ReadWrite','ReadWrite'); [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); Start-Sleep -Milliseconds ${ms}; $f.Close()`;
    const p = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps], { env: { ...process.env, HOLD_PATH: path }, stdout: "pipe" });
    const reader = p.stdout.getReader();
    let text = "";
    while (!text.includes("locked")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("не удалось заблокировать файл");
      text += new TextDecoder().decode(value);
    }
    return p;
  };

  test.skipIf(!win)("файл занят другим процессом — отказ, файл не изменён, временный удалён", async () => {
    const d = dir();
    writeFileSync(`${d}/c.json`, "old");
    const p = await hold(`${d}/c.json`, 6000);
    try {
      expect(() => writeAtomic(`${d}/c.json`, "new")).toThrow("занят");
    } finally {
      p.kill();
      await p.exited;
    }
    expect(readFileSync(`${d}/c.json`, "utf8")).toBe("old");
    expect(readdirSync(d)).toEqual(["c.json"]);
  }, 20000);

  test.skipIf(!win)("блокировка снята за время повторов — запись удаётся", async () => {
    const d = dir();
    writeFileSync(`${d}/c.json`, "old");
    const p = await hold(`${d}/c.json`, 300);
    writeAtomic(`${d}/c.json`, "new");
    await p.exited;
    expect(readFileSync(`${d}/c.json`, "utf8")).toBe("new");
  }, 20000);
});

describe.skipIf(win)("скрипты skills: исполняемый бит", () => {
  test("+x источника доставляется в проект, без +x — обычный файл", () => {
    const d = dir();
    const skill = `${d}/skill`;
    mkdirSync(`${skill}/scripts`, { recursive: true });
    writeFileSync(`${skill}/SKILL.md`, "---\nname: s\ndescription: d\n---\n");
    writeFileSync(`${skill}/scripts/run.sh`, "#!/bin/sh\necho hi\n");
    chmodSync(`${skill}/scripts/run.sh`, 0o755);
    const project = `${d}/project`;
    mkdirSync(project);
    Bun.spawnSync(["git", "init", "--quiet", project]);
    const machine: Machine = { workspace: d, os: "linux", home: `${d}/home`, vars: {} };
    const cfg: Resolved = { layers: ["l"], instructions: [], mcp: [], notes: [], skills: [{ item: { name: "s", dir: skill }, layer: "l" }] };
    const target = { scope: "project" as const, dir: project, rel: "project" };
    const r = claude.render(cfg, target, machine);
    expect(r.files.find((f) => f.path.endsWith("run.sh"))).toMatchObject({ executable: true });
    apply(plan(r, target, machine, emptyState(), false), emptyState());
    expect(statSync(`${project}/.claude/skills/s/scripts/run.sh`).mode & 0o111).not.toBe(0);
    expect(statSync(`${project}/.claude/skills/s/SKILL.md`).mode & 0o111).toBe(0);
  });
});
