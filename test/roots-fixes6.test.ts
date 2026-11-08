// Фаза 0.2.0, исправления после шестой проверки (out/phase-roots-fixes6.md, раздел B):
// B.1 — подсказка вне workspace и root add каталога, который сам проект (git-репо, проект другого корня);
// B.3 — доверие Claude: .claude/settings.local.json в цели без git и в подкаталогах её группы;
// B.4 — проект с отметкой «проект забыт» — не кандидат в переезд; B.6 — просмотр miksy trust после «забыть»;
// B.7 — doctor о ветке слоёв, похожей на папку (ветка другой машины или опечатка); B.8 — тексты вопроса о доверии.
// Тесты рецензентов широкой проверки 6x (out/check6x/miksy*/test/zz-review-*.test.ts) — здесь, ожидания — по
// требованиям круга
import { describe, expect, test } from "bun:test";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { cliFixture, put } from "./helpers";
import { git, inProcess, ledger, read, yamlRoots } from "./rootshelp";

const genv = () => ({ ...process.env, GIT_CONFIG_NOSYSTEM: "1" });
const gitc = (dir: string, ...args: string[]) => Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { env: genv() });
const unplug = (dir: string) => { renameSync(dir, `${dir}-disk`); mkdirSync(dir); };
const plugBack = (dir: string) => { rmSync(dir, { recursive: true }); renameSync(`${dir}-disk`, dir); };
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
const hook = (cmd: string) => ({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: cmd }] }] } });
// Цель без git (группа) Shared в основном корне
const sharedGroup = (f: { config: string; ws: string }) => {
  put(`${f.config}/layers/tree/Shared/layer.yaml`, "target: true\n");
  put(`${f.config}/layers/tree/Shared/instructions/10.md`, "# shared\n");
  const grp = `${f.ws}/Shared`;
  put(`${grp}/notes.md`, "x\n");
  return grp;
};

