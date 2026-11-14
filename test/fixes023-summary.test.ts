// Выпуск 0.2.3, круг 9b (проверка 023a, п. 2): итог sync/clean о целях с ошибкой — по команде и режиму. --dry-run —
// будущее время; clean — «убрано», без «допишет». Частичную ошибку clean в песочнице не вызвать — проверка текста функцией
import { expect, test } from "bun:test";
import { failureSummary } from "../src/commands";

test("9b: итог — sync, sync --dry-run, clean, clean --dry-run", () => {
  const f = { skipped: 1, partial: 2 };
  expect(failureSummary("sync", false, f)).toEqual([
    "Целей пропущено из-за ошибки: 1 — в них ничего не записано (причина и что сделать — в строках «ОШИБКА» выше).",
    "Целей записано частично: 2 — запись остановилась на ошибке (строки «ОШИБКА» выше); записанное до неё — в учёте, повтор после исправления допишет остальное.",
  ]);
  expect(failureSummary("sync", true, f)[0]).toStartWith("Целей будет пропущено из-за ошибки: 1 — в них ничего не запишется");
  expect(failureSummary("sync", true, f)[1]).toStartWith("Целей будет записано частично: 2 — запись остановится на ошибке");
  const clean = failureSummary("clean", false, f);
  expect(clean[0]).toStartWith("Целей пропущено из-за ошибки: 1 — в них ничего не убрано");
  expect(clean[1]).toBe("Целей убрано частично: 2 — остановилось на ошибке (строки «ОШИБКА» выше); после исправления повторите miksy clean — он уберёт остальное.");
  expect(clean.join(" ")).not.toMatch(/записан|допишет/);
  expect(failureSummary("clean", true, f)[1]).toStartWith("Целей будет убрано частично: 2 — остановится на ошибке");
  expect(failureSummary("sync", false, { skipped: 0, partial: 0 })).toEqual([]);
});
