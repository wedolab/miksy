// Круг 11y: JSON с комментариями (JSONC) — правка на месте. opencode читает JSONC в любом своём конфиге; miksy меняет
// только свои ключи, остальной текст (комментарии, отступы, порядок, концевые запятые, CRLF, BOM) — побайтно. clean
// возвращает файл побайтно; ключ mcp, созданный miksy в чужом файле, — учёт made.keys
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { cliFixture, expectCode, put, said } from "./helpers";
import { editJsonc, editToValue, JsoncError, parseJsonc } from "../src/jsonc";
import { type Action, apply } from "../src/apply";
import { emptyState, sha } from "../src/manifest";

// Набор настоящих JSONC: имя → текст
const CORPUS: Record<string, string> = {
  "комментарии всех видов": '{\n  // мой конфиг\n  "$schema": "https://opencode.ai/config.json",\n  /* модель */ "model": "anthropic/x", // по умолчанию\n  "mcp": {\n    /* мой сервер */\n    "mine": { "type": "local", "command": ["mine"] } // рабочий\n  }\n}\n',
  "концевые запятые": '{\n  "model": "x",\n  "mcp": {\n    "mine": {\n      "type": "local",\n      "command": ["mine",],\n    },\n  },\n}\n',
  "CRLF и BOM": '﻿{\r\n  // windows\r\n  "mcp": {\r\n    "mine": { "type": "local", "command": ["mine"] }\r\n  }\r\n}\r\n',
  "табы": '{\n\t"model": "x",\n\t"mcp": {\n\t\t"mine": {\n\t\t\t"type": "local"\n\t\t}\n\t}\n}',
  "четыре пробела без mcp": '{\n    // только модель\n    "model": "x"\n}\n',
  "одна строка": '{"model":"x","mcp":{"mine":{"type":"local","command":["mine"]}}}',
  "пустой mcp": '{\n  "mcp": {}\n}\n',
  "комментарий внутри mcp": '{\n  "mcp": {\n    // серверы ниже\n    "mine": { "type": "local", "command": ["mine"] },\n    // конец\n  }\n}\n',
};
const TOK = { type: "local", command: ["tok-server"], environment: { A: "1" } };

