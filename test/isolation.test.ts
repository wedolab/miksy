// Тесты не пишут в настоящую конфигурацию и домашний каталог: песочница задаётся в test/preload.ts,
// а корень конфигурации вычисляется при обращении, а не при импорте модуля.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { apply } from "../src/apply";
import { ENGINE } from "../src/load";
import { emptyState, saveManifest } from "../src/manifest";

const saved = process.env.MIKSY_CONFIG;
afterEach(() => {
  process.env.MIKSY_CONFIG = saved;
});
import { homeDir, canonical, inside as contains } from "../src/paths";
const inside = (p: string, dir: string) => contains(canonical(p), canonical(dir));

test("бэкап apply — в конфигурацию, заданную на момент вызова, а не при импорте", () => {
  const config = mkdtempSync(join(tmpdir(), "iso-config-"));
  process.env.MIKSY_CONFIG = config;
  const file = join(mkdtempSync(join(tmpdir(), "iso-target-")), "a.md").replaceAll("\\", "/");
  writeFileSync(file, "old");
  apply([{ kind: "write", abs: file, content: "new", why: "обновление" }], emptyState());
  expect(existsSync(join(config, "local", "backups"))).toBe(true);
  expect(readdirSync(join(config, "local", "backups"))).toHaveLength(1);
});

test("учёт — в конфигурацию, заданную на момент вызова", () => {
  const config = mkdtempSync(join(tmpdir(), "iso-config-"));
  process.env.MIKSY_CONFIG = config;
  saveManifest({ version: 1, targets: {} });
  expect(existsSync(join(config, "local", "state", "manifest.json"))).toBe(true);
});

test("песочница: конфигурация, HOME и tmp — во временном каталоге", () => {
  const sandbox = process.env.MIKSY_TEST_SANDBOX;
  expect(sandbox).toBeTruthy();
  expect(inside(process.env.MIKSY_CONFIG!, sandbox!)).toBe(true);
  expect(inside(homeDir(), sandbox!)).toBe(true);
  expect(inside(tmpdir(), sandbox!)).toBe(true);
  expect(inside(process.env.MIKSY_CONFIG!, join(ENGINE, "..", "miksy-config"))).toBe(false);
});

test("С13: окружение без внешних путей (BUN_INSTALL, XDG_*, CODEX_HOME) — setup в тестах не трогает настоящую команду miksy", () => {
  expect(Object.keys(process.env).filter((k) => /^(BUN_INSTALL|CODEX_HOME|XDG_)/.test(k))).toEqual([]);
});