describe("B.1 — проект вне workspace: подсказка доводит до работающего проекта", () => {
  test("sync в git-репо вне workspace (и в его подкаталоге) → подсказка root add «папки, где он лежит» → по ней дословно → sync пишет настройки", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const repo = `${f.dir}/elsewhere/new-repo`;
    git(repo);
    mkdirSync(`${repo}/src`, { recursive: true });
    const s1 = f.run(["sync"], { cwd: repo });
    const s0 = f.run(["sync"], { cwd: `${repo}/src` });
    const cmd = (r: { out: string; err: string }) => (r.out + r.err).match(/miksy root add "([^"]+)"/)?.[1];
    expect({ code: s1.code, cmd: cmd(s1), dot: (s1.out + s1.err).includes("root add ."), sub: cmd(s0), subRepo: (s0.out + s0.err).includes(`git-репо ${repo}`) })
      .toEqual({ code: 2, cmd: dirname(repo), dot: false, sub: dirname(repo), subRepo: true });
    // По подсказке: root add <папка> — в терминале Enter (ветка по умолчанию), sync сейчас — «нет»
    const a = inProcess(f, ["root", "add", cmd(s1)!], repo, ["", false]);
    expect({ code: a.code, err: a.err, q: a.questions.length }).toEqual({ code: 0, err: "", q: 2 });
    const s2 = f.run(["sync"], { cwd: repo });
    const s3 = f.run(["sync"], { cwd: `${repo}/src` });
    expect({ code: s2.code, sub: s3.code, written: read(`${repo}/CLAUDE.local.md`).includes("miksy") }).toEqual({ code: 0, sub: 0, written: true });
  }, 120000);

  test("sync вне workspace не в git-репо: папка с проектами — прежняя подсказка miksy root add .; без проектов — git init и корнем папку, где она лежит (рецензия 6y, п. 2)", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const dir = `${f.dir}/elsewhere/projects`;
    git(`${dir}/one`);
    const s = f.run(["sync"], { cwd: dir });
    expect({ code: s.code, dot: (s.out + s.err).includes("сделать этот каталог корнем workspace — miksy root add .") }).toEqual({ code: 2, dot: true });
    const notes = `${f.dir}/elsewhere/notes`;
    put(`${notes}/todo.md`, "x\n");
    const n = f.run(["sync"], { cwd: notes });
    const text = n.out + n.err;
    expect({ code: n.code, init: text.includes("git init"), parent: text.includes(`miksy root add "${dirname(notes)}"`), plain: text.includes("сделать этот каталог корнем workspace") }).toEqual({ code: 2, init: true, parent: true, plain: false });
    // По подсказке: git init, root add папки, где он лежит, — sync пишет настройки
    git(notes);
    expect(f.run(["root", "add", dirname(notes), "--tree", "Else"]).code).toBe(0);
    expect(f.run(["sync"], { cwd: notes }).code).toBe(0);
    expect(read(`${notes}/CLAUDE.local.md`)).toContain("miksy");
  }, 120000);

  test("root add git-репо: без терминала — не добавлен, объяснение и верная команда; в терминале — вопрос («нет» по умолчанию); --yes — добавлен с предупреждением", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const repo = `${f.dir}/elsewhere/new-repo`;
    git(repo);
    const yaml = () => read(`${f.config}/local/machine.yaml`);
    const before = yaml();
    const r = f.run(["root", "add", repo, "--tree", "New"]);
    expect({ code: r.code, why: (r.out + r.err).includes("папкой с проектами, а не проектом"), cmd: (r.out + r.err).includes(`miksy root add "${dirname(repo)}"`), yes: (r.out + r.err).includes(`miksy root add "${repo}" --tree New --yes`), dots: (r.out + r.err).includes(".."), yaml: yaml() })
      .toEqual({ code: 2, why: true, cmd: true, yes: true, dots: false, yaml: before });
    // Без --tree совет — с местом для ветки (иначе подсказанная команда дословно упала бы на «укажите ветку»)
    const nt = f.run(["root", "add", repo]);
    expect((nt.out + nt.err).includes(`miksy root add "${repo}" --tree <ветка> --yes`)).toBe(true);
    const q = inProcess(f, ["root", "add", repo, "--tree", "New"], f.dir, [false]);
    expect({ code: q.code, q: q.questions.length, none: q.out.includes("Корень не добавлен"), yaml: yaml() }).toEqual({ code: 0, q: 1, none: true, yaml: before });
    const dry = f.run(["root", "add", repo, "--tree", "New", "--dry-run"]);
    expect({ code: dry.code, warn: dry.out.includes("папкой с проектами"), yaml: yaml() }).toEqual({ code: 0, warn: true, yaml: before });
    const y = f.run(["root", "add", repo, "--tree", "New", "--yes"]);
    expect({ code: y.code, warn: y.out.includes("предупреждение:"), added: yaml().includes("new-repo") }).toEqual({ code: 0, warn: true, added: true });
    // Папка с проектами, которая сама git-репо (внутри — свои репо), — без вопроса
    const box = `${f.dir}/box`;
    git(box);
    git(`${box}/inner`);
    const b = f.run(["root", "add", box, "--tree", "Box"]);
    expect({ code: b.code, warn: b.out.includes("папкой с проектами, а не проектом") }).toEqual({ code: 0, warn: false });
    // --yes — только для root add
    expect(f.run(["root", "remove", box, "--yes"]).code).toBe(2);
  }, 120000);

  test("root add проекта основного корня: без терминала не добавлен (проект обновляется дальше); с --yes — sync --all и doctor говорят о записанном, совет работает", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const p1 = `${f.ws}/Org/p1`;
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(f.run(["sync", "--global"]).code).toBe(0);
    const a = f.run(["root", "add", p1, "--tree", "P1"]);
    expect({ code: a.code, kind: (a.out + a.err).includes("проект корня"), advice: (a.out + a.err).includes(`miksy sync "${p1}"`) }).toEqual({ code: 2, kind: true, advice: true });
    put(`${f.config}/layers/tree/instructions/00.md`, "# workspace v2\n");
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(read(`${p1}/CLAUDE.local.md`)).toContain("# workspace v2");
    // Всё-таки корень (--yes): записанное в p1 раньше не висит молча
    expect(f.run(["root", "add", p1, "--tree", "P1", "--yes"]).code).toBe(0);
    put(`${f.config}/layers/tree/instructions/00.md`, "# workspace v3\n");
    const s = f.run(["sync", "--all", "--yes"]);
    const d = f.run(["doctor"]);
    const problems = d.out.split("Справочно")[0];
    expect({ sync: s.out.includes(`${p1} — теперь корень workspace`), doctor: d.code, says: problems.includes("Проект стал корнем workspace") && problems.includes(p1), advice: problems.includes(`miksy clean "${p1}"`) && problems.includes(`miksy root remove "${p1}"`) })
      .toEqual({ sync: true, doctor: 1, says: true, advice: true });
    // Совет «добавлен по ошибке»: root remove — записанное в p1 не убирается и не забывается, sync --all обновляет
    const rm = f.run(["root", "remove", p1]);
    expect({ code: rm.code, listed: rm.out.includes("miksy записывал в его проекты") }).toEqual({ code: 0, listed: false });
    expect(read(`${p1}/CLAUDE.local.md`)).toContain("# workspace v2");
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(read(`${p1}/CLAUDE.local.md`)).toContain("# workspace v3");
    const d2 = f.run(["doctor"]);
    expect({ code: d2.code, rooted: d2.out.includes("Проект стал корнем") }).toEqual({ code: 0, rooted: false });
  }, 180000);

  test("root add проекта --yes, совет «так и задумано»: clean убирает записанное, doctor спокоен", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const p1 = `${f.ws}/Org/p1`;
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(f.run(["sync", "--global"]).code).toBe(0);
    expect(f.run(["root", "add", p1, "--tree", "P1", "--yes"]).code).toBe(0);
    const c = f.run(["clean", p1]);
    expect({ code: c.code, left: read(`${p1}/CLAUDE.local.md`).includes("miksy") }).toEqual({ code: 0, left: false });
    const d = f.run(["doctor"]);
    expect(d.out.includes("Проект стал корнем")).toBe(false);
  }, 120000);
});

