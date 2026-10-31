// Команды miksy: разбор аргументов и выполнение в этом процессе. CLI (src/cli.ts) и мастер setup
// (src/setup.ts) вызывают runCommand; вопросы — через Ask (в терминале — prompt, в тестах — сценарий)
import { existsSync, readdirSync, realpathSync, rmdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fold, inside, pathKey, samePath, slash } from "./paths";
import type { RenderResult } from "./adapter";
import { apply, applyPlanned, approvalExclude, describe, plan, verifyMerges, type Action } from "./apply";
import { cacheGit, gitCaching } from "./git";
import { AGENT_NOTE, AGENT_TITLE, askTrust, executableSettings, mcpJsonServers, ownFiles, type PendingTrust, pendingText, saveDecision, type TrustAgent } from "./trust";
import { KEEP_RUNS, runDir } from "./backup";
import { parseArgs, UsageError } from "./args";
import { adoptMcp, adoptSkill, fromNative, layerDir, mcpYaml } from "./adopt";
import { doctor } from "./doctor";
import { foreignMcp, foreignSkills } from "./foreign";
import { setup, unsafeWorkspace } from "./setup";
import { type Ask, terminalAsk } from "./ask";
import { formatResolved } from "./explain";
import { containsProjects, ENGINE, findProject, ignoredLayerParts, ignoredText, layerSecrets, listProjects, loadMachine, loadMap, loadSecrets, configRoot, unknownKeys } from "./load";
import { finishUpdate, update } from "./update";
import { engineVersion, newerLedger } from "./version";
import { emptyState, type Manifest, otherOwners, saveManifest, type TargetState } from "./manifest";
import { ADAPTERS, agentsFor, allProjects, allTargets, formerGroups, formerTarget, globalTarget, type Group, groupRulesDelivered, ledgerSkills, listGroups, markedKind, literalHints, projectTarget, launcherFor, loadManifestMoved, movesText, READERS, renderFor, saveMoves, type TargetSpec, targetId, unprotectedSecrets, unsyncedGroups, vanishedTarget, workspaceRepoNote } from "./registry";
import { prepareSandbox, syncOut } from "./sync";
import { applyMark, layerPath, markPlan, plainDirs, plainText, targetDir } from "./target";
import { type AgentId, formatTeamSkills, scanTeamSkills } from "./teamskills";
import type { Adapter } from "./adapter";
import type { Machine, Resolved } from "./types";
import { deliveredSkillNames, deliveryOrder } from "./registry";
import { adoptCodexTable } from "./codex-adopt";
import { checkLocalAccess, ensurePrivateLocal, neededSecrets, pruneSecretFiles, secretFileState, secretsDir, writeSecretFiles } from "./secretfiles";
export const USAGE = `miksy — раскладывает ваши правила, MCP-серверы и skills из каталога конфигурации (miksy-config)
по настройкам AI-агентов: Claude Code, Codex, opencode, Antigravity. В фоне не работает: поменяли
конфигурацию — запустите sync.

Установка и проверка
  miksy setup                  мастер установки; повторный запуск продолжает с несделанного
                               и находит новых агентов. --yes — без вопросов (только безопасное),
                               --yes --backup — и копия настроек агентов «до miksy»
  miksy doctor                 всё ли записано и не разошлось ли с конфигурацией (ничего не меняет).
                               После правок конфигурации, git pull в проектах и время от времени

Запись настроек агентам
  miksy sync --global          домашние настройки агентов (~/.claude, ~/.codex и т. д.) из слоёв
                               layers/global и layers/env-<ОС>: действуют во всех каталогах.
                               Когда меняли эти слои
  miksy sync --all             все проекты workspace (git-репо) и каталоги с пометкой target: true —
                               из слоёв layers/tree по их пути. Когда меняли layers/tree
  miksy sync <путь>            то же для одного проекта или каталога (например, нового)
    --dry-run                  только показать, что будет записано
    --force                    заменить и файлы, правленные вручную или чужие (с копией)
    --agent <имя>              один агент: ${Object.keys(ADAPTERS).join(", ")} (без флага — агенты из
                               local/machine.yaml)
  miksy clean <путь> | --global | --all
                               убрать всё, что miksy записал, — вернуть как было до него

Проекты и каталоги
  miksy projects               какие каталоги workspace получают настройки
  miksy explain [<путь>]       что получит каталог (без пути — домашние настройки) и из какого слоя
  miksy target [<путь>]        каталог без git (без пути — текущий) получает настройки, как проект:
                               пометка target: true в его слое. --remove — снять пометку
  miksy skills <путь> | --all  skills из репо проекта (от команды) и кто из агентов их видит

Настройки, добавленные агенту напрямую (claude mcp add и т. п.)
  miksy adopt --global <имя> --to <уровень>
  miksy adopt <путь> <имя> --to <уровень>
                               перенести MCP-сервер или skill в конфигурацию — получат все агенты;
                               уровень: global, workspace или путь в дереве (Acme, Acme/app).
                               Что перенести — показывает miksy doctor
  miksy trust [<путь>]         доверять ли проекту, где настройки агента из репо команды запускают
                               команды (хуки, .mcp.json); sync спросит сам. Агенту без терминала:
                               --confirm — только после явного «да» пользователя, иначе --deny

Обновление miksy
  miksy update                 новая версия движка (ветка stable): покажет, что изменилось, и
                               после «да» обновит. --check — только проверить, есть ли новая
  miksy version                версия движка (то же — miksy --version)

Примеры
  miksy sync --all --dry-run   поменяли правило в layers/tree — посмотреть план,
  miksy sync --all             затем записать
  miksy sync --global          добавили правило для всех агентов везде (layers/global)

Подробно — README движка: «Справочник команд» (все флаги; что изменилось → что запустить) и «Если
что-то пошло не так». Флаги: --флаг <значение> или --флаг=<значение>; ошибка в аргументах — код 2,
ничего не выполняется.`;

// Сколько целей, в которые miksy ещё не писал, sync --all берёт без подтверждения
const NEW_TARGETS_LIMIT = 10;

// Пользователь не подтвердил запись: ничего не записано (CLI — код 1)
export class Cancelled extends Error {
  constructor() { super("Отменено, ничего не записано."); }
}

