// Выпуск 0.2.2, круг 8b, C5 (рецензия B №2 проверки 8a): ветка по умолчанию для root add и мастера меняется только там,
// где ветка 0.2.1 давала неработающую или слишком широкую привязку match: (Bun.Glob, как src/resolve.ts): «[», «{», «\»,
// «*», «?», «!» в начале. Остальные имена (запятая, «!» не в начале, пробелы подряд) — ровно как в 0.2.1
import { expect, test } from "bun:test";
import { suggestTree } from "../src/roots";
import { hasTag, oldEngine } from "./fixes021b-helpers";

const hit = (pat: string, rel: string) => new Bun.Glob(pat.toLowerCase()).match(rel.toLowerCase());
// Привязка «<ветка>/Org/**»: совпадает со своими проектами и не совпадает с проектами соседних веток
const works = (b: string) => hit(`${b}/Org/**`, `${b}/Org/p1`) && !["Work/Org/p1", "Workx/Org/p1", "Projects/Org/p1", "x/Org/p1"].filter((r) => !r.startsWith(`${b}/`)).some((r) => hit(`${b}/Org/**`, r));

const SAME = ["Acme, Inc", "Projects!", "Pro!jects", "Work]", "Work}", "a  b", "O'Brien", "a(b)+c", "Work", " .x. ", "skills"];
const CHANGED: [string, string][] = [["Work [old]", "Work old"], ["Work {a}", "Work a"], ["!Projects", "Projects"], ["Work*", "Work"], ["Work?", "Work"], ["Wo[r]k", "Wo r k"], ["{}", "Root"]];

test.skipIf(!hasTag("v0.2.1"))("ветка по умолчанию 0.2.1 и 0.2.2: обычные имена — та же; со знаками, ломающими match, — без них", async () => {
  const old = (await import(`${oldEngine("v0.2.1")}/src/roots.ts`)).suggestTree as typeof suggestTree;
  const p = (n: string) => `D:/x/${n}`;
  expect(SAME.map((n) => [n, suggestTree(p(n), [])])).toEqual(SAME.map((n) => [n, old(p(n), [])]));
  expect(CHANGED.map(([n]) => [n, old(p(n), []), suggestTree(p(n), [])])).toEqual(CHANGED.map(([n, now]) => [n, n, now]));
}, 60000);

test("ветка 0.2.2 даёт работающую привязку <ветка>/Org/** — для всех имён; ветка 0.2.1 для изменённых — нет", () => {
  expect([...SAME, ...CHANGED.map(([n]) => n)].filter((n) => !works(suggestTree(`D:/x/${n}`, [])))).toEqual([]);
  expect(CHANGED.map(([n]) => n).filter((n) => works(n.trim()))).toEqual([]);
});
