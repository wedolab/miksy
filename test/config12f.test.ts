// Круг 12f: проверка формы файлов настроек (src/schema.ts). Не та форма известного ключа — отказ до записи с понятной
// строкой (файл, путь ключа, что ожидается, пример), одной и той же в sync, sync --dry-run, doctor и explain; отказывает
// команда, которая файл читает, — ошибка в остальных файлах только предупреждение. Неизвестный ключ на любом уровне —
// предупреждение с подсказкой похожего имени. Значения секретов — искусственные
import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configScan } from "../src/load";
import { cliFixture, expectCode, put } from "./helpers";

const ROOT = join(import.meta.dir, "..");
const HEAD = "ошибки в настройках miksy — ничего не записано. Исправьте эти строки в файлах вручную и повторите:";
const OTHERS = "ошибки в файлах настроек, которые эта команда не читает, — исправьте, иначе откажет sync, которому они нужны";
const OS = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
const MCP = "name: x\ncommand: npx\nargs: [-y, pkg]\n";

type Case = { what: string; file: string; text: string; line: string; append?: boolean };
// Вид ошибки → файл, текст, строка сообщения. Слои и MCP — в корне дерева (их читает sync проекта и --all)
const CASES: Case[] = [
  { what: "map.yaml: global строкой", file: "map.yaml", text: "global: global\nlayers: []\n", line: "map.yaml: global — список слоёв для домашнего каталога агентов: { use: <слой> }, например global: [{ use: global }]" },
  { what: "map.yaml: элемент строкой", file: "map.yaml", text: "global:\n  - global\nlayers: []\n", line: "map.yaml: global[0] — { use: <слой> }, например { use: global }" },
  { what: "map.yaml: use числом", file: "map.yaml", text: "global:\n  - { use: 5 }\nlayers: []\n", line: "map.yaml: global[0].use — имя слоя — каталог в layers/" },
  { what: "map.yaml: нет use", file: "map.yaml", text: "global:\n  - { usee: global }\nlayers: []\n", line: "map.yaml: нет global[0].use — имя слоя" },
  { what: "map.yaml: os не из списка", file: "map.yaml", text: "global:\n  - { use: global, os: windoz }\nlayers: []\n", line: "map.yaml: global[0].os «windoz» — windows, macos или linux (или их список)" },
  { what: "map.yaml: match числом", file: "map.yaml", text: "global:\n  - { use: global }\nlayers:\n  - { use: global, match: 5 }\n", line: "map.yaml: layers[0].match — шаблон места в дереве слоёв (строка)" },
  { what: "map.yaml: layers объектом", file: "map.yaml", text: "global:\n  - { use: global }\nlayers: { use: global }\n", line: "map.yaml: layers — список привязок слоёв по шаблону" },
  { what: "map.yaml: tools.find строкой", file: "map.yaml", text: "global:\n  - { use: global }\nlayers: []\ntools:\n  GH: { find: gh }\n", line: "map.yaml: tools.GH.find — список команд для поиска в PATH" },
  { what: "layer.yaml: exclude строкой", file: "layers/tree/layer.yaml", text: "exclude: skill.x\n", line: "layers/tree/layer.yaml: exclude — список: mcp.<имя>, skill.<имя>, instructions.<файл>, например exclude: [mcp.linear, skill.deploy]" },
  { what: "layer.yaml: exclude не того вида", file: "layers/tree/layer.yaml", text: "exclude: [skil.x]\n", line: "layers/tree/layer.yaml: exclude[0] «skil.x» — список: mcp.<имя>" },
  { what: "layer.yaml: exclude числом", file: "layers/tree/layer.yaml", text: "exclude: [5]\n", line: "layers/tree/layer.yaml: exclude[0] — список: mcp.<имя>" },
  { what: "layer.yaml: trust: yes", file: "layers/tree/layer.yaml", text: "trust: yes\n", line: "layers/tree/layer.yaml: trust — объект {" },
  { what: "layer.yaml: import_skills: always", file: "layers/tree/layer.yaml", text: "import_skills: always\n", line: "layers/tree/layer.yaml: import_skills «always» — auto, all, false или список имён" },
  { what: "layer.yaml: target строкой", file: "layers/tree/layer.yaml", text: "target: \"yes\"\n", line: "layers/tree/layer.yaml: target «yes» — true или false (цель-группа)" },
  { what: "layer.yaml списком", file: "layers/tree/layer.yaml", text: "- exclude\n", line: "layers/tree/layer.yaml: файл — ожидается набор «ключ: значение», а не список" },
  { what: "mcp: args строкой", file: "layers/tree/mcp/x.yaml", text: "name: x\ncommand: npx\nargs: \"-y pkg\"\n", line: "layers/tree/mcp/x.yaml: args — список аргументов, например args: [-y, \"@scope/pkg\"]" },
  { what: "mcp: command списком", file: "layers/tree/mcp/x.yaml", text: "name: x\ncommand: [npx, pkg]\n", line: "layers/tree/mcp/x.yaml: command — команда запуска — строка (аргументы — в args)" },
  { what: "mcp: url числом", file: "layers/tree/mcp/x.yaml", text: "name: x\nurl: 5\n", line: "layers/tree/mcp/x.yaml: url — адрес удалённого (HTTP) сервера — строка" },
  { what: "mcp: env списком", file: "layers/tree/mcp/x.yaml", text: `${MCP}env: [A=b]\n`, line: "layers/tree/mcp/x.yaml: env — объект «ИМЯ: значение»" },
  { what: "mcp: headers строкой", file: "layers/tree/mcp/x.yaml", text: "name: x\nurl: https://example.invalid/mcp\nheaders: \"Authorization: x\"\n", line: "layers/tree/mcp/x.yaml: headers — объект «Заголовок: значение»" },
  { what: "mcp: os не из списка", file: "layers/tree/mcp/x.yaml", text: `${MCP}os: [windoz]\n`, line: "layers/tree/mcp/x.yaml: os — windows, macos или linux (или их список)" },
  { what: "mcp: agents.<агент> не skip", file: "layers/tree/mcp/x.yaml", text: `${MCP}agents: { claude: skp }\n`, line: "layers/tree/mcp/x.yaml: agents.claude «skp» — skip (этому агенту не подключать) или { raw: { … } }" },
  { what: "mcp: raw строкой", file: "layers/tree/mcp/x.yaml", text: `${MCP}agents: { claude: { raw: x } }\n`, line: "layers/tree/mcp/x.yaml: agents.claude — skip (этому агенту не подключать) или { raw: { … } }" },
  { what: "mcp: command и url вместе", file: "layers/tree/mcp/x.yaml", text: "name: x\ncommand: npx\nurl: https://example.invalid/mcp\n", line: "layers/tree/mcp/x.yaml: command и url вместе — нужно одно" },
  { what: "mcp: нет name", file: "layers/tree/mcp/x.yaml", text: "command: npx\n", line: "layers/tree/mcp/x.yaml: нет name — имя сервера" },
  { what: "mcp: файл списком", file: "layers/tree/mcp/x.yaml", text: "- name: x\n", line: "layers/tree/mcp/x.yaml: файл — ожидается набор «ключ: значение», а не список" },
  { what: "machine.yaml: vars списком", file: "local/machine.yaml", text: "vars: [A]\n", append: true, line: "local/machine.yaml: vars — объект «ИМЯ: значение»" },
  { what: "machine.yaml: значение vars списком", file: "local/machine.yaml", text: "vars: { A: [1] }\n", append: true, line: "local/machine.yaml: vars.A — объект «ИМЯ: значение»" },
  { what: "machine.yaml: trust: yes", file: "local/machine.yaml", text: "trust: yes\n", append: true, line: "local/machine.yaml: trust — объект {" },
  { what: "machine.yaml: mcp_off строкой", file: "local/machine.yaml", text: "mcp_off: gl\n", append: true, line: "local/machine.yaml: mcp_off — список имён MCP-серверов, выключенных на этой машине" },
];