// Вопросы этой команды: в терминале — prompt, у мастера setup — его Ask; null — без терминала
let ask: Ask | null = null;

// Подтверждение перед массовой записью: --yes, иначе вопрос; без терминала — отказ
function confirm(reason: string, flags: Record<string, string>) {
  if ("yes" in flags) return;
  if (!ask) throw new UsageError(`${reason}. Проверьте план (--dry-run) и подтвердите: --yes`);
  if (!ask.yes(`${reason}. Продолжить?`)) throw new Cancelled();
}

// Что sync/clean решили по каждой цели (план до записи) — сводка плана для мастера setup
export type TargetReport = { agent: string; title: string; scope: "global" | "project"; dir?: string; actions: Action[]; warnings: string[]; error?: string };
let observe: ((r: TargetReport) => void) | null = null;

// Секреты, нужные целям этого запуска (id цели → имена): из них и из учёта остальных целей —
// какие файлы local/secrets/ нужны; файлы, уже записанные в этом запуске
let runSecrets = new Map<string, string[]>();
let secretsDone = new Set<string>();
let writtenMerges: { state: TargetState; actions: Action[] }[] = [];
let deliveredSkills = new Map<string, string[]>();
// Доверие ждёт решения пользователя (исполняемые настройки агента): разбор в конце sync
let pendingTrust = new Map<string, { p: PendingTrust; adapter: Adapter; t: TargetSpec }>();
// Группы машины; агенты этого запуска
let runGroups: Group[] = [];
let runAgents = new Set<string>();
let allMode = false;
// Получила ли группа правила в этом запуске (--dry-run: по плану; иначе — по учёту после записи)
let groupRulesRun = new Map<string, boolean>();

// Состояние одного запуска sync/clean: мастер setup выполняет несколько команд в одном процессе
function resetRun() {
  runSecrets = new Map();
  secretsDone = new Set();
  writtenMerges = [];
  deliveredSkills = new Map();
  pendingTrust = new Map();
  runGroups = [];
  runAgents = new Set();
  allMode = false;
  groupRulesRun = new Map();
}
const groupKey = (adapter: Adapter, dir: string) => `${adapter.id}|${fold(pathKey(dir))}`;
const groupRules = (adapter: Adapter, manifest: Manifest) => (dir: string) =>
  groupRulesRun.get(groupKey(adapter, dir)) ?? groupRulesDelivered(adapter, manifest, dir);

// Предупреждения цели ниже групп: группа выше не получила правила; пометку группы выше сняли, а её
// файлы остались (их уберёт sync --all — в нём не предупреждаем)
function groupWarnings(adapter: Adapter, t: TargetSpec, manifest: Manifest, machine: Machine): string[] {
  if (t.target.scope !== "project") return [];
  const dir = t.target.dir;
  const former = allMode ? [] : formerGroups(manifest, adapter, runGroups, machine)
    .filter((g) => inside(dir, g.dir) && fold(g.dir) !== fold(pathKey(dir)))
    .map((g) => `пометка группы ${g.rel} снята, а её файлы остались и действуют здесь — miksy sync --all уберёт их`);
  return [...unsyncedGroups(adapter, t, groupRules(adapter, manifest)), ...former];
}

// Учёт помнит, что цель записана как группа: снятую пометку sync --all найдёт по нему. clean пометку
// не снимает: цель с оставшимся содержимым (конфликт очистки) остаётся бывшей группой, пустая — уходит из учёта
const isGroup = (cmd: "sync" | "clean", t: TargetSpec) => cmd === "sync" && t.target.scope === "project" && !!t.target.group;
function markGroup(state: TargetState, cmd: "sync" | "clean", t: TargetSpec) {
  if (isGroup(cmd, t)) state.group = true;
  else if (cmd === "sync") delete state.group;
}
const groupChanged = (st: TargetState, cmd: "sync" | "clean", t: TargetSpec) => cmd === "sync" && !!st.group !== isGroup(cmd, t);

// Skills, которые в цели уже доставили другие агенты: этого запуска — по его результатам, остальные — по учёту
const skillsDelivered = (t: TargetSpec, manifest: Manifest) =>
  [...(deliveredSkills.get(t.title) ?? []), ...(t.target.scope === "project" ? ledgerSkills(manifest, t.target.dir, runAgents) : [])];

// Файлы local/secrets, созданные miksy (Manifest.secretFiles): только их prune может удалить
// (created — реально созданные этим запуском; существовавший файл пользователя не захватывается)
function rememberSecretFiles(manifest: Manifest, created: string[]) {
  manifest.secretFiles = [...new Set([...(manifest.secretFiles ?? []), ...created])].sort();
}

// Зависимости серверов (сервер → секреты). При конфликте или ошибке записи часть потребителей могла
// остаться на записанной версии: до подтверждённого переключения — объединение старых и новых
function unionServers(a: Record<string, string[]> = {}, b: Record<string, string[]> = {}): Record<string, string[]> {
  const out: Record<string, string[]> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = [...new Set([...(out[k] ?? []), ...v])].sort();
  return out;
}

