// Выпуск 0.2.1, круг 7c: правило доверия на всех путях (план out/7c-plan.md, одобрен основным агентом).
// R1: после clean / root remove / «забыть» / недоступности ответы в окне Claude «свои» только при совпавшем отпечатке;
//     отпечатка нет — один вопрос; чужая копия или новые ответы — вопрос и нет доверия.
// R2: снятие своего одобрения серверов .mcp.json и вопрос о них — в одном sync; «нет» — дальше не спрашивает и не одобряет.
// R3: после «забыть» у агента вне agents есть названная команда, после которой его файлов нет.
//     R1 — в fixes021c-rule-r1{a,b,c}.test.ts (по группам путей, круг 10d); общее — fixes021c-rule-help.ts
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { cliFixture, put, expectCode } from "./helpers";
import { git, inProcess, ledger, read, yamlRoots } from "./rootshelp";
import { commit, hasTag, local, oldEngine, oldRunner, patchLocal, userTrusts } from "./fixes021b-helpers";
import { DIALOG, off, ok, on, setup } from "./fixes021c-rule-help";

// Проверка 1 основного агента: путь 3, в файле остались одобрения miksy (clean недоступной папки их не убрал). Отпечаток
// при sync и при сравнении — без одобрений miksy (по учёту). «Да» доверию здесь снято (local/trust.json удалён), иначе
// ответы свои по решению: так видно именно сравнение отпечатков
test("R1, путь 3: одобрения miksy остались в файле — свои ответы не в вопросе; изменённые — в вопросе", () => {
  for (const v of ["свои", "изменены"] as const) {
    const e = setup(true);
    off(e);
    ok(e.f.run(["clean", e.site]));
    on(e);
    expect(read(local(e.site))).toContain("\"team\"");
    rmSync(`${e.f.config}/local/trust.json`);
    if (v === "изменены") patchLocal(e.site, { permissions: { allow: ["Bash(ls:*)", "Bash(curl:*)"] } });
    const d = e.f.run(["doctor"]).out;
    const s = e.f.run(["sync", e.site]);
    expect({ v, doctor: d.includes(DIALOG), sync: s.out.includes(DIALOG) }).toEqual({ v, doctor: v === "изменены", sync: v === "изменены" });
  }
}, 300000);

test.skipIf(!hasTag())("R2: пара 0.2.0 «нет» + «да» серверам, одобрение в файле — снятие и вопрос в одном sync; «нет» — дальше не спрашивает и не одобряет", () => {
  const f = cliFixture({ projects: ["Org/app"] });
  const old = oldRunner(oldEngine(), f);
  const app = `${f.ws}/Org/app`;
  expect(old(["sync", "--all", "--yes"]).err).toBe("");
  commit(app, { ".mcp.json": JSON.stringify({ mcpServers: { team: { command: "team-server" } } }) });
  old(["trust", app, "--confirm"]);
  old(["trust", app, "--deny"]);
  userTrusts(f.home, app);
  expect(old(["sync", app]).out).toContain("+ team");
  const s = inProcess(f, ["sync", app], f.dir, ["n"]);
  expect({ err: s.err, q: s.questions.length }).toEqual({ err: "", q: 1 });
  expect(read(local(app))).not.toContain("\"team\"");
  const again = inProcess(f, ["sync", app], f.dir, []); // лишний вопрос — ошибка «лишний вопрос»
  expect({ err: again.err, q: again.questions.length }).toEqual({ err: "", q: 0 });
  expect(read(local(app))).not.toContain("\"team\"");
}, 300000);

const filesIn = (dir: string, base = dir, out: string[] = []): string[] => {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    if (dir === base && n === ".git") continue;
    const p = `${dir}/${n}`;
    if (statSync(p).isDirectory()) filesIn(p, base, out);
    else out.push(p.slice(base.length + 1));
  }
  return out;
};

test("R3: «забыть» с агентом вне agents → команды из сообщения дословно → команда из doctor → файлов агента нет", () => {
  const f = cliFixture({ agents: ["claude", "codex"], projects: ["Org/p1"] });
  const drive = `${f.dir}/drive`, site = `${drive}/Acme/site`;
  git(site);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive, tree: "Clients" }])}agents: [claude, codex]\n`);
  put(`${f.config}/layers/tree/Clients/mcp/tool.yaml`, "name: tool\ncommand: echo\nargs: [x]\n");
  expectCode(f.run(["sync", "--all", "--yes"]), 0);
  put(`${f.config}/local/machine.yaml`, read(`${f.config}/local/machine.yaml`).replace("agents: [claude, codex]", "agents: [claude]"));
  renameSync(drive, `${drive}-off`);
  const g = f.run(["clean", site, "--forget"]);
  ok(g);
  renameSync(`${drive}-off`, drive);
  const named = [...g.out.matchAll(/miksy (sync|clean) "([^"]+)"( --agent \w+)?/g)].map((m) => [m[1], m[2], ...(m[3] ? m[3].trim().split(" ") : [])]);
  expect(named.some((c) => c.includes("--agent"))).toBe(true);
  for (const c of named) f.run(c);
  const d = f.run(["doctor"]).out;
  for (const m of d.matchAll(/miksy clean "([^"]+)" --agent (\w+)/g)) if (m[1].toLowerCase() === site.toLowerCase()) f.run(["clean", m[1], "--agent", m[2]]);
  expect(filesIn(site)).toEqual([]);
}, 300000);
