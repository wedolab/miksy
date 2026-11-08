// Общее для команд CLI: адаптеры, построение целей, генерация для цели
import { claude } from "../adapters/claude";
import { codex } from "../adapters/codex";
import { antigravity } from "../adapters/antigravity";
import { opencode } from "../adapters/opencode";
import type { Adapter, RenderedFile, RenderResult, Target } from "./adapter";
import { createLauncher, stableBun } from "./launch";
import { existsSync } from "node:fs";
import { canonical, fold, inside, pathKey, sameKey, samePath, slash, driveRoot, trimSlash } from "./paths";
import { dirname, join, relative, resolve } from "node:path";
import { agentId } from "./agentid";
import { clashText, dirsOf, locate, machineRoots, nestedText, outerRoot, type Root, rootExists, rootKey, rootText, treeAbove, treeClashes, treeJoin, treeOf } from "./roots";
import { containsProjects, ENGINE, listProjects, serviceDir, loadLayer, loadMap, configRoot, rootMemoryKey, treeGroups, treeLayers } from "./load";
import { merge, selectGlobal, selectProject } from "./resolve";
import { type AgentId, DEFAULT_READERS, scanTeamSkills, withTeamSkills } from "./teamskills";
import { loadManifest, type Manifest, saveManifest, sha, type TargetState } from "./manifest";
import { applyMoves, findMoves, HOW, type Move } from "./relocate";
import { moveDecisions, saveMovedDecisions } from "./trust";
import type { Action } from "./apply";
import type { Below, Layer, Machine, Resolved } from "./types";
import { bridgeEnv, refsIn, SECRET_MARK, type SkippedMcp, substitute } from "./vars";
import { readFileSync } from "node:fs";
import { parseToml } from "./toml";
import { blockHash, splitInstructions } from "./instructions";
import { MIN as MASK_MIN } from "./mask";

export const ADAPTERS: Record<string, Adapter> = { claude, codex, opencode, antigravity };

// Где каждый агент сам находит skills проекта: объявления адаптеров поверх таблицы ядра
export const READERS: Record<AgentId, string[]> = {
  ...DEFAULT_READERS,
  ...Object.fromEntries(Object.values(ADAPTERS).filter((a) => a.skillDirs).map((a) => [a.id, a.skillDirs!])),
};

// Импорт командных skills — для адаптеров, где он проверен
export const TEAM_IMPORT = new Set(["claude", "codex", "antigravity"]);

// Агенты для команды: --agent, иначе список машины (local/machine.yaml), иначе все. Прежние имена
// (gemini) — синонимы
export function agentsFor(machine: Machine, flag?: string): Adapter[] {
  const ids = flag ? [flag] : machine.agents ?? Object.keys(ADAPTERS);
  return [...new Set(ids.map(agentId))].map((id) => {
    const a = ADAPTERS[id];
    if (!a) throw new Error(`Нет адаптера «${id}». Есть: ${Object.keys(ADAPTERS).join(", ")}`);
    return a;
  });
}

export interface TargetSpec {
  cfg: Resolved;
  target: Target;
  title: string;
}

// Ключ цели для сведений одного запуска (skills, доставленные другими агентами): каталог, а не
// заголовок — при совпадении ветки корня с папкой другого корня заголовки могут совпасть
export const targetKey = (t: TargetSpec) => (t.target.scope === "project" ? fold(pathKey(t.target.dir)) : "global");

// Заголовок цели: место в дереве слоёв; если то же место есть на машине и в другом корне (ветка корня
// совпала с папкой другого корня — treeClashes) — и корень
export function titleOf(rel: string, root: Root | undefined, machine: Machine): string {
  const title = rel || "(корень workspace)";
  const roots = machineRoots(machine);
  return root && rel && roots.length > 1 && dirsOf(rel, roots).length > 1 ? `${title} (${root.path})` : title;
}

export function globalTarget(machine: Machine): TargetSpec {
  const cfg = merge(selectGlobal(loadMap(), machine.os).map((n) => loadLayer(n)), machine.os);
  return { cfg, target: { scope: "global" }, title: `~ (${machine.home})` };
}

// Слои проекта: дерево layers/tree по месту проекта в дереве, затем особые привязки из map.yaml
export const layersOf =(rel: string, machine: Machine) => [...treeLayers(rel), ...selectProject(loadMap(), rel, machine.os).map((n) => loadLayer(n))];

// Цель без git (Р4): каталог workspace, слой дерева которого помечен target: true. Получает слои до
// своего уровня, как проект; git не нужен. Частные случаи — каталог над проектами (группа: внутри
// есть проекты) и рабочий каталог без git. Тип и имена в коде — Group: исторически пометка вводилась
// для групп
export interface Group { abs: string; rel: string; nested: boolean; git: boolean; root?: Root }
// Как назвать помеченный каталог в выводе
export const markedKind = (t: { nested?: boolean }) => (t.nested ? "группа" : "цель без git");

