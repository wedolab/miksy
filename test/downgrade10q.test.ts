// Круг 10q: miksy downgrade — откат движка на прежний выпуск. Песочница как update.test.ts: репо владельца (dev),
// «удалённый» bare и клон пользователя; выпуски — теги и ветка stable. Шаги прежней версии подставляются (записываются),
// кроме последних тестов: там клон настоящего движка с его тегами и настоящие v0.3.5, v0.3.2, v0.3.0 (тегов нет —
// пропуск, как downgrade022)
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { Ask } from "../src/ask";
import { parseArgs, UsageError } from "../src/args";
import { downgrade, DOWNGRADE_MIN, DowngradeRefused, OLD_RECIPE } from "../src/downgrade";
import { ENGINE } from "../src/load";
import { canonical } from "../src/paths";
import { update } from "../src/update";
import { cliFixture, expectCode, put } from "./helpers";
import { commit, hasTag } from "./fixes021b-helpers";
import { ledger } from "./rootshelp";

const ID = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (dir: string, ...a: string[]) => {
  const r = Bun.spawnSync(["git", "-C", dir, ...a], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...ID } });
  if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
const gitTop = (...a: string[]) => {
  const r = Bun.spawnSync(["git", ...a], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...ID } });
  if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: код ${r.exitCode}, ${r.stderr.toString()}`);
};

const entry = (v: string, s: Record<string, string[]>) =>
  `## ${v} — 2026-11-20\n\n${Object.entries(s).map(([k, l]) => `### ${k}\n\n${l.join("\n")}\n`).join("\n")}`;

// dev: выпуски 0.2.9, 0.3.0 (клон пользователя — на нём), затем release() — новые. Пользователь «обновляется»
// (fetch + merge --ff-only, как miksy update) — так в журнале stable появляются записи
function repos(o: { cloneAt?: "first" | "later" } = {}) {
  const dir = canonical(mkdtempSync(join(tmpdir(), "downgrade-")));
  const dev = `${dir}/dev`;
  put(`${dev}/.gitattributes`, "* text=auto eol=lf\n");
  put(`${dev}/CHANGELOG.md`, `# Изменения miksy\n\n${entry("0.2.9", { "Новое": ["- старая"] })}`);
  put(`${dev}/package.json`, JSON.stringify({ name: "miksy", version: "0.2.9" }) + "\n");
  git(dev, "init", "-q");
  git(dev, "symbolic-ref", "HEAD", "refs/heads/main");
  git(dev, "add", "-A");
  git(dev, "commit", "-q", "-m", "engine 0.2.9");
  git(dev, "tag", "-a", "v0.2.9", "-m", "miksy 0.2.9");
  git(dev, "branch", "stable");
  const bare = `${dir}/miksy.git`;
  gitTop("clone", "-q", "--bare", dev, bare);
  git(dev, "remote", "add", "origin", bare);
  const release = (v: string, s: Record<string, string[]> = { "Исправлено": [`- исправление ${v}`] }) => {
    const log = readFileSync(`${dev}/CHANGELOG.md`, "utf8").replace("# Изменения miksy\n\n", `# Изменения miksy\n\n${entry(v, s)}\n`);
    writeFileSync(`${dev}/CHANGELOG.md`, log);
    writeFileSync(`${dev}/package.json`, JSON.stringify({ name: "miksy", version: v }) + "\n");
    git(dev, "add", "-A");
    git(dev, "commit", "-q", "-m", `Release ${v}`);
    git(dev, "tag", "-a", `v${v}`, "-m", `miksy ${v}`);
    git(dev, "branch", "-f", "stable", "HEAD");
    git(dev, "push", "-q", "origin", "main", "stable", `v${v}`);
  };
  release("0.3.0", { "Новое": ["- команда restore"] });
  const user = `${dir}/user`;
  const clone = () => gitTop("clone", "-q", "-b", "stable", bare, user);
  if (o.cloneAt !== "later") clone();
  const pull = () => { git(user, "fetch", "-q", "origin"); git(user, "merge", "-q", "--ff-only", "origin/stable"); };
  const head = () => git(user, "rev-parse", "HEAD");
  const tagSha = (v: string) => git(user, "rev-parse", `v${v}^{commit}`);
  const journal = () => git(user, "log", "-g", "--format=%H", "refs/heads/stable").split("\n").length;
  const config = `${dir}/config`;
  put(`${config}/local/machine.yaml`, "workspace: /ws\nagents: [claude]\n");
  return { dir, dev, bare, user, clone, release, pull, head, tagSha, journal, config };
}

