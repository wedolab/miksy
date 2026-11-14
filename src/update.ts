// miksy update — обновление движка до новой версии (DESIGN §12). Пользователи живут на ветке stable
// (последний релиз, тег vX.Y.Z), владелец разрабатывает в main. Обновление — только fast-forward чистого
// дерева: ничего не перезаписывается, локальные правки и коммиты не теряются (иначе — отказ с
// объяснением). Шаги после обновления выполняет уже новый код (новый процесс Bun: update --finish)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ask } from "./ask";
import { entriesBetween, entryText, hasSection, isEmpty, parseChangelog, type Entry } from "./changelog";
import { doctor } from "./doctor";
import { gitEnv } from "./git";
import { ENGINE, loadMachine } from "./load";
import { quoteArg, slash } from "./paths";
import { agentsFor } from "./registry";
import { planSummary, type Run, setup } from "./setup";
import type { Machine } from "./types";
import { compareVersions, describeEngine, engineRepo, engineVersion, packageVersion, SEMVER } from "./version";

export const STABLE = "stable";
export const MAIN = "main";

export class UpdateRefused extends Error {}

export type UpdateOptions = {
  engine?: string;
  ask: Ask | null; // null — без терминала: обновление только с --yes
  yes: boolean;
  check: boolean;
  main: boolean;
  log?: (s?: string) => void;
  // Шаги после обновления — новым кодом; по умолчанию новый процесс Bun: <движок>/src/cli.ts update --finish
  finish?: (engine: string, from: string) => number;
};

type Git = (args: string[], net?: boolean) => { code: number; out: string; err: string };

