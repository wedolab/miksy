// miksy doctor — что разошлось между слоями и тем, что лежит на диске. Только чтение.
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Adapter } from "./adapter";
import { type Action, plan, verifyMerges } from "./apply";
import { caseTwins, configRoot, ENGINE, ignoredLayerParts, ignoredText, layerSecrets, legacyAgentNames, loadSecrets, orphanTreeDirs, unknownKeys } from "./load";
import { machineRoots, rootText } from "./roots";
import { engineVersion, newerLedger } from "./version";
import { emptyState, ManifestError, type Manifest, otherOwners, splitState, strandedPaths } from "./manifest";
import type { Move } from "./relocate";
import { fold, pathKey, quoteArg, slash } from "./paths";
import { foreignMcp, foreignSkills } from "./foreign";
import { agentsFor, allProjects, allTargets, branchNotes, clashNotes, formerGroups, globalTarget, groupRulesDelivered, ledgerSkills, listGroups, literalHints, loadManifestMoved, movesText, nestedNotes, outsideRoots, READERS, stranded, renderFor, rootedTargets, rootedText, isMainRoot, rootNotes, type TargetSpec, targetId, targetKey, unavailable, unprotectedSecrets, unsyncedGroups, workspaceRepoNote } from "./registry";
import type { Machine } from "./types";
import { checkLocalAccess, checkSecretFiles, secretsDir } from "./secretfiles";
import { plainDirs } from "./target";
import { environment } from "./environ";
import { stableBun } from "./launch";
import { deliveredSkillNames, deliveryOrder } from "./registry";
import { files } from "./plural";
import { AGENT_NOTE, AGENT_TITLE, inheritedExec, type PendingTrust, pendingText, trustPlan, trustState } from "./trust";

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
        rendered = renderFor(adapter, t, machine, secrets, prev, [...(delivered.get(targetKey(t)) ?? []), ...others], rulesDelivered(adapter));
        // Для доверия — с отметкой «доверие ставил miksy» после clean (как у sync)
        const before = trustState(manifest, id) ?? emptyState();
        actions = plan(rendered.result, t.target, machine, before, false, adapter.id, otherOwners(manifest, id), manifest.forgotten?.[id]);
        delivered.set(targetKey(t), [...(delivered.get(targetKey(t)) ?? []), ...deliveredSkillNames(rendered.result, actions, t.target)]);
        for (const detail of trustPlan(rendered.result, t.target, machine, before, actions, adapter.id, undefined, undefined, manifest.forgotten?.[id]).missing) trust.push({ ...where, detail });
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
    for (const g of groups.filter((x) => !x.git)) {
      // Доверие группы запрещено (слой или machine.yaml) — наследовать нечего. Ответы в окне Claude в подкаталоге
      // (permissions.allow и т. п.) — не предмет этого раздела: их пишет Claude по ответу того, кто там работает;
      // здесь — хуки, env и прочее, что выполнится без вопроса
      const layer = targets.find((t) => t.target.scope === "project" && fold(pathKey(t.target.dir)) === fold(pathKey(g.abs)))?.cfg.trust?.claude?.item;
      if (layer === false || machine.trust?.claude === false) continue;
      for (const s of inheritedExec(g.abs, groups.filter((x) => x !== g).map((x) => x.abs), true))
        inherited.push({ agent: "claude", target: s.dir, detail: `доверие группы ${g.rel} действует и здесь: ${s.lines.join("; ")}` });
    }

  const localAccess = checkLocalAccess();
  if (localAccess.refuse) permissions.push({ agent: "—", target: "local/backups", detail: `пока так, все команды, которые пишут (sync, clean, setup, update, root, adopt, trust, target), откажут: ${localAccess.refuse}` });
  if (localAccess.bad.length) permissions.push({ agent: "—", target: "local/", detail: `открытых путей или ошибок проверки: ${localAccess.bad.length}; ${localAccess.bad[0]} — sync/setup исправит права${localAccess.refuse ? ", когда перестанут отказывать (строка выше)" : ""}` });
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
  const roots = machineRoots(machine);
  const treeUnused = orphanTreeDirs(roots);
  const typos = treeUnused.filter((d) => d.suggestion && !d.other).map((d) => ({ agent: "—", target: `layers/tree/${d.path}`, detail: `↔ в workspace есть ${d.suggestion}` }));
  // Ветка верхнего уровня, похожая на папку основного корня: опечатка или ветка корня другой машины — справочно
  const maybeOther = treeUnused.filter((d) => d.suggestion && d.other);
  const unused = treeUnused.filter((d) => !d.suggestion && !d.unmounted).map((d) => d.path);
  const unmounted = treeUnused.filter((d) => d.unmounted).map((d) => d.path);
  const twins = caseTwins().map((t) => ({ agent: "—", target: t.names.map((n) => `layers/tree/${n}`).join(", "), detail: `применяется только ${t.used}` }));

  const out: string[] = [`miksy doctor — версия ${engineVersion()}; агенты: ${adapters.map((a) => a.id).join(", ")}; ${roots.length > 1 ? `корней: ${roots.length}; ` : ""}проектов: ${projects.length}${groups.length ? `; помечено целями (target: true): ${groups.length}` : ""}`, ""];
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
  if (pendingTrust.length) out.push(`Нужно решение пользователя о доверии (${pendingTrust.length}) — у проектов исполняемые настройки агента, которые ставил не miksy (команда проекта, ответы в окне Claude, чужие файлы); без решения miksy доверие не ставит:`,
    ...pendingText(pendingTrust), AGENT_NOTE, "");
  section("Исполняемые настройки в подкаталогах групп без git", "Claude наследует доверие группы на подкаталоги без своего git: эти настройки применятся без вопроса; удалите их, сделайте каталог git-репо или запретите доверие группы (trust: { claude: false })", inherited);
  section("Не синхронизировано", "sync для них ни разу не запускался: miksy sync --all --agent <id>", unsynced, true);
  section("Проект забыт", "учёт записанного туда забыт (clean --forget или root remove --forget), а каталог на месте: miksy sync <путь> узнает файлы miksy, совпадающие с нынешними, и возьмёт их под учёт (изменённые — с --force); не нужны — затем miksy clean <путь>", forgottenNow, true);
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

  const problems = Number(!!manifestError) + blocked.length + permissions.length + unsynced.length + forgottenNow.length + stale.length + team.length + manual.length + lost.length + orphans.length + typos.length + naked.length + missing.size
    + values.length + secretProblems.length + undeliverable.length + groupBelow.length + former.length + badGroups.length + pendingTrust.length
    + emptySecrets.length + missingExe.length + clashes.length + rooted.length + rootedMain.length + twins.length;
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
  if (roots.length > 1 || roots.some((r) => r.tree)) info.push(`Корни workspace (${roots.length}): ${roots.map(rootText).join("; ")}`);
  const notes = rootNotes(machine, groups);
  if (notes.length) info.push(`Корни (${notes.length}):`, ...notes.map((n) => "  " + n));
  const nested = nestedNotes(machine);
  if (nested.length) info.push(`Вложенные корни (${nested.length}):`, ...nested.map((n) => "  " + n));
  const branches = branchNotes(machine);
  if (branches.length) info.push(`Ветки корней внутри чужих мест (${branches.length}) — не ошибка, но проекты этих корней получают слои этих мест:`, ...branches.map((n) => "  " + n));
  if (outside.length) info.push(`Цели учёта вне workspace (${outside.length}) — их корень убран или workspace сменился: miksy их больше не обновляет; убрать записанное туда — miksy clean <путь>${othersNote(new Set(outside)) ? ` (агентам, которых нет в agents, — с --agent: команды в строке «Учёт агентов, которых нет в agents»)` : ""}:`, ...outside.map((d) => "  " + d));
  if (awayTargets.size) info.push(`Учёт целей недоступного корня (${awayTargets.size}) не проверяется — подключите диск: ${[...awayTargets].join(", ")}. Убрать записанное туда (${ownFiles(awayTargets)}): ${bothWays}${othersNote(awayTargets)}`);
  // Учёт агентов, которых убрали из agents без clean: записанное им действует у агента, sync его не обновляет
  // (выпуск 0.2.1, A14). Команда — та, что действительно убирает (clean с --agent берёт и агента вне agents)
  // И отметки «проект забыт» таких агентов, если папка на месте: clean --agent узнает их файлы и уберёт (проверка 7b, B №1)
  const retired = [...new Map([...Object.keys(manifest.targets), ...Object.keys(manifest.forgotten ?? {}).filter((id) => existsSync(id.slice(id.indexOf("|") + 1)))]
    .map((id) => [id.slice(0, id.indexOf("|")), id.slice(id.indexOf("|") + 1)]).filter(([a]) => !enabled.has(a)).map((x) => [x.join("|"), x])).values()];
  if (retired.length) info.push(`Учёт агентов, которых нет в agents (${retired.length}) — miksy записывал им настройки, агента убрали из local/machine.yaml без clean: записанное действует, но не обновляется. Убрать (или верните агента в agents):`,
    ...retired.map(([a, d]) => `  miksy clean ${d === "global" ? "--global" : `${quoteArg(d)}`} --agent ${a}`));
  if (leftTargets.size) info.push(`Учёт целей вне workspace без каталога (${leftTargets.size}; ${ownFiles(leftTargets)}): ${[...leftTargets].join(", ")} — каталога нет: диск не подключён или папку удалили. Убрать записанное туда: диск вернётся — miksy clean "<путь>"; папки больше нет — miksy clean "<путь>" (спросит, забыть ли; без терминала — --forget)${othersNote(leftTargets)}`);
  // Прежние имена агентов в конфигурации работают как синонимы — подсказка переименовать
  const legacy = legacyAgentNames();
  if (legacy.length) info.push(`Прежнее имя агента (${legacy.length}) — работает, но лучше переименовать: gemini теперь antigravity (Antigravity — агент, Gemini — модель):`, ...legacy.map((l) => "  " + l));
  if (skippedDirs.length) info.push(`Пропущено при поиске проектов (${skippedDirs.length}):`, ...skippedDirs.map((w) => "  " + w));
  const unread = ignoredLayerParts();
  if (unread.length) info.push(`Не читается: ${ignoredText(unread)}`);
  if (unused.length) info.push(`Слои, которые на этой машине ни к чему не применяются (проектов нет): ${unused.join(", ")}`);
  if (maybeOther.length) info.push(`Ветки дерева слоёв без папки на этой машине, но с похожей папкой (${maybeOther.length}) — если это ветка корня другой машины (там в machine.yaml { path: …, tree: <ветка> }), всё в порядке, ничего не делайте; если опечатка — переименуйте слой:`,
    ...maybeOther.map((d) => `  layers/tree/${d.path} ↔ в workspace есть ${d.suggestion}`));
  if (unmounted.length) info.push(`Части дерева слоёв, которых нет на этой машине (над ними нет корня workspace — для других машин): ${unmounted.join(", ")}`);
  const env = environment({ env: process.env, home: machine.home, os: machine.os, bun: stableBun(process.execPath), agents: adapters.map((a) => a.id), engine: ENGINE, config: configRoot() });
  if (env.length) info.push(`Окружение (${env.length}) — только сведения, miksy здесь ничего не меняет:`, ...env.map((l) => "  " + l));
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
