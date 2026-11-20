// Круг 10n: путь с %ИМЯ% существующей переменной окружения — команда miksy (miksy.cmd) получит его искажённым: cmd
// раскрывает пару даже в кавычках. doctor (только Windows) называет такие корни и проекты; одиночный % и %ИМЯ%
// несуществующей переменной cmd не трогает — о них молчит
import { describe, expect, test } from "bun:test";
import { cliFixture, expectCode, said } from "./helpers";
import { cmdExpands } from "../src/doctor";

describe("cmdExpands — как cmd разбирает %…%", () => {
  const env = { PATH: "x", USERNAME: "u", EMPTY: "" };
  test.each([
    ["D:/a%PATH%b", true],
    ["D:/a%path%b", true], // имя без учёта регистра
    ["D:/a%EMPTY%b", true], // пустое значение — тоже подстановка
    ["D:/a%PATH:~0,2%b", true], // подстрока
    ["D:/100% sure", false],
    ["D:/x%NOSUCH%y", false],
    ["D:/x%NOSUCH%PATH%y", true], // первый % остался, пара — со второго
    ["D:/x%%y", false],
    ["D:/plain", false],
  ] as const)("%s → %p", (s, want) => expect(cmdExpands(s, env)).toBe(want));
});

test.skipIf(process.platform !== "win32")("doctor: проект с %ИМЯ% существующей переменной — в «Справочно» с советом; одиночный % и несуществующая — нет", () => {
  const saved = process.env.MIKSY_T10N;
  process.env.MIKSY_T10N = "1";
  try {
    const f = cliFixture({ projects: ["Org/a%MIKSY_T10N%b", "Org/100% sure", "Org/x%MIKSY_T10N_NOSUCH%y"] });
    expectCode(f.run(["sync", "--all", "--yes"]), 0);
    const d = f.run(["doctor"]);
    const block = d.out.split("\n");
    const at = block.findIndex((l) => l.startsWith("Пути с %ИМЯ% переменной окружения (1) — команда miksy с таким путём получит его искажённым"));
    expect(at, said(d)).toBeGreaterThan(-1);
    expect(block[at], said(d)).toContain("Переименуйте папку или запускайте miksy через Bun напрямую: bun \"");
    expect(block[at + 1]).toBe(`  ${f.ws}/Org/a%MIKSY_T10N%b`);
    expect(block[at + 2] ?? "").not.toMatch(/^  .*Org\//);
  } finally {
    if (saved === undefined) delete process.env.MIKSY_T10N;
    else process.env.MIKSY_T10N = saved;
  }
}, 60000);
