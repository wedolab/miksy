// Выпуск 0.2.3, A3 и A4 (проверка 8a, B №3; «Открытое» 8a): root remove и файлы агентов, которых нет в agents.
// - A4: доступный корень, codex убран из agents — root remove говорит, что его файлы clean без --agent не убирает, и даёт
//   команду; она дословно убирает их.
// - A3: после «забыть» и возврата диска root add → root remove с «да»: подсказка о папках, где осталась отметка codex, —
//   с возвратом корня (root add) первой строкой, а не голым sync для папки, которую этот же запуск убирает из workspace.
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { cliFixture, put } from "./helpers";
import { git, inProcess, yamlRoots } from "./rootshelp";

const files = (d: string, base = d): string[] => existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => e.name === ".git" ? [] : e.isDirectory() ? files(`${d}/${e.name}`, base) : [`${d}/${e.name}`.slice(base.length + 1)]) : [];

function world() {
  const f = cliFixture({ agents: ["claude", "codex"], projects: [] });
  const drive = `${f.dir}/drive`, site = `${drive}/Acme/site`;
  git(site);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive, tree: "Clients" }])}agents: [claude, codex]\n`);
  put(`${f.config}/layers/tree/Clients/instructions/10.md`, "# clients\n");
  put(`${f.config}/layers/tree/Clients/skills/s1/SKILL.md`, "---\nname: s1\ndescription: s\n---\nx\n");
  put(`${f.config}/layers/tree/Clients/mcp/tool.yaml`, "name: tool\ncommand: echo\n");
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  // codex убран из agents
  const m = `${f.config}/local/machine.yaml`;
  writeFileSync(m, readFileSync(m, "utf8").replace("agents: [claude, codex]", "agents: [claude]"));
  return { f, drive, site };
}

test("A4: root remove доступного корня — команда для файлов агента вне agents; дословно убирает их", () => {
  const { f, drive, site } = world();
  expect(files(site).some((p) => p.startsWith(".codex/"))).toBe(true);
  const r = inProcess(f, ["root", "remove", drive], f.dir, [true]);
  const line = r.out.split("\n").find((l) => l.includes("--agent codex"))?.trim() ?? "";
  expect(line).toBe(`miksy clean "${site}" --agent codex`);
  expect(r.out).toContain("Записанное агентами, которых нет в agents, clean без --agent не убирает");
  const c = f.run(["clean", site, "--agent", "codex"]);
  expect({ code: c.code, left: files(site) }).toEqual({ code: 0, left: [] });
}, 300000);

test("A4: root remove --dry-run и без терминала — та же команда", () => {
  const { f, drive, site } = world();
  for (const r of [inProcess(f, ["root", "remove", drive, "--dry-run"], f.dir, null), inProcess(f, ["root", "remove", drive, "--dry-run"], f.dir, []), inProcess(f, ["root", "remove", drive], f.dir, null)])
    expect(r.out).toContain(`miksy clean "${site}" --agent codex`);
}, 300000);

test("A3: «забыть» → диск вернулся → root add → root remove «да»: подсказка о забытом codex — с root add первой строкой", () => {
  const { f, drive, site } = world();
  renameSync(drive, `${drive}.off`);
  expect(inProcess(f, ["root", "remove", drive, "--forget"], f.dir, null).code).toBe(0);
  renameSync(`${drive}.off`, drive);
  expect(inProcess(f, ["root", "add", drive, "--tree", "Clients"], f.dir, [true]).code).toBe(0);
  const r = inProcess(f, ["root", "remove", drive], f.dir, [true]);
  const lines = r.out.split("\n");
  const sync = lines.findIndex((l) => l.includes(`miksy sync "${site}" --agent codex`));
  expect(sync).toBeGreaterThan(0);
  // Перед строкой sync — возврат корня (папка уже вне workspace после этого запуска)
  expect(lines.slice(0, sync).some((l) => /^\s+miksy root add /.test(l))).toBe(true);
  expect(r.out).toContain("Папка вне workspace: sync работает только в нём");
}, 300000);
