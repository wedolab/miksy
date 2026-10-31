// miksy doctor — что разошлось между слоями и тем, что лежит на диске. Только чтение.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Adapter } from "./adapter";
import { type Action, plan, verifyMerges } from "./apply";
import { configRoot, ENGINE, ignoredLayerParts, ignoredText, layerSecrets, loadSecrets, orphanTreeDirs, unknownKeys } from "./load";
import { engineVersion, newerLedger } from "./version";
import { emptyState, ManifestError, type Manifest, otherOwners } from "./manifest";
import type { Move } from "./relocate";
import { fold, pathKey } from "./paths";
import { foreignMcp, foreignSkills } from "./foreign";
import { allProjects, allTargets, formerGroups, globalTarget, groupRulesDelivered, ledgerSkills, listGroups, literalHints, loadManifestMoved, movesText, READERS, renderFor, type TargetSpec, targetId, unprotectedSecrets, unsyncedGroups, workspaceRepoNote } from "./registry";
import type { Machine } from "./types";
import { checkLocalAccess, checkSecretFiles } from "./secretfiles";
import { plainDirs } from "./target";
import { environment } from "./environ";
import { stableBun } from "./launch";
import { deliveredSkillNames, deliveryOrder } from "./registry";
import { AGENT_NOTE, AGENT_TITLE, inheritedExec, type PendingTrust, pendingText, trustPlan } from "./trust";

type Finding = { agent: string; target: string; detail: string };
// Добавка агента в обход слоёв: что поднимать (miksy adopt) — глобальное или проект (dir, rel)
export type Addition = Finding & { kind: "mcp" | "skill"; name: string; source: string; dir?: string; rel?: string };
// Конфликт первого sync: где (dir — проект; нет — глобально) и файл
export type Blocked = Finding & { dir?: string; file: string; why: string };

// Ручная правка — то, что sync без --force не перезапишет
const MANUAL = /изменён вручную|управляемый блок изменён|таблица изменена|хеш неизвестен/;

// Глобальные каталоги skills агентов — чтобы найти чужие регистрации (например, от установщиков наборов skills).
// Skill — каталог со SKILL.md; служебные каталоги агента без него (контейнеры синхронизации) не считаются
const GLOBAL_SKILL_DIRS = [".claude/skills", ".agents/skills", ".config/opencode/skills", ".gemini/config/skills"];