// Группы этой машины: каталоги всех корней на месте помеченного слоя (ветка корня совпала с папкой
// другого корня — два каталога). Неверная пометка (нет каталога, служебный каталог, содержит дом, внутри проекта,
// корень дерева или корень workspace) — предупреждение warn, слой остаётся обычным промежуточным
export function listGroups(machine: Machine, warn?: (msg: string) => void): Group[] {
  const roots = machineRoots(machine);
  const home = canonical(machine.home);
  const out: Group[] = [];
  for (const g of treeGroups()) {
    if (!g) {
      warn?.("пометка target: true не действует: корень дерева (layers/tree/layer.yaml) — workspace целиком не цель");
      continue;
    }
    // Каталоги корней по пути слоя, без учёта регистра (как treeLayers); ссылка на каталог (симлинк,
    // junction) — тоже каталог: причина отказа ниже, а не «каталога нет»
    const places = dirsOf(g, roots);
    if (!places.length) {
      // Каталог есть, но сам стал корнем workspace (root add … --yes): пометка в этом месте дерева не действует
      const rooted = dirsOf(g, roots, true).find((p) => roots.some((r) => sameKey(r.path, p.dir)));
      warn?.(rooted ? `цель ${g} (target: true): каталог ${rooted.dir} стал корнем workspace — пометка здесь не действует (слои его проектов — в ветке корня)` : `цель ${g} (target: true): каталога нет в workspace — пометка не действует`);
      continue;
    }
    for (const { root, dir, link } of places) {
      const ws = root.path;
      const abs = canonical(dir);
      // Файлы группы в чужом репо (не корень проекта) не скрыл бы exclude; корень workspace — не проект
      let repo: string | null = null;
      for (let d = slash(dirname(abs)); inside(d, ws) && !sameKey(d, ws); d = slash(dirname(d)))
        if (existsSync(join(d, ".git"))) { repo = d; break; }
      const why = !inside(abs, ws) ? `каталог ведёт через симлинк за пределы workspace (${abs})`
        : link ? `путь идёт через симлинк (→ ${slash(relative(ws, abs))}) — пометьте каталог назначения`
        : sameKey(abs, ws) ? `это корень workspace ${ws} — корень целью не бывает (его проекты и так получают этот слой)`
        : serviceDir(abs) ? "служебный каталог miksy"
        : inside(home, abs) ? "каталог содержит домашний каталог"
        : repo ? `внутри проекта ${treeJoin(root.tree, slash(relative(ws, repo)))} (файлы цели лежали бы в чужом репо без exclude)`
        : null;
      if (why) { warn?.(`цель ${g} (target: true)${roots.length > 1 ? ` в ${ws}` : ""}: ${why} — пометка не действует`); continue; }
      out.push({ abs, rel: treeJoin(root.tree, slash(relative(ws, abs))), nested: containsProjects(abs), git: existsSync(join(abs, ".git")), root });
    }
  }
  return out;
}

// Корень workspace — сам git-репо: группы без своего git лежат внутри него, и Codex собирает
// .codex/config.toml и .agents/skills от корня до каталога сессии — во вложенной группе skills
// групп выше видны вторично (одноимённые — дважды; проверено вживую, codex-cli 0.160)
export function workspaceRepoNote(machine: Machine, groups: Group[]): string | null {
  const notes = machineRoots(machine).flatMap((r) => {
    const mine = groups.filter((g) => !g.root || sameKey(g.root.path, r.path));
    const nested = mine.filter((g) => !g.git && mine.some((h) => h !== g && inside(g.abs, h.abs)));
    if (!nested.length || !existsSync(join(r.path, ".git"))) return [];
    return [`корень workspace ${r.path} — git-репо: Codex во вложенных группах без своего git (${nested.map((g) => g.rel).join(", ")}) видит и skills групп выше (одноимённые — дважды); уберите .git из корня workspace, если он не нужен`];
  });
  return notes.length ? notes.join("\n") : null;
}

// Особенности корней этой машины — предупреждения для projects, sync --all и doctor: недоступный
// корень (диск не подключён); вложенный корень внутри проекта внешнего (его файлы лежали бы в чужом
// git-репо) или внутри группы внешнего (группы считаются в пределах корня, а Claude читает
// родительские каталоги физически — правила такой группы придут и сюда)
export function rootNotes(machine: Machine, groups: Group[]): string[] {
  const roots = machineRoots(machine);
  const out: string[] = [];
  for (const r of roots) {
    if (!rootExists(r)) { out.push(`корень ${rootText(r)} недоступен (${r.away ?? "каталога нет"}): его проекты пропущены, записанное туда и учёт его целей не трогаются`); continue; }
    for (const o of roots.filter((x) => x !== r && rootExists(x) && inside(r.path, x.path) && !sameKey(r.path, x.path))) {
      for (let d = slash(dirname(r.path)); inside(d, o.path) && !sameKey(d, o.path); d = slash(dirname(d)))
        if (existsSync(join(d, ".git"))) { out.push(`корень ${r.path} лежит внутри проекта ${d} (корень ${o.path}): файлы его целей окажутся в чужом git-репо без exclude — уберите вложенный корень или перенесите каталог`); break; }
      for (const g of groups.filter((g) => g.root && sameKey(g.root.path, o.path) && inside(r.path, g.abs)))
        out.push(`корень ${r.path} лежит внутри группы ${g.rel} (корень ${o.path}): группы считаются в пределах своего корня, но Claude читает родительские каталоги — в проектах этого корня будут и правила группы ${g.rel}`);
    }
  }
  return out;
}

// Совпадения веток корней с папками других корней (src/roots.ts: treeClashes) — предупреждения
export const clashNotes = (machine: Machine) => treeClashes(machineRoots(machine)).map(clashText);

