// Выпуск 0.2.1, часть A (out/phase-021.md), доверие: A1 — после clean (и root remove с согласием убрать) ответы
// пользователя в окне Claude — его, вопроса о них нет, а чужие исполняемые настройки — в вопросе; A2 — «нет» доверию
// Claude отзывает и одобрение серверов .mcp.json; A3 — trust --confirm при trust: false называет запрет и где он.
// Тесты рецензентов: out/reviewer-tests/check6x-miksy/test/zz-review-trustpaths.test.ts (clean → sync, root remove →
// root add), out/reviewer-tests/check6z-miksy/test/zz-ra-deny.test.ts
import { describe, expect, test } from "bun:test";
import { cliFixture, put } from "./helpers";
import { git, inProcess, ledger, read } from "./rootshelp";

const gitc = (dir: string, ...args: string[]) => Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
const local = (dir: string) => JSON.parse(read(`${dir}/.claude/settings.local.json`) || "{}");
const allowInClaude = (app: string, rule = "Bash(ls:*)") => {
  const doc = local(app);
  put(`${app}/.claude/settings.local.json`, JSON.stringify({ ...doc, permissions: { ...doc.permissions, allow: [...(doc.permissions?.allow ?? []), rule] } }, null, 2));
};
const team = (app: string) => {
  put(`${app}/.mcp.json`, JSON.stringify({ mcpServers: { team: { command: "team-server" } } }));
  gitc(app, "add", ".mcp.json");
  gitc(app, "commit", "-qm", "team");
};
const trusted = (home: string, app: string) => Object.entries(JSON.parse(read(`${home}/.claude.json`) || "{}").projects ?? {})
  .some(([k, v]) => k.toLowerCase() === app.toLowerCase() && (v as { hasTrustDialogAccepted?: boolean }).hasTrustDialogAccepted === true);
const asked = (r: { out: string }) => r.out.includes("Нужно решение");
const swing = (r: { out: string }) => ({ ask: asked(r), removed: r.out.includes("снимается"), allow: r.out.includes("разрешено без вопроса") });
const STEADY = { ask: false, removed: false, allow: false };
const HOOK = (cmd: string) => ({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: cmd }] }] } });

