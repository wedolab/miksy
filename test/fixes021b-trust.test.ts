// Выпуск 0.2.1, круг 7b (проверка 7a, рецензия A): доверие после clean и «нет», записанное 0.2.0.
// Из тестов рецензента (out/check021/miksy/test/zz-rev021a-{trustclean,trustmove,rollback}.test.ts): там они закрепляли
// неверное поведение — здесь с верными ожиданиями
import { expect, test } from "bun:test";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { cliFixture, put } from "./helpers";
import { git, inProcess, ledger, read, yamlRoots } from "./rootshelp";
import { allow, commit, hasTag, local, oldEngine, oldRunner, patchLocal, trusted, userTrusts } from "./fixes021b-helpers";

const pending = (out: string) => out.includes("Нужно решение пользователя о доверии");
const before = (config: string) => (ledger(config) as { trustedBefore?: Record<string, string> }).trustedBefore;
const DIALOG = "ответы в окне Claude («да";

// A №1: папку удалили после clean и положили на её место чужую копию (архив коллеги) с его ответами в окне Claude
test.skipIf(!hasTag())("A1′: после clean на том же пути — другая папка (копия коллеги с его «разрешено без вопроса»): 0.2.1 спрашивает, как 0.2.0", () => {
  const results: Record<string, { asked: boolean; trusted: boolean; out: string }> = {};
  for (const ver of ["0.2.1", "0.2.0"]) {
    const f = cliFixture({ projects: ["Org/app"] });
    const run = ver === "0.2.1" ? f.run : oldRunner(oldEngine(), f);
    const app = `${f.ws}/Org/app`;
    expect(run(["sync", "--all", "--yes"]).err).toBe("");
    allow(app); // свой ответ пользователя
    expect(run(["sync", app]).err).toBe("");
    expect(trusted(f.home, app)).toBe(true);
    expect(run(["clean", app]).err).toBe("");
    expect(trusted(f.home, app)).toBe(false);
    rmSync(app, { recursive: true, force: true });
    mkdirSync(app, { recursive: true });
    git(app);
    put(local(app), JSON.stringify({ permissions: { allow: ["Bash(rm -rf:*)", "Bash(curl:*)"] } }, null, 2));
    const s = run(["sync", app]);
    expect(s.err).toBe("");
    results[ver] = { asked: pending(s.out), trusted: trusted(f.home, app), out: s.out };
  }
  expect(results["0.2.1"].out).toContain("Bash(rm -rf:*)");
  expect({ "0.2.0": [results["0.2.0"].asked, results["0.2.0"].trusted], "0.2.1": [results["0.2.1"].asked, results["0.2.1"].trusted] })
    .toEqual({ "0.2.0": [true, false], "0.2.1": [true, false] });
}, 300000);

test("A1′: ответы в окне Claude добавлены после clean — вопрос о них (с прежними); не менялись — вопроса нет", () => {
  const f = cliFixture({ projects: ["Org/app"] });
  const app = `${f.ws}/Org/app`;
  expect(f.run(["sync", "--all", "--yes"]).err).toBe("");
  allow(app);
  expect(f.run(["sync", app]).out).not.toContain("Нужно решение");
  // Не менялись: clean → sync — без вопроса, доверие ставится, отметка снята
  expect(f.run(["clean", app]).err).toBe("");
  expect(Object.keys(before(f.config) ?? {}).length).toBe(1);
  const s1 = f.run(["sync", app]);
  expect({ asked: pending(s1.out), trusted: trusted(f.home, app), mark: before(f.config) }).toEqual({ asked: false, trusted: true, mark: undefined });
  // Добавлены после clean: вопрос, в нём ответы в окне Claude
  expect(f.run(["clean", app]).err).toBe("");
  patchLocal(app, { permissions: { allow: ["Bash(ls:*)", "Bash(curl:*)"] } });
  const s2 = f.run(["sync", app]);
  expect({ asked: pending(s2.out), trusted: trusted(f.home, app) }).toEqual({ asked: true, trusted: false });
  expect(s2.out).toContain(DIALOG);
  expect(s2.out).toContain("Bash(curl:*)");
  // Вернули как было — снова свои: вопроса нет
  patchLocal(app, { permissions: { allow: ["Bash(ls:*)"] } });
  const s3 = f.run(["sync", app]);
  expect({ asked: pending(s3.out), trusted: trusted(f.home, app) }).toEqual({ asked: false, trusted: true });
  // «Да» на вопрос после изменения — доверие стоит, следующий sync не спрашивает
  expect(f.run(["clean", app]).err).toBe("");
  patchLocal(app, { permissions: { allow: ["Bash(ls:*)", "Bash(git:*)"] } });
  const y = inProcess(f, ["sync", app], f.dir, ["y"]);
  expect({ err: y.err, q: y.questions.length, trusted: trusted(f.home, app) }).toEqual({ err: "", q: 1, trusted: true });
  expect(pending(f.run(["sync", app]).out)).toBe(false);
}, 300000);