describe("B.3 — доверие Claude: .claude/settings.local.json в цели без git", () => {
  test("цель без git (группа) в общей папке: чужой хук в settings.local.json — доверие только после решения пользователя", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const grp = sharedGroup(f);
    put(`${grp}/.claude/settings.local.json`, JSON.stringify({ ...hook("colleague.sh"), env: { X: "1" } }, null, 2));
    const s = f.run(["sync", "--all", "--yes"]);
    expect({ ask: asked(s), hook: s.out.includes("colleague.sh"), trusted: trusted(f.home, grp) }).toEqual({ ask: true, hook: true, trusted: false });
    // «да» — доверие ставится, дальше без вопроса; хук поменялся — снова решение
    expect(f.run(["trust", grp, "--confirm"]).code).toBe(0);
    const runs = [1, 2].map(() => f.run(["sync", "--all", "--yes"]));
    expect({ runs: runs.map(swing), trusted: trusted(f.home, grp) }).toEqual({ runs: [STEADY, STEADY], trusted: true });
    put(`${grp}/.claude/settings.local.json`, JSON.stringify(hook("other.sh"), null, 2));
    const again = f.run(["sync", "--all", "--yes"]);
    expect({ ask: asked(again), hook: again.out.includes("other.sh"), trusted: trusted(f.home, grp) }).toEqual({ ask: true, hook: true, trusted: false });
  }, 120000);

  test("подкаталог группы без git: чужой хук в settings.local.json — doctor показывает; ответы пользователя в окне Claude там же (доверие ставил miksy) — нет", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const grp = sharedGroup(f);
    put(`${grp}/sub/.claude/settings.local.json`, JSON.stringify(hook("colleague.sh"), null, 2));
    allowInClaude(`${grp}/mine`);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    const d = f.run(["doctor"]);
    expect({ trusted: trusted(f.home, grp), doctor: d.out.includes("colleague.sh"), own: d.out.includes("Bash(ls:*)") }).toEqual({ trusted: true, doctor: true, own: false });
  }, 120000);

  test("группа без git: доверие ставил miksy, пользователь отвечал Claude «больше не спрашивать» — без вопроса и без качелей", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const grp = sharedGroup(f);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(trusted(f.home, grp)).toBe(true);
    allowInClaude(grp);
    const runs = [1, 2, 3].map(() => f.run(["sync", "--all", "--yes"]));
    expect({ runs: runs.map(swing), trusted: trusted(f.home, grp) }).toEqual({ runs: [STEADY, STEADY, STEADY], trusted: true });
  }, 120000);

  test("группа без git с .mcp.json: «да» сохранено — одобрения miksy и ответы Claude в settings.local.json вопроса не вызывают", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const grp = sharedGroup(f);
    put(`${grp}/.mcp.json`, JSON.stringify({ mcpServers: { team: { command: "team-server" } } }));
    expect(asked(f.run(["sync", "--all", "--yes"]))).toBe(true);
    expect(f.run(["trust", grp, "--confirm"]).code).toBe(0);
    expect(local(grp).enabledMcpjsonServers).toEqual(["team"]);
    allowInClaude(grp);
    const runs = [1, 2, 3].map(() => f.run(["sync", "--all", "--yes"]));
    expect({ runs: runs.map(swing), trusted: trusted(f.home, grp) }).toEqual({ runs: [STEADY, STEADY, STEADY], trusted: true });
  }, 120000);

  test("группа без git: trust: false в слое — окончательно, чужой хук вопроса не вызывает, доверия нет", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const grp = sharedGroup(f);
    put(`${f.config}/layers/tree/Shared/layer.yaml`, "target: true\ntrust: { claude: false }\n");
    put(`${grp}/.claude/settings.local.json`, JSON.stringify(hook("colleague.sh"), null, 2));
    const s = f.run(["sync", "--all", "--yes"]);
    expect({ ask: asked(s), trusted: trusted(f.home, grp) }).toEqual({ ask: false, trusted: false });
  }, 120000);
});