// Обычная история: 0.3.0 → 0.3.1 → 0.3.3 → 0.4.0, пользователь обновлялся на 0.3.3 и 0.4.0 (0.3.1 пропустил)
function history() {
  const r = repos();
  r.release("0.3.1");
  r.release("0.3.3", { "Исправлено": ["- ошибка Y"], "После обновления": ["- переименуйте агента gemini в agy"] });
  r.pull();
  r.release("0.4.0", { "Новое": ["- команда downgrade"] });
  r.pull();
  return r;
}

type Run = { code: number; out: string; steps: string[][]; asked: string[]; err: string };
function run(r: { user: string; config: string }, o: { version?: string; answers?: (boolean | string)[] | null; yes?: boolean; dryRun?: boolean; fail?: string; step?: (args: string[]) => void } = {}): Run {
  const out: string[] = [], steps: string[][] = [], asked: string[] = [];
  const list = o.answers === null ? null : [...(o.answers ?? [true])];
  const next = (q: string) => { asked.push(q.trim()); if (!list!.length) throw new Error(`лишний вопрос: ${q}`); return list!.shift()!; };
  const ask: Ask | null = list ? { yes: (q) => next(q) as boolean, choose: (q, _opts, def) => { const a = next(q); return a === "" ? def ?? null : a as string; }, line: () => null } : null;
  try {
    const code = downgrade({ engine: r.user, config: r.config, version: o.version, ask, yes: !!o.yes, dryRun: !!o.dryRun, log: (s = "") => out.push(s),
      step: (_e, args) => { steps.push(args); o.step?.(args); return args.join(" ") === o.fail ? 1 : 0; } });
    return { code, out: out.join("\n"), steps, asked, err: "" };
  } catch (e) {
    if (!(e instanceof DowngradeRefused)) throw e;
    return { code: -1, out: out.join("\n"), steps, asked, err: e.message };
  }
}
const ALL = [["setup", "--yes"], ["sync", "--global"], ["sync", "--all"], ["doctor"]];