// Цель без git, общая с коллегой: после clean коллега дописал своё в settings.local.json / .codex/config.toml / .mcp.json
test("A1′: цель без git после clean: хуки, env, режим разрешений, .mcp.json коллеги и правка .codex/config.toml — в вопросе; свои ответы — нет", () => {
  const f = cliFixture({ agents: ["claude", "codex"], projects: [] });
  put(`${f.config}/layers/tree/Shared/layer.yaml`, "target: true\n");
  const sh = `${f.ws}/Shared`;
  put(`${sh}/notes.txt`, "x\n");
  expect(f.run(["sync", "--all", "--yes"]).err).toBe("");
  allow(sh);
  expect(f.run(["sync", sh]).out).not.toContain("Нужно решение");
  expect(trusted(f.home, sh)).toBe(true);
  expect(f.run(["clean", sh]).err).toBe("");
  const s1 = f.run(["sync", sh]);
  expect({ asked: pending(s1.out), trusted: trusted(f.home, sh) }).toEqual({ asked: false, trusted: true });
  // Ответы в окне Claude те же (permissions.allow), исполняемое коллеги — в вопросе
  patchLocal(sh, { hooks: { Stop: [{ hooks: [{ type: "command", command: "colleague.sh" }] }] }, env: { HTTPS_PROXY: "http://evil:8080" }, permissions: { allow: ["Bash(ls:*)"], defaultMode: "bypassPermissions" } });
  put(`${sh}/.mcp.json`, JSON.stringify({ mcpServers: { col: { command: "col-server" } } }));
  put(`${sh}/.codex/config.toml`, read(`${sh}/.codex/config.toml`) + "\nnotify = [\"colleague-notify\"]\n");
  const s2 = f.run(["sync", sh]);
  expect(s2.out).toMatch(/хук Stop: colleague\.sh/);
  expect(s2.out).toMatch(/переменные окружения/);
  expect(s2.out).toMatch(/режим разрешений/);
  expect(s2.out).toMatch(/MCP col/);
  expect(s2.out).toMatch(/Codex:[\s\S]*colleague-notify|colleague-notify[\s\S]*Codex/);
  expect(s2.out).not.toContain(DIALOG);
}, 300000);