describe("B.3 — граница доверия: тесты рецензента «версии и доверие» (zz-review-trustpaths)", () => {
  test("«нет» в вопросе sync (терминал) → trust <проект> «да» (терминал) → sync: без качелей; ответы Claude после «нет» не мешают", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const app = `${f.ws}/Org/p1`;
    expect(f.run(["sync", app]).code).toBe(0);
    allowInClaude(app);
    team(app);
    const q = inProcess(f, ["sync", app], f.dir, ["n"]);
    expect(q.questions.length).toBe(1);
    allowInClaude(app, "Bash(cat:*)");
    const s0 = f.run(["sync", app]);
    expect({ ask: asked(s0), trusted: trusted(f.home, app) }).toEqual({ ask: false, trusted: false });
    const y = inProcess(f, ["trust", app], f.dir, ["y"]);
    expect({ allowShown: y.out.includes("разрешено без вопроса"), q: y.questions.length }).toEqual({ allowShown: false, q: 1 });
    const runs = [1, 2, 3].map(() => f.run(["sync", app]));
    expect(runs.map(swing)).toEqual([STEADY, STEADY, STEADY]);
    expect({ trusted: trusted(f.home, app), approvals: local(app).enabledMcpjsonServers }).toEqual({ trusted: true, approvals: ["team"] });
  }, 120000);

  test("trust: false в слое — окончательно и для trust --confirm; machine.yaml false сильнее trust: true слоя", () => {
    const f = cliFixture({ agents: ["claude", "codex"], projects: ["Org/p1"] });
    const app = `${f.ws}/Org/p1`;
    team(app);
    put(`${f.config}/layers/tree/Org/layer.yaml`, "trust: { claude: false }\n");
    f.run(["sync", app]);
    const c = f.run(["trust", app, "--agent", "claude", "--confirm"]);
    const s = f.run(["sync", app]);
    expect({ trusted: trusted(f.home, app), approvals: local(app).enabledMcpjsonServers ?? null, ask: asked(s) }).toEqual({ trusted: false, approvals: null, ask: false });
    put(`${f.config}/layers/tree/Org/layer.yaml`, "trust: { claude: true }\n");
    put(`${f.config}/local/machine.yaml`, read(`${f.config}/local/machine.yaml`) + "trust: { claude: false }\n");
    const m = f.run(["sync", app]);
    expect({ trusted: trusted(f.home, app), approvals: local(app).enabledMcpjsonServers ?? null, ask: asked(m), code: c.code }).toEqual({ trusted: false, approvals: null, ask: false, code: 0 });
  }, 120000);

  test("перенос каталога проекта: «да» пользователя, ответы Claude, командный .mcp.json — после переезда без вопроса и без снятия", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const app = `${f.ws}/Org/p1`, moved = `${f.ws}/Org/p1-new`;
    team(app);
    allowInClaude(app);
    expect(asked(f.run(["sync", "--all", "--yes"]))).toBe(true);
    expect(f.run(["trust", app, "--confirm"]).code).toBe(0);
    expect(swing(f.run(["sync", "--all", "--yes"]))).toEqual(STEADY);
    renameSync(app, moved);
    allowInClaude(moved, "Bash(cat:*)");
    const runs = [f.run(["sync", "--all", "--yes"]), f.run(["sync", "--all", "--yes"])];
    expect(runs.map((r) => ({ ...swing(r), moved: r.out.includes("перенесён вслед") }))).toEqual([{ ...STEADY, moved: true }, { ...STEADY, moved: false }]);
    expect({ trusted: trusted(f.home, moved), approvals: local(moved).enabledMcpjsonServers }).toEqual({ trusted: true, approvals: ["team"] });
  }, 120000);

  test("clean → sync, когда пользователь раньше сказал «да» (решение в local/trust.json): вопроса нет", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const app = `${f.ws}/Org/p1`;
    team(app);
    allowInClaude(app);
    f.run(["sync", app]);
    expect(f.run(["trust", app, "--confirm"]).code).toBe(0);
    expect(f.run(["clean", app]).code).toBe(0);
    const s = f.run(["sync", app]);
    expect({ ...swing(s), trusted: trusted(f.home, app) }).toEqual({ ...STEADY, trusted: true });
  }, 120000);
});

