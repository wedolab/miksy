// Круг 11e: тесты не заменяют process.env целиком (process.env = …). Замена делает окружение обычным объектом: на
// Windows process.env.Path перестаёт быть PATH, и следующие тесты процесса (bun test без --parallel) теряют программы.
// Вернуть окружение — restoreEnv из helpers
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

test("ни один тест не заменяет process.env целиком", () => {
  const dir = import.meta.dir;
  const bad = readdirSync(dir).filter((f) => f.endsWith(".ts")).flatMap((f) =>
    readFileSync(join(dir, f), "utf8").split("\n").flatMap((l, i) => (/process\.env\s*=(?!=)/.test(l.replace(/\/\/.*$/, "")) ? [`${f}:${i + 1}`] : [])));
  expect(bad).toEqual([]);
});
