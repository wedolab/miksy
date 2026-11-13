// Выпуск 0.2.2, круг 8e, F3–F5, F7 (проверка 8d, находки 3, 4, 5, 7): рецепт README «Windows: откат с 0.2.2 на 0.2.1 …»
// с ссылками на файлы и с ошибками человека. Блоки README — дословно, в одном окне PowerShell (один скрипт). Настоящие
// v0.2.1 и v0.2.0 в песочнице. Только временные каталоги (тесты взяты у рецензента проверки 8d, out/check022d)
import { expect, test } from "bun:test";
import { lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { hasTag, oldEngine } from "./fixes021b-helpers";
import { badPaths, cli, closeTarget, type Close, nat, ps, psFile, put, read, sddl, sys32, tmp, win } from "./fixes022e-helpers";

const README = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");
const section = README.slice(README.indexOf("**Windows: откат с 0.2.2 на 0.2.1, 0.2.0 или 0.1.x, когда в `local/` есть ссылки.**"), README.indexOf("На macOS и Linux прежние версии в ссылки не заходят"));
const blocks = [...section.matchAll(/```\n([\s\S]*?)```/g)].map((m) => m[1].split("\n").map((l) => l.trim()).filter(Boolean).join("\n"));
// Блоки: 0 — пути, 1 — шаг 1, 2 — шаг 2, 3 — шаг 3, 4 — шаг 5
function steps(dir: string, config: string, order: number[]) {
  const body = order.map((i, k) => `"=== ${k}:${i}"\n${blocks[i]}`).join("\n").replaceAll("<конфигурация>", nat(config).replace(/['‘’‚‛]/g, "$&$&"));
  const r = psFile(dir, body);
  const parts = r.out.split(/^=== /m).slice(1).map((s) => { const [head, ...rest] = s.split(/\r?\n/); return { step: head.trim(), lines: rest.map((l) => l.trim()).filter(Boolean) }; });
  return { code: r.code, err: r.err.trim().slice(0, 600), parts };
}
const lines = (r: ReturnType<typeof steps>, k: number) => r.parts[k]?.lines ?? [];
const notClosed = (o: string) => o.split("\n").filter((l) => /не закрыт|icacls|ОШИБКА|Ошибка/.test(l)).map((l) => l.trim().slice(0, 250));

function world(o: { backups?: Close; secrets?: Close }) {
  const root = tmp("e2e-");
  const home = `${root}/home`, config = `${root}/my cfg's/config`, ws = `${root}/ws`, dot = `${root}/dotfiles`, vb = `${root}/vaultB`, vs = `${root}/vaultS`;
  put(`${config}/map.yaml`, "global:\n  - { use: global }\nlayers: []\n");
  put(`${config}/layers/global/instructions/00.md`, "# global\n");
  put(`${config}/layers/global/mcp/srv.yaml`, "name: srv\ncommand: echo\nenv:\n  A_TOKEN: ${A_TOKEN}\n");
  mkdirSync(`${ws}/Org/p1`, { recursive: true }); Bun.spawnSync(["git", "init", "-q", `${ws}/Org/p1`]);
  put(`${home}/.codex/config.toml`, "model = \"o3\"\n");
  put(`${dot}/agents-skills/s1/SKILL.md`, "---\nname: s1\ndescription: s\n---\n");
  put(`${dot}/claude-skills/c1/SKILL.md`, "---\nname: c1\ndescription: c\n---\n");
  mkdirSync(`${home}/.agents`, { recursive: true }); mkdirSync(`${home}/.claude`, { recursive: true });
  symlinkSync(`${dot}/agents-skills`, `${home}/.agents/skills`, "junction");
  symlinkSync(`${dot}/claude-skills`, `${home}/.claude/skills`, "junction");
  Bun.spawnSync([sys32("icacls.exe"), nat(`${dot}/agents-skills/s1/SKILL.md`), "/grant", "*S-1-5-32-545:(R)"]);
  mkdirSync(`${config}/local`, { recursive: true });
  for (const [which, v, how] of [["backups", vb, o.backups], ["secrets", vs, o.secrets]] as const) {
    if (!how) continue;
    mkdirSync(v, { recursive: true });
    closeTarget(v, how);
    symlinkSync(v, `${config}/local/${which}`, "junction");
  }
  put(`${config}/local/machine.yaml`, `workspace: ${ws}\nagents: [claude, codex, opencode]\n`);
  put(`${config}/local/secrets.env`, "A_TOKEN=abcdef123\n");
  const env = { MIKSY_CONFIG: config, HOME: home, USERPROFILE: home, BUN_INSTALL: `${root}/bun` };
  const now = cli(env, root);
  expect(now(["setup", "--yes", "--backup"]).code).toBe(0);
  now(["sync", "--global"]); now(["sync", "--all", "--yes"]);
  return { root, home, config, ws, dot, vb, vs, env, now };
}

// F3: ссылки на файлы в local/ (secrets.env на другом томе, файл секрета) — шаг 3 их не показывает; прежние версии их
// цели не трогают
for (const tag of ["v0.2.1", "v0.2.0"])
  test.skipIf(!win || !hasTag(tag))(`F3: ссылки на файлы в local/ — шаг 3 молчит, ${tag} целей не трогает`, () => {
    const root = tmp("e2fl-");
    const home = `${root}/home`, config = `${root}/config`, ws = `${root}/ws`, vault = `${root}/vault`;
    put(`${config}/map.yaml`, "global:\n  - { use: global }\nlayers: []\n");
    put(`${config}/layers/global/instructions/00.md`, "# global\n");
    put(`${config}/layers/global/mcp/srv.yaml`, "name: srv\ncommand: echo\nenv:\n  A_TOKEN: ${A_TOKEN}\n");
    put(`${config}/local/machine.yaml`, `workspace: ${ws}\nagents: [claude]\n`);
    mkdirSync(`${ws}/Org/p1`, { recursive: true }); Bun.spawnSync(["git", "init", "-q", `${ws}/Org/p1`]);
    mkdirSync(home, { recursive: true });
    put(`${vault}/secrets.env`, "A_TOKEN=abcdef123\n");
    put(`${vault}/A_TOKEN`, "abcdef123\n");
    for (const f of ["secrets.env", "A_TOKEN"]) Bun.spawnSync([sys32("icacls.exe"), nat(`${vault}/${f}`), "/grant", "*S-1-5-32-545:(R)"]);
    symlinkSync(`${vault}/secrets.env`, `${config}/local/secrets.env`, "file");
    mkdirSync(`${config}/local/secrets`, { recursive: true });
    symlinkSync(`${vault}/A_TOKEN`, `${config}/local/secrets/A_TOKEN`, "file");
    const env = { MIKSY_CONFIG: config, HOME: home, USERPROFILE: home, BUN_INSTALL: `${root}/bun` };
    const before = { env: sddl(`${vault}/secrets.env`), tok: sddl(`${vault}/A_TOKEN`) };
    const r = steps(root, config, [0, 1, 2, 3]);
    const old = cli(env, root, oldEngine(tag));
    const runs = [["setup", "--yes"], ["sync", "--global"], ["sync", "--all", "--yes"]].map((a) => old(a));
    const after = { env: sddl(`${vault}/secrets.env`), tok: sddl(`${vault}/A_TOKEN`) };
    expect({ err: r.err, step3: lines(r, 3), codes: runs.map((x) => x.code), template: /создан из шаблона/.test(runs[0].out), same: before.env === after.env && before.tok === after.tok, value: read(`${vault}/secrets.env`) })
      .toEqual({ err: "", step3: [], codes: [0, 0, 0], template: false, same: true, value: "A_TOKEN=abcdef123\n" });
  }, 600000);

// F4: пропущен шаг 1 (цели закрыты «только вам» без наследования) → v0.2.1 ломает свои папки → по шагу 4: назад на
// 0.2.2, шаг 5, miksy doctor — команда из строки дословно, затем шаги 1–3 — всё закрыто и читается, секрет читается
test.skipIf(!win || !hasTag("v0.2.1"))("F4: пропустил шаг 1 — шаг 4 ведёт к выходу: 0.2.2, doctor, команда из строки", () => {
  const w = world({ backups: "только вам", secrets: "только вам" });
  steps(w.root, w.config, [0, 2, 3]);
  const old = cli(w.env, w.root, oldEngine("v0.2.1"));
  put(`${w.config}/layers/global/instructions/00.md`, "# global v2\n");
  put(`${w.config}/local/secrets.env`, "A_TOKEN=changed456\n");
  const back = [["setup", "--yes"], ["sync", "--global"], ["sync", "--all", "--yes"], ["sync", "--global"]].map((a) => old(a));
  // Шаг 4: появилось «не закрыт» / «icacls не закрыл»
  expect(back.some((r) => /не закрыт|icacls не закрыл/.test(r.out))).toBe(true);
  expect(README).toContain("и запустите `miksy doctor`. Строка с готовой командой в конце");
  // Назад на 0.2.2: шаг 5, miksy doctor — строка с готовой командой, выполнить; затем шаги 1–3
  steps(w.root, w.config, [0, 4]);
  const doc = w.now(["doctor"]);
  const cmd = doc.out.match(/\(PowerShell\): (.+)$/m)?.[1]?.trim() ?? "";
  const fix = ps(cmd);
  const again = steps(w.root, w.config, [0, 1, 2, 3]);
  const n = [w.now(["sync", "--global"]), w.now(["sync", "--all", "--yes"])];
  const doc2 = w.now(["doctor"]);
  const secret = (() => { try { return readFileSync(`${w.vs}/A_TOKEN`, "utf8"); } catch (e) { return `не читается: ${(e as Error).message.slice(0, 80)}`; } })();
  expect({
    cmd: /Закройте папку бэкапов и всё в ней|закройте вручную/.test(doc.out) && !!cmd, fix: fix.exitCode, err: again.err, step3: lines(again, 3),
    n: n.map((r) => [r.code === 3 ? 0 : r.code, notClosed(r.out)]), backups: /не пишет туда|Закройте папку/.test(doc2.out), secret, badB: badPaths(w.vb), badS: badPaths(w.vs),
  }).toEqual({ cmd: true, fix: 0, err: "", step3: [], n: [[0, []], [0, []]], backups: false, secret: "changed456\n", badB: [], badS: [] });
}, 600000);

// F5: пропущен шаг 2 — шаг 3 показывает ссылки внутри копии «до miksy»; по README — сначала шаг 2, затем проверка снова
test.skipIf(!win)("F5: пропустил шаг 2 — шаг 3 показывает ссылки копии; шаг 2 и снова шаг 3 — пусто, копия цела", () => {
  const w = world({});
  const r = steps(w.root, w.config, [0, 1, 3]);
  const printed = lines(r, 2);
  const again = steps(w.root, w.config, [0, 2, 3]);
  const moved = lines(again, 1)[0]?.replace(/^вынесена: /, "") ?? "";
  expect({ printed: printed.length, inCopy: printed.every((p) => /\\before-miksy-[^\\]+\\/.test(p)), step3: lines(again, 2), links: [".agents/skills", ".claude/skills"].map((l) => lstatSync(`${moved}/${l}`).isSymbolicLink()) })
    .toEqual({ printed: 2, inCopy: true, step3: [], links: [true, true] });
  expect(README).toContain("Путь внутри папки `before-miksy-…` — копия «до miksy» не вынесена: сначала шаг 2");
}, 600000);

// F7: шаг 2 без папки local/backups — ничего не печатает, ошибок нет
test.skipIf(!win)("F7: шаг 2 без папки local/backups — ничего не печатает", () => {
  const root = tmp("e2nb-");
  const config = `${root}/config`;
  put(`${config}/local/machine.yaml`, `workspace: ${root}/ws\nagents: [claude]\n`);
  const r = steps(root, config, [0, 2]);
  expect({ out: lines(r, 1), err: r.err }).toEqual({ out: [], err: "" });
}, 120000);

// Полный круг с повторами: 1,1,2,2,3 → v0.2.1 → 5,5 → 0.2.2 — по-прежнему
test.skipIf(!win || !hasTag("v0.2.1"))("E2: шаги дважды и полный круг: 1,1,2,2,3 → 0.2.1 → 5,5 → 0.2.2", () => {
  const w = world({ backups: "только вам", secrets: "miksy" });
  const dotAcl = sddl(`${w.dot}/agents-skills/s1/SKILL.md`), dotText = read(`${w.dot}/agents-skills/s1/SKILL.md`);
  const a = steps(w.root, w.config, [0, 1, 1, 2, 2, 3]);
  const old = cli(w.env, w.root, oldEngine("v0.2.1"));
  const back = [["setup", "--yes"], ["sync", "--global"], ["sync", "--all", "--yes"]].map((x) => old(x));
  const b = steps(w.root, w.config, [0, 4, 4]);
  const again = [w.now(["setup", "--yes"]), w.now(["sync", "--global"]), w.now(["sync", "--all", "--yes"])];
  const doc = w.now(["doctor"]);
  const copy = readdirSync(w.vb).find((d) => d.startsWith("before-miksy-"));
  expect({
    aerr: a.err, back: back.map((r) => r.code), berr: b.err, again: again.map((r) => (r.code === 3 ? 0 : r.code)),
    copy: !!copy, links: copy ? [".agents/skills", ".claude/skills"].map((l) => lstatSync(`${w.vb}/${copy}/${l}`).isSymbolicLink()) : [],
    unsafe: /Небезопасные права|не пишет туда|закройте/.test(doc.out), badB: badPaths(w.vb).length,
    dot: sddl(`${w.dot}/agents-skills/s1/SKILL.md`) === dotAcl && read(`${w.dot}/agents-skills/s1/SKILL.md`) === dotText,
  }).toEqual({ aerr: "", back: [0, 0, 0], berr: "", again: [0, 0, 0], copy: true, links: [true, true], unsafe: false, badB: 0, dot: true });
}, 600000);
