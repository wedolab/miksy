// Выпуск 0.2.2, A3: подсказки после «забыть» и setup --force выполняются дословно в песочнице.
// а — где копия local/machine.yaml до root remove (путь с <запуск>, «если ещё хранится»);
// б — папка вне workspace после setup --force (прежний основной корень без ветки);
// в — смешанный clean --all: заголовок верен для каждой папки;
// г, д — подсказка setup --force: ветка без знаков шаблона, общее правило для match: map.yaml;
// е — clean пропавшей забытой папки вне workspace: сообщение и команда, которая убирает отметку
import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import type { Ask } from "../src/ask";
import { setup } from "../src/setup";
import { cliFixture, put } from "./helpers";
import { git, inProcess, ledger, read, yamlRoots } from "./rootshelp";

type F = ReturnType<typeof cliFixture>;
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
const forgotten = (f: F) => Object.keys((ledger(f.config) as { forgotten?: object }).forgotten ?? {});
// Строки команд подсказки (sync/clean) — дословно
function runLines(f: F, lines: string[]) {
  for (const l of lines) for (const m of l.matchAll(/miksy (sync|clean) "([^"]+)"( --agent \w+)?/g))
    expect([0, 3]).toContain(f.run([m[1], m[2], ...(m[3] ? m[3].trim().split(" ") : [])]).code);
}

// setup в этом процессе: ответы по шаблонам вопросов; без команд miksy (run) и без изменений системы
function inSetup(f: F, force: boolean, rules: [RegExp, (boolean | string | null)[]][]) {
  const saved = { ...process.env }, cwd = process.cwd(), logs: string[] = [];
  Object.assign(process.env, { MIKSY_CONFIG: f.config, HOME: f.home, USERPROFILE: f.home });
  process.chdir(f.dir);
  const pick = (q: string) => { const r = rules.find(([re, a]) => re.test(q) && a.length); return r ? { hit: true, v: r[1].shift()! } : { hit: false, v: null }; };
  const ask: Ask = {
    yes: (q, def = false) => { const a = pick(q); return a.hit ? (a.v as boolean) : def; },
    line: (q) => { const a = pick(q); return a.hit ? (a.v as string | null) : null; },
    choose: (q, _o, def) => { const a = pick(q); return a.hit ? (a.v as string | null) : def ?? null; },
  };
  const sys = { which: () => null, exec: () => 0, git: () => 0, userPath: { get: () => "", set: () => {} }, refreshPath: () => {} };
  const log = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  try { return { code: setup({ ask, force, run: undefined, sys, log: (s = "") => logs.push(s) }), out: logs.join("\n") }; }
  finally {
    console.log = log;
    process.chdir(cwd);
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

// Подсказка setup --force «Вернуть его: 1) … 2) miksy root add …» — дословно: слои под ветку, match: по общему правилу, root add
function followSetupHint(f: F, out: string, folders: string[]) {
  const line = out.split("\n").find((l) => l.includes("Вернуть его"))!;
  expect(line).toBeTruthy();
  const branch = line.match(/перенесите в layers\/tree\/(.+?)\/<папка>\/…/)![1];
  expect(line).toContain(`<папка>/** → ${branch}/<папка>/**`);
  // Запятая или } в ветке внутри {…} сломали бы шаблон — тогда подсказка велит отдельную привязку к каждой папке (круг 8b, C5)
  const split = /[,}]/.test(branch);
  expect(line).toContain(split ? `({Org,Lab}/** → ${branch}/Org/** и ${branch}/Lab/**` : `({Org,Lab}/** → {${branch}/Org,${branch}/Lab}/**)`);
  expect(line).toContain("шаблоны, которые начинаются с **, не меняйте");
  // Путь — в двойных кавычках или, с $ ` ! " в имени, в одинарных (выпуск 0.2.3, A2)
  const m = line.match(/2\) miksy root add (?:"([^"]+)"|'((?:[^']|'')+)') --tree ("[^"]*"|'(?:[^']|'')*'|\S+) /)!;
  const unq = (s: string) => (s.startsWith("'") ? s.slice(1, -1).replaceAll("''", "'") : s);
  const add = [m[0], m[1] ?? unq(`'${m[2]}'`), m[3].startsWith("'") ? `"${unq(m[3])}"` : m[3]];
  for (const d of folders) if (existsSync(`${f.config}/layers/tree/${d}`)) {
    mkdirSync(`${f.config}/layers/tree/${branch}`, { recursive: true });
    renameSync(`${f.config}/layers/tree/${d}`, `${f.config}/layers/tree/${branch}/${d}`);
  }
  // Правило подсказки: <папка>/** → <ветка>/<папка>/**; в {…} — ветка к каждой папке (или отдельная привязка к каждой);
  // ** в начале — без изменений
  const map = readFileSync(`${f.config}/map.yaml`, "utf8")
    .replace(/match: "([^"*{][^"]*)"/g, (_, m: string) => `match: ${JSON.stringify(`${branch}/${m}`)}`)
    .replace(/^(\s*- \{ )match: "\{([^}]*)\}([^"]*)"(.*)$/gm, (_, pre: string, alts: string, rest: string, post: string) => split
      ? alts.split(",").map((a) => `${pre}match: ${JSON.stringify(`${branch}/${a}${rest}`)}${post}`).join("\n")
      : `${pre}match: ${JSON.stringify(`{${alts.split(",").map((a) => `${branch}/${a}`).join(",")}}${rest}`)}${post}`);
  writeFileSync(`${f.config}/map.yaml`, map);
  const r = inProcess(f, ["root", "add", add[1], "--tree", add[2].replace(/^"|"$/g, "")], f.dir, [true]);
  expect(r.err).toBe("");
  return branch;
}