export function doctor(adapters: Adapter[], machine: Machine, verbose: boolean): { text: string; problems: number; added: Addition[]; blocked: Blocked[] } {
  const secrets = loadSecrets();
  const skippedDirs: string[] = [];
  const projects = allProjects(machine, undefined, (w) => skippedDirs.push(w));
  const badGroups: string[] = [], absentGroups: string[] = [];
  // Каталога группы нет на этой машине (проекты не склонированы) — справочно, как слои без проектов
  const groups = listGroups(machine, (w) => {
    const m = /^цель (.+) \(target: true\): каталога нет в workspace/.exec(w);
    if (m) absentGroups.push(m[1]);
    else badGroups.push(w);
  });
  // Учёт — с переездами каталогов (в памяти: перенос сохранит sync)
  let manifest: Manifest;
  let manifestError: string | undefined;
  let moves: Move[] = [];
  try { ({ manifest, moves } = loadManifestMoved(machine, groups)); }
  catch (e) {
    if (!(e instanceof ManifestError)) throw e;
    manifestError = e.message;
    manifest = { version: 1, targets: {} };
  }
  const targets: TargetSpec[] = [globalTarget(machine), ...allTargets(machine, groups)];
  const groupBelow: Finding[] = []; // группа выше не синхронизирована — правил её отрезка у цели нет
  const former: Finding[] = []; // пометку группы сняли, а её файлы остались

  const unsynced: Finding[] = [];
  const stale: Finding[] = [];
  const team: Finding[] = [];
  const manual: Finding[] = [];
  const persistent: Finding[] = [];
  const blocked: Blocked[] = [];
  const missing = new Map<string, Set<string>>(); // переменная → агенты
  const added: Addition[] = []; // добавки агентов в обход слоёв
  const permissions: Finding[] = [];
  const exposed: Finding[] = []; // секреты в файлах каталогов без git
  const undeliverable: Finding[] = []; // секрет есть, но доставить его нельзя (многострочный, символы)
  const texts = new Map<string, string | null>();
  const valueFiles = new Map<string, Set<string>>(); // конфиг агента → секреты, чьи значения в нём лежат
  const advice: Finding[] = []; // нужно действие пользователя в агенте (доверие проекта Claude)
  const trust: Finding[] = [];
  const pendingTrust: PendingTrust[] = []; // нужно решение пользователя (исполняемые настройки агента)
  const declined: PendingTrust[] = []; // пользователь отказал в доверии (miksy trust)
  const literals: Finding[] = []; // значение секрета в ключе вне учёта (конфликт «создан не miksy»)
  const emptySecrets: Finding[] = []; // секрет, который использует сервер, пустой
  const delivered = new Map<string, string[]>();
  const rulesDelivered = (adapter: Adapter) => (dir: string) => groupRulesDelivered(adapter, manifest, dir);

  for (const adapter of deliveryOrder(adapters)) {
    for (const t of targets) {
      const id = targetId(adapter, t.target);
      const prev = manifest.targets[id];
      const where = { agent: adapter.id, target: t.title };
      let rendered: ReturnType<typeof renderFor>;
      let actions: Action[];
      try {
        const others = t.target.scope === "project" ? ledgerSkills(manifest, t.target.dir, new Set(adapters.map((a) => a.id))) : [];
        rendered = renderFor(adapter, t, machine, secrets, prev, [...(delivered.get(t.title) ?? []), ...others], rulesDelivered(adapter));
        actions = plan(rendered.result, t.target, machine, prev ?? emptyState(), false, adapter.id, otherOwners(manifest, id));
        delivered.set(t.title, [...(delivered.get(t.title) ?? []), ...deliveredSkillNames(rendered.result, actions, t.target)]);
        for (const detail of trustPlan(rendered.result, t.target, machine, prev ?? emptyState(), actions, adapter.id).missing) trust.push({ ...where, detail });
        const p = rendered.result.trustPending;
        if (p) (p.declined ? declined : pendingTrust).push(p);
        for (const detail of literalHints(actions, secrets, t.target.scope === "global" ? "--global" : t.target.dir, adapter.id)) literals.push({ ...where, detail });
      } catch (e) {
        // Ошибка одной цели (битая ссылка, нет доступа) — находка, проверка остальных продолжается
        persistent.push({ ...where, detail: `цель не проверена: ${(e as Error).message}` });
        continue;
      }
      for (const detail of unsyncedGroups(adapter, t, rulesDelivered(adapter))) groupBelow.push({ ...where, detail });
      const { result, cfg, missing: miss } = rendered;
      for (const m of miss) missing.set(m, (missing.get(m) ?? new Set()).add(adapter.id));
      for (const k of rendered.skipped) if (k.why) undeliverable.push({ ...where, detail: `mcp ${k.name}: ${k.why}` });
      for (const a of result.advice ?? []) advice.push({ ...where, detail: a });
      for (const w of result.warnings.filter((w) => /инструкции Claude не записаны/.test(w))) persistent.push({ ...where, detail: w });
      for (const w of result.warnings.filter((w) => /пустой в local\/secrets\.env/.test(w))) emptySecrets.push({ ...where, detail: w });
      // Значения секретов в конфигах агента (записанных до 2а или оставленных keep)
      const configs = new Set([
        ...Object.keys(prev?.merges ?? {}), ...Object.keys(prev?.toml ?? {}),
        ...result.files.filter((f) => f.mode === "merge" || f.mcp).map((f) => pathKey(`${f.base === "project" && t.target.scope === "project" ? t.target.dir : machine.home}/${f.path}`)),
      ]);
      for (const c of configs) for (const n of valuesIn(c, secrets, texts)) valueFiles.set(c, (valueFiles.get(c) ?? new Set()).add(n));
      // Права: только то, что sync исправит (chmod); отвергнутые файлы (командный opencode.json) — нет
      const changes = actions.filter((a) => a.kind !== "conflict" && a.kind !== "chmod");
      for (const a of actions) if (a.kind === "chmod") permissions.push({ ...where, detail: `${a.abs}: права ${a.mode.toString(8).padStart(4, "0")} — открыт группе или не хватает +x` });
      const open = unprotectedSecrets(result, t.target, secrets);
      if (open) exposed.push({ ...where, detail: open });
      for (const f of foreignMcp(adapter, cfg, t.target, machine))
        added.push({ ...where, detail: `mcp ${f.name}  (${f.source})`, kind: "mcp", name: f.name, source: f.source, ...(t.target.scope === "project" && { dir: t.target.dir, rel: t.target.rel }) });

      if (!prev) {
        for (const a of actions) if (a.kind === "conflict") blocked.push({ ...where, detail: `${a.abs}: ${a.why}`, file: a.abs, why: a.why, ...(t.target.scope === "project" && { dir: t.target.dir }) });
        if (changes.length) unsynced.push({ ...where, detail: "" });
        continue;
      }
      const teamNames = cfg.skills.filter((s) => s.item.team).map((s) => s.item.name);
      const isTeam = (a: Action) => "abs" in a && teamNames.some((n) => a.abs.includes(`/skills/${n}/`));
      const teamChanges = changes.filter(isTeam);
      const other = changes.filter((a) => !isTeam(a));
      if (teamChanges.length) team.push({ ...where, detail: summarizeSkills(teamChanges, teamNames) });
      if (other.length) stale.push({ ...where, detail: summarize(other) });
      for (const a of actions)
        if (a.kind === "conflict") (MANUAL.test(a.why) ? manual : persistent).push({ ...where, detail: `${a.abs}: ${a.why}` });
    }
  }

  for (const adapter of adapters)
    for (const f of formerGroups(manifest, adapter, groups, machine))
      if (!targets.some((t) => t.target.scope === "project" && fold(pathKey(t.target.dir)) === fold(f.dir)))
        former.push({ agent: adapter.id, target: f.rel, detail: "записанное осталось (у группы — действует на цели ниже)" });

  // Группы без git: Claude наследует их доверие на подкаталоги без своего git — исполняемые настройки
  // там (распакованный архив и т. п.) применились бы без вопроса
  const inherited: Finding[] = [];
  if (adapters.some((a) => a.id === "claude"))
    for (const g of groups.filter((x) => !x.git))
      for (const s of inheritedExec(g.abs, groups.filter((x) => x !== g).map((x) => x.abs)))
        inherited.push({ agent: "claude", target: s.dir, detail: `доверие группы ${g.rel} действует и здесь: ${s.lines.join("; ")}` });

  const localAccess = checkLocalAccess();
  if (localAccess.bad.length) permissions.push({ agent: "—", target: "local/", detail: `${localAccess.bad.length} открытых путей или ошибок проверки; ${localAccess.bad[0]} — sync/setup исправит права` });
  for (const l of localAccess.links) permissions.push({ agent: "—", target: "local/", detail: l });

  // Файлы секретов: нужные записанным конфигам (учёт) есть, закрыты владельцу, не устарели; лишних нет
  const needed = new Map<string, string[]>();
  for (const [id, st] of Object.entries(manifest.targets))
    for (const n of st.secrets ?? []) needed.set(n, [...(needed.get(n) ?? []), id.replace("|", " ")]);
  const secretFiles = checkSecretFiles(needed, secrets, manifest.secretFiles ?? []);
  const secretProblems = secretFiles.problems.map((d) => ({ agent: "—", target: "local/secrets", detail: d }));

  // Исполняемые файлы, которые запускают записанные обёртки (Bun моста, команда сервера): после
  // обновления или удаления программы обёртка падает до следующего sync
  const missingExe: Finding[] = [];
  for (const [id, st] of Object.entries(manifest.targets))
    for (const f of Object.keys(st.files).filter((p) => /\/local\/run\/.+\.(sh|cmd)$/.test(p)))
      for (const exe of wrapperExecutables(f))
        if (!existsSync(exe)) missingExe.push({ agent: id.split("|")[0], target: f, detail: `исполняемый файл ${exe} не найден — обновите путь в слое или выполните miksy sync` });

  // Skills, которые агенты положили в проекты вне слоёв (по пути — один раз, неважно, кто видит)
  for (const p of [...groups, ...projects.filter((x) => !groups.some((g) => fold(g.abs) === fold(pathKey(x.abs))))])
    for (const s of foreignSkills(p.abs, READERS, manifest))
      added.push({ agent: s.seenBy.join("/") || "—", target: p.rel, detail: `skill ${s.name}  (${s.dir})`, kind: "skill", name: s.name, source: s.dir, dir: p.abs, rel: p.rel });

  // Учёт ссылается на проекты, которых больше нет
  const orphans = Object.keys(manifest.targets)
    .map((id) => id.split("|"))
    .filter(([agent, dir]) => adapters.some((a) => a.id === agent) && dir !== "global" && !existsSync(dir))
    .map(([agent, dir]) => ({ agent, target: dir, detail: "" }));

  // Ключи, которые агент перезаписал своей копией файла
  const lost = Object.entries(manifest.targets)
    .filter(([id]) => adapters.some((a) => id.startsWith(a.id + "|")))
    .flatMap(([id, st]) => verifyMerges(st).map((l) => ({ agent: id.split("|")[0], target: id.split("|")[1], detail: l })));

  // Глобальные skills, которые положил не miksy
  const owned = new Set(Object.values(manifest.targets).flatMap((s) => Object.keys(s.files)));
  const foreign: string[] = [];
  for (const d of GLOBAL_SKILL_DIRS) {
    const dir = join(machine.home, d);
    if (!existsSync(dir)) continue;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".") || !existsSync(join(dir, e.name, "SKILL.md"))) continue;
      // Учёт канонический: ~/.claude может быть ссылкой (dotfiles)
      const prefix = `${pathKey(join(dir, e.name))}/`;
      if (![...owned].some((f) => f.startsWith(prefix))) foreign.push(`~/${d}/${e.name}`);
    }
  }

  // Каталоги дерева слоёв без соответствующего каталога workspace — опечатка или переименование
  const naked = layerSecrets().map((l) => ({ agent: "—", target: "", detail: l }));
  const treeUnused = orphanTreeDirs(machine.workspace);
  const typos = treeUnused.filter((d) => d.suggestion).map((d) => ({ agent: "—", target: `layers/tree/${d.path}`, detail: `↔ в workspace есть ${d.suggestion}` }));
  const unused = treeUnused.filter((d) => !d.suggestion).map((d) => d.path);

  const out: string[] = [`miksy doctor — версия ${engineVersion()}; агенты: ${adapters.map((a) => a.id).join(", ")}; проектов: ${projects.length}${groups.length ? `; помечено целями (target: true): ${groups.length}` : ""}`, ""];
  const section = (title: string, hint: string, items: Finding[], grouped = false) => {
    if (!items.length) return;
    out.push(`${title} (${items.length})${hint ? ` — ${hint}` : ""}`);
    if (grouped && !verbose) {
      const byAgent = new Map<string, string[]>();
      for (const f of items) byAgent.set(f.agent, [...(byAgent.get(f.agent) ?? []), f.target]);
      for (const [agent, list] of byAgent) out.push(`  ${agent}: ${list.length} — ${list.slice(0, 4).join(", ")}${list.length > 4 ? ", …" : ""}`);
    } else {
      const shown = verbose ? items : items.slice(0, 15);
      for (const f of shown) out.push(`  ${f.agent}  ${f.target}${f.detail ? `  ${f.detail}` : ""}`);
      if (shown.length < items.length) out.push(`  … ещё ${items.length - shown.length} (--verbose)`);
    }
    out.push("");
  };

  if (manifestError) out.push(manifestError, "Проверка без сведений о владении; файлы и учёт не изменены.", "");
  section("Конфликты первого sync", "файлы не записаны", blocked);
  section("Небезопасные права", "sync/setup закрывает local/ владельцу (ACL Windows / 0700 Unix)", permissions);
  section("Проекты без доверия", "причина для каждого агента; чужое доверие не меняется", trust);
  if (pendingTrust.length) out.push(`Нужно решение пользователя о доверии (${pendingTrust.length}) — у проектов исполняемые настройки агента команды; без решения miksy доверие не ставит:`,
    ...pendingText(pendingTrust), AGENT_NOTE, "");
  section("Исполняемые настройки в подкаталогах групп без git", "Claude наследует доверие группы на подкаталоги без своего git: эти настройки применятся без вопроса; удалите их, сделайте каталог git-репо или запретите доверие группы (trust: { claude: false })", inherited);
  section("Не синхронизировано", "sync для них ни разу не запускался: miksy sync --all --agent <id>", unsynced, true);
  section("Устарело", "слои изменились после sync: miksy sync --all --agent <id>", stale);
  section("Импорт командных skills устарел", "в репо изменились skills или агент теперь видит их сам: miksy sync <проект> --agent <id>", team);
  section("Правлено вручную", "sync не перезапишет без --force; перенесите правку в слои или откатите", manual);
  section("Ключи пропали", "агент перезаписал файл своей копией; повторите sync", lost);
  section("Группа выше не получила правила", "агент читает правила родительских каталогов, а файла правил группы нет — её правила пишутся в цели ниже: miksy sync <группа> или sync --all", groupBelow);
  section("Снята пометка target: true", "miksy sync --all уберёт записанное туда по учёту (у группы иначе её правила задвоятся в целях ниже)", former);
  section("Учёт ссылается на несуществующие каталоги", "каталог удалён или переехал, но не найден по записанным файлам (найденный sync переносит сам); убрать записанное вне него (ключи MCP, доверие, обёртки) и запись учёта: miksy clean <путь>", orphans);
  section(
    "Добавлено агентами в обход слоёв",
    "другие агенты этого не получат; поднять в слой: miksy adopt <проект|--global> <имя> --to <уровень> (не считается ошибкой)",
    added,
  );
  section("Похоже на опечатку или переименование", "слой дерева не совпадает с каталогом workspace, но есть похожий — переименуйте слой", typos);
  section("Пометка target: true не действует", "target: true в layer.yaml; слой остаётся обычным промежуточным", badGroups.map((detail) => ({ agent: "—", target: "", detail })));
  section("Секреты открытым текстом в слоях", "уйдут в git конфигурации; вынесите значения в local/secrets.env, в слое — ${ИМЯ}", naked);
  const values = [...valueFiles].map(([file, names]) => ({ agent: "—", target: file, detail: `значения ${[...names].sort().join(", ")}` }));
  section("Значения секретов в конфигах агентов", "miksy sync заменит серверы на обёртки (записанные keep-ом остаются, пока секрет не задан)", values);
  section("Значение секрета в ключе вне учёта", "sync оставляет такой ключ как есть (конфликт) — возьмите его под учёт", literals);
  section("Файлы секретов", "local/secrets/<ИМЯ>: нужны записанным конфигам", secretProblems);
  section("Секрет нельзя доставить", "сервер пропущен; исправьте значение в local/secrets.env или определение в слое", undeliverable);
  section("Пустые значения секретов", "сервер получит пустое значение; задайте его в local/secrets.env", emptySecrets);
  section("Нет исполняемого файла обёртки", "обёртка не запустится: программа удалена или обновлена (новый путь)", missingExe);
  if (missing.size) {
    out.push(`Не заданы переменные (${missing.size}) — local/machine.yaml или local/secrets.env`);
    for (const [v, ag] of missing) out.push(`  ${v}  (${[...ag].join(", ")})`);
    out.push("");
  }

  const problems = Number(!!manifestError) + blocked.length + permissions.length + unsynced.length + stale.length + team.length + manual.length + lost.length + orphans.length + typos.length + naked.length + missing.size
    + values.length + secretProblems.length + undeliverable.length + groupBelow.length + former.length + badGroups.length + pendingTrust.length
    + emptySecrets.length + missingExe.length;
  out.push(problems ? `Проблем: ${problems}.` : "Всё синхронизировано.");

  // Справочно: не требует действий
  const info: string[] = [];
  const newer = newerLedger(manifest.engine);
  if (newer) info.push(`Версия: ${newer}`);
  const keys = unknownKeys();
  if (keys.length) info.push(`Неизвестные ключи (${keys.length}) — miksy их не читает: опечатка или ключ более новой версии miksy:`, ...keys.map((k) => "  " + k));
  if (persistent.length) {
    info.push(`Известные конфликты (${persistent.length}) — повторяются при каждом sync, miksy их не трогает:`);
    for (const f of (verbose ? persistent : persistent.slice(0, 8))) info.push(`  ${f.agent}  ${f.target}  ${f.detail}`);
    if (!verbose && persistent.length > 8) info.push(`  … ещё ${persistent.length - 8} (--verbose)`);
  }
  const repoNote = workspaceRepoNote(machine, groups);
  if (repoNote) info.push(repoNote);
  if (skippedDirs.length) info.push(`Пропущено при поиске проектов (${skippedDirs.length}):`, ...skippedDirs.map((w) => "  " + w));
  const unread = ignoredLayerParts();
  if (unread.length) info.push(`Не читается: ${ignoredText(unread)}`);
  if (unused.length) info.push(`Слои, которые на этой машине ни к чему не применяются (проектов нет): ${unused.join(", ")}`);
  const env = environment({ env: process.env, home: machine.home, os: machine.os, bun: stableBun(process.execPath), agents: adapters.map((a) => a.id), engine: ENGINE, config: configRoot() });
  if (env.length) info.push(`Окружение (${env.length}) — только сведения, miksy здесь ничего не меняет:`, ...env.map((l) => "  " + l));
  const plain = plainDirs(machine.workspace, groups, targets);
  if (plain.length) info.push(`Каталоги без git на уровне проектов (${plain.length}) — настроек не получат: git init в каталоге или miksy target <путь>:`,
    ...(verbose ? plain : plain.slice(0, 15)).map((d) => "  " + d), ...(!verbose && plain.length > 15 ? [`  … ещё ${plain.length - 15} (--verbose)`] : []));
  if (absentGroups.length) info.push(`Цели target: true, каталогов которых на этой машине нет (пометка здесь не действует): ${absentGroups.join(", ")}`);
  if (moves.length) info.push(`Каталоги переехали (${moves.length}) — учёт следует за ними, sync сохранит перенос:`, ...movesText(moves));
  if (foreign.length) info.push(`Глобальные skills не от miksy (${foreign.length}): ${foreign.join(", ")}`);
  if (exposed.length) {
    info.push(`Секреты в каталогах без git (${exposed.length}) — не защищены от копий и архивов:`);
    for (const f of exposed) info.push(`  ${f.agent}  ${f.target}`);
  }
  if (secretFiles.info.length) info.push(`Файлы секретов (${secretFiles.info.length}):`, ...secretFiles.info.map((l) => "  " + l));
  if (declined.length) info.push(`Доверие отклонено пользователем (${declined.length}) — miksy его не ставит; пересмотреть: miksy trust <проект>:`,
    ...declined.map((p) => `  ${AGENT_TITLE[p.agent]}  ${p.rel || p.dir}`));
  if (advice.length) {
    info.push(`Нужно действие в агенте (${advice.length}):`);
    for (const f of (verbose ? advice : advice.slice(0, 8))) info.push(`  ${f.agent}  ${f.target}  ${f.detail}`);
    if (!verbose && advice.length > 8) info.push(`  … ещё ${advice.length - 8} (--verbose)`);
  }
  if (info.length) out.push("", "Справочно:", ...info);

  return { text: out.join("\n"), problems, added, blocked };
}