describe("miksy downgrade — выбор версии", () => {
  test("без версии — прежняя по журналу stable; повторный откат идёт ниже, а не обратно на новую", () => {
    const r = history();
    const first = run(r);
    expect({ code: first.code, err: first.err, head: r.head(), steps: first.steps, asked: first.asked }, first.out)
      .toEqual({ code: 0, err: "", head: r.tagSha("0.3.3"), steps: ALL, asked: ["Откатить miksy до 0.3.3?"] });
    expect(git(r.user, "symbolic-ref", "--short", "HEAD")).toBe("stable");
    expect(first.out).toContain("Откат miksy: 0.4.0 → 0.3.3");
    expect(first.out).toContain("Что уйдёт (CHANGELOG, версии после 0.3.3):\n\n## 0.4.0");
    expect(first.out).toContain("- команда downgrade");
    expect(first.out).not.toContain("переименуйте агента");
    expect(first.out).toContain("✓ откат: 0.4.0 → 0.3.3. Вернуться на новую версию — miksy update.");
    const second = run(r);
    expect({ code: second.code, head: r.head() }).toEqual({ code: 0, head: r.tagSha("0.3.0") });
    expect(second.out).toContain("Откат miksy: 0.3.3 → 0.3.0");
    expect(second.out).toContain("Делали что-то из «После обновления» этих версий (например, правили конфигурацию) — после отката верните, как было:\n  0.3.3: - переименуйте агента gemini в agy");
    // Ниже 0.3.0 — только 0.2.9 (ниже границы): некуда
    const third = run(r, { answers: [] });
    expect({ code: third.code, err: third.err, head: r.head() }).toEqual({ code: -1, err: `выпусков ниже 0.3.0 (от ${DOWNGRADE_MIN}) нет — откатывать некуда`, head: r.tagSha("0.3.0") });
  }, 60000);

  test("журнала нет (клон сразу на новой, журнал стёрт) — список выпусков: в терминале выбор, без терминала и с --dry-run — только список", () => {
    const r = repos({ cloneAt: "later" });
    r.release("0.3.1");
    r.release("0.4.0");
    r.clone();
    git(r.user, "reflog", "expire", "--expire=now", "--all");
    const before = r.head();
    const none = run(r, { answers: null });
    expect({ code: none.code, head: r.head(), steps: none.steps }).toEqual({ code: 1, head: before, steps: [] });
    expect(none.out).toContain("Прежнюю версию не узнать: журнал ветки stable пуст, устарел (больше 90 дней) или до обновления движок был на ветке main.");
    expect(none.out).toMatch(/Выпуски ниже 0\.4\.0:\n  0\.3\.1 — выпуск 2026-11-20, сразу под нынешней\n  0\.3\.0 — выпуск 2026-11-20\nВыберите и выполните: miksy downgrade <версия> \(например, miksy downgrade 0\.3\.1\)\. Движок не изменён\./);
    expect(none.out).not.toContain("0.2.9");
    const dry = run(r, { dryRun: true, answers: [] });
    expect({ code: dry.code, head: r.head(), asked: dry.asked }).toEqual({ code: 0, head: before, asked: [] });
    // В терминале: Enter — сразу под нынешней; затем вопрос «Откатить?»
    const picked = run(r, { answers: ["", true] });
    expect({ code: picked.code, head: r.head(), asked: picked.asked }).toEqual({ code: 0, head: r.tagSha("0.3.1"), asked: ["Нынешняя версия — 0.4.0. На какую откатить?", "Откатить miksy до 0.3.1?"] });
  }, 60000);

  test("до обновления была версия ниже границы — сказано, и список того, на что можно", () => {
    const r = repos({ cloneAt: "later" });
    r.clone();
    git(r.user, "reset", "-q", "--hard", "v0.2.9");
    r.release("0.3.1");
    r.pull();
    const o = run(r, { answers: null });
    expect(o.code).toBe(1);
    expect(o.out).toContain(`До обновления у вас была 0.2.9 — на неё команда не откатывает (только на 0.3.0 и новее; старше — ${OLD_RECIPE}).\nВыпуски ниже 0.3.1:\n  0.3.0 — выпуск 2026-11-20, сразу под нынешней\n`);
  }, 60000);

  test("явная версия — с v и без; та же — «уже»; новее — miksy update; ниже границы — ссылка; нет тега — список; не номер", () => {
    const r = history();
    const at = r.head();
    expect(run(r, { version: "0.4.0", answers: [] }).out).toBe("Движок уже на версии 0.4.0.");
    expect(run(r, { version: "0.5.0", answers: [] }).err).toBe("0.5.0 новее нынешней 0.4.0 — это не откат. Новая версия — miksy update");
    expect(run(r, { version: "v0.2.9", answers: [] }).err).toBe(`откат на 0.2.9 командой не поддерживается — только на 0.3.0 и новее: версиям старше нужна подготовка вручную. Как откатиться на них — docs/update.md выпуска 0.3.5: ${OLD_RECIPE}`);
    expect(run(r, { version: "0.3.2", answers: [] }).err).toBe("выпуска 0.3.2 нет (тега v0.3.2 нет в движке и в удалённом репо). Выпуски ниже 0.4.0: 0.3.3, 0.3.1, 0.3.0");
    expect(run(r, { version: "три", answers: [] }).err).toBe("«три» — не номер версии (например, 0.3.3)");
    expect(r.head()).toBe(at);
    // 0.3.1 не было в журнале (пропущена) — явно можно
    const v = run(r, { version: "v0.3.1" });
    expect({ code: v.code, head: r.head() }).toEqual({ code: 0, head: r.tagSha("0.3.1") });
    expect(v.out).toContain("Что уйдёт (CHANGELOG, версии после 0.3.1):\n\n## 0.4.0");
    expect(v.out).toContain("## 0.3.3");
  }, 60000);

  test("тега нет в клоне, есть в удалённом репо — берётся оттуда", () => {
    const r = history();
    git(r.user, "tag", "-d", "v0.3.1");
    const o = run(r, { version: "0.3.1" });
    expect({ code: o.code, err: o.err, head: r.head() }).toEqual({ code: 0, err: "", head: r.tagSha("0.3.1") });
  }, 60000);
});