// Прежний основной корень <name> (Org/p1, Lab/p2) и дополнительный drive (Clients); привязки map.yaml трёх видов
function forceScenario(name: string) {
  const f = cliFixture({ projects: [] });
  const ws = `${f.dir}/${name}`, drive = `${f.dir}/drive`;
  git(`${ws}/Org/p1`);
  git(`${ws}/Lab/p2`);
  git(`${drive}/Acme/site`);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([ws, { path: drive, tree: "Clients" }])}agents: [claude]\n`);
  put(`${f.config}/map.yaml`, "global:\n  - { use: global }\nlayers:\n  - { match: \"Org/**\", use: orgx }\n  - { match: \"{Org,Lab}/**\", use: both }\n  - { match: \"**/p1\", use: deep }\n");
  for (const l of ["orgx", "both", "deep"]) put(`${f.config}/layers/${l}/instructions/50-${l}.md`, `# ${l} rule\n`);
  put(`${f.config}/layers/tree/Org/instructions/10-org.md`, "# org rule\n");
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  return { f, ws, drive };
}
const rules = (p: string) => ["main", "org", "orgx", "both", "deep"].filter((r) => read(p).includes(`# ${r} rule`));

for (const name of ["ws", "Work [old]", "Work {a}", "Work, old", "Acme, Inc}", "Projects!", "!Projects"])
  test(`г, д: setup --force, прежний основной «${name}» — подсказка дословно возвращает привязки map.yaml`, () => {
    const { f, ws, drive } = forceScenario(name);
    expect(rules(`${ws}/Org/p1/CLAUDE.local.md`)).toEqual(["org", "orgx", "both", "deep"]);
    const s = inSetup(f, true, [[/Корень workspace/, [drive]], [/Есть ещё папки/, [null]]]);
    expect(s.code).toBe(0);
    const branch = followSetupHint(f, s.out, ["Org", "Lab"]);
    // Ветка — без знаков, ломающих match (круг 8b, C5); запятая, } и «!» не в начале — как в 0.2.1
    expect(branch).not.toMatch(/[*?[{\\]|^!/);
    if (!/[[{]|^!/.test(name)) expect(branch).toBe(name);
    expect(rules(`${ws}/Org/p1/CLAUDE.local.md`)).toEqual(["org", "orgx", "both", "deep"]);
    expect(rules(`${ws}/Lab/p2/CLAUDE.local.md`)).toEqual(["both"]);
  }, 180000);

// Дополнительный корень drive (Clients) с проектом site; агенты claude и codex, codex убран из agents; диск отключён,
// root remove --forget
function removedScenario() {
  const f = cliFixture({ agents: ["claude", "codex"], projects: ["Org/p1"] });
  const drive = `${f.dir}/drive`, site = `${drive}/Acme/site`;
  git(site);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive, tree: "Clients" }])}agents: [claude, codex]\n`);
  put(`${f.config}/layers/tree/Clients/instructions/10.md`, "# clients\n");
  put(`${f.config}/layers/tree/Clients/skills/s1/SKILL.md`, "---\nname: s1\ndescription: d\n---\nbody\n");
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  put(`${f.config}/local/machine.yaml`, read(`${f.config}/local/machine.yaml`).replace("agents: [claude, codex]", "agents: [claude]"));
  renameSync(drive, `${drive}-disk`);
  expect(inProcess(f, ["root", "remove", drive, "--forget"], f.dir, null).err).toBe("");
  return { f, site, drive };
}

test("а: копия local/machine.yaml до root remove — путь из подсказки находит её; корень и ветка оттуда — дословно; в папке ничего", () => {
  const { f, site, drive } = removedScenario();
  renameSync(`${drive}-disk`, drive);
  const c = f.run(["clean", site]);
  expect(c.out).toContain("если копия ещё хранится");
  const copy = c.out.match(/: (\S+\/local\/backups\/<запуск>\/\S+\/local\/machine\.yaml);/)![1];
  const runs = readdirSync(`${f.config}/local/backups`).map((r) => copy.replace("<запуск>", r)).filter((p) => existsSync(p));
  expect(runs.length).toBeGreaterThan(0);
  const before = read(runs[0]);
  const root = before.match(/path: "([^"]+)", tree: "([^"]+)"/)!;
  expect([root[1], root[2]]).toEqual([drive, "Clients"]);
  const lines = c.out.split("\n").filter((l) => /^\s+miksy (root add|sync)/.test(l));
  expect(lines[0]).toContain("miksy root add");
  expect(f.run(["root", "add", root[1], "--tree", root[2]]).code).toBe(0);
  runLines(f, lines.slice(1));
  expect(filesIn(site)).toEqual([]);
  expect(forgotten(f)).toEqual([]);
}, 240000);

test("б: папка вне workspace после setup --force — подсказка называет и этот случай; по ней — в папке ничего", () => {
  const { f, ws, drive } = forceScenario("ws");
  const p1 = `${ws}/Org/p1`;
  // Забыть p1, пока корень недоступен; затем основной — drive (setup --force), прежний основной уходит из workspace
  renameSync(ws, `${ws}-x`);
  expect(f.run(["clean", p1, "--forget"]).code).toBe(0);
  renameSync(`${ws}-x`, ws);
  const s = inSetup(f, true, [[/Корень workspace/, [drive]], [/Есть ещё папки/, [null]]]);
  expect(s.code).toBe(0);
  const c = f.run(["clean", p1]);
  expect(c.out).toContain("основной сменил miksy setup --force: путь — прежний основной (его называл тот setup");
  followSetupHint(f, s.out, ["Org", "Lab"]);
  runLines(f, c.out.split("\n").filter((l) => /^\s+miksy sync/.test(l)));
  expect(filesIn(p1)).toEqual([]);
  expect(forgotten(f)).toEqual([]);
}, 240000);

test("в: clean --all, у одной папки отметка у агента из agents, у другой — только у агента вне agents: заголовок у каждой свой", () => {
  const f = cliFixture({ agents: ["claude", "codex"], projects: ["Org/a", "Org/b"] });
  const a = `${f.ws}/Org/a`, b = `${f.ws}/Org/b`;
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  put(`${f.config}/local/machine.yaml`, read(`${f.config}/local/machine.yaml`).replace("agents: [claude, codex]", "agents: [claude]"));
  // Корень недоступен — обе папки забыть
  renameSync(f.ws, `${f.ws}-x`);
  for (const d of [a, b]) expect(f.run(["clean", d, "--forget"]).code).toBe(0);
  renameSync(`${f.ws}-x`, f.ws);
  // b: отметку claude снимает sync; остаётся только у codex (его нет в agents)
  expect(f.run(["sync", b]).code).toBe(0);
  for (const dry of [true, false]) {
    const out = f.run(["clean", "--all", ...(dry ? ["--dry-run"] : [])]).out;
    const head = out.indexOf(dry ? "План: проект забыт" : "Проект был забыт");
    const second = out.indexOf(dry ? "В этих папках останутся файлы агентов, которых нет в agents" : "В этих папках остались файлы агентов, которых нет в agents");
    expect(head).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(head);
    const first = out.slice(head, second), rest = out.slice(second);
    expect(first).toContain(`miksy sync "${a}"; miksy clean "${a}"`);
    expect(first).not.toContain(`"${b}"`);
    expect(rest).toContain(`miksy sync "${b}" --agent codex; miksy clean "${b}" --agent codex`);
    expect(rest).not.toContain(`"${a}"`);
    if (!dry) runLines(f, out.split("\n").filter((l) => /^\s+miksy sync/.test(l)));
  }
  expect(filesIn(a)).toEqual([]);
  expect(filesIn(b)).toEqual([]);
  expect(forgotten(f)).toEqual([]);
}, 240000);

test("е: clean пропавшей забытой папки вне workspace — сообщение и команда; она дословно убирает отметку; --dry-run не пишет", () => {
  const { f, site } = removedScenario();
  expect(forgotten(f).length).toBeGreaterThan(0);
  const c = f.run(["clean", site]);
  expect(c.code).toBe(0);
  expect(c.out).toContain(`Папки ${site} нет (она вне workspace)`);
  expect(c.out).toContain("осталась только отметка «проект забыт» (claude, codex)");
  const cmd = c.out.match(/убрать отметку: miksy clean "([^"]+)" --forget/)!;
  expect(cmd[1]).toBe(site);
  const ledgerBefore = read(`${f.config}/local/state/manifest.json`);
  const dry = f.run(["clean", cmd[1], "--forget", "--dry-run"]);
  expect(dry.out).toContain(`План: отметка «проект забыт» папки ${site} (claude, codex) будет убрана из учёта.`);
  expect(read(`${f.config}/local/state/manifest.json`)).toBe(ledgerBefore);
  const done = f.run(["clean", cmd[1], "--forget"]);
  expect({ code: done.code, err: done.err }).toEqual({ code: 0, err: "" });
  expect(done.out).toContain(`Отметка «проект забыт» папки ${site} (claude, codex) убрана из учёта.`);
  expect(forgotten(f)).toEqual([]);
  // Повторно — сообщения нет: учёт о папке ничего не помнит (clean — ошибка «нет в учёте» или «изменений нет»)
  expect(f.run(["clean", site]).out).not.toContain("осталась только отметка");
}, 240000);

// Круг 8b, C6 (рецензия B №4 проверки 8a): основным setup --force выбран новый каталог, не из дополнительных. «Вернуть
// его» печатается и тут; выполненный дословно, он возвращает проектам прежнего основного те же слои; подсказка clean
// забытой папки вне workspace ссылается на него — по ней в папке ничего не остаётся
for (const name of ["ws", "Work, old"])
  test(`C6: setup --force, основной — новый каталог; прежний основной «${name}» — «Вернуть его» дословно возвращает слои`, () => {
    const { f, ws } = forceScenario(name);
    const fresh = `${f.dir}/New`;
    mkdirSync(fresh, { recursive: true });
    const s = inSetup(f, true, [[/Корень workspace/, [fresh]], [/Есть ещё папки/, [null]]]);
    expect(s.code).toBe(0);
    expect(s.out).toContain(`прежний основной ${ws} из workspace уходит`);
    followSetupHint(f, s.out, ["Org", "Lab"]);
    expect(rules(`${ws}/Org/p1/CLAUDE.local.md`)).toEqual(["org", "orgx", "both", "deep"]);
    expect(rules(`${ws}/Lab/p2/CLAUDE.local.md`)).toEqual(["both"]);
  }, 180000);

test("C6: забытая папка, основной сменил setup --force на новый каталог — подсказка clean верна; по ней в папке ничего", () => {
  const { f, ws } = forceScenario("ws");
  const p1 = `${ws}/Org/p1`;
  renameSync(ws, `${ws}-x`);
  expect(f.run(["clean", p1, "--forget"]).code).toBe(0);
  renameSync(`${ws}-x`, ws);
  const fresh = `${f.dir}/New`;
  mkdirSync(fresh, { recursive: true });
  const s = inSetup(f, true, [[/Корень workspace/, [fresh]], [/Есть ещё папки/, [null]]]);
  expect(s.code).toBe(0);
  const c = f.run(["clean", p1]);
  expect(c.out).toContain("ветка — любая новая, которой нет в layers/tree. Слои его проектов под неё скопируйте, а не переносите");
  expect(s.out).toContain("Вернуть его: 1) ");
  followSetupHint(f, s.out, ["Org", "Lab"]);
  runLines(f, c.out.split("\n").filter((l) => /^\s+miksy sync/.test(l)));
  expect(filesIn(p1)).toEqual([]);
  expect(forgotten(f)).toEqual([]);
}, 240000);

// Круг 8b, C7 (рецензия B №5 проверки 8a): root remove без «забыть» (строки «Бэкапы этого запуска» нет), затем clean
// --forget; диск вернулся — подсказка clean верна и в этом случае: команда поиска (на Windows — с пометкой «PowerShell»)
// дословно находит копии machine.yaml, в последней, где корень ещё записан, — его путь и ветка
test("C7: root remove без «забыть» — команда поиска копий machine.yaml из подсказки дословно находит копию с корнем", () => {
  const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
  const drive = `${f.dir}/drive`, site = `${drive}/Acme/site`;
  git(site);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive, tree: "Clients" }])}agents: [claude]\n`);
  put(`${f.config}/layers/tree/Clients/instructions/10.md`, "# clients\n");
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  renameSync(drive, `${drive}-disk`);
  const rr = inProcess(f, ["root", "remove", drive], f.dir, null);
  expect(rr.err).toBe("");
  expect(rr.out).not.toContain("Бэкапы этого запуска");
  expect(f.run(["clean", site, "--forget"]).code).toBe(0);
  renameSync(`${drive}-disk`, drive);
  const c = f.run(["clean", site]);
  const win = process.platform === "win32";
  expect(c.out).not.toContain("он печатал его строкой");
  const cmd = c.out.match(win ? /\(PowerShell\) (Get-ChildItem -LiteralPath '(?:[^']|'')+' -Recurse -Filter machine\.yaml)/ : /(find '(?:[^']|'\\'')+' -name machine\.yaml)/)![1];
  const r = win
    ? Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", `(${cmd}).FullName`], { stdout: "pipe" })
    : Bun.spawnSync(["sh", "-c", cmd], { stdout: "pipe" });
  const found = r.stdout.toString().split(/\r?\n/).filter(Boolean).sort();
  expect(found.length).toBeGreaterThan(0);
  const last = found.filter((p) => read(p).includes(drive)).pop()!;
  expect(read(last).match(/path: "([^"]+)", tree: "([^"]+)"/)!.slice(1)).toEqual([drive, "Clients"]);
}, 240000);