// Ветка корня внутри чужого места — справка с рекомендацией (не проблема). Место — предок ветки (кроме
// корня дерева: он общий у всех корней по замыслу), у которого есть свои слои (layers/tree/<предок>/…)
// или каталог другого корня: ветка другого корня (tree: Clients/Sub при tree: Clients) или папка основного
// (tree: Org/Sub при папке Org). Проекты корня получают слои предка — что именно, перечисляется. Корень,
// который физически лежит в каталоге своего места-родителя (вложенный на естественном месте), — не справка
export function branchNote(r: Root, roots: Root[]): string | null {
  const segs = r.tree ? r.tree.split("/") : [];
  if (segs.length < 2) return null;
  const ancestors = segs.slice(0, -1).map((_, i) => segs.slice(0, i + 1).join("/"));
  if (dirsOf(ancestors[ancestors.length - 1], roots).some((d) => d.root !== r && inside(r.path, d.dir))) return null;
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const layers = treeLayers(r.tree).filter((l) => ancestors.some((a) => same(a, l.name)));
  const dirs = ancestors.flatMap((a) => dirsOf(a, roots).filter((d) => d.root !== r)).map((d) => `${d.dir}${sameKey(d.dir, d.root.path) ? ` — корень, ветка ${d.root.tree}` : ` — папка корня ${d.root.path}`}`);
  if (!layers.length && !dirs.length) return null;
  const parts = (l: Layer) => [
    l.instructions.length && `правила ${l.instructions.map((i) => i.file).join(", ")}`,
    l.mcp.length && `MCP ${l.mcp.map((m) => m.name).join(", ")}`,
    l.skills.length && `skills ${l.skills.map((s) => s.name).join(", ")}`,
  ].filter(Boolean).join("; ") || "настройки слоя";
  const inherit = layers.length
    ? `его проекты получают и слои ${layers.map((l) => `layers/tree/${l.name} (${parts(l)})`).join(", ")}`
    : `своих слоёв у ${ancestors.join(", ")} пока нет, но всё, что там появится, получат и его проекты`;
  const top = segs[0];
  return `корень ${r.path}: ветка layers/tree/${r.tree} лежит внутри места ${ancestors[ancestors.length - 1]}${dirs.length ? ` (там же: ${dirs.join("; ")})` : ""} — ${inherit}. ` +
    `Не нужно — вынесите ветку из ${top} (например, tree: ${top}-${segs[segs.length - 1]}), а общее задайте явно слоем в map.yaml (README, «Несколько корней workspace»)`;
}
export const branchNotes = (machine: Machine) => {
  const roots = machineRoots(machine);
  return roots.flatMap((r) => { const n = branchNote(r, roots); return n ? [n] : []; });
};

// Вложенные корни — справка (не предупреждение): какой корень внутри какого и где он в дереве
export const nestedNotes = (machine: Machine) => {
  const roots = machineRoots(machine);
  return roots.flatMap((r) => { const o = outerRoot(r, roots); return o ? [nestedText(r, o)] : []; });
};

// Каталог вне всех корней workspace (корень убран, workspace сменился): цель учёта, которую miksy больше
// не обновляет
export const outsideRoots = (dir: string, machine: Machine) => !locate(dir, machineRoots(machine));

// nested — внутри есть другие проекты (не задано — проверяется обходом каталога).
// groups — группы машины (не задано — читаются заново): цель-группа и отрезок ниже групп (Resolved.below) —
// только группы того же корня workspace
export function projectTarget(abs: string, rel: string, machine: Machine, nested?: boolean, groups = listGroups(machine)): TargetSpec {
  abs = canonical(abs);
  if (inside(canonical(machine.home), abs)) throw new Error(`${abs}: проектная цель содержит домашний каталог; используйте --global для дома`);
  const cfg = merge(layersOf(rel, machine), machine.os);
  const place = locate(abs, machineRoots(machine));
  const group = groups.some((g) => fold(g.abs) === fold(abs));
  const above = groups.filter((g) => inside(abs, g.abs) && fold(g.abs) !== fold(abs) && (!place || !g.root || sameKey(g.root.path, place.root.path))).sort((a, b) => a.abs.length - b.abs.length);
  if (above.length) cfg.below = belowOf(cfg, above, machine);
  const target: Target = { scope: "project", dir: abs, rel, nested: nested ?? containsProjects(abs), git: existsSync(join(abs, ".git")), ...(group && { group: true }) };
  return { cfg, target, title: titleOf(rel, place?.root, machine) };
}

// Отрезок цели ниже групп: слои между ближайшей группой выше (не включая) и целью (включая).
// Отрезок каждой группы — так же относительно группы над ней. Исключённое в цели, но лежащее в файлах
// любой группы выше (правила её отрезка, skills и MCP целиком), — leaked: агент прочитает его сам
function belowOf(cfg: Resolved, above: Group[], machine: Machine): Below {
  let prev: string[] = [];
  const groups: Below["groups"] = [];
  const leaked = new Map<string, Below["leaked"][number]>();
  const leak = (kind: Below["leaked"][number]["kind"], name: string, group: string) => { if (!leaked.has(`${kind}:${name}`)) leaked.set(`${kind}:${name}`, { kind, name, group }); };
  for (const g of above) {
    const gc = merge(layersOf(g.rel, machine), machine.os);
    const own = gc.layers.filter((n) => !prev.includes(n));
    groups.push({ rel: g.rel, dir: g.abs, layers: own, instructions: gc.instructions.some((i) => own.includes(i.layer)) });
    for (const i of gc.instructions.filter((i) => own.includes(i.layer)))
      if (!cfg.instructions.some((x) => x.layer === i.layer && x.item.file === i.item.file)) leak("instructions", i.item.file, g.rel);
    for (const s of gc.skills) if (!cfg.skills.some((x) => x.item.name === s.item.name)) leak("skills", s.item.name, g.rel);
    for (const s of gc.mcp) if (!cfg.mcp.some((x) => x.item.name === s.item.name)) leak("mcp", s.item.name, g.rel);
    prev = gc.layers;
  }
  const layers = cfg.layers.filter((n) => !prev.includes(n));
  return { groups, layers, instructions: cfg.instructions.filter((i) => layers.includes(i.layer)), leaked: [...leaked.values()] };
}