describe("src/jsonc.ts", () => {
  for (const [name, text] of Object.entries(CORPUS)) {
    test(`${name}: вставка сервера и снятие — побайтно, остальное не тронуто`, () => {
      const before = parseJsonc(text).value as Record<string, any>;
      const after = { ...before, mcp: { ...(before.mcp ?? {}), tok: TOK } };
      const s = editToValue(text, before, after);
      expect(parseJsonc(s).value).toEqual(after);
      // Комментарии на месте; добавлен только сервер
      for (const c of parseJsonc(text).comments) expect(s).toContain(text.slice(c.start, c.end));
      expect(s.startsWith("﻿")).toBe(text.startsWith("﻿"));
      if (text.includes("\r\n")) expect(s.replaceAll("\r\n", "").includes("\n")).toBe(false);
      // Снятие возвращает исходный текст побайтно (ключ mcp, которого не было, снимается тоже)
      expect(editToValue(s, after, before)).toBe(text);
    });
  }

  test("замена поля сервера — правится только поле, комментарии внутри сервера остаются", () => {
    const text = '{\n  "mcp": {\n    "tok": {\n      // не трогать\n      "type": "local",\n      "command": ["old"]\n    }\n  }\n}\n';
    const s = editJsonc(text, ["mcp", "tok", "command"], ["new"]);
    expect(s).toBe(text.replace('["old"]', '[\n        "new"\n      ]'));
    const v = editToValue(text, parseJsonc(text).value, { mcp: { tok: { type: "local", command: ["old"], enabled: true } } });
    expect(v).toContain("// не трогать");
    expect(parseJsonc(v).value).toEqual({ mcp: { tok: { type: "local", command: ["old"], enabled: true } } });
  });

  test("битый JSONC — ошибка со строкой и столбцом; ключ __proto__ — обычный ключ", () => {
    expect(() => parseJsonc('{\n  "a": 1\n  "b": 2\n}')).toThrow(JsoncError);
    expect(() => parseJsonc('{\n  "a": 1\n  "b": 2\n}')).toThrow("строка 3");
    expect(() => parseJsonc("{ /* не закрыт ")).toThrow("не закрыт");
    const v = parseJsonc('{"__proto__": {"x": 1}}').value as Record<string, unknown>;
    expect(Object.keys(v)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
  });
});

// Слой с сервером tok; opencode
function fixture() {
  const f = cliFixture({ agents: ["opencode"] });
  put(`${f.config}/layers/global/mcp/tok.yaml`, "name: tok\ncommand: tok-server\n");
  return f;
}
const text = (p: string) => readFileSync(p, "utf8");

describe("opencode: JSONC на поддельной системе (круг 11y)", () => {
  for (const [name, original] of Object.entries(CORPUS)) {
    test(`глобальный ${name}: sync — только свой сервер; повторный — без изменений; clean — побайтно`, () => {
      const f = fixture();
      const file = `${f.home}/.config/opencode/opencode.json`;
      put(file, original);
      expectCode(f.run(["sync", "--global"]), 0);
      const after = text(file);
      const want = parseJsonc(original).value as Record<string, any>;
      const got = parseJsonc(after).value as Record<string, any>;
      expect({ ...got, mcp: Object.fromEntries(Object.entries(got.mcp).filter(([k]) => k !== "tok")) }).toEqual({ ...want, mcp: want.mcp ?? {} });
      expect(got.mcp.tok.command).toEqual(["tok-server"]);
      // Отличие от исходного — только вставка: снять её из текста — исходный побайтно
      expect(editToValue(after, got, want)).toBe(original);
      const again = f.run(["sync", "--global"]);
      expect({ code: again.code, same: text(file) === after, none: again.out.includes("изменений нет") }, said(again)).toEqual({ code: 0, same: true, none: true });
      expectCode(f.run(["clean", "--global"]), 0);
      expect(text(file)).toBe(original);
    }, 60000);
  }

  test("проект: чужой opencode.jsonc — сервер вливается в него, clean — побайтно", () => {
    const f = fixture();
    const p = `${f.ws}/Org/p1`;
    const original = CORPUS["комментарии всех видов"];
    put(`${f.config}/layers/tree/mcp/tok.yaml`, "name: tok\ncommand: tok-server\n");
    put(`${p}/opencode.jsonc`, original);
    expectCode(f.run(["sync", p]), 0);
    expect((parseJsonc(text(`${p}/opencode.jsonc`)).value as any).mcp.tok.command).toEqual(["tok-server"]);
    expectCode(f.run(["clean", p]), 0);
    expect(text(`${p}/opencode.jsonc`)).toBe(original);
  }, 60000);

  test("свой сервер закомментирован: записан снова с предупреждением; совет miksy mcp off выполняется дословно", () => {
    const f = fixture();
    const file = `${f.home}/.config/opencode/opencode.json`;
    put(file, '{\n  "mcp": {\n    "mine": { "type": "local", "command": ["mine"] }\n  }\n}\n');
    expectCode(f.run(["sync", "--global"]), 0);
    expect((parseJsonc(text(file)).value as any).mcp.tok).toBeTruthy();
    // Пользователь закомментировал сервер miksy
    writeFileSync(file, '{\n  "mcp": {\n    "mine": { "type": "local", "command": ["mine"] }\n    // , "tok": { "type": "local", "command": ["tok-server"] }\n  }\n}\n');
    const r = f.run(["sync", "--global"]);
    const m = r.out.match(/выключить его на этой машине — miksy (mcp off \S+)/);
    expect({ code: r.code, warn: r.out.includes(`сервер tok закомментирован в ${file}`), back: !!(parseJsonc(text(file)).value as any).mcp.tok, cmd: m?.[1] }, said(r))
      .toEqual({ code: 0, warn: true, back: true, cmd: "mcp off tok" });
    expectCode(f.run(m![1].split(" ")), 0);
    const s = f.run(["sync", "--global"]);
    expect({ code: s.code, gone: !(parseJsonc(text(file)).value as any).mcp.tok, comment: text(file).includes("// ") }, said(s)).toEqual({ code: 0, gone: true, comment: true });
  }, 90000);

  test("битый JSONC — конфликт со строкой, файл не тронут; оба файла .json и .jsonc — сливается в .json, предупреждение", () => {
    const f = fixture();
    const dir = `${f.home}/.config/opencode`;
    const bad = '{\n  "model": "x"\n  "mcp": {}\n}\n';
    put(`${dir}/opencode.json`, bad);
    const r = f.run(["sync", "--global"]);
    expect({ conflict: r.out.includes("не разбирается как JSON (или JSONC): ожидалось , или } (строка 3"), same: text(`${dir}/opencode.json`) === bad }, said(r)).toEqual({ conflict: true, same: true });
    put(`${dir}/opencode.json`, '{\n  // json\n  "mcp": {}\n}\n');
    put(`${dir}/opencode.jsonc`, '{ "model": "y" }\n');
    const both = f.run(["sync", "--global"]);
    expect({ code: both.code, json: !!(parseJsonc(text(`${dir}/opencode.json`)).value as any).mcp.tok, jsonc: text(`${dir}/opencode.jsonc`), warn: both.out.includes("opencode.jsonc тоже загрузится — позже, и его серверы с теми же именами перекроют серверы miksy") }, said(both))
      .toEqual({ code: 0, json: true, jsonc: '{ "model": "y" }\n', warn: true });
  }, 60000);

  test("учёт до этой версии (без made.keys): clean оставляет пустой mcp и не пишет новых предупреждений", () => {
    const f = fixture();
    const file = `${f.home}/.config/opencode/opencode.json`;
    const original = '{\n  "model": "x"\n}\n';
    put(file, original);
    expectCode(f.run(["sync", "--global"]), 0);
    const ledger = `${f.config}/local/state/manifest.json`;
    const m = JSON.parse(text(ledger));
    expect(Object.keys(m.made?.keys ?? {}).length).toBe(1);
    delete m.made.keys;
    writeFileSync(ledger, JSON.stringify(m));
    const c = f.run(["clean", "--global"]);
    expect({ code: c.code, left: parseJsonc(text(file)).value, warn: c.out.includes("предупреждение") }, said(c)).toEqual({ code: 0, left: { model: "x", mcp: {} }, warn: false });
  }, 60000);
});

describe("правка, которая не сходится с ожидаемым (круг 11y)", () => {
  // Ключ дважды: разбор берёт последний, снять его — останется первый: результат не совпал бы с задуманным
  const DUP = '{\n  "mcp": {\n    "tok": { "type": "local", "command": ["a"] },\n    "tok": { "type": "local", "command": ["tok-server"] }\n  }\n}\n';

  test("план: конфликт файла с объяснением, файл не тронут", () => {
    const f = fixture();
    const file = `${f.home}/.config/opencode/opencode.json`;
    put(file, '{\n  "mcp": {}\n}\n');
    expectCode(f.run(["sync", "--global"]), 0);
    writeFileSync(file, DUP);
    const c = f.run(["clean", "--global"]);
    expect({ conflict: c.out.includes("не могу изменить файл, сохранив его вид"), same: text(file) === DUP }, said(c)).toEqual({ conflict: true, same: true });
  }, 60000);

  test("apply: перед записью та же проверка — ошибка, файл не тронут", () => {
    const f = fixture();
    const file = `${f.home}/x.json`;
    put(file, DUP);
    const actions: Action[] = [{ kind: "merge", abs: file, key: ["mcp"], set: {}, remove: ["tok"], adopt: [], own: [], beforeHash: sha(DUP) }];
    expect(() => apply(actions, emptyState())).toThrow(JsoncError);
    expect(text(file)).toBe(DUP);
  });
});
