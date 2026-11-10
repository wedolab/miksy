// Выпуск 0.2.1, круг 7b (проверка 7a, рецензия B №2): каталоги слоёв, отличающиеся только регистром, на ФС с учётом
// регистра (Linux; на Windows — каталог с включённым учётом регистра, fsutil). Из теста рецензента
// out/check021/miksy2/test/zz-check021b-case.test.ts с верными ожиданиями
import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { cliFixture, put } from "./helpers";
import { git, read, yamlRoots } from "./rootshelp";

// layers/tree с учётом регистра; false — так нельзя (не Windows и не Linux, нет прав) — тест пропускается
function caseTree(config: string): boolean {
  const tree = `${config}/layers/tree`;
  if (process.platform === "linux") return true;
  if (process.platform !== "win32") return false;
  renameSync(tree, `${tree}-old`);
  mkdirSync(tree, { recursive: true });
  const r = Bun.spawnSync(["fsutil.exe", "file", "setCaseSensitiveInfo", tree.replaceAll("/", "\\"), "enable"], { stdout: "pipe", stderr: "pipe" });
  for (const e of readdirSync(`${tree}-old`)) renameSync(`${tree}-old/${e}`, `${tree}/${e}`);
  rmSync(`${tree}-old`, { recursive: true });
  return r.exitCode === 0;
}
const canCase = process.platform === "linux" || process.platform === "win32";

test.skipIf(!canCase)("B №2: два каталога слоёв, отличающиеся регистром — doctor предупреждает, какой применяется", () => {
  const f = cliFixture({ projects: ["Org/p1"] });
  const drive = `${f.dir}/drive`;
  git(`${drive}/Acme/site`);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive, tree: "Clients" }])}agents: [claude]\n`);
  if (!caseTree(f.config)) return;
  put(`${f.config}/layers/tree/Clients/instructions/10-upper.md`, "# rule upper\n");
  put(`${f.config}/layers/tree/clients/instructions/20-lower.md`, "# rule lower\n");
  const names = readdirSync(`${f.config}/layers/tree`).filter((n) => n.toLowerCase() === "clients");
  if (names.length < 2) return; // каталог без учёта регистра
  expect(f.run(["sync", "--global"]).code).toBe(0);
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  const got = [...read(`${drive}/Acme/site/CLAUDE.local.md`).matchAll(/^# rule (\w+)$/gm)].map((m) => m[1]);
  const d = f.run(["doctor"]);
  expect(d.out).toContain("Каталоги слоёв отличаются только регистром (1)");
  const used = got[0] === "upper" ? "Clients" : "clients";
  expect(d.out).toContain(`применяется только ${used}`);
  expect(d.out).toMatch(/layers\/tree\/(Clients|clients), layers\/tree\/(Clients|clients)/);
  expect(d.out).not.toContain("Всё синхронизировано");
}, 120000);

test.skipIf(!canCase)("B №2: adopt --to <ветка в другом регистре> кладёт сервер в существующий каталог слоя — сервер и правила доходят", () => {
  const f = cliFixture({ projects: ["Org/p1"] });
  const drive = `${f.dir}/drive`;
  git(`${drive}/Acme/site`);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive, tree: "clients" }])}agents: [claude]\n`);
  if (!caseTree(f.config)) return;
  put(`${f.config}/layers/tree/Clients/instructions/10-clients.md`, "# rule clients\n");
  put(`${f.home}/.claude.json`, JSON.stringify({ mcpServers: { foo: { command: "echo", args: ["foo"] } } }, null, 2));
  expect(f.run(["doctor"]).out).toContain("mcp foo");
  const a = f.run(["adopt", "--global", "foo", "--to", "clients", "--yes"]);
  expect(a.code).toBe(0);
  expect(readdirSync(`${f.config}/layers/tree`).filter((n) => n.toLowerCase() === "clients")).toEqual(["Clients"]);
  expect(read(`${f.config}/layers/tree/Clients/mcp/foo.yaml`)).toContain("foo");
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  const claude = JSON.parse(read(`${f.home}/.claude.json`));
  const key = Object.keys(claude.projects ?? {}).find((k) => k.toLowerCase() === `${drive}/Acme/site`.toLowerCase());
  const servers = key ? Object.keys(claude.projects[key].mcpServers ?? {}) : [];
  const rules = [...read(`${drive}/Acme/site/CLAUDE.local.md`).matchAll(/^# rule (\w+)$/gm)].map((m) => m[1]);
  expect({ servers, rules }).toEqual({ servers: ["foo"], rules: ["clients"] });
  expect(f.run(["doctor"]).out).not.toContain("отличаются только регистром");
}, 120000);