// Один проход sync/clean для одной цели. Возвращает число конфликтов
function runTarget(
  cmd: "sync" | "clean",
  adapter: Adapter,
  machine: Machine,
  t: TargetSpec,
  manifest: Manifest,
  flags: Record<string, string>,
  quiet: boolean,
): number {
  let result: RenderResult = { files: [], warnings: [], ...(cmd === "clean" && { clean: true }) };
  const id = targetId(adapter, t.target);
  const prev = manifest.targets[id] ?? emptyState();
  // Файлы других целей: один канонический файл — один владелец (общая ссылка каталогов skills)
  const owners = otherOwners(manifest, id);
  const makePlan = (p: TargetState) => plan(result, t.target, machine, p, "force" in flags, adapter.id, owners);
  let actions: ReturnType<typeof plan>;
  let secrets: Record<string, string> = {};
  try {
    if (cmd === "sync") {
      secrets = loadSecrets();
      const r = renderFor(adapter, t, machine, secrets, prev, skillsDelivered(t, manifest), groupRules(adapter, manifest));
      result = r.result;
      const exposed = unprotectedSecrets(result, t.target, secrets);
      if (exposed) result.warnings.push(exposed);
      result.warnings.push(...groupWarnings(adapter, t, manifest, machine));
    }
    actions = makePlan(prev);
  } catch (e) {
    // Ошибка одной цели (битая ссылка, нет доступа) — её конфликт, остальные цели обрабатываются
    console.log(`${t.title}\n  КОНФЛИКТ             ${(e as Error).message} — цель пропущена`);
    observe?.({ agent: adapter.id, title: t.title, scope: t.target.scope, actions: [], warnings: [], error: (e as Error).message });
    return 1;
  }
  const p = result.trustPending;
  if (cmd === "sync" && p && !p.declined) pendingTrust.set(`${fold(pathKey(p.dir))}|${p.agent}`, { p, adapter, t });
  if (cmd === "sync") result.warnings.push(...literalHints(actions, secrets, t.target.scope === "global" ? "--global" : t.target.dir, adapter.id));
  observe?.({ agent: adapter.id, title: t.title, scope: t.target.scope, ...(t.target.scope === "project" && { dir: t.target.dir }), actions, warnings: result.warnings });
  let conflicts = actions.filter((a) => a.kind === "conflict").length;
  // Файлы секретов, нужные этой цели (значения — только в local/secrets/, имена — в выводе)
  const wanted = (result.secrets ?? []).filter((n) => !secretsDone.has(n));
  const secretPlan = wanted.flatMap((n) => {
    const st = secretFileState(n, secrets);
    return st === "create" || st === "update" ? [`  файл секрета ${n}: ${st === "create" ? "создать" : "обновить"} (${secretsDir()}/${n})`] : [];
  });
  runSecrets.set(id, [...new Set([...(result.secrets ?? []), ...(conflicts ? prev.secrets ?? [] : [])])].sort());
  // Секреты по серверам: при конфликте конфиг мог остаться прежним — зависимости записанной версии
  // остаются вместе с новыми (Г7)
  const servers = conflicts ? unionServers(prev.servers, result.servers) : { ...result.servers };
  const setServers = (st: TargetState, list: Record<string, string[]>) => {
    if (Object.keys(list).length) st.servers = list;
    else delete st.servers;
  };
  // Группа получила правила? Для целей ниже в этом же --dry-run — по плану (учёт не обновляется)
  if (cmd === "sync" && t.target.scope === "project" && t.target.group && "dry-run" in flags && actions.length) {
    const rules = (adapter.rulesFiles ?? []).map((r) => pathKey(join(t.target.scope === "project" ? t.target.dir : "", r)));
    groupRulesRun.set(groupKey(adapter, t.target.dir), actions.some((a) => a.kind !== "conflict" && rules.includes(pathKey(a.abs)))
      || (groupRulesDelivered(adapter, manifest, t.target.dir) && !actions.some((a) => a.kind === "conflict" && rules.includes(pathKey(a.abs)))));
  }

  if (!actions.length && !secretPlan.length) {
    deliveredSkills.set(t.title, [...(deliveredSkills.get(t.title) ?? []), ...deliveredSkillNames(result, actions, t.target)]);
    // При --all цель без изменений печатается, только если есть предупреждения — чтобы было видно, чьи они
    if (!quiet || result.warnings.length) console.log(`${t.title}: изменений нет`);
    for (const w of result.warnings) console.log("  предупреждение: " + w);
    // Учёт нужных секретов — и без изменений файлов (учёт прежней версии их не знал)
    const st = manifest.targets[id];
    const names = runSecrets.get(id)!;
    if (st && !("dry-run" in flags) && (JSON.stringify(st.secrets ?? []) !== JSON.stringify(names) || JSON.stringify(st.servers ?? {}) !== JSON.stringify(servers) || groupChanged(st, cmd, t))) {
      if (names.length) st.secrets = names;
      else delete st.secrets;
      setServers(st, servers);
      markGroup(st, cmd, t);
      saveManifest(manifest);
    }
    return 0;
  }
  console.log(`${t.title}${isGroup(cmd, t) ? ` (${markedKind(t.target)})` : ""}  [${t.cfg.layers.join(" → ") || "—"}]\n` + [...secretPlan, ...actions.map(describe)].join("\n"));
  for (const w of result.warnings) console.log("  предупреждение: " + w);
  for (const n of wanted) secretsDone.add(n);
  if ("dry-run" in flags) {
    deliveredSkills.set(t.title, [...(deliveredSkills.get(t.title) ?? []), ...deliveredSkillNames(result, actions, t.target)]);
    return conflicts;
  }
  // Файлы секретов — до конфигов агента: opencode с {file:} на ещё не созданный файл не стартует
  try {
    const written = writeSecretFiles(wanted, secrets);
    for (const l of written.lines) if (/ссылка/.test(l)) console.log(l);
    rememberSecretFiles(manifest, written.created);
  } catch (e) {
    console.log(`  ОШИБКА: файлы секретов не записаны: ${(e as Error).message} — цель пропущена`);
    return 1;
  }

  let state: TargetState;
  let failed = 0;
  try {
    const done = applyPlanned(makePlan, prev, actions, (again) =>
      console.log("  файл изменился во время sync — план пересчитан:\n" + again.map(describe).join("\n")));
    state = done.state;
    deliveredSkills.set(t.title, [...(deliveredSkills.get(t.title) ?? []), ...deliveredSkillNames(result, done.actions, t.target)]);
    writtenMerges.push(done);
    conflicts = done.actions.filter((a) => a.kind === "conflict").length;
  } catch (e) {
    // Ошибка одной цели не останавливает остальные; выполненное до ошибки — в учёт
    console.log(`  ОШИБКА: ${(e as Error).message} — цель синхронизирована частично`);
    state = (e as Error & { partialState?: TargetState }).partialState ?? prev;
    failed = 1;
  }
  // Пустое состояние sync с конфликтами тоже сохраняется: цель обработана, её повторяющиеся
  // конфликты — «известные», а не «первый sync» и не «новая цель» в sync --all
  // Частичная запись: прежние конфиги могли остаться — их файлы секретов тоже нужны
  const names = [...new Set([...(runSecrets.get(id) ?? []), ...(failed ? prev.secrets ?? [] : [])])].sort();
  runSecrets.set(id, names);
  if (names.length) state.secrets = names;
  else delete state.secrets;
  setServers(state, conflicts || failed ? unionServers(prev.servers, servers) : servers);
  markGroup(state, cmd, t);
  if (Object.keys(state.files).length || Object.keys(state.blocks ?? {}).length || Object.keys(state.trust ?? {}).length || Object.keys(state.approvals ?? {}).length || Object.keys(state.merges).length || Object.keys(state.exclude).length || Object.keys(state.toml ?? {}).length || (cmd === "sync" && conflicts) || (cmd === "clean" && conflicts && state.group))
    manifest.targets[id] = state;
  else delete manifest.targets[id];
  saveManifest(manifest);
  return conflicts + failed;
}