describe("B.4 — ложный «переезд» на забытый проект (zz-review-falsemove)", () => {
  const twoProjects = () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const drive = `${f.dir}/drive`, a = `${drive}/Acme/a`, b = `${drive}/Acme/b`;
    git(a);
    git(b);
    return { f, drive, a, b };
  };
  test("Acme/a удалён (в учёте, с оригиналом CLAUDE.local.md), Acme/b забыт и вернулся — sync --all не переносит учёт a на b, clean b не кладёт туда текст a", () => {
    const { f, drive, a, b } = twoProjects();
    put(`${a}/CLAUDE.local.md`, "# мои заметки проекта A\n");
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive, tree: "Clients" }])}agents: [claude]\n`);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    unplug(drive);
    expect(f.run(["clean", b, "--forget"]).code).toBe(0);
    plugBack(drive);
    rmSync(a, { recursive: true, force: true });
    const s = f.run(["sync", "--all", "--yes"]);
    const c = f.run(["clean", b]);
    expect({ moved: /переехал|перенесён/.test(s.out), bGotA: read(`${b}/CLAUDE.local.md`).includes("проекта A"), clean: c.code }).toEqual({ moved: false, bGotA: false, clean: 0 });
    // Учёт a — «ссылается на несуществующий каталог», как было бы и без b
    expect(f.run(["doctor"]).out).toContain("Учёт ссылается на несуществующие каталоги");
  }, 180000);

  test("Acme/a удалён (свой skill пользователя заменён miksy через --force — оригинал), Acme/b забыт и вернулся — clean b не кладёт skill из a", () => {
    const { f, drive, a, b } = twoProjects();
    put(`${f.config}/layers/tree/Clients/skills/sk/SKILL.md`, "---\nname: sk\ndescription: d\n---\nbody miksy\n");
    put(`${a}/.claude/skills/sk/SKILL.md`, "---\nname: sk\ndescription: d\n---\nмой skill в проекте A\n");
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive, tree: "Clients" }])}agents: [claude]\n`);
    f.run(["sync", "--all", "--yes"]);
    f.run(["sync", a, "--force"]);
    unplug(drive);
    expect(f.run(["clean", b, "--forget"]).code).toBe(0);
    plugBack(drive);
    rmSync(a, { recursive: true, force: true });
    const s = f.run(["sync", "--all", "--yes"]);
    f.run(["clean", b]);
    expect({ moved: /перенесён/.test(s.out), bGotA: read(`${b}/.claude/skills/sk/SKILL.md`).includes("проекте A") }).toEqual({ moved: false, bGotA: false });
  }, 180000);

  test("переезд без отметки «забыт» — как раньше: папку переименовали, учёт переезжает", () => {
    const { f, drive, a } = twoProjects();
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive, tree: "Clients" }])}agents: [claude]\n`);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    renameSync(a, `${drive}/Acme/a2`);
    const s = f.run(["sync", "--all", "--yes"]);
    expect(s.out).toContain("Учёт miksy перенесён вслед за каталогами");
  }, 120000);
});

describe("B.6 — miksy trust после «забыть»: свои файлы miksy — не чужие", () => {
  test("Codex: «забыть» → диск вернулся → miksy trust <проект> --agent codex не показывает свой .codex/config.toml как чужой", () => {
    const f = cliFixture({ agents: ["codex"], projects: ["Org/p1"] });
    const archive = `${f.dir}/archive`, app = `${archive}/Acme/app`;
    git(app);
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: archive, tree: "Archive" }])}agents: [codex]\n`);
    put(`${f.config}/layers/tree/Archive/mcp/tool.yaml`, "name: tool\ncommand: tool\nargs: []\n");
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    unplug(archive);
    f.run(["clean", app, "--forget"]);
    plugBack(archive);
    const t = inProcess(f, ["trust", app, "--agent", "codex"], f.dir, []);
    expect({ foreign: t.out.includes("конфиг Codex не от miksy"), err: t.err }).toEqual({ foreign: false, err: "" });
    // Чужой конфиг Codex (не от miksy) просмотр по-прежнему показывает
    put(`${app}/.codex/config.toml`, "[mcp_servers.evil]\ncommand = \"evil\"\n");
    const v = inProcess(f, ["trust", app, "--agent", "codex"], f.dir, [""]);
    expect(v.out.includes("конфиг Codex не от miksy")).toBe(true);
  }, 120000);
});

