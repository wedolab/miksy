// Выпуск 0.2.2, круг 8b, C5 (рецензия B №2 проверки 8a): ветка по умолчанию для root add и мастера меняется только там,
// где ветка 0.2.1 давала неработающую или слишком широкую привязку match: (Bun.Glob, как src/resolve.ts): «[», «{», «\»,
// «*», «?», «!» в начале. Остальные имена (запятая, «!» не в начале, пробелы подряд) — ровно как в 0.2.1
import { expect, test } from "bun:test";
import { suggestTree } from "../src/roots";

const hit = (pat: string, rel: string) => new Bun.Glob(pat.toLowerCase()).match(rel.toLowerCase());
// Привязка «<ветка>/Org/**»: совпадает со своими проектами и не совпадает с проектами соседних веток
const works = (b: string) => hit(`${b}/Org/**`, `${b}/Org/p1`) && !["Work/Org/p1", "Workx/Org/p1", "Projects/Org/p1", "x/Org/p1"].filter((r) => !r.startsWith(`${b}/`)).some((r) => hit(`${b}/Org/**`, r));

// Имя папки → ветка, как её давала 0.2.1 (круг 10r: ответы настоящего v0.2.1 записаны сюда, сам он не запускается)
const SAME: [string, string][] = [["Acme, Inc", "Acme, Inc"], ["Projects!", "Projects!"], ["Pro!jects", "Pro!jects"], ["Work]", "Work]"], ["Work}", "Work}"], ["a  b", "a  b"], ["O'Brien", "O'Brien"], ["a(b)+c", "a(b)+c"], ["Work", "Work"], [" .x. ", "x"], ["skills", "skills-root"]];
// 0.2.1 давала само имя (неработающая привязка); теперь — без знаков
const CHANGED: [string, string][] = [["Work [old]", "Work old"], ["Work {a}", "Work a"], ["!Projects", "Projects"], ["Work*", "Work"], ["Work?", "Work"], ["Wo[r]k", "Wo r k"], ["{}", "Root"]];

test("ветка по умолчанию: обычные имена — как в 0.2.1; со знаками, ломающими match, — без них", () => {
  const p = (n: string) => `D:/x/${n}`;
  expect(SAME.map(([n]) => [n, suggestTree(p(n), [])])).toEqual(SAME);
  expect(CHANGED.map(([n]) => [n, suggestTree(p(n), [])])).toEqual(CHANGED);
});

test("ветка 0.2.2 даёт работающую привязку <ветка>/Org/** — для всех имён; ветка 0.2.1 для изменённых — нет", () => {
  expect([...SAME, ...CHANGED].map(([n]) => n).filter((n) => !works(suggestTree(`D:/x/${n}`, [])))).toEqual([]);
  expect(CHANGED.map(([n]) => n).filter((n) => works(n.trim()))).toEqual([]);
});
