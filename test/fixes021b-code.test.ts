// Выпуск 0.2.1, круг 7b (проверка 7a): A3′ — причина запрета trust: false и когда план снимает доверие; A4′ — серверы
// miksy в own-файле, который правил пользователь. Из тестов рецензента (out/check021/miksy/test/zz-rev021a-{deny,doctor})
// с верными ожиданиями
import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { cliFixture, put } from "./helpers";
import { ledger, read } from "./rootshelp";
import { commit, trusted } from "./fixes021b-helpers";

const TEAM = { ".mcp.json": JSON.stringify({ mcpServers: { team: { command: "team-server" } } }), ".claude/settings.json": JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "team-hook.sh" }] }] } }) };

test("A3′: trust: false добавили после доверия miksy, sync не запускали: --confirm называет запрет и где он", () => {
  const f = cliFixture({ projects: ["Org/app"] });
  const app = `${f.ws}/Org/app`;
  commit(app, TEAM);
  expect(f.run(["sync", "--all", "--yes"]).err).toBe("");
  expect(f.run(["trust", app, "--confirm"]).err).toBe("");
  put(`${f.config}/layers/tree/Org/app/layer.yaml`, "trust: { claude: false }\n");
  const c = f.run(["trust", app, "--confirm"]);
  expect(c.out).toContain("доверять — записано в local/trust.json");
  expect(c.out).toMatch(/доверие Claude .*\(снять своё\)/);
  expect(c.out).toContain("доверие не ставится — запрет trust: { claude: false } в слое Org/app (его layer.yaml)");
  expect(c.out).toContain("доверие поставит следующий miksy sync после снятия запрета");
  expect(trusted(f.home, app)).toBe(false);
  // «Нет» запрету не мешает — о нём ни слова
  const d = f.run(["trust", app, "--deny"]);
  expect(d.out).not.toContain("запрет trust");
  // Запрет сняли, «да» — следующий sync ставит доверие
  expect(f.run(["trust", app, "--confirm"]).err).toBe("");
  put(`${f.config}/layers/tree/Org/app/layer.yaml`, "");
  expect(f.run(["sync", app]).out).not.toContain("Нужно решение");
  expect(trusted(f.home, app)).toBe(true);
}, 300000);

const ADDED = "Добавлено агентами в обход слоёв";
const addedLines = (out: string) => { const i = out.indexOf(ADDED); if (i < 0) return []; return out.slice(i).split(/\n\s*\n/)[0].split("\n").slice(1); };

test("A4′: в opencode.json проекта (файл miksy) пользователь дописал свой сервер — добавка только его; серверы miksy, убранные из слоёв и пропущенные из-за переменной, — нет", () => {
  const f = cliFixture({ agents: ["claude", "codex", "opencode", "antigravity"], projects: ["Org/p1"] });
  const p1 = `${f.ws}/Org/p1`;
  put(`${f.config}/layers/global/mcp/gsrv.yaml`, "name: gsrv\ncommand: echo\nargs: [g]\n");
  put(`${f.config}/layers/tree/mcp/tsrv.yaml`, "name: tsrv\ncommand: echo\nargs: [t]\n");
  put(`${f.config}/layers/tree/mcp/vsrv.yaml`, "name: vsrv\ncommand: echo\nargs: [\"${MY_VAR}\"]\n");
  put(`${f.config}/local/machine.yaml`, read(`${f.config}/local/machine.yaml`) + "vars:\n  MY_VAR: v1\n");
  expect(f.run(["sync", "--global"]).err).toBe("");
  expect(f.run(["sync", "--all", "--yes"]).err).toBe("");
  expect(f.run(["doctor"]).out).toContain("Всё синхронизировано");
  rmSync(`${f.config}/layers/global/mcp/gsrv.yaml`);
  rmSync(`${f.config}/layers/tree/mcp/tsrv.yaml`);
  put(`${f.config}/local/machine.yaml`, read(`${f.config}/local/machine.yaml`).replace("vars:\n  MY_VAR: v1\n", ""));
  expect(addedLines(f.run(["doctor"]).out)).toEqual([]);
  const pj = JSON.parse(read(`${p1}/opencode.json`));
  pj.mcp = { ...(pj.mcp ?? {}), usrpo: { type: "local", command: ["usrpo-cmd"] } };
  put(`${p1}/opencode.json`, JSON.stringify(pj, null, 2));
  const d = f.run(["doctor"]);
  expect(addedLines(d.out).join("\n")).toMatch(/^\s*opencode {2}Org\/p1 {2}mcp usrpo /);
  expect(addedLines(d.out).length).toBe(1);
  // sync файл не перезаписывает (правка пользователя — конфликт): список серверов miksy остаётся прежним
  f.run(["sync", "--all", "--yes"]);
  expect(addedLines(f.run(["doctor"]).out).join("\n")).not.toMatch(/tsrv|vsrv/);
}, 300000);

test("A4′: учёт без списка серверов own-файлов (записан 0.2.0) — первый sync без изменений его дописывает", () => {
  const f = cliFixture({ agents: ["claude", "opencode"], projects: ["Org/p1"] });
  put(`${f.config}/layers/tree/mcp/tsrv.yaml`, "name: tsrv\ncommand: echo\nargs: [t]\n");
  expect(f.run(["sync", "--all", "--yes"]).err).toBe("");
  const own = (m: any) => Object.values(m.targets).flatMap((st: any) => Object.values(st.ownMcp ?? {}).flat());
  const m = ledger(f.config) as any;
  expect(own(m)).toContain("tsrv");
  for (const st of Object.values(m.targets) as any[]) delete st.ownMcp;
  put(`${f.config}/local/state/manifest.json`, JSON.stringify(m, null, 2) + "\n");
  const s = f.run(["sync", "--all", "--yes"]);
  expect(s.out).not.toMatch(/\(обновить\)|\(создать\)/);
  expect(own(ledger(f.config))).toContain("tsrv");
  // --dry-run учёт не пишет
  const m2 = ledger(f.config) as any;
  for (const st of Object.values(m2.targets) as any[]) delete st.ownMcp;
  put(`${f.config}/local/state/manifest.json`, JSON.stringify(m2, null, 2) + "\n");
  f.run(["sync", "--all", "--dry-run", "--yes"]);
  expect(own(ledger(f.config))).toEqual([]);
}, 300000);
