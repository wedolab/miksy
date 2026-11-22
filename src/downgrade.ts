// miksy downgrade — откат движка на прежний выпуск (DESIGN §12, круг 10q). Ветка stable ставится на тег прежней
// версии (git checkout -B stable vX), затем шаги выполняет уже прежняя версия — отдельными процессами её движка
// (setup --yes, sync --global, sync --all, doctor): так настройки агентов пишутся так, как их пишет она. Всё, что
// нужно этому процессу (CHANGELOG, local/machine.yaml), читается до checkout: после него на диске — прежний код.
// Ниже DOWNGRADE_MIN — отказ: старым версиям нужна ручная подготовка (рецепт — в docs/update.md выпуска 0.3.5)
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ask } from "./ask";
import { entriesBetween, entryText, parseChangelog, type Entry } from "./changelog";
import { configRoot, ENGINE } from "./load";
import { writeAtomic } from "./manifest";
import { quoteArg, slash } from "./paths";
import { gitIn, lastLine, MAIN, netError, STABLE, versionOf } from "./update";
import { engineBunArgs } from "./shim";
import { compareVersions, engineRepo, SEMVER } from "./version";

export const DOWNGRADE_MIN = "0.3.0";
export const OLD_RECIPE = "https://github.com/wedolab/miksy/blob/v0.3.5/docs/update.md#откатиться-на-прежнюю-версию";
// До этой версии включительно setup --yes дописывает в agents всех найденных агентов (с 0.3.3 — только с вопросом)
const APPENDS_AGENTS = "0.3.2";
// Строка agents одной строкой — её и дописывают прежние версии (другой вид списка они не трогают)
const AGENTS_LINE = /^agents:[ \t]*\[([^\]\r\n]*)\][ \t]*$/m;

export class DowngradeRefused extends Error {}

export type DowngradeOptions = {
  engine?: string;
  config?: string;
  version?: string; // без версии — прежняя по журналу ветки stable
  ask: Ask | null; // null — без терминала: откат только с --yes, sync — командами в выводе
  yes: boolean;
  dryRun: boolean;
  log?: (s?: string) => void;
  // Шаг прежней версией; по умолчанию — новый процесс Bun: <движок>/src/cli.ts <args>
  step?: (engine: string, args: string[]) => number;
};

const cmd = (a: string[]) => `miksy ${a.join(" ")}`;
const names = (line: string | undefined) => (line ? AGENTS_LINE.exec(line)?.[1] ?? "" : "").split(",").map((s) => s.trim()).filter(Boolean);