describe("A1 — после clean ответы пользователя в окне Claude — его (zz-review-trustpaths)", () => {
  test("clean → sync: доверие ставил miksy, пользователь отвечал Claude «больше не спрашивать» — после clean и sync вопроса нет", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const app = `${f.ws}/Org/p1`;
    expect(f.run(["sync", app]).code).toBe(0);
    expect(trusted(f.home, app)).toBe(true);
    allowInClaude(app);
    expect(swing(f.run(["sync", app]))).toEqual(STEADY);
    expect(f.run(["clean", app]).code).toBe(0);
    // Учёт помнит только отметку о доверии: записей цели нет
    expect(Object.keys(ledger(f.config).targets).some((id) => id.toLowerCase().endsWith(app.toLowerCase()))).toBe(false);
    const s = f.run(["sync", app]);
    expect({ ...swing(s), trusted: trusted(f.home, app) }).toEqual({ ...STEADY, trusted: true });
    // Повторный clean → sync — так же (отметка ставится снова)
    expect(f.run(["clean", app]).code).toBe(0);
    expect({ ...swing(f.run(["sync", app])), trusted: trusted(f.home, app) }).toEqual({ ...STEADY, trusted: true });
  }, 120000);

  test("root remove (с согласием убрать) → root add → sync --all (рецепт отката и возврата README): проекты корня с ответами Claude — без вопроса", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const drive = `${f.dir}/drive`, site = `${drive}/Acme/site`;
    git(site);
    expect(f.run(["root", "add", drive, "--tree", "Clients"]).code).toBe(0);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(trusted(f.home, site)).toBe(true);
    allowInClaude(site);
    expect(swing(f.run(["sync", "--all", "--yes"]))).toEqual(STEADY);
    const rm = inProcess(f, ["root", "remove", drive], f.dir, [true]);
    expect(rm.err).toBe("");
    expect(f.run(["root", "add", drive, "--tree", "Clients"]).code).toBe(0);
    const s = f.run(["sync", "--all", "--yes"]);
    expect({ ...swing(s), trusted: trusted(f.home, site) }).toEqual({ ...STEADY, trusted: true });
  }, 120000);

  test("clean → команда добавила хук: вопрос — только о хуке (ответы Claude — не в нём), доверия до решения нет", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const app = `${f.ws}/Org/p1`;
    f.run(["sync", app]);
    allowInClaude(app);
    expect(f.run(["clean", app]).code).toBe(0);
    put(`${app}/.claude/settings.json`, JSON.stringify(HOOK("team-hook.sh")));
    gitc(app, "add", ".claude/settings.json");
    gitc(app, "commit", "-qm", "hook");
    const s = f.run(["sync", app]);
    expect({ ask: asked(s), hook: s.out.includes("team-hook.sh"), allow: s.out.includes("разрешено без вопроса"), trusted: trusted(f.home, app) })
      .toEqual({ ask: true, hook: true, allow: false, trusted: false });
    // doctor — так же: вопрос о хуке, без ответов Claude
    const d = f.run(["doctor"]);
    expect({ hook: d.out.includes("team-hook.sh"), allow: d.out.includes("разрешено без вопроса") }).toEqual({ hook: true, allow: false });
  }, 120000);

  test("цель без git (папка, общая с коллегой): после clean свои ответы Claude — без вопроса; хук коллеги в settings.local.json — в вопросе", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    put(`${f.config}/layers/tree/Shared/layer.yaml`, "target: true\n");
    put(`${f.config}/layers/tree/Shared/instructions/10.md`, "# shared\n");
    const grp = `${f.ws}/Shared`;
    put(`${grp}/notes.md`, "x\n");
    expect(asked(f.run(["sync", "--all", "--yes"]))).toBe(false);
    expect(trusted(f.home, grp)).toBe(true);
    allowInClaude(grp);
    expect(f.run(["clean", grp]).code).toBe(0);
    const s = f.run(["sync", "--all", "--yes"]);
    expect({ ...swing(s), trusted: trusted(f.home, grp) }).toEqual({ ...STEADY, trusted: true });
    // Коллега дописал хук в тот же файл; clean → sync: вопрос о хуке, ответы Claude — не в нём
    put(`${grp}/.claude/settings.local.json`, JSON.stringify({ ...local(grp), ...HOOK("colleague.sh") }, null, 2));
    expect(f.run(["clean", grp]).code).toBe(0);
    const q = f.run(["sync", "--all", "--yes"]);
    expect({ ask: asked(q), hook: q.out.includes("colleague.sh"), allow: q.out.includes("разрешено без вопроса"), trusted: trusted(f.home, grp) })
      .toEqual({ ask: true, hook: true, allow: false, trusted: false });
  }, 120000);

  test("miksy не доверял (пользователь отказал), clean → sync: ответов Claude отметка не делает своими — отказ остаётся, вопроса нет", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const app = `${f.ws}/Org/p1`;
    team(app);
    expect(inProcess(f, ["sync", app], f.dir, ["n"]).questions.length).toBe(1);
    expect(trusted(f.home, app)).toBe(false);
    expect(f.run(["clean", app]).code).toBe(0);
    expect((ledger(f.config) as { trustedBefore?: Record<string, string> }).trustedBefore ?? {}).toEqual({});
    const s = f.run(["sync", app]);
    expect({ ask: asked(s), trusted: trusted(f.home, app) }).toEqual({ ask: false, trusted: false });
  }, 120000);
});

