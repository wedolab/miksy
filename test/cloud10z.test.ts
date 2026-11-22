// Круг 10z: машины в общей папке не мешают друг другу. Проект лежит в папке, которую видят две машины (облако, NAS), у
// каждой свой miksy, своя конфигурация и учёт. У каждой машины свой блок miksy в .git/info/exclude (метка — номер
// машины: src/machineid.ts); строки чужого блока — улика «файл другой машины» (DESIGN §8.3, «Машины в общей
// папке»). Тесты рецензентов 6x и 6z (out/reviewer-tests, прогон 10y) — с ожиданиями после исправления; п. 5 и 6 —
// воспроизведения 10z
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { computerId, ensureMachineId, type HardwareSource, idFrom, machineId as machineIdOf, setHardwareSource } from "../src/machineid";
import { cliFixture, expectCode, put, textFiles } from "./helpers";
import { git, inProcess, read, yamlRoots } from "./rootshelp";

type F = ReturnType<typeof cliFixture>;
const gitx = (dir: string, ...args: string[]) => Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", `core.excludesFile=${tmpdir()}/no-global-ignore`, ...args],
  { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
const status = (dir: string) => gitx(dir, "status", "--porcelain", "--untracked-files=all").stdout.toString().trim();
const exclude = (dir: string) => read(`${dir}/.git/info/exclude`);
const files = (dir: string, rel = ""): string[] => !existsSync(dir) ? [] : readdirSync(dir).flatMap((n) => {
  if (n === ".git") return [];
  const p = `${dir}/${n}`;
  return statSync(p).isDirectory() ? files(p, `${rel}${n}/`) : [`${rel}${n}`];
});
const snap = (dir: string) => Object.fromEntries(textFiles(dir).filter((p) => !p.includes("/.git/")).map((p) => [p.slice(dir.length), readFileSync(p, "utf8")]));
const skill = (name: string) => `---\nname: ${name}\ndescription: ${name}\n---\nbody ${name}\n`;
const machineId = (f: F) => machineIdOf(f.config);
const changes = (out: string) => out.split("\n").filter((l) => /^\s{2}(записать|обновить|удалить|взять под учёт|снять с учёта|восстановить|блок|КОНФЛИКТ|\.git\/info|доверие|слить)/.test(l));

// Две машины: у каждой своя конфигурация, дом и учёт; проект — один каталог (общая папка)
function twoMachines(agentsA = ["claude"], agentsB = ["claude"], tree = "Cloud") {
  const A = cliFixture({ agents: agentsA, projects: ["Org/a1"] });
  const B = cliFixture({ agents: agentsB, projects: ["Org/b1"] });
  const cloud = `${A.dir}/cloud`;
  git(`${cloud}/Acme/app`);
  put(`${A.config}/local/machine.yaml`, `${yamlRoots([A.ws, { path: cloud, tree }])}agents: [${agentsA.join(", ")}]\n`);
  put(`${B.config}/local/machine.yaml`, `${yamlRoots([B.ws, { path: cloud, tree }])}agents: [${agentsB.join(", ")}]\n`);
  return { A, B, cloud, app: `${cloud}/Acme/app` };
}

describe("10z: блок исключений у каждой машины", () => {
  test("разные skills у машин: sync и clean по очереди — git status пуст на каждом шаге, повтор — без изменений", () => {
    const { A, B, app } = twoMachines();
    put(`${A.config}/layers/tree/Cloud/skills/a-skill/SKILL.md`, skill("a-skill"));
    put(`${B.config}/layers/tree/Cloud/skills/b-skill/SKILL.md`, skill("b-skill"));
    const log: string[] = [];
    const step = (name: string, r: { code: number | null; out: string }) => log.push(`${name}: код ${r.code}; git: ${status(app) || "чисто"}`);
    step("A sync", A.run(["sync", app]));
    step("B sync", B.run(["sync", app]));
    const a2 = A.run(["sync", app]);
    step("A sync 2", a2);
    const b2 = B.run(["sync", app]);
    step("B sync 2", b2);
    step("B clean", B.run(["clean", app]));
    step("A sync 3", A.run(["sync", app]));
    expect(log).toEqual(["A sync", "B sync", "A sync 2", "B sync 2", "B clean", "A sync 3"].map((n) => `${n}: код 0; git: чисто`));
    // Повтор без изменений: ни exclude, ни файлов
    expect(changes(a2.out)).toEqual([]);
    expect(changes(b2.out)).toEqual([]);
    // Свой номер у каждой машины — только в local/, в общей папке — метка в заголовке блока
    const [ia, ib] = [machineId(A), machineId(B)];
    expect(ia).toMatch(/^[0-9a-f]{12}$/);
    expect(ib).toMatch(/^[0-9a-f]{12}$/);
    expect(ia).not.toBe(ib);
    expect(exclude(app)).toContain(`# >>> miksy:claude (машина ${ia}; сгенерировано, не править)`);
    expect(exclude(app)).not.toContain(`машина ${ib}`); // B сделала clean — её блока нет
    expect(existsSync(`${app}/.claude/skills/a-skill/SKILL.md`)).toBe(true);
  }, 180000);

  test("одна машина пишет codex, другая нет; clean второй машины не открывает git файлы первой", () => {
    const { A, B, app } = twoMachines(["claude", "codex"], ["claude"]);
    expectCode(A.run(["sync", app]), 0);
    expectCode(B.run(["sync", app]), 0);
    const st1 = status(app);
    expectCode(B.run(["clean", app]), 0);
    expect({ st1, st2: status(app), codex: existsSync(`${app}/.codex/config.toml`), rules: read(`${app}/CLAUDE.local.md`).includes("miksy:begin") })
      .toEqual({ st1: "", st2: "", codex: true, rules: true });
  }, 180000);

  test("одна конфигурация, Codex + MCP с секретом: sync и sync --force по очереди — без конфликтов, git чист", () => {
    const A = cliFixture({ agents: ["codex"], projects: ["Org/p1"] });
    const B = cliFixture({ agents: ["codex"], projects: [] });
    const cloud = `${A.dir}/cloud`;
    const app = `${cloud}/Acme/app`;
    git(app);
    for (const m of [A, B]) {
      put(`${m.config}/local/machine.yaml`, `workspace:\n  - "${m.ws}"\n  - { path: "${cloud}", tree: Clients }\nagents: [codex]\n`);
      put(`${m.config}/layers/tree/Clients/mcp/tracker.yaml`, "name: tracker\ncommand: echo\nargs: [x]\nenv:\n  TOKEN: ${TRACKER_TOKEN}\n");
      put(`${m.config}/local/secrets.env`, "TRACKER_TOKEN=secret-value-123\n");
    }
    const log: string[] = [];
    const step = (name: string, r: { code: number | null; out: string }) => log.push(`${name}: код ${r.code}; конфликт: ${/КОНФЛИКТ/.test(r.out)}; git: ${status(app) || "чисто"}`);
    step("A sync", A.run(["sync", app]));
    step("B sync", B.run(["sync", app]));
    step("B sync --force", B.run(["sync", app, "--force"]));
    step("A sync", A.run(["sync", app]));
    step("A sync --force", A.run(["sync", app, "--force"]));
    step("B sync", B.run(["sync", app]));
    expect(log).toEqual(["A sync", "B sync", "B sync --force", "A sync", "A sync --force", "B sync"].map((n) => `${n}: код 0; конфликт: false; git: чисто`));
    expect(read(`${app}/.codex/config.toml`)).not.toContain("secret-value-123");
  }, 180000);
});

describe("10z: «забыть» и уборка на второй машине", () => {
  test("A «забыла» проект (диск был отключён), B — нет: первый sync A не удаляет файл B и не берёт свой skill «оригиналом»; clean A — git чист", () => {
    const { A, B, cloud, app } = twoMachines(["codex"], ["codex"]);
    // A: правил проекта нет (только глобальные), но есть skill; B: правила проекта есть — .codex/config.toml пишет только B
    rmSync(`${A.config}/layers/tree/instructions`, { recursive: true });
    put(`${A.config}/layers/tree/Cloud/skills/a-skill/SKILL.md`, skill("a-skill"));
    expectCode(A.run(["sync", app]), 0);
    expectCode(B.run(["sync", app]), 0);
    expect(existsSync(`${app}/.codex/config.toml`)).toBe(true);
    renameSync(cloud, `${cloud}-away`); mkdirSync(cloud);
    expectCode(A.run(["clean", app, "--forget"]), 0);
    rmSync(cloud, { recursive: true }); renameSync(`${cloud}-away`, cloud);
    const s = A.run(["sync", app]);
    expect(s.out).not.toContain("Оригинал сохранён");
    expect(s.out).not.toContain("config.toml (файл miksy, которого не было в учёте, — больше не нужен)");
    const bFileAfterA = existsSync(`${app}/.codex/config.toml`);
    const s2 = B.run(["sync", app]);
    expect(changes(s2.out)).toEqual([]);
    const gitAfterB = status(app);
    const c = A.run(["clean", app]);
    expect(c.out).not.toContain("восстановить оригинал");
    expect({ bFileAfterA, gitAfterB, aSkillAfterCleanA: existsSync(`${app}/.agents/skills/a-skill/SKILL.md`), bFileAfterCleanA: existsSync(`${app}/.codex/config.toml`), gitAfterCleanA: status(app) })
      .toEqual({ bFileAfterA: true, gitAfterB: "", aSkillAfterCleanA: false, bFileAfterCleanA: true, gitAfterCleanA: "" });
  }, 180000);

  test("A убирает корень с согласием убрать записанное: файлы B на месте, их строки исключений — тоже (git чист)", () => {
    const { A, B, cloud, app } = twoMachines();
    put(`${A.config}/layers/tree/Cloud/skills/a-skill/SKILL.md`, skill("a-skill"));
    put(`${B.config}/layers/tree/Cloud/skills/b-skill/SKILL.md`, skill("b-skill"));
    put(`${B.config}/layers/tree/Cloud/instructions/50-b.md`, "# only on B\n");
    expectCode(A.run(["sync", app]), 0);
    B.run(["sync", app]); // у B правила другие — конфликт блока инструкций A (разные конфигурации, docs/roots.md)
    expectCode(A.run(["sync", app]), 0);
    const r = inProcess(A, ["root", "remove", cloud], A.dir, [true]);
    expect(r.err).toBe("");
    expect({ aSkill: existsSync(`${app}/.claude/skills/a-skill/SKILL.md`), bSkill: existsSync(`${app}/.claude/skills/b-skill/SKILL.md`), git: status(app) })
      .toEqual({ aSkill: false, bSkill: true, git: "" });
  }, 180000);

  test("одинаковые слои: B убирает корень с согласием — файлы, нужные A, остаются; doctor A — без находок о проекте", () => {
    const { A, B, cloud, app } = twoMachines();
    expectCode(A.run(["sync", app]), 0);
    const b = B.run(["sync", app]);
    expectCode(b, 0);
    expect(b.out).toContain("взять под учёт");
    expect(b.out).not.toContain("Оригинал сохранён");
    const before = snap(app);
    const r = inProcess(B, ["root", "remove", cloud], B.dir, [true]);
    expect(r.out).toContain("файл нужен и другой машине в общей папке — не удаляю");
    expect(snap(app)).toEqual(before);
    expect(status(app)).toBe("");
    const d = A.run(["doctor"]);
    expect(d.out).not.toContain("Acme/app");
    expect(changes(A.run(["sync", app]).out)).toEqual([]);
  }, 180000);

  test("A забыла проект (её ссылка в никуда), B — нет; диск у A вернулся: sync A не меняет файлы B, повторы без изменений", () => {
    const A = cliFixture({ agents: ["claude"], projects: ["Org/a1"] });
    const B = cliFixture({ agents: ["claude"], projects: ["Org/b1"] });
    const cloud = `${A.dir}/Cloud`, proj = `${cloud}/Acme/site`, linkA = `${A.dir}/cloud-link`;
    git(proj);
    symlinkSync(cloud, linkA, "junction");
    put(`${A.config}/local/machine.yaml`, `${yamlRoots([A.ws, { path: linkA, tree: "Clients" }])}agents: [claude]\n`);
    put(`${B.config}/local/machine.yaml`, `${yamlRoots([B.ws, { path: cloud, tree: "Clients" }])}agents: [claude]\n`);
    for (const f of [A, B]) put(`${f.config}/layers/tree/Clients/instructions/10.md`, "# clients\n");
    put(`${B.config}/layers/tree/Clients/mcp/b.yaml`, "name: b\ncommand: echo\nargs: [x]\n");
    expectCode(A.run(["sync", "--all", "--yes"]), 0);
    expectCode(B.run(["sync", "--all", "--yes"]), 0);
    unlinkSync(linkA);
    symlinkSync(`${A.dir}/nowhere`, linkA, "junction");
    const f = inProcess(A, ["root", "remove", linkA], A.dir, [true]);
    expect(f.err).toBe("");
    unlinkSync(linkA);
    symlinkSync(cloud, linkA, "junction");
    put(`${B.config}/layers/tree/Clients/instructions/11.md`, "# clients 2\n");
    expectCode(B.run(["sync", "--all", "--yes"]), 0);
    const before = snap(proj);
    expectCode(A.run(["root", "add", linkA, "--tree", "Clients"]), 0);
    A.run(["sync", "--all", "--yes"]);
    expect(snap(proj)).toEqual(before);
    expect(changes(B.run(["sync", "--all", "--yes"]).out)).toEqual([]);
    expect(status(proj)).toBe("");
  }, 180000);
});

describe("10z: doctor — пропавшие файлы", () => {
  test("файл miksy удалён не через miksy: doctor — «Пропали файлы miksy», а не «Устарело»; sync возвращает", () => {
    const { A, app } = twoMachines();
    put(`${A.config}/layers/tree/Cloud/skills/a-skill/SKILL.md`, skill("a-skill"));
    expectCode(A.run(["sync", app]), 0);
    rmSync(`${app}/CLAUDE.local.md`);
    rmSync(`${app}/.claude/skills/a-skill`, { recursive: true });
    const d = A.run(["doctor"]);
    expect(d.out).toContain("Пропали файлы miksy (1) — удалены не через miksy (например, другой машиной в общей папке): miksy sync --all --agent <id> вернёт");
    expect(d.out).not.toContain("Устарело");
    expectCode(A.run(["sync", app]), 0);
    expect(A.run(["doctor"]).out).not.toContain("Пропали файлы miksy");
  }, 180000);

  test("слои изменились — по-прежнему «Устарело»", () => {
    const { A, app } = twoMachines();
    expectCode(A.run(["sync", app]), 0);
    put(`${A.config}/layers/tree/Cloud/instructions/20.md`, "# new\n");
    const d = A.run(["doctor"]);
    expect(d.out).toContain("Устарело");
    expect(d.out).not.toContain("Пропали файлы miksy");
  }, 180000);
});

describe("10z: одобрения .mcp.json на двух машинах", () => {
  test("A одобряет, B — нет, потом тоже: строка файла одобрений не качается; clean одной не снимает одобрения другой", () => {
    const { A, B, app } = twoMachines();
    put(`${app}/.mcp.json`, JSON.stringify({ mcpServers: { team: { command: "runner", args: ["serve"] } } }));
    gitx(app, "add", "-f", ".mcp.json"); gitx(app, "commit", "-q", "-m", "team");
    const approvals = () => existsSync(`${app}/.claude/settings.local.json`) ? JSON.parse(read(`${app}/.claude/settings.local.json`)).enabledMcpjsonServers ?? [] : null;
    const log: string[] = [];
    const step = (name: string, r: { code: number | null; out: string }) => log.push(`${name}: код ${r.code}; одобрения ${JSON.stringify(approvals())}; git: ${status(app) || "чисто"}`);
    step("A sync", A.run(["sync", "--all", "--yes"]));
    step("A trust", A.run(["trust", app, "--confirm"]));
    step("B sync", B.run(["sync", "--all", "--yes"]));
    step("A sync", A.run(["sync", "--all", "--yes"]));
    step("B trust", B.run(["trust", app, "--confirm"]));
    step("A clean", A.run(["clean", app]));
    step("B sync", B.run(["sync", "--all", "--yes"]));
    step("B clean", B.run(["clean", app]));
    expect(log).toEqual([
      "A sync: код 0; одобрения null; git: чисто",
      "A trust: код 0; одобрения [\"team\"]; git: чисто",
      "B sync: код 0; одобрения [\"team\"]; git: чисто",
      "A sync: код 0; одобрения [\"team\"]; git: чисто",
      "B trust: код 0; одобрения [\"team\"]; git: чисто",
      // «team» одобрила A (B застала его одобренным — не её): clean A снимает своё, sync B одобряет снова — уже своё
      "A clean: код 0; одобрения null; git: чисто",
      "B sync: код 0; одобрения [\"team\"]; git: чисто",
      "B clean: код 0; одобрения null; git: чисто",
    ]);
  }, 180000);
});

describe("10z: ложный «переезд» в общей папке", () => {
  test("A: Acme/a в учёте и удалён; Acme/b записан только машиной B — учёт a не переезжает на b, clean b на A не трогает файлы B", () => {
    const A = cliFixture({ agents: ["claude"], projects: ["Org/a1"] });
    const B = cliFixture({ agents: ["claude"], projects: ["Org/b1"] });
    const cloud = `${A.dir}/Cloud`, a = `${cloud}/Acme/a`, b = `${cloud}/Acme/b`;
    git(a);
    for (const m of [A, B]) {
      put(`${m.config}/local/machine.yaml`, `${yamlRoots([m.ws, { path: cloud, tree: "Clients" }])}agents: [claude]\n`);
      put(`${m.config}/layers/tree/Clients/skills/sk/SKILL.md`, skill("sk"));
    }
    expectCode(A.run(["sync", "--all", "--yes"]), 0);
    git(b);
    expectCode(B.run(["sync", b]), 0);
    rmSync(a, { recursive: true, force: true });
    const s = A.run(["sync", "--all", "--yes"]);
    expect(s.out).not.toContain("перенесён");
    expect(A.run(["doctor"]).out).toContain("Учёт ссылается на несуществующие каталоги");
    const before = snap(b);
    expectCode(A.run(["clean", b]), 0);
    expect(snap(b)).toEqual(before);
    expect(status(b)).toBe("");
  }, 180000);

  test("переезд своего проекта по-прежнему узнаётся (свой блок едет вместе с .git)", () => {
    const { A, cloud, app } = twoMachines();
    put(`${A.config}/layers/tree/Cloud/skills/sk/SKILL.md`, skill("sk"));
    expectCode(A.run(["sync", "--all", "--yes"]), 0);
    renameSync(app, `${cloud}/Acme/app2`);
    expect(A.run(["sync", "--all", "--yes"]).out).toContain("Учёт miksy перенесён вслед за каталогами");
  }, 180000);
});

describe("10z: переход с прежней версии и чужие строки без файлов", () => {
  const unmark = (dir: string) => writeFileSync(`${dir}/.git/info/exclude`, exclude(dir).replace(/ \(машина [0-9a-f]+; /g, " (").replace(/ \(машина [0-9a-f]+\)$/gm, ""));

  test("свой блок без метки (прежняя версия): первый sync тихо пишет блок с меткой и убирает покрытые строки; вывод и бэкапы — как без изменений", () => {
    const { A, app } = twoMachines();
    expectCode(A.run(["sync", app]), 0);
    unmark(app);
    expect(exclude(app)).toContain("# >>> miksy:claude (сгенерировано, не править)");
    expect(A.run(["doctor"]).out).not.toContain("Acme/app");
    expect(A.run(["sync", app, "--dry-run"]).out).toContain("изменений нет");
    const s = A.run(["sync", app]);
    expectCode(s, 0);
    expect(changes(s.out)).toEqual([]);
    expect(s.out).toContain("изменений нет");
    const ex = exclude(app);
    expect(ex).toContain(`# >>> miksy:claude (машина ${machineId(A)}; сгенерировано, не править)`);
    expect(ex).not.toContain("# >>> miksy:claude (сгенерировано");
    expect(ex.match(/\/CLAUDE\.local\.md/g)?.length).toBe(1);
    expect(status(app)).toBe("");
    expect(changes(A.run(["sync", app]).out)).toEqual([]);
  }, 180000);

  test("блок без метки другой машины на прежней версии: строки не из учёта этой машины — не трогаются", () => {
    const { A, app } = twoMachines();
    expectCode(A.run(["sync", app]), 0);
    put(`${app}/.claude/skills/old/SKILL.md`, skill("old"));
    writeFileSync(`${app}/.git/info/exclude`, exclude(app) + "# >>> miksy:claude (сгенерировано, не править)\n/.claude/skills/old/\n# <<< miksy:claude\n");
    put(`${A.config}/layers/tree/Cloud/skills/sk/SKILL.md`, skill("sk"));
    expectCode(A.run(["sync", app]), 0);
    expect(exclude(app)).toContain("# >>> miksy:claude (сгенерировано, не править)\n/.claude/skills/old/\n# <<< miksy:claude\n");
    expect(status(app)).toBe("");
    expectCode(A.run(["clean", app]), 0);
    expect(exclude(app)).toContain("/.claude/skills/old/");
    expect(existsSync(`${app}/.claude/skills/old/SKILL.md`)).toBe(true);
  }, 180000);

  test("строка блока другой машины без файла снимается один раз — повтор sync ничего не меняет (без качелей)", () => {
    const { A, B, app } = twoMachines();
    put(`${A.config}/layers/tree/Cloud/skills/a-skill/SKILL.md`, skill("a-skill"));
    put(`${B.config}/layers/tree/Cloud/skills/b-skill/SKILL.md`, skill("b-skill"));
    expectCode(A.run(["sync", app]), 0);
    expectCode(B.run(["sync", app]), 0);
    // Облако принесло exclude B, а файла ещё нет
    rmSync(`${app}/.claude/skills/b-skill`, { recursive: true });
    const s1 = A.run(["sync", app]);
    expect(s1.out).toContain("строки другой машины без файлов — убрать: /.claude/skills/b-skill/");
    expect(exclude(app)).not.toContain("b-skill");
    expect(changes(A.run(["sync", app]).out)).toEqual([]);
    // Файл пришёл — B возвращает строку своим sync
    expectCode(B.run(["sync", app]), 0);
    expect(exclude(app)).toContain("/.claude/skills/b-skill/");
    expect(status(app)).toBe("");
    expect(changes(A.run(["sync", app]).out)).toEqual([]);
  }, 180000);

  test("соль номера машины: создаётся при первой записи блока, doctor и --dry-run её не создают", () => {
    const { A, app } = twoMachines();
    A.run(["doctor"]);
    A.run(["sync", app, "--dry-run"]);
    expect(existsSync(`${A.config}/local/state/machine-salt`)).toBe(false);
    expectCode(A.run(["sync", app]), 0);
    expect(read(`${A.config}/local/state/machine-salt`)).toMatch(/^[0-9a-f]{32}\n$/);
    expect(existsSync(`${A.config}/local/state/machine-id`)).toBe(false); // сам номер на диске не хранится
    expect(exclude(app)).toContain(`(машина ${machineId(A)}; `);
    if (process.platform !== "win32") expect(statSync(`${A.config}/local/state/machine-salt`).mode & 0o777).toBe(0o600);
  }, 180000);

  test("пересоздали local/ (ни соли, ни учёта): новый номер, прежний блок — «чужой»; его строки уходят, когда за ними нет файлов", () => {
    const { A, app } = twoMachines();
    put(`${A.config}/layers/tree/Cloud/skills/sk/SKILL.md`, skill("sk"));
    expectCode(A.run(["sync", app]), 0);
    const old = machineId(A);
    rmSync(`${A.config}/local/state`, { recursive: true });
    expectCode(A.run(["sync", app]), 0);
    const now = machineId(A);
    expect(now).not.toBe(old);
    expect(exclude(app)).toContain(`(машина ${old}; `);
    expect(status(app)).toBe("");
    // Файлы под строками прежнего блока clean не удаляет (не отличить от другой машины — безопасная сторона)
    const c = A.run(["clean", app]);
    expect(c.out).toContain("файл нужен и другой машине в общей папке — не удаляю");
    // Пользователь убрал файлы сам — строки прежнего блока снимаются уборкой, блок исчезает
    rmSync(`${app}/.claude/skills`, { recursive: true });
    rmSync(`${app}/CLAUDE.local.md`, { force: true });
    expectCode(A.run(["sync", app]), 0);
    expect(exclude(app)).not.toContain(`машина ${old}`);
  }, 180000);

  test("копия local/ (с солью) на другом компьютере — другой номер; восстановление на том же — прежний; в бэкапах miksy соли нет", () => {
    const { A, B, app } = twoMachines();
    expectCode(A.run(["sync", app]), 0);
    expectCode(B.run(["sync", app]), 0);
    for (const f of [A, B]) expect(textFiles(`${f.config}/local/backups`).filter((p) => /machine-(salt|id)$/.test(p))).toEqual([]);
    const salt = read(`${A.config}/local/state/machine-salt`).trim();
    expect(idFrom("pc-1", salt)).toBe(idFrom("pc-1", salt));
    expect(idFrom("pc-2", salt)).not.toBe(idFrom("pc-1", salt));
    // Восстановление на том же компьютере: та же соль — тот же номер (sync без изменений)
    const before = read(`${A.config}/local/state/machine-salt`);
    rmSync(`${A.config}/local/state/machine-salt`);
    writeFileSync(`${A.config}/local/state/machine-salt`, before);
    expect(changes(A.run(["sync", app]).out)).toEqual([]);
  }, 180000);
});

describe("10z: номер компьютера от системы (поддельная система)", () => {
  const fake = (platform: string, out: Record<string, string>, files: Record<string, string> = {}): HardwareSource => ({
    platform, run: (cmd) => { ran.push(cmd[0]); return out[cmd[0].split(/[\\/]/).pop()!.replace(/\.exe$/i, "")] ?? null; }, read: (p) => files[p] ?? null,
  });
  const ran: string[] = [];
  test("Windows — MachineGuid, macOS — IOPlatformUUID (полные пути программ), Linux — /etc/machine-id, иначе /var/lib/dbus/machine-id; сбой — null, нет источника — пусто", () => {
    ran.length = 0;
    expect(computerId(fake("win32", { reg: "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    3F2504E0-4F89-11D3-9A0C-0305E82C3301\r\n" }))).toBe("3f2504e0-4f89-11d3-9a0c-0305e82c3301");
    expect(computerId(fake("darwin", { ioreg: '+-o J316sAP  <class IOPlatformExpertDevice>\n  {\n    "IOPlatformUUID" = "A1B2C3D4-0000-1111-2222-333344445555"\n  }\n' }))).toBe("a1b2c3d4-0000-1111-2222-333344445555");
    expect(computerId(fake("linux", {}, { "/etc/machine-id": "0123456789abcdef0123456789abcdef\n" }))).toBe("0123456789abcdef0123456789abcdef");
    expect(computerId(fake("linux", {}, { "/var/lib/dbus/machine-id": "fedcba\n" }))).toBe("fedcba");
    expect(computerId(fake("linux", {}, { "/etc/machine-id": "\n" }))).toBe("");
    expect(computerId(fake("freebsd", {}))).toBe("");
    // Сбой (не запустилась, ненулевой код, тайм-аут — run вернул null) и неразобранный вывод — номер неизвестен
    expect(computerId(fake("win32", {}))).toBeNull();
    expect(computerId(fake("win32", { reg: "ERROR: The system was unable to find the specified registry key" }))).toBeNull();
    expect(computerId(fake("darwin", {}))).toBeNull();
    expect(computerId(fake("darwin", { ioreg: "garbage" }))).toBeNull();
    expect(ran[0]).toMatch(/[\\/]System32[\\/]reg\.exe$/i);
    expect(ran).toContain("/usr/sbin/ioreg");
  });

  test("номер: 12 hex; две учётки на одном компьютере (свои local/ — свои соли) — разные номера; без номера компьютера — из соли; повторные запуски — тот же номер", () => {
    const salt = "00112233445566778899aabbccddeeff", other = "ffeeddccbbaa99887766554433221100";
    const a = idFrom("pc", salt), b = idFrom("pc", other);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
    expect(idFrom("", salt)).toMatch(/^[0-9a-f]{12}$/);
    expect(idFrom("", salt)).not.toBe(idFrom("", other));
    expect(idFrom("pc", salt)).toBe(a);
    // Через модуль: поддельная система, одна конфигурация — один и тот же номер при повторных вызовах
    const f = cliFixture();
    try {
      setHardwareSource(fake("linux", {}, { "/etc/machine-id": "pc-xyz\n" }));
      const id1 = ensureMachineId(f.config);
      expect(machineIdOf(f.config)).toBe(id1);
      setHardwareSource(fake("linux", {}, { "/etc/machine-id": "pc-xyz\n" }));
      expect(machineIdOf(f.config)).toBe(id1);
      // Другой компьютер с той же солью (копия local/) — другой номер
      setHardwareSource(fake("linux", {}, { "/etc/machine-id": "other\n" }));
      expect(machineIdOf(f.config)).not.toBe(id1);
      // Запасной случай: источника номера на ОС нет — номер из соли, стабилен
      setHardwareSource(fake("freebsd", {}));
      const z = machineIdOf(f.config);
      expect(z).toMatch(/^[0-9a-f]{12}$/);
      expect(machineIdOf(f.config)).toBe(z);
      // Номер компьютера никуда не записан
      expect(read(`${f.config}/local/state/machine-salt`)).not.toContain("xyz");
    } finally { setHardwareSource(null); }
  });
});