// Рецензия A круга 8b, п. 2: у прежнего основного была ветка (Main) — новый каталог берёт её, «Вернуть его» печатается:
// слои прежнего — из layers/tree/Main/<папка> под новую ветку, привязки «Main/…» — под неё же; дословно — слои те же
test("C6: прежний основной с веткой, основной — новый каталог: «Вернуть его» дословно возвращает слои", () => {
  const f = cliFixture({ projects: [] });
  const ws = `${f.dir}/ws`, drive = `${f.dir}/drive`;
  git(`${ws}/Org/p1`);
  git(`${ws}/Lab/p2`);
  git(`${drive}/Acme/site`);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([{ path: ws, tree: "Main" }, { path: drive, tree: "Clients" }])}agents: [claude]\n`);
  put(`${f.config}/map.yaml`, "global:\n  - { use: global }\nlayers:\n  - { match: \"Main/Org/**\", use: orgx }\n  - { match: \"{Main/Org,Main/Lab}/**\", use: both }\n  - { match: \"**/p1\", use: deep }\n");
  for (const l of ["orgx", "both", "deep"]) put(`${f.config}/layers/${l}/instructions/50-${l}.md`, `# ${l} rule\n`);
  put(`${f.config}/layers/tree/Main/Org/instructions/10-org.md`, "# org rule\n");
  // Слой самой ветки (повторная проверка круга 8b, п. 1) — должен вернуться прежнему основному, а не остаться у нового
  put(`${f.config}/layers/tree/Main/instructions/05-main.md`, "# main rule\n");
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  expect(rules(`${ws}/Org/p1/CLAUDE.local.md`)).toEqual(["main", "org", "orgx", "both", "deep"]);
  const fresh = `${f.dir}/New`;
  git(`${fresh}/Acme/n1`);
  const s = inSetup(f, true, [[/Корень workspace/, [fresh]], [/Есть ещё папки/, [null]]]);
  expect(s.code).toBe(0);
  const line = s.out.split("\n").find((l) => l.includes("Вернуть его"))!;
  expect(line).toContain(`прежний основной ${ws} из workspace уходит`);
  const branch = line.match(/папку layers\/tree\/Main целиком \(с её собственными instructions, mcp, skills\) переименуйте в layers\/tree\/(.+?), а в привязках map\.yaml \(match:\) замените начало Main\/ на /)![1];
  expect(line).toContain(`(Main/** → ${branch}/**, шаблон Main → ${branch})`);
  expect(line).toContain(`({Main/Org,Main/Lab}/** → {${branch}/Org,${branch}/Lab}/**)`);
  // Дословно: ветку целиком — под новое имя, привязки «Main/…» — под него, root add
  renameSync(`${f.config}/layers/tree/Main`, `${f.config}/layers/tree/${branch}`);
  writeFileSync(`${f.config}/map.yaml`, readFileSync(`${f.config}/map.yaml`, "utf8").replaceAll("Main/", `${branch}/`));
  // Путь — в двойных кавычках или, с $ ` ! " в имени, в одинарных (выпуск 0.2.3, A2)
  const m = line.match(/2\) miksy root add (?:"([^"]+)"|'((?:[^']|'')+)') --tree ("[^"]*"|'(?:[^']|'')*'|\S+) /)!;
  const unq = (s: string) => (s.startsWith("'") ? s.slice(1, -1).replaceAll("''", "'") : s);
  const add = [m[0], m[1] ?? unq(`'${m[2]}'`), m[3].startsWith("'") ? `"${unq(m[3])}"` : m[3]];
  expect(inProcess(f, ["root", "add", add[1], "--tree", add[2].replace(/^"|"$/g, "")], f.dir, [true]).err).toBe("");
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  expect(rules(`${ws}/Org/p1/CLAUDE.local.md`)).toEqual(["main", "org", "orgx", "both", "deep"]);
  expect(rules(`${ws}/Lab/p2/CLAUDE.local.md`)).toEqual(["main", "both"]);
  expect(rules(`${fresh}/Acme/n1/CLAUDE.local.md`)).toEqual([]);
}, 240000);