const fixture = () => {
  const f = cliFixture({ agents: ["claude", "codex", "opencode"] });
  const p1 = `${f.ws}/Org/p1`;
  const nothing = () => !existsSync(`${p1}/CLAUDE.local.md`) && !existsSync(`${f.config}/local/state/manifest.json`);
  return { ...f, p1, nothing };
};
const write = (f: { config: string }, c: Case) => {
  const path = join(f.config, c.file);
  if (c.append) writeFileSync(path, readFileSync(path, "utf8") + c.text);
  else put(path, c.text);
};

describe("12f: не та форма известного ключа — отказ до записи, одна и та же строка", () => {
  for (const c of CASES) {
    test(c.what, () => {
      const f = fixture();
      write(f, c);
      const dry = f.run(["sync", "--all", "--dry-run"]);
      expectCode(dry, 1);
      expect(dry.err).toContain(HEAD);
      expect(dry.err).toContain(c.line);
      // Не JS-ошибка, а строка про файл
      expect(dry.err).not.toMatch(/is not a function|must be of type|undefined/);
      const sync = f.run(["sync", "--all"]);
      expectCode(sync, 1);
      expect(sync.err).toContain(c.line);
      expect(f.nothing()).toBe(true);
      const doc = f.run(["doctor"]);
      expectCode(doc, 1);
      expect(doc.out).toContain("Ошибки в файлах настроек (");
      expect(doc.out).toContain(`  ${c.line}`);
      const ex = f.run(["explain", f.p1]);
      expectCode(ex, 1);
      expect(ex.err).toContain(c.line);
    }, 60000);
  }
});