test("A1′: root remove (согласие) → root add → sync --all и «забыть» → [sync →] clean → sync: свои ответы в окне Claude — без вопроса; хук коллеги — в вопросе", () => {
  const f = cliFixture({ projects: ["Org/p1"] });
  const drive = `${f.dir}/drive`;
  git(`${drive}/Acme/site`);
  git(`${drive}/Acme/web`);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive, tree: "Clients" }])}agents: [claude]\n`);
  const site = `${drive}/Acme/site`, web = `${drive}/Acme/web`;
  expect(f.run(["sync", "--all", "--yes"]).err).toBe("");
  allow(site); allow(web);
  expect(f.run(["sync", "--all", "--yes"]).out).not.toContain("Нужно решение");
  const rm = inProcess(f, ["root", "remove", drive], f.dir, [true]);
  expect(rm.err).toBe("");
  expect(trusted(f.home, site)).toBe(false);
  expect(Object.keys(before(f.config) ?? {}).length).toBe(2);
  // Коллега положил хук в web, пока корня не было
  patchLocal(web, { hooks: { Stop: [{ hooks: [{ type: "command", command: "colleague.sh" }] }] } });
  expect(f.run(["root", "add", drive, "--tree", "Clients"]).err).toBe("");
  const a = f.run(["sync", "--all", "--yes"]);
  expect(trusted(f.home, site)).toBe(true);
  expect(a.out).toMatch(/Clients\/Acme\/web — Claude:[\s\S]*colleague\.sh/);
  expect(a.out).not.toMatch(/Clients\/Acme\/site — Claude/);
  expect(a.out).not.toContain(DIALOG);

  // «забыть» → sync → clean → sync
  renameSync(drive, `${drive}.off`);
  expect(f.run(["clean", site, "--forget"]).err).toBe("");
  renameSync(`${drive}.off`, drive);
  expect(f.run(["sync", site]).err).toBe("");
  expect(trusted(f.home, site)).toBe(true);
  expect(f.run(["clean", site]).err).toBe("");
  const s = f.run(["sync", site]);
  expect({ asked: pending(s.out), trusted: trusted(f.home, site) }).toEqual({ asked: false, trusted: true });

  // «забыть» → clean (без sync) → sync
  renameSync(drive, `${drive}.off`);
  expect(f.run(["clean", site, "--forget"]).err).toBe("");
  renameSync(`${drive}.off`, drive);
  expect(f.run(["clean", site]).err).toBe("");
  const s3 = f.run(["sync", site]);
  expect({ asked: pending(s3.out), trusted: trusted(f.home, site) }).toEqual({ asked: false, trusted: true });
}, 300000);

// README «Переименовали или перенесли каталог»: переименовали папку корня — путь в local/machine.yaml, затем sync --all
test("A1′: папку корня переименовали после clean проекта: отметка переезжает — на новом месте свои ответы без вопроса, на старом отметки нет", () => {
  const f = cliFixture({ projects: ["Org/p1"] });
  const drive = `${f.dir}/drive`, drive2 = `${f.dir}/drive2`;
  git(`${drive}/Acme/site`);
  git(`${drive}/Acme/web`);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive, tree: "Clients" }])}agents: [claude]\n`);
  expect(f.run(["sync", "--all", "--yes"]).err).toBe("");
  allow(`${drive}/Acme/web`);
  expect(f.run(["sync", "--all", "--yes"]).out).not.toContain("Нужно решение");
  expect(f.run(["clean", `${drive}/Acme/web`]).err).toBe("");
  renameSync(drive, drive2);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive2, tree: "Clients" }])}agents: [claude]\n`);
  // План (--dry-run) — тоже без вопроса
  const d = f.run(["sync", "--all", "--dry-run", "--yes"]);
  expect(d.out).not.toMatch(/Clients\/Acme\/web — Claude/);
  const s = f.run(["sync", "--all", "--yes"]);
  expect(s.out).toContain("перенесён вслед за каталогами");
  expect(s.out).not.toMatch(/Clients\/Acme\/web — Claude/);
  expect(trusted(f.home, `${drive2}/Acme/web`)).toBe(true);
  expect(Object.keys(before(f.config) ?? {}).filter((k) => k.toLowerCase().includes(`${drive}/`.toLowerCase()))).toEqual([]);
}, 120000);

// A №2: «нет» после «да», записанное 0.2.0, оставило в local/trust.json mcpjson: yes
test.skipIf(!hasTag())("A2′: «нет» доверию Claude, записанное 0.2.0 после «да»: после обновления и доверия в окне Claude sync серверы .mcp.json не одобряет, а спрашивает", () => {
  const f = cliFixture({ projects: ["Org/deny"] });
  const run = oldRunner(oldEngine(), f);
  const deny = `${f.ws}/Org/deny`;
  commit(deny, { ".mcp.json": JSON.stringify({ mcpServers: { tdeny: { command: "deny-server" } } }) });
  expect(run(["sync", "--all", "--yes"]).err).toBe("");
  expect(run(["trust", deny, "--confirm"]).err).toBe("");
  expect(run(["trust", deny, "--deny"]).err).toBe("");
  const entry = Object.values(JSON.parse(read(`${f.config}/local/trust.json`)).decisions)[0] as any;
  expect({ claude: entry.claude.answer, mcpjson: entry.mcpjson?.answer }).toEqual({ claude: "no", mcpjson: "yes" });
  userTrusts(f.home, deny);
  const s = f.run(["sync", deny]);
  expect(s.err).toBe("");
  expect(read(`${deny}/.claude/settings.local.json`)).not.toContain("tdeny");
  expect(s.out).toMatch(/серверы \.mcp\.json \(Claude\)/);
  // «Да» на отдельный вопрос — одобряет; дальше без вопроса
  const y = inProcess(f, ["sync", deny], f.dir, ["y"]);
  expect({ err: y.err, q: y.questions.length }).toEqual({ err: "", q: 1 });
  expect(read(`${deny}/.claude/settings.local.json`)).toContain("tdeny");
  expect(pending(f.run(["sync", deny]).out)).toBe(false);
  // Прежний v0.2.0 читает такой local/trust.json (с отметкой alone) без ошибок и одобрения не снимает
  const o = run(["sync", deny]);
  expect(o.err).toBe("");
  expect(o.code).toBe(0);
  expect(read(`${deny}/.claude/settings.local.json`)).toContain("tdeny");
}, 300000);

test("A2′: «нет» → доверие в окне Claude → «да» серверам на отдельный вопрос → следующий sync не спрашивает и одобряет (в тот же день)", () => {
  const f = cliFixture({ projects: ["Org/app"] });
  const app = `${f.ws}/Org/app`;
  commit(app, { ".mcp.json": JSON.stringify({ mcpServers: { team: { command: "team-server" } } }) });
  expect(f.run(["sync", "--all", "--yes"]).err).toBe("");
  expect(f.run(["trust", app, "--deny"]).err).toBe("");
  userTrusts(f.home, app);
  // «Нет» записано и серверам: sync о них не спрашивает (решить заново — miksy trust), не одобряет
  const s = f.run(["sync", app]);
  expect(read(local(app))).not.toContain("\"team\"");
  expect(s.err).toBe("");
  const y = inProcess(f, ["trust", app], f.dir, ["y"]);
  expect({ err: y.err, q: y.questions.join("|") }).toEqual({ err: "", q: expect.stringContaining(".mcp.json") });
  const d = (Object.values(JSON.parse(read(`${f.config}/local/trust.json`)).decisions)[0] as any);
  expect({ claude: d.claude.answer, mcpjson: d.mcpjson.answer, date: d.mcpjson.date === d.claude.date }).toEqual({ claude: "no", mcpjson: "yes", date: true });
  const again = f.run(["sync", app]);
  expect(pending(again.out)).toBe(false);
  expect(read(local(app))).toContain("\"team\"");
  expect(pending(f.run(["doctor"]).out)).toBe(false);
}, 300000);
