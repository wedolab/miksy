// Защита прогона (test/guard.ts) и окружение подпроцессов: запуск без env получает песочное окружение
// (Bun на Windows отдал бы подпроцессу исходное окружение процесса bun — настоящий USERPROFILE, без MIKSY_CONFIG),
// а git в тестах не читает настройки машины (глобальный gitignore прятал бы файлы, которые проверяют тесты)
import { expect, test } from "bun:test";
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { canonical, fold, inside } from "../src/paths";
import { put } from "./helpers";

const PRINT = "console.log(JSON.stringify({ HOME: process.env.HOME ?? null, USERPROFILE: process.env.USERPROFILE ?? null, MIKSY_CONFIG: process.env.MIKSY_CONFIG ?? null }))";
const sandbox = { HOME: process.env.HOME ?? null, USERPROFILE: process.env.USERPROFILE ?? null, MIKSY_CONFIG: process.env.MIKSY_CONFIG ?? null };
const seen = (out: string | Buffer) => JSON.parse(out.toString().trim());

test("подпроцесс без env видит песочные HOME, USERPROFILE и MIKSY_CONFIG — и при запуске массивом, и объектом { cmd }", () => {
  expect(sandbox.MIKSY_CONFIG).toBeTruthy();
  expect(seen(Bun.spawnSync([process.execPath, "-e", PRINT], { stdout: "pipe" }).stdout)).toEqual(sandbox);
  expect(seen(Bun.spawnSync([process.execPath, "-e", PRINT]).stdout)).toEqual(sandbox);
  expect(seen(Bun.spawnSync({ cmd: [process.execPath, "-e", PRINT], stdout: "pipe" }).stdout)).toEqual(sandbox);
});

test("подпроцесс без env видит окружение на момент запуска (переменную, заданную тестом)", async () => {
  process.env.MIKSY_GUARD_PROBE = "probe";
  try {
    const p = Bun.spawn([process.execPath, "-e", "console.log(process.env.MIKSY_GUARD_PROBE ?? '')"], { stdout: "pipe" });
    expect((await new Response(p.stdout).text()).trim()).toBe("probe");
  } finally { delete process.env.MIKSY_GUARD_PROBE; }
});

test("node:child_process без env — тоже песочное окружение", () => {
  expect(seen(nodeSpawnSync(process.execPath, ["-e", PRINT], { encoding: "utf8" }).stdout)).toEqual(sandbox);
});

test("git в тестах не читает настройки машины: все источники конфигурации — в песочнице, глобальный gitignore не прячет файлы", () => {
  const repo = mkdtempSync(join(tmpdir(), "gitenv-")).replaceAll("\\", "/");
  expect(Bun.spawnSync(["git", "init", "-q", repo]).exitCode).toBe(0);
  const origins = Bun.spawnSync(["git", "-C", repo, "config", "--list", "--show-origin"], { stdout: "pipe" }).stdout.toString()
    .split(/\r?\n/).filter(Boolean).map((l) => l.split("\t")[0]);
  // Только файлы песочницы: ни системного и глобального конфига машины, ни настроек из окружения («command line:» —
  // GIT_CONFIG_COUNT/KEY/VALUE, GIT_CONFIG_PARAMETERS)
  expect(origins.filter((o) => !o.startsWith("file:"))).toEqual([]);
  const files = origins.map((o) => o.slice(5));
  const box = fold(canonical(process.env.MIKSY_TEST_SANDBOX!));
  expect(files.filter((f) => !inside(fold(canonical(isAbsolute(f) ? f : join(repo, f))), box))).toEqual([]);
  // Файлы, которые глобальный gitignore пользователя часто прячет: git их видит
  for (const p of [".claude/settings.local.json", "CLAUDE.local.md", ".DS_Store"]) put(`${repo}/${p}`, "x\n");
  const status = Bun.spawnSync(["git", "-C", repo, "status", "--porcelain", "--untracked-files=all"], { stdout: "pipe" }).stdout.toString();
  expect(status.split(/\r?\n/).filter(Boolean).sort()).toEqual(["?? .DS_Store", "?? .claude/settings.local.json", "?? CLAUDE.local.md"]);
});

// Тот же тест в отдельном прогоне, где у машины настройки git заданы окружением (рецензия 6w): preload их убирает
test.skipIf(!!process.env.MIKSY_GUARDENV_NESTED)("настройки git из окружения машины (GIT_CONFIG_COUNT/KEY/VALUE, GIT_CONFIG_PARAMETERS) до тестов не доходят", () => {
  const dir = mkdtempSync(join(tmpdir(), "gitenv-")).replaceAll("\\", "/");
  put(`${dir}/ignore`, "CLAUDE.local.md\n.claude/\n.DS_Store\n");
  const r = Bun.spawnSync([process.execPath, "test", "test/guardenv.test.ts", "-t", "git в тестах не читает настройки машины"], {
    cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
    env: { ...process.env, MIKSY_GUARDENV_NESTED: "1", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.excludesFile", GIT_CONFIG_VALUE_0: `${dir}/ignore`,
      GIT_CONFIG_PARAMETERS: `'core.excludesfile'='${dir}/ignore'` },
  });
  const out = r.stdout.toString() + r.stderr.toString();
  expect({ code: r.exitCode, pass: / 1 pass/.test(out), fail: / [1-9]\d* fail/.test(out) }).toEqual({ code: 0, pass: true, fail: false });
}, 120000);
