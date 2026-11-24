// miksy doctor — что разошлось между слоями и тем, что лежит на диске. Только чтение.
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Adapter } from "./adapter";
import { type Action, plan, verifyMerges } from "./apply";
import { allLayerMcp, caseTwins, configRoot, ENGINE, ignoredLayerParts, ignoredText, layerSecrets, SKILL_SECRETS_ADVICE, legacyAgentNames, declaredSkillSecrets, loadLayer, loadMap, loadSecrets, orphanTreeDirs, unknownKeys, WIDE_SKILL_SECRETS, wideSkillSecrets, SHALLOW_LEVELS, type WalkCut } from "./load";
import { machineRoots, rootText } from "./roots";
import { engineVersion, newerLedger, oldBun } from "./version";
import { splitInstructions } from "./instructions";
import { blocksOf as blocksWithMachine, machineId, machineUnknown } from "./machineid";
import { emptyState, ManifestError, type Manifest, type TargetState, otherOwners, splitState, strandedPaths } from "./manifest";
import type { Move } from "./relocate";
import { fold, pathKey, quoteArg, slash } from "./paths";
import { foreignMcp, foreignSkills } from "./foreign";
import { connectHint, detectAgents } from "./agentid";
import { agentsFor, allProjects, allTargets, branchNotes, clashNotes, formerGroups, globalTarget, groupRulesDelivered, ledgerSkills, listGroups, literalHints, loadManifestMoved, movesText, nestedNotes, outsideRoots, READERS, stranded, renderFor, rootedTargets, rootedText, isMainRoot, rootNotes, type TargetSpec, targetId, targetKey, unavailable, unprotectedSecrets, unsyncedGroups, workspaceRepoNote } from "./registry";
import type { Machine } from "./types";
import { checkLocalAccess, checkSecretFiles, localAccessText, secretsDir } from "./secretfiles";
import { plainDirs } from "./target";
import { environment } from "./environ";
import { stableBun } from "./launch";
import { SKILL_SECRET_COPY_ADVICE } from "./skillfiles";
import { BUILTIN_SKILL, type BuiltinCopy, builtinCopies, builtinCopyText, builtinLayer } from "./builtin";
import { selectGlobal } from "./resolve";
import { ADAPTERS, agentTitle, deliveredSkillNames, deliveryOrder } from "./registry";
import { count, files } from "./plural";
import { agentNote, decisionTitle, dialogAgentId, dialogTitle, approvalsSource, inheritedExec, type PendingTrust, pendingText, trustMark, trustPlan, trustState } from "./trust";
import { shimNotes } from "./shim";

type Finding = { agent: string; target: string; detail: string };
// Добавка агента в обход слоёв: что поднимать (miksy adopt) — глобальное или проект (dir, rel)
export type Addition = Finding & { kind: "mcp" | "skill"; name: string; source: string; dir?: string; rel?: string };
// Конфликт первого sync: где (dir — проект; нет — глобально) и файл
export type Blocked = Finding & { dir?: string; file: string; why: string };

// Ручная правка — то, что sync без --force не перезапишет
const MANUAL = /изменён вручную|управляемый блок изменён|таблица изменена|хеш неизвестен/;

// Глобальные каталоги skills агентов — чтобы найти чужие регистрации (например, от установщиков наборов skills).
// Skill — каталог со SKILL.md; служебные каталоги агента без него (контейнеры синхронизации) не считаются
const globalSkillDirs = () => Object.values(ADAPTERS).flatMap((a) => (a.homeSkillsDir ? [a.homeSkillsDir] : []));

