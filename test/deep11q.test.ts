// Круг 11q: поиск проектов глубже 7 уровней — полностью до 7-го, глубже — бюджет папок; упор — строка в doctor «Справочно»
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { containsProjects, DEEP_BUDGET, listProjects, SHALLOW_LEVELS, type WalkCut } from "../src/load";
import { cliFixture, expectCode, gitInit } from "./helpers";

const chain = (n: number, prefix = "l") => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`).join("/");

describe("поиск проектов: глубина и бюджет (круг 11q)", () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env.MIKSY_CONFIG; });
  afterEach(() => { if (saved === undefined) delete process.env.MIKSY_CONFIG; else process.env.MIKSY_CONFIG = saved; });

  test("проекты на уровне 7, 8 и 12 найдены; containsProjects видит глубокий", () => {
    const f = cliFixture({ projects: [] });
    process.env.MIKSY_CONFIG = f.config;
    const at = (lvl: number) => `${f.ws}/${chain(lvl - 1, `d${lvl}-`)}/p${lvl}`;
    for (const l of [7, 8, 12]) { mkdirSync(at(l), { recursive: true }); gitInit(at(l)); }
    const cuts: WalkCut[] = [];
    const found = listProjects(f.ws, [], undefined, (c) => cuts.push(c)).map((p) => p.abs);
    expect(found).toEqual([at(12), at(7), at(8)].sort());
    expect(cuts).toEqual([]);
    expect(containsProjects(`${f.ws}/d12-1`)).toBe(true);
    expect(SHALLOW_LEVELS).toBe(7);
    expect(DEEP_BUDGET).toBe(10_000);
  });

  test("глубокие папки без проектов меньше бюджета — без сообщения", () => {
    const f = cliFixture({ projects: ["Org/p1"] });
    process.env.MIKSY_CONFIG = f.config;
    mkdirSync(`${f.ws}/Data/${chain(20)}`, { recursive: true });
    const cuts: WalkCut[] = [];
    expect(listProjects(f.ws, [], undefined, (c) => cuts.push(c)).map((p) => p.rel)).toEqual(["Org/p1"]);
    expect(cuts).toEqual([]);
  });

  test("бюджет исчерпан: обход в ширину — неглубокие проекты найдены; сообщение с самыми тяжёлыми папками", () => {
    const f = cliFixture({ projects: ["Org/p1"] });
    process.env.MIKSY_CONFIG = f.config;
    // 12 папок на уровне 8 под Data/big, 2 — под Data/small; проект на уровне 8 — тоже в очереди глубоких
    const deep = `${f.ws}/Data/big/${chain(5)}`;
    for (let i = 0; i < 12; i++) mkdirSync(`${deep}/x${i}`, { recursive: true });
    mkdirSync(`${f.ws}/Data/small/${chain(5)}/y1`, { recursive: true });
    mkdirSync(`${f.ws}/Data/small/${chain(5)}/y2`, { recursive: true });
    // Проект на уровне 6 — найден при любом бюджете
    const mid = `${f.ws}/Acme/${chain(4)}/mid`;
    mkdirSync(mid, { recursive: true });
    gitInit(mid);
    const cuts: WalkCut[] = [];
    const found = listProjects(f.ws, [], undefined, (c) => cuts.push(c), 10).map((p) => p.rel);
    expect(found).toContain("Org/p1");
    expect(found).toContain(`Acme/${chain(4)}/mid`);
    expect(cuts.length).toBe(1);
    expect(cuts[0].root).toBe(f.ws);
    expect(cuts[0].budget).toBe(10);
    expect(cuts[0].heavy[0][0]).toBe("Data/big");
    expect(cuts[0].heavy.reduce((s, [, k]) => s + k, 0)).toBe(10);
  });

  test("doctor: упор в бюджет — строка в «Справочно»; sync --all её не печатает", () => {
    const f = cliFixture({ projects: ["Org/p1"] });
    // Уровень 8: DEEP_BUDGET + 1 папка
    const deep = `${f.ws}/Data/${chain(6)}`;
    for (let i = 0; i <= DEEP_BUDGET; i++) mkdirSync(`${deep}/x${i}`, { recursive: true });
    const d = f.run(["doctor"]);
    expect(d.out).toMatch(/Справочно:[\s\S]*Поиск проектов остановлен \(1\) — глубже 7 уровней от корня miksy просматривает не больше 10 000 папок/);
    expect(d.out).toContain(`  ${f.ws} — больше всего папок в Data/l1 (10 000)`);
    expect(d.out).toContain("Проект там — запустите miksy sync в его папке");
    const s = f.run(["sync", "--all", "--dry-run"]);
    expectCode(s, 0);
    expect(s.out + s.err).not.toContain("Поиск проектов остановлен");
    expect(s.out).toContain("Org/p1");
  }, 120000);
});