describe("A2 — «нет» доверию Claude отзывает одобрение серверов .mcp.json (zz-ra-deny)", () => {
  const setup = () => {
    const f = cliFixture({ projects: ["Org/p1"] });
    const p = `${f.ws}/Org/p1`;
    put(`${p}/.mcp.json`, JSON.stringify({ mcpServers: { team: { command: "echo", args: ["t"] } } }));
    gitc(p, "add", ".mcp.json");
    gitc(p, "commit", "-qm", "team");
    expect(inProcess(f, ["sync", p], f.dir, ["y"]).questions.length).toBe(1);
    expect(read(`${p}/.claude/settings.local.json`)).toContain("team");
    return { f, p };
  };
  // Пользователь сам принял доверие в окне Claude
  const acceptInClaude = (home: string, p: string) => {
    const cj = JSON.parse(read(`${home}/.claude.json`));
    cj.projects ??= {};
    cj.projects[p] = { ...(cj.projects[p] ?? {}), hasTrustDialogAccepted: true };
    put(`${home}/.claude.json`, JSON.stringify(cj, null, 2));
  };

  test("после --deny пользователь сам доверился в Claude — sync серверы не одобряет; miksy trust <проект> спрашивает о них заново, «да» — одобряет", () => {
    const { f, p } = setup();
    expect(f.run(["trust", p, "--deny"]).code).toBe(0);
    expect(read(`${p}/.claude/settings.local.json`)).not.toContain("team");
    acceptInClaude(f.home, p);
    const s = f.run(["sync", p]);
    expect({ approved: read(`${p}/.claude/settings.local.json`).includes("team"), ask: asked(s) }).toEqual({ approved: false, ask: false });
    const t = inProcess(f, ["trust", p], f.dir, ["y"]);
    expect(t.questions.some((q) => q.includes("Одобрить серверы .mcp.json"))).toBe(true);
    f.run(["sync", p]);
    expect(read(`${p}/.claude/settings.local.json`)).toContain("team");
  }, 120000);

  test("«нет» в вопросе sync (терминал) — так же", () => {
    const { f, p } = setup();
    // Команда добавила хук (серверы .mcp.json те же) — новый вопрос; «нет»
    put(`${p}/.claude/settings.json`, JSON.stringify(HOOK("team-hook.sh")));
    gitc(p, "add", ".claude/settings.json");
    gitc(p, "commit", "-qm", "hook");
    expect(inProcess(f, ["sync", p], f.dir, ["n"]).questions.length).toBe(1);
    expect(read(`${p}/.claude/settings.local.json`)).not.toContain("team");
    acceptInClaude(f.home, p);
    f.run(["sync", p]);
    expect(read(`${p}/.claude/settings.local.json`)).not.toContain("team");
  }, 120000);
});

describe("A3 — trust --confirm при trust: false называет запрет", () => {
  test("запрет в слое: «да» записано, доверие не ставится — причина и слой", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const app = `${f.ws}/Org/p1`;
    team(app);
    put(`${f.config}/layers/tree/Org/layer.yaml`, "trust: { claude: false }\n");
    f.run(["sync", app]);
    const c = f.run(["trust", app, "--confirm"]);
    expect(c.code).toBe(0);
    expect(c.out).toContain("записано в local/trust.json");
    expect(c.out).toMatch(/trust: \{ claude: false \} в слое Org/);
    expect(c.out).toContain("доверие поставит следующий miksy sync после снятия запрета");
    expect(trusted(f.home, app)).toBe(false);
  }, 120000);

  test("запрет в local/machine.yaml — так же, с местом запрета", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const app = `${f.ws}/Org/p1`;
    team(app);
    put(`${f.config}/local/machine.yaml`, read(`${f.config}/local/machine.yaml`) + "trust: { claude: false }\n");
    const c = f.run(["trust", app, "--confirm"]);
    expect(c.out).toMatch(/trust: \{ claude: false \} в local\/machine\.yaml/);
    expect(c.out).toContain("доверие поставит следующий miksy sync после снятия запрета");
    expect(trusted(f.home, app)).toBe(false);
  }, 120000);
});
