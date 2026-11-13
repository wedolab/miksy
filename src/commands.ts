// Команды miksy: разбор аргументов и выполнение в этом процессе. CLI (src/cli.ts) и мастер setup
// (src/setup.ts) вызывают runCommand; вопросы — через Ask (в терминале — prompt, в тестах — сценарий)
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { canonical, fold, homeDir, inside, pathKey, sameKey, samePath, slash, driveRoot, trimSlash } from "./paths";
import type { RenderResult } from "./adapter";
import { apply, applyPlanned, approvalExclude, describe, plan, verifyMerges, type Action } from "./apply";
import { cacheGit, gitCaching } from "./git";
import { AGENT_NOTE, AGENT_TITLE, askTrust, dialogOwn, dialogPrint, ownApprovals, executableSettings, mcpJsonServers, ownFiles, type PendingTrust, pendingText, renewDecision, saveDecision, type TrustAgent, trustedByMiksy, trustState } from "./trust";
import { backup, backupRel, KEEP_RUNS, runDir } from "./backup";
import { parseArgs, UsageError } from "./args";
import { adoptMcp, adoptSkill, elsewhereText, fromNative, layerDir, mcpYaml } from "./adopt";
import { doctor } from "./doctor";
import { foreignMcp, foreignSkills, ownMcpOf } from "./foreign";
import { expandPath, outsideRepoAdvice, projectRootText, repoAbove, setup, unsafeWorkspace } from "./setup";
import { type Ask, terminalAsk } from "./ask";
import { formatResolved } from "./explain";
import { checkTree, containsProjects, ENGINE, serviceDir, findProject, type Project, ignoredLayerParts, ignoredText, LAYER_PARTS, layerSecrets, ledgerRoots, listProjects, loadMachine, loadMap, loadSecrets, configRoot, parseRoots, parseYaml, rootMemoryKey, unknownKeys } from "./load";
import { finishUpdate, update } from "./update";
import { engineVersion, newerLedger } from "./version";
import { emptyState, joinStates, type ForgottenMark, type Manifest, otherOwners, saveManifest, splitState, strandedPaths, type TargetState, writeAtomic } from "./manifest";
import { ADAPTERS, agentsFor, allProjects, allTargets, branchNote, branchNotes, clashNotes, formerGroups, stranded, formerTarget, globalTarget, type Group, groupRulesDelivered, layersOf, ledgerSkills, listGroups, markedKind, literalHints, outsideRoots, projectTarget, launcherFor, loadManifestMoved, movesText, READERS, renderFor, rootedTargets, rootedText, rootNotes, saveMoves, type TargetSpec, targetId, targetKey, titleOf, unprotectedSecrets, unsyncedGroups, vanishedTarget, workspaceRepoNote } from "./registry";
import { merge } from "./resolve";
import { clashText, locate, machineRoots, nestedText, outerRoot, type Root, rootExists, rootKey, rootText, suggestTree, treeClashes, treeOf } from "./roots";
import { type RootItem, rootItems, rewriteRoots } from "./rootfile";
import { files, plural } from "./plural";
import { prepareSandbox, syncOut } from "./sync";
import { applyMark, layerPath, markPlan, plainDirs, plainText, targetDir } from "./target";
import { type AgentId, formatTeamSkills, scanTeamSkills } from "./teamskills";
import type { Adapter } from "./adapter";
import type { Machine, Resolved } from "./types";
import { deliveredSkillNames, deliveryOrder } from "./registry";
import { adoptCodexTable } from "./codex-adopt";
import { backupsRefusal, checkLocalAccess, ensurePrivateLocal, neededSecrets, pruneSecretFiles, secretFileState, secretsDir, writeSecretFiles } from "./secretfiles";

// Ссылка (в том числе битая)
const isLinkPath = (p: string) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

