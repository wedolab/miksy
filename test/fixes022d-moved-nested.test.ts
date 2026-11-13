// Выпуск 0.2.2, круг 8d, E3 (рецензия B №1 проверки 8c) и B №2. setup --force после переноса основного корня:
// - внутри перенесённой папки был вложенный дополнительный корень — мастер не говорит «делать ничего не нужно», а называет
//   корень, его новое место и что сделать; шаги дословно → у его проектов прежние слои (miksy explain), doctor чист;
// - перенесли только содержимое, прежняя папка осталась пустой — как «нет на месте»: без рецепта «Вернуть его» (он снял
//   бы слои с перенесённых проектов), sync --all — прежние слои.
// Мастер в процессе — с поддельной системой (sys), как в test/rootshelp.ts
import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Ask } from "../src/ask";
import { setup } from "../src/setup";
import { runCommand } from "../src/commands";
import { newBackupRun } from "../src/backup";
import { cliFixture, put } from "./helpers";
import { git, read, yamlRoots } from "./rootshelp";

type F = ReturnType<typeof cliFixture>;
function inSetup(f: F, rules: [RegExp, (boolean | string | null)[]][]) {
  const saved = { ...process.env }, cwd = process.cwd(), logs: string[] = [];
  Object.assign(process.env, { MIKSY_CONFIG: f.config, HOME: f.home, USERPROFILE: f.home });
  process.chdir(f.dir);
  newBackupRun();
  const pick = (q: string) => { const r = rules.find(([re, a]) => re.test(q) && a.length); return r ? { hit: true, v: r[1].shift()! } : { hit: false, v: null }; };
  const ask: Ask = {
    yes: (q, def = false) => { const a = pick(q); return a.hit ? (a.v as boolean) : def; },
    line: (q) => { const a = pick(q); return a.hit ? (a.v as string | null) : null; },
    choose: (q, _o, def) => { const a = pick(q); return a.hit ? (a.v as string | null) : def ?? null; },
  };
  const sys = { which: () => null, exec: () => 0, git: () => 0, userPath: { get: () => "", set: () => {} }, refreshPath: () => {} };
  const orig = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  try {
    const run = (cmd: string, args: string[], io: { ask?: Ask | null }) => runCommand(cmd, args, { ask: io.ask ?? ask });
    return { code: setup({ ask, force: true, run, sys, log: (s = "") => logs.push(s) }), out: logs.join("\n") };
  } finally {
    console.log = orig; process.chdir(cwd); newBackupRun();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}
const rules = (file: string) => [...read(file).matchAll(/^# (\w+(?: \w+)?)$/gm)].map((m) => m[1]).join(",");
const layers = (f: F, p: string) => f.run(["explain", p]).out.match(/^Слои\s+(.*)$/m)?.[1] ?? "";

// Шаги из текста дословно: «Записать настройки агентам сейчас?» — «нет», path:, sync --global и --all. Агенты claude и
// codex, у сервера ветки в слое ${WORKSPACE} (рецензия B круга 8d, №5: запись мастером до правки пути давала конфликт codex)
for (const agents of [["claude"], ["claude", "codex"]])
  test(`E3: перенесли папку с вложенным корнем — шаги из текста мастера дословно (агенты: ${agents.join(", ")})`, () => {
    const f = cliFixture({ projects: [] });
    const ws = `${f.dir}/ws`, ws2 = `${f.dir}/disk2/ws`;
    git(`${ws}/Org/p1`);
    git(`${ws}/Inner/Acme/site`);
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([ws, { path: `${ws}/Inner`, tree: "Code" }])}agents: [${agents.join(", ")}]\n`);
    put(`${f.config}/layers/tree/Org/instructions/10.md`, "# org rule\n");
    put(`${f.config}/layers/tree/Code/instructions/30.md`, "# code rule\n");
    put(`${f.config}/layers/tree/Code/Acme/instructions/31.md`, "# acme rule\n");
    put(`${f.config}/layers/tree/Code/mcp/tool.yaml`, "name: tool\ncommand: echo\nargs: [\"${WORKSPACE}/x\"]\n");
    const write = false;
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    const before = { p1: rules(`${ws}/Org/p1/CLAUDE.local.md`), site: rules(`${ws}/Inner/Acme/site/CLAUDE.local.md`), layers: layers(f, `${ws}/Inner/Acme/site`) };
    mkdirSync(`${f.dir}/disk2`, { recursive: true });
    renameSync(ws, ws2);
    const s = inSetup(f, [[/Корень workspace/, [ws2]], [/Есть ещё папки/, [null]], [/Записать настройки агентам/, [write]]]);
    const line = s.out.split("\n").find((l) => l.includes("нет на месте"))!;
    // Текст: корень назван, его новое место, что сделать; не «делать ничего не нужно»
    expect(line).not.toContain("делать ничего не нужно");
    const m = line.match(/был ещё корень — (\S+) \(ветка Code; если папку перенесли сюда — теперь (\S+)\): .*Если папку перенесли в новую — на вопрос «Записать настройки агентам сейчас\?» в конце мастера ответьте «нет», после мастера поправьте path: этого корня в local\/machine\.yaml \(workspace\) на новое место, затем miksy sync --global и miksy sync --all/)!;
    expect(m).toBeTruthy();
    expect([m[1], m[2]]).toEqual([`${ws}/Inner`, `${ws2}/Inner`]);
    expect(line).toContain("--force из строки конфликта о его проектах не выполняйте");
    // Шаги дословно: path: в local/machine.yaml — на новое место, затем sync --all
    const file = `${f.config}/local/machine.yaml`;
    const text = readFileSync(file, "utf8");
    expect(text.split(m[1]).length).toBe(2);
    writeFileSync(file, text.replace(m[1], () => m[2]));
    expect(f.run(["sync", "--global"]).code).toBe(0);
    const a = f.run(["sync", "--all"]);
    const doc = f.run(["doctor"]);
    expect({
      code: a.code, conflicts: a.out.split("\n").filter((l) => /КОНФЛИКТ/.test(l)), doctor: doc.code,
      after: { p1: rules(`${ws2}/Org/p1/CLAUDE.local.md`), site: rules(`${ws2}/Inner/Acme/site/CLAUDE.local.md`), layers: layers(f, `${ws2}/Inner/Acme/site`) },
    }).toEqual({ code: 0, conflicts: [], doctor: 0, after: before });
  }, 240000);

test("B №2: перенесли содержимое, прежняя папка осталась пустой — как «нет на месте»: без «Вернуть его», слои прежние", () => {
  const f = cliFixture({ projects: [] });
  const ws = `${f.dir}/ws`, ws2 = `${f.dir}/disk2/ws`;
  git(`${ws}/Org/p1`);
  git(`${ws}/Lab/q`);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([ws])}agents: [claude]\n`);
  put(`${f.config}/map.yaml`, "global:\n  - { use: global }\nlayers:\n  - { match: \"Org/**\", use: orgx }\n");
  put(`${f.config}/layers/orgx/instructions/50.md`, "# orgx rule\n");
  put(`${f.config}/layers/tree/Org/instructions/10.md`, "# org rule\n");
  put(`${f.config}/layers/tree/Lab/instructions/11.md`, "# lab rule\n");
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  const before = [rules(`${ws}/Org/p1/CLAUDE.local.md`), rules(`${ws}/Lab/q/CLAUDE.local.md`)];
  mkdirSync(ws2, { recursive: true });
  for (const n of readdirSync(ws)) renameSync(`${ws}/${n}`, `${ws2}/${n}`);
  const s = inSetup(f, [[/Корень workspace/, [ws2]], [/Есть ещё папки/, [null]], [/Записать настройки агентам/, [false]]]);
  const a = f.run(["sync", "--all"]);
  expect({
    said: /в прежнем основном \S+ проектов нет: перенесли его содержимое или их там не было — делать ничего не нужно/.test(s.out),
    back: s.out.includes("Вернуть его"), leaves: s.out.includes("больше не обновляет"),
    code: a.code, after: [rules(`${ws2}/Org/p1/CLAUDE.local.md`), rules(`${ws2}/Lab/q/CLAUDE.local.md`)],
  }).toEqual({ said: true, back: false, leaves: false, code: 0, after: before });
}, 240000);

// B №4: прежний основной без ветки, у нового основного папка с тем же именем (Org) — перенос layers/tree/Org снял бы
// слои и с её проектов: рецепта «Вернуть его: 1) …» нет, названа папка. Без совпадений — рецепт, и в нём B №5: в новой
// копии файлы с путями — конфликт до sync --force
for (const clash of [true, false])
  test(`B №4, B №5: новый основной — другая папка${clash ? " с той же папкой Org" : " без общих папок"}`, () => {
    const f = cliFixture({ projects: [] });
    const ws = `${f.dir}/ws`, work = `${f.dir}/work`;
    git(`${ws}/Org/p1`);
    git(`${ws}/Lab/q`);
    git(`${work}/${clash ? "Org" : "Team"}/p2`);
    git(`${work}/Other/r`);
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([ws])}agents: [claude]\n`);
    put(`${f.config}/layers/tree/Org/instructions/10.md`, "# org rule\n");
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    const s = inSetup(f, [[/Корень workspace/, [work]], [/Есть ещё папки/, [null]], [/Записать настройки агентам/, [false]]]);
    const line = s.out.split("\n").find((l) => l.includes("из workspace уходит"))!;
    expect({
      recipe: line.includes("Вернуть его: 1) "),
      named: line.includes("у нового основного есть папка с тем же именем (Org), перенос layers/tree/<папка> снял бы слои и с её проектов"),
      copy: line.includes('в новой копии файлы miksy с путями (например, .codex/config.toml с ${WORKSPACE}) — конфликт, пока не выполните miksy sync "<путь проекта>" --force в её проектах (бэкап будет)'),
    }).toEqual(clash ? { recipe: false, named: true, copy: true } : { recipe: true, named: false, copy: true });
  }, 240000);