describe("12f: отказывает только команда, которая читает файл", () => {
  test("ошибка в слое дерева: sync --global пишет с предупреждением, sync --all и sync проекта отказывают", () => {
    const f = fixture();
    put(`${f.config}/layers/tree/mcp/x.yaml`, "name: x\ncommand: npx\nargs: \"-y pkg\"\n");
    const g = f.run(["sync", "--global"]);
    expectCode(g, 0);
    expect(g.out).toContain(`предупреждение: ${OTHERS} (например, sync --all):\n  layers/tree/mcp/x.yaml: args — список аргументов`);
    expect(existsSync(`${f.home}/.claude/CLAUDE.md`)).toBe(true);
    expectCode(f.run(["sync", "--all"]), 1);
    const one = f.run(["sync", f.p1]);
    expectCode(one, 1);
    expect(one.err).toContain("layers/tree/mcp/x.yaml: args");
    expect(existsSync(`${f.p1}/CLAUDE.local.md`)).toBe(false);
    // explain --global — как sync --global: предупреждение, не отказ
    const ex = f.run(["explain", "--global"]);
    expectCode(ex, 0);
    expect(ex.out).toContain(OTHERS);
  }, 60000);

  test("ошибка в слое организации, которой нет на этой машине: sync --all пишет с предупреждением, doctor — проблема", () => {
    const f = fixture();
    put(`${f.config}/layers/tree/Other/layer.yaml`, "trust: yes\n");
    const all = f.run(["sync", "--all"]);
    expectCode(all, 0);
    expect(all.out).toContain(`${OTHERS} (например, sync --all):\n  layers/tree/Other/layer.yaml: trust — объект {`);
    expect(existsSync(`${f.p1}/CLAUDE.local.md`)).toBe(true);
    const doc = f.run(["doctor"]);
    expectCode(doc, 1);
    expect(doc.out).toContain("Ошибки в файлах настроек (1) — sync, которому нужен такой файл, откажет, пока их не исправить:\n  layers/tree/Other/layer.yaml: trust — объект {");
  }, 60000);

  test("ошибки нескольких файлов — одним блоком; clean работает и со сломанной конфигурацией", () => {
    const f = fixture();
    expectCode(f.run(["sync", "--all"]), 0);
    put(`${f.config}/layers/tree/layer.yaml`, "exclude: skill.x\n");
    put(`${f.config}/layers/tree/mcp/x.yaml`, "name: x\ncommand: npx\nurl: https://example.invalid/mcp\n");
    const r = f.run(["sync", "--all", "--dry-run"]);
    expectCode(r, 1);
    expect(r.err).toContain(`${HEAD}\n  layers/tree/layer.yaml: exclude — список`);
    expect(r.err).toContain("\n  layers/tree/mcp/x.yaml: command и url вместе");
    const clean = f.run(["clean", f.p1]);
    expectCode(clean, 0);
    expect(existsSync(`${f.p1}/CLAUDE.local.md`)).toBe(false);
  }, 60000);
});