// Повторная проверка круга 8b, п. 2: основным стал бывший дополнительный корень, внутри которого лежит прежний основной —
// проекты прежнего остаются в workspace, «Вернуть его» нет
test("C6: прежний основной внутри бывшего дополнительного, ставшего основным — «уходит» не печатается", () => {
  const f = cliFixture({ projects: [] });
  const drive = `${f.dir}/drive`, ws = `${drive}/ws`;
  git(`${ws}/Org/p1`);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([ws, { path: drive, tree: "Clients" }])}agents: [claude]\n`);
  const s = inSetup(f, true, [[/Корень workspace/, [drive]], [/Есть ещё папки/, [null]]]);
  expect(s.code).toBe(0);
  expect(s.out).not.toContain("Вернуть его");
  expect(s.out).not.toContain("из workspace уходит");
  expect(s.out).toContain(`прежний основной ${ws} лежит внутри нового: его проекты остаются в workspace, слои — по их пути от ${drive} (layers/tree/Clients/<путь от него>/…)`);
}, 240000);

// Рецензия A круга 8b, п. 3: новый основной — папка внутри прежнего (ws/Org): её проекты остаются в workspace (слои — по
// пути от неё), уходят остальные — подсказка говорит так и возвращает слои им; прежний внутри нового — «Вернуть» не нужно
test("C6: новый основной внутри прежнего — текст по правде, подсказка возвращает слои проектам вне него", () => {
  const { f, ws } = forceScenario("ws");
  const s = inSetup(f, true, [[/Корень workspace/, [`${ws}/Org`]], [/Есть ещё папки/, [null]]]);
  expect(s.code).toBe(0);
  const line = s.out.split("\n").find((l) => l.includes("Вернуть его"))!;
  expect(line).toContain(`прежний основной ${ws} из workspace уходит (кроме проектов внутри нового основного: они остаются в workspace, слои — по их пути от ${ws}/Org`);
  expect(line).toContain("остальные его проекты miksy больше не обновляет");
  followSetupHint(f, s.out, ["Org", "Lab"]);
  expect(rules(`${ws}/Lab/p2/CLAUDE.local.md`)).toEqual(["both"]);
}, 240000);

test("C6: прежний основной внутри нового — «Вернуть его» нет, проекты остаются в workspace", () => {
  const { f, ws } = forceScenario("top/ws");
  const s = inSetup(f, true, [[/Корень workspace/, [`${f.dir}/top`]], [/Есть ещё папки/, [null]]]);
  expect(s.code).toBe(0);
  expect(s.out).not.toContain("Вернуть его");
  expect(s.out).toContain(`прежний основной ${ws} лежит внутри нового: его проекты остаются в workspace`);
}, 240000);

// Повторная проверка 2 круга 8b, п. 1–3 (решение основного агента: ветку прежнего основного забирает новый каталог).
// Ветка из нескольких частей или внутри неё ветка другого корня — без рецепта переименования: только правда и README.
// Прежний основной внутри оставшегося дополнительного корня — его проекты остаются, «уходит» не печатается
for (const [label, roots] of [
  ["ветка из двух частей", (ws: string) => [{ path: ws, tree: "Clients/Home" }]],
  ["внутри ветки — ветка другого корня", (ws: string, drive: string) => [{ path: ws, tree: "Main" }, { path: drive, tree: "Main/Drive" }]],
] as const)
  test(`C6: ${label} — ветка перешла к новому основному, без рецепта переименования`, () => {
    const f = cliFixture({ projects: [] });
    const ws = `${f.dir}/ws`, drive = `${f.dir}/drive`;
    git(`${ws}/Org/p1`);
    git(`${drive}/Acme/site`);
    put(`${f.config}/local/machine.yaml`, `${yamlRoots(roots(ws, drive))}agents: [claude]\n`);
    const fresh = `${f.dir}/New`;
    mkdirSync(fresh, { recursive: true });
    const s = inSetup(f, true, [[/Корень workspace/, [fresh]], [/Есть ещё папки/, [null]]]);
    expect(s.code).toBe(0);
    const tree = roots(ws, drive)[0].tree;
    const line = s.out.split("\n").find((l) => l.includes("перешла к новому основному"))!;
    expect(line).toContain(`ветка layers/tree/${tree} перешла к новому основному ${fresh}; прежний основной ${ws} из workspace уходит: его проекты miksy больше не обновляет. Вернуть его — README, «Несколько корней workspace»`);
    expect(line).not.toMatch(/переименуйте|miksy root add/);
  }, 240000);

for (const how of ["новый каталог", "другой дополнительный"])
  test(`C6: прежний основной внутри оставшегося дополнительного корня, основной — ${how}: «уходит» не печатается`, () => {
    const f = cliFixture({ projects: [] });
    const drive = `${f.dir}/drive`, ws = `${drive}/ws`, other = `${f.dir}/other`;
    git(`${ws}/Org/p1`);
    git(`${other}/x/q`);
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([ws, { path: drive, tree: "Clients" }, { path: other, tree: "Other" }])}agents: [claude]\n`);
    const fresh = `${f.dir}/New`;
    mkdirSync(fresh, { recursive: true });
    const s = inSetup(f, true, [[/Корень workspace/, [how === "новый каталог" ? fresh : other]], [/Есть ещё папки/, [null]]]);
    expect(s.code).toBe(0);
    expect(s.out).not.toContain("из workspace уходит");
    expect(s.out).toContain(`прежний основной ${ws} лежит внутри корня ${drive}: его проекты остаются в workspace, слои — по их пути от ${drive} (layers/tree/Clients/<путь от него>/…)`);
  }, 240000);

