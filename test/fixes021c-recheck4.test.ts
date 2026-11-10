// Выпуск 0.2.1, круг 7c — повторная проверка 4 (out/review021j/miksy/test/zzrev021j.test.ts): отметка «забыт» только у агента вне agents
import { expect, test } from "bun:test";
import { existsSync, readdirSync, renameSync, statSync } from "node:fs";
import { cliFixture, put } from "./helpers";
import { git, inProcess, ledger, read, yamlRoots } from "./rootshelp";
import { claudeJson, userTrusts, trusted } from "./fixes021b-helpers";

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

function base(agents: string[]) {
  const f = cliFixture({ agents, projects: ["Org/p1"] });
  const drive = `${f.dir}/drive`, site = `${drive}/Acme/site`;
  git(site);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive, tree: "Clients" }])}agents: [${agents.join(", ")}]\n`);
  put(`${f.config}/layers/tree/Clients/instructions/10.md`, "# clients\n");
  put(`${f.config}/layers/tree/Clients/skills/s1/SKILL.md`, "---\nname: s1\ndescription: d\n---\nbody\n");
  put(`${f.config}/layers/tree/Clients/mcp/m1.yaml`, "name: m1\ncommand: echo\nargs: [hi]\n");
  const s0 = inProcess(f, ["sync", "--all", "--yes"], f.dir, null);
  expect(s0.code).toBe(0);
  return { f, drive, site };
}

// Отметка «забыт» только у codex (вне agents); claude уже в учёте — подсказка велит и `sync site; clean site` без --agent
test("E: подсказка для отметки только у агента вне agents — лишний sync/clean claude и вопросы", () => {
  const { f, drive, site } = base(["claude", "codex"]);
  put(`${f.config}/local/machine.yaml`, read(`${f.config}/local/machine.yaml`).replace("agents: [claude, codex]", "agents: [claude]"));
  renameSync(drive, `${drive}-disk`);
  inProcess(f, ["clean", site, "--forget"], f.dir, null);
  renameSync(`${drive}-disk`, drive);
  const s = inProcess(f, ["sync", site], f.dir, [true, true, true, true]);
  console.log("E sync questions: " + JSON.stringify(s.questions) + " code " + s.code + " " + s.err);
  const c = inProcess(f, ["clean", site], f.dir, [true, true, true, true]);
  console.log("E clean questions: " + JSON.stringify(c.questions));
  console.log("E clean out tail:\n" + c.out.split("\n").slice(-8).join("\n"));
  console.log("E after clean trusted=" + trusted(f.home, site) + " trustedBefore=" + JSON.stringify((ledger(f.config) as any).trustedBefore ?? {}));
  // После clean пользователь сам доверился папке в окне Claude (его ответ)
  if (process.env.E_USER_TRUST) userTrusts(f.home, site);
  const hint = c.out.split("\n").filter((l) => /^\s+miksy /.test(l));
  console.log("E hint lines: " + hint.length);
  const qs: string[][] = [];
  for (const l of hint) for (const part of l.trim().split("; ")) {
    const args = (part.match(/"[^"]+"|\S+/g) ?? []).slice(1).map((x) => x.replace(/^"|"$/g, ""));
    const r = inProcess(f, args, f.dir, []);
    qs.push([part.slice(0, 40), String(r.code), r.err, ...r.questions]);
  }
  console.log("E follow: " + JSON.stringify(qs, null, 1));
  console.log("E LEFT: " + filesIn(site).join(", "));
  console.log("E trusted after=" + trusted(f.home, site) + " claude.json=" + JSON.stringify(claudeJson(f.home).projects ?? {}));
  // Первая строка подсказки (sync/clean без --agent) не нужна: у claude отметки нет, его записанное уже убрано по учёту
  expect(hint.filter((l) => !l.includes("--agent")).length).toBe(0);
}, 240000);

// clean --dry-run и настоящий clean: подсказка одна и та же
test("F: dry-run совпадает с настоящим clean по подсказке", () => {
  const { f, drive, site } = base(["claude", "codex"]);
  put(`${f.config}/local/machine.yaml`, read(`${f.config}/local/machine.yaml`).replace("agents: [claude, codex]", "agents: [claude]"));
  renameSync(drive, `${drive}-disk`);
  inProcess(f, ["clean", site, "--forget"], f.dir, null);
  renameSync(`${drive}-disk`, drive);
  inProcess(f, ["sync", site], f.dir, null);
  const d = inProcess(f, ["clean", "--all", "--dry-run"], f.dir, null);
  const c = inProcess(f, ["clean", "--all"], f.dir, null);
  const h = (o: string) => o.split("\n").filter((l) => /^\s+miksy (sync|root)/.test(l)).join("\n");
  console.log("F dry:\n" + h(d.out) + "\nF real:\n" + h(c.out));
  expect(h(d.out)).toBe(h(c.out));
  expect(h(c.out)).toContain("--agent codex");
}, 240000);
