// Выпуск 0.2.1, круг 7c — повторная проверка 3 (out/review021i/miksy/test/zzrev021i.test.ts), с ожиданием верного поведения
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

// Строки подсказки дословно; заглушки прежнего корня и ветки — настоящими. Коды всех команд
function follow(f: any, out: string, drive: string) {
  const codes: number[] = [];
  for (const l of out.split("\n").filter((x) => /^\s+miksy /.test(x)))
    for (const part of l.trim().split("; ")) {
      const m = part.match(/^miksy root add "<[^>]+>" --tree <[^>]+>$/);
      const args = m ? ["root", "add", drive, "--tree", "Clients"] : (part.match(/"[^"]+"|\S+/g) ?? []).slice(1).map((x: string) => x.replace(/^"|"$/g, ""));
      codes.push(f.run(args).code);
    }
  return codes;
}

function base(agents: string[]) {
  const f = cliFixture({ agents, projects: ["Org/p1"] });
  const drive = `${f.dir}/drive`, site = `${drive}/Acme/site`;
  git(site);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive, tree: "Clients" }])}agents: [${agents.join(", ")}]\n`);
  put(`${f.config}/layers/tree/Clients/instructions/10.md`, "# clients\n");
  put(`${f.config}/layers/tree/Clients/skills/s1/SKILL.md`, "---\nname: s1\ndescription: d\n---\nbody\n");
  put(`${f.config}/layers/tree/Clients/mcp/m1.yaml`, "name: m1\ncommand: echo\nargs: [hi]\n");
  const homeBefore = { claude: read(`${f.home}/.claude.json`), codex: read(`${f.home}/.codex/config.toml`) };
  const s0 = f.run(["sync", "--all", "--yes"]);
  if (s0.code) console.log("SYNC0 " + s0.out + s0.err);
  expect(s0.code).toBe(0);
  return { f, drive, site, homeBefore };
}

test("A: в workspace, отметка только у codex (claude после forget уже sync) → clean без --agent", () => {
  const { f, drive, site } = base(["claude", "codex"]);
  put(`${f.config}/local/machine.yaml`, read(`${f.config}/local/machine.yaml`).replace("agents: [claude, codex]", "agents: [claude]"));
  renameSync(drive, `${drive}-disk`);
  f.run(["clean", site, "--forget"]);
  renameSync(`${drive}-disk`, drive);
  console.log("A forgotten after forget: " + Object.keys((ledger(f.config) as any).forgotten ?? {}).join(", "));
  const s = f.run(["sync", site]);
  console.log("A sync code " + s.code);
  const c = f.run(["clean", site]);
  console.log("A clean out:\n" + c.out);
  console.log("A LEFT: " + filesIn(site).join(", "));
  console.log("A forgotten: " + Object.keys((ledger(f.config) as any).forgotten ?? {}).join(", "));
  expect(c.out).toMatch(/--agent codex/);
  expect(follow(f, c.out, drive).every((x) => x === 0 || x === 3)).toBe(true);
  expect(filesIn(site)).toEqual([]);
}, 240000);

test("B: вне workspace, подсказка дословно, включая каждый root add; дом после", () => {
  const { f, drive, site, homeBefore } = base(["claude", "codex", "opencode"]);
  put(`${f.config}/local/machine.yaml`, read(`${f.config}/local/machine.yaml`).replace("agents: [claude, codex, opencode]", "agents: [claude]"));
  renameSync(drive, `${drive}-disk`);
  const g = inProcess(f, ["root", "remove", drive, "--forget"], f.dir, null);
  renameSync(`${drive}-disk`, drive);
  const c = f.run(["clean", site]);
  console.log("B clean out:\n" + c.out);
  const codes = follow(f, c.out, drive);
  expect(codes.every((x) => x === 0 || x === 3)).toBe(true); // ни одной ошибки, в том числе «уже корень»
  console.log("B LEFT: " + filesIn(site).join(", "));
  console.log("B forgotten: " + Object.keys((ledger(f.config) as any).forgotten ?? {}).join(", "));
  console.log("B targets: " + Object.keys((ledger(f.config) as any).targets ?? {}).join(", "));
  const claudeAfter = read(`${f.home}/.claude.json`), codexAfter = read(`${f.home}/.codex/config.toml`);
  console.log("B home claude before/after:\n" + homeBefore.claude + "\n---\n" + claudeAfter);
  console.log("B home codex before/after:\n" + homeBefore.codex + "\n---\n" + codexAfter);
  console.log("B roots: " + read(`${f.config}/local/machine.yaml`));
  expect(filesIn(site)).toEqual([]);
}, 400000);

test("C: root remove без --forget (диск недоступен) → clean --forget вне workspace → текст про root add", () => {
  const { f, drive, site } = base(["claude", "codex"]);
  put(`${f.config}/local/machine.yaml`, read(`${f.config}/local/machine.yaml`).replace("agents: [claude, codex]", "agents: [claude]"));
  renameSync(drive, `${drive}-disk`);
  const rr = f.run(["root", "remove", drive]);
  console.log("C root remove:\n" + rr.out + rr.err);
  const cf = f.run(["clean", site, "--forget"]);
  console.log("C clean --forget:\n" + cf.out + cf.err);
  renameSync(`${drive}-disk`, drive);
  const c = f.run(["clean", site]);
  console.log("C clean:\n" + c.out);
  expect(cf.out).not.toContain("папку, в которой лежит этот проект");
}, 240000);

test("D: как C, затем совет clean --forget для codex дословно (clean --agent codex) → что осталось", () => {
  const { f, drive, site } = base(["claude", "codex"]);
  put(`${f.config}/local/machine.yaml`, read(`${f.config}/local/machine.yaml`).replace("agents: [claude, codex]", "agents: [claude]"));
  renameSync(drive, `${drive}-disk`);
  f.run(["root", "remove", drive]);
  f.run(["clean", site, "--forget"]);
  renameSync(`${drive}-disk`, drive);
  const c = f.run(["clean", site, "--agent", "codex"]);
  console.log("D clean --agent codex:\n" + c.out);
  console.log("D LEFT: " + filesIn(site).join(", "));
  // Подсказка этого clean (вернуть корень, sync, clean --agent codex) — дословно
  expect(c.out).toContain("Проект был забыт");
  expect(follow(f, c.out, drive).every((x) => x === 0 || x === 3)).toBe(true);
  expect(filesIn(site).filter((p) => p.startsWith(".agents") || p.startsWith(".codex"))).toEqual([]);
}, 240000);
