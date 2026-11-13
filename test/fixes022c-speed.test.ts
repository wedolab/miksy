// Выпуск 0.2.2, круг 8c, C13 (рецензия A №7 проверки 8b): проверка прав local/ без ссылок — не медленнее 0.2.1 (в
// пределах разброса). local/ — 20 запусков бэкапов по 400 файлов; настоящий v0.2.1 — файлы тега во временном каталоге;
// медиана из 7 замеров по очереди
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as now from "../src/secretfiles";
import { hasTag, oldEngine } from "./fixes021b-helpers";

test.skipIf(process.platform !== "win32" || !hasTag("v0.2.1"))("C13: checkLocalAccess без ссылок — не медленнее v0.2.1", async () => {
  const old = await import(join(oldEngine("v0.2.1"), "src", "secretfiles.ts"));
  const local = join(mkdtempSync(join(tmpdir(), "c13-")), "local");
  for (let r = 0; r < 20; r++) for (let d = 0; d < 10; d++) {
    const dir = join(local, "backups", `2026-01-${String(r + 1).padStart(2, "0")}T00-00-00-000Z`, "C", `p${d}`);
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < 40; f++) writeFileSync(join(dir, `f${f}.md`), "x");
  }
  now.privateLocal(local);
  const t = { now: [] as number[], old: [] as number[] };
  for (let i = 0; i < 7; i++) for (const [k, m] of [["now", now], ["old", old]] as const) {
    const s = performance.now();
    expect(m.checkLocalAccess(local).bad).toEqual([]);
    t[k].push(performance.now() - s);
  }
  const median = (a: number[]) => [...a].sort((x, y) => x - y)[3];
  console.log(`C13: эта версия ${Math.round(median(t.now))} мс, v0.2.1 ${Math.round(median(t.old))} мс`);
  expect(median(t.now)).toBeLessThan(median(t.old) * 1.15 + 20);
}, 300000);
