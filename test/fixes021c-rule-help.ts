// Общее для тестов правила доверия выпуска 0.2.1 (круг 7c): fixes021c-rule.test.ts и R1 по группам путей
// fixes021c-rule-r1{a,b,c}.test.ts (круг 10d: R1 разделён на три файла — при --parallel файлы идут одновременно; пути,
// варианты, шаги и ожидания — дословно прежние, в одном месте)
import { expect } from "bun:test";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { cliFixture, put } from "./helpers";
import { git, inProcess, ledger, read, yamlRoots } from "./rootshelp";
import { allow, commit, local, patchLocal, trusted } from "./fixes021b-helpers";

export const pending = (out: string) => out.includes("Нужно решение пользователя о доверии");
export type Env = { f: ReturnType<typeof cliFixture>; drive: string; site: string };

// Проект на втором корне: командный .mcp.json одобрен miksy («да»), свои ответы в окне Claude
// Без «да» доверию и без trust: true в слое: при них ответы в окне Claude свои по решению (так и в 0.2.0) — правило R1
// про отметки проверяется без них. team — ещё командный .mcp.json, «да» и одобрение miksy в settings.local.json
export function setup(team = false): Env {
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
export const DIALOG = "ответы в окне Claude («да";
export const off = (e: Env) => renameSync(e.drive, `${e.drive}-off`);
export const on = (e: Env) => renameSync(`${e.drive}-off`, e.drive);
export const roots = (e: Env, drive = e.drive) => put(`${e.f.config}/local/machine.yaml`, `${yamlRoots([e.f.ws, { path: drive, tree: "Clients" }])}agents: [claude]\n`);

// Пути из таблицы плана (7, 9, 11 — вне правила: доверие Claude на месте папки miksy не снимал; как в 0.2.0 —
// fixes021c-paths711.test.ts). noPrint — «отпечатка нет»: и свои ответы — один вопрос
// Шаг подготовки — успешно: код 0, а не только пустой stderr (EBUSY под нагрузкой — «КОНФЛИКТ … цель пропущена», код 3:
// отметка «проект забыт» остаётся, и шаг молча меняет путь; проверка 7c, A №1)
export const ok = (r: { code: number | null; err: string; out: string }) => expect({ code: r.code, err: r.err, out: r.code ? r.out : "" }).toEqual({ code: 0, err: "", out: "" });

export const PATHS: { n: string; act: (e: Env) => void; noPrint?: true }[] = [
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
export const VARIANTS = ["свои", "изменены", "чужая копия"] as const;

// R1 для части путей: каждый путь × свои / изменены / чужая копия — вопрос и доверие как в таблице плана 7c
export function r1(paths: typeof PATHS) {
  const got: string[] = [], want: string[] = [];
  for (const p of paths) for (const v of VARIANTS) {
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
}