// Повторная проверка 3 круга 8b, п. 2: новый основной — папка внутри прежнего, у прежнего ветка из одной части: ветку
// занял новый основной — без рецепта переименования (он снял бы слои с его проектов)
test("C6: новый основной внутри прежнего с веткой — без рецепта переименования", () => {
  const f = cliFixture({ projects: [] });
  const ws = `${f.dir}/ws`;
  git(`${ws}/Org/p1`);
  git(`${ws}/Lab/p2`);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([{ path: ws, tree: "Main" }])}agents: [claude]\n`);
  const s = inSetup(f, true, [[/Корень workspace/, [`${ws}/Org`]], [/Есть ещё папки/, [null]]]);
  expect(s.code).toBe(0);
  const line = s.out.split("\n").find((l) => l.includes("перешла к новому основному"))!;
  expect(line).toContain(`(кроме проектов внутри нового основного: они остаются в workspace`);
  expect(line).toContain("Вернуть его — README, «Несколько корней workspace»");
  expect(line).not.toMatch(/переименуйте|miksy root add/);
}, 240000);

// Круг 8c, C12 (рецензия B №3 проверки 8b): папку с проектами перенесли (прежней нет) и выбрали основным — рецепта
// «Вернуть его» нет (он снял бы слои с перенесённых проектов): «нет на месте … делать ничего не нужно»; после sync --all
// у перенесённых проектов те же слои. Скопировали (прежняя есть) — подсказка говорит, когда возвращать, а когда — clean
const layersOf = (f: ReturnType<typeof cliFixture>, p: string) => f.run(["explain", p]).out.match(/^Слои\s+(.*)$/m)?.[1] ?? "";
function movedScenario(tree: string | null) {
  const f = cliFixture({ projects: [] });
  const ws = `${f.dir}/ws`, ws2 = `${f.dir}/disk2/ws`;
  git(`${ws}/Org/p1`);
  git(`${f.dir}/drive/Acme/site`);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([tree ? { path: ws, tree } : ws, { path: `${f.dir}/drive`, tree: "Clients" }])}agents: [claude]\n`);
  const pre = tree ? `${tree}/` : "";
  put(`${f.config}/map.yaml`, `global:\n  - { use: global }\nlayers:\n  - { match: "${pre}Org/**", use: orgx }\n`);
  put(`${f.config}/layers/orgx/instructions/50.md`, "# orgx rule\n");
  put(`${f.config}/layers/tree/${pre}Org/instructions/10.md`, "# org rule\n");
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  return { f, ws, ws2 };
}
for (const tree of [null, "Main"])
  test(`C12: перенесли папку (ветка ${tree ?? "нет"}) — рецепта «Вернуть его» нет, слои перенесённых проектов те же`, () => {
    const { f, ws, ws2 } = movedScenario(tree);
    const before = layersOf(f, `${ws}/Org/p1`);
    mkdirSync(`${f.dir}/disk2`, { recursive: true });
    renameSync(ws, ws2);
    const s = inSetup(f, true, [[/Корень workspace/, [ws2]], [/Есть ещё папки/, [null]]]);
    expect(s.code).toBe(0);
    expect(s.out).not.toContain("Вернуть его:");
    expect(s.out).toContain(`прежнего основного ${ws} нет на месте: перенесли папку — делать ничего не нужно, учёт обычно переедет сам при sync --all`);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(layersOf(f, `${ws2}/Org/p1`)).toBe(before);
    expect(rules(`${ws2}/Org/p1/CLAUDE.local.md`)).toEqual(["org", "orgx"]);
  }, 240000);