const AGENT_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", opencode: "opencode", antigravity: "Antigravity" };

// Канал правил группы доставлен: в учёте группы — блок или own-файл правил (rulesFiles адаптера), и он
// цел на диске: блок разбирается и его хеш совпадает с учтённым, own-файл — с учтённым хешем. Файл без
// блока (заменён чужим текстом) или с правленым блоком правил не даёт. Любой другой файл группы (skill,
// обёртка) правил не означает
export function groupRulesDelivered(adapter: Adapter, manifest: Manifest, dir: string): boolean {
  const st = manifest.targets[`${adapter.id}|${pathKey(dir)}`];
  if (!st) return false;
  return (adapter.rulesFiles ?? []).map((r) => pathKey(join(dir, r))).some((p) => {
    if (!existsSync(p)) return false;
    const text = readFileSync(p, "utf8");
    const hash = st.blocks?.[p];
    if (hash) {
      try { return blockHash(splitInstructions(text, hash).block) === hash; } catch { return false; }
    }
    return p in st.files && st.files[p] === sha(text);
  });
}

// Группы выше цели, которые должны были дать агенту правила своего отрезка, а не дали (не
// синхронизирована, конфликт файла правил, команда версионирует файлы правил). Ближайшая доставившая
// группа покрывает всё выше себя (её sync так же досчитал отрезки групп над ней) — covered: её слои.
// delivered — по учёту (и по плану этого запуска в --dry-run); не задано — все считаются доставленными
export function groupCoverage(adapter: Adapter, t: TargetSpec, delivered?: (dir: string) => boolean): { lacking: Below["groups"]; covered: string[] } | null {
  if (!delivered || t.target.scope !== "project" || !t.cfg.below || !adapter.inherits?.(t.target).rules) return null;
  const gs = t.cfg.below.groups;
  let low = gs.length - 1;
  while (low >= 0 && !delivered(gs[low].dir)) low--;
  return { lacking: gs.slice(low + 1).filter((g) => g.instructions), covered: gs.slice(0, low + 1).flatMap((g) => g.layers) };
}

export function unsyncedGroups(adapter: Adapter, t: TargetSpec, delivered: (dir: string) => boolean): string[] {
  return (groupCoverage(adapter, t, delivered)?.lacking ?? []).map((g) =>
    `группа ${g.rel} выше не получила правила ${AGENT_NAMES[adapter.id] ?? adapter.id} (не синхронизирована, конфликт или файлы правил версионирует команда) — правила её слоёв ${g.layers.join(", ")} записаны в эту цель; когда группа их получит (sync ${g.rel} или sync --all), повторите sync цели`);
}

// Бывшие группы: в учёте записаны как группа, а пометки больше нет (или она стала неверной).
// Их наследуемые файлы продолжали бы действовать на цели ниже — sync --all убирает их по учёту
export function formerGroups(manifest: Manifest, adapter: Adapter, groups: Group[], machine: Machine): { dir: string; rel: string }[] {
  const current = new Set(groups.map((g) => fold(pathKey(g.abs))));
  const roots = machineRoots(machine);
  // Группа недоступного корня (диск не подключён) пометку не теряла — её не трогаем; вне всех корней
  // (корень убран из workspace) — тоже: убрать записанное туда — явно, miksy clean <путь>
  const away = roots.filter((r) => !rootExists(r));
  return Object.entries(manifest.targets)
    .filter(([id, st]) => st.group && id.startsWith(`${adapter.id}|`))
    .map(([id]) => id.slice(id.indexOf("|") + 1))
    .filter((dir) => !current.has(fold(dir)) && !away.some((r) => inside(dir, r.path)) && !!locate(dir, roots))
    .map((dir) => ({ dir, rel: treeOf(dir, roots) }));
}

// Бывшая группа как цель clean: только каталог и учёт (слои не нужны)
export function formerTarget(f: { dir: string; rel: string }): TargetSpec {
  const dir = f.dir;
  return { cfg: merge([], "linux"), target: { scope: "project", dir, rel: f.rel, nested: existsSync(dir) && containsProjects(dir), git: existsSync(join(dir, ".git")) }, title: f.rel };
}

// Файлы проекта без git, где секреты лежат открытым текстом: нет .git/info/exclude и ничего,
// что удержало бы их от копий каталога, архивов, синхронизации. Возвращает предупреждение или null
export function unprotectedSecrets(result: RenderResult, target: Target, secrets: Record<string, string>): string | null {
  if (target.scope !== "project" || target.git) return null;
  const values = Object.entries(secrets).filter(([, v]) => v.length >= 4);
  const files = new Set<string>();
  const names = new Set<string>();
  for (const f of result.files) {
    if (f.base !== "project") continue;
    const text = f.mode === "own" ? f.content : JSON.stringify(f.data);
    for (const [n, v] of values)
      if (text.includes(v)) {
        files.add(f.path);
        names.add(n);
      }
  }
  if (!files.size) return null;
  return `каталог без git: секреты ${[...names].join(", ")} лежат открытым текстом в ${[...files].join(", ")} и не защищены git ` +
    "(нет .git/info/exclude; попадут в копии и архивы каталога)";
}

export const targetId = (adapter: Adapter, target: Target) =>
  `${adapter.id}|${target.scope === "global" ? "global" : pathKey(target.dir)}`;