describe("12f: неизвестные ключи на любом уровне — предупреждение с подсказкой", () => {
  test("mcp, machine.yaml, tools, agents.<агент>, привязки — sync пишет, doctor в «Справочно»", () => {
    const f = fixture();
    put(`${f.config}/layers/tree/mcp/x.yaml`, `${MCP}enviroment: { A: b }\nagents: { claud: skip }\n`);
    put(`${f.config}/map.yaml`, "global:\n  - { use: global }\nlayers: []\ntools:\n  GH: { find: [gh], instal: { macos: brew install gh } }\n");
    writeFileSync(`${f.config}/local/machine.yaml`, readFileSync(`${f.config}/local/machine.yaml`, "utf8") + "mcp_of: [x]\n");
    const keys = [
      "map.yaml: tools.GH.instal (может быть, tools.GH.install?)",
      "local/machine.yaml: mcp_of (может быть, mcp_off?)",
      "layers/tree/mcp/x.yaml: enviroment (может быть, env?)",
      "layers/tree/mcp/x.yaml: agents.claud (может быть, agents.claude?)",
    ];
    const r = f.run(["sync", "--all"]);
    expectCode(r, 0);
    expect(r.out).toContain(`предупреждение: неизвестные ключи — miksy их не читает (опечатка или ключ более новой версии miksy): ${keys.join(", ")}`);
    expect(readFileSync(`${f.p1}/opencode.json`, "utf8")).toContain('"x"');
    expect(f.run(["doctor"]).out).toContain(`Неизвестные ключи (4) — miksy их не читает: опечатка или ключ более новой версии miksy:\n${keys.map((k) => "  " + k).join("\n")}`);
    expect(f.run(["explain", f.p1]).out).toContain("предупреждение: неизвестные ключи");
  }, 60000);

  test("замечания без отказа: description списком, привязка без match", () => {
    const f = fixture();
    put(`${f.config}/layers/tree/layer.yaml`, "description: [a, b]\n");
    put(`${f.config}/map.yaml`, "global:\n  - { use: global }\nlayers:\n  - { use: global }\n");
    const r = f.run(["sync", "--all", "--dry-run"]);
    expectCode(r, 0);
    expect(r.out).toContain("предупреждение: layers/tree/layer.yaml: description — строка (описание слоя; агентам не пишется)");
    expect(r.out).toContain("предупреждение: map.yaml: layers[0] — нет match: слой не применяется ни к одному проекту");
    const doc = f.run(["doctor"]);
    expect(doc.out).toContain("Замечания к файлам настроек (2):");
    expect(doc.out).not.toContain("Ошибки в файлах настроек");
  }, 60000);
});

describe("12f: прежние формы работают", () => {
  test("числа и true/false в args, env, vars; os строкой; ключ без значения — как отсутствие", () => {
    const f = fixture();
    put(`${f.config}/layers/tree/mcp/x.yaml`, `name: x\ncommand: npx\nargs: [-y, 5, true, "\${A}"]\nenv: { PORT: 8080 }\nos: ${OS}\nheaders:\n`);
    put(`${f.config}/layers/tree/layer.yaml`, "trust:\ntarget:\nimport_skills:\nexclude:\ndescription: 2026\n");
    writeFileSync(`${f.config}/local/machine.yaml`, readFileSync(`${f.config}/local/machine.yaml`, "utf8") + "vars: { A: 7 }\nmcp_off:\n");
    const r = f.run(["sync", "--all"]);
    expectCode(r, 0);
    expect(r.out).not.toContain("предупреждение: неизвестные ключи");
    expect(r.out).not.toContain("предупреждение: layers/");
    const claude = JSON.parse(readFileSync(`${f.home}/.claude.json`, "utf8")) as { projects: Record<string, { mcpServers?: Record<string, { args: string[]; env: Record<string, string> }> }> };
    const x = Object.values(claude.projects).find((p) => p.mcpServers?.x)!.mcpServers!.x;
    expect(x.args).toEqual(["-y", "5", "true", "7"]);
    expect(x.env).toEqual({ PORT: "8080" });
    const doc = f.run(["doctor"]).out;
    expect(doc).not.toContain("Ошибки в файлах настроек");
    expect(doc).not.toContain("Неизвестные ключи");
  }, 60000);

  test("образцы examples/ (config, extra, local) — без ошибок, неизвестных ключей и замечаний", () => {
    const f = cliFixture();
    const dir = `${f.dir}/examples-config`;
    cpSync(join(ROOT, "examples", "config"), dir, { recursive: true });
    cpSync(join(ROOT, "examples", "extra", "layers"), `${dir}/layers`, { recursive: true });
    mkdirSync(`${dir}/local`, { recursive: true });
    cpSync(join(ROOT, "examples", "local", "machine.yaml"), `${dir}/local/machine.yaml`);
    const scan = configScan(dir);
    expect({ errors: [...scan.errors.values()].flat(), unknown: scan.unknown, soft: scan.soft }).toEqual({ errors: [], unknown: [], soft: [] });
  });
});