describe("miksy downgrade — отказы и без изменений", () => {
  test("не git-клон, detached, main, другая ветка, правки, свои коммиты (сохранены в ветке — можно)", () => {
    const r = history();
    const plain = `${r.dir}/plain`;
    put(`${plain}/package.json`, JSON.stringify({ version: "0.4.0" }));
    expect(run({ user: plain, config: r.config }, { answers: [] }).err).toMatch(/^движок .*plain — не git-клон, откатить его командой нельзя\./);
    git(r.user, "checkout", "-q", "--detach");
    expect(run(r, { answers: [] }).err).toMatch(/^движок не на ветке \(отдельный коммит, detached HEAD\)/);
    git(r.user, "checkout", "-q", "-b", "main");
    expect(run(r, { answers: [] }).err).toMatch(/^движок на ветке разработки main, а miksy downgrade возвращает прежний выпуск \(ветка stable\)\. Перейти на выпуски — miksy update/);
    git(r.user, "branch", "-m", "main", "mine");
    expect(run(r, { answers: [] }).err).toMatch(/^движок на ветке mine\. miksy downgrade откатывает ветку stable \(выпуски\): git -C .* checkout stable, затем miksy downgrade$/);
    git(r.user, "checkout", "-q", "stable");
    writeFileSync(`${r.user}/CHANGELOG.md`, "правка\n");
    expect(run(r, { answers: [] }).err).toMatch(/^в движке есть незакоммиченные правки — откат их не трогает и не начнётся:\n  M CHANGELOG\.md\n[\s\S]*git -C .* stash/);
    git(r.user, "commit", "-q", "-am", "своё");
    const own = r.head();
    expect(run(r, { answers: [] }).err).toMatch(/^в ветке stable движка есть свои коммиты \(их нет ни в одном выпуске\) — откат отвязал бы их от ветки\. Сохраните их в другой ветке: git -C .* branch stable-mine — затем miksy downgrade$/);
    expect(r.head()).toBe(own);
    git(r.user, "branch", "stable-mine");
    const ok = run(r, { version: "0.3.3" });
    expect({ code: ok.code, head: r.head(), mine: git(r.user, "rev-parse", "stable-mine") }).toEqual({ code: 0, head: r.tagSha("0.3.3"), mine: own });
  }, 60000);

  test("--dry-run, без терминала без --yes, ответ «нет» — движок, журнал и machine.yaml не тронуты, шагов нет", () => {
    const r = history();
    const snap = () => ({ head: r.head(), journal: r.journal(), machine: readFileSync(`${r.config}/local/machine.yaml`, "utf8") });
    const before = snap();
    const dry = run(r, { dryRun: true, answers: [] });
    expect({ code: dry.code, steps: dry.steps, ...snap() }).toEqual({ code: 0, steps: [], ...before });
    expect(dry.out).toContain("Что будет сделано:\n  1. движок — на выпуск 0.3.3: git -C ");
    expect(dry.out).toContain("checkout -B stable v0.3.3");
    expect(dry.out).toMatch(/\(--dry-run: ничего не изменено\)$/);
    const quiet = run(r, { answers: null });
    expect({ code: quiet.code, steps: quiet.steps, ...snap() }).toEqual({ code: 1, steps: [], ...before });
    expect(quiet.out).toContain("3. без терминала — только команды: miksy sync --global и miksy sync --all");
    expect(quiet.out).toMatch(/Без терминала откат — только с --yes \(агенту — после «да» пользователя\): miksy downgrade 0\.3\.3 --yes\. Движок не изменён\.$/);
    const no = run(r, { answers: [false] });
    expect({ code: no.code, steps: no.steps, asked: no.asked, ...snap() }).toEqual({ code: 1, steps: [], asked: ["Откатить miksy до 0.3.3?"], ...before });
    expect(no.out).toMatch(/Отменено, движок не изменён\.$/);
  }, 60000);

  test("без терминала с --yes — checkout и setup --yes, sync — командами в выводе", () => {
    const r = history();
    const o = run(r, { answers: null, yes: true });
    expect({ code: o.code, head: r.head(), steps: o.steps }).toEqual({ code: 0, head: r.tagSha("0.3.3"), steps: [["setup", "--yes"]] });
    expect(o.out).toMatch(/Настройки агентов пока записаны версией 0\.4\.0\. Записать их версией 0\.3\.3 \(агенту — после «да» пользователя\): miksy sync --global и miksy sync --all, затем проверка: miksy doctor\. Вернуться на новую версию — miksy update\.$/);
    expect(o.out).not.toContain("о доверии Claude");
  }, 60000);

  test("сбой шага — стоп и оставшиеся команды; движок уже прежний", () => {
    const r = history();
    const setup = run(r, { fail: "setup --yes" });
    expect({ code: setup.code, steps: setup.steps, head: r.head() }).toEqual({ code: 1, steps: [["setup", "--yes"]], head: r.tagSha("0.3.3") });
    expect(setup.out).toMatch(/Шаг «miksy setup --yes» не выполнен \(код 1\)\. Движок уже на 0\.3\.3: исправьте сказанное выше и выполните miksy setup --yes, затем miksy sync --global, затем miksy sync --all\. Вернуться на новую версию — miksy update$/);
    const all = run(r, { fail: "sync --all" });
    expect(all.steps).toEqual([["setup", "--yes"], ["sync", "--global"], ["sync", "--all"]]);
    expect(all.out).toContain("Движок уже на 0.3.0: исправьте сказанное выше и выполните miksy sync --all. Вернуться");
    expect(all.out).toContain("Если sync спросит о доверии Claude проекту, где вы сами отвечали Claude «да, больше не спрашивать»");
  }, 60000);

  test("на 0.3.2 и ниже: setup ещё впереди — после него вернуть строку agents, затем sync; setup прошёл — только sync; без терминала — sync после «да»", () => {
    const r = history();
    const back = "затем верните в local/machine.yaml строку «agents: [claude]» (версия 0.3.1 дописывает туда всех найденных агентов)";
    const setup = run(r, { version: "0.3.1", fail: "setup --yes" });
    expect(setup.out).toContain(`если прервётся, выполните сами: miksy setup --yes, ${back}, затем miksy sync --global, затем miksy sync --all.`);
    expect(setup.out).toMatch(new RegExp(`Движок уже на 0\\.3\\.1: исправьте сказанное выше и выполните miksy setup --yes, ${back.replace(/[.()[\]]/g, "\\$&")}, затем miksy sync --global, затем miksy sync --all\\. Вернуться на новую версию — miksy update$`));
    expect(setup.out).not.toContain("после «да» пользователя)");
    // setup прошёл, сбой на sync --global — строка agents уже возвращена, совет — только оставшиеся sync
    const sync = run(r, { version: "0.3.0", fail: "sync --global" });
    expect(sync.out).toMatch(/Движок уже на 0\.3\.0: исправьте сказанное выше и выполните miksy sync --global, затем miksy sync --all\. Вернуться на новую версию — miksy update$/);
    // Без терминала: те же советы и оговорка о sync
    const r2 = history();
    const quiet = run(r2, { version: "0.3.1", answers: null, yes: true, fail: "setup --yes" });
    const tail = `miksy setup --yes, ${back}, затем miksy sync --global, затем miksy sync --all (sync агенту — только после «да» пользователя)`;
    expect(quiet.out).toContain(`если прервётся, выполните сами: ${tail}.`);
    expect(quiet.out).toContain(`Движок уже на 0.3.1: исправьте сказанное выше и выполните ${tail}. Вернуться на новую версию — miksy update`);
    const r3 = history();
    const ok = run(r3, { version: "0.3.3", answers: null, yes: true });
    expect(ok.out).toContain("если прервётся, выполните сами: miksy setup --yes, затем miksy sync --global, затем miksy sync --all (sync агенту — только после «да» пользователя).");
  }, 60000);

  test("на 0.3.2 и ниже — дописанные прежней версией агенты убираются; выше — не трогаются", () => {
    const r = history();
    const machine = `${r.config}/local/machine.yaml`;
    const append = (args: string[]) => { if (args[0] === "setup") writeFileSync(machine, readFileSync(machine, "utf8").replace("agents: [claude]", "agents: [claude, codex, opencode]")); };
    const high = run(r, { version: "0.3.3", step: append });
    expect(high.code).toBe(0);
    expect(readFileSync(machine, "utf8")).toBe("workspace: /ws\nagents: [claude, codex, opencode]\n");
    expect(high.out).not.toContain("дописывают в agents");
    writeFileSync(machine, "workspace: /ws\nagents: [claude]\n");
    const low = run(r, { version: "0.3.1", step: append });
    expect(low.code).toBe(0);
    expect(readFileSync(machine, "utf8")).toBe("workspace: /ws\nagents: [claude]\n");
    expect(low.out).toContain("Версии 0.3.2 и раньше в шаге 2 дописывают в agents (local/machine.yaml) всех агентов, найденных на машине, — downgrade вернёт список, как был.");
    expect(low.out).toContain("↩ 0.3.1 дописала в agents (local/machine.yaml) найденных агентов codex, opencode — убрано, список как был: agents: [claude]");
  }, 60000);

  test("после отката miksy update предлагает новую: «нет» — остаётся прежняя, «да» — снова новая", () => {
    const r = history();
    const latest = r.head();
    expect(run(r).code).toBe(0);
    const old = r.head();
    const asked: string[] = [], out: string[] = [];
    const ans = (a: boolean[]): Ask => ({ yes: (q) => { asked.push(q); return a.shift()!; }, choose: () => null, line: () => null });
    const opts = { engine: r.user, yes: false, check: false, main: false, log: (s = "") => out.push(s), finish: () => 0 };
    expect(update({ ...opts, ask: ans([false]) })).toBe(1);
    expect({ asked, head: r.head() }).toEqual({ asked: ["Обновить движок до 0.4.0?"], head: old });
    expect(out.join("\n")).toContain("Новая версия: 0.4.0; у вас 0.3.3.");
    expect(update({ ...opts, ask: ans([true]) })).toBe(0);
    expect(r.head()).toBe(latest);
  }, 60000);

  test("аргументы: одна версия, --dry-run, --yes; лишнее — ошибка до действий", () => {
    expect(parseArgs("downgrade", ["0.3.4", "--dry-run", "--yes"])).toEqual({ flags: { "dry-run": "", yes: "" }, positional: ["0.3.4"] });
    expect(() => parseArgs("downgrade", ["0.3.4", "0.3.3"])).toThrow(UsageError);
    expect(() => parseArgs("downgrade", ["--force"])).toThrow(UsageError);
  });
});

