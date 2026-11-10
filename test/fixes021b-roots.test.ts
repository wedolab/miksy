// Выпуск 0.2.1, круг 7b (проверка 7a, рецензия B №4, №6): target --remove через корень-ссылку в никуда; подсказка
// setup --force в порядке текста. Из тестов рецензента out/check021/miksy2/test/zz-check021b-roots.test.ts
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import type { Ask } from "../src/ask";
import { runCommand } from "../src/commands";
import { setup } from "../src/setup";
import { cliFixture, put } from "./helpers";
import { git, inProcess, ledger, read, rootsFixture, yamlRoots } from "./rootshelp";

// Мастер в этом процессе: ответы по шаблонам вопросов (по порядку для одного шаблона), остальное — по умолчанию
function inSetup(f: { config: string; home: string; dir: string }, force: boolean, rules: [RegExp, (boolean | string | null)[]][]) {
  const saved = { ...process.env }, cwd = process.cwd(), logs: string[] = [], questions: string[] = [];
  Object.assign(process.env, { MIKSY_CONFIG: f.config, HOME: f.home, USERPROFILE: f.home });
  process.chdir(f.dir);
  const pick = (q: string) => { questions.push(q); const r = rules.find(([re, a]) => re.test(q) && a.length); return r ? { hit: true, v: r[1].shift()! } : { hit: false, v: null }; };
  const ask: Ask = {
    yes: (q, def = false) => { const a = pick(q); return a.hit ? (a.v as boolean) : def; },
    line: (q) => { const a = pick(q); return a.hit ? (a.v as string | null) : null; },
    choose: (q, _o, def) => { const a = pick(q); return a.hit ? (a.v as string | null) : def ?? null; },
  };
  const sys = { which: () => null, exec: () => 0, git: () => 0, userPath: { get: () => "", set: () => {} }, refreshPath: () => {} };
  const log = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  try { const code = setup({ ask, force, run: undefined, sys, log: (s = "") => logs.push(s) }); return { code, out: logs.join("\n"), questions, err: "" }; }
  catch (e) { return { code: -1, out: logs.join("\n"), questions, err: (e as Error).message }; }
  finally {
    console.log = log;
    process.chdir(cwd);
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}


const gone = (f: { dir: string; config: string; ws: string }) => {
  const real = `${f.dir}/drive-real`, link = `${f.dir}/drive-link`;
  mkdirSync(`${real}/Acme/notes`, { recursive: true });
  symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: link, tree: "Clients" }])}agents: [claude]\n`);
  put(`${f.config}/layers/tree/Clients/Acme/notes/layer.yaml`, "target: true\n");
  put(`${f.config}/layers/tree/Clients/instructions/10.md`, "# clients\n");
  return { real, link };
};

test("B №4: корень-ссылка в никуда — target --remove по пути через ссылку (и --dry-run) снимает пометку", () => {
  const f = cliFixture({ projects: ["Org/p1"] });
  const { real, link } = gone(f);
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  renameSync(real, `${real}-gone`);
  const dry = inProcess(f, ["target", `${link}/Acme/notes`, "--remove", "--dry-run"]);
  expect(dry.err).toBe("");
  expect(dry.out).toContain("снять пометку цели");
  expect(read(`${f.config}/layers/tree/Clients/Acme/notes/layer.yaml`)).toContain("target: true");
  const r = inProcess(f, ["target", `${link}/Acme/notes`, "--remove"]);
  expect(r.err).toBe("");
  expect(read(`${f.config}/layers/tree/Clients/Acme/notes/layer.yaml`)).not.toContain("target: true");
}, 120000);

test("B №4: target <путь в недоступном корне-ссылке> --remove: пометка снята; подсказка clean, после возвращения диска записанное убрано", () => {
  const f = cliFixture({ projects: ["Org/p1"] });
  const { real, link } = gone(f);
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  expect(existsSync(`${real}/Acme/notes/CLAUDE.local.md`)).toBe(true);
  renameSync(real, `${real}-gone`);
  const r = inProcess(f, ["target", `${link}/Acme/notes`, "--remove"]);
  expect(r.err).toBe("");
  expect(read(`${f.config}/layers/tree/Clients/Acme/notes/layer.yaml`)).not.toContain("target: true");
  const next = r.out.match(/Дальше: miksy clean "([^"]+)"/);
  expect(next).not.toBeNull();
  expect(inProcess(f, ["clean", next![1]]).err).toBe("");
  renameSync(`${real}-gone`, real);
  f.run(["sync", "--all", "--yes"]);
  f.run(["clean", `${link}/Acme/notes`]);
  expect(existsSync(`${real}/Acme/notes/CLAUDE.local.md`)).toBe(false);
}, 180000);

test("B №6: setup --force — подсказка, выполненная в порядке текста (перенос слоёв, затем root add с «да» на sync --all), доводит до цели", () => {
  const f = cliFixture({ projects: ["Org/p1"] });
  const drive = `${f.dir}/drive`;
  git(`${drive}/Acme/site`);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive, tree: "Clients" }])}agents: [claude]\n`);
  put(`${f.config}/layers/tree/Org/instructions/10-org.md`, "# org rule\n");
  put(`${f.config}/layers/tree/Org/mcp/orgtool.yaml`, "name: orgtool\ncommand: echo\nargs: [o]\n");
  put(`${f.config}/layers/tree/Clients/instructions/20-clients.md`, "# clients rule\n");
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  const s = inSetup(f, true, [[/Корень workspace/, [drive]], [/Есть ещё папки/, [null]]]);
  expect(s.err).toBe("");
  const line = s.out.split("\n").find((l) => l.includes("Вернуть его"))!;
  expect(line).toContain("${WORKSPACE} в слоях теперь");
  const m = line.match(/Вернуть его: 1\) .*перенесите в layers\/tree\/([^/]+)\/<папка>\/…, а привязки map\.yaml .*?; 2\) miksy root add "([^"]+)" --tree (\S+) /)!;
  expect(m).not.toBeNull();
  // 1) перенос слоёв
  renameSync(`${f.config}/layers/tree/Org`, `${f.config}/layers/tree/${m[1]}-tmp`);
  mkdirSync(`${f.config}/layers/tree/${m[1]}`, { recursive: true });
  renameSync(`${f.config}/layers/tree/${m[1]}-tmp`, `${f.config}/layers/tree/${m[1]}/Org`);
  // 2) root add, в терминале — «да» на «Записать настройки … сейчас?»
  const add = inProcess(f, ["root", "add", m[2], "--tree", m[3]], f.dir, [true]);
  expect(add.err).toBe("");
  expect(read(`${f.ws}/Org/p1/CLAUDE.local.md`)).toContain("# org rule");
  expect(read(`${drive}/Acme/site/CLAUDE.local.md`)).toContain("# clients rule");
  const d = f.run(["doctor"]);
  expect(d.out).not.toContain("Устарело");
  expect(d.out).not.toContain("Правлено вручную");
}, 180000);
