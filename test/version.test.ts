// Версия движка (--version, help, doctor), запись версии в учёт и предупреждения совместимости:
// учёт записан более новой версией, неизвестные ключи map.yaml и layer.yaml
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unknownKeys } from "../src/load";
import { canonical } from "../src/paths";
import { compareVersions, describeEngine, newerLedger, packageVersion } from "../src/version";
import { cliFixture, put } from "./helpers";

const ID = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (dir: string, ...a: string[]) => Bun.spawnSync(["git", "-C", dir, ...a], { stdout: "pipe", env: { ...process.env, ...ID } }).stdout.toString().trim();
const VERSION = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")).version as string;

describe("версия движка", () => {
  const engine = () => {
    const dir = canonical(mkdtempSync(join(tmpdir(), "version-")));
    put(`${dir}/engine/package.json`, JSON.stringify({ name: "miksy", version: "0.3.0" }));
    return { dir, e: `${dir}/engine` };
  };

  test("в духе git describe: на релизе — номер, после — коммитов от релиза и коммит, правки — -dirty", () => {
    const { e } = engine();
    expect(describeEngine(e)).toBe("0.3.0"); // не git
    git(e, "init", "-q");
    git(e, "add", "-A");
    git(e, "commit", "-q", "-m", "one");
    const short = git(e, "rev-parse", "--short", "HEAD");
    expect(describeEngine(e)).toBe(`0.3.0 (коммит ${short})`); // тегов ещё нет
    git(e, "tag", "-a", "v0.3.0", "-m", "0.3.0");
    expect(describeEngine(e)).toBe("0.3.0");
    for (const n of ["a", "b"]) { put(`${e}/${n}`, n); git(e, "add", "-A"); git(e, "commit", "-q", "-m", n); }
    expect(describeEngine(e)).toBe(`0.3.0-2-g${git(e, "rev-parse", "--short", "HEAD")}`);
    writeFileSync(`${e}/a`, "changed");
    expect(describeEngine(e)).toMatch(/^0\.3\.0-2-g[0-9a-f]+-dirty$/);
  });

  test("движок внутри чужого git-репо (workspace) — только номер", () => {
    const { dir, e } = engine();
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "ws");
    expect(describeEngine(e)).toBe("0.3.0");
  });

  test("miksy --version, miksy version, help и doctor показывают версию", () => {
    const f = cliFixture();
    const v = f.run(["--version"]);
    expect(v.code).toBe(0);
    expect(v.out).toMatch(new RegExp(`^miksy ${VERSION.replaceAll(".", "\\.")}`));
    expect(f.run(["version"]).out).toBe(v.out);
    expect(f.run(["version", "x"]).code).toBe(2);
    expect(f.run(["help"]).out.split("\n")[0]).toStartWith(`miksy ${VERSION}`);
    expect(f.run(["doctor"]).out.split("\n")[0]).toStartWith(`miksy doctor — версия ${VERSION}`);
  });

  test("сравнение номеров", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.1.0", "0.1.1")).toBeLessThan(0);
    expect(packageVersion()).toBe(VERSION);
  });
});

describe("совместимость: учёт записан более новой версией", () => {
  test("sync пишет версию движка в учёт; учёт новее — предупреждение в sync и в «Справочно» doctor, ничего не блокируется", () => {
    const f = cliFixture();
    expect(f.run(["sync", "--global"]).code).toBe(0);
    const path = `${f.config}/local/state/manifest.json`;
    const m = JSON.parse(readFileSync(path, "utf8"));
    expect(m.engine).toBe(VERSION);
    expect(newerLedger(m.engine)).toBeNull();
    writeFileSync(path, JSON.stringify({ ...m, engine: "99.0.0" }));
    const doc = f.run(["doctor"]);
    expect(doc.out).toMatch(/Справочно:[\s\S]*Версия: учёт miksy \(local\/state\/manifest\.json\) записан более новой версией движка — 99\.0\.0, а этот движок — [\d.]+: обновите движок \(miksy update\)/);
    const dry = f.run(["sync", "--global", "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("предупреждение: учёт miksy (local/state/manifest.json) записан более новой версией движка — 99.0.0");
    // Запись не блокируется; после неё учёт — этой версии (без изменений sync учёт не переписывает)
    put(`${f.config}/layers/global/instructions/01.md`, "# ещё правило\n");
    expect(f.run(["sync", "--global"]).code).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf8")).engine).toBe(VERSION);
    expect(f.run(["doctor"]).out).not.toContain("более новой версией");
    // Поле неверного типа — как нет поля, учёт не «повреждён»
    writeFileSync(path, JSON.stringify({ ...m, engine: 5 }));
    expect(f.run(["doctor"]).out).not.toContain("учёт повреждён");
  });
});

describe("совместимость: неизвестные ключи map.yaml и layer.yaml", () => {
  test("файл и ключ — в sync и в «Справочно» doctor; известные ключи не названы", () => {
    const f = cliFixture();
    put(`${f.config}/map.yaml`, "global:\n  - { use: global, mach: x }\nlayers: []\nskil_prefix: acme-\ntools: {}\n");
    put(`${f.config}/layers/tree/Org/layer.yaml`, "description: орг\ntrusts: { claude: true }\nimport_skills: auto\n");
    put(`${f.config}/layers/global/layer.yaml`, "description: всё\nexclude: []\n");
    put(`${f.config}/layers/global/skills/s/layer.yaml`, "not: a layer\n"); // внутри skills — не слой
    expect(unknownKeys(f.config)).toEqual(["map.yaml: skil_prefix", "map.yaml: global[0].mach", "layers/tree/Org/layer.yaml: trusts"]);
    const doc = f.run(["doctor"]);
    expect(doc.out).toMatch(/Неизвестные ключи \(3\) — miksy их не читает: опечатка или ключ более новой версии miksy:\n  map\.yaml: skil_prefix\n  map\.yaml: global\[0\]\.mach\n  layers\/tree\/Org\/layer\.yaml: trusts/);
    const dry = f.run(["sync", "--all", "--dry-run"]);
    expect(dry.out).toContain("предупреждение: неизвестные ключи — miksy их не читает (опечатка или ключ более новой версии miksy): map.yaml: skil_prefix, map.yaml: global[0].mach, layers/tree/Org/layer.yaml: trusts");
    // Конфигурация без лишних ключей — без предупреждения
    const clean = cliFixture();
    expect(unknownKeys(clean.config)).toEqual([]);
    expect(clean.run(["doctor"]).out).not.toContain("Неизвестные ключи");
  });
});
