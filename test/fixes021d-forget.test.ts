// Выпуск 0.2.1, круг 7d (проверка 7c, B №1): подсказка после clean … --forget --agent <имя> — команды с тем же
// --agent: после дословного выполнения записанное Claude на месте. Из out/check021c/miksy2/test/zzb-forget3.test.ts
// (случаи C1, C2) с ожиданием верного поведения
import { expect, test } from "bun:test";
import { existsSync, readdirSync, renameSync, statSync } from "node:fs";
import { cliFixture, put } from "./helpers";
import { git, read, yamlRoots } from "./rootshelp";

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
const cmds = (s: string) => [...new Set([...s.matchAll(/miksy ((?:sync|clean) "[^"]+"(?: --\w+(?: \w+)?)*)/g)].map((m) => m[1]))];
const run = (f: any, c: string) => f.run(c.match(/"[^"]*"|\S+/g)!.map((a: string) => a.replace(/^"|"$/g, "")));

function base() {
  const f = cliFixture({ agents: ["claude", "codex"], projects: ["Org/p1"] });
  const drive = `${f.dir}/drive`, site = `${drive}/Acme/site`;
  git(site);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive, tree: "Clients" }])}agents: [claude, codex]\n`);
  put(`${f.config}/layers/tree/Clients/instructions/10.md`, "# clients\n");
  put(`${f.config}/layers/tree/Clients/mcp/tool.yaml`, "name: tool\ncommand: echo\nargs: [x]\n");
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  const dropCodex = () => put(`${f.config}/local/machine.yaml`, read(`${f.config}/local/machine.yaml`).replace("agents: [claude, codex]", "agents: [claude]"));
  return { f, drive, site, dropCodex };
}

for (const [name, drop] of [["C1: codex в agents", false], ["C2: codex убран из agents", true]] as const)
  test(`B №1, ${name}: clean --forget --agent codex → диск вернулся → подсказка дословно → Claude на месте, codex убран`, () => {
    const { f, drive, site, dropCodex } = base();
    if (drop) dropCodex();
    renameSync(drive, `${drive}-disk`);
    const g = f.run(["clean", site, "--forget", "--agent", "codex"]);
    expect(g.code).toBe(0);
    renameSync(`${drive}-disk`, drive);
    const hint = cmds(g.out);
    expect(hint.length).toBeGreaterThan(0);
    for (const c of hint) expect(c).toContain("--agent codex");
    for (const c of hint) if (!c.includes("--force")) expect([0, 3]).toContain(run(f, c).code);
    // Записанное Claude — на месте; файлов codex нет
    expect(read(`${site}/CLAUDE.local.md`)).toContain("# clients");
    expect(filesIn(site).filter((p) => p.startsWith(".codex") || p.startsWith(".agents"))).toEqual([]);
    const claude = JSON.parse(read(`${f.home}/.claude.json`));
    const key = Object.keys(claude.projects ?? {}).find((k) => k.toLowerCase() === site.toLowerCase());
    expect(Object.keys(claude.projects[key!].mcpServers ?? {})).toContain("tool");
  }, 240000);
