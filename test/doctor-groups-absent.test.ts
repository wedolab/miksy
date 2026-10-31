// doctor: пометка группы, каталога которой нет на этой машине, — справочно, не проблема
import { expect, test } from "bun:test";
import { cliFixture, put } from "./helpers";
import { answerYes } from "../src/ask";

test("группа без каталога на этой машине — в «Справочно», не в проблемах", () => {
  const f = cliFixture({ agents: ["claude"] });
  put(`${f.config}/layers/tree/Nope/layer.yaml`, "target: true\n");
  expect(f.run(["sync", "--global"]).code).toBe(0);
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  const r = f.run(["doctor"]);
  expect(r.out).not.toContain("Пометка target: true не действует");
  expect(r.out).toMatch(/Справочно:[\s\S]*Nope/);
  expect(r.out).toContain("Всё синхронизировано");
  expect(r.code).toBe(0);
}, 60000);

test("ответ «да/нет»: Enter — значение по умолчанию, явный ответ — как есть", () => {
  expect(answerYes(null)).toBe(false);
  expect(answerYes("", true)).toBe(true);
  expect(answerYes(null, true)).toBe(true);
  expect(answerYes("n", true)).toBe(false);
  expect(answerYes("да")).toBe(true);
  expect(answerYes("что-то", true)).toBe(false);
});
