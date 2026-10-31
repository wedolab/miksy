// Вопрос о workspace в setup: Enter — значение по умолчанию (prompt Bun возвращает null и на Enter,
// и на конец ввода); закрытый ввод не зацикливает
import { expect, test } from "bun:test";
import { chooseWorkspace } from "../src/setup";

const home = "/Users/u";
const answers = (...list: (string | null)[]) => () => (list.length ? list.shift()! : null);

test("Enter (null) — предложенный workspace", () => {
  expect(chooseWorkspace("/Users/u/Workspace", answers(null), () => false, home, "/x")).toBe("/Users/u/Workspace");
});

test("свой ответ — свой workspace, ~ раскрывается", () => {
  expect(chooseWorkspace("/Users/u/Workspace", answers("~/ai"), () => false, home, "/x")).toBe("/Users/u/ai");
});

test("опасный (домашний каталог): отказ — вопрос снова; закрытый ввод — не выбран, без зацикливания", () => {
  expect(chooseWorkspace(null, answers("~", "~/ai"), () => false, home, "/x")).toBe("/Users/u/ai");
  expect(chooseWorkspace("/Users/u", answers(), () => false, home, "/x")).toBeNull();
  expect(chooseWorkspace(null, answers(), () => false, home, "/x")).toBeNull();
});

test("опасный с подтверждением — берётся", () => {
  expect(chooseWorkspace(null, answers("~"), () => true, home, "/x")).toBe("/Users/u");
});
