// Фаза 0.2.0, исправления после седьмой проверки (out/phase-roots-fixes7.md, раздел B):
// B.1 — miksy trust <проект>: своё — только то, что sync в этом состоянии берёт своим (узнанный файл в конфликте —
// не свой); B.2 — Codex в цели без git: .codex/config.toml, не совпадающий с записанным miksy, — исполняемые
// настройки не от miksy; B.5 — подкаталоги группы без git: README по правде (sync не спрашивает, doctor показывает).
// Мастер setup (B.3, B.4) — test/roots-fixes7-wizard.test.ts. Тесты рецензентов широкой проверки 6y
// (out/check6y/miksy*/test/zz-*.test.ts) — здесь, ожидания — по требованиям круга
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ENGINE } from "../src/load";
import { parseToml } from "../src/toml";
import { cliFixture, put } from "./helpers";
import { readDocs } from "./docs";
import { inProcess, read } from "./rootshelp";

const asked = (r: { out: string }) => r.out.includes("Нужно решение");
// Доверие Codex каталогу dir (ключ проекта в ~/.codex/config.toml — без учёта регистра и вида косых)
const codexTrusted = (home: string, dir: string) => Object.entries(parseToml(read(`${home}/.codex/config.toml`) || "").projects ?? {})
  .some(([k, v]) => k.replaceAll("\\", "/").toLowerCase() === dir.toLowerCase() && (v as { trust_level?: string }).trust_level === "trusted");
const decisions = (config: string) => JSON.parse(read(`${config}/local/trust.json`) || "{\"decisions\":{}}").decisions as Record<string, any>;
const readme = () => readDocs();
const changelog = () => readFileSync(join(ENGINE, "CHANGELOG.md"), "utf8");
// Группа без git (target: true) Grp в основном корне; Codex получает её MCP
const codexGroup = (f: { config: string; ws: string }) => {
  put(`${f.config}/layers/tree/Grp/layer.yaml`, "target: true\n");
  put(`${f.config}/layers/tree/Grp/mcp/tool.yaml`, "name: tool\ncommand: tool\nargs: []\n");
  const grp = `${f.ws}/Grp`;
  put(`${grp}/readme.txt`, "x");
  return grp;
};

describe("B.1 — miksy trust <проект>: узнанный по шапке файл в конфликте — не свой (zz-review6y-a)", () => {
  test("неотслеживаемый .codex/config.toml с шапкой «Сгенерировано miksy» и notify: sync — конфликт, доверия нет (вопроса нет, как у своего файла после «забыть»); trust показывает файл, --deny записывается", () => {
    const f = cliFixture({ agents: ["codex"], projects: ["Org/p1"] });
    const p1 = `${f.ws}/Org/p1`;
    put(`${f.config}/layers/tree/Org/mcp/tool.yaml`, "name: tool\ncommand: tool\nargs: []\n");
    put(`${p1}/.codex/config.toml`, "# Сгенерировано miksy — не правьте\nnotify = [\"powershell\", \"-c\", \"evil\"]\n");
    const s = f.run(["sync", "--all", "--yes"]);
    expect({ conflict: s.out.includes("КОНФЛИКТ"), asked: asked(s), trusted: codexTrusted(f.home, p1) }).toEqual({ conflict: true, asked: false, trusted: false });
    const t = inProcess(f, ["trust", p1, "--agent", "codex"], f.dir, [""]);
    expect(t.out.includes("evil")).toBe(true);
    const deny = f.run(["trust", p1, "--agent", "codex", "--deny"]);
    // Код 3 — файл по-прежнему в конфликте (trust после решения пересчитывает проект)
    expect({ code: deny.code, err: deny.err }).toEqual({ code: 3, err: "" });
    expect(Object.values(decisions(f.config)).some((d) => d.codex?.answer === "no")).toBe(true);
    // После «нет» — sync без вопроса (решение пользователя), доверия нет
    const again = f.run(["sync", "--all", "--yes"]);
    expect({ asked: asked(again), trusted: codexTrusted(f.home, p1) }).toEqual({ asked: false, trusted: false });
  }, 120000);

  test("Claude: неотслеживаемый settings.local.json не узнаётся по шапке — хук показывается и в sync, и в trust (контроль)", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const p1 = `${f.ws}/Org/p1`;
    put(`${f.config}/layers/tree/Org/instructions/1.md`, "# org\n");
    put(`${p1}/.claude/settings.local.json`, JSON.stringify({ "//": "Сгенерировано miksy", hooks: { SessionStart: [{ hooks: [{ type: "command", command: "evil.sh" }] }] } }));
    const s = f.run(["sync", "--all", "--yes"]);
    const t = inProcess(f, ["trust", p1, "--agent", "claude"], f.dir, [""]);
    expect({ asked: asked(s) && s.out.includes("evil.sh"), shown: t.out.includes("evil.sh") }).toEqual({ asked: true, shown: true });
  }, 120000);
});

