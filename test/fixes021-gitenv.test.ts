// Выпуск 0.2.1, часть A (out/phase-021.md), A18: переменная GIT_TEMPLATE_DIR машины (шаблон git init: info/exclude,
// хуки) до тестов не доходит — test/preload.ts убирает её, как другие переменные git. Тест рецензента:
// out/reviewer-tests/check6w-miksy/test/review6x-gitenv.test.ts — тот же тест guardenv в отдельном прогоне
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { put } from "./helpers";

test.skipIf(!!process.env.MIKSY_GUARDENV_NESTED)("GIT_TEMPLATE_DIR машины (шаблон с info/exclude) до тестов не доходит", () => {
  const tpl = mkdtempSync(join(tmpdir(), "gittpl-")).replaceAll("\\", "/");
  put(`${tpl}/info/exclude`, "CLAUDE.local.md\n.claude/\n.DS_Store\n");
  const r = Bun.spawnSync([process.execPath, "test", "test/guardenv.test.ts", "-t", "git в тестах не читает настройки машины"], {
    cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe",
    env: { ...process.env, MIKSY_GUARDENV_NESTED: "1", GIT_TEMPLATE_DIR: tpl },
  });
  const out = r.stdout.toString() + r.stderr.toString();
  expect({ code: r.exitCode, pass: / 1 pass/.test(out), fail: / [1-9]\d* fail/.test(out) }).toEqual({ code: 0, pass: true, fail: false });
}, 120000);
