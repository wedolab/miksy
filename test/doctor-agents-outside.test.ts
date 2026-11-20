// doctor, «Справочно»: агент в PATH, которого нет в agents (круг 10i) — подсказка, как подключить; агенту с учётом
// (убран из agents без clean) — прежняя строка «Учёт агентов, которых нет в agents», без повтора
import { expect, test } from "bun:test";
import { chmodSync, readFileSync } from "node:fs";
import { delimiter } from "node:path";
import { cliFixture, expectCode, put, said } from "./helpers";

const win = process.platform === "win32";

// Запуск с поддельной командой codex первой в PATH
function withCodex<T>(dir: string, fn: () => T): T {
  const bin = `${dir}/fakebin`;
  put(win ? `${bin}/codex.cmd` : `${bin}/codex`, win ? "@echo off\r\n" : "#!/bin/sh\n");
  if (!win) chmodSync(`${bin}/codex`, 0o755);
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const saved = process.env[key];
  process.env[key] = `${bin}${delimiter}${saved}`;
  try { return fn(); } finally { process.env[key] = saved; }
}

const line = /Найдены агенты вне agents \(local\/machine\.yaml\): ([^\n]*?) — miksy (его|их) не настраивает\. Подключить: miksy setup в терминале \(спросит\) или допишите (его|их) в agents в local\/machine\.yaml, затем miksy sync --global и miksy sync --all\. Убрали (его|их) сами — ничего делать не нужно/;

test("агент в PATH вне agents — строка в «Справочно», не проблема", () => {
  const f = cliFixture({ agents: ["claude"] });
  expectCode(f.run(["sync", "--all"]), 0);
  expectCode(f.run(["sync", "--global"]), 0);
  const d = withCodex(f.dir, () => f.run(["doctor"]));
  expectCode(d, 0);
  const info = d.out.split("Справочно:")[1] ?? "";
  expect(info.match(line)?.[1].split(", "), said(d)).toContain("codex");
}, 60000);

test("агент с учётом, убранный из agents вручную, — только строка учёта с командами clean", () => {
  const f = cliFixture({ agents: ["claude"] });
  const machine = `${f.config}/local/machine.yaml`;
  const text = readFileSync(machine, "utf8");
  put(machine, text.replace(/^agents: .*$/m, "agents: [claude, codex]"));
  expectCode(f.run(["sync", "--global"]), 0);
  put(machine, text);
  const d = withCodex(f.dir, () => f.run(["doctor"]));
  expect(d.out, said(d)).toContain("miksy clean --global --agent codex");
  expect(d.out.match(line)?.[1].split(", ") ?? [], said(d)).not.toContain("codex");
}, 60000);

test("без agents в machine.yaml (настраиваются все агенты) — строки нет", () => {
  const f = cliFixture({ agents: ["claude"] });
  const machine = `${f.config}/local/machine.yaml`;
  put(machine, readFileSync(machine, "utf8").replace(/^agents: .*\n/m, ""));
  const d = withCodex(f.dir, () => f.run(["doctor"]));
  expect(d.out, said(d)).not.toMatch(line);
}, 60000);
