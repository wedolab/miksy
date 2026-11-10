// Выпуск 0.2.1, круг 7c (проверка 7b, B №4): итог clean --all при недоступном корне — в числе только агенты из agents,
// остальным — clean --agent. Из out/check021b/miksy2/test/zz-revb-cleanall.test.ts (тест 2) с ожиданиями
import { expect, test } from "bun:test";
import { existsSync, renameSync } from "node:fs";
import { cliFixture, put } from "./helpers";
import { git, yamlRoots } from "./rootshelp";

test("B №4: clean --all, codex убран из agents, корень недоступен — обещание = сделанное; codex — clean --agent", () => {
  const f = cliFixture({ projects: ["Org/p1"], agents: ["claude", "codex"] });
  const drive = `${f.dir}/drive`, site = `${drive}/Acme/site`;
  git(site);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive, tree: "Clients" }])}agents: [claude, codex]\n`);
  put(`${f.config}/layers/tree/Clients/instructions/10.md`, "# clients\n");
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive, tree: "Clients" }])}agents: [claude]\n`);
  renameSync(drive, `${drive}-disk`);
  const c = f.run(["clean", "--all"]);
  const n = Number(c.out.match(/осталось записанное miksy — (\d+) файл/)?.[1]);
  const cmd = c.out.match(/clean --all не убирает — когда диск вернётся:\n\s+(miksy clean "([^"]+)" --agent codex)/);
  expect(cmd).not.toBeNull();
  renameSync(`${drive}-disk`, drive);
  expect(f.run(["clean", "--all"]).code).toBe(0);
  expect(existsSync(`${site}/CLAUDE.local.md`)).toBe(false);
  expect(n).toBe(2); // CLAUDE.local.md и строка .git/info/exclude
  expect(existsSync(`${site}/.codex/config.toml`)).toBe(true);
  expect(f.run(["clean", cmd![2], "--agent", "codex"]).code).toBe(0);
  expect(existsSync(`${site}/.codex/config.toml`)).toBe(false);
}, 240000);