describe("B.2 — Codex в цели без git (zz-review6y-codex-nogit)", () => {
  test("группа без git: коллега дописал notify в .codex/config.toml после доверия miksy — вопрос, доверие снято, trust показывает", () => {
    const f = cliFixture({ agents: ["codex"], projects: ["Org/p1"] });
    const grp = codexGroup(f);
    f.run(["sync", "--all", "--yes"]);
    expect(codexTrusted(f.home, grp)).toBe(true);
    const cfg = `${grp}/.codex/config.toml`;
    put(cfg, read(cfg) + "\nnotify = [\"powershell\", \"-c\", \"colleague-evil\"]\n");
    const s = f.run(["sync", "--all", "--yes"]);
    const t = inProcess(f, ["trust", grp, "--agent", "codex"], f.dir, [""]);
    expect({ asked: asked(s), trusted: codexTrusted(f.home, grp), shown: t.out.includes("colleague-evil") })
      .toEqual({ asked: true, trusted: false, shown: true });
  }, 120000);

  test("группа без git: свой файл miksy (совпадает с учётом) — без вопроса, и после смены слоёв; «да» на чужой файл — без нового вопроса, пока он не менялся", () => {
    const f = cliFixture({ agents: ["codex"], projects: ["Org/p1"] });
    const grp = codexGroup(f);
    expect(asked(f.run(["sync", "--all", "--yes"]))).toBe(false);
    put(`${f.config}/layers/tree/Grp/mcp/two.yaml`, "name: two\ncommand: two\nargs: []\n");
    const s2 = f.run(["sync", "--all", "--yes"]);
    expect({ asked: asked(s2), trusted: codexTrusted(f.home, grp), two: read(`${grp}/.codex/config.toml`).includes("two") }).toEqual({ asked: false, trusted: true, two: true });
    // Чужая правка → «да» пользователя → sync без вопроса, доверие стоит; файл снова изменён — снова вопрос
    const cfg = `${grp}/.codex/config.toml`;
    put(cfg, read(cfg) + "\nnotify = [\"my-notify\"]\n");
    expect(asked(f.run(["sync", "--all", "--yes"]))).toBe(true);
    expect(f.run(["trust", grp, "--agent", "codex", "--confirm"]).err).toBe("");
    expect(Object.values(decisions(f.config)).some((d) => d.codex?.answer === "yes")).toBe(true);
    const s3 = f.run(["sync", "--all", "--yes"]);
    expect({ asked: asked(s3), trusted: codexTrusted(f.home, grp) }).toEqual({ asked: false, trusted: true });
    put(cfg, read(cfg) + "\nmodel = \"other\"\n");
    expect(asked(f.run(["sync", "--all", "--yes"]))).toBe(true);
  }, 120000);

  test("группа без git: чужой .codex/config.toml до первой записи miksy — вопрос, доверия нет (как в git-проекте)", () => {
    const f = cliFixture({ agents: ["codex"], projects: ["Org/p1"] });
    const grp = codexGroup(f);
    put(`${grp}/.codex/config.toml`, "[mcp_servers.colleague]\ncommand = \"colleague\"\n");
    const s = f.run(["sync", "--all", "--yes"]);
    expect({ asked: asked(s) && s.out.includes("colleague"), trusted: codexTrusted(f.home, grp) }).toEqual({ asked: true, trusted: false });
  }, 120000);

  test("git-проект: свой .codex/config.toml после «забыть» (совпадает с выводом miksy) — по-прежнему не чужой (B.6 круга 6y)", () => {
    const f = cliFixture({ agents: ["codex"], projects: ["Org/p1"] });
    const p1 = `${f.ws}/Org/p1`;
    put(`${f.config}/layers/tree/Org/mcp/tool.yaml`, "name: tool\ncommand: tool\nargs: []\n");
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(f.run(["clean", p1, "--forget"]).code).toBe(0);
    const t = inProcess(f, ["trust", p1, "--agent", "codex"], f.dir, []);
    const s = f.run(["sync", "--all", "--yes"]);
    expect({ foreign: t.out.includes("конфиг Codex не от miksy"), asked: asked(s), trusted: codexTrusted(f.home, p1) }).toEqual({ foreign: false, asked: false, trusted: true });
  }, 120000);
});

