// Удалённый из слоя skill не оставляет у агентов пустых каталогов; каталог skills и чужие skills — на месте
import { expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { cliFixture, put } from "./helpers";

test("skill убран из слоя: его каталоги у агентов удаляются, skills и чужое остаются", () => {
  const f = cliFixture({ agents: ["claude", "codex"] });
  put(`${f.config}/layers/tree/skills/old/SKILL.md`, "---\nname: old\ndescription: d\n---\n");
  put(`${f.config}/layers/tree/skills/old/scripts/deep/run.sh`, "echo\n");
  const p = `${f.ws}/Org/p1`;
  expect(f.run(["sync", p]).code).toBe(0);
  expect(existsSync(`${p}/.claude/skills/old/scripts/deep/run.sh`)).toBe(true);
  put(`${p}/.claude/skills/mine/SKILL.md`, "---\nname: mine\ndescription: d\n---\n");

  rmSync(`${f.config}/layers/tree/skills`, { recursive: true });
  const r = f.run(["sync", p]);
  expect(r.code).toBe(0);
  for (const dir of [".claude/skills", ".agents/skills"]) {
    expect(existsSync(`${p}/${dir}/old`)).toBe(false);
    expect(existsSync(`${p}/${dir}`)).toBe(true);
  }
  expect(existsSync(`${p}/.claude/skills/mine/SKILL.md`)).toBe(true);
}, 60000);