// Проекты, которые видит хотя бы один агент (git-репо + каталоги, где агенты уже работали)
// Служебные каталоги самого miksy (песочницы, тестовые репо, бэкапы) — не проекты
// warn — пропущенные каталоги и проекты (нет доступа; проект содержит домашний каталог — его
// файлы агенты читали бы во всём доме): предупреждение, а не отказ всей команды
export function allProjects(machine: Machine, adapters: Adapter[] = Object.values(ADAPTERS), warn?: (msg: string) => void) {
  const known = adapters.flatMap((a) => a.knownDirs?.(machine) ?? []);
  const home = canonical(machine.home);
  return listProjects(machineRoots(machine), known, warn).filter((p) => {
    if (serviceDir(p.abs)) return false;
    if (!inside(home, p.abs)) return true;
    warn?.(`${p.rel} пропущен: проект содержит домашний каталог (для дома — --global)`);
    return false;
  });
}

// Все цели workspace: группы (сверху вниз — их учёт обновляется раньше целей ниже) и проекты;
// git-репо, помеченное группой, — один раз, как группа
export function allTargets(machine: Machine, groups: Group[], warn?: (msg: string) => void): TargetSpec[] {
  const dirs = new Set(groups.map((g) => fold(g.abs)));
  const ordered = [...groups].sort((a, b) => a.rel.split("/").length - b.rel.split("/").length || a.rel.localeCompare(b.rel));
  return [
    ...ordered.map((g) => projectTarget(g.abs, g.rel, machine, g.nested, groups)),
    ...allProjects(machine, undefined, warn).filter((p) => !dirs.has(fold(canonical(p.abs)))).map((p) => projectTarget(p.abs, p.rel, machine, p.nested, groups)),
  ];
}

export function teamFor(cfg: Resolved, target: Target, adapter: Adapter): { cfg: Resolved; warnings: string[] } {
  if (target.scope !== "project" || !cfg.importSkills) return { cfg, warnings: [] };
  if (!TEAM_IMPORT.has(adapter.id)) {
    const unseen = scanTeamSkills(target.dir, READERS).skills.filter((s) => !s.seenBy.includes(adapter.id as AgentId)).length;
    return { cfg, warnings: unseen ? [`командных skills, которых ${adapter.id} не видит: ${unseen}; импорт для ${adapter.id} пока не включён`] : [] };
  }
  return withTeamSkills(cfg, target.dir, adapter.id, READERS);
}

// Доставка секретов цели: обёртки и helper-ы в local/run/<агент>/<цель>/. Bun моста — по стабильному
// пути (без каталога с версией): обновление Bun не ломает обёртки
export function launcherFor(adapter: Adapter, target: Target, machine: Machine) {
  return createLauncher({ os: machine.os, local: join(configRoot(), "local"), agent: adapter.id, target, bun: stableBun(process.execPath), engine: ENGINE });
}