describe("B.7 — doctor: ветка слоёв, похожая на папку (zz-review-doctor)", () => {
  test("на этой машине корня Clients нет, а в основном корне есть папка Clients-old — справочно, оба варианта, не «проблема»", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    put(`${f.config}/layers/tree/Clients/instructions/10.md`, "# clients\n");
    git(`${f.ws}/Clients-old/x`);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(f.run(["sync", "--global"]).code).toBe(0);
    const d = f.run(["doctor"]);
    const info = d.out.split("Справочно")[1] ?? "";
    expect({ code: d.code, typo: d.out.includes("Похоже на опечатку"), both: info.includes("ветка корня другой машины") && info.includes("если опечатка") && info.includes("layers/tree/Clients ↔ в workspace есть Clients-old") })
      .toEqual({ code: 0, typo: false, both: true });
  }, 120000);

  test("основной корень с tree на этой машине — ветка другой машины справочно", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    put(`${f.config}/local/machine.yaml`, `workspace:\n  - { path: "${f.ws}", tree: Main }\nagents: [claude]\n`);
    put(`${f.config}/layers/tree/Clients/instructions/10.md`, "# clients\n");
    put(`${f.config}/layers/tree/Main/Org/instructions/10.md`, "# org\n");
    mkdirSync(`${f.ws}/Clients-old`, { recursive: true });
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(f.run(["sync", "--global"]).code).toBe(0);
    expect(f.run(["doctor"]).code).toBe(0);
  }, 120000);

  test("настоящая опечатка внутри папки (Org/sitte ↔ Org/site) — по-прежнему проблема", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/site"] });
    put(`${f.config}/layers/tree/Org/sitte/instructions/10.md`, "# typo\n");
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(f.run(["sync", "--global"]).code).toBe(0);
    const d = f.run(["doctor"]);
    expect({ code: d.code, typo: d.out.includes("Похоже на опечатку") && d.out.includes("layers/tree/Org/sitte") }).toEqual({ code: 1, typo: true });
  }, 120000);
});

