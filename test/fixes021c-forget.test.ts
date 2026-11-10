// Выпуск 0.2.1, круг 7c (проверка 7b, B №1): «забыть» при агенте, убранном из agents. Из out/check021b/miksy2/test/zz-revb-forget.test.ts с ожиданиями
import { expect, test } from "bun:test";
import { existsSync, readdirSync, renameSync, statSync } from "node:fs";
import { cliFixture, put } from "./helpers";
import { git, inProcess, ledger, read, yamlRoots } from "./rootshelp";

const filesIn = (dir: string, base = dir, out: string[] = []): string[] => {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    if (dir === base && n === ".git") continue;
    const p = `${dir}/${n}`;
    if (statSync(p).isDirectory()) filesIn(p, base, out);
    else out.push(p.slice(base.length + 1));
  }
  return out.sort();
};

function setup() {
  const f = cliFixture({ agents: ["claude", "codex"], projects: ["Org/p1"] });
  const drive = `${f.dir}/drive`, site = `${drive}/Acme/site`;
  git(site);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive, tree: "Clients" }])}agents: [claude, codex]\n`);
  put(`${f.config}/layers/tree/Clients/instructions/10.md`, "# clients\n");
  put(`${f.config}/layers/tree/Clients/mcp/tool.yaml`, "name: tool\ncommand: echo\nargs: [x]\n");
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  expect(filesIn(site)).toContain(".codex/config.toml");
  put(`${f.config}/local/machine.yaml`, read(`${f.config}/local/machine.yaml`).replace("agents: [claude, codex]", "agents: [claude]"));
  renameSync(drive, `${drive}-disk`);
  const g = f.run(["clean", site, "--forget"]);
  renameSync(`${drive}-disk`, drive);
  return { f, site, g };
}

test("B №1: «забыть» с агентом вне agents → диск вернулся → команды из сообщения дословно и doctor → файлов codex не осталось", () => {
  const { f, site, g } = setup();
  const cmd = g.out.match(/уберёт (miksy clean "[^"]+" --agent codex)/);
  expect(cmd).not.toBeNull();
  // sync и clean проекта (из сообщения «Если диск найдётся») codex не трогают — отметка codex остаётся
  f.run(["sync", site]);
  f.run(["clean", site]);
  const d = f.run(["doctor"]);
  expect(d.out).toMatch(/miksy clean "[^"]+" --agent codex/);
  const c = f.run(["clean", site, "--agent", "codex"]);
  expect(c.code).toBe(0);
  expect(filesIn(site)).toEqual([]);
  expect(Object.keys(ledger(f.config).forgotten ?? {})).toEqual([]);
  expect(f.run(["doctor"]).out.toLowerCase()).not.toContain(`"${site}" --agent codex`.toLowerCase());
}, 240000);

test("B №1: после возвращения диска сразу clean --agent codex — убирает файлы codex", () => {
  const { f, site } = setup();
  expect(f.run(["clean", site, "--agent", "codex"]).code).toBe(0);
  expect(filesIn(site).filter((p) => p.startsWith(".codex") || p.startsWith(".agents"))).toEqual([]);
}, 240000);