// Пустые каталоги обёрток после clean/удаления серверов
function removeEmptyDirs(dir: string): boolean {
  if (!existsSync(dir)) return true;
  let empty = true;
  for (const e of readdirSync(dir, { withFileTypes: true }))
    empty = (e.isDirectory() && !e.isSymbolicLink() ? removeEmptyDirs(join(dir, e.name)) : false) && empty;
  if (empty) rmdirSync(dir);
  return empty;
}

// Только доверие цели по текущему решению (после ответа пользователя): остальное — дело sync
function applyTrust(adapter: Adapter, machine: Machine, t: TargetSpec, manifest: Manifest): number {
  const id = targetId(adapter, t.target);
  const prev = manifest.targets[id] ?? emptyState();
  const r = renderFor(adapter, t, machine, loadSecrets(), prev, deliveredSkills.get(t.title));
  const planned = plan(r.result, t.target, machine, prev, false, adapter.id, otherOwners(manifest, id));
  const actions = planned.filter((a) => a.kind === "trust" || a.kind === "approve" || (a.kind === "conflict" && /\/(\.codex\/config\.toml|\.claude\.json|\.claude\/settings\.local\.json)$/.test(a.abs)));
  // Файл одобрений скрыт от git вместе с одобрением — до его создания (Г10)
  const ex = t.target.scope === "project" ? approvalExclude(planned, t.target.dir) : null;
  if (ex) actions.push(ex);
  if (!actions.length) {
    console.log(`  ${AGENT_TITLE[adapter.id as TrustAgent]} ${t.title}: доверие не меняется`);
    return 0;
  }
  console.log(actions.map(describe).join("\n"));
  try {
    const { state } = apply(actions, prev);
    manifest.targets[id] = state;
    saveManifest(manifest);
  } catch (e) {
    console.log(`  ОШИБКА: ${(e as Error).message}`);
    return 1;
  }
  return actions.filter((a) => a.kind === "conflict").length;
}

// Решение о доверии: в терминале — вопрос; answer — уже данный ответ (--confirm/--deny)
function decideTrust(list: { p: PendingTrust; adapter: Adapter; t: TargetSpec }[], machine: Machine, manifest: Manifest, answer?: "yes" | "no"): number {
  let conflicts = 0;
  for (const { p, adapter, t } of list) {
    console.log(`\n${pendingText([p]).join("\n")}`);
    const a = answer ?? askTrust(p, (q) => ask!.line(q));
    if (!a) {
      console.log("  решение отложено — спрошу при следующем sync");
      continue;
    }
    saveDecision(p, a);
    console.log(`  ${a === "yes" ? "доверять" : "не доверять"} — записано в local/trust.json`);
    conflicts += applyTrust(adapter, machine, t, manifest);
  }
  return conflicts;
}

// Одна команда miksy: код выхода (0 — успех, 1 — проблемы doctor, 3 — конфликты). Ошибки — исключения
// (UsageError — код 2, Cancelled — отказ в подтверждении). io.ask — вопросы (по умолчанию — терминал,
// если он есть); io.observe — план каждой цели sync/clean. Кеш git — на одну команду (если включён)
export function runCommand(cmd: string, rest: string[], io: { ask?: Ask | null; observe?: (r: TargetReport) => void } = {}): number {
  const { flags, positional } = parseArgs(cmd, rest);
  ask = io.ask !== undefined ? io.ask : process.stdin.isTTY ? terminalAsk : null;
  observe = io.observe ?? null;
  resetRun();
  if (gitCaching()) cacheGit();
  try { return command(cmd, flags, positional); }
  finally { ask = null; observe = null; }
}

