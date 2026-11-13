// Выпуск 0.2.2, A4: root remove недоступного корня без «забыть» — в обещании «уберёт miksy clean» только файлы агентов
// из agents; агентам вне agents — команда clean --agent. --dry-run говорит то же, что настоящий запуск. Диск вернулся —
// команды из вывода дословно: файлов miksy не осталось
import { expect, test } from "bun:test";
import { existsSync, readdirSync, renameSync, statSync } from "node:fs";
import { cliFixture, put } from "./helpers";
import { git, ledger, read, yamlRoots } from "./rootshelp";

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

// Дополнительный корень drive (Clients): проекты site и shop; агенты agents, затем в agents остаётся только claude;
// диск отключён
function scenario(agents: string[]) {
  const f = cliFixture({ agents, projects: ["Org/p1"] });
  const drive = `${f.dir}/drive`;
  const sites = [`${drive}/Acme/site`, `${drive}/Acme/shop`];
  for (const s of sites) git(s);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive, tree: "Clients" }])}agents: [${agents.join(", ")}]\n`);
  put(`${f.config}/layers/tree/Clients/instructions/10.md`, "# clients\n");
  put(`${f.config}/layers/tree/Clients/skills/s1/SKILL.md`, "---\nname: s1\ndescription: d\n---\nbody\n");
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  put(`${f.config}/local/machine.yaml`, read(`${f.config}/local/machine.yaml`).replace(`agents: [${agents.join(", ")}]`, "agents: [claude]"));
  renameSync(drive, `${drive}-disk`);
  return { f, drive, sites };
}
const promised = (out: string) => Number(out.match(/miksy clean "<путь проекта>" уберёт (\d+) файл/)?.[1] ?? -1);
const commands = (out: string) => out.split("\n").filter((l) => /^\s+miksy clean "[^"]+" --agent \w+$/.test(l)).map((l) => l.trim());

test("A4: в числе — только файлы агентов из agents; codex (вне agents) — команда clean --agent; --dry-run = настоящий запуск; дословно — файлов нет", () => {
  // Сколько файлов на диске у одного claude — эталон
  const solo = scenario(["claude"]);
  const soloDry = solo.f.run(["root", "remove", solo.drive, "--dry-run"]);
  const claudeOnly = Number(soloDry.out.match(/на нём записанное miksy: (\d+) файл/)![1]);
  expect(promised(soloDry.out)).toBe(claudeOnly);

  const { f, drive, sites } = scenario(["claude", "codex"]);
  const dry = f.run(["root", "remove", drive, "--dry-run"]);
  const all = Number(dry.out.match(/на нём записанное miksy: (\d+) файл/)![1]);
  expect(all).toBeGreaterThan(claudeOnly);
  // Круг 8b, C8 (рецензия B №6 проверки 8a): числа сходятся — всего = уберёт clean + только агентами вне agents (общий
  // .git/info/exclude правят оба — он в числе clean)
  const only = Number(dry.out.match(/из них только агентами, которых нет в agents, — (\d+) файл/)![1]);
  expect(only).toBeGreaterThan(0);
  expect(promised(dry.out) + only).toBe(all);
  // Круг 8b, C9 (рецензия B №7 проверки 8a): то же правило в doctor — в числе и обещании clean только агенты из agents,
  // агентам вне agents — команды clean --agent из строки «Учёт агентов, которых нет в agents»
  const want = sites.map((s) => `miksy clean "${s}" --agent codex`).sort();
  const retired = (out: string) => out.split("\n").map((l) => l.trim()).filter((l) => want.includes(l)).sort();
  const away = f.run(["doctor"]).out;
  expect(away).toContain(`Убрать записанное туда (${claudeOnly} файл`);
  expect(away).toMatch(/Учёт целей недоступного корня[^\n]*агентами из agents\)[^\n]*записанное только агентами, которых нет в agents \(\d+ файл[^\n]*команды в строке «Учёт агентов, которых нет в agents»/);
  expect(retired(away)).toEqual(want);
  const real = f.run(["root", "remove", drive]);
  expect({ code: real.code, err: real.err }).toEqual({ code: 0, err: "" });
  const left = f.run(["doctor"]).out;
  expect(left).toContain(`Учёт целей вне workspace без каталога (2; ${claudeOnly} файл`);
  expect(left).toMatch(/Учёт целей вне workspace без каталога[^\n]*записанное только агентами, которых нет в agents \(\d+ файл[^\n]*команды в строке «Учёт агентов, которых нет в agents»/);
  expect(retired(left)).toEqual(want);
  expect({ dry: promised(dry.out), real: promised(real.out) }).toEqual({ dry: claudeOnly, real: claudeOnly });
  expect({ dry: commands(dry.out).sort(), real: commands(real.out).sort() }).toEqual({ dry: want, real: want });
  // Учёт не тронут: обе цели codex на месте
  for (const s of sites) expect(ledger(f.config).targets[`codex|${s}`]).toBeTruthy();
  // Диск вернулся: «miksy clean "<путь проекта>"» — для каждого проекта из списка, затем команды codex — дословно
  renameSync(`${drive}-disk`, drive);
  // Диск на месте, корня в workspace нет: «Цели учёта вне workspace» — clean и clean --agent агентам вне agents (C9)
  const back = f.run(["doctor"]).out;
  expect(back).toContain("Цели учёта вне workspace (2) — их корень убран или workspace сменился: miksy их больше не обновляет; убрать записанное туда — miksy clean <путь> (агентам, которых нет в agents, — с --agent: команды в строке «Учёт агентов, которых нет в agents»):");
  expect(retired(back)).toEqual(want);
  const listed = real.out.split("\n").filter((l) => sites.includes(l.trim())).map((l) => l.trim());
  expect(listed.sort()).toEqual([...sites].sort());
  for (const s of listed) expect(f.run(["clean", s]).code).toBe(0);
  for (const c of commands(real.out)) {
    const m = c.match(/^miksy clean "([^"]+)" --agent (\w+)$/)!;
    expect(f.run(["clean", m[1], "--agent", m[2]]).code).toBe(0);
  }
  for (const s of sites) expect(filesIn(s)).toEqual([]);
  expect(Object.keys(ledger(f.config).targets).filter((id) => id.includes("/drive/"))).toEqual([]);
}, 300000);