export const USAGE = `miksy — раскладывает ваши правила, MCP-серверы и skills из конфигурации (miksy-config) по
настройкам AI-агентов: Claude Code, Codex, opencode, Antigravity. В фоне не работает: поменяли
конфигурацию — запустите sync.

Установка и проверка
  miksy setup                  мастер установки; повторный запуск продолжает с несделанного и
                               находит новых агентов. --yes — без вопросов (только безопасное),
                               --yes --backup — и копия настроек агентов «до miksy»
  miksy doctor                 всё ли записано и не разошлось ли с конфигурацией (ничего не
                               меняет). Запускайте после правок конфигурации, git pull
                               в проектах и время от времени

Записать настройки агентам
  miksy sync --global          домашние настройки агентов (~/.claude, ~/.codex и т. д.) из слоёв
                               layers/global и layers/env-<ОС>: действуют во всех каталогах.
                               Когда меняли эти слои
  miksy sync --all             во все проекты (git-репо во всех папках с проектами) и папки с
                               пометкой target: true — по их месту в layers/tree. Когда меняли
                               layers/tree
  miksy sync [<путь>]          в один проект или папку (например, новый проект); без пути —
                               проект текущего каталога (и из его подпапки)
    --dry-run                  только показать, что будет записано
    --force                    заменить и файлы, правленные вручную или чужие (с копией)
    --agent <имя>              один агент: ${Object.keys(ADAPTERS).join(", ")}
                               (без флага — агенты из local/machine.yaml)
  miksy clean <путь> | --global | --all
                               убрать всё, что записал miksy, — вернуть как было до него.
                               Папки нет (диск не подключён) — уберёт, до чего дотянется;
                               данных больше нет — --forget: забыть записанное туда

Проекты и папки
  miksy projects               какие папки получают настройки
  miksy explain [<путь>]       что получит папка (без пути — текущая) и из какого слоя;
                               --global — домашние настройки агентов
  miksy target [<путь>]        папка без git (без пути — текущая) получает настройки, как
                               проект: пометка target: true в её слое. --remove — снять пометку
  miksy root add [<путь>]      ещё одна папка с проектами — корень workspace (без пути —
                               текущая); --tree <ветка> — её место в layers/tree. Папку,
                               которая сама проект (git-репо или папка внутри него), miksy
                               объяснит и спросит (--yes — без вопроса).
                               miksy root remove <путь> — убрать (--forget — как у clean);
                               miksy root — список
  miksy skills <путь> | --all  skills из репо проекта (от команды) и кто из агентов их видит

Доверие проектам
  miksy trust [<путь>]         доверять ли проекту, где есть то, что агент выполнит без вопроса и
                               что ставил не miksy: хуки, переменные окружения, разрешения,
                               серверы .mcp.json (файлы команды, .claude/settings.local.json,
                               чужой .codex/config.toml; так же в папках без git). sync спросит
                               сам. Агенту без терминала: --confirm — только после явного «да»
                               пользователя, иначе --deny. Отозвать доверие — trust: { claude:
                               false } в слое проекта

Настройки, добавленные агенту напрямую (claude mcp add и т. п.)
  miksy adopt --global <имя> --to <уровень>
  miksy adopt <путь> <имя> --to <уровень>
                               перенести MCP-сервер или skill в конфигурацию — получат все
                               агенты; уровень: global, workspace или путь в дереве (Acme,
                               Acme/app). Что перенести — покажет miksy doctor

Обновление miksy
  miksy update                 новая версия (ветка stable): покажет, что изменилось, и после
                               «да» обновит. --check — только проверить, есть ли новая
  miksy version                версия (то же — miksy --version)

Примеры
  miksy sync --all --dry-run   поменяли правило в layers/tree — посмотреть план,
  miksy sync --all             затем записать
  miksy sync --global          добавили правило для всех агентов везде (layers/global)

Подробно — README движка: «Справочник команд» (все флаги; что изменилось → что запустить) и
«Если что-то пошло не так». В путях можно писать ~. Флаги: --флаг <значение> или
--флаг=<значение>; ошибка в аргументах — код 2, ничего не выполняется.`;

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
// clean каталога, до которого не дотянуться (диск не подключён): каталог → забыть записанное туда (--forget
// или «да» на вопрос) или оставить в учёте до возвращения диска
let forgetDirs = new Map<string, boolean>();
// clean проектов с отметкой «проект забыт» в этом запуске — подсказка, что могло остаться (выпуск 0.2.1, A12)
let forgottenRun = new Set<string>();

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
  forgetDirs = new Map();
  forgottenRun = new Set();
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
  [...(deliveredSkills.get(targetKey(t)) ?? []), ...(t.target.scope === "project" ? ledgerSkills(manifest, t.target.dir, runAgents) : [])];

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
  // Каталог цели недоступен: clean убирает только достижимое (near); записи внутри каталога (far) остаются
  // в учёте или забываются
  const forget = cmd === "clean" && t.target.scope === "project" ? forgetDirs.get(fold(pathKey(t.target.dir))) : undefined;
  // С отметкой «доверие ставил miksy» после clean (Manifest.trustedBefore): ответы пользователя в окне Claude, которые
  // с тех пор не менялись, — его
  const whole = trustState(manifest, id) ?? emptyState();
  const parts = forget === undefined ? null : splitState(whole, (t.target as { dir: string }).dir);
  const far = parts && !forget ? parts.far : null;
  const prev = parts ? parts.near : whole;
  // Состояние цели после clean: снятое достижимое + оставленное на недоступном диске
  const withFar = (st: TargetState) => (far ? joinStates(st, far) : st);
  // Отметка «проект забыт» (manifest.ts: ForgottenMark): план с ней убирает ненужные файлы miksy без учёта; снимает
  // её первый sync или clean, дошедший до проекта (каталог доступен: clean недоступного каталога без записей на нём
  // до проекта не доходит — рецензия 6x)
  const reached = forget === undefined && t.target.scope === "project" && !stranded(t.target.dir, machine);
  const mark = reached ? manifest.forgotten?.[id] : undefined;
  if (cmd === "clean" && mark && t.target.scope === "project") forgottenRun.add(t.target.dir);
  // Снять свою отметку. Отметку агента, которого нет в agents, не трогаем: только с ней clean --agent <имя> узнает и
  // уберёт его файлы (учёта их больше нет); doctor называет эту команду (проверка 7b, B №1). true — учёт изменился
  const unmark = () => {
    if (!reached || "dry-run" in flags || !manifest.forgotten) return false;
    const done = Object.keys(manifest.forgotten).filter((k) => k === id);
    for (const k of done) delete manifest.forgotten[k];
    if (!Object.keys(manifest.forgotten).length) delete manifest.forgotten;
    return done.length > 0;
  };
  // Файлы других целей: один канонический файл — один владелец (общая ссылка каталогов skills)
  const owners = otherOwners(manifest, id);
  const makePlan = (p: TargetState) => plan(result, t.target, machine, p, "force" in flags, adapter.id, owners, mark);
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
  // «Да», сохранённое прежним расчётом отпечатка, — на новый (doctor и --dry-run не сохраняют)
  if (cmd === "sync" && result.trustRenew && !("dry-run" in flags)) renewDecision(result.trustRenew);
  if (cmd === "sync") result.warnings.push(...literalHints(actions, secrets, t.target.scope === "global" ? "--global" : t.target.dir, adapter.id));
  observe?.({ agent: adapter.id, title: t.title, scope: t.target.scope, ...(t.target.scope === "project" && { dir: t.target.dir }), actions, warnings: result.warnings });
  let conflicts = actions.filter((a) => a.kind === "conflict").length;
  // Файлы секретов, нужные этой цели (значения — только в local/secrets/, имена — в выводе)
  const wanted = (result.secrets ?? []).filter((n) => !secretsDone.has(n));
  const secretPlan = wanted.flatMap((n) => {
    const st = secretFileState(n, secrets);
    if (st !== "create" && st !== "update") return [];
    // Файл-ссылку (и битую) sync не перезаписывает (writeSecretFiles) — план говорит так же (повторная проверка 4 круга 8b)
    if (isLinkPath(join(secretsDir(), n))) return [`  файл секрета ${n}: это ${st === "update" ? "ссылка — не перезаписываю (значение в secrets.env другое или файл не читается — проверьте цель ссылки)" : "битая ссылка — не перезаписываю (исправьте или удалите её)"} (${secretsDir()}/${n})`];
    return [`  файл секрета ${n}: ${st === "create" ? "создать" : "обновить"} (${secretsDir()}/${n})`];
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
    deliveredSkills.set(targetKey(t), [...(deliveredSkills.get(targetKey(t)) ?? []), ...deliveredSkillNames(result, actions, t.target)]);
    // При --all цель без изменений печатается, только если есть предупреждения — чтобы было видно, чьи они
    if (!quiet || result.warnings.length) console.log(`${t.title}: изменений нет`);
    for (const w of result.warnings) console.log("  предупреждение: " + w);
    // Учёт нужных секретов — и без изменений файлов (учёт прежней версии их не знал)
    const st = manifest.targets[id];
    const names = runSecrets.get(id)!;
    // Достижимого нет, а записанное на недоступном диске забывается
    if (st && forget && !("dry-run" in flags)) {
      if (hasRecords(prev)) manifest.targets[id] = prev;
      else delete manifest.targets[id];
      markForgotten(manifest, id, adapter, whole, parts!.far);
      saveManifest(manifest);
      return 0;
    }
    // clean без действий (например, забытый проект, где файлов miksy уже нет): отметка «доверие ставил miksy» — до
    // снятия отметки «проект забыт» (рецензия 0.2.1 A, п. 6)
    let dirty = false;
    if (cmd === "clean" && forget === undefined && !("dry-run" in flags) && adapter.id === "claude" && t.target.scope === "project" && trustedByMiksy(whole, mark))
      dirty = rememberTrust(manifest, id, t.target.dir);
    // clean недоступной папки: доверие — отметкой с отпечатком последнего sync (без него — один вопрос), не everTrusted
    if (cmd === "clean" && forget === false && !("dry-run" in flags) && st && (st.everTrusted || st.dialog)) {
      strandTrust(manifest, id, adapter, t, whole, mark);
      delete st.everTrusted;
      delete st.dialog;
      dirty = true;
    }
    // Отпечаток ответов в окне Claude — и без изменений файлов (пользователь отвечал Claude после прошлого sync)
    // Доверие ставил miksy — и по записи доверия без everTrusted (учёт 0.1.x/0.2.0; рецензия 7c A, п. 2)
    if (cmd === "sync" && st && reached && !("dry-run" in flags) && adapter.id === "claude" && trustedByMiksy(st)) {
      const print = dialogPrint(t.target.dir, ownApprovals(st, t.target.dir));
      if (st.dialog !== print) { st.dialog = print; dirty = true; }
    }
    dirty = unmark() || dirty;
    // Серверы в own-файлах — и без изменений (учёт 0.2.0 их не знал)
    const ownMcp = st && cmd === "sync" ? ownMcpOf(adapter, t.target, machine, st, st) : st?.ownMcp;
    if (st && !("dry-run" in flags) && JSON.stringify(st.ownMcp ?? {}) !== JSON.stringify(ownMcp ?? {})) {
      setOwnMcp(st, ownMcp);
      dirty = true;
    }
    if (st && !("dry-run" in flags) && (JSON.stringify(st.secrets ?? []) !== JSON.stringify(names) || JSON.stringify(st.servers ?? {}) !== JSON.stringify(servers) || groupChanged(st, cmd, t))) {
      if (names.length) st.secrets = names;
      else delete st.secrets;
      setServers(st, servers);
      markGroup(st, cmd, t);
      dirty = true;
    }
    if (dirty) saveManifest(manifest);
    return 0;
  }
  console.log(`${t.title}${isGroup(cmd, t) ? ` (${markedKind(t.target)})` : ""}  [${t.cfg.layers.join(" → ") || "—"}]\n` + [...secretPlan, ...actions.map(describe)].join("\n"));
  for (const w of result.warnings) console.log("  предупреждение: " + w);
  for (const n of wanted) secretsDone.add(n);
  if ("dry-run" in flags) {
    deliveredSkills.set(targetKey(t), [...(deliveredSkills.get(targetKey(t)) ?? []), ...deliveredSkillNames(result, actions, t.target)]);
    return conflicts;
  }
  // Файлы секретов — до конфигов агента: opencode с {file:} на ещё не созданный файл не стартует
  try {
    const written = writeSecretFiles(wanted, secrets);
    // Строку «это ссылка — не перезаписываю» уже напечатал план выше (повторная проверка 5 круга 8b)
    rememberSecretFiles(manifest, written.created);
  } catch (e) {
    console.log(`  ОШИБКА (цель пропущена): файлы секретов не записаны: ${(e as Error).message}`);
    return 1;
  }

  let state: TargetState;
  let failed = 0;
  try {
    const done = applyPlanned(makePlan, prev, actions, (again) =>
      console.log("  файл изменился во время sync — план пересчитан:\n" + again.map(describe).join("\n")));
    state = done.state;
    deliveredSkills.set(targetKey(t), [...(deliveredSkills.get(targetKey(t)) ?? []), ...deliveredSkillNames(result, done.actions, t.target)]);
    writtenMerges.push(done);
    conflicts = done.actions.filter((a) => a.kind === "conflict").length;
  } catch (e) {
    // Ошибка одной цели не останавливает остальные; выполненное до ошибки — в учёт
    // Хвост — до сообщения: в нём бывает готовая команда, её копируют до конца строки (круг 8c)
    console.log(`  ОШИБКА (цель синхронизирована частично): ${(e as Error).message}`);
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
  setOwnMcp(state, cmd === "sync" ? ownMcpOf(adapter, t.target, machine, state, prev)
    : state.ownMcp && Object.fromEntries(Object.entries(state.ownMcp).filter(([k]) => state.files[k])));
  // Доверие ставил miksy (сейчас, раньше или до «забыть») — помнится, пока цель в учёте; после clean — отметкой
  // учёта без записей цели (Manifest.trustedBefore; «забыть» — отметкой «проект забыт»)
  // Каталог недоступен, записи на его диске остаются в учёте (clean без «забыть»): цель остаётся и помнит доверие сама —
  // ответов в окне Claude на недоступном диске не прочитать, отметку с отпечатком поставит clean, который дотянется
  // до папки (рецензия 7b A, п. 1)
  if (cmd === "clean") {
    if (forget === false) strandTrust(manifest, id, adapter, t, whole, mark);
    delete state.everTrusted;
    delete state.dialog;
  } else if (adapter.id === "claude" && t.target.scope === "project" && (trustedByMiksy(prev, mark) || Object.keys(state.trust ?? {}).length > 0)) {
    state.everTrusted = true;
    if (reached) state.dialog = dialogPrint(t.target.dir, ownApprovals(state, t.target.dir));
  }
  state = withFar(state);
  if (hasRecords(state) || (cmd === "sync" && conflicts) || (cmd === "clean" && conflicts && state.group))
    manifest.targets[id] = state;
  else delete manifest.targets[id];
  if (cmd === "clean" && forget === undefined && adapter.id === "claude" && t.target.scope === "project" && trustedByMiksy(whole, mark))
    rememberTrust(manifest, id, t.target.dir);
  else if (cmd === "sync" && manifest.targets[id]?.everTrusted) dropTrustedBefore(manifest, id);
  if (forget) markForgotten(manifest, id, adapter, whole, parts!.far);
  else if (!failed) unmark();
  saveManifest(manifest);
  return conflicts + failed;
}

// clean недоступной папки, которой доверие ставил miksy: ответов на диске не прочитать — отметка «доверие ставил miksy»
// с отпечатком, снятым последним sync (TargetState.dialog). Отпечатка нет (учёт прежней версии) — отметки нет: на
// следующем sync ответы в окне Claude — в вопросе, один раз (проверка 7b, A №1)
function strandTrust(manifest: Manifest, id: string, adapter: Adapter, t: TargetSpec, whole: TargetState, mark?: ForgottenMark) {
  if (adapter.id !== "claude" || t.target.scope !== "project" || !trustedByMiksy(whole, mark)) return;
  if (whole.dialog) (manifest.trustedBefore ??= {})[id] = whole.dialog;
}

// Подсказка после clean «забытого» проекта: убрать всё — sync (вернёт записанное под учёт), затем clean; вне workspace —
// сначала вернуть корень, в котором лежала папка (sync работает только в workspace). Без --agent — и строки для
// агентов вне agents, у которых по папке осталась отметка «забыт»: их файлы убирает только clean с --agent (повторные
// проверки круга 7c)
// onlyOthers — папки, где отметка «забыт» только у агентов вне agents: агентам запуска там делать нечего (их записанное
// этот же clean убрал по учёту; повторная проверка 4). Такие папки — отдельным списком со своим заголовком: в clean --all
// бывают обе (выпуск 0.2.2, A3 в)
function forgottenHint(dirs: string[], manifest: Manifest, machine: Machine, agent: string | undefined, dryRun: boolean, onlyOthers = new Set<string>()): string {
  const enabled = new Set(agentsFor(machine).map((a) => a.id));
  const main: string[] = [], others: string[] = [];
  let outside = false;
  for (const d of dirs) {
    const out = outsideRoots(d, machine);
    outside ||= out;
    const into = onlyOthers.has(d) ? others : main;
    if (out) into.push(`  miksy root add "<корень workspace, в котором лежала папка>" --tree <его ветка>`);
    const pair = (a?: string) => `  miksy sync "${d}"${a ? ` --agent ${a}` : ""}; miksy clean "${d}"${a ? ` --agent ${a}` : ""}`;
    if (!onlyOthers.has(d)) into.push(pair(agent));
    if (!agent) for (const id of Object.keys(manifest.forgotten ?? {})) {
      const a = id.slice(0, id.indexOf("|"));
      if (!enabled.has(a) && fold(id.slice(id.indexOf("|") + 1)) === fold(pathKey(d))) into.push(pair(a));
    }
  }
  const left = "Skills, плагин Antigravity и opencode.json от miksy могут остаться — они действуют у агентов и скрыты от git.";
  const how = (ls: string[]) => `Убрать всё: сначала miksy sync (вернёт записанное под учёт), затем miksy clean${ls.some((l) => l.includes(" --agent ")) && !agent ? " (агентам, которых нет в agents, — с --agent)" : ""}:\n${ls.join("\n")}`;
  const parts: string[] = [];
  if (main.length) parts.push(`${dryRun ? "План: проект забыт" : "Проект был забыт"} (miksy clean --forget или root remove --forget): учёта записанного туда нет, и clean убирает только файлы miksy, которые узнаёт сам. ${left} ${how(main)}`);
  if (others.length) parts.push(`${main.length ? "В этих папках " : ""}${dryRun ? `${main.length ? "о" : "План: о"}станутся` : `${main.length ? "о" : "О"}стались`} файлы агентов, которых нет в agents: проект был забыт (miksy clean --forget или root remove --forget), учёта их файлов нет, а clean без --agent их не трогает.${main.length ? "" : ` ${left}`} ${how(others)}`);
  // Как вернуть корень: его убрал root remove (путь и ветку он печатал, они же — в копии machine.yaml до него) или
  // основной корень сменил setup --force — выпуск 0.2.2, A3 а, б; слои — копией под новую ветку, с веткой и без (круг 8e, F2)
  const copy = `${slash(configRoot())}/local/backups/<запуск>/${backupRel(slash(join(configRoot(), "local", "machine.yaml")))}`;
  const back = `\nПапка вне workspace: sync работает только в нём — сначала верните корень, в котором она лежала (строка miksy root add выше); после clean его можно снова убрать (root remove). Путь и ветка корня:
  - корень убрали командой root remove — их печатала она («Убрать корень <путь> → layers/tree/<ветка>»); они же — в копии local/machine.yaml до неё, если копия ещё хранится (miksy хранит копии ${KEEP_RUNS} последних запусков): ${copy}; <запуск> — дата и время запуска miksy, все копии этого файла покажет ${process.platform === "win32" ? `(PowerShell) Get-ChildItem -LiteralPath '${slash(configRoot()).replace(/['‘’‚‛]/g, "$&$&")}/local/backups' -Recurse -Filter machine.yaml` : `find '${slash(configRoot()).replaceAll("'", "'\\''")}/local/backups/' -name machine.yaml`}, нужна последняя, где этот корень ещё записан (значения секретов в копии заменены на <secret:ИМЯ>);
  - корень был основным, а основной сменил miksy setup --force: путь — прежний основной (его называл тот setup: «прежний основной …» или «прежнего основного …»), ветка — любая новая, которой нет в layers/tree. Слои его проектов под неё скопируйте, а не переносите: ветки у него не было — layers/tree/<папка> → layers/tree/<ветка>/<папка>; была (её забрал новый основной, «ветка layers/tree/<прежняя> перешла к новому основному») — всё содержимое layers/tree/<прежняя> → layers/tree/<ветка>. К привязкам map.yaml (match:) его папок допишите такие же с новой веткой в начале (<папка>/** или <прежняя>/<папка>/** → ещё и <ветка>/<папка>/**), прежние не трогайте — тогда sync узнает всё записанное туда (и skills), clean уберёт всё, а слои одноимённых папок нового основного не изменятся (перенос снял бы их). На вопрос root add «Записать настройки проектам workspace сейчас?» ответьте «нет» — иначе sync --all перепишет остальные его проекты по новой ветке, без слоёв, которых вы не скопировали; на вопрос root remove «Убрать записанное miksy в эти проекты сейчас?» — тоже «нет», если остальные его проекты трогать не нужно. После root remove копию слоёв (layers/tree/<ветка>) и дописанные привязки удалите. Вернуть его насовсем, со слоями, — README, «Несколько корней workspace», «Сменить основной корень».`;
  return `\n${parts.join("\n")}${outside ? back : ""}`;
}

function setOwnMcp(st: TargetState, v: Record<string, string[]> | undefined) {
  if (v && Object.keys(v).length) st.ownMcp = v;
  else delete st.ownMcp;
}
// Отметка «доверие ставил miksy» после clean: отпечаток ответов в окне Claude, оставшихся после уборки miksy (его
// одобрений там уже нет). true — учёт изменился
function rememberTrust(manifest: Manifest, id: string, dir: string): boolean {
  const print = dialogPrint(dir, ownApprovals(manifest.targets[id], dir));
  if (manifest.trustedBefore?.[id] === print) return false;
  (manifest.trustedBefore ??= {})[id] = print;
  return true;
}
// Отметка «доверие ставил miksy» после clean больше не нужна: цель снова в учёте и помнит это сама (everTrusted)
function dropTrustedBefore(manifest: Manifest, id: string) {
  if (!manifest.trustedBefore || !Object.hasOwn(manifest.trustedBefore, id)) return;
  delete manifest.trustedBefore[id];
  if (!Object.keys(manifest.trustedBefore).length) delete manifest.trustedBefore;
}

// «Забыть» (forget): учёт помнит только факт «проект забыт» и, для Claude, ставил ли miksy доверие (ответы
// пользователя в окне Claude — его, trust.ts: dialogOwn) — если на недоступном диске было что забывать
function markForgotten(manifest: Manifest, id: string, adapter: Adapter, whole: TargetState, far: TargetState) {
  if (!hasRecords(far)) return;
  (manifest.forgotten ??= {})[id] = adapter.id === "claude" && trustedByMiksy(whole) ? { trusted: true } : {};
}

// Цели clean, чей каталог недоступен (src/registry.ts: stranded), сколько записанного miksy лежит внутри и у скольких
// из этих файлов есть оригинал — копия прежнего файла пользователя в local/backups/originals/: replaced — miksy заменил
// файл своим, blocks — только дописал свой блок (CLAUDE.local.md): файл на месте, его текст ваш (выпуск 0.2.1, A15)
// count — у всех агентов adapters («забыть» забывает и учёт агентов вне agents, A14); own — у агентов из agents (их
// файлы уберёт повторный clean, когда диск вернётся), others — у остальных: им — clean --agent (проверка 7a, B №5)
type Stranded = { dir: string; count: number; own: number; others?: { agent: string; count: number }[]; originals: number; blocks?: number };
function strandedTargets(targets: TargetSpec[], manifest: Manifest, adapters: Adapter[], machine: Machine, inAgents: Adapter[] = adapters): Stranded[] {
  const out: Stranded[] = [];
  for (const t of targets) {
    if (t.target.scope !== "project" || !stranded(t.target.dir, machine)) continue;
    const dir = t.target.dir;
    const farOf = (a: Adapter) => splitState(manifest.targets[targetId(a, t.target)] ?? emptyState(), dir).far;
    const far = adapters.map(farOf);
    const paths = new Set(far.flatMap((st) => [...strandedPaths(st)]));
    const own = new Set(adapters.filter((a) => inAgents.includes(a)).flatMap((a) => [...strandedPaths(farOf(a))])).size;
    const others = adapters.filter((a) => !inAgents.includes(a)).map((a) => ({ agent: a.id, count: strandedPaths(farOf(a)).size })).filter((o) => o.count > 0);
    const copies = far.flatMap((st) => Object.entries(st.originals ?? {}).map(([p, o]) => ({ p, block: p in (st.blocks ?? {}) && !o.restoreBlock })));
    const originals = new Set(copies.filter((c) => !c.block).map((c) => c.p)).size;
    const blocks = new Set(copies.filter((c) => c.block).map((c) => c.p)).size;
    if (paths.size) out.push({ dir, count: paths.size, own, ...(others.length > 0 && { others }), originals, ...(blocks > 0 && { blocks }) });
  }
  return out;
}
// После «забыть» — как вернуть файлы под учёт, если диск найдётся: sync проекта (совпадающие с нынешним
// выводом miksy узнает и возьмёт сам, изменённые — --force), не нужны — затем clean. sync работает только
// в workspace: проект вне всех корней — сначала вернуть его папку корнем (root add). root remove --forget
// печатает подсказку один раз на корень (regainRoot) — с путём и веткой корня
let regainRoot: Root | null = null;
// Аргумент команды в подсказке: с пробелами и прочим — в кавычках
const shellArg = (s: string) => (/^[\w./-]+$/.test(s) ? s : `"${s}"`);
// agent — запуск с --agent: и команды подсказки с ним, иначе clean без --agent снимет записанное и другим агентам (проверка
// 7c, B №1)
const syncBack = (dir: string, agent?: string) => { const a = agent ? ` --agent ${agent}` : ""; return `miksy sync "${dir}"${a} — файлы miksy, совпадающие с нынешними, он возьмёт обратно сам, изменённые — с miksy sync "${dir}"${a} --force (бэкап будет); если они не нужны — после этого miksy clean "${dir}"${a}`; };
export const strandedText = (s: Stranded, forgot: boolean, dryRun: boolean, machine?: Machine, agent?: string) => {
  if (!forgot) {
    // Запуск с --agent считал только его файлы — и советы с тем же --agent (рецензия 7b A, п. 5)
    const only = agent ? ` --agent ${agent}` : "";
    const own = s.own > 0 ? [`${files(s.own)} в ${s.dir}: подключите диск и повторите miksy clean "${s.dir}"${only}`] : [];
    const others = (s.others ?? []).map((o) => `${files(o.count)} агента ${o.agent} (его нет в agents${own.length ? "" : `, папка ${s.dir}`}): когда диск вернётся — miksy clean "${s.dir}" --agent ${o.agent}`);
    return `На недоступном диске ${dryRun ? "останется" : "осталось"} записанное miksy — ${[...own, ...others].join("; ")}; данных больше нет — miksy clean "${s.dir}" --forget${only}.`;
  }
  // «Забыть» значит забыть: оригиналы (miksy когда-то заменил файлы пользователя) сами на место не вернутся
  const store = `${slash(join(configRoot(), "local", "backups", "originals"))}/`;
  const copies = (s.originals ? ` Копии ваших прежних файлов (${s.originals}), которые miksy когда-то заменил, ${dryRun ? "останутся" : "остаются"} в ${store} — сами на место не вернутся.` : "")
    + (s.blocks ? ` В ${s.blocks} ${plural(s.blocks, "файле", "файлах", "файлах")} (CLAUDE.local.md и т. п.) miksy только дописал свой блок: файл ваш и остаётся на месте, miksy уберёт из него только свой блок; копию «до блока» в ${store} поверх него не возвращайте — потеряете дописанное позже.` : "");
  // Агенты, которых нет в agents: их файлы sync и clean без --agent не тронут — команда для каждого (проверка 7b, B №1)
  const others = (s.others ?? []).length ? ` Файлы агентов, которых нет в agents, когда диск найдётся, уберёт ${s.others!.map((o) => `miksy clean "${s.dir}" --agent ${o.agent}`).join(", ")} (miksy узнает их сам; если clean напишет «Проект был забыт» — выполните и его подсказку).` : "";
  const done = `${dryRun ? "План: записанное" : "Записанное"} в ${s.dir} (${files(s.count)} на недоступном диске) ${dryRun ? "будет забыто" : "забыто"}.${copies}${others}`;
  if (regainRoot && locate(s.dir, [regainRoot])) return done;
  if (machine && outsideRoots(s.dir, machine))
    return `${done} Если диск найдётся: сначала верните прежний корень workspace, в котором лежал проект, с его прежней веткой (miksy root add "<прежний корень>" --tree <прежняя ветка>), затем ${syncBack(s.dir, agent)}.`;
  return `${done} Если диск найдётся: ${syncBack(s.dir, agent)}.`;
};

// Что осталось в учёте после clean --all: проекты недоступных корней (по корням) и цели вне workspace
// former — бывшие группы, которые этот же запуск убирает сам (рецензия 0.2.1 A, п. 4)
function leftAfterAll(manifest: Manifest, machine: Machine, targets: TargetSpec[], dryRun: boolean, former: string[] = []): string[] {
  const done = new Set([...targets.flatMap((t) => (t.target.scope === "project" ? [fold(pathKey(t.target.dir))] : [])), ...former.map((d) => fold(pathKey(d)))]);
  const dirs = [...new Set(Object.keys(manifest.targets).map((id) => id.slice(id.indexOf("|") + 1)))].filter((d) => d !== "global" && !done.has(fold(d))).sort();
  if (!dirs.length) return [];
  const roots = machineRoots(machine);
  const out: string[] = [];
  for (const [i, r] of roots.entries()) {
    if (rootExists(r)) continue;
    const mine = dirs.filter((d) => locate(d, [r]) && locate(d, roots)?.root === r);
    if (!mine.length) continue;
    // В числе — только агенты из agents (их файлы уберёт повторный clean --all); остальным — clean --agent, как у doctor
    // (проверка 7b, B №4)
    const enabled = new Set(agentsFor(machine).map((a) => a.id));
    const paths = (keep: (agent: string) => boolean) => new Set(mine.flatMap((d) => Object.entries(manifest.targets)
      .filter(([id]) => fold(id.slice(id.indexOf("|") + 1)) === fold(d) && keep(id.slice(0, id.indexOf("|"))))
      .flatMap(([, st]) => [...strandedPaths(splitState(st, d).far)]))).size;
    const count = paths((a) => enabled.has(a));
    const others = [...new Set(mine.flatMap((d) => Object.keys(manifest.targets).filter((id) => fold(id.slice(id.indexOf("|") + 1)) === fold(d)
      && !enabled.has(id.slice(0, id.indexOf("|"))) && strandedPaths(splitState(manifest.targets[id], d).far).size > 0)
      .map((id) => `  miksy clean "${d}" --agent ${id.slice(0, id.indexOf("|"))}`)))];
    const forget = i === 0 ? `miksy clean "<путь проекта>" --forget в каждом из них` : `miksy root remove "${r.given ?? r.path}" --forget (корень уйдёт из workspace, записанное туда забудется)`;
    out.push(`Корень ${r.path} недоступен (${r.away ?? "каталога нет"}): в его проектах (${mine.length}) ${dryRun ? "останется" : "осталось"} записанное miksy — ${count ? `${files(count)}, учёт помнит его. Подключите диск и повторите miksy clean --all` : "только агентами, которых нет в agents (ниже)"}; данных больше нет — ${forget}:\n${mine.map((d) => `  ${d}`).join("\n")}${others.length ? `\nЗаписанное агентами, которых нет в agents, clean --all не убирает — когда диск вернётся:\n${others.join("\n")}` : ""}`);
  }
  const outside = dirs.filter((d) => outsideRoots(d, machine));
  // Остальные — каталог удалён или переехал и не найден (doctor: «Учёт ссылается на несуществующие каталоги»)
  const rest = dirs.filter((d) => !outside.includes(d) && !roots.some((r) => !rootExists(r) && locate(d, roots)?.root === r));
  if (rest.length) out.push(`Цели учёта, которых clean --all не нашёл (${rest.length}) — каталог удалён или переехал. Убрать записанное вне их каталога (ключи MCP, доверие) и учёт:\n${rest.map((d) => `  miksy clean "${d}"${existsSync(d) ? "" : " --forget"}`).join("\n")}`);
  if (outside.length) out.push(`Цели учёта вне workspace (${outside.length}) — их корень убран или workspace сменился, clean --all их не обходит. Убрать записанное туда:\n${outside.map((d) => `  miksy clean "${d}"${existsSync(d) ? "" : " --forget  (каталога нет)"}`).join("\n")}`);
  return out;
}

// Есть ли в учёте цели что-то записанное (иначе запись цели не нужна)
const hasRecords = (st: TargetState) => [st.files, st.blocks, st.trust, st.approvals, st.merges, st.exclude, st.toml].some((x) => x && Object.keys(x).length);

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
function applyTrust(adapter: Adapter, machine: Machine, t: TargetSpec, manifest: Manifest, answer: "yes" | "no"): number {
  const id = targetId(adapter, t.target);
  const prev = trustState(manifest, id) ?? emptyState();
  const r = renderFor(adapter, t, machine, loadSecrets(), prev, deliveredSkills.get(targetKey(t)));
  // Запрет доверия (trust: false) мешает «да» — сказать, где он, и что решение подействует после его снятия: и когда
  // доверия нет, и когда план снимает поставленное раньше (выпуск 0.2.1, A3; проверка 7a, A №4)
  const agent = adapter.id as TrustAgent;
  const where = machine.trust?.[agent] === false ? "в local/machine.yaml"
    : r.result.trust?.[agent]?.item === false ? `в слое ${r.result.trust[agent]!.layer} (его layer.yaml)` : null;
  const ban = where && answer === "yes" ? `запрет trust: { ${agent}: false } ${where}; решение записано — доверие поставит следующий miksy sync после снятия запрета` : null;
  const planned = plan(r.result, t.target, machine, prev, false, adapter.id, otherOwners(manifest, id), manifest.forgotten?.[id]);
  const actions = planned.filter((a) => a.kind === "trust" || a.kind === "approve" || (a.kind === "conflict" && /\/(\.codex\/config\.toml|\.claude\.json|\.claude\/settings\.local\.json)$/.test(a.abs)));
  // Файл одобрений скрыт от git вместе с одобрением — до его создания (Г10)
  const ex = t.target.scope === "project" ? approvalExclude(planned, t.target.dir) : null;
  if (ex) actions.push(ex);
  if (!actions.length) {
    console.log(`  ${AGENT_TITLE[agent]} ${t.title}: доверие не меняется${ban ? ` — ${ban}` : ""}`);
    return 0;
  }
  console.log(actions.map(describe).join("\n"));
  if (ban) console.log(`  ${AGENT_TITLE[agent]} ${t.title}: доверие не ставится — ${ban}`);
  try {
    const { state } = apply(actions, prev);
    // Доверие ставил miksy (сейчас, раньше или до «забыть») — помнится и после отказа (trust --deny)
    if (adapter.id === "claude" && t.target.scope === "project" && (trustedByMiksy(prev, manifest.forgotten?.[id]) || Object.keys(state.trust ?? {}).length > 0)) state.everTrusted = true;
    manifest.targets[id] = state;
    if (state.everTrusted) dropTrustedBefore(manifest, id);
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
    conflicts += applyTrust(adapter, machine, t, manifest, a);
  }
  return conflicts;
}

// Каталоги, где агенты уже работали (их реестры проектов): тоже проекты, и без git
const agentDirs = (machine: Machine) => new Set(Object.values(ADAPTERS).flatMap((a) => a.knownDirs?.(machine) ?? []).flatMap((d) => { try { return [fold(pathKey(d))]; } catch { return []; } }));

// Каталог для root add, который сам проект: git-репо (без проектов внутри), проект или цель target: true другого
// корня, каталог с записанным miksy. Текст — общий с мастером setup (projectRootText); иначе null
function projectRoot(dir: string, machine: Machine, roots: Root[]): string | null {
  const at = locate(dir, roots);
  const group = at && at.rel !== "" ? listGroups(machine).some((g) => sameKey(g.abs, dir)) : false;
  const recorded = Object.keys(loadManifestMoved(machine).manifest.targets).some((id) => fold(id.slice(id.indexOf("|") + 1)) === fold(pathKey(dir)));
  return projectRootText(dir, machine.home, roots, { group, recorded });
}

// Цель одного sync (и sync --out): по пути или (без пути) по текущему каталогу.
// Без пути — только то, что и так цель: проект (git-репо или каталог, где работал агент) или его
// подпапка, цель target: true или её подпапка (ближайшая цель вверх). Корень workspace, каталог без git,
// который не цель, и каталог вне workspace — ошибка с подсказкой, без записи: новую цель создают явно.
// Явный путь — как раньше: проект вверх до git, иначе сам каталог; plain — он не цель (sync --all его
// не обновит) — предупредить
function syncProject(path: string | undefined, machine: Machine, out: boolean): { p: Project; plain: boolean } {
  const roots = machineRoots(machine);
  const list = roots.map((r) => r.path).join(", ");
  const how = out ? "sync --out без пути показывает" : "sync без пути пишет";
  const rootError = (abs: string) => new UsageError(`${abs} — корень workspace, а не проект: ${path === undefined || path === "." ? `${out ? "sync --out" : "sync"} без пути (и с путём «.»)` : "sync <путь>"} — для одного проекта. Все проекты — miksy sync --all, домашние настройки агентов — miksy sync --global`);
  const groups = listGroups(machine);
  const known = agentDirs(machine);
  const isGroup = (d: string) => groups.find((g) => sameKey(g.abs, d));
  if (path === undefined) {
    const cwd = slash(realpathSync.native(process.cwd()));
    // Служебные каталоги miksy (копии и бэкапы в out/, local/, dist/ движка и конфигурации) — не проекты:
    // их пропускают projects, sync --all и target
    if (serviceDir(cwd))
      throw new UsageError(`${cwd} — служебный каталог miksy (копии, бэкапы, сборки): настройки сюда не пишутся. Проект — miksy ${out ? "sync <путь проекта> --out <каталог>" : "sync <путь проекта>"}; все проекты — miksy sync --all`);
    const at = locate(cwd, roots);
    if (!at) {
      // Совет — по месту: каталог, в котором лежит корень (D:\ при корне D:/ai), домашний или корень диска
      // корнем делать не стоит — им стал бы весь диск или дом
      // В git-репо (или его подкаталоге) — что сделает его проектом: корень — папка, где он лежит (корнем сам репо
      // стал бы папкой с проектами, а не проектом, — рецензия 6x, B3)
      const holds = roots.find((r) => inside(r.path, cwd));
      const unsafe = unsafeWorkspace(cwd, machine.home);
      // Репо — дом или диск целиком (dotfiles и т. п.) — не проект: подсказка как вне git
      const above = holds ? null : repoAbove(cwd);
      const repo = above && !unsafeWorkspace(above, machine.home) ? above : null;
      const hint = holds ? `в нём лежит корень workspace ${holds.path} — перейдите в каталог проекта внутри него`
        : repo ? `${sameKey(repo, cwd) ? "это git-репо" : `каталог лежит в git-репо ${repo}`} вне workspace. Чтобы miksy писал в него настройки проекта, ${outsideRepoAdvice(repo, machine.home, roots)}`
        : unsafe ? `корнем его делать не стоит (${unsafe})`
        // Корень — папка с проектами: без проектов внутри root add . дал бы «Проектов в нём: 0» (рецензия 6y)
        : containsProjects(cwd) ? "сделать этот каталог корнем workspace — miksy root add ."
        : `проектов (git-репо) в нём нет, а корень workspace — папка с проектами. Сделать его проектом — git init в нём, затем ${outsideRepoAdvice(cwd, machine.home, roots)}; если сюда вы будете класть проекты — miksy root add .`;
      throw new UsageError(`${cwd} — каталог вне workspace (${list}); ${how} настройки проекта, в каталоге которого вы находитесь. Здесь: ${hint}; ${out ? "домашние настройки агентов в песочницу — miksy sync --global --out <каталог>" : "домашние настройки агентов — miksy sync --global"}`);
    }
    // Корень, содержащий домашний каталог, отклоняет projectTarget — своим сообщением (про дом)
    if (!at.rel) {
      if (inside(machine.home, cwd)) return { p: findProject(cwd, roots), plain: false };
      throw rootError(cwd);
    }
    for (let d = cwd; inside(d, at.root.path) && !sameKey(d, at.root.path); d = slash(dirname(d))) {
      if (existsSync(join(d, ".git"))) return { p: findProject(d, roots), plain: false };
      const g = isGroup(d);
      if (g) return { p: { abs: g.abs, rel: g.rel, nested: g.nested, root: at.root }, plain: false };
      if (known.has(fold(d)) && !containsProjects(d)) return { p: findProject(d, roots), plain: false };
    }
    throw new UsageError(`${cwd} — не проект: каталог без git и не цель${containsProjects(cwd) ? " (внутри — проекты)" : ""}; ${how} настройки только проекту или цели. Сделать его проектом — git init, целью без git — miksy target; все проекты — miksy sync --all`);
  }
  const p = findProject(path, roots);
  if (roots.some((r) => sameKey(r.path, p.abs)) && !inside(machine.home, p.abs)) throw rootError(p.abs);
  const plain = !existsSync(join(p.abs, ".git")) && !isGroup(p.abs) && !known.has(fold(pathKey(p.abs)));
  return { p, plain };
}

const tilde = (s: string) => (/^~(?=$|[\\/])/.test(s) ? homeDir() + s.slice(1).replaceAll("\\", "/") : s);

// Одна команда miksy: код выхода (0 — успех, 1 — проблемы doctor, 3 — конфликты). Ошибки — исключения
// (UsageError — код 2, Cancelled — отказ в подтверждении). io.ask — вопросы (по умолчанию — терминал,
// если он есть); io.observe — план каждой цели sync/clean. Кеш git — на одну команду (если включён)
export function runCommand(cmd: string, rest: string[], io: { ask?: Ask | null; observe?: (r: TargetReport) => void } = {}): number {
  const parsed = parseArgs(cmd, rest);
  // «~», «~/…» и «~\…» в путях — домашний каталог: PowerShell 5.1 передаёт «~» программе как есть (выпуск 0.2.1, A4).
  // Имена (adopt <путь> <имя>) и значения других флагов так не начинаются
  const positional = parsed.positional.map(tilde);
  const flags = "out" in parsed.flags ? { ...parsed.flags, out: tilde(parsed.flags.out) } : parsed.flags;
  ask = io.ask !== undefined ? io.ask : process.stdin.isTTY ? terminalAsk : null;
  observe = io.observe ?? null;
  resetRun();
  if (gitCaching()) cacheGit();
  try { return command(cmd, flags, positional); }
  finally { ask = null; observe = null; }
}

function command(cmd: string, flags: Record<string, string>, positional: string[]): number {
  let code = 0;
  // Запись в local/backups отказана (ссылка с открытой или несуществующей целью) — пишущие команды останавливаются в
  // начале, до вопросов и записи; их --dry-run — та же строка и код 1 (выпуск 0.2.2, круг 8c, C10; рецензия A, п. 7)
  if (["sync", "clean", "trust", "target", "adopt"].includes(cmd) || (cmd === "root" && ["add", "remove"].includes(positional[0]))) {
    const refuse = backupsRefusal();
    if (refuse) {
      if ("dry-run" in flags) { console.log(`Ошибка (запуск откажет): ${refuse}`); return 1; }
      throw new Error(refuse);
    }
  }
  switch (cmd) {
    case "explain": {
      const machine = loadMachine();
      const roots = machineRoots(machine);
      let title: [string, string][];
      let cfg: Resolved;
      // Без пути — текущий каталог (как sync); --global — домашние настройки агентов. Каталог вне всех
      // корней workspace получает только глобальные настройки — их и показываем
      if (positional[0] !== undefined && !existsSync(driveRoot(positional[0]))) findProject(positional[0], roots); // понятная ошибка «каталога нет»
      const abs = "global" in flags ? "" : slash(realpathSync.native(resolve(driveRoot(positional[0] ?? "."))));
      // Без пути в служебном каталоге miksy — как у sync: это не проект
      if (abs && positional[0] === undefined && serviceDir(abs))
        throw new UsageError(`${abs} — служебный каталог miksy (копии, бэкапы, сборки): настроек он не получает. Что получит проект — miksy explain <путь проекта>`);
      const place = abs ? locate(abs, roots) : null;
      const many = roots.length > 1 || roots.some((r) => r.tree);
      // Вложенный корень — справка: внутри какого корня он лежит
      const rootRows = (r: Root, tree: string): [string, string][] => {
        const outer = outerRoot(r, roots);
        return many ? [["Корень", `${r.path}${outer ? ` (внутри корня ${outer.path})` : ""}`], ["Место в дереве", `layers/tree${tree ? `/${tree}` : ""}`]] : [];
      };
      if (!abs) {
        ({ cfg } = globalTarget(machine));
        title = [["Цель", `домашний каталог агентов (${machine.home})`], ["ОС", machine.os]];
      } else if (!place) {
        ({ cfg } = globalTarget(machine));
        title = [["Каталог", abs], ["Цель",`вне workspace — только глобальные настройки (${machine.home})`], ["ОС", machine.os]];
      } else if (!place.rel) {
        // Сам корень — не цель: показываем слои, общие для его проектов
        cfg = merge(layersOf(place.tree, machine), machine.os);
        title = [["Корень workspace", place.abs], ...rootRows(place.root, place.tree).slice(1), ["Цель", "корень — не цель; это слои, общие для его проектов (каждый проект получит ещё свои)"], ["ОС", machine.os]];
      } else {
        // Без пути — как sync без пути (подпапка цели — сама цель); каталог без git, который не цель, —
        // его слои с пометкой, что настроек он не получает
        let p = findProject(abs, roots);
        let plain = !existsSync(join(p.abs, ".git"));
        if (plain) {
          try { ({ p, plain } = syncProject(positional[0], machine, false)); }
          catch (e) { if (!(e instanceof UsageError)) throw e; }
        }
        const t = projectTarget(p.abs, p.rel, machine, p.nested);
        cfg = t.cfg;
        title = [[t.target.scope === "project" && t.target.group ? (t.target.nested ? "Цель-группа" : "Цель без git") : plain ? "Каталог без git" : "Проект", t.title], ["Каталог", p.abs], ...rootRows(p.root, p.rel), ["ОС", machine.os]];
        // Ветка корня внутри чужого места — справка с рекомендацией
        const note = branchNote(p.root, roots);
        if (note) title.push(["Ветка корня", note]);
        if (plain)
          title.push(["Цель", `не проект и не цель — sync --all его не обновит (sync <путь> запишет разово); сделать целью — miksy target, проектом — git init`]);
        // Ниже группы: агенты, читающие правила родительских каталогов (Claude), получают здесь только отрезок
        const below = cfg.below;
        if (below) title.push(
          ["Группа выше", below.groups.map((g) => g.rel).join(" → ")],
          ["Claude здесь", `правила только слоёв ${below.layers.join(" → ") || "—"} (остальные — из файлов групп выше)`]);
      }
      title.unshift(["Конфигурация", configRoot().replaceAll("\\", "/")]);
      title.unshift(["Движок miksy", ENGINE.replaceAll("\\", "/")]);
      console.log(formatResolved(title, cfg, machine, loadSecrets()));
      if (place) console.log("\n(+ глобальные слои — см. `miksy explain --global`)");
      break;
    }

    case "skills": {
      const machine = loadMachine();
      const mine = agentsFor(machine, flags.agent).map((a) => a.id) as AgentId[];
      const list = "all" in flags
        ? allProjects(machine, undefined, (w) => console.log("предупреждение: " + w))
        : positional[0] ? [findProject(positional[0], machineRoots(machine))]
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
      for (const n of [...rootNotes(machine, groups), ...clashNotes(machine)]) warn(n);
      const roots = machineRoots(machine);
      // Вложенный корень — справка у самого корня
      if (roots.length > 1 || roots.some((r) => r.tree))
        console.log(`Корни workspace (${roots.length}):\n${roots.map((r) => { const o = outerRoot(r, roots); return `  ${rootText(r)}${o ? `  (внутри корня ${o.path})` : ""}${rootExists(r) ? "" : "  — недоступен"}`; }).join("\n")}\n`);
      const gdirs = new Set(groups.map((g) => fold(g.abs)));
      const list = allProjects(machine, flags.agent ? agentsFor(machine, flags.agent) : undefined, warn).filter((p) => !gdirs.has(fold(pathKey(p.abs))));
      const rows = [
        ...groups.map((g) => ({ rel: titleOf(g.rel, g.root, machine), note: `   (${markedKind(g)}: target: true в layer.yaml${g.git ? ", git-репо" : ""})` })),
        ...list.map((p) => ({ rel: titleOf(p.rel, p.root, machine), note: p.nested ? "   (внутри есть другие проекты — CLAUDE.local.md сюда не пишется)" : "" })),
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

      // Одна цель sync — проект по пути или (без пути) текущего каталога: проверка до учёта и записи
      const single = cmd === "sync" && !("all" in flags) && !("global" in flags) ? syncProject(positional[0], machine, "out" in flags) : null;
      const one = single?.p ?? null;
      if (cmd === "clean" && !positional[0] && !("all" in flags) && !("global" in flags))
        throw new UsageError("clean убирает записанное — только явно: укажите путь проекта, --global или --all");
      if (single?.plain && !("out" in flags))
        console.log(`предупреждение: ${one!.rel} — каталог без git и не цель: sync --all его не обновит (и doctor не проверит). Сделать целью — miksy target "${one!.abs}"\n`);
      // Ветка этой цели совпала с веткой другого корня: её слои получат обе папки
      if (one) for (const c of treeClashes(machineRoots(machine)).filter((c) => inside(one.abs, c.dir) || inside(one.abs, c.root.path)))
        console.log(`предупреждение: ${clashText(c)}\n`);

      if (cmd === "sync" && "out" in flags) {
        const p = one;
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
      const roots = machineRoots(machine);
      const unsafe = roots.flatMap((r) => { const why = unsafeWorkspace(r.path, machine.home); return why ? [`${r.path} — ${why}`] : []; });
      if (writeAll && unsafe.length) confirm(`workspace ${unsafe.join("; ")}: sync --all запишет конфиги во все git-репо внутри`, flags);

      const warn = (w: string) => console.log("предупреждение: " + w);
      allMode = "all" in flags;
      runGroups = "global" in flags ? [] : listGroups(machine, allMode ? warn : undefined);
      const repoNote = allMode && workspaceRepoNote(machine, runGroups);
      if (repoNote) warn(repoNote);
      if (allMode) for (const n of [...rootNotes(machine, runGroups), ...clashNotes(machine)]) warn(n);
      // Учёт — с переездами каталогов: sync и clean сохраняют перенос до записи целей
      const { manifest, moves, rootsChanged } = loadManifestMoved(machine, "global" in flags ? undefined : runGroups);
      const newer = newerLedger(manifest.engine);
      if (newer) console.log(`предупреждение: ${newer}\n`);
      // Проект (цель), который стал корнем workspace: записанное в него раньше не висит молча
      if (allMode) for (const d of rootedTargets(manifest, machine)) warn(rootedText(d, machine));
      if (moves.length) {
        console.log(`${"dry-run" in flags ? "План: учёт miksy переедет вслед за каталогами" : "Учёт miksy перенесён вслед за каталогами"}:\n${movesText(moves).join("\n")}\n`);
        if (!("dry-run" in flags)) saveMoves(manifest, moves);
      }
      const targets = allMode
        ? allTargets(machine, runGroups, warn)
        : "global" in flags ? [globalTarget(machine)]
        : one ? [projectTarget(one.abs, one.rel, machine, one.nested, runGroups)]
        : [vanishedTarget(positional[0], manifest, machine) || (() => { const p = findProject(positional[0], roots); return projectTarget(p.abs, p.rel, machine, p.nested, runGroups); })()];

      const adapters = agentsFor(machine, flags.agent);
      runAgents = new Set(adapters.map((a) => a.id));
      // «Забыть» каталог — и записанное туда агентами, которых убрали из agents без clean: данных на диске больше нет,
      // учёт о них не нужен ни одному агенту; так же считает и вопрос «забыть?», и root remove (выпуск 0.2.1, A14).
      // С --agent — только он
      const forgetting = cmd === "clean" && !flags.agent ? Object.values(ADAPTERS) : adapters;
      if (allMode) {
        // Цели до записи: известные (уже в учёте) — списком, новые — по одной в строке
        const known = new Set(Object.keys(manifest.targets).map((id) => id.slice(id.indexOf("|") + 1).toLowerCase()));
        const fresh = targets.filter((t) => t.target.scope === "project" && !known.has(t.target.dir.toLowerCase()));
        const old = targets.filter((t) => !fresh.includes(t));
        const marked = targets.filter((t) => t.target.scope === "project" && t.target.group);
        const groupTitles = marked.filter((t) => t.target.scope === "project" && t.target.nested).map((t) => t.title);
        const bareTitles = marked.filter((t) => !groupTitles.includes(t.title)).map((t) => t.title);
        console.log(`${cmd} --all: workspace ${roots.map(rootText).join(", ")}; проектов: ${targets.length - marked.length}; агенты: ${adapters.map((a) => a.id).join(", ")}`);
        if (groupTitles.length) console.log(`  группы (${groupTitles.length}): ${groupTitles.join(", ")}`);
        if (bareTitles.length) console.log(`  цели без git (${bareTitles.length}): ${bareTitles.join(", ")}`);
        if (old.length) console.log(`  уже в учёте (${old.length}): ${old.map((t) => t.title).join(", ")}`);
        if (fresh.length) console.log(`  новые — miksy в них ещё не писал (${fresh.length}):\n${fresh.map((t) => "    " + t.title).join("\n")}`);
        const plain = cmd === "sync" ? plainDirs(roots, runGroups, targets) : [];
        if (plain.length) console.log(`  ${plainText(plain)}`);
        if (writeAll && fresh.length > NEW_TARGETS_LIMIT)
          confirm(`новых целей: ${fresh.length} (больше ${NEW_TARGETS_LIMIT}) — miksy создаст файлы в каждом из этих репо`, flags);
      }
      // clean каталога, до которого не дотянуться: достижимое убирается, записанное внутри — остаётся в учёте
      // (miksy узнает свои файлы, когда диск вернётся) или забывается: --forget или «да» на вопрос
      const unreachable = cmd === "clean" ? strandedTargets(targets, manifest, forgetting, machine, adapters) : [];
      for (const s of unreachable) {
        let drop = "forget" in flags;
        if (!drop && ask && !("dry-run" in flags))
          drop = ask.yes(`Каталога ${s.dir} нет: диск не подключён или данных больше нет? Забыть записанное туда (${files(s.count)})?`, false);
        forgetDirs.set(fold(pathKey(s.dir)), drop);
      }
      let conflicts = 0;
      // Права local/: проверка одним снимком; исправление — только при открытых путях
      if ("dry-run" in flags) {
        const access = checkLocalAccess();
        if (access.bad.length) console.log(`\nДоступ local/: закрыть владельцу (открытых путей или ошибок проверки: ${access.bad.length}).`);
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
      // Агенты вне agents: только забываемые каталоги, где у них есть учёт
      for (const adapter of forgetting.filter((a) => !adapters.includes(a))) {
        const gone = targets.filter((t) => t.target.scope === "project" && forgetDirs.get(fold(pathKey(t.target.dir))) === true && manifest.targets[targetId(adapter, t.target)]);
        if (!gone.length) continue;
        console.log(`\n=== ${adapter.id} (нет в agents — забывается и его учёт)`);
        for (const t of gone) conflicts += runTarget(cmd, adapter, machine, t, manifest, flags, gone.length > 1);
      }
      // Лишние файлы секретов: не нужны ни целям этого запуска, ни остальным целям учёта
      for (const s of unreachable) console.log(`\n${strandedText(s, forgetDirs.get(fold(pathKey(s.dir)))!, "dry-run" in flags, machine, flags.agent)}`);
      // Папки нет, а в учёте о ней — только отметка «проект забыт» (записей нет: clean до неё не доходит и молчал бы):
      // сказать, что осталось и чем убрать; с --forget — убрать отметку (выпуск 0.2.2, A3 е)
      if (cmd === "clean") for (const t of targets) {
        if (t.target.scope !== "project" || !stranded(t.target.dir, machine) || unreachable.some((s) => s.dir === t.target.dir)) continue;
        const ids = forgetting.map((a) => targetId(a, t.target)).filter((id) => manifest.forgotten?.[id]);
        if (!ids.length) continue;
        const dir = t.target.dir, names = ids.map((id) => id.slice(0, id.indexOf("|"))).join(", ");
        const only = flags.agent ? ` --agent ${flags.agent}` : "";
        if (!("forget" in flags)) {
          console.log(`\nПапки ${dir} нет (${outsideRoots(dir, machine) ? "она вне workspace" : "её корень недоступен"}): записанного туда учёт не помнит, осталась только отметка «проект забыт» (${names}) — по ней miksy узнает свои файлы, если папка вернётся (тогда — miksy clean "${dir}"${only}). Папки больше не будет — убрать отметку: miksy clean "${dir}" --forget${only}`);
          continue;
        }
        if (!("dry-run" in flags)) {
          for (const id of ids) delete manifest.forgotten![id];
          if (!Object.keys(manifest.forgotten!).length) delete manifest.forgotten;
          saveManifest(manifest);
        }
        console.log(`\n${"dry-run" in flags ? "План: отметка" : "Отметка"} «проект забыт» папки ${dir} (${names}) ${"dry-run" in flags ? "будет убрана" : "убрана"} из учёта.`);
      }
      // clean «забытого» проекта убрал только узнанное по уликам — сказать, что могло остаться (выпуск 0.2.1, A12)
      // И папки, где отметка «забыт» осталась только у агентов вне agents: их файлы уберёт лишь clean с --agent — без
      // подсказки человек о них не узнал бы (повторная проверка 3 круга 7c, п. 1)
      const onlyOthers = new Set<string>();
      if (cmd === "clean" && !flags.agent) {
        const enabled = new Set(agentsFor(machine).map((a) => a.id));
        for (const t of targets) {
          if (t.target.scope !== "project" || stranded(t.target.dir, machine)) continue;
          const dir = fold(pathKey(t.target.dir));
          if (!Object.keys(manifest.forgotten ?? {}).some((id) => !enabled.has(id.slice(0, id.indexOf("|"))) && fold(id.slice(id.indexOf("|") + 1)) === dir)) continue;
          if (!forgottenRun.has(t.target.dir)) onlyOthers.add(t.target.dir);
          forgottenRun.add(t.target.dir);
        }
      }
      if (cmd === "clean" && forgottenRun.size)
        console.log(forgottenHint([...forgottenRun], manifest, machine, flags.agent, "dry-run" in flags, onlyOthers));
      // clean --all не дотягивается до проектов недоступного корня и целей учёта вне workspace — итог: что осталось
      // и что сделать (выпуск 0.2.1, A13)
      if (cmd === "clean" && allMode) for (const l of leftAfterAll(manifest, machine, targets, "dry-run" in flags, [...printedFormer])) console.log(`\n${l}`);
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
      // Настоящие пути корней — в учёт, даже если цели не изменились: без них цели корня-ссылки, ставшего
      // недоступным, выглядели бы пропавшими (src/load.ts: parseRoots)
      if (!("dry-run" in flags) && rootsChanged && Object.keys(manifest.targets).length) saveManifest(manifest);

      // Доверие проектам с исполняемыми настройками агента: в терминале — вопрос по каждому (--yes его
      // не снимает); без терминала и в --dry-run — список и указание агенту спросить пользователя
      if (pendingTrust.size) {
        const list = [...pendingTrust.values()];
        console.log(`\nНужно решение пользователя о доверии (${list.length}) — у проектов исполняемые настройки агента, которые ставил не miksy (команда проекта, ответы в окне Claude, чужие файлы); без решения miksy доверие не ставит:`);
        if (!("dry-run" in flags) && ask) conflicts += decideTrust(list, machine, manifest);
        else console.log(`${pendingText(list.map((x) => x.p)).join("\n")}\n${AGENT_NOTE}`);
      }

      // План root remove --forget --dry-run по проектам (regainRoot): итог печатает он сам
      if ("dry-run" in flags) { if (!regainRoot) console.log("\n--dry-run: ничего не записано."); }
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
      const t = isGlobal ? globalTarget(machine) : (() => { const p = findProject(positional[0], machineRoots(machine)); return projectTarget(p.abs, p.rel, machine, p.nested); })();
      const secrets = loadSecrets();
      const { manifest, moves } = loadManifestMoved(machine);
      const mcps = agentsFor(machine, flags.agent).flatMap((a) => foreignMcp(a, renderFor(a, t, machine, secrets, manifest.targets[targetId(a, t.target)]).cfg, t.target, machine, manifest.targets[targetId(a, t.target)])).filter((f) => f.name === name);
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
        // ${WORKSPACE} — только пути основного корня (при любом --to); пути в другие корни — как есть
        const { server, secrets: found, open, elsewhere } = fromNative(name, src.def, src.agent, machine, level, secrets);
        const comment = `Поднято из ${src.agent} (${src.source}) командой miksy adopt`;
        // План до записи: что попадёт в слой (только ссылки), какие секреты уйдут в local/secrets.env, что осталось
        const file = adoptMcp(server, found, level, comment, undefined, true);
        console.log(`План: MCP ${name} → ${file}\n${mcpYaml(server, comment).replace(/^/gm, "    ")}`);
        if (Object.keys(found).length)
          console.log(`  в local/secrets.env (в слое — ссылки):\n${Object.entries(found).map(([k, v]) => `    ${k}  (${v.length} симв.)`).join("\n")}`);
        if (open.length)
          console.log(`  ВНИМАНИЕ: похоже на секрет, но не распознано — останется в слое открытым текстом: ${open.join(", ")}\n` +
            "  проверьте файл после записи и замените значение ссылкой ${ИМЯ}");
        if (elsewhere.length) console.log(elsewhereText(elsewhere).join("\n"));
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
        ? [(() => { const p = findProject(positional[0], machineRoots(machine)); return projectTarget(p.abs, p.rel, machine, p.nested, groups); })()]
        : allTargets(machine, groups);
      const { manifest, moves } = loadManifestMoved(machine, groups);
      saveMoves(manifest, moves);
      const secrets = loadSecrets();
      const list: { p: PendingTrust; adapter: Adapter; t: TargetSpec }[] = [];
      for (const adapter of agentsFor(machine, flags.agent).filter((a) => a.id === "claude" || a.id === "codex"))
        for (const t of targets) {
          if (t.target.scope !== "project") continue;
          const id = targetId(adapter, t.target);
          const prev = trustState(manifest, id) ?? emptyState();
          const r = renderFor(adapter, t, machine, secrets, prev);
          plan(r.result, t.target, machine, prev, false, adapter.id, otherOwners(manifest, id), manifest.forgotten?.[id]);
          let p = r.result.trustPending;
          // Названный проект — решение можно пересмотреть, даже если оно уже есть
          if (!p && positional[0]) {
            const dialog = adapter.id === "claude" && dialogOwn(prev, t.target.dir, r.result.trust?.claude?.item === true, manifest.forgotten?.[id]);
            // Свои файлы — те же, что у sync в этом состоянии (с узнанными планом после «забыть»)
            const exec = executableSettings(t.target.dir, !!t.target.git, adapter.id as TrustAgent, { ...(r.result.trustOwn ?? ownFiles(prev, t.target.dir)), dialog });
            const mcp = adapter.id === "claude" ? mcpJsonServers(t.target.dir, !!t.target.git) : null;
            if (exec) p = { dir: t.target.dir, rel: t.target.rel, agent: adapter.id as TrustAgent, ...exec, ...(mcp && { mcp: { fingerprint: mcp.fingerprint } }) };
          }
          if (p && (!p.declined || positional[0])) list.push({ p, adapter, t });
        }
      if (!list.length) {
        console.log(positional[0] ? "Исполняемых настроек агента не от miksy нет — решение не нужно: доверие ставит sync по умолчанию." : "Решения о доверии не ждёт ни один проект.");
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
      const { abs, rel } = targetDir(positional[0] ?? ".", machineRoots(machine), machine.home, remove);
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
          for (const w of warns.filter((x) => x.toLowerCase().startsWith(`цель ${rel.toLowerCase()} (target: true)`))) console.log(`предупреждение: ${w}`);
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

    case "root": {
      // Корни workspace (local/machine.yaml → workspace): список, добавить, убрать. Пишется только ключ
      // workspace; учёт и записанное в проекты — только с согласия (root remove)
      const machine = loadMachine();
      const roots = machineRoots(machine);
      const warn = (w: string) => console.log("предупреждение: " + w);
      const file = join(configRoot(), "local", "machine.yaml");
      const text = readFileSync(file, "utf8");
      const items = rootItems((parseYaml(text) as { workspace?: unknown } | null)?.workspace);
      if (!positional.length) {
        console.log(`Корни workspace (${roots.length}):`);
        for (const [i, r] of roots.entries()) {
          const o = outerRoot(r, roots);
          console.log(`  ${rootText(r)}${i === 0 ? "  (основной)" : ""}${o ? `  (внутри корня ${o.path})` : ""}${rootExists(r) ? "" : `  — недоступен (${r.away ?? "каталога нет"})`}`);
        }
        console.log("\nДобавить — miksy root add <путь> --tree <ветка>, убрать — miksy root remove <путь>");
        break;
      }
      const given = trimSlash(slash(resolve(process.cwd(), driveRoot(positional[1] ?? "."))));
      if (positional[0] === "add") {
        if (!existsSync(given) || !statSync(given).isDirectory()) throw new Error(`${given}: каталога нет — корнем workspace может быть только существующий каталог`);
        const real = canonical(given);
        const twin = roots.find((r) => rootKey(r.path) === rootKey(real));
        if (twin) throw new UsageError(`${given} — уже корень workspace${fold(twin.path) !== fold(given) ? ` (${twin.given ?? twin.path} — тот же каталог: повтор, junction или симлинк)` : ""}`);
        // Каталог, который сам проект: корнем он станет папкой с проектами, а не проектом. Справка с рекомендацией;
        // в терминале — вопрос («нет» по умолчанию), без терминала — не добавляется без --yes (рецензия 6x, B3)
        const project = projectRoot(real, machine, roots);
        const withYes = `miksy root add "${given}"${flags.tree !== undefined ? ` --tree ${shellArg(flags.tree)}` : " --tree <ветка>"} --yes`;
        if (project) {
          if ("yes" in flags) warn(project);
          // План — как настоящий запуск в этом же режиме (выпуск 0.2.1, A8): без терминала — отказ без --yes, в
          // терминале — вопрос с «нет» по умолчанию
          else if ("dry-run" in flags && !ask) {
            console.log(`${project}\nПлан: без терминала корень не будет добавлен — нужно согласие флагом: ${withYes}`);
            console.log("\n--dry-run: ничего не записано.");
            break;
          } else if ("dry-run" in flags) console.log(`${project}\nПлан: будет вопрос «Всё равно сделать ${given} корнем workspace?» — по умолчанию «нет» (корень не добавляется); ответ «да» — так:`);
          else if (!ask) throw new UsageError(`${project} Если такой корень всё-таки нужен — ${withYes}`);
          else {
            console.log(project);
            if (!ask.yes(`Всё равно сделать ${given} корнем workspace?`, false)) {
              console.log("Корень не добавлен.");
              break;
            }
          }
        }
        const taken = roots.map((r) => r.tree).filter(Boolean);
        const suggestion = suggestTree(given, taken);
        let answer = flags.tree;
        if (answer === undefined) {
          if (!ask) throw new UsageError(`укажите ветку дерева слоёв для нового корня: miksy root add "${given}" --tree <ветка> (например, --tree ${shellArg(suggestion)}) — его слои будут в layers/tree/<ветка>/`);
          answer = ask.line(`Ветка дерева слоёв для ${given} — его слои будут в layers/tree/<ветка>/ (Enter — ${suggestion}):`)?.trim() || suggestion;
        }
        const tree = checkTree(answer);
        if (!tree) throw new UsageError(`«${answer}» — не ветка дерева слоёв: имена каталогов через «/» (например, Clients), без «..», дисков и имён ${[...LAYER_PARTS].join(", ")}`);
        const busy = roots.find((r) => r.tree.toLowerCase() === tree.toLowerCase());
        if (busy) throw new UsageError(`tree: ${tree} уже у корня ${busy.given ?? busy.path} — выберите другое имя ветки (например, ${suggestion})`);
        const next: RootItem[] = [...items, { path: given, tree }];
        // Проверки — как при загрузке (дубль, ветка), затем текст файла
        const newRoots = parseRoots(next, slash(file), ledgerRoots());
        const after = rewriteRoots(text, next, [...items.keys(), -1]);
        const added = newRoots[newRoots.length - 1];
        const grown = { ...machine, roots: newRoots };
        console.log(`Новый корень: ${rootText(added)} — local/machine.yaml: workspace ${typeof (parseYaml(text) as { workspace?: unknown }).workspace === "string" ? "станет списком корней" : "— ещё один элемент списка"}`);
        // Предупреждения и справка: домашний каталог, корень в чужом проекте или группе, совпадение веток
        const why = unsafeWorkspace(given, machine.home);
        if (why) warn(`${given} — ${why}: sync --all обойдёт все каталоги внутри (и спросит подтверждение)`);
        const before = new Set([...rootNotes(machine, listGroups(machine)), ...clashNotes(machine)]);
        for (const n of [...rootNotes(grown, listGroups(grown)), ...clashNotes(grown)]) if (!before.has(n)) warn(n);
        for (const r of newRoots) {
          const o = outerRoot(r, newRoots);
          if (o && (r === added || o === added)) console.log(`справка: ${nestedText(r, o)}`);
        }
        for (const n of branchNotes(grown)) if (n.includes(added.path)) console.log(`справка: ${n}`);
        if ("dry-run" in flags) {
          console.log(ask ? "После записи — вопрос «Записать настройки проектам workspace сейчас (miksy sync --all)?», по умолчанию «да»."
            : "После записи: miksy projects — проверить, что видно; miksy sync --all — записать настройки.");
          console.log("\n--dry-run: ничего не записано.");
          break;
        }
        backup(file);
        writeAtomic(file, after);
        console.log("✓ записано");
        const found = allProjects(grown).filter((p) => sameKey(p.root.path, added.path));
        console.log(`Проектов в нём: ${found.length}${found.length ? ` — ${found.slice(0, 10).map((p) => p.rel).join(", ")}${found.length > 10 ? ", …" : ""}` : ""} (весь список — miksy projects)`);
        if (!ask) {
          console.log("Дальше: miksy projects — проверить, что видно; miksy sync --all — записать настройки");
          break;
        }
        if (!ask.yes("Записать настройки проектам workspace сейчас (miksy sync --all)?", true)) {
          console.log("Позже: miksy sync --all");
          break;
        }
        console.log("");
        resetRun();
        code = command("sync", { all: "" }, []);
        break;
      }
      // remove: только дополнительный корень. Записанное в его проекты — с согласия (в терминале —
      // вопрос, без него — подсказка команд); учёт и файлы без согласия не трогаются
      const idx = roots.findIndex((r) => rootKey(r.path) === rootKey(given) || (r.given !== undefined && rootMemoryKey(r.given) === rootMemoryKey(given)));
      if (idx < 0) throw new UsageError(`${given} — не корень workspace. Корни: ${roots.map((r) => r.path).join(", ")} (список — miksy root)`);
      if (idx === 0) throw new UsageError(`${roots[0].path} — основной корень, его нельзя убрать: на нём \${WORKSPACE} и ветка дерева без префикса. Сменить основной — miksy setup --force`);
      const gone = roots[idx];
      const outer = outerRoot(gone, roots);
      let cleaned = false;
      const { manifest } = loadManifestMoved(machine);
      // Записанное в сам каталог корня (проект, ставший корнем, — root add … --yes) — не в его проектах: после
      // удаления корня каталог снова проект (внешнего корня), его не убираем и не забываем
      const dirs = [...new Set(Object.keys(manifest.targets).map((id) => id.slice(id.indexOf("|") + 1)))]
        .filter((d) => d !== "global" && locate(d, roots)?.root === gone && rootKey(d) !== rootKey(gone.path)).sort();
      const after = rewriteRoots(text, items.filter((_, i) => i !== idx), [...items.keys()].filter((i) => i !== idx));
      console.log(`Убрать корень ${rootText(gone)} из local/machine.yaml (workspace)`);
      if (dirs.length) console.log(`miksy записывал в его проекты (${dirs.length}): ${dirs.map((d) => treeOf(d, roots)).join(", ")}`);
      // Корень недоступен (диск не подключён): тот же вопрос, что у clean, — забыть записанное туда (по
      // умолчанию «нет») или --forget; без согласия корень убирается, а учёт его проектов остаётся
      const away = !rootExists(gone);
      const all = Object.values(ADAPTERS);
      const far = (a: Adapter, d: string) => strandedPaths(splitState(manifest.targets[`${a.id}|${d}`] ?? emptyState(), d).far);
      const count = (agents: Adapter[]) => (dirs.length && away ? new Set(dirs.flatMap((d) => agents.flatMap((a) => [...far(a, d)]))).size : 0);
      // «Забыть» — все агенты (n); без него обещание «уберёт clean» — только агентам из agents (nOwn), остальным — clean
      // --agent: clean без --agent их не трогает (выпуск 0.2.2, A4)
      const enabled = new Set(agentsFor(machine).map((a) => a.id));
      // Общий файл (.git/info/exclude) правят оба — он в числе clean; «только агентами вне agents» — остаток: числа сходятся
      // (n = nOwn + nOther; круг 8b, C8)
      const n = count(all), nOwn = count(all.filter((a) => enabled.has(a.id))), nOther = n - nOwn;
      const otherCmds = dirs.length && away ? dirs.flatMap((d) => all.filter((a) => !enabled.has(a.id) && far(a, d).size > 0).map((a) => `  miksy clean "${d}" --agent ${a.id}`)) : [];
      const whenBack = `Когда диск вернётся — ${nOwn ? `miksy clean "<путь проекта>" уберёт ${files(nOwn)} (работает и без корня в workspace)` : "агентам из agents там убирать нечего"}${otherCmds.length ? ", записанное агентами, которых нет в agents, — команды ниже" : ""}`;
      const otherText = otherCmds.length ? `\nЗаписанное агентами, которых нет в agents, clean без --agent не убирает — когда диск вернётся:\n${otherCmds.join("\n")}` : "";
      // Вложенный корень: его папки остаются внутри внешнего — там они обычные папки внешнего корня
      const outerText = (done: boolean) => `${gone.path} лежит внутри корня ${outer!.path}: после удаления его папки — обычные папки ${outer!.path}. Следующий sync --all пересчитает их проекты по месту в ${outer!.path} (layers/tree${outer!.tree ? `/${outer!.tree}` : ""}/…), а записанное в его цели target: true уберёт, как у бывших групп${dirs.length && !done ? `; убрать записанное сейчас — miksy clean "<путь>" до root remove` : ""}`;
      if ("dry-run" in flags) {
        // План для недоступного корня — что будет: вопрос или --forget, сколько файлов забудется или что останется
        // в учёте (как у clean … --forget --dry-run — по проектам)
        if (dirs.length && away) {
          console.log(`Корень недоступен (${gone.away ?? "каталога нет"}) — на нём записанное miksy: ${files(n)}${nOther ? `, из них только агентами, которых нет в agents, — ${files(nOther)}` : ""}.`);
          if ("forget" in flags) {
            regainRoot = gone;
            try {
              for (const d of dirs) {
                console.log("");
                resetRun();
                command("clean", { forget: "", "dry-run": "" }, [d]);
              }
            } finally { regainRoot = null; }
            console.log(`\nПлан: корень убирается из workspace, записанное в его проекты (${files(n)}) забывается.`);
          } else if (outer) console.log(`Корень лежит внутри корня ${outer.path}: без «забыть» он не убирается (его папки стали бы обычными папками ${outer.path}, и miksy не отличил бы неподключённый диск от удалённых данных). ${ask ? "Будет вопрос: забыть записанное в его проекты? «Нет» (по умолчанию) — корень не убран" : "Без терминала вопроса нет — корень не будет убран"}; забыть — --forget.`);
          else console.log(`${ask ? "Будет вопрос: забыть записанное в его проекты? «Нет» (по умолчанию)" : "Без терминала вопроса нет"} — корень убирается, а записанное в его проекты и учёт остаются. ${whenBack}; данных больше нет — miksy clean "<путь проекта>" --forget (или сразу root remove с --forget):\n${dirs.map((d) => `  ${d}`).join("\n")}${otherText}`);
        } else if (dirs.length) {
          // Доступный корень — как настоящий запуск (выпуск 0.2.1, A8): в терминале вопрос («да» по умолчанию), без
          // терминала записанное остаётся
          if (ask) console.log(`Будет вопрос «Убрать записанное miksy в эти проекты сейчас?» — по умолчанию «да»: miksy clean в каждом (${dirs.length}). Ответ «нет» — записанное в проекты и учёт останутся (убрать позже — miksy clean "<путь проекта>").`);
          // Вложенный корень без терминала — как настоящий запуск: только текст о вложенном корне (рецензия 0.2.1 A, п. 3)
          else if (!outer) console.log(`Без терминала вопроса нет — записанное в проекты и учёт останутся. Убрать позже (работает и без корня в workspace):\n${dirs.map((d) => `  miksy clean "${d}"`).join("\n")}`);
        }
        if (outer && !(dirs.length && away && !("forget" in flags))) console.log(outerText(!!ask || "forget" in flags));
        console.log("\n--dry-run: ничего не записано.");
        break;
      }
      if (dirs.length && away) {
        if ("forget" in flags || (ask && ask.yes(`Корень ${gone.path} недоступен (${gone.away ?? "каталога нет"}): диск не подключён или данных больше нет? Забыть записанное в его проекты (${files(n)})?`, false))) {
          regainRoot = gone;
          try {
            for (const d of dirs) {
              console.log("");
              resetRun();
              code = Math.max(code, command("clean", { forget: "" }, [d]));
            }
          } finally { regainRoot = null; }
          cleaned = true;
          console.log("");
          // Путь — как записан в machine.yaml (ссылка, junction — не путь назначения), «~» раскрыт: root add
          // принимает путь от каталога запуска
          const back = gone.given ? expandPath(gone.given, machine.home, process.cwd()) : gone.path;
          console.log(`Если диск найдётся: сначала верните папку корнем — miksy root add "${back}" --tree ${shellArg(gone.tree)}; затем miksy sync --all — файлы miksy в его проектах, совпадающие с нынешними, вернутся под учёт сами, изменённые — с miksy sync "<путь проекта>" --force (бэкап будет). Если они не нужны — после этого miksy root remove "${back}" с согласием убрать записанное (без терминала — miksy clean "<путь проекта>" в каждом проекте).`);
        } else if (outer) {
          // Вложенный корень: после удаления его каталоги — обычные каталоги внешнего, доступного корня, и miksy
          // уже не отличит неподключённый диск от удалённых данных — учёт забылся бы без вопроса. Не убираем
          console.log(`Корень ${gone.path} недоступен и лежит внутри корня ${outer.path}: после удаления его папки стали бы обычными папками ${outer.path}, и miksy не отличил бы неподключённый диск от удалённых данных — записанное туда (${files(n)}) забылось бы без вопроса. Корень не убран. Подключите диск и повторите miksy root remove "${gone.path}" или, если данных больше нет, — miksy root remove "${gone.path}" --forget`);
          code = 1;
          break;
        } else console.log(`Корень недоступен — записанное в его проекты и учёт не тронуты. ${whenBack}; данных больше нет — miksy clean "<путь проекта>" --forget:\n${dirs.map((d) => `  ${d}`).join("\n")}${otherText}`);
      } else if (dirs.length) {
        if (ask && ask.yes(`Убрать записанное miksy в эти проекты сейчас (miksy clean — ${dirs.length})?`, true)) {
          for (const d of dirs) {
            console.log("");
            resetRun();
            code = Math.max(code, command("clean", {}, [d]));
          }
          cleaned = true;
          console.log("");
        } else if (!outer) console.log(`Записанное в проекты и учёт не тронуты. Убрать позже (работает и без корня в workspace):\n${dirs.map((d) => `  miksy clean "${d}"`).join("\n")}`);
      }
      if (outer) console.log(outerText(cleaned));
      backup(file);
      writeAtomic(file, after);
      console.log(`✓ корень ${gone.path} убран из workspace`);
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