function command(cmd: string, flags: Record<string, string>, positional: string[]): number {
  let code = 0;
  switch (cmd) {
    case "explain": {
      const machine = loadMachine();
      let title: [string, string][];
      let cfg: Resolved;
      // Каталог вне workspace получает только глобальные настройки — их и показываем
      const abs = positional[0] ? slash(realpathSync.native(resolve(positional[0]))) : "";
      const outside = abs && !inside(abs, slash(realpathSync.native(machine.workspace)));
      if (outside) {
        ({ cfg } = globalTarget(machine));
        title = [["Каталог", abs], ["Цель",`вне workspace — только глобальные настройки (${machine.home})`], ["ОС", machine.os]];
      } else if (positional[0]) {
        const p = findProject(positional[0], machine.workspace);
        const t = projectTarget(p.abs, p.rel, machine, p.nested);
        cfg = t.cfg;
        title = [[t.target.scope === "project" && t.target.group ? (t.target.nested ? "Цель-группа" : "Цель без git") : "Проект", p.rel || "(корень workspace)"], ["Каталог", p.abs], ["ОС", machine.os]];
        // Ниже группы: агенты, читающие правила родительских каталогов (Claude), получают здесь только отрезок
        const below = cfg.below;
        if (below) title.push(
          ["Группа выше", below.groups.map((g) => g.rel).join(" → ")],
          ["Claude здесь", `правила только слоёв ${below.layers.join(" → ") || "—"} (остальные — из файлов групп выше)`]);
      } else {
        ({ cfg } = globalTarget(machine));
        title = [["Цель", `домашний каталог агентов (${machine.home})`], ["ОС", machine.os]];
      }
      title.unshift(["Конфигурация", configRoot().replaceAll("\\", "/")]);
      title.unshift(["Движок miksy", ENGINE.replaceAll("\\", "/")]);
      console.log(formatResolved(title, cfg, machine, loadSecrets()));
      if (positional[0] && !outside) console.log("\n(+ глобальные слои — см. `miksy explain` без пути)");
      break;
    }

    case "skills": {
      const machine = loadMachine();
      const mine = agentsFor(machine, flags.agent).map((a) => a.id) as AgentId[];
      const list = "all" in flags
        ? allProjects(machine, undefined, (w) => console.log("предупреждение: " + w))
        : positional[0] ? [findProject(positional[0], machine.workspace)]
        : (() => { throw new UsageError("укажите путь проекта или --all"); })();
      let total = 0, broken = 0, unseen = 0;
      for (const p of list) {
        const r = scanTeamSkills(p.abs, READERS);
        if ("all" in flags && !r.skills.length && !r.commands.length) continue;
        console.log(formatTeamSkills(p.rel, r, mine) + "\n");
        total += r.skills.length;
        broken += r.skills.filter((s) => s.copies.some((c) => c.issues.length)).length;
        unseen += r.skills.filter((s) => mine.some((a) => !s.seenBy.includes(a))).length;
      }
      console.log(`Итого skills: ${total}; с ошибками хотя бы в одной копии: ${broken}; не видны хотя бы одному из ваших агентов (${mine.join(", ")}): ${unseen}`);
      break;
    }

    case "projects": {
      const machine = loadMachine();
      const warn = (w: string) => console.log("предупреждение: " + w);
      const groups = listGroups(machine, warn);
      const repoNote = workspaceRepoNote(machine, groups);
      if (repoNote) warn(repoNote);
      const gdirs = new Set(groups.map((g) => fold(g.abs)));
      const list = allProjects(machine, flags.agent ? agentsFor(machine, flags.agent) : undefined, warn).filter((p) => !gdirs.has(fold(pathKey(p.abs))));
      const rows = [
        ...groups.map((g) => ({ rel: g.rel, note: `   (${markedKind(g)}: target: true в layer.yaml${g.git ? ", git-репо" : ""})` })),
        ...list.map((p) => ({ rel: p.rel, note: p.nested ? "   (внутри есть другие проекты — CLAUDE.local.md сюда не пишется)" : "" })),
      ].sort((a, b) => a.rel.localeCompare(b.rel));
      for (const r of rows) console.log(r.rel + r.note);
      console.log(`\nВсего: ${list.length}${groups.length ? `; помечено целями (target: true): ${groups.length}` : ""}`);
      break;
    }

    case "sync":
    case "clean": {
      const machine = loadMachine();
      if (cmd === "sync") {
        const naked = layerSecrets();
        if (naked.length)
          console.log(`ВНИМАНИЕ: секреты открытым текстом в слоях (уйдут в git конфигурации) — вынесите значения в local/secrets.env, в слое оставьте \${ИМЯ}:\n${naked.map((l) => "  " + l).join("\n")}\n`);
        const unread = ignoredLayerParts();
        if (unread.length) console.log(`предупреждение: ${ignoredText(unread)}\n`);
        const keys = unknownKeys();
        if (keys.length) console.log(`предупреждение: неизвестные ключи — miksy их не читает (опечатка или ключ более новой версии miksy): ${keys.join(", ")}\n`);
      }

      if (cmd === "sync" && "out" in flags) {
        const p = positional[0] ? findProject(positional[0], machine.workspace) : null;
        const t = p ? projectTarget(p.abs, p.rel, machine, p.nested) : globalTarget(machine);
        const secrets = loadSecrets();
        const { manifest } = loadManifestMoved(machine);
        const adapters = agentsFor(machine, flags.agent);
        // Путь — от текущего каталога; песочница проверяется до любых записей
        const out = resolve(process.cwd(), flags.out).replaceAll("\\", "/");
        const dryRun = "dry-run" in flags;
        prepareSandbox(out, dryRun);
        console.log(`${t.title}\nСлои: ${t.cfg.layers.join(" → ")}\nПесочница: ${out}`);
        for (const adapter of adapters) {
          console.log("");
          // keep — как в настоящем sync: пропущенный сервер, записанный раньше, остаётся в own-файле
          const rendered = renderFor(adapter, t, machine, secrets, manifest.targets[targetId(adapter, t.target)]);
          console.log(syncOut(adapter, rendered, t.target, machine, out, dryRun, secrets, launcherFor(adapter, t.target, machine)));
        }
        if (dryRun) console.log("\n--dry-run: ничего не записано.");
        break;
      }

      // sync --all пишет во все репо workspace: при неверном workspace (корень, ~) — подтверждение до обхода
      const writeAll = cmd === "sync" && "all" in flags && !("dry-run" in flags);
      const unsafe = unsafeWorkspace(machine.workspace, machine.home);
      if (writeAll && unsafe) confirm(`workspace ${machine.workspace} — ${unsafe}: sync --all запишет конфиги во все git-репо внутри`, flags);

      const warn = (w: string) => console.log("предупреждение: " + w);
      allMode = "all" in flags;
      runGroups = "global" in flags ? [] : listGroups(machine, allMode ? warn : undefined);
      const repoNote = allMode && workspaceRepoNote(machine, runGroups);
      if (repoNote) warn(repoNote);
      // Учёт — с переездами каталогов: sync и clean сохраняют перенос до записи целей
      const { manifest, moves } = loadManifestMoved(machine, "global" in flags ? undefined : runGroups);
      const newer = newerLedger(manifest.engine);
      if (newer) console.log(`предупреждение: ${newer}\n`);
      if (moves.length) {
        console.log(`${"dry-run" in flags ? "План: учёт miksy переедет вслед за каталогами" : "Учёт miksy перенесён вслед за каталогами"}:\n${movesText(moves).join("\n")}\n`);
        if (!("dry-run" in flags)) saveMoves(manifest, moves);
      }
      const targets = allMode
        ? allTargets(machine, runGroups, warn)
        : "global" in flags ? [globalTarget(machine)]
        : positional[0] ? [(cmd === "clean" && vanishedTarget(positional[0], manifest, machine)) || (() => { const p = findProject(positional[0], machine.workspace); return projectTarget(p.abs, p.rel, machine, p.nested, runGroups); })()]
        : (() => { throw new UsageError("укажите путь проекта, --global или --all"); })();

      const adapters = agentsFor(machine, flags.agent);
      runAgents = new Set(adapters.map((a) => a.id));
      if (allMode) {
        // Цели до записи: известные (уже в учёте) — списком, новые — по одной в строке
        const known = new Set(Object.keys(manifest.targets).map((id) => id.slice(id.indexOf("|") + 1).toLowerCase()));
        const fresh = targets.filter((t) => t.target.scope === "project" && !known.has(t.target.dir.toLowerCase()));
        const old = targets.filter((t) => !fresh.includes(t));
        const marked = targets.filter((t) => t.target.scope === "project" && t.target.group);
        const groupTitles = marked.filter((t) => t.target.scope === "project" && t.target.nested).map((t) => t.title);
        const bareTitles = marked.filter((t) => !groupTitles.includes(t.title)).map((t) => t.title);
        console.log(`${cmd} --all: workspace ${machine.workspace}; проектов: ${targets.length - marked.length}; агенты: ${adapters.map((a) => a.id).join(", ")}`);
        if (groupTitles.length) console.log(`  группы (${groupTitles.length}): ${groupTitles.join(", ")}`);
        if (bareTitles.length) console.log(`  цели без git (${bareTitles.length}): ${bareTitles.join(", ")}`);
        if (old.length) console.log(`  уже в учёте (${old.length}): ${old.map((t) => t.title).join(", ")}`);
        if (fresh.length) console.log(`  новые — miksy в них ещё не писал (${fresh.length}):\n${fresh.map((t) => "    " + t.title).join("\n")}`);
        const plain = cmd === "sync" ? plainDirs(machine.workspace, runGroups, targets) : [];
        if (plain.length) console.log(`  ${plainText(plain)}`);
        if (writeAll && fresh.length > NEW_TARGETS_LIMIT)
          confirm(`новых целей: ${fresh.length} (больше ${NEW_TARGETS_LIMIT}) — miksy создаст файлы в каждом из этих репо`, flags);
      }
      let conflicts = 0;
      // Права local/: проверка одним снимком; исправление — только при открытых путях
      if ("dry-run" in flags) {
        const access = checkLocalAccess();
        if (access.bad.length) console.log(`\nДоступ local/: закрыть владельцу (${access.bad.length} открытых путей или ошибок проверки).`);
        for (const l of access.links) warn(l);
      } else {
        const access = ensurePrivateLocal();
        if (access.fixed) console.log("\nДоступ local/: закрыт владельцу (были открытые пути).");
        for (const l of access.warnings) warn(l);
      }
      const printedFormer = new Set<string>();
      for (const adapter of deliveryOrder(adapters)) {
        if (adapters.length > 1) console.log(`\n=== ${adapter.id}`);
        // Снятая пометка группы: её наследуемые файлы действовали бы на цели ниже (задвоение правил) —
        // убираем по учёту до остальных целей. Каталог, ставший обычной целью, пересчитает её sync
        if (allMode) for (const fg of formerGroups(manifest, adapter, runGroups, machine)) {
          if (targets.some((t) => t.target.scope === "project" && fold(pathKey(t.target.dir)) === fold(fg.dir))) continue;
          if (!printedFormer.has(fg.dir)) console.log(`пометка target: true снята: ${fg.rel} — убираю записанное туда по учёту`);
          printedFormer.add(fg.dir);
          conflicts += runTarget("clean", adapter, machine, formerTarget(fg), manifest, flags, false);
        }
        for (const t of targets) conflicts += runTarget(cmd, adapter, machine, t, manifest, flags, targets.length > 1);
      }
      // Лишние файлы секретов: не нужны ни целям этого запуска, ни остальным целям учёта
      const needed = neededSecrets({ ...manifest, targets: Object.fromEntries(Object.entries(manifest.targets).filter(([id]) => !runSecrets.has(id))) });
      for (const names of runSecrets.values()) for (const n of names) needed.add(n);
      const pruned = pruneSecretFiles(needed, "dry-run" in flags, manifest.secretFiles ?? []);
      if (pruned.lines.length) console.log("\nФайлы секретов\n" + pruned.lines.join("\n"));
      // Учёт созданных файлов: удалённые и пропавшие с диска уходят из него
      if (!("dry-run" in flags) && manifest.secretFiles) {
        const left = manifest.secretFiles.filter((n) => !pruned.removed.includes(n) && existsSync(join(secretsDir(), n)));
        if (left.length !== manifest.secretFiles.length) {
          manifest.secretFiles = left;
          saveManifest(manifest);
        }
      }
      if (!("dry-run" in flags)) removeEmptyDirs(join(configRoot(), "local", "run"));

      // Доверие проектам с исполняемыми настройками агента: в терминале — вопрос по каждому (--yes его
      // не снимает); без терминала и в --dry-run — список и указание агенту спросить пользователя
      if (pendingTrust.size) {
        const list = [...pendingTrust.values()];
        console.log(`\nНужно решение пользователя о доверии (${list.length}) — у проектов исполняемые настройки агента команды; без решения miksy доверие не ставит:`);
        if (!("dry-run" in flags) && ask) conflicts += decideTrust(list, machine, manifest);
        else console.log(`${pendingText(list.map((x) => x.p)).join("\n")}\n${AGENT_NOTE}`);
      }

      if ("dry-run" in flags) console.log("\n--dry-run: ничего не записано.");
      else {
        console.log(`\nГотово. Бэкапы этого запуска: ${runDir() ?? "не понадобились"} (хранятся последние ${KEEP_RUNS} запусков)`);
        // Записанные ключи общих файлов — на месте ли сразу после записи (без паузы); перезапись
        // открытой сессией агента позже покажет doctor («ключи пропали»)
        const checking = writtenMerges.filter((x) => x.actions.some((a) => a.kind === "merge" || a.kind === "toml" || a.kind === "trust" || a.kind === "approve"));
        const lost = checking.flatMap((x) => verifyMerges(x.state, x.actions));
        if (checking.length) console.log(lost.length
          ? "ВНИМАНИЕ: часть ключей пропала — файл перезаписан другим процессом (сессией агента?):\n" + lost.map((l) => "  " + l).join("\n")
          : "Проверка: все ключи на месте (если их позже перезапишет открытая сессия агента — покажет miksy doctor).");
      }
      if (conflicts) {
        console.log(`Конфликтов: ${conflicts} — эти места не изменены.`);
        code = 3;
      }
      break;
    }

    case "adopt": {
      const machine = loadMachine();
      const isGlobal = "global" in flags;
      const name = isGlobal ? positional[0] : positional[1];
      if (!name || !("to" in flags)) throw new UsageError("Использование: miksy adopt <путь проекта> <имя> --to <уровень>  |  miksy adopt --global <имя> --to <уровень>");
      const level = flags.to;
      layerDir(level); // проверка уровня
      const t = isGlobal ? globalTarget(machine) : (() => { const p = findProject(positional[0], machine.workspace); return projectTarget(p.abs, p.rel, machine, p.nested); })();
      const secrets = loadSecrets();
      const { manifest, moves } = loadManifestMoved(machine);
      const mcps = agentsFor(machine, flags.agent).flatMap((a) => foreignMcp(a, renderFor(a, t, machine, secrets, manifest.targets[targetId(a, t.target)]).cfg, t.target, machine)).filter((f) => f.name === name);
      const skills = t.target.scope === "project" ? foreignSkills(t.target.dir, READERS, manifest).filter((s) => s.name === name) : [];
      if (!mcps.length && !skills.length) throw new Error(`«${name}» нет среди добавок агентов в ${t.title}. Список — miksy doctor`);
      if (mcps.length && skills.length) throw new Error(`«${name}» — и MCP, и skill; переименуйте одно из них`);

      const rel = t.target.scope === "project" ? t.target.rel.toLowerCase() : "";
      const lv = level.replace(/^\/+|\/+$/g, "").toLowerCase();
      if (t.target.scope === "project" && !["global", "workspace", ""].includes(lv) && rel !== lv && !rel.startsWith(lv + "/"))
        console.log(`Внимание: уровень «${level}» не включает проект-источник ${t.title} — там добавка останется только у агента.`);

      if (mcps.length) {
        const defs = new Set(mcps.map((m) => JSON.stringify(m.def)));
        if (defs.size > 1 && !flags.agent)
          throw new Error(`У агентов разные определения «${name}» (${mcps.map((m) => m.agent).join(", ")}) — укажите --agent`);
        const src = mcps[0];
        const codexSource = isGlobal && mcps.find((m) => m.agent === "codex");
        if (codexSource) adoptCodexTable(manifest, machine, name, codexSource.def, true);
        const { server, secrets: found, open } = fromNative(name, src.def, src.agent, machine, level, secrets);
        const comment = `Поднято из ${src.agent} (${src.source}) командой miksy adopt`;
        // План до записи: что попадёт в слой (только ссылки), какие секреты уйдут в local/secrets.env, что осталось
        const file = adoptMcp(server, found, level, comment, undefined, true);
        console.log(`План: MCP ${name} → ${file}\n${mcpYaml(server, comment).replace(/^/gm, "    ")}`);
        if (Object.keys(found).length)
          console.log(`  в local/secrets.env (в слое — ссылки):\n${Object.entries(found).map(([k, v]) => `    ${k}  (${v.length} симв.)`).join("\n")}`);
        if (open.length)
          console.log(`  ВНИМАНИЕ: похоже на секрет, но не распознано — останется в слое открытым текстом: ${open.join(", ")}\n` +
            "  проверьте файл после записи и замените значение ссылкой ${ИМЯ}");
        if ("dry-run" in flags) {
          console.log("\n--dry-run: ничего не записано.");
          break;
        }
        confirm("Записать в слой", flags);
        ensurePrivateLocal();
        adoptMcp(server, found, level, comment);
        if (codexSource) {
          adoptCodexTable(manifest, machine, name, codexSource.def);
          saveMoves(manifest, moves);
          saveManifest(manifest);
          console.log(`  Codex: таблица mcp_servers.${name} взята под учёт с бэкапом; следующий sync --global не требует --force.`);
        }
        console.log(`✓ MCP ${name} → ${file}`);
        if (Object.keys(found).length) console.log(`  на другой машине эти секреты нужно добавить в её local/secrets.env`);
      } else {
        const src = skills[0];
        if (skills.length > 1) console.log(`Копий ${skills.length}, беру ${src.dir}`);
        const plan = adoptSkill(src.dir, name, level, undefined, true);
        console.log(`План: skill ${name} → ${plan.dir}\n  файлы: ${plan.files.join(", ")}`);
        if (plan.skipped.length) console.log(`  симлинки не копируются (могли вести за пределы skill): ${plan.skipped.join(", ")}`);
        const risky = plan.files.filter((f) => /(^|\/)(\.env[^/]*|id_[a-z0-9]+|[^/]*\.(pem|key|p12|pfx))$/i.test(f));
        if (risky.length) console.log(`  ВНИМАНИЕ: похоже на секреты — попадут в слой (и в git конфигурации): ${risky.join(", ")}`);
        if ("dry-run" in flags) {
          console.log("\n--dry-run: ничего не записано.");
          break;
        }
        confirm("Скопировать в слой", flags);
        adoptSkill(src.dir, name, level);
        console.log(`✓ skill ${name} → ${plan.dir}`);
        // Префикс своих skills — skill_prefix в map.yaml конфигурации; не задан — miksy-
        const prefix = loadMap().skillPrefix ?? "miksy-";
        if (!name.startsWith(prefix)) console.log(`  совет: свои skills лучше называть с префиксом (${prefix}…), чтобы не совпадать с командными${loadMap().skillPrefix ? "" : "; свой префикс — skill_prefix в map.yaml"}`);
      }
      console.log(`\nДальше: miksy sync --all${level === "global" ? " и miksy sync --global" : ""}` +
        `\nЕсли для ${t.title} будет конфликт с исходной записью агента — miksy sync ${isGlobal ? "--global" : positional[0]} --agent <агент> --force (бэкап будет).`);
      break;
    }

    case "trust": {
      const machine = loadMachine();
      const answer = "confirm" in flags ? "yes" as const : "deny" in flags ? "no" as const : undefined;
      // Без терминала ответ — только явным флагом и для названного проекта (агент спрашивает пользователя)
      if (!ask && !answer) throw new UsageError(`без терминала решение передаётся флагом: miksy trust <проект> --confirm (только после явного «да» пользователя) или --deny`);
      if (!ask && !positional[0]) throw new UsageError("без терминала укажите проект: miksy trust <проект> --confirm | --deny");
      const groups = listGroups(machine);
      const targets = positional[0]
        ? [(() => { const p = findProject(positional[0], machine.workspace); return projectTarget(p.abs, p.rel, machine, p.nested, groups); })()]
        : allTargets(machine, groups);
      const { manifest, moves } = loadManifestMoved(machine, groups);
      saveMoves(manifest, moves);
      const secrets = loadSecrets();
      const list: { p: PendingTrust; adapter: Adapter; t: TargetSpec }[] = [];
      for (const adapter of agentsFor(machine, flags.agent).filter((a) => a.id === "claude" || a.id === "codex"))
        for (const t of targets) {
          if (t.target.scope !== "project") continue;
          const id = targetId(adapter, t.target);
          const prev = manifest.targets[id] ?? emptyState();
          const r = renderFor(adapter, t, machine, secrets, prev);
          plan(r.result, t.target, machine, prev, false, adapter.id, otherOwners(manifest, id));
          let p = r.result.trustPending;
          // Названный проект — решение можно пересмотреть, даже если оно уже есть
          if (!p && positional[0]) {
            const exec = executableSettings(t.target.dir, !!t.target.git, adapter.id as TrustAgent, ownFiles(prev, t.target.dir));
            const mcp = adapter.id === "claude" ? mcpJsonServers(t.target.dir, !!t.target.git) : null;
            if (exec) p = { dir: t.target.dir, rel: t.target.rel, agent: adapter.id as TrustAgent, ...exec, ...(mcp && { mcp: { fingerprint: mcp.fingerprint } }) };
          }
          if (p && (!p.declined || positional[0])) list.push({ p, adapter, t });
        }
      if (!list.length) {
        console.log(positional[0] ? "Исполняемых настроек агента команды нет — решение не нужно: доверие ставит sync по умолчанию." : "Решения о доверии не ждёт ни один проект.");
        break;
      }
      const conflicts = decideTrust(list, machine, manifest, answer);
      if (conflicts) code = 3;
      break;
    }

    case "target": {
      // Пометка target: true в слое дерева: каталог без git становится целью (над проектами — группой)
      const machine = loadMachine();
      const remove = "remove" in flags;
      const { abs, rel } = targetDir(positional[0] ?? ".", machine.workspace, machine.home, remove);
      const p = markPlan(layerPath(rel), remove);
      const file = slash(relative(configRoot(), p.file));
      if (p.after === p.before) console.log(remove ? `${rel}: не помечен целью (${file}) — снимать нечего` : `${rel}: уже цель (${file}: target: true)`);
      else {
        console.log(`${rel}: ${remove ? "снять пометку цели" : "сделать целью"} — ${file}: ${p.before === null ? "создать с target: true" : p.after === null ? "удалить (в нём ничего не останется)" : remove ? "убрать строку target: true" : "target: true (остальное в файле — как было)"}`);
        if ("dry-run" in flags) {
          console.log("\n--dry-run: ничего не записано.");
          break;
        }
        applyMark(p);
        console.log("✓ записано");
      }
      if (remove && p.after === p.before) break;
      // Что записать или убрать: вложенные проекты — sync --all (правила Claude ниже пересчитаются с
      // группой или без неё; файлы бывшей группы он убирает сам); иначе — сама цель: записать — sync,
      // убрать — clean, как у бывшей группы (git-репо и без пометки проект — sync пересчитает его)
      const exists = existsSync(abs);
      const nested = exists && containsProjects(abs);
      let next: [string, Record<string, string>, string[], string];
      if (!remove) {
        const warns: string[] = [];
        if (!listGroups(machine, (w) => warns.push(w)).some((g) => samePath(g.abs, abs))) {
          for (const w of warns.filter((x) => x.toLowerCase().startsWith(`цель ${rel.toLowerCase()} (target: true):`))) console.log(`предупреждение: ${w}`);
          return 1;
        }
        next = nested ? ["sync", { all: "" }, [], "Записать настройки: miksy sync --all (цель и проекты ниже неё)?"]
          : ["sync", {}, [abs], `Записать настройки в ${rel} сейчас (miksy sync ${rel})?`];
      } else {
        const { manifest } = loadManifestMoved(machine);
        if (!Object.keys(manifest.targets).some((id) => fold(id.slice(id.indexOf("|") + 1)) === fold(pathKey(abs)))) {
          console.log("miksy сюда ещё не писал — убирать нечего.");
          break;
        }
        next = nested ? ["sync", { all: "" }, [], "Убрать файлы бывшей группы и пересчитать проекты ниже: miksy sync --all?"]
          : exists && existsSync(join(abs, ".git")) ? ["sync", {}, [abs], `${rel} — git-репо, без пометки это проект. Пересчитать его настройки (miksy sync ${rel})?`]
          : ["clean", {}, [abs], `Убрать то, что miksy записал в ${rel} (miksy clean ${rel})?`];
      }
      const [cmd2, flags2, pos2, question] = next;
      const shown = `miksy ${cmd2} ${"all" in flags2 ? "--all" : `"${abs}"`}`;
      if (!ask) {
        console.log(`Дальше: ${shown}`);
        break;
      }
      if (!ask.yes(question, true)) {
        console.log(`Позже: ${shown}`);
        break;
      }
      console.log("");
      resetRun();
      code = command(cmd2, flags2, pos2);
      // Каталог, где агент работал сам (его реестр проектов: запись не только от miksy), и без
      // пометки — проект: sync --all снова запишет туда настройки
      if (cmd2 === "clean" && exists && allProjects(machine).some((x) => samePath(x.abs, abs)))
        console.log(`\nВнимание: ${rel} и без пометки — проект: в нём работал агент (его реестр проектов), sync --all снова запишет туда настройки.`);
      break;
    }

    case "setup":
      // --yes или без терминала — только безопасная часть, без вопросов
      code = setup({ ask: "yes" in flags ? null : ask, force: "force" in flags, backup: "backup" in flags, run: runCommand });
      break;

    case "version":
      console.log(`miksy ${engineVersion()}`);
      break;

    case "update":
      code = "finish" in flags
        ? finishUpdate({ from: flags.from ?? "0.0.0", ask, run: runCommand })
        : update({ ask, yes: "yes" in flags, check: "check" in flags, main: "main" in flags });
      break;

    case "doctor": {
      const machine = loadMachine();
      const { text, problems } = doctor(agentsFor(machine, flags.agent), machine, "verbose" in flags);
      console.log(text);
      if (problems) code = 1;
      break;
    }
  }
  return code;
}