describe("B.8 — вопрос о доверии: ответы в окне Claude — не «настройки команды»", () => {
  test("папка, которой miksy не доверял: ответы Claude — отдельной строкой «ответы в окне Claude», настройки команды — отдельно", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const app = `${f.ws}/Org/p1`;
    team(app);
    allowInClaude(app);
    const s = f.run(["sync", app]);
    const block = s.out.slice(s.out.indexOf("Нужно решение"));
    const lines = block.split("\n");
    const title = lines.findIndex((l) => l.includes("ответы в окне Claude («да, больше не спрашивать»"));
    const allow = lines.findIndex((l) => l.includes("разрешено без вопроса"));
    // Ответы — под своим заголовком (с отступом), строка команды — в общем списке
    expect({ head: block.includes("исполняемые настройки агента команды"), title: title > 0, under: allow === title + 1 && lines[allow].startsWith("        "), team: /^ {6}\.mcp\.json: MCP team/.test(lines.find((l) => l.includes("MCP team")) ?? "") })
      .toEqual({ head: false, title: true, under: true, team: true });
  }, 120000);
});

describe("рецензия круга 6y", () => {
  test("п. 1: группа target: true без git, добавленная корнем --yes, — текст root add верный, sync --all убирает записанное без «теперь корень», doctor без ложного «каталога нет»", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const grp = sharedGroup(f);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(f.run(["sync", "--global"]).code).toBe(0);
    expect(read(`${grp}/CLAUDE.local.md`)).toContain("# shared");
    const a = f.run(["root", "add", grp, "--tree", "SharedRoot", "--yes"]);
    expect({ code: a.code, mark: a.out.includes("пометка target: true (layers/tree/Shared/layer.yaml) перестанет действовать"), stays: a.out.includes("останется и перестанет обновляться") })
      .toEqual({ code: 0, mark: true, stays: false });
    const s = f.run(["sync", "--all", "--yes"]);
    expect({ code: s.code, rooted: s.out.includes("теперь корень workspace"), absent: s.out.includes("каталога нет в workspace"), gone: read(`${grp}/CLAUDE.local.md`).includes("# shared") })
      .toEqual({ code: 0, rooted: false, absent: false, gone: false });
    const d = f.run(["doctor"]);
    expect({ code: d.code, absent: d.out.includes("каталогов которых на этой машине нет"), info: d.out.includes("Цели target: true, чей каталог стал корнем workspace"), rooted: d.out.includes("Проект стал корнем") })
      .toEqual({ code: 0, absent: false, info: true, rooted: false });
  }, 120000);

  test("п. 4: doctor о подкаталогах группы — при trust: false в слое раздела нет; ответы в окне Claude в подкаталоге доверенной группы — не в разделе, хук — в разделе", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const grp = sharedGroup(f);
    allowInClaude(`${grp}/mine`);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(f.run(["sync", "--global"]).code).toBe(0);
    expect(f.run(["doctor"]).out.includes("Исполняемые настройки в подкаталогах групп без git")).toBe(false);
    put(`${grp}/sub/.claude/settings.local.json`, JSON.stringify(hook("colleague.sh"), null, 2));
    expect(f.run(["doctor"]).out.includes("colleague.sh")).toBe(true);
    put(`${f.config}/layers/tree/Shared/layer.yaml`, "target: true\ntrust: { claude: false }\n");
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    const d = f.run(["doctor"]);
    expect(d.out.includes("Исполняемые настройки в подкаталогах групп без git")).toBe(false);
  }, 120000);
});