// git в каталоге движка. Сетевые команды без терминала не спрашивают учётные данные (иначе агент
// повис бы на запросе) и ограничены по времени
function gitIn(engine: string, interactive: boolean): Git {
  return (args, net = false) => {
    const env: Record<string, string | undefined> = { ...gitEnv() };
    if (net && !interactive) Object.assign(env, { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" });
    try {
      const r = Bun.spawnSync(["git", "-C", engine, ...args], { stdout: "pipe", stderr: "pipe", env, ...(net && { timeout: 180_000 }) });
      return { code: r.exitCode ?? -1, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
    } catch (e) {
      return { code: -1, out: "", err: (e as Error).message };
    }
  };
}

const lastLine = (s: string) => s.split("\n").filter((l) => l.trim()).pop() ?? "";
// Ошибка сети git: последняя строка и, если похоже на отказ в доступе (репо приватный), — как войти
const netError = (err: string, code: number) => `${lastLine(err) || `код ${code}`}${
  /could not read Username|Authentication failed|Permission denied|Repository not found|terminal prompts disabled/i.test(err)
    ? ". Нет доступа к репо: войдите в GitHub (gh auth login, затем gh auth setup-git) или клонируйте по SSH-адресу" : ""}`;
const versionOf = (pkg: string | null) => {
  try {
    const v = pkg && (JSON.parse(pkg) as { version?: unknown }).version;
    return typeof v === "string" && SEMVER.test(v) ? v : null;
  } catch { return null; }
};

// Шаги после обновления — уже новым кодом (update --finish в новом процессе): безопасная часть setup
// (команда miksy и т. п.), doctor, сводка плана sync --global/--all --dry-run и вопрос о записи
// агентам; без терминала — только подсказка команд. from — версия до обновления: напомнить «После
// обновления» из записей CHANGELOG между ней и этой версией
export function finishUpdate(o: { from: string; ask: Ask | null; run: Run; log?: (s?: string) => void; engine?: string }): number {
  const log = o.log ?? ((s = "") => console.log(s));
  const engine = o.engine ?? ENGINE;
  const now = packageVersion(engine);
  log(`\n── После обновления (шаги miksy ${engineVersion(engine)})`);
  let text: string | null = null;
  try { text = readFileSync(join(engine, "CHANGELOG.md"), "utf8"); } catch { /* нет — нечего напоминать */ }
  let after: string[] = [];
  try {
    after = text ? entriesBetween(parseChangelog(text).entries, o.from, now)
      .flatMap((e) => (e.sections["После обновления"] ?? []).filter((l) => l.trim()).map((l) => `  ${e.version}: ${l.trim()}`)) : [];
  } catch { /* CHANGELOG не разбирается — update показал это до обновления */ }
  if (after.length) log(`\nПосле обновления нужно (CHANGELOG):\n${after.join("\n")}`);

  log("\n1. Команда miksy и local/ (setup --yes, только безопасная часть)");
  try { setup({ ask: null, force: false, hints: false, log, engine }); }
  catch (e) { log(`Ошибка setup: ${(e as Error).message}\nДвижок обновлён, но setup не выполнен: исправьте сказанное выше, затем miksy setup --yes`); }

  let machine: Machine;
  try { machine = loadMachine(); }
  catch (e) {
    log(`\n${(e as Error).message}\nДальше: miksy setup`);
    return 1;
  }
  log("\n2. Проверка (miksy doctor)");
  try {
    const d = doctor(agentsFor(machine), machine, false);
    for (const l of d.text.split("\n")) if (l && !l.startsWith(" ")) log(`  ${l}`);
    if (d.problems) log("  подробно: miksy doctor");
  } catch (e) { log(`  Ошибка: ${(e as Error).message}`); }

  log("\n3. Что изменится у агентов (sync --global --dry-run, sync --all --dry-run)");
  const plan = planSummary(o.run);
  for (const l of plan.lines) log(l);
  const later = "miksy sync --global и miksy sync --all (план — с --dry-run)";
  // Запись откажет (C10): план не построен — что исправить и что затем, без вопроса «Записать?»
  if (plan.refused) {
    log(`\nПлан не построен: запись откажет (строка выше). Исправьте сказанное, затем miksy setup --yes и ${later}`);
    return 1;
  }
  if (!plan.changes) {
    log("\nЗаписывать агентам нечего — их настройки уже совпадают с конфигурацией.");
    return 0;
  }
  if (!o.ask) {
    log(`\nЗаписать настройки агентам (агенту — после «да» пользователя): ${later}`);
    return 0;
  }
  if (!o.ask.yes("\nЗаписать настройки агентам (sync --global и sync --all)?")) {
    log(`Не записано. Позже: ${later}`);
    return 0;
  }
  let code = 0;
  for (const args of [["--global"], ["--all"]]) {
    log(`\n$ miksy sync ${args.join(" ")}`);
    try { code = Math.max(code, o.run("sync", args, { ask: o.ask })); }
    catch (e) { log((e as Error).message); code = Math.max(code, 1); }
  }
  return code;
}

// Изменения между версиями по CHANGELOG новой версии: записи (from, to], отдельно — «Ломает» и
// «После обновления». unreleased — ещё и «Не выпущено» (обновление main владельца)
export function changesText(changelog: string | null, from: string | null, to: string | null, unreleased = false): string[] {
  if (!changelog) return ["(CHANGELOG.md в новой версии нет)"];
  let entries: Entry[];
  try { entries = parseChangelog(changelog).entries; }
  catch (e) { return [`(CHANGELOG.md не разбирается: ${(e as Error).message})`]; }
  const list = [
    ...(unreleased ? entries.filter((e) => e.version === null && !isEmpty(e)) : []),
    ...(to ? entriesBetween(entries, from, to) : []),
  ];
  if (!list.length) return ["(записей в CHANGELOG.md для этих версий нет)"];
  const out = [...list.flatMap((e) => [entryText(e), ""])];
  const label = (e: Entry) => e.version ?? "не выпущено";
  const breaking = list.filter((e) => hasSection(e, "Ломает"));
  if (breaking.length)
    out.push("ВНИМАНИЕ — ломает (прочитайте до обновления):", ...breaking.flatMap((e) => e.sections["Ломает"]!.filter((l) => l.trim()).map((l) => `  ${label(e)}: ${l.trim()}`)), "");
  const after = list.filter((e) => hasSection(e, "После обновления"));
  if (after.length)
    out.push("После обновления нужно:", ...after.flatMap((e) => e.sections["После обновления"]!.filter((l) => l.trim()).map((l) => `  ${label(e)}: ${l.trim()}`)), "");
  while (out.length && !out[out.length - 1]) out.pop();
  return out;
}

export function update(o: UpdateOptions): number {
  const engine = o.engine ?? ENGINE;
  const log = o.log ?? ((s = "") => console.log(s));
  const at = quoteArg(slash(engine));
  const g = gitIn(engine, !!o.ask);
  // Не репо (или каталог внутри чужого репо) — отказ «не git-клон»; другой сбой git — его сообщение
  const top = g(["rev-parse", "--show-toplevel"]);
  if (top.code !== 0 && !/not a git repository/i.test(top.err))
    throw new UpdateRefused(`git в каталоге движка не работает: ${lastLine(top.err) || `код ${top.code}`}`);
  if (!engineRepo(engine))
    throw new UpdateRefused(`движок ${slash(engine)} — не git-клон, обновить его командой нельзя. Скачайте движок заново (git clone -b ${STABLE} …, README, «Установка»), затем miksy setup`);
  const branch = g(["symbolic-ref", "--short", "-q", "HEAD"]).out;
  const current = describeEngine(engine);
  const curVersion = versionOf(g(["show", "HEAD:package.json"]).out);
  if (!branch)
    throw new UpdateRefused(`движок не на ветке (отдельный коммит, detached HEAD) — так обновлять нельзя. Вернитесь на ветку: git -C ${at} checkout ${STABLE}`);
  const remote = g(["config", `branch.${branch}.remote`]).out || "origin";
  const url = g(["remote", "get-url", remote]);
  if (url.code !== 0) throw new UpdateRefused(`у движка нет удалённого репо «${remote}» — обновляться неоткуда (git -C ${at} remote -v)`);
  const dirty = () => g(["status", "--porcelain", "--untracked-files=no"]).out;

  if (o.check) return check();

  if (branch === MAIN && !o.main) return switchToStable();
  if (o.main && branch !== MAIN)
    throw new UpdateRefused(`--main — обновление ветки разработки main (для владельца), а движок на ветке ${branch}. Обычное обновление: miksy update`);
  if (branch !== MAIN && branch !== STABLE)
    throw new UpdateRefused(`движок на ветке ${branch}. miksy update обновляет ветку ${STABLE} (последний релиз): git -C ${at} checkout ${STABLE}, затем miksy update`);
  requireClean();
  const target = branch === MAIN ? MAIN : STABLE;
  const ref = fetch(target);
  if (!ref) throw new UpdateRefused(`в удалённом репо (${url.out}) нет ветки ${target}`);
  const head = g(["rev-parse", "HEAD"]).out;
  if (head === ref.sha || ancestor(ref.sha, "HEAD")) {
    log(`У вас последняя версия: ${current}${branch === MAIN ? ` (ветка ${MAIN})` : ""}.`);
    return 0;
  }
  if (!ancestor("HEAD", ref.sha)) throw diverged(branch, ref.name);
  const next = versionOf(g(["show", `${ref.name}:package.json`]).out);
  log(`Новая версия: ${next ?? "?"}${branch === MAIN ? ` (ветка ${MAIN}, коммит ${ref.sha.slice(0, 7)})` : ""}; у вас ${current}.\n`);
  for (const l of changesText(show(`${ref.name}:CHANGELOG.md`), curVersion, next, branch === MAIN)) log(l);
  if (!confirm(`Обновить движок до ${next ?? ref.sha.slice(0, 7)}?`)) return 1;
  merge(ref.name);
  return done();

  // Ветка main без --main: предложить перейти на stable (последний релиз)
  function switchToStable(): number {
    log(`Движок на ветке разработки ${MAIN}, версия ${current}: туда попадают и промежуточные, не проверенные изменения.\nДля пользователей — ветка ${STABLE}: последний релиз.`);
    const ref = fetch(STABLE);
    if (!ref) {
      log(`В удалённом репо ещё нет ветки ${STABLE} (релизов пока нет) — оставайтесь на ${MAIN}. Обновить ${MAIN}: miksy update --main`);
      return 0;
    }
    requireClean();
    const local = g(["rev-parse", "--verify", "-q", `refs/heads/${STABLE}`]).out;
    if (local && !ancestor(local, ref.sha))
      throw new UpdateRefused(`локальная ветка ${STABLE} разошлась с ${ref.name} — перейти без потери коммитов нельзя. Сохраните её под другим именем: git -C ${at} branch -m ${STABLE} ${STABLE}-old, затем miksy update`);
    const next = versionOf(g(["show", `${ref.name}:package.json`]).out);
    log(`\nПерейти на ${STABLE}: ${current} → ${next ?? "?"}.`);
    if (!ancestor("HEAD", ref.sha))
      log(`В вашей копии ${MAIN} есть коммиты, которых нет в ${STABLE} (ещё не выпущены) — после перехода их не будет до следующего релиза. Ветка ${MAIN} остаётся как есть.`);
    if (next && (!curVersion || compareVersions(next, curVersion) > 0)) {
      log("");
      for (const l of changesText(show(`${ref.name}:CHANGELOG.md`), curVersion, next)) log(l);
    }
    if (!confirm(`Перейти на ветку ${STABLE} (версия ${next ?? "?"})?`)) return 1;
    const sw = local ? g(["checkout", "-q", STABLE]) : g(["checkout", "-q", "-b", STABLE, "--track", ref.name]);
    if (sw.code !== 0) throw new UpdateRefused(`git checkout не выполнен, движок не изменён: ${lastLine(sw.err)}`);
    if (local && local !== ref.sha) merge(ref.name);
    log(`\n✓ движок на ветке ${STABLE}. Дальше обновляйтесь командой miksy update.`);
    return done();
  }

  // --check: только «есть ли новая версия»; ls-remote ничего в репо не меняет (без fetch)
  function check(): number {
    const ls = g(["ls-remote", "--heads", "--tags", remote], true);
    if (ls.code !== 0) throw new UpdateRefused(`не удалось проверить ${url.out}: ${netError(ls.err, ls.code)}`);
    const refs = new Map<string, string>();
    for (const l of ls.out.split("\n")) {
      const [sha, name] = l.trim().split(/\s+/);
      if (sha && name) refs.set(name, sha);
    }
    const tags = [...refs.keys()].map((n) => /^refs\/tags\/v(\d+\.\d+\.\d+)$/.exec(n)?.[1]).filter((v): v is string => !!v)
      .map((v) => ({ v, sha: refs.get(`refs/tags/v${v}^{}`) ?? refs.get(`refs/tags/v${v}`)! }))
      .sort((a, b) => compareVersions(b.v, a.v));
    const stable = refs.get(`refs/heads/${STABLE}`);
    const release = stable ? tags.find((t) => t.sha === stable)?.v ?? tags[0]?.v ?? null : null;
    const head = g(["rev-parse", "HEAD"]).out;
    const has = (sha: string) => sha === head || (g(["cat-file", "-e", `${sha}^{commit}`]).code === 0 && ancestor(sha, "HEAD"));
    const note = dirty() ? `\n(В движке есть незакоммиченные правки — miksy update откажет, пока они есть: git -C ${at} status)` : "";
    if (branch === STABLE) {
      if (!stable) log(`В удалённом репо нет ветки ${STABLE} — проверять нечего.`);
      else if (has(stable)) log(`У вас последняя версия: ${current}.`);
      else log(`Есть новая версия: ${release ?? "(без номера)"}; у вас ${current}. Что изменилось и обновление: miksy update`);
    } else {
      log(`Движок на ветке ${branch} — ${branch === MAIN ? "ветка разработки" : `не ${STABLE}`}; версия ${current}.`);
      if (stable) log(`Последний релиз — ${release ?? "(без номера)"} (ветка ${STABLE}). ${branch === MAIN ? "Перейти на него: miksy update" : `Перейти: git -C ${at} checkout ${STABLE}`}`);
      else log(`Релизов (ветки ${STABLE}) в удалённом репо ещё нет.${branch === MAIN ? ` Обновить ${MAIN}: miksy update --main` : ""}`);
      const main = refs.get(`refs/heads/${MAIN}`);
      if (branch === MAIN && main && !has(main)) log(`В ${MAIN} есть новые коммиты: miksy update --main (для разработки).`);
    }
    if (note) log(note.slice(1));
    return 0;
  }

  // Ветка из удалённого репо (с тегами) → remote-tracking; нет такой ветки — null
  function fetch(name: string): { name: string; sha: string } | null {
    const r = g(["fetch", "--tags", "--quiet", remote, `+refs/heads/${name}:refs/remotes/${remote}/${name}`], true);
    if (r.code !== 0) {
      if (/couldn't find remote ref/i.test(r.err)) return null;
      throw new UpdateRefused(`git fetch из ${url.out} не выполнен: ${netError(r.err, r.code)}. Движок не изменён`);
    }
    const sha = g(["rev-parse", "--verify", "-q", `refs/remotes/${remote}/${name}^{commit}`]).out;
    return sha ? { name: `${remote}/${name}`, sha } : null;
  }

  function requireClean() {
    const d = dirty();
    if (d) throw new UpdateRefused(`в движке есть незакоммиченные правки — обновление их не трогает и не начнётся:\n${d.split("\n").slice(0, 10).map((l) => "  " + l).join("\n")}\nСвои правки движка держите в конфигурации (слои, map.yaml), а не в движке. Убрать их: git -C ${at} stash (вернуть потом: git -C ${at} stash pop) — затем miksy update`);
  }

  function ancestor(a: string, b: string) {
    return g(["merge-base", "--is-ancestor", a, b]).code === 0;
  }

  function diverged(branch: string, ref: string) {
    return new UpdateRefused(`ветка ${branch} движка разошлась с ${ref} (свои коммиты в движке или история в удалённом репо переписана) — обновление без потери невозможно, движок не изменён.\nСохраните свои коммиты в другой ветке: git -C ${at} branch ${branch}-mine\nи переведите ${branch} на удалённую: git -C ${at} checkout -B ${branch} ${ref}`);
  }

  function show(spec: string): string | null {
    const r = g(["show", spec]);
    return r.code === 0 ? r.out : null;
  }

  // Подтверждение: в терминале — [y/N]; без терминала — только --yes
  function confirm(q: string): boolean {
    if (o.yes) return true;
    if (!o.ask) {
      log(`\nБез терминала обновление — только с --yes (агенту — после «да» пользователя): miksy update${o.main ? " --main" : ""} --yes. Движок не изменён.`);
      return false;
    }
    if (o.ask.yes(q)) return true;
    log("Отменено, движок не изменён.");
    return false;
  }

  function merge(ref: string) {
    const r = g(["merge", "--ff-only", "-q", ref]);
    if (r.code !== 0) throw new UpdateRefused(`git merge --ff-only не выполнен: ${lastLine(r.err)}. Движок не изменён`);
  }

  // Обновлено: шаги после обновления — новым кодом
  function done(): number {
    log(`\n✓ движок обновлён: ${current} → ${describeEngine(engine)}`);
    const finish = o.finish ?? ((e: string, from: string) => {
      const r = Bun.spawnSync([process.execPath, join(e, "src", "cli.ts"), "update", "--finish", "--from", from], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      return r.exitCode ?? 1;
    });
    return finish(engine, curVersion ?? "0.0.0");
  }
}
