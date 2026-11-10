// Выпуск 0.2.1, круг 7c (проверка 7b, рецензия A №1, №2). Из тестов рецензента
// out/check021b/miksy/test/zzcheck021b-trustpaths.test.ts — с ожиданием верного поведения
import { expect, test } from "bun:test";
import { mkdirSync, renameSync } from "node:fs";
import { cliFixture, put } from "./helpers";
import { git, inProcess, ledger, read, yamlRoots } from "./rootshelp";
import { allow, commit, hasTag, local, oldEngine, oldRunner, trusted, userTrusts } from "./fixes021b-helpers";

const pending = (out: string) => out.includes("Нужно решение пользователя о доверии");

function unreachable(run: (a: string[]) => { out: string; err: string }, f: ReturnType<typeof cliFixture>) {
  const drive = `${f.dir}/drive`;
  git(`${drive}/Acme/site`);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive, tree: "Clients" }])}agents: [claude]\n`);
  const site = `${drive}/Acme/site`;
  expect(run(["sync", "--all", "--yes"]).err).toBe("");
  allow(site);
  expect(run(["sync", site]).out).not.toContain("Нужно решение");
  renameSync(drive, `${drive}-off`);
  expect(run(["clean", site]).err).toBe("");
  return { drive, site };
}

test.skipIf(!hasTag())("A1″: clean недоступной папки → на её месте чужая копия → sync: вопрос и в 0.2.0, и в 0.2.1", () => {
  const res: Record<string, [boolean, boolean]> = {};
  for (const ver of ["0.2.0", "0.2.1"]) {
    const f = cliFixture({ projects: ["Org/p1"] });
    const run = ver === "0.2.1" ? f.run : oldRunner(oldEngine(), f);
    const { drive, site } = unreachable(run, f);
    mkdirSync(drive);
    git(site);
    put(local(site), JSON.stringify({ permissions: { allow: ["Bash(rm -rf:*)", "Bash(curl:*)"] } }, null, 2));
    const s = run(["sync", site]);
    res[ver] = [pending(s.out), trusted(f.home, site)];
  }
  expect(res).toEqual({ "0.2.0": [true, false], "0.2.1": [true, false] });
}, 300000);

test("A1″: clean недоступной папки → диск вернулся, свои ответы те же → sync без вопроса; отметка — с отпечатком последнего sync", () => {
  const f = cliFixture({ projects: ["Org/p1"] });
  const { drive, site } = unreachable(f.run, f);
  const m = ledger(f.config) as any;
  const id = Object.keys(m.trustedBefore ?? {})[0];
  expect(id?.toLowerCase()).toBe(`claude|${site}`.toLowerCase());
  expect(Object.values(m.targets).some((st: any) => st.everTrusted && JSON.stringify(st).toLowerCase().includes(site.toLowerCase()))).toBe(false);
  renameSync(`${drive}-off`, drive);
  const s = f.run(["sync", site]);
  expect({ asked: pending(s.out), trusted: trusted(f.home, site) }).toEqual({ asked: false, trusted: true });
}, 120000);

test("A1″: учёт без отпечатка (прежняя версия) → clean недоступной папки → диск вернулся → один вопрос о своих ответах", () => {
  const f = cliFixture({ projects: ["Org/p1"] });
  const drive = `${f.dir}/drive`;
  git(`${drive}/Acme/site`);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive, tree: "Clients" }])}agents: [claude]\n`);
  const site = `${drive}/Acme/site`;
  expect(f.run(["sync", "--all", "--yes"]).err).toBe("");
  allow(site);
  expect(f.run(["sync", site]).out).not.toContain("Нужно решение");
  const m = ledger(f.config) as any;
  for (const st of Object.values(m.targets) as any[]) delete st.dialog;
  put(`${f.config}/local/state/manifest.json`, JSON.stringify(m, null, 2) + "\n");
  renameSync(drive, `${drive}-off`);
  expect(f.run(["clean", site]).err).toBe("");
  renameSync(`${drive}-off`, drive);
  const s = f.run(["sync", site]);
  expect(pending(s.out)).toBe(true);
  expect(s.out).toContain("ответы в окне Claude («да");
}, 120000);

test("A1″: свои ответы добавлены после последнего sync — sync без изменений обновляет отпечаток", () => {
  const f = cliFixture({ projects: ["Org/p1"] });
  const p1 = `${f.ws}/Org/p1`;
  expect(f.run(["sync", "--all", "--yes"]).err).toBe("");
  allow(p1);
  f.run(["sync", p1]);
  const before = JSON.stringify(ledger(f.config));
  put(local(p1), JSON.stringify({ ...JSON.parse(read(local(p1))), permissions: { allow: ["Bash(ls:*)", "Bash(git:*)"] } }, null, 2));
  f.run(["sync", p1]);
  expect(JSON.stringify(ledger(f.config))).not.toBe(before);
  f.run(["sync", "--all", "--dry-run", "--yes"]);
}, 120000);

// Пара 0.2.0 «нет» + «да» серверам, одобрение в файле (0.2.0 вернула его после доверия в окне Claude)
test.skipIf(!hasTag())("A2″: обновление — пара 0.2.0 с одобрением в файле: первый sync 0.2.1 снимает одобрение и спрашивает сразу; «да» — одобрение остаётся", () => {
  for (const answer of ["y", "n"]) {
    const f = cliFixture({ projects: ["Org/app"] });
    const old = oldRunner(oldEngine(), f);
    const app = `${f.ws}/Org/app`;
    expect(old(["sync", "--all", "--yes"]).err).toBe("");
    commit(app, { ".mcp.json": JSON.stringify({ mcpServers: { team: { command: "team-server" } } }) });
    old(["trust", app, "--confirm"]);
    old(["trust", app, "--deny"]);
    userTrusts(f.home, app);
    expect(old(["sync", app]).out).toContain("+ team");
    const s = inProcess(f, ["sync", app], f.dir, [answer]);
    expect({ answer, err: s.err, q: s.questions.length }).toEqual({ answer, err: "", q: 1 });
    expect({ answer, approved: read(local(app)).includes("\"team\"") }).toEqual({ answer, approved: answer === "y" });
    // Без терминала — снимается, и miksy говорит, как одобрить
    if (answer === "n") {
      const again = f.run(["sync", app]);
      expect(again.out).not.toContain("+ team");
    }
  }
  // Без терминала: снятие и подсказка
  const f = cliFixture({ projects: ["Org/app"] });
  const old = oldRunner(oldEngine(), f);
  const app = `${f.ws}/Org/app`;
  old(["sync", "--all", "--yes"]);
  commit(app, { ".mcp.json": JSON.stringify({ mcpServers: { team: { command: "team-server" } } }) });
  old(["trust", app, "--confirm"]);
  old(["trust", app, "--deny"]);
  userTrusts(f.home, app);
  old(["sync", app]);
  const s = f.run(["sync", app]);
  expect(s.out).toContain("- team");
  expect(pending(s.out)).toBe(true);
  expect(s.out).toMatch(/miksy trust/);
}, 300000);