function summarize(actions: Action[]): string {
  const n = (k: Action["kind"]) => actions.filter((a) => a.kind === k).length;
  return [
    n("write") && `файлов: ${n("write")}`,
    n("block") && `блоков инструкций: ${n("block")}`,
    n("trust") && `доверие: ${n("trust")}`,
    n("approve") && `одобрение серверов .mcp.json: ${n("approve")}`,
    n("delete") && `удалить: ${n("delete")}`,
    (n("merge") || n("toml")) && `ключей MCP: ${n("merge") + n("toml")}`,
    n("exclude") && "git exclude",
  ].filter(Boolean).join(", ");
}

function summarizeSkills(actions: Action[], names: string[]): string {
  const hit = names.filter((n) => actions.some((a) => "abs" in a && a.abs.includes(`/skills/${n}/`)));
  return hit.join(", ");
}

// Абсолютные пути программ, которые запускает сгенерированная обёртка (src/launch.ts): sh — `exec '<путь>'`,
// .cmd — команда перед `%*` (после очистки копий секретов). Команда из PATH (npx) не проверяется
export function wrapperExecutables(file: string): string[] {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { return []; }
  let exe: string | undefined;
  if (file.endsWith(".sh")) {
    const m = text.match(/^exec '((?:[^']|'\\'')*)'/m);
    exe = m?.[1].replaceAll("'\\''", "'");
  } else {
    const line = text.split(/\r?\n/).find((l) => /%\*$/.test(l));
    const cmd = line?.replace(/^(?:set "h\.[A-Za-z0-9_]+=" & )+/, "");
    const m = cmd?.match(/^"([^"]*)"|^(\S+)/);
    exe = (m?.[1] ?? m?.[2])?.replaceAll("%%", "%");
  }
  return exe && /^([A-Za-z]:[\\/]|\/)/.test(exe) ? [exe] : [];
}

// Имена секретов, значения которых (от 8 символов, как есть или в JSON/TOML-экранировании) лежат в файле
function valuesIn(path: string, secrets: Record<string, string>, fileText: Map<string, string | null>): string[] {
  if (!fileText.has(path)) {
    try { fileText.set(path, existsSync(path) ? readFileSync(path, "utf8") : null); }
    catch { fileText.set(path, null); }
  }
  const text = fileText.get(path);
  if (!text) return [];
  return Object.entries(secrets).filter(([, v]) => v.length >= 8 && (text.includes(v) || text.includes(JSON.stringify(v).slice(1, -1)))).map(([n]) => n);
}
