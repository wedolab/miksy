// Выпуск 0.2.1, рецензия части B (временный тест рецензента — out/review021b/miksy/test/review021b-docs.test.ts):
// п. 1 (план update после обновления) — test/update.test.ts; п. 9 — подсказка sync в git-репо вне workspace даёт
// команду root add с --tree, которая работает и без терминала
import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { cliFixture } from "./helpers";
import { git, read } from "./rootshelp";

test("п. 9: sync в git-репо вне workspace — подсказка root add с --tree; выполненная дословно без терминала, она добавляет корень", () => {
  const f = cliFixture({ projects: ["Org/p1"] });
  const repo = `${f.dir}/other/new-repo`;
  git(repo);
  mkdirSync(repo, { recursive: true });
  const s = f.run(["sync"], { cwd: repo });
  const cmd = s.err.match(/miksy root add "([^"]+)" --tree (\S+)/);
  expect(cmd?.[1]).toBe(`${f.dir}/other`);
  const r = f.run(["root", "add", cmd![1], "--tree", cmd![2]]);
  expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
  expect(read(`${f.config}/local/machine.yaml`)).toContain(`${f.dir}/other`);
}, 120000);
