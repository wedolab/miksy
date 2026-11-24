// Круг 11s: понятные тексты — доступ к local/ (открыто и не проверено — отдельно) и номер версии движка
import { describe, expect, test } from "bun:test";
import { chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { localAccessText } from "../src/secretfiles";
import { versionNote } from "../src/version";
import { cliFixture, expectCode, put } from "./helpers";

const win = process.platform === "win32";
const sys = (exe: string) => join(process.env.SystemRoot ?? "C:\\Windows", "System32", exe);
// Открыть путь другим: Windows — «Пользователи: чтение»; macOS, Linux — 0644/0755
function open(p: string) {
  if (win) Bun.spawnSync([sys("icacls.exe"), p.replaceAll("/", "\\"), "/grant", "*S-1-5-32-545:(R)"], { stdout: "pipe", stderr: "pipe" });
  else chmodSync(p, statSync(p).isDirectory() ? 0o755 : 0o644);
}

describe("доступ к local/: открытые и непроверенные — отдельно (круг 11s)", () => {
  test("текст: только открытые, только непроверенные, оба вида, ничего", () => {
    expect(localAccessText({ bad: [], failed: [] })).toBeNull();
    expect(localAccessText({ bad: ["local/a: доступ есть не только у владельца (BU)", "local/b: x"], failed: [] }))
      .toBe("открыто другим пользователям: 2 (например, local/a: доступ есть не только у владельца (BU))");
    expect(localAccessText({ bad: ["local/c: icacls не прочитал права"], failed: ["local/c: icacls не прочитал права"] }))
      .toBe("права не удалось проверить: 1 (local/c: icacls не прочитал права)");
    expect(localAccessText({ bad: ["local/a: открыт", "local/c: не прочитаны"], failed: ["local/c: не прочитаны"] }))
      .toBe("открыто другим пользователям: 1 (например, local/a: открыт); права не удалось проверить: 1 (local/c: не прочитаны)");
  });

  test("doctor и sync --dry-run: открытый путь в local/ — «открыто другим пользователям», без «ошибок проверки»", () => {
    const f = cliFixture();
    expectCode(f.run(["sync", "--global"]), 0);
    put(`${f.config}/local/secrets.env`, "A=1\n");
    open(`${f.config}/local/secrets.env`);
    const d = f.run(["doctor"]);
    expect(d.out).toMatch(/Небезопасные права[\s\S]*local\/\s+открыто другим пользователям: 1 \(например, .*secrets\.env: .*\) — sync\/setup закроет local\/ \(секреты и учёт этой машины\) только для вас/);
    expect(d.out).not.toContain("ошибок проверки");
    const s = f.run(["sync", "--global", "--dry-run"]);
    expect(s.out).toMatch(/Доступ к local\/ \(секреты и учёт этой машины\): открыто другим пользователям: 1 \(например, .*secrets\.env: .*\) — sync закроет его только для вас\./);
    const w = f.run(["sync", "--global"]);
    expectCode(w, 0);
    expect(w.out).toContain("Доступ к local/ (секреты и учёт этой машины): закрыт — теперь только для вас.");
    expect(f.run(["doctor"]).out).not.toContain("открыто другим пользователям");
  }, 60000);
});

describe("номер версии: пояснение в miksy --version (круг 11s)", () => {
  test("выпуск — без пояснения; после выпуска и с правками — словами", () => {
    expect(versionNote("0.7.0")).toBeNull();
    expect(versionNote("0.7.0 (коммит abc1234, есть правки)")).toBeNull();
    expect(versionNote("0.7.0-2-gc5c1a79")).toBe("не выпуск: на 2 коммита новее выпуска 0.7.0, коммит c5c1a79");
    expect(versionNote("0.7.0-1-gc5c1a79")).toBe("не выпуск: на 1 коммит новее выпуска 0.7.0, коммит c5c1a79");
    expect(versionNote("0.7.0-12-gc5c1a79-dirty")).toBe("не выпуск: на 12 коммитов новее выпуска 0.7.0, коммит c5c1a79; в папке движка есть незакоммиченные правки");
    expect(versionNote("0.7.0-dirty")).toBe("в папке движка есть незакоммиченные правки");
  });
});
