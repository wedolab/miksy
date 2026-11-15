// Выпуск 0.2.2, A2: правило R2 на всех путях (план out/8a-plan.md, таблица A2; ответ основного агента — строки «а», «б»).
// R2: если sync снимает своё одобрение серверов .mcp.json, в том же запуске есть вопрос о них (терминал) или подсказка
// (--dry-run, doctor, и в терминале — когда вопрос бессмыслен: проект не доверенный, запрет trust: false); где одобрение
// не снимается — новых вопросов нет; отказ не переспрашивается
// Строки таблицы — здесь первые 7 и в fixes022-rule-r2b.test.ts остальные (круг 10d); общее — fixes022-rule-r2-help.ts
import { expect, test } from "bun:test";
import { cliFixture } from "./helpers";
import { commit, hasTag, oldEngine, oldRunner, userTrusts } from "./fixes021b-helpers";
import { CASES, MCP, r2, row } from "./fixes022-rule-r2-help";

test("R2 (строки 1–7 таблицы): снятие своего одобрения серверов — вопрос или подсказка в том же запуске; без снятия — новых вопросов нет", () => r2(CASES.slice(0, 7)), 900000);

test.skipIf(!hasTag())("R2, 9: пара 0.2.0 «нет» + «да» серверам — снятие и вопрос в том же sync", () => {
  const f = cliFixture({ projects: ["Org/app"] });
  const old = oldRunner(oldEngine(), f);
  const app = `${f.ws}/Org/app`;
  commit(app, MCP("v1"));
  old(["sync", "--all", "--yes"]);
  old(["trust", app, "--confirm"]);
  old(["trust", app, "--deny"]);
  userTrusts(f.home, app);
  old(["sync", app]);
  const r = row(f, app, "9");
  expect(r).toEqual({ n: "9", removed: true, dry: true, doctor: true, terminal: true, asked: r.asked, a2: false, err: "" });
  expect(r.asked).toBeGreaterThan(0);
}, 300000);
