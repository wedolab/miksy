// Выпуск 0.2.3, A1 (проверка 8b, B №2): диск исчез вместе с буквой, у проекта на нём был MCP-сервер Claude
// (~/.claude.json, projects["Q:/…"]). «Забыть» (root remove --forget) и clean не спотыкаются: сервер проекта убран из
// ~/.claude.json, записи учёта нет, конфликта нет. Обратный случай: запись вне всех корней, которые раскрываются, при
// пропавшем диске — по-прежнему отказ. Тесты взяты у рецензента проверки 8b (out/check022b)
import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { cliFixture, put } from "./helpers";
import { git, inProcess, ledger, read, yamlRoots } from "./rootshelp";
import { missingDrive } from "./nodrive";
import { escapes } from "../src/paths";

const win = process.platform === "win32";

function world() {
  const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
  const drive = `${f.dir}/drive`, site = `${drive}/Acme/site`;
  git(site);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive, tree: "Clients" }])}agents: [claude]\n`);
  put(`${f.config}/layers/tree/Clients/mcp/srv.yaml`, "name: srv\ncommand: echo\nargs: [hi]\n");
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  // Как если бы sync шёл, пока диск был подключён: путь корня — на букве диска, которой сейчас нет
  const root = missingDrive("Clients");
  const forms = (p: string) => [p, p.replaceAll("/", "\\"), p.replaceAll("/", "\\\\"), p.toLowerCase().replaceAll("/", "\\"), p.toLowerCase().replaceAll("/", "\\\\")];
  const from = forms(drive), to = forms(root);
  for (const p of [`${f.config}/local/state/manifest.json`, `${f.config}/local/machine.yaml`, `${f.home}/.claude.json`])
    if (existsSync(p)) { let t = read(p); for (let i = 0; i < from.length; i++) t = t.replaceAll(from[i], to[i]); writeFileSync(p, t); }
  return { f, root, site: site.replace(drive, root) };
}
const servers = (home: string, site: string) => Object.keys(JSON.parse(read(`${home}/.claude.json`) || "{}").projects?.[site]?.mcpServers ?? {});

test.skipIf(!win)("A1: нет диска + MCP-сервер Claude — root remove --forget: без конфликта, учёт пуст, сервера нет", () => {
  const { f, root, site } = world();
  expect(servers(f.home, site)).toEqual(["srv"]);
  const r = inProcess(f, ["root", "remove", root, "--forget"], f.dir, null);
  const ids = Object.keys(ledger(f.config).targets).filter((k) => k.includes(root));
  const doc = inProcess(f, ["doctor"], f.dir, null);
  expect({ code: r.code, conflict: /КОНФЛИКТ/.test(r.out), ledger: ids, servers: servers(f.home, site), doctor: doc.out.split("\n").filter((l) => l.includes(root)) })
    .toEqual({ code: 0, conflict: false, ledger: [], servers: [], doctor: [] });
}, 240000);

test.skipIf(!win)("A1: нет диска + MCP-сервер Claude — clean убирает сервер проекта из ~/.claude.json", () => {
  const { f, site } = world();
  const c = inProcess(f, ["clean", site], f.dir, null);
  expect({ code: c.code, conflict: /КОНФЛИКТ/.test(c.out), servers: servers(f.home, site) }).toEqual({ code: 0, conflict: false, servers: [] });
}, 240000);

// Обратный случай: путь записи вне всех корней, которые раскрываются, — отказ; не раскрылся ни один — причина, как раньше
test("A1: запись вне раскрытых корней при пропавшем диске — по-прежнему отказ", () => {
  const f = cliFixture({ projects: [] });
  const gone = missingDrive("Clients/Acme/site");
  expect(escapes(`${f.home}/.claude.json`, gone, f.home)).toBeNull();
  expect(escapes(`${f.dir}/elsewhere/x.json`, gone, f.home)).toMatch(/путь вне/);
  expect(escapes(`${f.home}/.claude.json`, gone)).toBeTruthy();
});