// Настоящие прежние версии: клон этого движка (с тегами) в песочнице, сверху — «выпуск» 0.99.0 (код v0.3.5, номер
// выше). Состояние конфигурации пишет эта версия; откат downgrade — шаги настоящим прежним движком (процессы, без
// терминала у них: stdin закрыт), ответ «да» — как в терминале
const REAL = ["v0.3.5", "v0.3.2", "v0.3.0"].every((t) => hasTag(t));
function realRepos() {
  const dir = canonical(mkdtempSync(join(tmpdir(), "downgrade-real-")));
  const bare = `${dir}/miksy.git`, dev = `${dir}/dev`, user = `${dir}/user`;
  gitTop("clone", "-q", "--bare", "--no-local", ENGINE, bare);
  gitTop("clone", "-q", bare, dev);
  git(dev, "checkout", "-q", "-B", "stable", "v0.3.5");
  const pkg = readFileSync(`${dev}/package.json`, "utf8");
  writeFileSync(`${dev}/package.json`, pkg.replace(/"version": "[^"]+"/, '"version": "0.99.0"'));
  const log = readFileSync(`${dev}/CHANGELOG.md`, "utf8");
  writeFileSync(`${dev}/CHANGELOG.md`, log.replace("\n## 0.3.5", "\n## 0.99.0 — 2026-12-01\n\n### Новое\n\n- проверочный выпуск\n\n## 0.3.5"));
  git(dev, "commit", "-q", "-am", "Release 0.99.0");
  git(dev, "tag", "-a", "v0.99.0", "-m", "miksy 0.99.0");
  git(dev, "push", "-q", "-f", "origin", "stable", "v0.99.0");
  gitTop("clone", "-q", "-b", "stable", bare, user);
  return { dir, user, tagSha: (v: string) => git(user, "rev-parse", `v${v}^{commit}`), head: () => git(user, "rev-parse", "HEAD") };
}

// Конфигурация песочницы: sync --all, root add с веткой, доверие с серверами .mcp.json, clean одного проекта.
// В PATH — поддельный codex: прежние версии ≤0.3.2 дописали бы его в agents. Команда miksy (setup --yes) — в HOME
// песочницы и первой в PATH, как у пользователя: иначе прежняя версия видит в PATH чужую команду и не переписывает
// отметку версии в учёте
function realState() {
  const f = cliFixture({ projects: ["Org/p1", "Org/p2"] });
  const bin = `${f.dir}/bin`, shims = `${f.home}/.bun/bin`;
  mkdirSync(bin, { recursive: true });
  writeFileSync(`${bin}/codex`, "#!/bin/sh\nexit 0\n");
  chmodSync(`${bin}/codex`, 0o755);
  writeFileSync(`${bin}/codex.cmd`, "@exit /b 0\r\n");
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const env = { ...process.env, MIKSY_CONFIG: f.config, HOME: f.home, USERPROFILE: f.home, BUN_INSTALL: `${f.home}/.bun`,
    [pathKey]: [shims, bin, process.env[pathKey]].join(delimiter) };
  const p2 = `${f.ws}/Org/p2`, side = `${f.dir}/side`;
  mkdirSync(`${side}/Team/p3`, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", `${side}/Team/p3`]);
  commit(p2, { ".mcp.json": JSON.stringify({ mcpServers: { team: { command: "team-server" } } }) });
  for (const a of [["sync", "--all", "--yes"], ["root", "add", side, "--tree", "Side"], ["trust", p2, "--confirm"], ["sync", "--all", "--yes"], ["clean", `${f.ws}/Org/p1`]])
    expectCode(f.run(a), 0);
  const outs: string[] = [];
  const step = (e: string, args: string[]) => {
    const r = Bun.spawnSync([process.execPath, join(e, "src", "cli.ts"), ...args], { cwd: f.dir, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    outs.push(`$ ${args.join(" ")} → ${r.exitCode}\n${r.stdout.toString()}${r.stderr.toString()}`);
    return r.exitCode ?? 1;
  };
  return { f, env, step, outs };
}
const realRun = (r: { user: string }, s: ReturnType<typeof realState>, version: string) => {
  const out: string[] = [];
  const code = downgrade({ engine: r.user, config: s.f.config, version, ask: { yes: () => true, choose: () => null, line: () => null }, yes: false, dryRun: false, log: (x = "") => out.push(x), step: s.step });
  return { code, out: out.join("\n"), steps: s.outs.join("\n") };
};
const trouble = (s: string) => s.split("\n").filter((l) => /Ошибка|конфликт|повреждён|не разбирается|не выполнен/i.test(l));

describe.skipIf(!REAL)("miksy downgrade настоящими прежними версиями", () => {
  test("0.99.0 → 0.3.5: шаги прежней версией без ошибок и конфликтов; update прежней версией возвращает новую", () => {
    const r = realRepos();
    const s = realState();
    const o = realRun(r, s, "0.3.5");
    expect({ code: o.code, head: r.head(), trouble: trouble(o.steps) }, o.out + "\n" + o.steps).toEqual({ code: 0, head: r.tagSha("0.3.5"), trouble: [] });
    expect(o.steps).toContain("$ setup --yes → 0");
    expect(o.steps).toContain("$ sync --all → 0");
    expect(Object.keys(ledger(s.f.config).targets).length).toBeGreaterThan(0);
    expect(readFileSync(`${s.f.config}/local/machine.yaml`, "utf8")).toMatch(/^agents: \[claude\]$/m);
    const back = Bun.spawnSync([process.execPath, `${r.user}/src/cli.ts`, "update", "--yes"], { cwd: s.f.dir, env: s.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const said2 = back.stdout.toString() + back.stderr.toString();
    expect({ code: back.exitCode, head: r.head() }, said2).toEqual({ code: 0, head: r.tagSha("0.99.0") });
    expect(said2).toContain("Новая версия: 0.99.0; у вас 0.3.5.");
  }, 240000);

  test("0.99.0 → 0.3.2: дописанный ею codex из agents убран; sync без ошибок", () => {
    const r = realRepos();
    const s = realState();
    const o = realRun(r, s, "0.3.2");
    expect({ code: o.code, head: r.head(), trouble: trouble(o.steps) }, o.out + "\n" + o.steps).toEqual({ code: 0, head: r.tagSha("0.3.2"), trouble: [] });
    // Кроме поддельного codex прежняя дописывает и агентов, найденных на этой машине (opencode и т. п.)
    expect(o.steps).toMatch(/добавлены агенты: [^\n]*\bcodex\b/);
    expect(o.out).toMatch(/↩ 0\.3\.2 дописала в agents \(local\/machine\.yaml\) найденных агентов [^\n]*\bcodex\b[^\n]* — убрано, список как был: agents: \[claude\]/);
    expect(readFileSync(`${s.f.config}/local/machine.yaml`, "utf8")).toMatch(/^agents: \[claude\]$/m);
    expect(o.steps).not.toContain(".codex");
  }, 240000);

  test("0.99.0 → 0.3.0 (граница): шаги без ошибок и конфликтов", () => {
    const r = realRepos();
    const s = realState();
    const o = realRun(r, s, "0.3.0");
    expect({ code: o.code, head: r.head(), trouble: trouble(o.steps) }, o.out + "\n" + o.steps).toEqual({ code: 0, head: r.tagSha("0.3.0"), trouble: [] });
    expect(readFileSync(`${s.f.config}/local/machine.yaml`, "utf8")).toMatch(/^agents: \[claude\]$/m);
  }, 240000);
});

