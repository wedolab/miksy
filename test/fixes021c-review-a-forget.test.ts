// Выпуск 0.2.1, круг 7c — рецензия A, п. 1 (из out/review021e/miksy/test/zzrev021e-forget.test.ts)
// Рецензия A круга 7c: A3″ — «забыть» агента вне agents через root remove --forget; проект вне workspace
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
  return { f, drive, site };
}

test("root remove --forget (корень недоступен) → диск вернулся, корень назад не добавляли → команда из сообщения / doctor", () => {
  const { f, drive, site } = setup();
  renameSync(drive, `${drive}-disk`);
  const g = inProcess(f, ["root", "remove", drive, "--forget"], f.dir, null);
  renameSync(`${drive}-disk`, drive);
  console.log("ROOT-REMOVE-FORGET\n" + g.out);
  const d = f.run(["doctor"]).out;
  console.log("DOCTOR\n" + d);
  const c = f.run(["clean", site, "--agent", "codex"]);
  console.log("CLEAN-AGENT\n" + c.out + c.err);
  expect({ code: c.code, left: filesIn(site).filter((p) => p.startsWith(".codex")) }).toEqual({ code: 0, left: [] });
}, 240000);

test("root remove --forget → root add → sync --all → root remove с согласием (как велит сообщение) → doctor → команда", () => {
  const { f, drive, site } = setup();
  renameSync(drive, `${drive}-disk`);
  inProcess(f, ["root", "remove", drive, "--forget"], f.dir, null);
  renameSync(`${drive}-disk`, drive);
  expect(f.run(["root", "add", drive, "--tree", "Clients"]).err).toBe("");
  f.run(["sync", "--all", "--yes"]);
  const r = inProcess(f, ["root", "remove", drive], f.dir, [true]);
  console.log("ROOT-REMOVE\n" + r.out);
  const d = f.run(["doctor"]).out;
  console.log("DOCTOR2\n" + d);
  const cmds = [...d.matchAll(/miksy clean "([^"]+)" --agent (\w+)/g)];
  for (const m of cmds) { const c = f.run(["clean", m[1], "--agent", m[2]]); console.log("RUN " + m[0] + " → " + c.code + "\n" + c.out + c.err); }
  console.log("FORGOTTEN " + JSON.stringify(ledger(f.config).forgotten ?? {}));
  expect(filesIn(site).filter((p) => p.startsWith(".codex"))).toEqual([]);
}, 240000);