export function downgrade(o: DowngradeOptions): number {
  const engine = o.engine ?? ENGINE;
  const log = o.log ?? ((s = "") => console.log(s));
  const at = quoteArg(slash(engine));
  const g = gitIn(engine, !!o.ask);
  const top = g(["rev-parse", "--show-toplevel"]);
  if (top.code !== 0 && !/not a git repository/i.test(top.err))
    throw new DowngradeRefused(`git в каталоге движка не работает: ${lastLine(top.err) || `код ${top.code}`}`);
  if (top.code === 0 && !top.out) throw new DowngradeRefused("git в каталоге движка не работает: git ничего не ответил (код 0). Повторите miksy downgrade");
  if (!engineRepo(engine))
    throw new DowngradeRefused(`движок ${slash(engine)} — не git-клон, откатить его командой нельзя. Скачайте движок заново (README, «Установка») и переключитесь на нужный выпуск: git -C <папка движка> checkout -B ${STABLE} v<версия>, затем miksy setup --yes`);
  const branch = g(["symbolic-ref", "--short", "-q", "HEAD"]).out;
  if (!branch)
    throw new DowngradeRefused(`движок не на ветке (отдельный коммит, detached HEAD) — так откатывать нельзя. Вернитесь на ветку: git -C ${at} checkout ${STABLE}`);
  if (branch === MAIN)
    throw new DowngradeRefused(`движок на ветке разработки ${MAIN}, а miksy downgrade возвращает прежний выпуск (ветка ${STABLE}). Перейти на выпуски — miksy update (предложит ветку ${STABLE}), затем miksy downgrade`);
  if (branch !== STABLE)
    throw new DowngradeRefused(`движок на ветке ${branch}. miksy downgrade откатывает ветку ${STABLE} (выпуски): git -C ${at} checkout ${STABLE}, затем miksy downgrade`);
  const show = (spec: string) => { const r = g(["show", spec]); return r.code === 0 ? r.out : null; };
  const cur = versionOf(show("HEAD:package.json"));
  if (!cur) throw new DowngradeRefused(`версия движка не определяется (package.json в ${slash(engine)} не читается или без номера) — откатывать не от чего`);
  const d = g(["status", "--porcelain", "--untracked-files=no"]).out;
  if (d) throw new DowngradeRefused(`в движке есть незакоммиченные правки — откат их не трогает и не начнётся:\n${d.split("\n").slice(0, 10).map((l) => "  " + l).join("\n")}\nСвои правки движка держите в конфигурации (слои, map.yaml), а не в движке. Убрать их: git -C ${at} stash (вернуть потом: git -C ${at} stash pop) — затем miksy downgrade`);
  // Свои коммиты в stable: HEAD не входит ни в выпуск, ни в удалённую или другую свою ветку — checkout -B отвязал бы их
  const holders = g(["for-each-ref", "--contains", "HEAD", "--format=%(refname)", "refs/heads", "refs/remotes", "refs/tags"]).out
    .split("\n").map((s) => s.trim()).filter((r) => r && r !== `refs/heads/${STABLE}`);
  if (!holders.length)
    throw new DowngradeRefused(`в ветке ${STABLE} движка есть свои коммиты (их нет ни в одном выпуске) — откат отвязал бы их от ветки. Сохраните их в другой ветке: git -C ${at} branch ${STABLE}-mine — затем miksy downgrade`);
  const remote = g(["config", `branch.${STABLE}.remote`]).out || "origin";

  // Выпуски: тег vX.Y.Z → коммит (у аннотированного — коммит, на который он указывает)
  const loadTags = () => {
    const m = new Map<string, string>();
    for (const l of g(["for-each-ref", "--format=%(refname:short)\t%(objectname)\t%(*objectname)", "refs/tags"]).out.split("\n")) {
      const [name, sha, peeled] = l.trim().split("\t");
      const v = /^v(\d+\.\d+\.\d+)$/.exec(name ?? "")?.[1];
      if (v && sha) m.set(v, peeled || sha);
    }
    return m;
  };
  let tags = loadTags();
  let fetched = false;
  const fetchTags = () => {
    if (fetched) return;
    fetched = true;
    const r = g(["fetch", "--tags", "--quiet", remote], true);
    if (r.code !== 0) log(`(не удалось взять список выпусков из удалённого репо: ${netError(r.err, r.code)})`);
    tags = loadTags();
  };
  const below = () => [...tags.keys()].filter((v) => compareVersions(v, cur) < 0 && compareVersions(v, DOWNGRADE_MIN) >= 0)
    .sort((a, b) => compareVersions(b, a));
  const tooOld = (v: string) => `откат на ${v} командой не поддерживается — только на ${DOWNGRADE_MIN} и новее: версиям старше нужна подготовка вручную. Как откатиться на них — docs/update.md выпуска 0.3.5: ${OLD_RECIPE}`;

  // CHANGELOG нынешней версии — до checkout (даты выпусков для списка, записи «что уйдёт»)
  const text = show("HEAD:CHANGELOG.md");
  let entries: Entry[] = [];
  let unreadable = "";
  try { entries = text ? parseChangelog(text).entries : []; }
  catch (e) { unreadable = (e as Error).message; }
  const dated = (v: string) => entries.find((e) => e.version === v)?.date ?? "";

  let target: string;
  if (o.version) {
    const v = o.version.replace(/^v/, "");
    if (!SEMVER.test(v)) throw new DowngradeRefused(`«${o.version}» — не номер версии (например, ${below()[0] ?? "0.3.5"})`);
    const c = compareVersions(v, cur);
    if (c === 0) { log(`Движок уже на версии ${cur}.`); return 0; }
    if (c > 0) throw new DowngradeRefused(`${v} новее нынешней ${cur} — это не откат. Новая версия — miksy update`);
    if (compareVersions(v, DOWNGRADE_MIN) < 0) throw new DowngradeRefused(tooOld(v));
    if (!tags.has(v)) fetchTags();
    if (!tags.has(v)) {
      const list = below();
      throw new DowngradeRefused(`выпуска ${v} нет (тега v${v} нет в движке${fetched ? " и в удалённом репо" : ""}). ${list.length ? `Выпуски ниже ${cur}: ${list.join(", ")}` : `Выпусков ниже ${cur} (от ${DOWNGRADE_MIN}) нет`}`);
    }
    target = v;
  } else {
    // Прежняя по журналу stable: первая запись с выпуском ниже нынешнего (не просто stable@{1}: после отката это
    // новая — второй downgrade вернул бы её)
    const bySha = new Map<string, string>();
    for (const [v, sha] of tags) if (!bySha.has(sha) || compareVersions(v, bySha.get(sha)!) > 0) bySha.set(sha, v);
    const journal = g(["log", "-g", "--format=%H", `refs/heads/${STABLE}`]);
    const was = (journal.code === 0 ? journal.out.split("\n") : []).map((s) => bySha.get(s.trim())).find((v) => v && compareVersions(v, cur) < 0);
    if (was && compareVersions(was, DOWNGRADE_MIN) >= 0) target = was;
    else {
      if (!below().length) fetchTags();
      const list = below();
      if (!list.length) throw new DowngradeRefused(`выпусков ниже ${cur} (от ${DOWNGRADE_MIN}) нет — откатывать некуда${was ? `. До обновления у вас была ${was}: ${tooOld(was)}` : ""}`);
      log(was
        ? `До обновления у вас была ${was} — на неё команда не откатывает (только на ${DOWNGRADE_MIN} и новее; старше — ${OLD_RECIPE}).`
        : `Прежнюю версию не узнать: журнал ветки ${STABLE} пуст, устарел (больше 90 дней) или до обновления движок был на ветке ${MAIN}.`);
      const options = list.map((v) => ({ key: v, label: `${dated(v) ? `выпуск ${dated(v)}` : "выпуск"}${v === list[0] ? ", сразу под нынешней" : ""}` }));
      if (!o.ask || o.dryRun) {
        log(`Выпуски ниже ${cur}:`);
        for (const x of options) log(`  ${x.key} — ${x.label}`);
        log(`Выберите и выполните: miksy downgrade <версия> (например, miksy downgrade ${list[0]}). Движок не изменён.`);
        return o.dryRun ? 0 : 1;
      }
      const k = o.ask.choose(`Нынешняя версия — ${cur}. На какую откатить?`, options, list[0]);
      if (!k) { log("Отменено, движок не изменён."); return 1; }
      target = k;
    }
  }

  // local/machine.yaml — до шагов: прежние версии (≤ APPENDS_AGENTS) дописывают агентов, список возвращаем
  let machinePath: string | null = null;
  let agentsBefore: string | undefined;
  try {
    machinePath = join(o.config ?? configRoot(), "local", "machine.yaml");
    agentsBefore = existsSync(machinePath) ? AGENTS_LINE.exec(readFileSync(machinePath, "utf8"))?.[0] : undefined;
  } catch { machinePath = null; }
  const appends = compareVersions(target, APPENDS_AGENTS) <= 0;

  log(`Откат miksy: ${cur} → ${target} (движок ${slash(engine)}).`);
  const lost = entriesBetween(entries, target, cur);
  if (unreadable) log(`\n(CHANGELOG.md не разбирается: ${unreadable})`);
  else if (lost.length) {
    log(`\nЧто уйдёт (CHANGELOG, версии после ${target}):\n`);
    for (const e of lost) log(entryText(e) + "\n");
    const after = lost.flatMap((e) => (e.sections["После обновления"] ?? []).filter((l) => l.trim()).map((l) => `  ${e.version}: ${l.trim()}`));
    if (after.length) log(`Делали что-то из «После обновления» этих версий (например, правили конфигурацию) — после отката верните, как было:\n${after.join("\n")}\n`);
  }
  log(`${lost.length && !unreadable ? "" : "\n"}Что будет сделано:`);
  log(`  1. движок — на выпуск ${target}: git -C ${at} checkout -B ${STABLE} v${target} (файлы, которые miksy пишет в папку движка, не трогаются);`);
  log(`  2. уже версией ${target}: miksy setup --yes — команда miksy и local/ под неё;`);
  log(o.ask
    ? `  3. miksy sync --global и miksy sync --all — настройки агентов так, как их пишет ${target}; затем проверка: miksy doctor.`
    : `  3. без терминала — только команды: miksy sync --global и miksy sync --all (записать настройки агентам версией ${target} — после «да» пользователя), затем miksy doctor.`);
  if (appends && agentsBefore)
    log(`Версии ${APPENDS_AGENTS} и раньше в шаге 2 дописывают в agents (local/machine.yaml) всех агентов, найденных на машине, — downgrade вернёт список, как был.`);
  log("Вернуться на новую версию — miksy update.");

  if (o.dryRun) { log("\n(--dry-run: ничего не изменено)"); return 0; }
  if (!o.yes) {
    if (!o.ask) {
      log(`\nБез терминала откат — только с --yes (агенту — после «да» пользователя): miksy downgrade ${target} --yes. Движок не изменён.`);
      return 1;
    }
    if (!o.ask.yes(`\nОткатить miksy до ${target}?`)) { log("Отменено, движок не изменён."); return 1; }
  }

  const co = g(["checkout", "-q", "-B", STABLE, `v${target}^{commit}`]);
  if (co.code !== 0) throw new DowngradeRefused(`git checkout не выполнен, движок не изменён: ${lastLine(co.err) || `код ${co.code}`}`);
  const all = [["setup", "--yes"], ["sync", "--global"], ["sync", "--all"]];
  // Оставшиеся шаги для ручного запуска. Прежняя ≤ APPENDS_AGENTS в setup снова допишет найденных агентов, а вернуть
  // список, как restoreAgents, вручную некому (у прежней нет downgrade) — точная строка до sync. Без терминала sync —
  // агенту только после «да» пользователя
  const rest = (from: number) => {
    const left = all.slice(from);
    const text = left.map((a) => a[0] === "setup" && appends && agentsBefore
      ? `${cmd(a)}, затем верните в local/machine.yaml строку «${agentsBefore}» (версия ${target} дописывает туда всех найденных агентов)`
      : cmd(a)).join(", затем ");
    return `${text}${!o.ask && left.some((a) => a[0] === "sync") ? " (sync агенту — только после «да» пользователя)" : ""}`;
  };
  log(`\n✓ движок на выпуске ${target} (был ${cur}). Дальше — шаги версией ${target}; если прервётся, выполните сами: ${rest(0)}.`);
  const step = o.step ?? ((e: string, args: string[]) => {
    const r = Bun.spawnSync([process.execPath, ...engineBunArgs(e), join(e, "src", "cli.ts"), ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    return r.exitCode ?? 1;
  });
  const steps = o.ask ? all : all.slice(0, 1);
  for (const [i, a] of steps.entries()) {
    if (a[1] === "--global")
      log("\nЕсли sync спросит о доверии Claude проекту, где вы сами отвечали Claude «да, больше не спрашивать», и в вопросе только ваши ответы в окне Claude, — отвечайте «да».");
    log(`\n$ ${cmd(a)}   (miksy ${target})`);
    let code: number;
    try { code = step(engine, a); }
    catch (e) { log(`  не запустилось: ${(e as Error).message}`); code = 1; }
    if (a[0] === "setup") restoreAgents();
    if (code !== 0) {
      log(`\nШаг «${cmd(a)}» не выполнен (код ${code}). Движок уже на ${target}: исправьте сказанное выше и выполните ${rest(i)}. Вернуться на новую версию — miksy update`);
      return code;
    }
  }
  if (!o.ask) {
    log(`\nНастройки агентов пока записаны версией ${cur}. Записать их версией ${target} (агенту — после «да» пользователя): miksy sync --global и miksy sync --all, затем проверка: miksy doctor. Вернуться на новую версию — miksy update.`);
    return 0;
  }
  log(`\n$ miksy doctor   (miksy ${target})`);
  try { step(engine, ["doctor"]); } catch (e) { log(`  не запустилось: ${(e as Error).message}`); }
  log(`\n✓ откат: ${cur} → ${target}. Вернуться на новую версию — miksy update.`);
  return 0;

  // Прежняя версия дописала найденных агентов в agents — вернуть строку, как была (бэкап machine.yaml она сделала сама)
  function restoreAgents() {
    if (!appends || !machinePath || !agentsBefore) return;
    let now: string;
    try { now = readFileSync(machinePath, "utf8"); } catch { return; }
    const line = AGENTS_LINE.exec(now)?.[0];
    if (!line || line === agentsBefore) return;
    const added = names(line).filter((a) => !names(agentsBefore).includes(a));
    try {
      writeAtomic(machinePath, now.replace(AGENTS_LINE, () => agentsBefore!));
      log(`  ↩ ${target} дописала в agents (local/machine.yaml) найденных агентов${added.length ? ` ${added.join(", ")}` : ""} — убрано, список как был: ${agentsBefore}`);
    } catch (e) {
      log(`  ! ${target} дописала в agents найденных агентов${added.length ? ` ${added.join(", ")}` : ""}, вернуть не удалось (${(e as Error).message}) — уберите их из agents в local/machine.yaml до miksy sync`);
    }
  }
}
