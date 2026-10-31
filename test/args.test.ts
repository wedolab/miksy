import { describe, expect, test } from "bun:test";
import { COMMANDS, parseArgs, UsageError } from "../src/args";
import { USAGE } from "../src/commands";

describe("parseArgs", () => {
  test("флаги со значением: через пробел и через =", () => {
    expect(parseArgs("sync", ["p", "--agent", "codex", "--dry-run"])).toEqual({ flags: { agent: "codex", "dry-run": "" }, positional: ["p"] });
    expect(parseArgs("adopt", ["--global", "ctx", "--to=Org/Team"])).toEqual({ flags: { global: "", to: "Org/Team" }, positional: ["ctx"] });
    expect(parseArgs("sync", ["--out=../sb", "--agent=claude"]).flags).toEqual({ out: "../sb", agent: "claude" });
  });

  test("ошибки разбора — UsageError", () => {
    for (const [cmd, args] of [
      ["sync", ["--global", "--dryrun"]],
      ["sync", ["--global", "--agent"]],
      ["sync", ["--global", "--force=1"]],
      ["setup", ["--agent", "x"]],
      ["projects", ["extra"]],
      ["adopt", ["p", "--to", "Org"]], // нет имени
      ["adopt", ["--global", "p", "name", "--to", "Org"]], // лишний путь
      ["skills", ["p", "--all"]],
      ["sync", ["--all", "--out", "x"]],
      ["nope", []],
    ] as [string, string[]][])
      expect(() => parseArgs(cmd, args), `${cmd} ${args.join(" ")}`).toThrow(UsageError);
  });

  test("значение, похожее на путь с дефисом, — не флаг", () => {
    expect(parseArgs("explain", ["-"]).positional).toEqual(["-"]);
    expect(parseArgs("sync", ["--out", "-x", "--global"]).flags.out).toBe("-x");
  });
});

// help — для нового пользователя: каждая команда, разница --global и --all, ссылка на README, узко
test("help: все команды, --global — домашние настройки (global, env-<ОС>), --all — дерево; строки до 100 символов", () => {
  for (const cmd of Object.keys(COMMANDS)) expect(USAGE).toContain(`miksy ${cmd}`);
  expect(USAGE).toMatch(/sync --global[\s\S]*layers\/global[\s\S]*env-<ОС>[\s\S]*во всех каталогах/);
  expect(USAGE).toMatch(/sync --all[\s\S]*layers\/tree/);
  expect(USAGE).toContain("README");
  expect(USAGE).toContain("Примеры");
  expect(Math.max(...USAGE.split("\n").map((l) => l.length))).toBeLessThanOrEqual(100);
});