// Полная генерация для цели: подстановка переменных, импорт командных skills, рендер адаптера.
// Секреты адаптер получает ссылками и доставляет через launch; значение в конфиг агента не
// попадает: метка ссылки или значение секрета в MCP-файле рендера — ошибка цели, не запись
export function renderFor(
  adapter: Adapter,
  t: TargetSpec,
  machine: Machine,
  secrets: Record<string, string>,
  prev?: TargetState, // учёт цели: адаптер решает, чей файл, по нему
  deliveredSkills?: string[],
  groupRules?: (dir: string) => boolean, // группа выше доставила правила (не задано — считается, что да)
): { result: RenderResult; cfg: Resolved; missing: string[]; skipped: SkippedMcp[] } {
  // ${WORKSPACE} — основной (первый) корень у целей любого корня и в глобальных настройках: смысл
  // переменной не зависит от цели. Путь в другой корень — своей переменной в vars local/machine.yaml
  const { resolved, missing, skipped, secretServers, usedSecrets, serverUses, empty } = substitute(t.cfg, machine, secrets, { agent: adapter.id, http: adapter.httpSecrets });
  const team = teamFor(resolved, t.target, adapter);
  const launch = launcherFor(adapter, t.target, machine);
  const ownedFiles = Object.keys(prev?.files ?? {});
  // Ниже группы: агенту, который сам читает правила родительских каталогов, — только отрезок цели.
  // Группа выше правил не получила — её отрезок (до ближайшей доставившей группы) пишется в цель
  const below = t.target.scope === "project" ? t.cfg.below : undefined;
  const inherits = below && t.target.scope === "project" ? adapter.inherits?.(t.target) ?? {} : {};
  const coverage = groupCoverage(adapter, t, groupRules);
  const layers = coverage?.lacking.length ? team.cfg.layers.filter((n) => !coverage.covered.includes(n)) : below?.layers;
  const cfg = below && inherits.rules ? { ...team.cfg, instructions: team.cfg.instructions.filter((i) => layers!.includes(i.layer)), layers: layers! } : team.cfg;
  const result = adapter.render(cfg, t.target, machine, { ownedFiles, keep: skipped.map((s) => s.name), launch, skipped, deliveredSkills });
  const lackingRel = new Set(coverage?.lacking.map((g) => g.rel));
  for (const l of below?.leaked ?? [])
    if (inherits[l.kind === "instructions" ? "rules" : l.kind] && !(l.kind === "instructions" && lackingRel.has(l.group)))
      result.warnings.push(`exclude ${l.kind === "skills" ? "skill" : l.kind}.${l.name} не действует для ${adapter.id}: приходит из файлов группы ${l.group} (агент сам читает родительские каталоги); исключите в слое группы или снимите пометку`);
  const kept = skipped.filter((s) => !result.noKeep?.includes(s.name));
  // Обёртки пропущенных серверов, записанных раньше, остаются вместе с их определениями (keep)
  const owned = new Set(ownedFiles.map((f) => fold(pathKey(f))));
  const local = join(configRoot(), "local");
  for (const s of kept)
    for (const f of launch.kept(s.name))
      if (owned.has(fold(pathKey(join(local, f.path)))) && !result.files.some((x) => x.base === "local" && x.path === f.path)) result.files.push(f);
  for (const f of result.files) assertNoSecret(adapter, f, usedSecrets, secrets);
  // Секретны MCP-файлы (всегда, в том числе при keep и уже отсутствующем секрете) и файлы, где
  // встречается значение используемого секрета (от 8 символов: skill с копией токена). Не любое
  // совпадение со значением из secrets.env: PGUSER=postgres не делает скрипт секретным.
  // Значения могут содержать кавычки/переводы строк: сравниваем и JSON-форму.
  const values = usedSecrets.map((n) => secrets[n]).filter((v) => v.length >= 8);
  for (const f of result.files) {
    if (f.mode === "merge") {
      f.sensitive = true;
      const data = (f.data ?? {}) as Record<string, unknown>;
      const names = Object.keys(data).filter((n) => secretServers.includes(n));
      if (names.length) f.secretKeys = names;
      continue;
    }
    if (f.mcp || values.some((v) => f.content.includes(v) || f.content.includes(JSON.stringify(v).slice(1, -1)))) f.sensitive = true;
  }
  result.warnings.push(...team.warnings, ...[...argSecretWarnings(team.cfg, adapter.id), ...httpEnvWarnings(team.cfg, adapter)].filter((w) => !result.warnings.includes(w)));
  for (const e of empty) result.warnings.push(`mcp ${e.server}: секрет ${e.name} пустой в local/secrets.env — сервер получит пустое значение`);
  // Короткое значение совпадало бы с чем угодно: маскируется только целой строкой (src/mask.ts)
  for (const n of usedSecrets.filter((n) => secrets[n] && secrets[n].length < MASK_MIN))
    result.warnings.push(`секрет ${n} короче ${MASK_MIN} символов: в бэкапах и выводе моста маскируется, только когда он — целое строковое значение (JSON/TOML, строка ответа); в прочем тексте — нет`);
  if (team.cfg.trust) result.trust = team.cfg.trust;
  // Сервер без переменной (или с недоставляемым секретом) пропускается сам, остальное генерируется;
  // записанный раньше остаётся как был
  for (const s of skipped)
    result.warnings.push(`пропущен сервер ${s.name} — ${[
      ...(s.vars.length ? [`не заданы переменные ${s.vars.join(", ")} (local/secrets.env или local/machine.yaml)`] : []),
      ...(s.why ? [s.why] : []),
    ].join("; ")}`);
  if (kept.length) result.keep = kept.map((s) => s.name);
  else delete result.keep;
  // Файлы секретов, нужные конфигам цели, — по доставленному серверу: записанные сейчас (их ссылки) и
  // оставленные keep-ом (зависимости их записанной версии из учёта: новое определение могло сменить
  // имя секрета). Учёт до 2г-2 зависимостей по серверам не знал — тогда прежние секреты цели целиком
  const servers: Record<string, string[]> = { ...serverUses };
  for (const s of kept) {
    const was = prev?.servers ? prev.servers[s.name] : prev?.secrets;
    if (was?.length) servers[s.name] = was;
  }
  const names = new Set([...usedSecrets, ...Object.values(servers).flat()]);
  if (names.size) result.secrets = [...names].sort();
  if (Object.keys(servers).length) result.servers = servers;
  return { result, cfg: team.cfg, missing, skipped };
}

// env у HTTP-сервера агент не передаёт никому (удалённому серверу переменные не нужны); мост берёт
// из него только прокси/TLS. Секрет в таком env — пропуск сервера (vars.ts), без секрета — предупреждение
export function httpEnvWarnings(cfg: Resolved, adapter: Adapter): string[] {
  return cfg.mcp.filter(({ item }) => item.url && item.env && item.agents?.[adapter.id] !== "skip").flatMap(({ item }) => {
    const bridge = adapter.httpSecrets === "bridge" || refsIn(item.url).length > 0;
    const ignored = Object.keys(item.env!).filter((k) => !(bridge && bridgeEnv(k)));
    return ignored.length ? [`mcp ${item.name}: env HTTP-сервера (${ignored.join(", ")}) ${AGENT_NAMES[adapter.id] ?? adapter.id} игнорирует — удалённому серверу переменные окружения не передаются${bridge ? " (мосту — только прокси/TLS)" : ""}`] : [];
  });
}

// Конфликт «уже есть и создан не miksy», а в этом ключе (файле) — значение секрета из local/secrets.env:
// похоже на сервер miksy до фазы 2а без учёта (новая машина, конфиг без manifest). Литерал остаётся в
// конфиге агента, пока ключ не взят под учёт, — подсказка как (в бэкап значение не попадёт).
// where — цель для команды: --global или путь проекта
export function literalHints(actions: Action[], secrets: Record<string, string>, where: string, agent: string): string[] {
  const values = Object.entries(secrets).filter(([, v]) => v.length >= 8);
  const out: string[] = [];
  for (const a of values.length ? actions : []) {
    if (a.kind !== "conflict" || !/создан не miksy|вне владения miksy/.test(a.why)) continue;
    const merge = a.abs.match(/^(.*?) (\[".*"\])\.(.+)$/);
    const toml = merge ? null : a.abs.match(/^(.*) mcp_servers\.(.+)$/);
    let text: string;
    try {
      text = merge ? JSON.stringify([...JSON.parse(merge[2]), merge[3]].reduce((o: any, k) => o?.[k], JSON.parse(readFileSync(merge[1], "utf8"))) ?? "")
        : toml ? JSON.stringify(parseToml(readFileSync(toml[1], "utf8")).mcp_servers?.[toml[2]] ?? "")
        : readFileSync(a.abs, "utf8");
    } catch { continue; }
    const names = values.filter(([, v]) => text.includes(v) || text.includes(JSON.stringify(v).slice(1, -1))).map(([n]) => n);
    if (!names.length) continue;
    const fix = toml && where === "--global" ? `miksy adopt --global ${toml[2]} --to global --agent ${agent}, затем miksy sync --global` : `miksy sync ${where} --agent ${agent} --force`;
    out.push(`${a.abs}: вне учёта, а в нём значение секрета ${names.join(", ")} из local/secrets.env — похоже на сервер miksy до фазы 2а (учёта нет: новая машина, конфиг без manifest). Взять под учёт и заменить обёрткой: ${fix} (в бэкап значение не попадёт)`);
  }
  return out;
}