// bunVersion — версия Bun для предупреждения о старом Bun (тест подменяет)
export function doctor(adapters: Adapter[], machine: Machine, verbose: boolean, bunVersion: string = Bun.version, which: (cmd: string) => string | null = (c) => Bun.which(c)): { text: string; problems: number; added: Addition[]; blocked: Blocked[] } {
  const secrets = loadSecrets();
  const skippedDirs: string[] = [];
  const cuts: WalkCut[] = [];
  const projects = allProjects(machine, undefined, (w) => skippedDirs.push(w), (c) => cuts.push(c));
  const badGroups: string[] = [], absentGroups: string[] = [], rootGroups: string[] = [];
  // Каталога группы нет на этой машине (проекты не склонированы) — справочно, как слои без проектов
  const groups = listGroups(machine, (w) => {
    const m = /^цель (.+) \(target: true\): каталога нет в workspace/.exec(w);
    const r = /^цель (.+) \(target: true\): каталог (.+) стал корнем workspace/.exec(w);
    if (m) absentGroups.push(m[1]);
    else if (r) rootGroups.push(`${r[1]} (${r[2]})`);
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
  const forgottenNow: Finding[] = []; // проект забыт («забыть»), каталог на месте: sync ещё не запускали
  const stale: Finding[] = [];
  const vanished: Finding[] = [];
  const team: Finding[] = [];
  const manual: Finding[] = [];
  const persistent: Finding[] = [];
  const blocked: Blocked[] = [];
  const missing = new Map<string, Set<string>>(); // переменная → агенты
  const added: Addition[] = []; // добавки агентов в обход слоёв
  const permissions: Finding[] = [];
  const exposed: Finding[] = []; // секреты в файлах каталогов без git
  const skillLinks: Finding[] = [];
  // Секреты для skills (skill_secrets), которых нет в local/secrets.env: miksy secret их не выдаст (круг 11k; справка — 11l)
  const secretsNow = loadSecrets();
  const skillSecretsMissing: Finding[] = declaredSkillSecrets().filter((d) => !(d.name in secretsNow)).map((d) => ({ agent: "—", target: d.file, detail: `skill_secrets: ${d.name} — нет в local/secrets.env` }));
  // Копии файлов-секретов skills по целям (круг 11i-2): «<skill>/<файл>» → места (агент, цель, путь)
  const secretCopies = new Map<string, Set<string>>();
  const undeliverable: Finding[] = []; // секрет есть, но доставить его нельзя (многострочный, символы)
  const texts = new Map<string, string | null>();
  const valueFiles = new Map<string, Set<string>>(); // конфиг агента → секреты, чьи значения в нём лежат
  let portableUsed = false; // MCP-серверы какой-то цели запускает команда miksy (miksy mcp)
  const advice: Finding[] = []; // нужно действие пользователя в агенте (доверие проекта Claude)
  const trust: Finding[] = [];
  const pendingTrust: PendingTrust[] = []; // нужно решение пользователя (исполняемые настройки агента)
  const declined: PendingTrust[] = []; // пользователь отказал в доверии (miksy trust)
  const literals: Finding[] = []; // значение секрета в настройке, записанной не miksy (конфликт)
  const emptySecrets: Finding[] = []; // секрет, который использует сервер, пустой
  const delivered = new Map<string, string[]>();
  // Серверы, которые на этой машине не запустятся (круг 11c, справочно): имя → причина → агенты
  const idle = new Map<string, Map<string, Set<string>>>();
  const offSet = new Set(machine.mcpOff);
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
        rendered = renderFor(adapter, t, machine, secrets, prev, [...(delivered.get(targetKey(t)) ?? []), ...others], rulesDelivered(adapter));
        // Для доверия — с отметкой «доверие ставил miksy» после clean (как у sync)
        const before = trustState(manifest, id) ?? emptyState();
        actions = plan(rendered.result, t.target, machine, before, false, adapter.id, otherOwners(manifest, id), trustMark(manifest, id));
        delivered.set(targetKey(t), [...(delivered.get(targetKey(t)) ?? []), ...deliveredSkillNames(rendered.result, actions, t.target)]);
        for (const detail of trustPlan(rendered.result, t.target, machine, before, actions, adapter.id, undefined, undefined, trustMark(manifest, id)).missing) trust.push({ ...where, detail });
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
      for (const { item } of cfg.mcp) {
        const why = item.unavailable?.off ? "выключен (miksy mcp off) — пустой сервер"
          : item.unavailable ? (item.unavailable.quiet ? `${item.unavailable.why} — пустой сервер` : `${item.unavailable.why} — агент покажет эту причину; не нужен на этой машине — miksy mcp off ${item.name}`)
          : offSet.has(item.name) && item.agents?.[adapter.id] !== "skip" ? `выключен (miksy mcp off), но без секретов и переменных записан в файл проекта как есть и запустится; убрать — exclude: [mcp.${item.name}] в слое проекта`
          : null;
        if (!why) continue;
        const byWhy = idle.get(item.name) ?? new Map<string, Set<string>>();
        idle.set(item.name, byWhy.set(why, (byWhy.get(why) ?? new Set()).add(adapter.id)));
      }
      for (const k of rendered.skipped) if (k.why) undeliverable.push({ ...where, detail: `mcp ${k.name}: ${k.why}` });
      // Файлы skills слоёв, которые фильтр доставки не пропустил (круг 11i): ссылки наружу и битые. Файлы-секреты — в
      // разделе «Секреты в skills слоёв»; одна строка на skill и файл, а не на каждого агента и цель
      for (const f of result.files) if (f.mode === "own" && f.skillSecret) secretCopies.set(f.skillSecret, (secretCopies.get(f.skillSecret) ?? new Set()).add(`${adapter.id}|${t.title}|${f.path}`));
      for (const w of result.warnings) if (/^skill .*ссылка .*не доставлен/.test(w) && !skillLinks.some((x) => x.detail === w)) skillLinks.push({ agent: "—", target: "", detail: w });
      for (const a of result.advice ?? []) advice.push({ ...where, detail: a });
      if (result.portable) portableUsed = true;
      for (const w of result.persistent ?? []) persistent.push({ ...where, detail: w });
      for (const w of result.warnings.filter((w) => /пустой в local\/secrets\.env/.test(w))) emptySecrets.push({ ...where, detail: w });
      // Значения секретов в конфигах агента (записанных до 2а или оставленных keep)
      const configs = new Set([
        ...Object.keys(prev?.merges ?? {}), ...Object.keys(prev?.toml ?? {}),
        ...result.files.filter((f) => f.mode === "merge" || f.mcp).map((f) => pathKey(`${f.base === "project" && t.target.scope === "project" ? t.target.dir : machine.home}/${f.path}`)),
      ]);
      for (const c of configs) for (const n of valuesIn(c, secrets, texts)) valueFiles.set(c, (valueFiles.get(c) ?? new Set()).add(n));
      // Права: только то, что sync исправит (chmod); отвергнутые файлы (командный opencode.json) — нет
      // Снять строки блока exclude другой машины, за которыми нет файлов, — не дело этой машины (круг 10z)
      const changes = actions.filter((a) => a.kind !== "conflict" && a.kind !== "chmod" && !(a.kind === "exclude" && (a.foreignOnly || a.quiet)));
      for (const a of actions) if (a.kind === "chmod") permissions.push({ ...where, detail: `${a.abs}: права ${a.mode.toString(8).padStart(4, "0")} — открыт группе или не хватает +x` });
      const open = unprotectedSecrets(result, t.target, secrets);
      if (open) exposed.push({ ...where, detail: open });
      for (const f of foreignMcp(adapter, cfg, t.target, machine, prev))
        added.push({ ...where, detail: `mcp ${f.name}  (${f.source})`, kind: "mcp", name: f.name, source: f.source, ...(t.target.scope === "project" && { dir: t.target.dir, rel: t.target.rel }) });

      if (!prev) {
        for (const a of actions) if (a.kind === "conflict") blocked.push({ ...where, detail: `${a.abs}: ${a.why}`, file: a.abs, why: a.why, ...(t.target.scope === "project" && { dir: t.target.dir }) });
        // Забытый проект: sync был, но учёт забыт — своя строка (выпуск 0.2.1, A16)
        if (changes.length) (manifest.forgotten?.[id] ? forgottenNow : unsynced).push({ ...where, detail: "" });
        continue;
      }
      const teamNames = cfg.skills.filter((s) => s.item.team).map((s) => s.item.name);
      const isTeam = (a: Action) => "abs" in a && teamNames.some((n) => a.abs.includes(`/skills/${n}/`));
      const teamChanges = changes.filter(isTeam);
      const other = changes.filter((a) => !isTeam(a));
      if (teamChanges.length) team.push({ ...where, detail: summarizeSkills(teamChanges, teamNames) });
      // Только вернуть пропавшее из учёта (файлы и блоки удалены не через miksy — например, другой машиной в общей
      // папке) — своя причина, а не «слои изменились» (круг 10z)
      const back = other.filter((a) => missingNow(a, prev));
      if (back.length && other.every((a) => back.includes(a) || a.kind === "exclude")) vanished.push({ ...where, detail: summarize(other) });
      else if (other.length) stale.push({ ...where, detail: summarize(other) });
      for (const a of actions)
        if (a.kind === "conflict") (MANUAL.test(a.why) ? manual : persistent).push({ ...where, detail: `${a.abs}: ${a.why}` });
    }
  }

  for (const adapter of adapters)
    for (const f of formerGroups(manifest, adapter, groups, machine))
      if (!targets.some((t) => t.target.scope === "project" && fold(pathKey(t.target.dir)) === fold(f.dir)))
        former.push({ agent: adapter.id, target: f.rel, detail: "записанное осталось (у группы — действует на цели ниже)" });

  // Группы без git: агент с ответами в своём окне (адаптер: trust.dialog — Claude) наследует их доверие на подкаталоги
  // без своего git — исполняемые настройки там (распакованный архив и т. п.) применились бы без вопроса
  const inherited: Finding[] = [];
  for (const heir of adapters.filter((a) => a.trust?.dialog))
    for (const g of groups.filter((x) => !x.git)) {
      // Доверие группы запрещено (слой или machine.yaml) — наследовать нечего. Ответы в окне Claude в подкаталоге
      // (permissions.allow и т. п.) — не предмет этого раздела: их пишет Claude по ответу того, кто там работает;
      // здесь — хуки, env и прочее, что выполнится без вопроса
      const layer = targets.find((t) => t.target.scope === "project" && fold(pathKey(t.target.dir)) === fold(pathKey(g.abs)))?.cfg.trust?.[heir.id]?.item;
      if (layer === false || machine.trust?.[heir.id] === false) continue;
      for (const s of inheritedExec(g.abs, groups.filter((x) => x !== g).map((x) => x.abs), true))
        inherited.push({ agent: heir.id, target: s.dir, detail: `доверие группы ${g.rel} действует и здесь: ${s.lines.join("; ")}` });
    }

  const localAccess = checkLocalAccess();
  if (localAccess.refuse) permissions.push({ agent: "—", target: "local/backups", detail: `пока так, все команды, которые пишут (sync, clean, setup, update, root, adopt, trust, target), откажут: ${localAccess.refuse}` });
  if (localAccess.bad.length) permissions.push({ agent: "—", target: "local/", detail: `${localAccessText(localAccess)} — sync/setup закроет local/ (секреты и учёт этой машины) только для вас${localAccess.refuse ? ", когда перестанут отказывать (строка выше)" : ""}` });
  // Ссылка local/secrets — одной строкой, в «Файлах секретов» (там и что делает sync); здесь — без повтора (выпуск 0.2.3, A7)
  // Путь — как записан и через настоящий путь local/ (local/ сама — ссылка; рецензия 9a, №8)
  const secretsLinks = [slash(secretsDir())];
  try { secretsLinks.push(slash(join(realpathSync(dirname(secretsDir())), "secrets"))); } catch { /* local/ нет */ }
  const aboutSecrets = (l: string) => secretsLinks.some((p) => fold(l).startsWith(fold(`${p} →`)) || fold(l).startsWith(fold(`${p}:`)));
  for (const l of localAccess.links) if (!aboutSecrets(l)) permissions.push({ agent: "—", target: "local/", detail: l });

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

  // Учёт ссылается на проекты, которых больше нет. Каталоги недоступного корня (диск не подключён) — не
  // пропавшие: они в «Справочно»
  // Каталога нет и вне всех корней (корень убран; диск не подключён или папку удалили — не отличить) — тоже не
  // «пропавшие»: clean их не забывает без согласия (вопрос или --forget), в «Справочно» — что осталось убрать
  const awayTargets = new Set<string>();
  const leftTargets = new Set<string>();
  const orphans = Object.keys(manifest.targets)
    .map((id) => id.split("|"))
    .filter(([agent, dir]) => adapters.some((a) => a.id === agent) && dir !== "global" && !existsSync(dir))
    .filter(([, dir]) => !(unavailable(dir, machine) && awayTargets.add(dir)) && !(outsideRoots(dir, machine) && leftTargets.add(dir)))
    .map(([agent, dir]) => ({ agent, target: dir, detail: "" }));
  // Сколько записанного miksy лежит в каталогах: own — агентами из agents (его уберёт clean без --agent; общий
  // .git/info/exclude — тоже), иначе — только агентами, которых нет в agents (clean — с --agent: команды в строке «Учёт
  // агентов, которых нет в agents»). Правило A4 root remove (выпуск 0.2.2) — и здесь (круг 8b, C9)
  const enabled = new Set(agentsFor(machine).map((a) => a.id));
  const paths = (dirs: Set<string>, own: boolean) => new Set([...dirs].flatMap((d) => Object.entries(manifest.targets)
    .filter(([id]) => enabled.has(id.slice(0, id.indexOf("|"))) === own && fold(id.slice(id.indexOf("|") + 1)) === fold(d))
    .flatMap(([, st]) => [...strandedPaths(splitState(st, d).far)])));
  const filesIn = (dirs: Set<string>) => paths(dirs, true).size;
  const othersIn = (dirs: Set<string>) => { const own = paths(dirs, true); return [...paths(dirs, false)].filter((p) => !own.has(p)).length; };
  const othersNote = (dirs: Set<string>) => (othersIn(dirs) ? `; записанное только агентами, которых нет в agents (${files(othersIn(dirs))}), clean без --agent не убирает — команды в строке «Учёт агентов, которых нет в agents»` : "");
  // Без агентов вне agents — текст как в 0.2.1
  const ownFiles = (dirs: Set<string>) => `${files(filesIn(dirs))}${othersIn(dirs) ? " агентами из agents" : ""}`;
  const bothWays = `диск вернётся — miksy clean "<путь>"; данных больше нет — miksy clean "<путь>" --forget`;
  // Доверие агента к папке, которое поставил miksy (запись доверия в учёте цели), держится, пока его не снимет clean:
  // агент без вопроса выполняет настройки папки, а miksy ею больше не управляет (круг 10l). clean снимает его и без диска.
  // Только агенты из agents: доверие агента вне agents снимает clean --agent (строка «Учёт агентов, которых нет в agents»)
  const trustNote = (dirs: Set<string>) => {
    const hits = new Map<string, Set<string>>();
    for (const [id, st] of Object.entries(manifest.targets)) {
      const dir = id.slice(id.indexOf("|") + 1), agent = id.slice(0, id.indexOf("|"));
      if (enabled.has(agent) && Object.keys(st.trust ?? {}).length && [...dirs].some((d) => fold(d) === fold(dir))) (hits.get(dir) ?? hits.set(dir, new Set()).get(dir)!).add(decisionTitle(agent));
    }
    if (!hits.size) return "";
    const who = [...new Set([...hits.values()].flatMap((s) => [...s]))].join(" и ");
    const one = hits.size === 1;
    return `В том числе доверие ${who} к ${one ? "папке" : "папкам"} ${[...hits.keys()].join(", ")}: агент без вопроса выполняет ${one ? "её" : "их"} настройки (хуки, серверы MCP проекта), а miksy ${one ? "ею" : "ими"} больше не управляет — снять: miksy clean "<путь>" (работает и без диска)`;
  };

  // Цели учёта, чей каталог теперь сам корень workspace: записанное туда действует и не обновляется
  const rootedAll: Finding[] = rootedTargets(manifest, machine).map((d) => ({ agent: "—", target: d, detail: rootedText(d, machine).slice(d.length + 3) }));
  const rootedMain = rootedAll.filter((x) => isMainRoot(x.target, machine));
  const rooted = rootedAll.filter((x) => !isMainRoot(x.target, machine));
  // Цели учёта, которые есть, но вне всех корней workspace (корень убран): sync их не обновляет
  const outside = [...new Set(Object.keys(manifest.targets).map((id) => id.slice(id.indexOf("|") + 1)))]
    .filter((dir) => dir !== "global" && existsSync(dir) && outsideRoots(dir, machine)).sort();

  // Ключи, которые агент перезаписал своей копией файла
  // Цели, чей каталог недоступен (диск не подключён и т. п.), не проверяются: о них — отдельная строка
  const lost = Object.entries(manifest.targets)
    .filter(([id]) => adapters.some((a) => id.startsWith(a.id + "|")))
    .filter(([id]) => { const dir = id.slice(id.indexOf("|") + 1); return dir === "global" || !stranded(dir, machine); })
    .flatMap(([id, st]) => verifyMerges(st).map((l) => ({ agent: id.split("|")[0], target: id.split("|")[1], detail: l })));

  // Глобальные skills, которые положил не miksy
  const owned = new Set(Object.values(manifest.targets).flatMap((s) => Object.keys(s.files)));
  const foreign: string[] = [];
  for (const d of globalSkillDirs()) {
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
  const layerNaked = layerSecrets();
  const naked = layerNaked.mcp.map((l) => ({ agent: "—", target: "", detail: l }));
  const nakedSkills = layerNaked.skills.map((l) => ({ agent: "—", target: "", detail: l }));
  const roots = machineRoots(machine);
  const treeUnused = orphanTreeDirs(roots);
  const typos = treeUnused.filter((d) => d.suggestion && !d.other).map((d) => ({ agent: "—", target: `layers/tree/${d.path}`, detail: `↔ в workspace есть ${d.suggestion}` }));
  // Ветка верхнего уровня, похожая на папку основного корня: опечатка или ветка корня другой машины — справочно
  const maybeOther = treeUnused.filter((d) => d.suggestion && d.other);
  const unused = treeUnused.filter((d) => !d.suggestion && !d.unmounted).map((d) => d.path);
  const unmounted = treeUnused.filter((d) => d.unmounted).map((d) => d.path);
  const twins = caseTwins().map((t) => ({ agent: "—", target: t.names.map((n) => `layers/tree/${n}`).join(", "), detail: `применяется только ${t.used}` }));

  const out: string[] = [`miksy doctor — версия ${engineVersion()}; агенты: ${adapters.map((a) => a.id).join(", ")}; ${roots.length > 1 ? `корней: ${roots.length}; ` : ""}проектов: ${projects.length}${groups.length ? `; помечено целями (target: true): ${groups.length}` : ""}`, ""];
  // Номер этой машины сменился, а блоки с прежним номером учёта остались в проектах (круг 10z-2): одна подсказка
  const was = manifest.machine && !machineUnknown() && manifest.machine !== machineId() ? manifest.machine : null;
  const renumbered = { was, files: was ? blocksWithMachine(manifest, was) : [] };
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
  section("Небезопасные права", "открытые пути local/ и права файлов miksy исправит sync/setup; о ссылках — в самих строках", permissions);
  section("Проекты без доверия", "причина для каждого агента; чужое доверие не меняется", trust);
  if (pendingTrust.length) out.push(`Нужно решение пользователя о доверии (${pendingTrust.length}) — у проектов исполняемые настройки агента, которые ставил не miksy (команда проекта, ответы в окне ${dialogTitle()}, чужие файлы); без решения miksy доверие не ставит:`,
    ...pendingText(pendingTrust), agentNote(), "");
  section("Исполняемые настройки в подкаталогах групп без git", `${dialogTitle()} наследует доверие группы на подкаталоги без своего git: эти настройки применятся без вопроса; удалите их, сделайте каталог git-репо или запретите доверие группы (trust: { ${dialogAgentId()}: false })`, inherited);
  section("Не синхронизировано", "sync для них ни разу не запускался: miksy sync --all --agent <id>", unsynced, true);
  section("Номер этой машины сменился", `в этих проектах блоки .git/info/exclude записаны этим учётом под номером ${renumbered.was}, а у машины теперь другой; пока такие блоки считаются блоками другой машины, clean не убирает файлы под их строками. Переустановили систему или пропал local/state/machine-salt — вернуть их своими: miksy sync --all --machine-was ${renumbered.was}. local/ перенесён с другого компьютера (это блоки той машины) — miksy sync --all --machine-other ${renumbered.was}: учёт перестанет считать номер своим, блоки не тронет`,
    renumbered.files.map((f) => ({ agent: "—", target: slash(f.replace(/\/\.git\/info\/exclude$/i, "")), detail: "" })));
  section("Проект забыт", "учёт записанного туда забыт (clean --forget или root remove --forget), а каталог на месте: miksy sync <путь> узнает файлы miksy, совпадающие с нынешними, и возьмёт их под учёт (изменённые — с --force); не нужны — затем miksy clean <путь>", forgottenNow, true);
  section("Пропали файлы miksy", "удалены не через miksy (например, другой машиной в общей папке): miksy sync --all --agent <id> вернёт", vanished);
  section("Устарело", "слои изменились после sync: miksy sync --all --agent <id>", stale);
  section("Импорт командных skills устарел", "в репо изменились skills или агент теперь видит их сам: miksy sync <проект> --agent <id>", team);
  section("Правлено вручную", "sync не перезапишет без --force; перенесите правку в слои или откатите", manual);
  section("Ключи пропали", "агент перезаписал файл своей копией; повторите sync", lost);
  section("Проект стал корнем workspace", "записанное в него miksy раньше действует, но больше не обновляется", rooted);
  section("Записанное в основной корень workspace", "miksy раньше записал настройки в сам корень: они действуют, но больше не обновляются", rootedMain);
  section("Группа выше не получила правила", "агент читает правила родительских каталогов, а файла правил группы нет — её правила пишутся в цели ниже: miksy sync <группа> или sync --all", groupBelow);
  section("Снята пометка target: true", "miksy sync --all уберёт записанное туда по учёту (у группы иначе её правила задвоятся в целях ниже)", former);
  section("Учёт ссылается на несуществующие каталоги", "каталог удалён или переехал, но не найден по записанным файлам (найденный sync переносит сам); убрать записанное вне него (ключи MCP, доверие, обёртки) и запись учёта: miksy clean <путь>", orphans);
  section(
    "Добавлено агентами в обход слоёв",
    "другие агенты этого не получат; поднять в слой: miksy adopt <проект|--global> <имя> --to <уровень> (не считается ошибкой)",
    added,
  );
  section("Каталоги слоёв отличаются только регистром", "на этой машине (ФС с учётом регистра) применяется один из них; перенесите файлы в один каталог и удалите остальные (на Windows и macOS git сложил бы их в один)", twins);
  section("Похоже на опечатку или переименование", "слой дерева не совпадает с каталогом workspace, но есть похожий — переименуйте слой", typos);
  // Ветка корня совпала с папкой другого корня: правила ветки молча достаются обеим папкам
  const clashes = clashNotes(machine).map((detail) => ({ agent: "—", target: "", detail }));
  section("Ветка корня совпадает с папкой другого корня", "слои у них общие", clashes);
  section("Пометка target: true не действует", "target: true в layer.yaml; слой остаётся обычным промежуточным", badGroups.map((detail) => ({ agent: "—", target: "", detail })));
  section("Секреты открытым текстом в слоях", "уйдут в git конфигурации; вынесите значения в local/secrets.env, в слое — ${ИМЯ}", naked);
  section("Секреты в skills слоёв", SKILL_SECRETS_ADVICE, nakedSkills);
  const values = [...valueFiles].map(([file, names]) => ({ agent: "—", target: file, detail: `значения ${[...names].sort().join(", ")}` }));
  section("Значения секретов в конфигах агентов", "miksy sync заменит серверы на обёртки (записанные keep-ом остаются, пока секрет не задан)", values);
  section("Значение секрета в настройке, записанной не miksy", "sync её не трогает (конфликт), и значение лежит в конфиге агента открытым текстом. Что сделать — в конце каждой строки", literals);
  section("Файлы секретов", "local/secrets/<ИМЯ>: нужны записанным конфигам", secretProblems);
  section("Файлы skills не доставлены", "ссылка ведёт за пределы слоёв конфигурации, никуда или на файл секретов вне skill; положите в skill сам файл (папку) или уберите ссылку", skillLinks);
  section("Секрет нельзя доставить", "сервер пропущен; исправьте значение в local/secrets.env или определение в слое", undeliverable);
  section("Пустые значения секретов", "сервер получит пустое значение; задайте его в local/secrets.env", emptySecrets);
  // Команда miksy: старый вид — всегда; нет её — когда ею запускаются MCP-серверы проектов (src/shim.ts)
  const shim = shimNotes(machine.home, machine.os, portableUsed, { agents: adapters.filter((x) => x.projectMcp === "portable").map((x) => agentTitle(x.id)) });
  const shimProblems = shim.problems.map((detail) => ({ agent: "—", target: "", detail }));
  section("Команда miksy", "ею агенты запускают MCP-серверы проектов", shimProblems);
  section("Нет исполняемого файла обёртки", "обёртка не запустится: программа удалена или обновлена (новый путь)", missingExe);
  if (missing.size) {
    out.push(`Не заданы переменные (${missing.size}) — local/machine.yaml или local/secrets.env; сервер на этой машине не нужен — miksy mcp off <имя>`);
    for (const [v, ag] of missing) out.push(`  ${v}  (${[...ag].join(", ")})`);
    out.push("");
  }
  // Отметка mcp_off для имени, которого нет ни в одном слое: опечатка или сервер убран (круг 11c)
  const known = new Set(offSet.size ? allLayerMcp().map((s) => s.name) : []);
  const strayOff = [...offSet].filter((n) => !known.has(n)).map((n) => ({ agent: "—", target: "local/machine.yaml", detail: `mcp_off: ${n} — такого сервера нет ни в одном слое; снять отметку — miksy mcp on ${n}` }));
  section("Выключен сервер, которого нет в слоях", "опечатка в имени или сервер убран из слоёв", strayOff);

  const problems = Number(!!manifestError) + blocked.length + permissions.length + unsynced.length + forgottenNow.length + renumbered.files.length + stale.length + vanished.length + team.length + manual.length + lost.length + orphans.length + typos.length + naked.length + nakedSkills.length + missing.size
    + values.length + secretProblems.length + undeliverable.length + skillLinks.length + groupBelow.length + former.length + badGroups.length + pendingTrust.length
    + emptySecrets.length + strayOff.length + missingExe.length + shimProblems.length + clashes.length + rooted.length + rootedMain.length + twins.length;
  out.push(problems ? `Проблем: ${problems}.` : "Всё синхронизировано.");
  // Старый Bun — предупреждение, не проблема: код выхода doctor от него не меняется (круг 10f)
  const bun = oldBun(bunVersion);
  if (bun) out.push("", `Предупреждение: ${bun}.`);

  // Справочно: не требует действий
  const info: string[] = [];
  if (shim.info.length) info.push(`Команда miksy (${shim.info.length}):`, ...shim.info.map((l) => "  " + l));
  const newer = newerLedger(manifest.engine);
  if (newer) info.push(`Версия: ${newer}`);
  // Копии skill miksy в глобальных слоях: прежний образец не действует, своя замена может отставать (круг 11j)
  let copies: BuiltinCopy[] = [];
  try {
    if (builtinLayer()) copies = builtinCopies(selectGlobal(loadMap(), machine.os).map((n) => loadLayer(n)));
  } catch { /* ошибку слоёв показывает проверка целей */ }
  if (copies.length) info.push(`Skill ${BUILTIN_SKILL} в конфигурации (${copies.length}):`, ...copies.map((c) => "  " + builtinCopyText(c, configRoot())));
  // Объявлены для skills, но не заданы на этой машине — справка, как и MCP без значения (круг 11l): слой может быть
  // для другой машины или организации, которой здесь нет
  if (skillSecretsMissing.length) info.push(`Секреты для skills не заданы (${skillSecretsMissing.length}) — miksy secret их не выдаст; если они нужны на этой машине, впишите ИМЯ=значение в ${slash(join(configRoot(), "local", "secrets.env"))}:`,
    ...skillSecretsMissing.map((f) => `  ${f.target}  ${f.detail}`));
  const wide = wideSkillSecrets();
  if (wide.length) info.push(`Секреты для skills в широкой привязке (${wide.length}) — ${WIDE_SKILL_SECRETS}:`, ...wide.map((l) => "  " + l));
  if (secretCopies.size)
    info.push(`Файлы секретов skills разложены по целям (секрет хранится не только в local/secrets.env; ${SKILL_SECRET_COPY_ADVICE}):`,
      ...[...secretCopies].sort(([a], [b]) => a.localeCompare(b)).map(([k, s]) => `  ${k} → ${count(s.size, "место", "места", "мест")}`));
  if (idle.size) {
    info.push(`Серверы, которые на этой машине не запустятся (${idle.size}):`);
    for (const [name, byWhy] of idle) for (const [why, ag] of byWhy) info.push(`  ${name}  ${why}  (${[...ag].join(", ")})`);
  }
  const keys = unknownKeys();
  if (keys.length) info.push(`Неизвестные ключи (${keys.length}) — miksy их не читает: опечатка или ключ более новой версии miksy:`, ...keys.map((k) => "  " + k));
  if (persistent.length) {
    info.push(`Известные конфликты (${persistent.length}) — повторяются при каждом sync, miksy их не трогает:`);
    for (const f of (verbose ? persistent : persistent.slice(0, 8))) info.push(`  ${f.agent}  ${f.target}  ${f.detail}`);
    if (!verbose && persistent.length > 8) info.push(`  … ещё ${persistent.length - 8} (--verbose)`);
  }
  const repoNote = workspaceRepoNote(machine, groups);
  if (repoNote) info.push(repoNote);
  if (roots.length > 1 || roots.some((r) => r.tree)) info.push(`Корни workspace (${roots.length}): ${roots.map(rootText).join("; ")}`);
  const notes = rootNotes(machine, groups);
  if (notes.length) info.push(`Корни (${notes.length}):`, ...notes.map((n) => "  " + n));
  const nested = nestedNotes(machine);
  if (nested.length) info.push(`Вложенные корни (${nested.length}):`, ...nested.map((n) => "  " + n));
  const branches = branchNotes(machine);
  if (branches.length) info.push(`Ветки корней внутри чужих мест (${branches.length}) — не ошибка, но проекты этих корней получают слои этих мест:`, ...branches.map((n) => "  " + n));
  if (outside.length) info.push(`Цели учёта вне workspace (${outside.length}) — их корень убран или workspace сменился: miksy их больше не обновляет; убрать записанное туда — miksy clean <путь>${othersNote(new Set(outside)) ? ` (агентам, которых нет в agents, — с --agent: команды в строке «Учёт агентов, которых нет в agents»)` : ""}${trustNote(new Set(outside)) ? `. ${trustNote(new Set(outside))}` : ""}:`, ...outside.map((d) => "  " + d));
  if (awayTargets.size) info.push(`Учёт целей недоступного корня (${awayTargets.size}) не проверяется — подключите диск: ${[...awayTargets].join(", ")}. Убрать записанное туда (${ownFiles(awayTargets)}): ${bothWays}${othersNote(awayTargets)}${trustNote(awayTargets) ? `. ${trustNote(awayTargets)}` : ""}`);
  // Учёт агентов, которых убрали из agents без clean: записанное им действует у агента, sync его не обновляет
  // (выпуск 0.2.1, A14). Команда — та, что действительно убирает (clean с --agent берёт и агента вне agents)
  // И отметки «проект забыт» таких агентов, если папка на месте: clean --agent узнает их файлы и уберёт (проверка 7b, B №1)
  const retired = [...new Map([...Object.keys(manifest.targets), ...Object.keys(manifest.forgotten ?? {}).filter((id) => existsSync(id.slice(id.indexOf("|") + 1)))]
    .map((id) => [id.slice(0, id.indexOf("|")), id.slice(id.indexOf("|") + 1)]).filter(([a]) => !enabled.has(a)).map((x) => [x.join("|"), x])).values()];
  if (retired.length) info.push(`Учёт агентов, которых нет в agents (${retired.length}) — miksy записывал им настройки, агента убрали из local/machine.yaml без clean: записанное действует, но не обновляется. Убрать (или верните агента в agents):`,
    ...retired.map(([a, d]) => `  miksy clean ${d === "global" ? "--global" : `${quoteArg(d)}`} --agent ${a}`));
  // Агенты в PATH, которых нет в agents и нет в учёте (у агентов с учётом — строка выше): новый или убранный пользователем
  // — miksy не знает, подключать сам не будет; подсказка, как подключить (круг 10i). Без agents в machine.yaml — все агенты
  const outsideAgents = machine.agents ? detectAgents(machine.home, which).inPath.filter((a) => !enabled.has(a) && !retired.some(([r]) => r === a)) : [];
  if (outsideAgents.length) info.push(`Найдены агенты вне agents (local/machine.yaml): ${outsideAgents.join(", ")} — miksy ${outsideAgents.length === 1 ? "его" : "их"} не настраивает. ${connectHint(outsideAgents.length)}`);
  if (leftTargets.size) info.push(`Учёт целей вне workspace без каталога (${leftTargets.size}; ${ownFiles(leftTargets)}): ${[...leftTargets].join(", ")} — каталога нет: диск не подключён или папку удалили. Убрать записанное туда: диск вернётся — miksy clean "<путь>"; папки больше нет — miksy clean "<путь>" (спросит, забыть ли; без терминала — --forget)${othersNote(leftTargets)}${trustNote(leftTargets) ? `. ${trustNote(leftTargets)}` : ""}`);
  // Прежние имена агентов в конфигурации работают как синонимы — подсказка переименовать
  const legacy = legacyAgentNames();
  const renamed = Object.values(ADAPTERS).flatMap((a) => (a.aliases ?? []).map((old) => `${old} теперь ${a.id}${a.aliasNote ? ` ${a.aliasNote}` : ""}`)).join("; ");
  if (legacy.length) info.push(`Прежнее имя агента (${legacy.length}) — работает, но лучше переименовать: ${renamed}:`, ...legacy.map((l) => "  " + l));
  if (skippedDirs.length) info.push(`Пропущено при поиске проектов (${skippedDirs.length}):`, ...skippedDirs.map((w) => "  " + w));
  // Обход корня упёрся в бюджет папок глубже SHALLOW_LEVELS (круг 11q): справка, а не проблема — в sync --all её нет
  if (cuts.length) {
    const n = (x: number) => String(x).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
    info.push(`Поиск проектов остановлен (${cuts.length}) — глубже ${SHALLOW_LEVELS} уровней от корня miksy просматривает не больше ${n(cuts[0].budget)} папок, проекты дальше могли не найтись:`,
      ...cuts.map((c) => `  ${c.root}${c.heavy.length ? ` — больше всего папок в ${c.heavy.map(([p, k]) => `${p} (${n(k)})`).join(", ")}` : ""}`),
      "  Проект там — запустите miksy sync в его папке; большие папки без проектов (данные, архивы) лучше держать вне workspace.");
  }
  const unread = ignoredLayerParts();
  if (unread.length) info.push(`Не читается: ${ignoredText(unread)}`);
  if (unused.length) info.push(`Слои, которые на этой машине ни к чему не применяются (проектов нет): ${unused.join(", ")}`);
  if (maybeOther.length) info.push(`Ветки дерева слоёв без папки на этой машине, но с похожей папкой (${maybeOther.length}) — если это ветка корня другой машины (там в machine.yaml { path: …, tree: <ветка> }), всё в порядке, ничего не делайте; если опечатка — переименуйте слой:`,
    ...maybeOther.map((d) => `  layers/tree/${d.path} ↔ в workspace есть ${d.suggestion}`));
  if (unmounted.length) info.push(`Части дерева слоёв, которых нет на этой машине (над ними нет корня workspace — для других машин): ${unmounted.join(", ")}`);
  const env = environment({ env: process.env, home: machine.home, os: machine.os, bun: stableBun(process.execPath), agents: adapters.map((a) => a.id), engine: ENGINE, config: configRoot() });
  if (env.length) info.push(`Окружение (${env.length}) — только сведения, miksy здесь ничего не меняет:`, ...env.map((l) => "  " + l));
  // Windows: команда miksy — miksy.cmd, а cmd раскрывает %ИМЯ% существующей переменной даже в кавычках — путь корня или
  // проекта с такой парой в команде miksy (в cmd и в PowerShell) дойдёт искажённым (круг 10n). Одиночный % и %ИМЯ%
  // несуществующей переменной cmd оставляет как есть — о них молчим
  const percent = process.platform === "win32"
    ? [...new Set([...roots.map((r) => slash(r.path)), ...[...groups, ...projects].map((p) => slash(p.abs))])].filter((p) => cmdExpands(p)).sort()
    : [];
  if (percent.length) info.push(`Пути с %ИМЯ% переменной окружения (${percent.length}) — команда miksy с таким путём получит его искажённым: miksy — это miksy.cmd, а cmd подставляет значение переменной даже в кавычках (и из PowerShell). Переименуйте папку или запускайте miksy через Bun напрямую: bun "${slash(ENGINE)}/src/cli.ts" <команда>:`, ...percent.map((p) => "  " + p));
  const plain = plainDirs(roots, groups, targets);
  if (plain.length) info.push(`Каталоги без git на уровне проектов (${plain.length}) — настроек не получат: git init в каталоге или miksy target <путь>:`,
    ...(verbose ? plain : plain.slice(0, 15)).map((d) => "  " + d), ...(!verbose && plain.length > 15 ? [`  … ещё ${plain.length - 15} (--verbose)`] : []));
  if (rootGroups.length) info.push(`Цели target: true, чей каталог стал корнем workspace (пометка в этом месте дерева не действует; слои его проектов — в ветке корня): ${rootGroups.join(", ")}`);
  if (absentGroups.length) info.push(`Цели target: true, каталогов которых на этой машине нет (пометка здесь не действует): ${absentGroups.join(", ")}`);
  if (moves.length) info.push(`Каталоги переехали (${moves.length}) — учёт следует за ними, sync сохранит перенос:`, ...movesText(moves));
  if (foreign.length) info.push(`Глобальные skills не от miksy (${foreign.length}): ${foreign.join(", ")}`);
  if (exposed.length) {
    info.push(`Секреты в каталогах без git (${exposed.length}) — не защищены от копий и архивов:`);
    for (const f of exposed) info.push(`  ${f.agent}  ${f.target}`);
  }
  if (secretFiles.info.length) info.push(`Файлы секретов (${secretFiles.info.length}):`, ...secretFiles.info.map((l) => "  " + l));
  if (declined.length) info.push(`Доверие отклонено пользователем (${declined.length}) — miksy его не ставит; пересмотреть: miksy trust <проект>:`,
    ...declined.map((p) => `  ${decisionTitle(p.agent)}  ${p.rel || p.dir}`));
  if (advice.length) {
    info.push(`Нужно действие в агенте (${advice.length}):`);
    for (const f of (verbose ? advice : advice.slice(0, 8))) info.push(`  ${f.agent}  ${f.target}  ${f.detail}`);
    if (!verbose && advice.length > 8) info.push(`  … ещё ${advice.length - 8} (--verbose)`);
  }
  if (info.length) out.push("", "Справочно:", ...info);

  return { text: out.join("\n"), problems, added, blocked };
}

// Действие плана возвращает записанное по учёту, а его нет: файл удалён, блок инструкций убран из файла
function missingNow(a: Action, prev: TargetState): boolean {
  if (a.kind === "write") return pathKey(a.abs) in prev.files && !existsSync(a.abs);
  if (a.kind !== "block" || !a.hash || !(pathKey(a.abs) in (prev.blocks ?? {}))) return false;
  try { return !existsSync(a.abs) || !splitInstructions(readFileSync(a.abs, "utf8")).block; } catch { return false; }
}

function summarize(actions: Action[]): string {
  const n = (k: Action["kind"]) => actions.filter((a) => a.kind === k).length;
  return [
    n("write") && `файлов: ${n("write")}`,
    n("block") && `блоков инструкций: ${n("block")}`,
    n("trust") && `доверие: ${n("trust")}`,
    n("approve") && `одобрение серверов ${approvalsSource()}: ${n("approve")}`,
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

// Раскроет ли cmd в строке пару %ИМЯ%: как разбирает cmd — от % до следующего %; имя есть в окружении (без учёта
// регистра; %ИМЯ:…% — подстрока и замена — тоже по имени до двоеточия) — раскроет. Нет — первый % остаётся, разбор
// продолжается со второго (круг 10n)
export function cmdExpands(s: string, env: Record<string, string | undefined> = process.env): boolean {
  const names = new Set(Object.keys(env).filter((k) => env[k] !== undefined).map((k) => k.toLowerCase()));
  for (let i = s.indexOf("%"); i >= 0; ) {
    const j = s.indexOf("%", i + 1);
    if (j < 0) return false;
    const name = s.slice(i + 1, j).split(":")[0].toLowerCase();
    if (name && names.has(name)) return true;
    i = j;
  }
  return false;
}
