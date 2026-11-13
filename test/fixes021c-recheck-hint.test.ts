// Выпуск 0.2.1, круг 7c — повторная проверка 2 (out/review021h/miksy/test/zzrev021h.test.ts): подсказка clean забытой папки — все агенты, прежний корень
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

function setup(skillLayer = "Clients") {
  const f = cliFixture({ agents: ["claude", "codex"], projects: ["Org/p1"] });
  const drive = `${f.dir}/drive`, site = `${drive}/Acme/site`;
  git(site);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive, tree: "Clients" }])}agents: [claude, codex]\n`);
  put(`${f.config}/layers/tree/Clients/instructions/10.md`, "# clients\n");
  put(`${f.config}/layers/tree/${skillLayer}/skills/s1/SKILL.md`, "---\nname: s1\ndescription: d\n---\nbody\n");
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  put(`${f.config}/local/machine.yaml`, read(`${f.config}/local/machine.yaml`).replace("agents: [claude, codex]", "agents: [claude]"));
  renameSync(drive, `${drive}-disk`);
  inProcess(f, ["root", "remove", drive, "--forget"], f.dir, null);
  renameSync(`${drive}-disk`, drive);
  return { f, site, drive };
}

// Строки подсказки — дословно; вместо заглушек прежнего корня и ветки — настоящие (их печатал root remove)
function follow(f: ReturnType<typeof setup>["f"], out: string, drive: string) {
  let rootAdded = false;
  for (const l of out.split("\n").filter((x) => /^\s+(miksy root add|miksy sync)/.test(x))) {
    if (l.includes("miksy root add") && !rootAdded) { expect(f.run(["root", "add", drive, "--tree", "Clients"]).code).toBe(0); rootAdded = true; }
    for (const m of l.matchAll(/miksy (sync|clean) "([^"]+)"( --agent \w+)?/g)) expect([0, 3]).toContain(f.run([m[1], m[2], ...(m[3] ? m[3].trim().split(" ") : [])]).code);
  }
}

test("Б, вне workspace: clean без --agent → подсказка называет и codex (вне agents) и прежний корень → дословно → в папке ничего", () => {
  const { f, site, drive } = setup();
  const c = f.run(["clean", site]);
  expect(c.out).toMatch(/--agent codex/);
  expect(c.out).toContain("корень workspace, в котором лежала папка");
  follow(f, c.out, drive);
  expect(filesIn(site)).toEqual([]);
  expect(Object.keys((ledger(f.config) as any).forgotten ?? {})).toEqual([]);
}, 240000);

test("Б, в workspace: clean без --agent забытой папки → подсказка с codex → дословно → в папке ничего", () => {
  const f = cliFixture({ agents: ["claude", "codex"], projects: ["Org/p1"] });
  const drive = `${f.dir}/drive`, site = `${drive}/Acme/site`;
  git(site);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive, tree: "Clients" }])}agents: [claude, codex]\n`);
  put(`${f.config}/layers/tree/Clients/skills/s1/SKILL.md`, "---\nname: s1\ndescription: d\n---\nbody\n");
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  put(`${f.config}/local/machine.yaml`, read(`${f.config}/local/machine.yaml`).replace("agents: [claude, codex]", "agents: [claude]"));
  renameSync(drive, `${drive}-disk`);
  f.run(["clean", site, "--forget"]);
  renameSync(`${drive}-disk`, drive);
  const c = f.run(["clean", site]);
  expect(c.out).not.toContain("root add");
  follow(f, c.out, drive);
  expect(filesIn(site)).toEqual([]);
}, 240000);

test("dry-run подсказка = настоящая", () => {
  const { f, site } = setup();
  const hint = (o: string) => o.split("\n").filter((l) => /^\s+miksy /.test(l)).join("\n");
  expect(hint(f.run(["clean", site, "--dry-run"]).out)).toBe(hint(f.run(["clean", site]).out));
}, 240000);