test("C12: папку скопировали (прежняя на месте) — подсказка: возвращать, только если прежняя нужна; иначе clean в её проектах", () => {
  const { f, ws, ws2 } = movedScenario(null);
  mkdirSync(`${f.dir}/disk2`, { recursive: true });
  cpSync(ws, ws2, { recursive: true });
  const s = inSetup(f, true, [[/Корень workspace/, [ws2]], [/Есть ещё папки/, [null]]]);
  expect(s.code).toBe(0);
  // В копии те же папки (Org, Lab): перенос их слоёв снял бы слои и с копии — рецепта нет (круг 8d, B №4); что делать со
  // скопированной — сказано (B №5)
  const line = s.out.split("\n").find((l) => l.includes("из workspace уходит"))!;
  expect(line).not.toContain("Вернуть его:");
  expect(line).toContain("у нового основного есть папка с тем же именем (Org)");
  expect(line).toContain("Если папку скопировали, и прежняя копия не нужна, — не возвращайте, уберите записанное туда: miksy clean \"<путь проекта>\" в её проектах; в новой копии файлы miksy с путями");
  // Дословно: clean в проекте прежней копии — в ней не остаётся файлов miksy; у нового основного слои на месте
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  expect(f.run(["clean", `${ws}/Org/p1`]).code).toBe(0);
  expect(read(`${ws}/Org/p1/CLAUDE.local.md`)).toBe("");
  expect(rules(`${ws2}/Org/p1/CLAUDE.local.md`)).toEqual(["org", "orgx"]);
}, 240000);

