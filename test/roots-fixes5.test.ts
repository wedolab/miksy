// Фаза 0.2.0, исправления после пятой проверки (out/phase-roots-fixes5.md):
// B.1 — доверие Claude не «качается» от ответов пользователя в окне Claude (.claude/settings.local.json); прежние «да»
// работают без нового вопроса; граница доверия — чужая исполняемая настройка без решения пользователя доверия не получает.
// B.2 — после «забыть» учёт помнит только факт «проект забыт» (и ставил ли miksy доверие Claude); «больше не нужен —
// убрать по уликам» — только в таких проектах: в общей облачной папке одна машина не трогает файлы другой.
// Тесты рецензента 6w (out/check6w/miksy/test/review6x*.test.ts) и проверка основного агента (zz-swing) — здесь,
// ожидания — по требованиям круга
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { cliFixture, put } from "./helpers";
import { git, inProcess, ledger, read, rootsFixture, yamlRoots } from "./rootshelp";
import { applyMoves } from "../src/relocate";

// git — песочное окружение (test/guard.ts отдаёт его и запуску без env); системный конфиг выключен
const genv = () => ({ ...process.env, GIT_CONFIG_NOSYSTEM: "1" });
const status = (dir: string) => Bun.spawnSync(["git", "-C", dir, "status", "--porcelain", "--untracked-files=all"], { env: genv() }).stdout.toString();
const statusIgnored = (dir: string) => Bun.spawnSync(["git", "-C", dir, "status", "--porcelain", "--untracked-files=all", "--ignored"], { env: genv() }).stdout.toString();
const gitc = (dir: string, ...args: string[]) => Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { env: genv() });
// Диск «отключён»: каталог корня пуст, в учёте есть его цели — корень недоступен
const unplug = (dir: string) => { renameSync(dir, `${dir}-disk`); mkdirSync(dir); };
const plugBack = (dir: string) => { rmSync(dir, { recursive: true }); renameSync(`${dir}-disk`, dir); };
const local = (dir: string) => JSON.parse(read(`${dir}/.claude/settings.local.json`) || "{}");
const exclude = (dir: string) => read(`${dir}/.git/info/exclude`);
// Командный .mcp.json (в git)
const team = (app: string) => {
  put(`${app}/.mcp.json`, JSON.stringify({ mcpServers: { team: { command: "team-server" } } }));
  gitc(app, "add", ".mcp.json");
  gitc(app, "commit", "-qm", "team");
};
// Пользователь в окне Claude ответил «да, больше не спрашивать» — Claude дописал разрешение в settings.local.json
const allowInClaude = (app: string, rule = "Bash(ls:*)") => {
  const doc = local(app);
  put(`${app}/.claude/settings.local.json`, JSON.stringify({ ...doc, permissions: { ...doc.permissions, allow: [...(doc.permissions?.allow ?? []), rule] } }, null, 2));
};
const trusted = (home: string, app: string) => {
  const doc = JSON.parse(read(`${home}/.claude.json`) || "{}");
  return Object.entries(doc.projects ?? {}).some(([k, v]) => k.toLowerCase() === app.toLowerCase() && (v as { hasTrustDialogAccepted?: boolean }).hasTrustDialogAccepted === true);
};
const codexTrusted = (home: string) => /trust_level = "trusted"/.test(read(`${home}/.codex/config.toml`));
const asked = (r: { out: string }) => r.out.includes("Нужно решение");
const swing = (r: { out: string }) => ({ ask: asked(r), removed: r.out.includes("снимается") });
const STEADY = { ask: false, removed: false };
// Отметки «проект забыт» в учёте этой машины: цель (агент|путь, без учёта регистра) → что помнится
const marks = (config: string) => Object.fromEntries(Object.entries((ledger(config) as { forgotten?: Record<string, unknown> }).forgotten ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
const id = (agent: string, dir: string) => `${agent}|${dir}`.toLowerCase();
// «Забыть» при отключённом диске, затем диск вернулся
const forgetAway = (f: { run: (a: string[]) => { code: number | null; out: string } }, root: string, app: string) => {
  unplug(root);
  const c = f.run(["clean", app, "--forget"]);
  expect(c.code).toBe(0);
  plugBack(root);
  return c;
};

// Проект Acme/app во втором корне (Archive); правила проекта — из layers/tree/instructions
const archiveFixture = (agents: string[]) => {
  const f = cliFixture({ agents, projects: ["Org/p1"] });
  const archive = `${f.dir}/archive`, app = `${archive}/Acme/app`;
  git(app);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: archive, tree: "Archive" }])}agents: [${agents.join(", ")}]\n`);
  return { ...f, archive, app };
};
const shellWords = (cmd: string) => cmd.match(/"[^"]*"|\S+/g)!.map((a) => a.replace(/^"|"$/g, ""));
// Все файлы каталога (кроме .git)
const files = (dir: string, rel = ""): string[] => !existsSync(dir) ? [] : readdirSync(dir).flatMap((n) => {
  if (n === ".git") return [];
  const p = `${dir}/${n}`;
  return statSync(p).isDirectory() ? files(p, `${rel}${n}/`) : [`${rel}${n}`];
});
const targetsUnder = (config: string, dir: string) => Object.keys(ledger(config).targets).filter((k) => k.toLowerCase().includes(dir.toLowerCase()));
// Строки действий в выводе (без заголовков целей и предупреждений)
const changed = (out: string) => out.split(/\r?\n/).filter((l) => /^ {2}\S/.test(l) && !/^ {2}предупреждение/.test(l));

describe("B.1: ответы пользователя в окне Claude и доверие (рецензия 6w, п. 1)", () => {
  test("H1: «да» пользователя (trust --confirm), затем «всегда разрешать» в Claude; «забыть» → диск вернулся → sync: одобрения берутся, вопроса нет, git файл не видит", () => {
    const f = rootsFixture(["claude"]);
    const app = `${f.archive}/Acme/app`;
    team(app);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(f.run(["trust", app, "--confirm"]).code).toBe(0);
    allowInClaude(app);
    const before = f.run(["sync", app]);
    expect({ ask: asked(before), trusted: trusted(f.home, app), approvals: local(app).enabledMcpjsonServers, git: status(app) })
      .toEqual({ ask: false, trusted: true, approvals: ["team"], git: "" });
    forgetAway(f, f.archive, app);
    const s = f.run(["sync", app]);
    expect({ ask: asked(s), regained: s.out.includes("одобрения miksy, которых не было в учёте"), trusted: trusted(f.home, app), git: status(app) })
      .toEqual({ ask: false, regained: true, trusted: true, git: "" });
  }, 120000);

  test("H1b: то же — после возвращения диска sync без вопроса, и три следующих — без вопроса и без снятия доверия", () => {
    const f = rootsFixture(["claude"]);
    const app = `${f.archive}/Acme/app`;
    team(app);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(f.run(["trust", app, "--confirm"]).code).toBe(0);
    allowInClaude(app);
    expect(asked(f.run(["sync", app]))).toBe(false);
    forgetAway(f, f.archive, app);
    const runs = [f.run(["sync", app]), f.run(["sync", app]), f.run(["sync", app]), f.run(["sync", app])];
    expect(runs.map(swing)).toEqual([STEADY, STEADY, STEADY, STEADY]);
    expect({ trusted: trusted(f.home, app), approvals: local(app).enabledMcpjsonServers, git: status(app) }).toEqual({ trusted: true, approvals: ["team"], git: "" });
  }, 120000);

  test("H1c: проект без командных настроек (без .mcp.json), «всегда разрешать» в Claude; «забыть» → диск вернулся → sync: доверие Claude возвращается без вопроса", () => {
    const f = rootsFixture(["claude"]);
    const app = `${f.archive}/Acme/app`;
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(trusted(f.home, app)).toBe(true);
    allowInClaude(app);
    expect(asked(f.run(["sync", app]))).toBe(false);
    forgetAway(f, f.archive, app);
    const s = f.run(["sync", app]);
    expect({ ask: asked(s), trusted: trusted(f.home, app) }).toEqual({ ask: false, trusted: true });
  }, 120000);

  test("H2: без «забыть» — settings.local.json с ответами в диалогах был до miksy, «да» пользователя: следующие sync не спрашивают снова и доверие не снимают", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const app = `${f.ws}/Org/p1`;
    team(app);
    allowInClaude(app);
    expect(asked(f.run(["sync", app]))).toBe(true);
    expect(f.run(["trust", app, "--confirm"]).code).toBe(0);
    const runs = [f.run(["sync", app]), f.run(["sync", app]), f.run(["sync", app])];
    expect(runs.map(swing)).toEqual([STEADY, STEADY, STEADY]);
    expect(trusted(f.home, app)).toBe(true);
  }, 120000);

  // Проверка основного агента (out/verify6w/miksy/test/zz-swing.test.ts): так бывает в жизни
  test("доверие miksy → ответы в Claude → команда добавила .mcp.json → вопрос → «да» → четыре sync подряд без вопроса и без «снимается», доверие стоит", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const app = `${f.ws}/Org/p1`;
    expect(f.run(["sync", app]).code).toBe(0);
    expect(trusted(f.home, app)).toBe(true);
    allowInClaude(app);
    expect(swing(f.run(["sync", app]))).toEqual(STEADY);
    team(app);
    const q = f.run(["sync", app]);
    // В вопросе — только изменения команды: ответы пользователя в окне Claude — его (доверие ставил miksy)
    expect({ ask: asked(q), mcp: q.out.includes(".mcp.json: MCP team"), allow: q.out.includes("разрешено без вопроса") }).toEqual({ ask: true, mcp: true, allow: false });
    // Тот же вопрос и после того, как доверие снято: ответы Claude по-прежнему не в нём
    const again = f.run(["sync", app]);
    expect({ ask: asked(again), allow: again.out.includes("разрешено без вопроса") }).toEqual({ ask: true, allow: false });
    expect(f.run(["trust", app, "--confirm"]).code).toBe(0);
    const runs = [1, 2, 3, 4].map(() => f.run(["sync", app]));
    expect(runs.map(swing)).toEqual([STEADY, STEADY, STEADY, STEADY]);
    expect({ trusted: trusted(f.home, app), approvals: local(app).enabledMcpjsonServers }).toEqual({ trusted: true, approvals: ["team"] });
  }, 120000);

  test("решение, сохранённое прежним расчётом (с ответами Claude в отпечатке), работает без нового вопроса и переносится на новый расчёт", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const app = `${f.ws}/Org/p1`;
    team(app);
    allowInClaude(app);
    // Отпечаток 0.1.1 и прежних кругов, когда доверие ставил не miksy: ответы Claude входили в него
    const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon)
      : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v);
    const fp = (data: unknown) => "v2:" + createHash("sha256").update(JSON.stringify(canon(data))).digest("hex");
    const servers = { team: { command: "team-server" } };
    const old = fp([[".claude/settings.local.json", { permissions: { allow: ["Bash(ls:*)"] } }], [".mcp.json", servers]]);
    put(`${f.config}/local/trust.json`, JSON.stringify({ version: 1, decisions: { [app]: { rel: "Org/p1", claude: { answer: "yes", fingerprint: old, date: "2026-11-01" }, mcpjson: { answer: "yes", fingerprint: fp([[".mcp.json", servers]]), date: "2026-11-01" } } } }, null, 2));
    const s = f.run(["sync", app]);
    expect({ ask: asked(s), trusted: trusted(f.home, app), approvals: local(app).enabledMcpjsonServers }).toEqual({ ask: false, trusted: true, approvals: ["team"] });
    // Перенесено на новый расчёт: отпечаток — без ответов Claude
    const saved = JSON.parse(read(`${f.config}/local/trust.json`)).decisions;
    const entry = Object.entries<any>(saved).find(([k]) => k.toLowerCase() === app.toLowerCase())![1];
    expect(entry.claude).toEqual({ answer: "yes", fingerprint: fp([[".mcp.json", servers]]), date: "2026-11-01" });
    // Пользователь ответил Claude ещё раз — вопроса нет, доверие стоит
    allowInClaude(app, "Bash(cat:*)");
    const runs = [1, 2, 3].map(() => f.run(["sync", app]));
    expect(runs.map(swing)).toEqual([STEADY, STEADY, STEADY]);
    expect(trusted(f.home, app)).toBe(true);
  }, 120000);

  test("решение, сохранённое прежним расчётом при доверии miksy (ответы Claude не в отпечатке), работает без нового вопроса и без доверия miksy", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const app = `${f.ws}/Org/p1`;
    team(app);
    allowInClaude(app);
    const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon)
      : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v);
    const fp = (data: unknown) => "v2:" + createHash("sha256").update(JSON.stringify(canon(data))).digest("hex");
    const servers = { team: { command: "team-server" } };
    put(`${f.config}/local/trust.json`, JSON.stringify({ version: 1, decisions: { [app]: { rel: "Org/p1", claude: { answer: "yes", fingerprint: fp([[".mcp.json", servers]]), date: "2026-11-01" } } } }, null, 2));
    const runs = [1, 2, 3].map(() => f.run(["sync", app]));
    expect(runs.map(swing)).toEqual([STEADY, STEADY, STEADY]);
    expect({ trusted: trusted(f.home, app), approvals: local(app).enabledMcpjsonServers }).toEqual({ trusted: true, approvals: ["team"] });
  }, 120000);

  test("граница: папка, которой miksy не доверял, пользователь не подтверждал и слоя нет, — ответы Claude в вопросе; после «да» без качелей; хук после «да» — снова решение, доверие снимается", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const app = `${f.ws}/Org/p1`;
    allowInClaude(app);
    const s1 = f.run(["sync", app]);
    expect({ ask: asked(s1), allow: s1.out.includes("разрешено без вопроса"), trusted: trusted(f.home, app) }).toEqual({ ask: true, allow: true, trusted: false });
    // Вопрос не меняется от запуска к запуску (один вопрос)
    const s2 = f.run(["sync", app]);
    expect({ ask: asked(s2), allow: s2.out.includes("разрешено без вопроса") }).toEqual({ ask: true, allow: true });
    expect(f.run(["trust", app, "--confirm"]).code).toBe(0);
    const runs = [1, 2, 3].map(() => f.run(["sync", app]));
    expect(runs.map(swing)).toEqual([STEADY, STEADY, STEADY]);
    expect(trusted(f.home, app)).toBe(true);
    // Новые ответы в окне Claude после «да» — свои пользователя
    allowInClaude(app, "Bash(cat:*)");
    expect(swing(f.run(["sync", app]))).toEqual(STEADY);
    // Хук — не ответ в диалоге Claude: исполняемая настройка требует решения; в вопросе — только она
    put(`${app}/.claude/settings.local.json`, JSON.stringify({ ...local(app), hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "evil.sh" }] }] } }, null, 2));
    const h = f.run(["sync", app]);
    expect({ ask: asked(h), hook: h.out.includes("evil.sh"), allow: h.out.includes("разрешено без вопроса"), removed: h.out.includes("снимается"), trusted: trusted(f.home, app) })
      .toEqual({ ask: true, hook: true, allow: false, removed: true, trusted: false });
  }, 120000);

  test("граница: «ответы Claude» в отслеживаемом git settings.local.json — настройки команды: в вопросе, доверие miksy снимается", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const app = `${f.ws}/Org/p1`;
    expect(f.run(["sync", app]).code).toBe(0);
    expect(trusted(f.home, app)).toBe(true);
    allowInClaude(app, "Bash(rm:*)");
    gitc(app, "add", "-f", ".claude/settings.local.json");
    gitc(app, "commit", "-qm", "team settings");
    const s = f.run(["sync", app]);
    expect({ ask: asked(s), allow: s.out.includes("Bash(rm:*)"), removed: s.out.includes("снимается"), trusted: trusted(f.home, app) }).toEqual({ ask: true, allow: true, removed: true, trusted: false });
  }, 120000);

  test("trust: false в слое и в machine.yaml — окончательно и для забытого проекта, которому miksy доверял: доверия нет, одобрения не берутся", () => {
    const f = rootsFixture(["claude"]);
    const app = `${f.archive}/Acme/app`;
    team(app);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(f.run(["trust", app, "--confirm"]).code).toBe(0);
    allowInClaude(app);
    expect(asked(f.run(["sync", app]))).toBe(false);
    forgetAway(f, f.archive, app);
    put(`${f.config}/layers/tree/Archive/layer.yaml`, "trust: { claude: false }\n");
    const s = f.run(["sync", app]);
    expect({ trusted: trusted(f.home, app), regained: s.out.includes("одобрения miksy"), ask: asked(s) }).toEqual({ trusted: false, regained: false, ask: false });
    rmSync(`${f.config}/layers/tree/Archive/layer.yaml`);
    put(`${f.config}/local/machine.yaml`, read(`${f.config}/local/machine.yaml`).replace("agents: [claude]", "agents: [claude]\ntrust: { claude: false }"));
    const m = f.run(["sync", app]);
    expect({ trusted: trusted(f.home, app), regained: m.out.includes("одобрения miksy"), ask: asked(m) }).toEqual({ trusted: false, regained: false, ask: false });
  }, 120000);

  test("trust: true в слое — ответы Claude свои: вопроса нет, доверие стоит, одобрения на месте", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const app = `${f.ws}/Org/p1`;
    put(`${f.config}/layers/tree/Org/layer.yaml`, "trust: { claude: true }\n");
    team(app);
    allowInClaude(app);
    const runs = [1, 2, 3].map(() => f.run(["sync", app]));
    expect(runs.map(swing)).toEqual([STEADY, STEADY, STEADY]);
    expect({ trusted: trusted(f.home, app), approvals: local(app).enabledMcpjsonServers }).toEqual({ trusted: true, approvals: ["team"] });
  }, 120000);

  test("G1: чужой .codex/config.toml с шапкой miksy (не под строкой exclude) в проекте с доверием miksy — доверие снимается, нужен ответ пользователя", () => {
    const f = cliFixture({ agents: ["codex"], projects: ["Org/p1"] });
    const p1 = `${f.ws}/Org/p1`;
    expect(f.run(["sync", p1]).code).toBe(0);
    expect(codexTrusted(f.home)).toBe(true);
    const evil = "# Сгенерировано miksy. Не править вручную — изменения вносить в конфигурацию miksy (слои).\n[mcp_servers.evil]\ncommand = \"evil.exe\"\nargs = []\n";
    put(`${p1}/.codex/config.toml`, evil);
    const s = f.run(["sync", p1]);
    expect({ trusted: codexTrusted(f.home), ask: asked(s), out: s.out.includes("КОНФЛИКТ") }).toEqual({ trusted: false, ask: true, out: true });
  }, 120000);

  test("G2: свежий проект, чужой .codex/config.toml с шапкой miksy — sync: конфликт, доверия нет (вопроса нет); --force: файл miksy, доверие", () => {
    const f = cliFixture({ agents: ["codex"], projects: ["Org/p1"] });
    const p1 = `${f.ws}/Org/p1`;
    const evil = "# Сгенерировано miksy. Не править вручную — изменения вносить в конфигурацию miksy (слои).\n[mcp_servers.evil]\ncommand = \"evil.exe\"\nargs = []\n";
    put(`${p1}/.codex/config.toml`, evil);
    const s = f.run(["sync", p1]);
    expect({ trusted: codexTrusted(f.home), conflict: s.out.includes("КОНФЛИКТ"), ask: asked(s) }).toEqual({ trusted: false, conflict: true, ask: false });
    expect(f.run(["sync", p1, "--force"]).code).toBe(0);
    expect({ trusted: codexTrusted(f.home), evil: read(`${p1}/.codex/config.toml`).includes("evil") }).toEqual({ trusted: true, evil: false });
  }, 120000);
});

describe("B.2: отметка «проект забыт» и файлы miksy без учёта (рецензия 6w, п. 2)", () => {
  test("облачная папка на двух машинах: машина B файл машины A не удаляет и строку exclude не снимает, A не пишет его заново", () => {
    const f = cliFixture({ agents: ["codex"], projects: ["Org/p1"] });
    const p1 = `${f.ws}/Org/p1`;
    // Правила проекта — только глобальные; у проекта — MCP-сервер, программа которого задана переменной машины
    rmSync(`${f.config}/layers/tree/instructions`, { recursive: true });
    put(`${f.config}/layers/tree/Org/mcp/tool.yaml`, "name: tool\ncommand: ${TOOL}\nargs: []\n");
    const yamlA = `workspace: ${f.ws}\nagents: [codex]\nvars:\n  TOOL: "C:/tools/tool.exe"\n`;
    const yamlB = `workspace: ${f.ws}\nagents: [codex]\n`;
    const manifest = `${f.config}/local/state/manifest.json`;
    // Машина A
    put(`${f.config}/local/machine.yaml`, yamlA);
    expect(f.run(["sync", p1]).code).toBe(0);
    expect(read(`${p1}/.codex/config.toml`)).toContain("tool.exe");
    const ledgerA = read(manifest);
    const exA = exclude(p1);
    // Машина B: своя конфигурация (тот же репо слоёв), свой учёт — без записей об этом проекте, переменной TOOL нет
    put(`${f.config}/local/machine.yaml`, yamlB);
    rmSync(manifest);
    rmSync(`${manifest}.bak`, { force: true });
    const b = f.run(["sync", p1]);
    const deletedByB = !existsSync(`${p1}/.codex/config.toml`);
    const exB = exclude(p1);
    const cleanB = f.run(["clean", p1]);
    const afterCleanB = { file: existsSync(`${p1}/.codex/config.toml`), exclude: exclude(p1) === exA };
    // Снова машина A
    put(`${f.config}/local/machine.yaml`, yamlA);
    put(manifest, ledgerA);
    const a = f.run(["sync", p1]);
    expect({ deletedByB, bSays: b.out.includes("больше не нужен"), exB: exB === exA, cleanB: cleanB.out.includes("больше не нужен"), afterCleanB, aRecreates: a.out.includes("записать (новый)"), aChanged: changed(a.out), git: status(p1) })
      .toEqual({ deletedByB: false, bSays: false, exB: true, cleanB: false, afterCleanB: { file: true, exclude: true }, aRecreates: false, aChanged: [], git: "" });
  }, 120000);

  test("проект без «забыть»: файл miksy под точной строкой, которого нет в учёте и который miksy не пишет, — sync и clean его не трогают", () => {
    const f = cliFixture({ agents: ["codex"], projects: ["Org/p1"] });
    const p1 = `${f.ws}/Org/p1`;
    expect(f.run(["sync", p1]).code).toBe(0);
    const text = read(`${p1}/.codex/config.toml`);
    expect(text).toContain("Сгенерировано miksy");
    expect(exclude(p1)).toContain("/.codex/config.toml");
    // Учёт этой цели потерян без «забыть» (другая машина, своя конфигурация); правила убраны из слоёв
    const m = ledger(f.config);
    m.targets = Object.fromEntries(Object.entries(m.targets).filter(([k]) => !k.startsWith("codex|") || k.endsWith("|global")));
    put(`${f.config}/local/state/manifest.json`, JSON.stringify(m, null, 2));
    rmSync(`${f.config}/layers/tree/instructions`, { recursive: true });
    const s = f.run(["sync", p1]);
    const c = f.run(["clean", p1]);
    expect({ sync: s.out.includes("больше не нужен"), clean: c.out.includes("больше не нужен"), file: read(`${p1}/.codex/config.toml`) === text, line: exclude(p1).includes("/.codex/config.toml"), git: status(p1) })
      .toEqual({ sync: false, clean: false, file: true, line: true, git: "" });
  }, 120000);

  test("отметка: «забыть» запоминает только факт и доверие Claude (без файлов и хешей), --dry-run её не ставит; первый sync после возвращения диска убирает ненужное и снимает её, повтор — «изменений нет»", () => {
    const f = archiveFixture(["claude", "codex"]);
    const app = f.app;
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect({ claude: trusted(f.home, app), codex: read(`${app}/.codex/config.toml`).includes("Сгенерировано miksy") }).toEqual({ claude: true, codex: true });
    unplug(f.archive);
    expect(f.run(["clean", app, "--forget", "--dry-run"]).code).toBe(0);
    expect(marks(f.config)).toEqual({});
    expect(f.run(["clean", app, "--forget"]).code).toBe(0);
    expect(marks(f.config)).toEqual({ [id("claude", app)]: { trusted: true }, [id("codex", app)]: {} });
    expect(targetsUnder(f.config, "/Acme/app")).toEqual([]);
    // Диск так и не вернулся — отметка остаётся
    f.run(["sync", "--all", "--yes"]);
    expect(Object.keys(marks(f.config)).length).toBe(2);
    plugBack(f.archive);
    // Пока диска не было, правила проекта убрали из слоёв: CLAUDE.local.md и .codex/config.toml больше не нужны
    rmSync(`${f.config}/layers/tree/instructions`, { recursive: true });
    // --dry-run отметку не снимает
    const dry = f.run(["sync", app, "--dry-run"]);
    expect({ gone: dry.out.includes("больше не нужен"), marks: Object.keys(marks(f.config)).length }).toEqual({ gone: true, marks: 2 });
    const s = f.run(["sync", app]);
    expect({ code: s.code, gone: s.out.includes("больше не нужен"), files: files(app), marks: marks(f.config), git: status(app) })
      .toEqual({ code: 0, gone: true, files: [], marks: {}, git: "" });
    expect(changed(f.run(["sync", app]).out)).toEqual([]);
  }, 180000);

  test("отметка: clean после возвращения диска (без sync) убирает ненужное по уликам и снимает отметку; повторный clean — «изменений нет»", () => {
    const f = archiveFixture(["claude", "codex"]);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    forgetAway(f, f.archive, f.app);
    expect(Object.keys(marks(f.config)).length).toBe(2);
    const dry = f.run(["clean", f.app, "--dry-run"]);
    expect(Object.keys(marks(f.config)).length).toBe(2);
    const c = f.run(["clean", f.app]);
    expect({ code: c.code, gone: c.out.includes("больше не нужен"), same: dry.out.includes("больше не нужен"), files: files(f.app), marks: marks(f.config), git: status(f.app) })
      .toEqual({ code: 0, gone: true, same: true, files: [], marks: {}, git: "" });
    expect(changed(f.run(["clean", f.app]).out)).toEqual([]);
  }, 180000);

  test("root remove --forget → root add → sync --all по подсказкам: ненужное убрано, отметки сняты, повторный sync --all — без изменений", () => {
    const f = archiveFixture(["claude", "codex"]);
    const app = f.app;
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    unplug(f.archive);
    const r = f.run(["root", "remove", f.archive, "--forget"]);
    expect(r.code).toBe(0);
    expect(Object.keys(marks(f.config)).length).toBe(2);
    const add = r.out.match(/верните папку корнем — (miksy root add "[^"]+" --tree (?:"[^"]+"|\S+));/)?.[1] ?? "";
    const then = r.out.match(/затем (miksy sync --all)/)?.[1] ?? "";
    expect({ add: add !== "", then }).toEqual({ add: true, then: "miksy sync --all" });
    // Пока диска не было, правила проекта убрали из слоёв
    rmSync(`${f.config}/layers/tree/instructions`, { recursive: true });
    plugBack(f.archive);
    expect(f.run(shellWords(add).slice(1)).code).toBe(0);
    const s = f.run([...shellWords(then).slice(1), "--yes"]);
    expect({ code: s.code, conflict: s.out.includes("КОНФЛИКТ"), gone: s.out.includes("больше не нужен"), files: files(app), marks: marks(f.config), git: status(app) })
      .toEqual({ code: 0, conflict: false, gone: true, files: [], marks: {}, git: "" });
    // Повтор — без действий (строка «новые — miksy в них ещё не писал» — список, не действие)
    expect(changed(f.run(["sync", "--all", "--yes"]).out).filter((l) => !/^ {2}новые — /.test(l))).toEqual([]);
  }, 240000);
});

// Находки рецензента этого круга (out/review6x/miksy/test/review6x-r1.test.ts)
describe("рецензия круга 6x", () => {
  test("R1: «да» в терминале sync (а не trust --confirm) после изменения команды — четыре sync без вопроса", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const app = `${f.ws}/Org/p1`;
    expect(f.run(["sync", app]).code).toBe(0);
    allowInClaude(app);
    team(app);
    const q = inProcess(f, ["sync", app], f.dir, ["y"]);
    expect({ code: q.code, err: q.err, questions: q.questions.length }).toEqual({ code: 0, err: "", questions: 1 });
    const runs = [1, 2, 3, 4].map(() => f.run(["sync", app]));
    expect(runs.map(swing)).toEqual([STEADY, STEADY, STEADY, STEADY]);
    expect(trusted(f.home, app)).toBe(true);
  }, 120000);

  test("п. 3 (R2): clean, который до проекта не дошёл (диска всё ещё нет), отметку «забыт» не снимает", () => {
    const f = rootsFixture(["claude"]);
    const app = `${f.archive}/Acme/app`;
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    unplug(f.archive);
    // При «забыть» ближняя часть — конфликт (битый ~/.claude.json): цель остаётся в учёте с ближними записями
    const good = read(`${f.home}/.claude.json`);
    put(`${f.home}/.claude.json`, good.slice(0, -5));
    f.run(["clean", app, "--forget"]);
    expect(Object.keys(marks(f.config))).toEqual([id("claude", app)]);
    put(`${f.home}/.claude.json`, good);
    f.run(["clean", app]);
    expect(Object.keys(marks(f.config))).toEqual([id("claude", app)]);
    plugBack(f.archive);
    rmSync(`${f.config}/layers/tree/instructions`, { recursive: true });
    rmSync(`${f.config}/layers/acme/instructions`, { recursive: true });
    rmSync(`${f.config}/layers/tree/mcp`, { recursive: true });
    const s = f.run(["sync", app]);
    expect({ gone: s.out.includes("больше не нужен"), marks: marks(f.config) }).toEqual({ gone: true, marks: {} });
  }, 120000);

  test("п. 4 (R5): учёт прежней версии без everTrusted, trust --deny, затем trust --confirm — ответов Claude нет в списке", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const app = `${f.ws}/Org/p1`;
    expect(f.run(["sync", app]).code).toBe(0);
    allowInClaude(app);
    const m = ledger(f.config);
    for (const t of Object.values(m.targets)) delete (t as { everTrusted?: true }).everTrusted;
    put(`${f.config}/local/state/manifest.json`, JSON.stringify(m, null, 2));
    expect(asked(f.run(["sync", app]))).toBe(false);
    team(app);
    const d = f.run(["trust", app, "--deny"]);
    const c = f.run(["trust", app, "--confirm"]);
    expect({ deny: d.out.includes("разрешено без вопроса"), confirm: c.out.includes("разрешено без вопроса") }).toEqual({ deny: false, confirm: false });
  }, 120000);

  test("п. 6: отметка агента, которого убрали из agents, снимается вместе с отметкой каталога; пустых отметок в учёте нет", () => {
    const f = archiveFixture(["claude", "codex"]);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    forgetAway(f, f.archive, f.app);
    expect(Object.keys(marks(f.config)).length).toBe(2);
    put(`${f.config}/local/machine.yaml`, read(`${f.config}/local/machine.yaml`).replace("agents: [claude, codex]", "agents: [claude]"));
    expect(f.run(["sync", f.app]).code).toBe(0);
    expect("forgotten" in ledger(f.config)).toBe(false);
  }, 120000);

  test("п. 6: отметка «проект забыт» переезжает вместе с каталогом (applyMoves)", () => {
    const f = cliFixture({ projects: ["Org/p1"] });
    const from = `${f.dir}/old`, to = `${f.dir}/new`;
    mkdirSync(`${to}/Org/p1`, { recursive: true });
    const out = applyMoves({ version: 1, targets: {}, forgotten: { [`claude|${from}/Org/p1`]: { trusted: true } } }, [{ from, to, how: "parent" }]);
    expect(Object.entries(out.forgotten ?? {}).map(([k, v]) => [k.toLowerCase(), v])).toEqual([[id("claude", `${to}/Org/p1`), { trusted: true }]]);
  });
});

// Проверки рецензента 6w без находок (out/check6w/miksy/test/review6x.test.ts, review6x-drive.test.ts): подсказки
// после «забыть» дословно, план --dry-run против настоящего запуска, повтор — «изменений нет». С отметкой «проект
// забыт» они проверяют и её: ставится, работает, снимается
const SKILL = "---\nname: sk\ndescription: d\n---\nbody\n";
const ALL = ["claude", "codex", "opencode", "antigravity"];

describe("рецензия 6w без находок: подсказки дословно, все четыре агента", () => {
  test("A: clean без «забыть» при отключённом диске → диск вернулся → «повторите miksy clean …» дословно → ничего от miksy", () => {
    const f = rootsFixture(ALL);
    const app = `${f.archive}/Acme/app`;
    put(`${f.config}/layers/tree/Archive/skills/sk/SKILL.md`, SKILL);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    const before = files(app);
    unplug(f.archive);
    const c = f.run(["clean", app]);
    const hint = c.out.match(/подключите диск и повторите (miksy clean "[^"]+")/)?.[1] ?? "";
    expect(hint).not.toBe("");
    expect(marks(f.config)).toEqual({});
    plugBack(f.archive);
    const r = f.run(shellWords(hint).slice(1));
    const again = f.run(shellWords(hint).slice(1));
    expect({ code: r.code, before: before.length > 0, left: files(app), git: statusIgnored(app), ledger: targetsUnder(f.config, "/Acme/app"), again: again.out.includes("изменений нет") })
      .toEqual({ code: 0, before: true, left: [], git: "", ledger: [], again: true });
  }, 180000);

  test("B: clean --forget → диск вернулся → «miksy sync …», затем «miksy clean …» дословно → ничего от miksy, отметок нет", () => {
    const f = rootsFixture(ALL);
    const app = `${f.archive}/Acme/app`;
    put(`${f.config}/layers/tree/Archive/skills/sk/SKILL.md`, SKILL);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    unplug(f.archive);
    const c = f.run(["clean", app, "--forget"]);
    expect(c.code).toBe(0);
    const sync = c.out.match(/Если диск найдётся: (miksy sync "[^"]+")/)?.[1] ?? "";
    const clean = c.out.match(/после этого (miksy clean "[^"]+")/)?.[1] ?? "";
    expect({ sync, clean }).toEqual({ sync: `miksy sync "${app}"`, clean: `miksy clean "${app}"` });
    plugBack(f.archive);
    const s = f.run(shellWords(sync).slice(1));
    const k = f.run(shellWords(clean).slice(1));
    const again = f.run(shellWords(clean).slice(1));
    expect({ sync: s.code, clean: k.code, left: files(app), git: statusIgnored(app), ledger: targetsUnder(f.config, "/Acme/app"), again: again.out.includes("изменений нет"), marks: marks(f.config) })
      .toEqual({ sync: 0, clean: 0, left: [], git: "", ledger: [], again: true, marks: {} });
  }, 180000);

  test("C: root remove --forget → «root add …», «sync --all», затем «root remove …» без терминала и «miksy clean …» по списку → ничего от miksy", () => {
    const f = rootsFixture(ALL);
    const app = `${f.archive}/Acme/app`;
    put(`${f.config}/layers/tree/Archive/skills/sk/SKILL.md`, SKILL);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(f.run(["sync", "--global"]).code).toBe(0);
    unplug(f.archive);
    const r = f.run(["root", "remove", f.archive, "--forget"]);
    expect(r.code).toBe(0);
    const add = r.out.match(/верните папку корнем — (miksy root add "[^"]+" --tree (?:"[^"]+"|\S+));/)?.[1] ?? "";
    const then = r.out.match(/затем (miksy sync --all)/)?.[1] ?? "";
    const rm = r.out.match(/после этого (miksy root remove "[^"]+")/)?.[1] ?? "";
    expect({ add: add !== "", then, rm: rm !== "" }).toEqual({ add: true, then: "miksy sync --all", rm: true });
    plugBack(f.archive);
    expect(f.run(shellWords(add).slice(1)).code).toBe(0);
    const s = f.run([...shellWords(then).slice(1), "--yes"]);
    expect({ code: s.code, conflict: s.out.includes("КОНФЛИКТ") }).toEqual({ code: 0, conflict: false });
    const rr = f.run(shellWords(rm).slice(1));
    expect(rr.code).toBe(0);
    const cleans = [...rr.out.matchAll(/^\s+(miksy clean "[^"]+")$/gm)].map((m) => m[1]);
    expect(cleans.length).toBeGreaterThan(0);
    for (const k of cleans) expect(f.run(shellWords(k).slice(1)).code).toBe(0);
    const doc = f.run(["doctor"]);
    expect({ left: files(app), git: statusIgnored(app), ledger: targetsUnder(f.config, f.archive), problems: /Проблем: [1-9]/.test(doc.out) ? doc.out : "", marks: marks(f.config) })
      .toEqual({ left: [], git: "", ledger: [], problems: "", marks: {} });
  }, 240000);

  test("F1: «забыть» → диск вернулся → sync, sync — второй ничего не меняет (все агенты, skill, MCP)", () => {
    const f = rootsFixture(ALL);
    const app = `${f.archive}/Acme/app`;
    put(`${f.config}/layers/tree/Archive/skills/sk/SKILL.md`, SKILL);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    forgetAway(f, f.archive, app);
    const s1 = f.run(["sync", app]);
    const s2 = f.run(["sync", app]);
    const changed = s2.out.split(/\r?\n/).filter((l) => /^ {2}\S/.test(l) && !/^ {2}предупреждение/.test(l));
    expect({ s1: s1.code, conflict: s1.out.includes("КОНФЛИКТ"), changed, git: status(app) }).toEqual({ s1: 0, conflict: false, changed: [], git: "" });
  }, 180000);
});

describe("рецензия 6w без находок: план --dry-run против настоящего запуска", () => {
  // Строки действий целей (без заголовков, итогов и путей бэкапов)
  const actions = (out: string) => out.split(/\r?\n/).filter((l) => /^ {2}\S/.test(l) && !/Бэкапы|Готово|Проверка/.test(l)).map((l) => l.trim()).sort();

  test("D1: clean --forget --dry-run при отключённом диске — те же действия и итог, что у clean --forget", () => {
    const f = rootsFixture(["claude", "codex"]);
    const app = `${f.archive}/Acme/app`;
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    unplug(f.archive);
    const dry = f.run(["clean", app, "--forget", "--dry-run"]);
    const real = f.run(["clean", app, "--forget"]);
    expect({ dry: actions(dry.out), forget: dry.out.includes("будет забыто") }).toEqual({ dry: actions(real.out), forget: true });
  }, 120000);

  test("D2: clean цели без учёта (диск вернулся после «забыть») --dry-run — те же действия, что у clean", () => {
    const f = rootsFixture(["claude", "codex", "opencode"]);
    const app = `${f.archive}/Acme/app`;
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    forgetAway(f, f.archive, app);
    const dry = f.run(["clean", app, "--dry-run"]);
    const real = f.run(["clean", app]);
    expect(actions(dry.out)).toEqual(actions(real.out));
  }, 120000);
});

// Корень на корне диска, которого нет (Q:), — clean и root remove с путём в разных написаниях, «забыть»
const freeLetter = () => { for (const l of "QRSTUVWXYZPONMLKJIH") if (!existsSync(`${l}:/`)) return l; throw new Error("нет свободной буквы"); };
describe.skipIf(process.platform !== "win32")("рецензия 6w без находок: корень на корне диска, которого нет", () => {
  const setup = () => {
    const f = cliFixture({ projects: ["Org/p1"] });
    const L = freeLetter();
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: `${L}:`, tree: "Drive" }])}agents: [claude]\n`);
    const site = `${L}:/Acme/site`;
    const state = { files: { [`${site}/.claude/rules/miksy.md`]: "0".repeat(64) }, merges: {}, exclude: { [`${site}/.git/info/exclude`]: ["/.claude/rules/miksy.md"] }, blocks: { [`${site}/CLAUDE.local.md`]: "1".repeat(64) } };
    put(`${f.config}/local/state/manifest.json`, JSON.stringify({ version: 1, engine: "0.1.1", targets: { [`claude|${site}`]: state } }, null, 2));
    return { f, L, site };
  };

  test("root (список): корень недоступен — нет диска", () => {
    const { f, L } = setup();
    const r = inProcess(f, ["root"]);
    expect({ code: r.code, err: r.err, line: r.out.split("\n").find((l) => l.includes(`${L}:/`)) ?? "" }).toEqual({ code: 0, err: "", line: `  ${L}:/ → layers/tree/Drive  — недоступен (нет диска)` });
  });

  test("clean пути проекта в другом написании (q:\\acme\\SITE): записанное на диске остаётся в учёте, подсказка — путь учёта", () => {
    const { f, L, site } = setup();
    const r = inProcess(f, ["clean", `${L.toLowerCase()}:\\acme\\SITE`]);
    expect({ code: r.code, err: r.err, hint: r.out.includes(`miksy clean "${site}" --forget`), kept: Object.keys(ledger(f.config).targets), marks: marks(f.config) })
      .toEqual({ code: 0, err: "", hint: true, kept: [`claude|${site}`], marks: {} });
  });

  test("clean --forget, затем root remove Q: (без косой) и q:\\ — корень убран, учёт пуст, отметка «забыт» — только факт", () => {
    const { f, L, site } = setup();
    const c = inProcess(f, ["clean", `${site}/`, "--forget"]);
    expect({ code: c.code, err: c.err, forgot: c.out.includes("забыто"), left: Object.keys(ledger(f.config).targets), marks: marks(f.config) })
      .toEqual({ code: 0, err: "", forgot: true, left: [], marks: { [id("claude", site)]: {} } });
    const r = inProcess(f, ["root", "remove", `${L.toLowerCase()}:\\`]);
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
    expect(inProcess(f, ["root"]).out).not.toContain(`${L}:/`);
  });

  test("root remove Q: --forget --dry-run → план; затем root remove Q: --forget — подсказка root add с корнем диска", () => {
    const { f, L } = setup();
    const dry = inProcess(f, ["root", "remove", `${L}:`, "--forget", "--dry-run"]);
    expect(marks(f.config)).toEqual({});
    const r = inProcess(f, ["root", "remove", `${L}:`, "--forget"]);
    const add = r.out.match(/miksy root add "([^"]+)" --tree (\S+);/);
    expect({ dry: dry.code, dryErr: dry.err, code: r.code, err: r.err, add: add ? [add[1], add[2]] : null, left: Object.keys(ledger(f.config).targets) })
      .toEqual({ dry: 0, dryErr: "", code: 0, err: "", add: [`${L}:/`, "Drive"], left: [] });
  });
});