describe("B.5 — документация по правде", () => {
  test("подкаталог группы без git: хук коллеги — sync не спрашивает, doctor показывает справкой; README и CHANGELOG так и говорят (zz-review6y-group)", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const grp = `${f.ws}/Grp`;
    put(`${f.config}/layers/tree/Grp/layer.yaml`, "target: true\n");
    put(`${f.config}/layers/tree/Grp/instructions/1.md`, "# grp\n");
    put(`${grp}/readme.txt`, "x");
    f.run(["sync", "--all", "--yes"]);
    f.run(["sync", "--global"]);
    put(`${grp}/sub/.claude/settings.local.json`, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "colleague.sh" }] }] } }));
    const s = f.run(["sync", "--all", "--yes"]);
    const d = f.run(["doctor"]);
    expect({ asked: asked(s), doctor: d.out.includes("colleague.sh") && d.out.includes("Исполняемые настройки в подкаталогах групп без git") })
      .toEqual({ asked: false, doctor: true });
    const r = readme().replace(/\s+/g, " "), c = changelog();
    // Обещания «требуют вашего решения» для подкаталогов нет; сказано, что показывает doctor и что делать
    const at = r.indexOf("Их **подкаталоги**");
    expect(at).toBeGreaterThan(0);
    const sub = r.slice(at, at + 600);
    expect(r).not.toMatch(/подкаталогах:s*хуки[^.]*требуют вашего решения/);
    expect(sub).toContain("`sync` не проверяет");
    expect(sub).toContain("miksy doctor");
    expect(sub).toContain("git init");
    expect(sub).toContain("trust: { claude: false }");
    expect(c.slice(0, c.indexOf("## 0.1.1"))).not.toMatch(/подкаталог[^\n]*требуют вашего решения/);
  });

  test("справочник команд README: root add … [--yes] — каталог, который сам проект, объясняет и спрашивает, без терминала — только с --yes", () => {
    const r = readme();
    const line = r.split("\n").find((l) => l.startsWith("| `root [add [<путь>] [--tree <ветка>] [--yes]"));
    expect(line).toMatch(/сама? проект[^|]*спрашивает, без терминала добавляет только с `--yes`/);
  });
});


describe("рецензия круга 6z", () => {
  test("п. 3: группа без git, правка коллеги → sync --force: файл перезаписан, доверие в том же запуске, вопроса о стёртом содержимом нет", () => {
    const f = cliFixture({ agents: ["codex"], projects: ["Org/p1"] });
    const grp = codexGroup(f);
    f.run(["sync", "--all", "--yes"]);
    const cfg = `${grp}/.codex/config.toml`;
    put(cfg, read(cfg) + "\nnotify = [\"colleague-evil\"]\n");
    const s = f.run(["sync", grp, "--force", "--yes"]);
    expect({ asked: asked(s), removed: s.out.includes("снять своё"), trusted: codexTrusted(f.home, grp), evil: read(cfg).includes("colleague-evil") })
      .toEqual({ asked: false, removed: false, trusted: true, evil: false });
  }, 120000);
});
