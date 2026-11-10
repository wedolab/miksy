// Выпуск 0.2.1, круг 7c: правило доверия на всех путях (план out/7c-plan.md, одобрен основным агентом).
// R1: после clean / root remove / «забыть» / недоступности ответы в окне Claude «свои» только при совпавшем отпечатке;
//     отпечатка нет — один вопрос; чужая копия или новые ответы — вопрос и нет доверия.
// R2: снятие своего одобрения серверов .mcp.json и вопрос о них — в одном sync; «нет» — дальше не спрашивает и не одобряет.
// R3: после «забыть» у агента вне agents есть названная команда, после которой его файлов нет.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { cliFixture, put } from "./helpers";
import { git, inProcess, ledger, read, yamlRoots } from "./rootshelp";
import { allow, commit, hasTag, local, oldEngine, oldRunner, patchLocal, trusted, userTrusts } from "./fixes021b-helpers";

const pending = (out: string) => out.includes("Нужно решение пользователя о доверии");
type Env = { f: ReturnType<typeof cliFixture>; drive: string; site: string };

// Проект на втором корне: командный .mcp.json одобрен miksy («да»), свои ответы в окне Claude
// Без «да» доверию и без trust: true в слое: при них ответы в окне Claude свои по решению (так и в 0.2.0) — правило R1
// про отметки проверяется без них. team — ещё командный .mcp.json, «да» и одобрение miksy в settings.local.json
function setup(team = false): Env {
  const f = cliFixture({ projects: ["Org/p1"] });
  const drive = `${f.dir}/drive`, site = `${drive}/Acme/site`;
  git(site);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive, tree: "Clients" }])}agents: [claude]\n`);
  if (team) commit(site, { ".mcp.json": JSON.stringify({ mcpServers: { team: { command: "team-server" } } }) });
  ok(f.run(["sync", "--all", "--yes"]));
  if (team) ok(f.run(["trust", site, "--confirm"]));
  allow(site);
  expect(pending(f.run(["sync", site]).out)).toBe(false);
  expect(trusted(f.home, site)).toBe(true);
  if (team) expect(read(local(site))).toContain("\"team\""); // одобрение miksy лежит в файле вместе со своими ответами
  return { f, drive, site };
}
const DIALOG = "ответы в окне Claude («да";
const off = (e: Env) => renameSync(e.drive, `${e.drive}-off`);
const on = (e: Env) => renameSync(`${e.drive}-off`, e.drive);
const roots = (e: Env, drive = e.drive) => put(`${e.f.config}/local/machine.yaml`, `${yamlRoots([e.f.ws, { path: drive, tree: "Clients" }])}agents: [claude]\n`);

// Пути из таблицы плана (7, 9, 11 — вне правила: доверие Claude на месте папки miksy не снимал; как в 0.2.0 —
// fixes021c-paths711.test.ts). noPrint — «отпечатка нет»: и свои ответы — один вопрос
// Шаг подготовки — успешно: код 0, а не только пустой stderr (EBUSY под нагрузкой — «КОНФЛИКТ … цель пропущена», код 3:
// отметка «проект забыт» остаётся, и шаг молча меняет путь; проверка 7c, A №1)
const ok = (r: { code: number | null; err: string; out: string }) => expect({ code: r.code, err: r.err, out: r.code ? r.out : "" }).toEqual({ code: 0, err: "", out: "" });

const PATHS: { n: string; act: (e: Env) => void; noPrint?: true }[] = [
  { n: "2 clean доступной папки", act: (e) => ok(e.f.run(["clean", e.site])) },
  { n: "3 clean недоступной (одобрения miksy остались в файле)", act: (e) => { off(e); ok(e.f.run(["clean", e.site])); on(e); } },
  { n: "3 без отпечатка (учёт прежней версии)", noPrint: true, act: (e) => {
    const m = ledger(e.f.config) as any;
    for (const st of Object.values(m.targets) as any[]) delete st.dialog;
    put(`${e.f.config}/local/state/manifest.json`, JSON.stringify(m, null, 2) + "\n");
    off(e); ok(e.f.run(["clean", e.site])); on(e);
  } },
  { n: "3 → диск вернулся → clean ещё раз (как велит вывод)", act: (e) => { off(e); ok(e.f.run(["clean", e.site])); on(e); ok(e.f.run(["clean", e.site])); } },
  { n: "5 забыть → диск вернулся → clean", act: (e) => { off(e); ok(e.f.run(["clean", e.site, "--forget"])); on(e); ok(e.f.run(["clean", e.site])); } },
  { n: "8 root remove с согласием → root add", act: (e) => {
    const r = inProcess(e.f, ["root", "remove", e.drive], e.f.dir, [true]);
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
    ok(e.f.run(["root", "add", e.drive, "--tree", "Clients"]));
  } },
  { n: "13 clean → папку организации переименовали (соседний проект с файлами переехал)", act: (e) => {
    git(`${e.drive}/Acme/web`);
    ok(e.f.run(["sync", "--all", "--yes"]));
    ok(e.f.run(["clean", e.site]));
    renameSync(`${e.drive}/Acme`, `${e.drive}/Acme2`);
    e.site = `${e.drive}/Acme2/site`;
  } },
  { n: "14 clean → корень переименовали (путь в machine.yaml)", act: (e) => {
    ok(e.f.run(["clean", e.site]));
    renameSync(e.drive, `${e.drive}2`);
    e.drive = `${e.drive}2`; e.site = `${e.drive}/Acme/site`;
    roots(e);
  } },
  // Переименовали сам проект после clean: файлов miksy в нём нет — переезд не найти, один вопрос (README)
  { n: "15 clean → проект переименовали", noPrint: true, act: (e) => {
    ok(e.f.run(["clean", e.site]));
    renameSync(e.site, `${e.site}2`);
    e.site = `${e.site}2`;
  } },
];
const VARIANTS = ["свои", "изменены", "чужая копия"] as const;

test("R1: правило доверия на всех путях × свои / изменённые / чужие ответы в окне Claude", () => {
  const got: string[] = [], want: string[] = [];
  for (const p of PATHS) for (const v of VARIANTS) {
    const e = setup();
    p.act(e);
    if (v === "изменены") patchLocal(e.site, { permissions: { allow: ["Bash(ls:*)", "Bash(curl:*)"] } });
    if (v === "чужая копия") {
      rmSync(e.site, { recursive: true, force: true });
      mkdirSync(e.site, { recursive: true });
      git(e.site);
      put(local(e.site), JSON.stringify({ permissions: { allow: ["Bash(rm -rf:*)", "Bash(curl:*)"] } }, null, 2));
    }
    const s = e.f.run(["sync", e.site]);
    const ok = v === "свои" && !p.noPrint;
    // Код и ошибка команды — только если что-то не так: в строке будет видна причина (разовое падение в полном прогоне)
    got.push(`${p.n} / ${v}: вопрос=${pending(s.out)} доверие=${trusted(e.f.home, e.site)}${s.code === 0 || s.code === 3 ? "" : ` код=${s.code}`}${s.err ? ` ошибка=${s.err.trim().slice(0, 300)}` : ""}`);
    want.push(`${p.n} / ${v}: вопрос=${!ok} доверие=${ok}`);
    // Без отпечатка — один вопрос: после «да» дальше не спрашивает
    if (p.noPrint && v === "свои") {
      expect(inProcess(e.f, ["sync", e.site], e.f.dir, ["y"]).err).toBe("");
      expect(pending(e.f.run(["sync", e.site]).out)).toBe(false);
    }
  }
  expect(got).toEqual(want);
}, 900000);

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
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
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
