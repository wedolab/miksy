// Разбор local/secrets.env: кавычки, export, комментарии; пустое значение — заданная переменная
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSecrets } from "../src/load";
import { envLine } from "../src/secrets";
import { put } from "./helpers";

const parse = (text: string) => {
  const root = mkdtempSync(join(tmpdir(), "senv-"));
  put(join(root, "local", "secrets.env"), text);
  return loadSecrets(root);
};

test("кавычки, export, комментарии, пустые значения", () => {
  expect(parse([
    "# комментарий",
    "PLAIN=abc",
    "SPACED = abc  ",
    'DOUBLE="a b # не комментарий"',
    "SINGLE='a\\nb $X \"q\"'",
    "export EXPORTED=e1",
    "export  QUOTED_EXPORT=\"q1\"",
    "INLINE=value # комментарий",
    "HASH=abc#def",
    "EMPTY=",
    'EMPTY_QUOTED=""',
    "  # отступ и комментарий",
    "ESCAPED=\"line1\\nline2\\t\\\"x\\\"\"",
    "",
  ].join("\n"))).toEqual({
    PLAIN: "abc",
    SPACED: "abc",
    DOUBLE: "a b # не комментарий",
    SINGLE: 'a\\nb $X "q"',
    EXPORTED: "e1",
    QUOTED_EXPORT: "q1",
    INLINE: "value",
    HASH: "abc#def",
    EMPTY: "",
    EMPTY_QUOTED: "",
    ESCAPED: 'line1\nline2\\t"x"',
  });
});

test("CRLF и BOM", () => {
  expect(parse("﻿A=1\r\nB='2'\r\n")).toEqual({ A: "1", B: "2" });
});

test("envLine ↔ loadSecrets: любое значение возвращается как было", () => {
  const values = ["simple", "", "with space", "#hash", 'q"uote', "back\\slash", "multi\nline\r\n", "a=b", " lead", "trail ", "'single'"];
  const text = values.map((v, i) => envLine(`V${i}`, v)).join("\n") + "\n";
  expect(parse(text)).toEqual(Object.fromEntries(values.map((v, i) => [`V${i}`, v])));
});

test("пустое значение — заданная переменная: sync не пропускает сервер", async () => {
  const { secretRef, substitute } = await import("../src/vars");
  const r = substitute(
    { layers: [], instructions: [], skills: [], notes: [], mcp: [{ item: { name: "a", command: "x", env: { K: "${OPT}" } }, layer: "l" }] },
    { workspace: "/w", os: "linux", home: "/h", vars: {} },
    parse("OPT=\n"),
  );
  expect(r.skipped).toEqual([]);
  // Значение не подставляется: ссылка на секрет (файл local/secrets/OPT)
  expect(r.resolved.mcp[0].item.env).toEqual({ K: secretRef("OPT") });
});
