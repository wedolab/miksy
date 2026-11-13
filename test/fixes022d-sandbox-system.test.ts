// Выпуск 0.2.2, круг 8d, T1: временный тест рецензента 8c запустил мастер в процессе с настоящей системой (realSystem) —
// «да» по умолчанию дописало пути песочницы в настоящий пользовательский PATH. Под песочницей тестов
// (MIKSY_TEST_SANDBOX) realSystem не меняет систему: запись PATH и установка программ отказывают с понятной ошибкой.
// Безопасно и при сломанной защите (круг 8e, F6): Bun.spawnSync на время теста подменён записью вызовов — ничего не
// запускается, реестр не читается и не пишется; значения поддельные. Мастер в тесте — только с поддельной системой
import { afterEach, beforeEach, expect, test } from "bun:test";
import { realSystem } from "../src/setup";

let calls: string[][] = [];
let saved: typeof Bun.spawnSync;
beforeEach(() => {
  calls = [];
  saved = Bun.spawnSync;
  Bun.spawnSync = ((a: any) => {
    calls.push((Array.isArray(a) ? a : a?.cmd ?? []).map(String));
    return { exitCode: 0, success: true, stdout: Buffer.from(""), stderr: Buffer.from(""), pid: 0 } as any;
  }) as typeof Bun.spawnSync;
});
afterEach(() => { Bun.spawnSync = saved; });

test("под песочницей тестов: запись пользовательского PATH — ошибка, ничего не запускалось", () => {
  expect(process.env.MIKSY_TEST_SANDBOX).toBeTruthy();
  let err = "";
  try { realSystem.userPath.set("ПОДДЕЛЬНОЕ-ЗНАЧЕНИЕ"); } catch (e) { err = (e as Error).message; }
  expect(err).toMatch(/тест не меняет настоящую систему: запись пользовательского PATH под песочницей тестов \(MIKSY_TEST_SANDBOX=.*\) запрещено — передайте мастеру поддельную систему \(sys\)/);
  expect(calls).toEqual([]);
});

test("под песочницей тестов: установка программы (exec) — ошибка, команда не выполнялась", () => {
  let err = "";
  try { realSystem.exec("echo ПОДДЕЛЬНАЯ-КОМАНДА"); } catch (e) { err = (e as Error).message; }
  expect({ err: /тест не меняет настоящую систему: установка программы «.*» под песочницей тестов .* запрещено/.test(err), calls }).toEqual({ err: true, calls: [] });
});
