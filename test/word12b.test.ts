// Круг 12b: «ветка дерева слоёв» теперь «раздел» — слово «ветка» в src/ и adapters/ (тексты сообщений, help, комментарии)
// остаётся только про ветки git. Страж: строка со словом «ветк…» допустима в модулях обновления и отката движка (там
// все ветки — git) или если в ней названа ветка git движка (stable, main — значения или константы STABLE, MAIN)
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
// Модули, где «ветка» — всегда ветка git движка
const GIT_ONLY = new Set(["src/update.ts", "src/downgrade.ts"]);
const GIT_NAMED = /\b(?:stable|main|STABLE|MAIN)\b/;

const files = (dir: string): string[] => readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? files(`${dir}/${e.name}`) : e.name.endsWith(".ts") ? [`${dir}/${e.name}`] : []);

test("«ветка» в src/ и adapters/ — только ветка git (дерево слоёв — «раздел»)", () => {
  const found: string[] = [];
  for (const f of [...files("src"), ...files("adapters")]) {
    if (GIT_ONLY.has(f)) continue;
    readFileSync(join(ROOT, f), "utf8").split("\n").forEach((line, i) => {
      if (/[вВ]ет(?:к|ок(?![а-яё]))/.test(line) && !GIT_NAMED.test(line)) found.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  expect(found).toEqual([]);
});

test("страж видит слово «ветка» в любом падеже и с заглавной", () => {
  for (const s of ["ветка", "ветки", "веткой", "Ветку", "веток"]) expect(/[вВ]ет(?:к|ок(?![а-яё]))/.test(s)).toBe(true);
  expect(GIT_NAMED.test("новая версия (ветка stable)")).toBe(true);
  expect(GIT_NAMED.test("раздел дерева слоёв")).toBe(false);
});
