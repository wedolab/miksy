// Выпуск 0.2.2: учёт (local/state/manifest.json) и решения о доверии (local/trust.json), записанные этой версией,
// настоящий v0.2.1 читает без ошибок — откат на одну версию назад по рецепту README («Откатиться на прежнюю версию»:
// setup --yes, sync --global, sync --all). Тег v0.2.1 репо движка разворачивается во временный каталог (временный индекс
// git; индекс и ветки репо не меняются). Тега нет (CI и стенды клонируют без тегов) — пропуск.
// Отметку версии учёта (A5) v0.2.1 после отката не переписывает — это умеют версии с 0.2.2: сообщение «учёт записан
// более новой версией» на v0.2.1 остаётся до первого sync с изменениями (README, «Особенности версий»)
import { expect, test } from "bun:test";
import { cliFixture } from "./helpers";
import { inProcess, ledger, read } from "./rootshelp";
import { commit, hasTag, oldEngine, oldRunner, userTrusts } from "./fixes021b-helpers";

const TAG = "v0.2.1";
const MCP = { ".mcp.json": JSON.stringify({ mcpServers: { team: { command: "team-server" } } }) };

test.skipIf(!hasTag(TAG))("учёт и local/trust.json этой версии (доверие после clean, «нет» + «да» серверам, «забыть») — v0.2.1 читает, рецепт отката без конфликтов", () => {
  const f = cliFixture({ agents: ["claude", "codex"], projects: ["Org/p1", "Org/p2", "Org/p3"] });
  const old = oldRunner(oldEngine(TAG), f);
  const p1 = `${f.ws}/Org/p1`, p2 = `${f.ws}/Org/p2`, p3 = `${f.ws}/Org/p3`;
  // Эта версия: p1 — доверие ставил miksy, затем clean; p2 — «нет» доверию Claude, «да» серверам .mcp.json (alone);
  // p3 — забыт
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  expect(f.run(["clean", p1]).code).toBe(0);
  commit(p2, MCP);
  expect(f.run(["trust", p2, "--deny"]).code).toBe(0);
  userTrusts(f.home, p2);
  expect(inProcess(f, ["trust", p2], f.dir, ["y"]).err).toBe("");
  expect(f.run(["sync", p2]).code).toBe(0);
  expect(f.run(["clean", p3, "--forget"]).code).toBe(0);
  const mine = { ledger: read(`${f.config}/local/state/manifest.json`), trust: read(`${f.config}/local/trust.json`) };
  expect(JSON.parse(mine.trust).decisions).toBeTruthy();
  expect(Object.keys(ledger(f.config).targets).length).toBeGreaterThan(0);
  // v0.2.1: doctor, затем рецепт отката README — без ошибок учёта и решений, без конфликтов
  const doc = old(["doctor"]);
  const steps = [old(["setup", "--yes"]), old(["sync", "--global"]), old(["sync", "--all", "--yes"]), old(["doctor"])];
  for (const s of [doc, ...steps]) {
    expect(s.err).toBe("");
    expect(s.out).not.toMatch(/учёт повреждён|не разбирается|КОНФЛИКТ/);
  }
  expect(steps.slice(0, 3).map((s) => s.code)).toEqual([0, 0, 0]);
  // Вернулись на эту версию — всё читается
  const back = f.run(["doctor"]);
  expect({ err: back.err, broken: /учёт повреждён|не разбирается/.test(back.out) }).toEqual({ err: "", broken: false });
}, 300000);
