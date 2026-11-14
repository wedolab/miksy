// Выпуск 0.2.3, A2 (проверка 8b, B №8): путь или ветка в подсказке с `$`, `!`, «`», `"` и `'` — в кавычках, которые
// оболочка этой машины (PowerShell на Windows, sh/bash/zsh на macOS и Linux) передаёт без изменений; обычный путь — в
// двойных кавычках, как раньше
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { quoteArg } from "../src/paths";
import { cliFixture } from "./helpers";
import { yamlRoots } from "./rootshelp";

const win = process.platform === "win32";
const NAMES = ["C:/Users/you/Work$1 x", "/home/you/Wo!rk", "D:/My 'cfg’ $HOME `x`", "Work$1", "Projects!", "plain path", "a\"b", ...(process.platform === "win32" ? ["D:/“q” „x‟"] : [])];

test("A2: обычный путь — в двойных кавычках, как раньше; ветка без особых знаков — без кавычек", () => {
  expect(quoteArg("C:/Users/you/Projects")).toBe("\"C:/Users/you/Projects\"");
  expect(quoteArg("Clients", true)).toBe("Clients");
  expect(quoteArg("Acme, Inc", true)).toBe("\"Acme, Inc\"");
});

for (const name of NAMES)
  test(`A2: «${name}» — оболочка передаёт как есть`, () => {
    const q = quoteArg(name);
    const shells: string[][] = win
      ? [["powershell", "-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding = [Text.Encoding]::UTF8; Write-Output ${q}`]]
      : [["sh", "-c", `printf '%s\\n' ${q}`], ...(Bun.which("bash") ? [["bash", "-c", `set -H; printf '%s\\n' ${q}`]] : []), ...(Bun.which("zsh") ? [["zsh", "-c", `printf '%s\\n' ${q}`]] : [])];
    for (const argv of shells) {
      const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
      expect({ shell: argv[0], out: r.stdout.toString().replace(/\r?\n$/, "") }).toEqual({ shell: argv[0], out: name });
    }
  });

// Рецензия 9a, №2: путь с $ в подсказке «теперь корень workspace» (doctor) — оболочка передаёт как есть
test("A2: путь с $ в подсказке rootedText — оболочка передаёт как есть", () => {
  const f = cliFixture({ agents: ["claude"], projects: ["Pro$1x"] });
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  const m = `${f.config}/local/machine.yaml`;
  writeFileSync(m, readFileSync(m, "utf8").replace(/^workspace: .*$/m, yamlRoots([f.ws, { path: `${f.ws}/Pro$1x`, tree: "Code" }]).trimEnd()));
  const doc = f.run(["doctor"]);
  const line = (doc.out + doc.err).split("\n").find((l) => /теперь корень workspace/.test(l)) ?? "";
  const cmd = line.match(/убрать записанное: miksy clean (.+)$/)?.[1] ?? "";
  const ps = process.platform === "win32"
    ? Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding = [Text.Encoding]::UTF8; Write-Output ${cmd}`], { stdout: "pipe" })
    : Bun.spawnSync(["sh", "-c", `printf '%s\n' ${cmd}`], { stdout: "pipe" });
  expect({ cmd: !!cmd, arg: ps.stdout.toString().trim() }).toEqual({ cmd: true, arg: `${f.ws}/Pro$1x` });
}, 120000);
