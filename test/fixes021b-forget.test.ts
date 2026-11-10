// Выпуск 0.2.1, круг 7b (проверка 7a, рецензия B №5): clean недоступной папки без --forget, когда агента убрали из agents
// без clean, — обещание совпадает с тем, что сделает повторный clean; агенту вне agents — clean --agent. Из теста
// рецензента out/check021/miksy2/test/zz-check021b-forget.test.ts с верными ожиданиями
import { expect, test } from "bun:test";
import { existsSync, readdirSync, renameSync, statSync } from "node:fs";
import { cliFixture, put } from "./helpers";
import { git, inProcess, read, yamlRoots } from "./rootshelp";

const ALL = ["claude", "codex", "opencode", "antigravity"];
// Файлы проекта, кроме .git
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

function fixture(agents = ALL) {
  const f = cliFixture({ agents, projects: ["Org/p1"] });
  const drive = `${f.dir}/drive`;
  git(`${drive}/Acme/site`);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive, tree: "Clients" }])}agents: [${agents.join(", ")}]\n`);
  put(`${f.config}/layers/tree/Clients/instructions/10.md`, "# clients\n");
  put(`${f.config}/layers/tree/Clients/skills/miksy-sk/SKILL.md`, "---\nname: miksy-sk\ndescription: d\n---\nbody\n");
  put(`${f.config}/layers/tree/Clients/mcp/tool.yaml`, "name: tool\ncommand: echo\nargs: [x]\n");
  return { ...f, drive, site: `${drive}/Acme/site` };
}


test("B №5: агент убран из agents: clean недоступной папки без --forget — в числе только агенты из agents, остальным — clean --agent; повторы доводят до пустой папки", () => {
  const f = fixture(["claude", "codex"]);
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  const codexFiles = filesIn(f.site).filter((p) => p.startsWith(".codex") || p.startsWith(".agents"));
  expect(codexFiles.length).toBeGreaterThan(0);
  put(`${f.config}/local/machine.yaml`, read(`${f.config}/local/machine.yaml`).replace("agents: [claude, codex]", "agents: [claude]"));
  renameSync(f.drive, `${f.drive}-disk`);
  const dry = f.run(["clean", f.site, "--dry-run"]);
  const c = inProcess(f, ["clean", f.site]);
  expect(c.err).toBe("");
  for (const out of [dry.out, c.out]) {
    expect(out).toMatch(/записанное miksy — \d+ файл\S* в .*: подключите диск и повторите miksy clean "[^"]+"; \d+ файл\S* агента codex \(его нет в agents\): когда диск вернётся — miksy clean "[^"]+" --agent codex; данных больше нет/);
  }
  const promised = Number(c.out.match(/записанное miksy — (\d+) файл/)![1]);
  renameSync(`${f.drive}-disk`, f.drive);
  const before = filesIn(f.site);
  const again = f.run(["clean", f.site]);
  expect(again.code).toBe(0);
  const left = filesIn(f.site);
  // Повторный clean убрал обещанное (claude), файлы codex — на месте
  expect(left.sort()).toEqual(codexFiles.sort());
  expect(before.length - left.length).toBeLessThanOrEqual(promised);
  const cmd = c.out.match(/miksy clean "([^"]+)" --agent codex/)!;
  const byAgent = f.run(["clean", cmd[1], "--agent", "codex"]);
  expect(byAgent.code).toBe(0);
  expect(filesIn(f.site)).toEqual([]);
}, 180000);

test("B №5: только агент вне agents записал в недоступную папку — текст без «повторите clean», с clean --agent; --forget забывает и его учёт", () => {
  const f = fixture(["claude", "codex"]);
  expect(f.run(["sync", "--all", "--yes", "--agent", "codex"]).code).toBe(0);
  put(`${f.config}/local/machine.yaml`, read(`${f.config}/local/machine.yaml`).replace("agents: [claude, codex]", "agents: [claude]"));
  renameSync(f.drive, `${f.drive}-disk`);
  const c = f.run(["clean", f.site]);
  expect(c.out).not.toContain("повторите miksy clean");
  expect(c.out).toMatch(/файл\S* агента codex \(его нет в agents, папка .*site\): когда диск вернётся — miksy clean "[^"]+" --agent codex/);
  const g = f.run(["clean", f.site, "--forget"]);
  expect(g.out).toContain("=== codex (нет в agents — забывается и его учёт)");
}, 180000);
