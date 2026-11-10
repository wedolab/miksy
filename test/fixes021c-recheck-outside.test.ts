// Выпуск 0.2.1, круг 7c — повторная проверка правок по рецензии A, п. 1 (из out/review021g/miksy/test/zzrevA021g-outside.test.ts)
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
  put(`${f.config}/layers/tree/Clients/skills/s1/SKILL.md`, "---\nname: s1\ndescription: d\n---\nbody\n");
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  put(`${f.config}/local/machine.yaml`, read(`${f.config}/local/machine.yaml`).replace("agents: [claude, codex]", "agents: [claude]"));
  renameSync(drive, `${drive}-disk`);
  const g = inProcess(f, ["root", "remove", drive, "--forget"], f.dir, null);
  renameSync(`${drive}-disk`, drive);
  return { f, site, g };
}

// Подсказка после clean забытой папки вне workspace: сначала вернуть корень (root add), затем sync и clean — выполненная
// дословно (с настоящей папкой и веткой), не оставляет файлов агента (повторная проверка 7c, п. 1)
for (const agent of [null, "codex"] as const)
  test(`вне workspace: clean ${agent ? "--agent codex" : "без --agent"} → подсказка (root add → sync → clean) дословно → файлов агента нет`, () => {
    const { f, site } = setup();
    const drive = site.slice(0, site.indexOf("/Acme/site"));
    const c = f.run(["clean", site, ...(agent ? ["--agent", agent] : [])]);
    expect(c.code).toBe(0);
    expect(c.out.split("\n").filter((l) => /^\s+miksy root add /.test(l)).length).toBe(1);
    const line = c.out.split("\n").filter((l) => /^\s+miksy sync /.test(l)).join("\n");
    expect(f.run(["root", "add", drive, "--tree", "Clients"]).code).toBe(0);
    for (const m of line.matchAll(/miksy (sync|clean) "([^"]+)"( --agent \w+)?/g)) {
      const r = f.run([m[1], m[2], ...(m[3] ? m[3].trim().split(" ") : [])]);
      expect([0, 3]).toContain(r.code);
    }
    const left = filesIn(site).filter((p) => (agent ? p.startsWith(".codex") || p.startsWith(".agents") : p.startsWith(".claude") || p === "CLAUDE.local.md"));
    expect(left).toEqual([]);
  }, 240000);

// Для сравнения: та же папка в workspace (clean --forget при недоступном диске, корень на месте) — подсказка выполнима
test("в workspace: clean --agent codex → подсказка sync/clean --agent codex убирает skill codex", () => {
  const f = cliFixture({ agents: ["claude", "codex"], projects: ["Org/p1"] });
  const drive = `${f.dir}/drive`, site = `${drive}/Acme/site`;
  git(site);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive, tree: "Clients" }])}agents: [claude, codex]\n`);
  put(`${f.config}/layers/tree/Clients/instructions/10.md`, "# clients\n");
  put(`${f.config}/layers/tree/Clients/skills/s1/SKILL.md`, "---\nname: s1\ndescription: d\n---\nbody\n");
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  put(`${f.config}/local/machine.yaml`, read(`${f.config}/local/machine.yaml`).replace("agents: [claude, codex]", "agents: [claude]"));
  renameSync(drive, `${drive}-disk`);
  f.run(["clean", site, "--forget"]);
  renameSync(`${drive}-disk`, drive);
  const c = f.run(["clean", site, "--agent", "codex"]);
  const hint = c.out.match(/(miksy sync "[^"]+" --agent codex); (miksy clean "[^"]+" --agent codex)/);
  console.log("IN-WS LEFT after clean: " + filesIn(site).join(", "));
  expect(hint).not.toBeNull();
  const s = f.run(["sync", site, "--agent", "codex"]);
  const c2 = f.run(["clean", site, "--agent", "codex"]);
  console.log("IN-WS sync " + s.code + s.err + " clean " + c2.code + " LEFT: " + filesIn(site).join(", "));
  expect(filesIn(site).filter((p) => p.startsWith(".codex") || p.startsWith(".agents"))).toEqual([]);
}, 240000);
