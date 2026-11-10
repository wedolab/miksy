// Выпуск 0.2.1, рецензия части A (тесты рецензента — out/review021a/miksy/test/zz-review021a.test.ts; R2 и второй тест
// R5 находками не были и не переносятся): п. 1 — сервер, дописанный пользователем в файл miksy проекта, — добавка (doctor,
// adopt); п. 2 — root add папки с проектами внутри git-репо в workspace (монорепо) — без вопроса, как в 0.2.0; п. 3 —
// root remove вложенного доступного корня --dry-run без терминала — как настоящий запуск; п. 4 — итог clean --all не
// называет снятую группу «удалённой»; п. 6 — clean забытого проекта без действий не теряет отметку «доверие ставил miksy»
import { describe, expect, test } from "bun:test";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { cliFixture, put } from "./helpers";
import { git, read, rootsFixture, yamlRoots } from "./rootshelp";

describe("п. 1 — сервер, добавленный пользователем вручную в файл miksy проекта, — добавка (doctor, adopt)", () => {
  test("opencode.json проекта (own, скрыт блоком miksy в exclude): пользователь дописал сервер mine", () => {
    const f = cliFixture({ agents: ["opencode"], projects: ["Org/p1"] });
    const p = `${f.ws}/Org/p1`;
    put(`${f.config}/layers/tree/mcp/s1.yaml`, "name: s1\ncommand: echo\nargs: [s1]\n");
    expect(f.run(["sync", p]).code).toBe(0);
    const doc = JSON.parse(read(`${p}/opencode.json`));
    expect(doc.mcp?.s1).toBeDefined();
    doc.mcp.mine = { type: "local", command: ["mine-server"] };
    put(`${p}/opencode.json`, JSON.stringify(doc, null, 2) + "\n");
    const d = f.run(["doctor"]);
    const a = f.run(["adopt", p, "mine", "--to", "Org", "--dry-run"]);
    expect({ doctor: d.out.includes("mcp mine"), adopt: a.err.includes("нет среди добавок") }).toEqual({ doctor: true, adopt: false });
  }, 120000);

  test(".codex/config.toml проекта (own): пользователь дописал сервер mine", () => {
    const f = cliFixture({ agents: ["codex"], projects: ["Org/p1"] });
    const p = `${f.ws}/Org/p1`;
    put(`${f.config}/layers/tree/mcp/s1.yaml`, "name: s1\ncommand: echo\nargs: [s1]\n");
    expect(f.run(["sync", p]).code).toBe(0);
    const text = read(`${p}/.codex/config.toml`);
    expect(text).toContain("s1");
    put(`${p}/.codex/config.toml`, `${text}\n[mcp_servers.mine]\ncommand = "mine-server"\n`);
    const d = f.run(["doctor"]);
    const a = f.run(["adopt", p, "mine", "--to", "Org", "--dry-run"]);
    expect({ doctor: d.out.includes("mcp mine"), adopt: a.err.includes("нет среди добавок") }).toEqual({ doctor: true, adopt: false });
  }, 120000);
});

describe("п. 2 — root add папки с проектами внутри git-репо в workspace (монорепо) — без вопроса", () => {
  test("ws/Org/mono (git) / apps / x (git): root add ws/Org/mono/apps --tree Apps", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    git(`${f.ws}/Org/mono`);
    git(`${f.ws}/Org/mono/apps/x`);
    const r = f.run(["root", "add", `${f.ws}/Org/mono/apps`, "--tree", "Apps"]);
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
  }, 120000);
});

describe("п. 3 — root remove вложенного доступного корня --dry-run без терминала — как настоящий запуск", () => {
  test("план не обещает «записанное и учёт останутся», если настоящий запуск этого не говорит", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    put(`${f.config}/layers/tree/Grp/layer.yaml`, "target: true\n");
    const inner = `${f.ws}/Grp/Inner`;
    git(`${inner}/p`);
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: inner, tree: "Code" }])}agents: [claude]\n`);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    const dry = f.run(["root", "remove", inner, "--dry-run"]);
    const real = f.run(["root", "remove", inner]);
    expect(dry.out.includes("записанное в проекты и учёт останутся")).toBe(real.out.includes("не тронуты"));
  }, 120000);
});

describe("п. 4 — итог clean --all: снятая группа — не «каталог удалён»", () => {
  test("снятая пометка группы: план clean --all --dry-run и настоящий запуск", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1", "Grp/q"] });
    put(`${f.config}/layers/tree/Grp/layer.yaml`, "target: true\n");
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    put(`${f.config}/layers/tree/Grp/layer.yaml`, "x: 1\n");
    const dry = f.run(["clean", "--all", "--dry-run"]);
    const real = f.run(["clean", "--all"]);
    expect(dry.out.includes("каталог удалён или переехал")).toBe(real.out.includes("каталог удалён или переехал"));
  }, 120000);
});

describe("п. 6 — clean забытого проекта без действий: отметка «доверие ставил miksy» остаётся", () => {
  test("«забыть» → диск вернулся, файлов miksy уже нет → clean → sync: о своих ответах в окне Claude не спрашивает", () => {
    const f = rootsFixture(["claude"]);
    const app = `${f.archive}/Acme/app`;
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    put(`${app}/.claude/settings.local.json`, JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }));
    renameSync(f.archive, `${f.archive}-disk`);
    mkdirSync(f.archive);
    expect(f.run(["clean", app, "--forget"]).code).toBe(0);
    rmSync(f.archive, { recursive: true });
    renameSync(`${f.archive}-disk`, f.archive);
    // Файлов miksy в проекте уже нет (убрали вручную)
    rmSync(`${app}/CLAUDE.local.md`, { force: true });
    expect(f.run(["clean", app]).code).toBe(0);
    const s = f.run(["sync", app]);
    expect({ ask: s.out.includes("Нужно решение"), allow: s.out.includes("разрешено без вопроса") }).toEqual({ ask: false, allow: false });
  }, 120000);
});