// Круг 8c, C14 (рецензия B №5 проверки 8b): команда поиска копий machine.yaml из подсказки clean находит копию и когда в
// пути конфигурации [ ] (Windows: -LiteralPath) или ' (кавычки оболочки)
for (const dirName of process.platform === "win32" ? ["Work [old]", "O'Brien ’x"] : ["Work [old]", "O'Brien"])
  test(`C14: команда поиска копий machine.yaml — путь конфигурации «${dirName}»`, () => {
    const win = process.platform === "win32";
    const base = cliFixture({ projects: [] }).dir;
    const config = `${base}/${dirName}/miksy-config`, home = `${base}/home`, ws = `${base}/ws`, drive = `${base}/drive`, site = `${drive}/Acme/site`;
    mkdirSync(home, { recursive: true });
    put(`${config}/map.yaml`, "global:\n  - { use: global }\nlayers: []\n");
    put(`${config}/layers/tree/Clients/instructions/10.md`, "# clients\n");
    git(`${ws}/Org/p1`);
    git(site);
    put(`${config}/local/machine.yaml`, `${yamlRoots([ws, { path: drive, tree: "Clients" }])}agents: [claude]\n`);
    const f = { dir: base, config, home } as ReturnType<typeof cliFixture>;
    const cli = (args: string[]) => {
      const r = Bun.spawnSync([process.execPath, `${import.meta.dir}/../src/cli.ts`, ...args], { cwd: base, env: { ...process.env, MIKSY_CONFIG: config, HOME: home, USERPROFILE: home }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
    };
    expect(cli(["sync", "--all", "--yes"]).code).toBe(0);
    renameSync(drive, `${drive}-disk`);
    expect(inProcess(f, ["root", "remove", drive, "--forget"], base, null).err).toBe("");
    renameSync(`${drive}-disk`, drive);
    const c = cli(["clean", site]);
    // sh: кавычка в пути — '\'' (закрыть, экранированная, открыть)
    const cmd = c.out.match(win ? /\(PowerShell\) (Get-ChildItem -LiteralPath '(?:[^']|'')+' -Recurse -Filter machine\.yaml)/ : /(find '(?:[^']|'\\'')+' -name machine\.yaml)/)![1];
    const r = win
      ? Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", `(${cmd}).FullName`], { stdout: "pipe" })
      : Bun.spawnSync(["sh", "-c", cmd], { stdout: "pipe" });
    expect(r.stdout.toString().trim()).toContain("machine.yaml");
  }, 240000);

// Круг 8c, D3 («новичок» 8b, Н 1; рецензия B 8c, п. 2): выбрали основным не ту папку — новую пустую или бывший
// дополнительный корень. Рецепт README: копия local/machine.yaml из последней папки запуска, где она есть, — на место,
// затем sync --global, sync --all: корни, ветки и слои — как до ошибки
for (const [label, tree] of [["новая пустая", null], ["новая пустая", "Main"], ["дополнительный корень", null]] as const)
  test(`D3: выбрали основным не ту папку (${label}, ветка ${tree ?? "нет"}) — копия machine.yaml на место возвращает как было`, () => {
    const { f, ws } = movedScenario(tree);
    const before = layersOf(f, `${ws}/Org/p1`);
    const machineBefore = read(`${f.config}/local/machine.yaml`);
    const siteBefore = layersOf(f, `${f.dir}/drive/Acme/site`);
    const wrong = label === "новая пустая" ? `${f.dir}/empty` : `${f.dir}/drive`;
    mkdirSync(wrong, { recursive: true });
    expect(inSetup(f, true, [[/Корень workspace/, [wrong]], [/Есть ещё папки/, [null]]]).code).toBe(0);
    expect(read(`${f.config}/local/machine.yaml`)).not.toBe(machineBefore);
    // Последняя по дате папка запуска, где есть копия machine.yaml (путь — как у конфигурации, без двоеточия)
    const backups = `${f.config}/local/backups`;
    const rel = `${f.config}/local/machine.yaml`.replace(/^([A-Za-z]):/, "$1").replace(/^\/+/, "");
    const stamp = readdirSync(backups).filter((d) => !d.startsWith("before-miksy-") && existsSync(`${backups}/${d}/${rel}`)).sort().pop()!;
    writeFileSync(`${f.config}/local/machine.yaml`, readFileSync(`${backups}/${stamp}/${rel}`));
    expect(f.run(["sync", "--global"]).code).toBe(0);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect({ machine: read(`${f.config}/local/machine.yaml`), layers: layersOf(f, `${ws}/Org/p1`), site: layersOf(f, `${f.dir}/drive/Acme/site`) })
      .toEqual({ machine: machineBefore, layers: before, site: siteBefore });
    expect(rules(`${ws}/Org/p1/CLAUDE.local.md`)).toEqual(["org", "orgx"]);
  }, 240000);

// Повторная проверка 6 круга 8c: мастер успел записать в проект ошибочной папки — после возврата machine.yaml doctor
// показывает его полным путём в «Цели учёта вне workspace»; clean по этому пути убирает записанное, правильные проекты
// не трогает
test("D3: проект ошибочной папки — путь из doctor «Цели учёта вне workspace», clean по нему", () => {
  const { f, ws } = movedScenario(null);
  const wrong = `${f.dir}/empty`;
  git(`${wrong}/Wrong/p9`);
  expect(inSetup(f, true, [[/Корень workspace/, [wrong]], [/Есть ещё папки/, [null]]]).code).toBe(0);
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  expect(read(`${wrong}/Wrong/p9/CLAUDE.local.md`)).not.toBe("");
  const backups = `${f.config}/local/backups`;
  const rel = `${f.config}/local/machine.yaml`.replace(/^([A-Za-z]):/, "$1").replace(/^\/+/, "");
  const stamp = readdirSync(backups).filter((d) => !d.startsWith("before-miksy-") && existsSync(`${backups}/${d}/${rel}`)).sort().pop()!;
  writeFileSync(`${f.config}/local/machine.yaml`, readFileSync(`${backups}/${stamp}/${rel}`));
  expect(f.run(["sync", "--global"]).code).toBe(0);
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  const doc = f.run(["doctor"]).out;
  // Строки раздела — подряд после заголовка, с отступом
  const after = doc.slice(doc.indexOf("Цели учёта вне workspace")).split("\n").slice(1);
  const listed = after.slice(0, after.findIndex((l) => !/^\s{2}\S/.test(l))).map((l) => l.trim());
  expect(listed).toContain(`${wrong}/Wrong/p9`);
  for (const p of listed) expect(f.run(["clean", p]).code).toBe(0);
  expect(read(`${wrong}/Wrong/p9/CLAUDE.local.md`)).toBe("");
  expect(rules(`${ws}/Org/p1/CLAUDE.local.md`)).toEqual(["org", "orgx"]);
}, 240000);
