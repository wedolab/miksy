// setup и агенты: команда в PATH или только каталог настроек; новый агент при повторном setup
import { describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cliFixture, expectCode, put } from "./helpers";
import { detectAgents, setup as runSetup } from "../src/setup";
import type { Ask } from "../src/ask";
import { ENGINE } from "../src/load";

const win = process.platform === "win32";

// Поддельная команда агента в отдельном каталоге PATH
function fakeCommand(dir: string, name: string) {
  const file = win ? `${dir}/${name}.cmd` : `${dir}/${name}`;
  put(file, win ? "@echo off\r\n" : "#!/bin/sh\n");
  if (!win) chmodSync(file, 0o755);
}


// Мастер в процессе (как setup --yes): движок — копия в песочнице (workspace по умолчанию — от её места, внутри
// песочницы), система — поддельная, команды агентов — which. Настоящий движок под песочницей workspace не предлагает,
// и setup --yes подпроцессом записал бы в конфигурацию место настоящего движка (круг 8e, F6)
function inProcessSetup(f: ReturnType<typeof cliFixture>, which: (c: string) => string | null, o: { ask?: Ask | null; agentAsk?: Ask | null } = {}): string {
  const engine = `${f.dir}/ws/home/Miksy/miksy`;
  cpSync(join(ENGINE, "examples"), `${engine}/examples`, { recursive: true });
  put(`${engine}/src/cli.ts`, "// движок для теста\n");
  const saved = { ...process.env }, logs: string[] = [], orig = console.log;
  Object.assign(process.env, { MIKSY_CONFIG: f.config, HOME: f.home, USERPROFILE: f.home, BUN_INSTALL: `${f.dir}/bun` });
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  try {
    const sys = { which, exec: () => 0, git: () => 0, userPath: { get: () => "", set: () => {} }, refreshPath: () => {} };
    runSetup({ ask: o.ask ?? null, agentAsk: o.agentAsk, force: false, engine, sys, log: (s = "") => logs.push(s) });
  } finally {
    console.log = orig;
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
  return logs.join("\n");
}

// Ответы на вопросы «Найден агент X…»: сценарий по агенту (undefined — Enter, ответ по умолчанию); прочие вопросы мастера —
// по умолчанию. asked — вопросы об агентах с умолчанием
function agentAnswers(map: Record<string, boolean | undefined>, asked: { q: string; def: boolean }[]): Ask {
  return {
    yes: (q, def = false) => {
      const m = q.match(/^Найден агент (\w+)/);
      if (!m) return def;
      asked.push({ q, def });
      return map[m[1]] ?? def;
    },
    choose: (_q, _o, def) => def ?? null,
    line: () => null,
  };
}

// Учёт с записями агента: machine.yaml с claude и codex, sync --global, затем codex убран из agents вручную (без clean)
function removedByHand(f: ReturnType<typeof cliFixture>) {
  const machine = `${f.config}/local/machine.yaml`;
  const text = readFileSync(machine, "utf8");
  put(machine, text.replace(/^agents: .*$/m, "agents: [claude, codex]"));
  expectCode(f.run(["sync", "--global"]), 0);
  put(machine, text);
}

describe("setup: какие агенты настраивать", () => {
  test("detectAgents: команда в PATH — найден; нет команды, но есть каталог настроек — отдельно", () => {
    const f = cliFixture();
    mkdirSync(`${f.home}/.claude`, { recursive: true });
    mkdirSync(`${f.home}/.config/opencode`, { recursive: true });
    const which = (c: string) => (c === "codex" ? "/bin/codex" : null);
    const r = detectAgents(f.home, which);
    expect(r.inPath).toEqual(["codex"]);
    expect(r.dirOnly.map((d) => d.id)).toEqual(["claude", "opencode"]);
    expect(r.dirOnly[0].dir).toContain(".claude");
  });

  test("агент только с каталогом настроек: без вопроса (--yes) не добавляется, подсказка — как добавить", () => {
    const f = cliFixture();
    rmSync(`${f.config}/local/machine.yaml`);
    mkdirSync(`${f.home}/.claude`, { recursive: true });
    const out = inProcessSetup(f, () => null);
    expect(out).toMatch(/claude: команды нет в PATH, но есть .*\.claude/);
    expect(readFileSync(`${f.config}/local/machine.yaml`, "utf8")).toMatch(/^agents: \[\]$/m);
  }, 30000);

  // Круг 10i: агент вне agents — новый или убранный пользователем; без терминала machine.yaml не трогается
  test("повторный setup --yes: агент в PATH вне agents не дописывается — подсказка, machine.yaml не меняется", () => {
    const f = cliFixture({ agents: ["claude"] });
    const machine = `${f.config}/local/machine.yaml`;
    put(machine, readFileSync(machine, "utf8") + "# моя заметка\nvars:\n  CUSTOM: \"x\"\n");
    const before = readFileSync(machine, "utf8");
    const bin = `${f.dir}/bin`;
    fakeCommand(bin, "claude");
    fakeCommand(bin, "codex");
    const out = inProcessSetup(f, (c) => (["claude", "codex"].includes(c) ? `${bin}/${c}` : null));
    expect(out, out).toContain("• найден агент codex, его нет в agents (local/machine.yaml) — miksy его не настраивает. Подключить: miksy setup в терминале (спросит) или допишите его в agents в local/machine.yaml, затем miksy sync --global и miksy sync --all. Убрали его сами — ничего делать не нужно");
    expect(out, out).toContain("Агенты: claude (из текущего local/machine.yaml)");
    expect(out, out).not.toContain("добавлены агенты");
    expect(readFileSync(machine, "utf8")).toBe(before);
  }, 30000);

  test("в терминале: вопрос о каждом агенте вне agents; Enter — «да», «нет» — не дописан, прочее в файле на месте", () => {
    const f = cliFixture({ agents: ["claude"] });
    const machine = `${f.config}/local/machine.yaml`;
    put(machine, readFileSync(machine, "utf8") + "# моя заметка\n");
    const before = readFileSync(machine, "utf8");
    const which = (c: string) => (["claude", "codex", "opencode"].includes(c) ? `${f.dir}/bin/${c}` : null);
    const asked: { q: string; def: boolean }[] = [];
    const out = inProcessSetup(f, which, { agentAsk: agentAnswers({ codex: undefined, opencode: false }, asked) });
    expect(asked).toEqual([{ q: "Найден агент codex. Подключить?", def: true }, { q: "Найден агент opencode. Подключить?", def: true }]);
    expect(out, out).toContain("✓ в local/machine.yaml добавлены агенты: codex — дальше: miksy sync --global и miksy sync --all");
    expect(out, out).toContain("  не подключены: opencode — miksy их не настраивает; передумаете — miksy setup ещё раз (спросит) или допишите в agents в local/machine.yaml");
    expect(readFileSync(machine, "utf8")).toBe(before.replace(/^agents: .*$/m, "agents: [claude, codex]"));
    // Повторно: codex уже в agents — о нём не спрашивает, opencode — снова
    asked.length = 0;
    inProcessSetup(f, which, { agentAsk: agentAnswers({ opencode: true }, asked) });
    expect(asked.map((a) => a.q)).toEqual(["Найден агент opencode. Подключить?"]);
    expect(readFileSync(machine, "utf8")).toMatch(/^agents: \[claude, codex, opencode\]$/m);
  }, 30000);

  test("мастер setup в терминале спрашивает о найденном агенте так же", () => {
    const f = cliFixture({ agents: ["claude"] });
    const asked: { q: string; def: boolean }[] = [];
    inProcessSetup(f, (c) => (["claude", "codex"].includes(c) ? `${f.dir}/bin/${c}` : null), { ask: agentAnswers({ codex: false }, asked) });
    expect(asked).toEqual([{ q: "Найден агент codex. Подключить?", def: true }]);
    expect(readFileSync(`${f.config}/local/machine.yaml`, "utf8")).toMatch(/^agents: \[claude\]$/m);
  }, 60000);

  test("агент с учётом (убран из agents вручную, без clean): умолчание «нет», вопрос объясняет; «да» — вернётся", () => {
    const f = cliFixture({ agents: ["claude"] });
    removedByHand(f);
    const machine = `${f.config}/local/machine.yaml`;
    const which = (c: string) => (["claude", "codex"].includes(c) ? `${f.dir}/bin/${c}` : null);
    const asked: { q: string; def: boolean }[] = [];
    inProcessSetup(f, which, { agentAsk: agentAnswers({}, asked) });
    expect(asked).toEqual([{ q: "Найден агент codex: раньше miksy писал ему настройки, его убрали из agents (local/machine.yaml). Подключить снова?", def: false }]);
    expect(readFileSync(machine, "utf8")).toMatch(/^agents: \[claude\]$/m);
    inProcessSetup(f, which, { agentAsk: agentAnswers({ codex: true }, asked) });
    expect(readFileSync(machine, "utf8")).toMatch(/^agents: \[claude, codex\]$/m);
  }, 60000);

  test("переход: агент уже убран (с учётом и без) — setup --yes его не возвращает", () => {
    const f = cliFixture({ agents: ["claude"] });
    removedByHand(f);
    const machine = `${f.config}/local/machine.yaml`;
    const before = readFileSync(machine, "utf8");
    const out = inProcessSetup(f, (c) => (["claude", "codex", "opencode"].includes(c) ? `${f.dir}/bin/${c}` : null));
    expect(out, out).toContain("• найдены агенты codex, opencode, их нет в agents (local/machine.yaml) — miksy их не настраивает. Подключить: miksy setup в терминале (спросит) или допишите их в agents");
    expect(readFileSync(machine, "utf8")).toBe(before);
  }, 60000);
});

// Выпуск 0.2.3, A8 («Открытое» 8e): без --force, при готовом machine.yaml, движок прямо в каталоге без раскладки
// (workspace по умолчанию не определить) — мастер берёт workspace из файла; нового агента без терминала не дописывает,
// а подсказывает (круг 10i)
test("A8: движок без раскладки, machine.yaml есть — о новом агенте в PATH подсказка, «workspace не выбран» нет", () => {
  const f = cliFixture({ agents: ["claude"] });
  const machine = `${f.config}/local/machine.yaml`;
  const engine = `${f.home}/miksy`;
  cpSync(join(ENGINE, "examples"), `${engine}/examples`, { recursive: true });
  put(`${engine}/src/cli.ts`, "// движок для теста\n");
  const saved = { ...process.env }, logs: string[] = [], orig = console.log;
  Object.assign(process.env, { MIKSY_CONFIG: f.config, HOME: f.home, USERPROFILE: f.home, BUN_INSTALL: `${f.dir}/bun` });
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  try {
    const which = (c: string) => (["claude", "codex"].includes(c) ? `${f.dir}/bin/${c}` : null);
    const sys = { which, exec: () => 0, git: () => 0, userPath: { get: () => "", set: () => {} }, refreshPath: () => {} };
    runSetup({ ask: null, force: false, engine, sys, log: (s = "") => logs.push(s) });
  } finally {
    console.log = orig;
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
  const out = logs.join("\n");
  expect({ notChosen: /workspace не выбран/.test(out), hint: out.includes("• найден агент codex, его нет в agents"), agents: readFileSync(machine, "utf8").match(/^agents: .*$/m)?.[0] }, out)
    .toEqual({ notChosen: false, hint: true, agents: "agents: [claude]" });
}, 30000);