// Секрет в args stdio-сервера: обёртка передаёт значение в argv сервера — его видит список процессов
export function argSecretWarnings(cfg: Resolved, agent: string): string[] {
  return cfg.mcp.filter(({ item }) => item.command && !item.url && item.agents?.[agent] !== "skip" && (item.args ?? []).some((x) => refsIn(x).length))
    .map(({ item }) => `mcp ${item.name}: секрет передаётся аргументом — значение видно в списке процессов (ps) другим пользователям машины; лучше env`);
}

// Учитываем только полностью доставленные skills; конфликт одного файла оставляет opencode свою копию.
export function deliveredSkillNames(result: RenderResult, actions: Action[], target: Target): string[] {
  if (target.scope !== "project") return [];
  const groups = new Map<string, string[]>();
  for (const f of result.files) {
    const m = f.base === "project" && f.path.match(/^\.(?:claude|agents)\/skills\/([^/]+)\//);
    if (m) groups.set(m[1], [...(groups.get(m[1]) ?? []), pathKey(join(target.dir, f.path))]);
  }
  return [...groups].filter(([, paths]) => paths.some((p) => p.endsWith("/SKILL.md")) && !actions.some((a) => a.kind === "conflict" && paths.includes(pathKey(a.abs))))
    .map(([name]) => name);
}

// Skills, которые в каталоге цели уже доставил другой агент (по учёту: SKILL.md в .claude/skills или
// .agents/skills записан и не изменён) — opencode их видит сам, своя копия была бы дублем. except —
// агенты этого запуска: их доставку дают результаты запуска (deliveredSkillNames)
export function ledgerSkills(manifest: Manifest, dir: string, except: Set<string>): string[] {
  const out = new Set<string>();
  for (const [id, st] of Object.entries(manifest.targets)) {
    const split = id.indexOf("|");
    const root = id.slice(split + 1);
    if (except.has(id.slice(0, split)) || fold(root) !== fold(pathKey(dir))) continue;
    for (const [p, hash] of Object.entries(st.files)) {
      const m = fold(p).startsWith(fold(root) + "/") && p.slice(root.length).match(/^\/\.(?:claude|agents)\/skills\/([^/]+)\/SKILL\.md$/);
      if (!m) continue;
      try { if (sha(readFileSync(p, "utf8")) === hash) out.add(m[1]); } catch {}
    }
  }
  return [...out];
}

// opencode использует результаты доставки остальных адаптеров, независимо от порядка machine.agents.
export const deliveryOrder = (adapters: Adapter[]) => [...adapters].sort((a, b) => Number(a.id === "opencode") - Number(b.id === "opencode"));

// Ни метки ссылки, ни значения секрета в MCP-файлах и скриптах рендера: адаптер, не умеющий
// доставить секрет, должен пропустить сервер, а не записать значение
function assertNoSecret(adapter: Adapter, f: RenderedFile, used: string[], secrets: Record<string, string>) {
  const text = f.mode === "own" ? f.content : JSON.stringify(f.data);
  if (text.includes(SECRET_MARK) || text.includes(JSON.stringify(SECRET_MARK).slice(1, -1)))
    throw new Error(`адаптер ${adapter.id}: в ${f.path} осталась ссылка на секрет — запись цели отменена (ошибка адаптера)`);
  if (f.mode === "own" && !f.mcp && f.base !== "local") return;
  for (const n of used) {
    const v = secrets[n];
    if (v.length >= 8 && (text.includes(v) || text.includes(JSON.stringify(v).slice(1, -1))))
      throw new Error(`адаптер ${adapter.id}: в ${f.path} оказалось значение секрета ${n} — запись цели отменена`);
  }
}

// Учёт с переездами каталогов (src/relocate.ts): перенос — в памяти; sync и clean сохраняют его
// (saveMoves). Цели workspace перечисляются, только если какой-то каталог учёта пропал
// Каталоги под недоступным корнем (диск не подключён) не считаются пропавшими: их не переносят
export function loadManifestMoved(machine: Machine, groups?: Group[]): { manifest: Manifest; moves: Move[]; rootsChanged: boolean } {
  const raw = loadManifest();
  const roots = machineRoots(machine);
  const away = roots.filter((r) => !rootExists(r));
  const exists = (p: string) => existsSync(p) || away.some((r) => inside(p, r.path));
  const moves = findMoves(raw, configRoot(), () =>
    [...(groups ?? listGroups(machine)).map((g) => g.abs), ...allProjects(machine).map((p) => p.abs)].map(pathKey), exists);
  moveDecisions(moves, (dir) => treeOf(dir, roots));
  const manifest = applyMoves(raw, moves);
  // Последний известный настоящий путь доступных корней (по пути, как он записан в machine.yaml):
  // запишется с учётом при первой записи. Нужен, когда корень станет недоступен (src/load.ts: parseRoots)
  // rootsChanged — запомненное разошлось с учётом на диске: sync и clean сохраняют учёт и без других изменений
  const known = roots.filter((r) => r.given && rootExists(r));
  const before = JSON.stringify(manifest.roots ?? {});
  if (known.length) {
    const memo = { ...manifest.roots };
    for (const r of known) memo[rootMemoryKey(r.given!)] = r.path;
    manifest.roots = Object.fromEntries(Object.entries(memo).filter(([k]) => roots.some((r) => r.given && rootMemoryKey(r.given) === k)));
  }
  return { manifest, moves, rootsChanged: JSON.stringify(manifest.roots ?? {}) !== before };
}

// Каталог учёта под недоступным корнем: не «пропал», а недоступен сейчас
export const unavailable = (dir: string, machine: Machine) => machineRoots(machine).some((r) => !rootExists(r) && inside(dir, r.path));

// Каталог цели, до которого не дотянуться: под недоступным корнем или вне всех корней и его нет (после
// root remove не отличить неподключённый диск от удалённых данных). clean убирает достижимое, а учёт
// файлов внутри оставляет — до повторного clean с диском или явного «забыть» (--forget)
export const stranded = (dir: string, machine: Machine) => unavailable(dir, machine) || (outsideRoots(dir, machine) && !existsSync(dir));

// Цели учёта, чей каталог теперь сам корень workspace (root add проекта или цели --yes): записанное туда miksy
// раньше действует, но sync --all его больше не обновляет — корень не проект (рецензия 6x, B3). Цель-группа — не
// здесь: её пометка в этом месте дерева больше не действует, и записанное туда sync --all убирает сам (formerGroups)
export function rootedTargets(manifest: Manifest, machine: Machine): string[] {
  const roots = machineRoots(machine).filter(rootExists);
  const dirOf = (id: string) => id.slice(id.indexOf("|") + 1);
  const groups = new Set(Object.entries(manifest.targets).filter(([, st]) => st.group).map(([id]) => fold(dirOf(id))));
  return [...new Set(Object.keys(manifest.targets).map(dirOf))]
    .filter((d) => d !== "global" && !groups.has(fold(d)) && existsSync(d) && roots.some((r) => rootKey(r.path) === rootKey(d))).sort();
}
// Основной корень: root remove его не убирает, а «добавлен по ошибке» неверно — туда писал miksy sync в самом
// корне (0.1.x) или workspace сменили на бывший проект (микроправка перед 0.2.0)
export const isMainRoot = (dir: string, machine: Machine) => rootKey(machineRoots(machine)[0].path) === rootKey(dir);
export function rootedText(dir: string, machine: Machine): string {
  if (isMainRoot(dir, machine)) return `${dir} — основной корень workspace (папка с проектами), а не проект: miksy раньше записал настройки в сам корень (например, miksy sync в нём в 0.1.x или он был проектом до смены workspace) — CLAUDE.local.md и др. действуют, но больше не обновляются. Убрать записанное: miksy clean "${dir}"`;
  const outer = machineRoots(machine).find((r) => rootKey(r.path) !== rootKey(dir) && inside(dir, r.path));
  return `${dir} — теперь корень workspace (папка с проектами), а не проект: записанное туда miksy раньше (CLAUDE.local.md и др.) действует, но больше не обновляется. Корень добавлен по ошибке — miksy root remove "${dir}"${outer ? ` (записанное останется; следующий miksy sync --all снова обновит его как проект корня ${outer.path})` : ""}; так и задумано — убрать записанное: miksy clean "${dir}"`;
}

export const movesText = (moves: Move[]) => moves.map((m) => `  ${m.from} → ${m.to}  (${HOW[m.how]})`);

export function saveMoves(manifest: Manifest, moves: Move[]) {
  if (!moves.length) return;
  saveManifest(manifest);
  saveMovedDecisions();
}

// Каталог из учёта, которого больше нет (удалён или переехал и не найден): clean <прежний путь>
// убирает записанное вне него (ключи MCP, доверие, обёртки) и его записи учёта
// Так же — каталог, который есть, но вне всех корней workspace (корень убран из machine.yaml): sync его
// больше не обновляет, а clean <путь> убирает записанное по учёту
export function vanishedTarget(path: string, manifest: Manifest, machine: Machine): TargetSpec | null {
  const abs = trimSlash(slash(resolve(process.cwd(), driveRoot(path))));
  if (existsSync(abs) && !outsideRoots(pathKey(abs), machine)) return null;
  // Каталог — в написании учёта: путь, набранный в другом регистре (Windows, macOS), — та же цель,
  // а учёт и записи внутри (splitState) сравниваются по написанию учёта
  const typed = fold(pathKey(abs));
  // Путь через корень, как он записан в machine.yaml, когда корень — ссылка (junction, симлинк) в никуда: учёт
  // знает каталог по пути назначения, запомненному при последней записи (src/load.ts: parseRoots)
  const via = machineRoots(machine).flatMap((r) => {
    if (!r.given) return [];
    const given = rootMemoryKey(r.given);
    return fold(r.path) !== given && inside(typed, given) ? [fold(trimSlash(slash(join(r.path, relative(given, typed)))))] : [];
  });
  const id = Object.keys(manifest.targets).find((id) => [typed, ...via].includes(fold(id.slice(id.indexOf("|") + 1))));
  if (!id) return null;
  const key = id.slice(id.indexOf("|") + 1);
  return formerTarget({ dir: key, rel: treeOf(key, machineRoots(machine)) });
}
