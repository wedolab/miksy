// Круг 10h: говорящие проверки кода выхода — при несовпадении сообщение показывает команду, коды, stdout и stderr
import { expect, test } from "bun:test";
import { cliFixture, expectCode, expectCodeIn, expectNotCode, said } from "./helpers";

const message = (f: () => void) => { try { f(); } catch (e) { return (e as Error).message; } return "(не упало)"; };

test("expectCode: несовпадение — в сообщении коды, stdout и stderr; совпадение — молча", () => {
  const r = { code: 3, out: "ВЫВОД-КОМАНДЫ", err: "ОШИБКА-КОМАНДЫ" };
  const m = message(() => expectCode(r, 0));
  expect(m).toContain("код выхода 3 вместо 0");
  expect(m).toContain("ВЫВОД-КОМАНДЫ");
  expect(m).toContain("ОШИБКА-КОМАНДЫ");
  expect(message(() => expectCode(r, 3))).toBe("(не упало)");
  expect(message(() => expectNotCode(r, 3))).toContain("ОШИБКА-КОМАНДЫ");
  expect(message(() => expectCodeIn(r, [0, 1]))).toContain("ВЫВОД-КОМАНДЫ");
  expect(message(() => expectCodeIn(r, [0, 3]))).toBe("(не упало)");
});

test("expectCode: Bun.spawnSync — exitCode и вывод-буферы; длинный вывод обрезан", () => {
  const r = Bun.spawnSync([process.execPath, "-e", "process.stdout.write('x'.repeat(7000)); console.error('ПЛОХО'); process.exit(2)"], { stdout: "pipe", stderr: "pipe" });
  const m = message(() => expectCode(r, 0));
  expect(m).toContain("код выхода 2 вместо 0");
  expect(m).toContain("ПЛОХО");
  expect(m).toContain("… (ещё 1000 символов)");
});

test("expectCode: результат cliFixture.run знает команду; said — для составных проверок", () => {
  const f = cliFixture();
  const r = f.run(["нет-такой-команды"]);
  const m = message(() => expectCode(r, 0));
  expect(m).toContain("команда: miksy нет-такой-команды");
  expect(Object.keys(r)).toEqual(["code", "out", "err"]);
  expect(message(() => expect({ code: r.code }, said(r)).toEqual({ code: 0 }))).toContain("команда: miksy нет-такой-команды");
});
