import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { canonical, child, fold, homeDir, inside, sameKey, samePath, slash, driveRoot, expandHome, treeSlash, trimSlash } from "./paths";
import { nakedInText, nakedSecrets, skillFileKind, textFile } from "./secrets";
import { gitSpawn } from "./git";
import { agentId } from "./agentid";
import { innerRoots, locate, type Root, rootExists, rootKey, treeAbove, treeJoin } from "./roots";
import type { MiksyMap, Instruction, Layer, Machine, McpServer, Os, Skill } from "./types";
import { check, distance, LAYER_FORM, MACHINE_FORM, MAP_FORM, mapNotes, MCP_FORM, mcpKind, type Field, type Finding } from "./schema";

// Движок (этот код) и конфигурация пользователя (layers/, map.yaml, local/) живут отдельно:
// движком можно делиться, конфигурация — личная.
export const ENGINE = canonical(join(import.meta.dir, ".."));

export const hasConfig = (dir: string) => existsSync(join(dir, "map.yaml"));

// Где конфигурация: MIKSY_CONFIG → путь из файла ~/.miksy → соседний каталог miksy-config →
// сам движок (всё в одном репо). engine — другой каталог движка (мастер setup в тестах)
export function findConfig(engine = ENGINE): string {
  const env = process.env.MIKSY_CONFIG;
  if (env) return env;
  const pointer = join(homeDir(), ".miksy");
  if (existsSync(pointer)) {
    const p = readFileSync(pointer, "utf8").trim();
    if (p) return p;
  }
  const sibling = join(engine, "..", "miksy-config");
  if (hasConfig(sibling)) return sibling;
  return engine;
}

// Корень конфигурации: слои, map.yaml, local/ (настройки машины, секреты, учёт, бэкапы).
// Вычисляется при каждом обращении, а не при импорте: MIKSY_CONFIG, заданный позже
// (тесты, вложенный вызов), действует сразу
export const configRoot = (): string => canonical(expandHome(findConfig(), homeDir()));

// YAML с BOM в начале (Set-Content -Encoding utf8 в PowerShell 5.1, Блокнот) — как без него: иначе
// первый ключ получает невидимый префикс («нет поля name»)
export const parseYaml = (text: string): unknown => Bun.YAML.parse(text.replace(/^﻿/, ""));

function yaml<T>(path: string): T {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new Error(code === "ENOENT" ? `${path}: файла нет — это каталог конфигурации miksy? (MIKSY_CONFIG, ~/.miksy; новая — miksy setup)` : `${path}: не читается (${code ?? "ошибка"})`);
  }
  try { return parseYaml(text) as T; }
  catch { throw new Error(`${path}: YAML не разбирается; проверьте синтаксис (содержимое не выводится)`); }
}


// ---- Проверка формы файлов настроек (круг 12f, src/schema.ts) ----
// Ошибки формы файлов, прочитанных командой. Без «ворот» загрузчик бросает сразу (adopt, target, mcp off …). sync,
// explain открывают ворота (collect): загрузчики копят ошибки всех прочитанных файлов, команда до записи бросает их
// одним блоком (gateCheck в src/commands.ts). doctor и clean — ignore: ошибки не останавливают (doctor показывает их
// сам, clean должен убирать записанное и при сломанной конфигурации), загрузчик отдаёт файл без ключей с ошибками
export class ConfigError extends Error {}
export const configErrorText = (lines: string[]) =>
  `ошибки в настройках miksy — ничего не записано. Исправьте эти строки в файлах вручную и повторите:\n${lines.map((l) => "  " + l).join("\n")}`;
let gate: { mode: "collect" | "ignore"; errors: Map<string, string[]>; read: Set<string> } | null = null;
export function openGate(mode: "collect" | "ignore") { gate = { mode, errors: new Map(), read: new Set() }; }
// Вложенный запуск команды (план setup/update — sync --dry-run): свои ворота, по выходе — ворота внешней
export function swapGate(next: unknown = null): unknown {
  const old = gate;
  gate = next as typeof gate;
  return old;
}
// Закрыть ворота: ошибки прочитанных файлов и сами файлы (от корня конфигурации)
export function closeGate(): { errors: string[]; read: Set<string> } {
  const g = gate;
  gate = null;
  return { errors: g ? [...g.errors.values()].flat() : [], read: g?.read ?? new Set() };
}
// Путь файла от корня конфигурации («layers/tree/Acme/layer.yaml», «local/machine.yaml»); вне её — как есть
export function configRel(path: string, root = configRoot()): string {
  const p = slash(path);
  return inside(p, slash(root)) ? slash(relative(root, path)) : p;
}
// read — файл прочитан командой целиком (его ошибки — её); treeGroups читает из слоя только target
function report(file: string, findings: Finding[], read = true) {
  if (read) gate?.read.add(file);
  if (!findings.length) return;
  const lines = findings.map((e) => `${file}: ${e.text}`);
  if (!gate) throw new ConfigError(configErrorText(lines));
  gate.errors.set(file, [...new Set([...(gate.errors.get(file) ?? []), ...lines])]);
}
// Документ файла по форме: ошибки — в report, в ответ — документ без ключей с ошибками
function checked<T>(doc: unknown, form: Field, file: string, extra: Finding[] = []): T {
  const c = check(doc, form);
  report(file, [...c.errors, ...extra]);
  return c.value as T;
}
// Обход слоёв ради справки (все MCP, широкие skill_secrets): не чтение командой — ворота его не видят, а ошибки
// слоя ловит сам обход
function ungated<T>(fn: () => T): T {
  const g = gate;
  gate = null;
  try { return fn(); } finally { gate = g; }
}

export function currentOs(): Os {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "linux";
}

export function loadMachine(root = configRoot()): Machine {
  const path = join(root, "local", "machine.yaml");
  if (!existsSync(path)) throw new Error(`Нет ${path}. Машина ещё не настроена — запусти: bun src/cli.ts setup`);
  // Форма (vars, agents, trust, mcp_off) — src/schema.ts; workspace разбирает parseRoots
  const m = checked<{ workspace?: unknown; vars?: Record<string, unknown>; agents?: string[]; trust?: Machine["trust"]; mcp_off?: string[] }>(yaml(path), MACHINE_FORM(), configRel(path, root));
  const roots = parseRoots(m.workspace, slash(path), ledgerRoots(root));
  return {
    workspace: roots[0].path,
    roots,
    os: currentOs(),
    home: slash(homeDir()),
    vars: Object.fromEntries(Object.entries(m.vars ?? {}).map(([k, v]) => [k, String(v)])),
    // Прежние имена агентов (gemini) — синонимы
    ...(m.agents && { agents: [...new Set(m.agents.map(agentId))] }),
    ...(m.trust && { trust: m.trust }),
    ...(Array.isArray(m.mcp_off) && m.mcp_off.length && { mcpOff: [...new Set(m.mcp_off as string[])] }),
  };
}

// Место корня в дереве слоёв: имена каталогов через «/» — без .., «.», дисков и имён частей слоя
export function checkTree(tree: string): string | null {
  const t = treeSlash(tree).trim().replace(/^\/+|\/+$/g, "");
  if (/^[A-Za-z]:/.test(t) || t.split("/").some((s) => s === "." || s === ".." || (t && !s) || LAYER_PARTS.has(s.toLowerCase())))
    return null;
  return t;
}

// Что учёт помнит о корнях (local/state/manifest.json): последний известный настоящий путь каждого корня
// (корень-ссылка: учёт его целей — по пути назначения) и каталоги целей. Нужно, только если корень
// недоступен или пуст; учёт не читается или повреждён — помнить нечего (ошибку покажут sync и doctor)
export type LedgerRoots = { real: (key: string) => string | undefined; hasTargets: (dir: string) => boolean };
export function ledgerRoots(root = configRoot()): LedgerRoots {
  let doc: { roots?: unknown; targets?: unknown } | null | undefined;
  const read = () => {
    if (doc === undefined) {
      try { doc = JSON.parse(readFileSync(join(root, "local", "state", "manifest.json"), "utf8")); }
      catch { doc = null; }
    }
    return doc;
  };
  return {
    real: (key) => { const r = read()?.roots; const v = r && typeof r === "object" ? (r as Record<string, unknown>)[key] : undefined; return typeof v === "string" ? v : undefined; },
    hasTargets: (dir) => { const t = read()?.targets; return !!t && typeof t === "object" && Object.keys(t).some((id) => { const d = id.slice(id.indexOf("|") + 1); return d !== "global" && inside(d, dir); }); },
  };
}

// Ключ корня в учёте (manifest.roots): путь, как он записан в machine.yaml, без раскрытия ссылок
export const rootMemoryKey = (given: string) => fold(trimSlash(slash(resolve(driveRoot(expandHome(given, homeDir()))))));

// Каталог без видимых записей (скрытые — .DS_Store и т. п. — не в счёт); не читается — не пуст
const emptyDir = (dir: string) => { try { return !readdirSync(dir).some((n) => !n.startsWith(".")); } catch { return false; } };

// Каталог, где только точки монтирования дисков: корень ФС, /Volumes (macOS), /mnt, /media и /media/<пользователь>
// (Ubuntu), /run/media/<пользователь> (Fedora и др.) — ближайший существующий предок корня здесь: диск не подключён
export const mountParent = (dir: string) => /^(\/|\/Volumes|\/mnt|\/media(\/[^/]+)?|\/run\/media(\/[^/]+)?)$/.test(dir);

// Почему корень недоступен: нет даже корня диска — «нет диска»; путь не раскрывается (ссылка или junction
// на пропавший каталог) — «ссылка ведёт в никуда»; каталога нет; не каталог. null — доступен
export function rootAway(given: string): { path: string; away?: string } {
  const plain = trimSlash(slash(resolve(driveRoot(given))));
  const exists = (p: string) => { try { lstatSync(p); return true; } catch { return false; } };
  // Ближайший существующий предок: нет даже корня диска (Windows) или есть только корень файловой
  // системы либо каталог точек монтирования (/Volumes, /mnt, /media) — не подключён диск (том)
  let near = plain;
  while (!exists(near) && slash(dirname(near)) !== near) near = slash(dirname(near));
  if (!exists(near) || (near !== plain && mountParent(near)))
    return { path: plain, away: "нет диска" };
  let path: string;
  try { path = canonical(plain); }
  catch (e) {
    return { path: plain, away: /нет доступа|цикл/.test((e as Error).message) ? (e as Error).message.replace(/^.*?: /, "") : "ссылка ведёт в никуда" };
  }
  try { if (!statSync(path).isDirectory()) return { path, away: "это не каталог" }; }
  catch { return { path, away: "каталога нет" }; }
  return { path };
}

// workspace в machine.yaml: строка (один корень в корне дерева) или список — путь либо { path, tree }.
// У дополнительных корней раздел дерева (tree) обязателен и у всех корней — свой: иначе правила одного
// раздела молча доставались бы папкам с тем же именем в другом корне. Один каталог дважды (повтор,
// junction, симлинк) — ошибка: сравниваются настоящие пути. Недоступный корень (нет диска, ссылка в
// никуда, каталога нет; пуст, а в учёте есть его цели — точка монтирования без диска) — не ошибка: away,
// путь — последний известный настоящий из учёта (memory), иначе как записан
export function parseRoots(value: unknown, file: string, memory?: LedgerRoots): Root[] {
  const usage = `${file}: workspace — путь или список корней: путь, либо { path: <путь>, tree: <раздел дерева слоёв, например Clients> }`;
  if (value === undefined || value === null || value === "") throw new Error(`${file}: не задан workspace`);
  const items: unknown[] = typeof value === "string" ? [value] : Array.isArray(value) && value.length ? value : (() => { throw new Error(usage); })();
  const roots: (Root & { given: string })[] = [];
  for (const [i, it] of items.entries()) {
    const raw = typeof it === "string" ? { path: it } : it && typeof it === "object" && !Array.isArray(it) ? (it as Record<string, unknown>) : null;
    if (!raw || typeof raw.path !== "string" || !raw.path.trim() || Object.keys(raw).some((k) => k !== "path" && k !== "tree") || (raw.tree !== undefined && raw.tree !== null && typeof raw.tree !== "string"))
      throw new Error(usage);
    const given = raw.path.trim();
    const tree = checkTree(typeof raw.tree === "string" ? raw.tree : "");
    if (tree === null)
      throw new Error(`${file}: tree «${raw.tree}» корня ${given} — раздел дерева слоёв: имена каталогов через «/» (например, Clients), без «..», дисков и имён ${[...LAYER_PARTS].join(", ")}`);
    if (i > 0 && !tree)
      throw new Error(`${file}: у корня ${given} не указан раздел дерева слоёв — укажите: { path: ${JSON.stringify(given)}, tree: <раздел, например Clients> }. У дополнительных корней раздел обязателен: без него правила основного корня молча доставались бы папкам с теми же именами`);
    const busy = roots.find((r) => tree && r.tree.toLowerCase() === tree.toLowerCase());
    if (busy) throw new Error(`${file}: tree: ${tree} уже у корня ${busy.given} — выберите корню ${given} другое имя раздела (общие правила для нескольких корней — слоем в map.yaml, docs/roots.md, «Правила нескольких корней»)`);
    const expanded = expandHome(given, homeDir());
    let { path, away } = rootAway(expanded);
    if (!away && memory && emptyDir(path) && memory.hasTargets(path)) away = "пуст, а в учёте есть его цели — диск не смонтирован?";
    if (away) path = memory?.real(rootMemoryKey(given)) ?? path;
    const twin = roots.find((r) => rootKey(r.path) === rootKey(path));
    if (twin) throw new Error(`${file}: корень ${path} указан дважды (${twin.given} и ${given} — один и тот же каталог: повтор, junction или симлинк). Оставьте одну запись`);
    roots.push({ path, tree, given, ...(away && { away }) });
  }
  return roots;
}

export function loadSecrets(root = configRoot()): Record<string, string> {
  const path = join(root, "local", "secrets.env");
  if (!existsSync(path)) return {};
  return parseEnv(readFileSync(path, "utf8"));
}

// Формат secrets.env (как у dotenv): ИМЯ=значение; необязательный export; # в начале строки и
// « #» после значения без кавычек — комментарий; "…" — с экранированием \n \r \" \\ (так пишет
// adopt), '…' — как есть; пустое значение — заданная переменная со значением ""
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const raw = m[2];
    const dq = raw.match(/^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/);
    const sq = raw.match(/^'([^']*)'\s*(?:#.*)?$/);
    if (dq) out[m[1]] = dq[1].replace(/\\(.)/g, (whole, c: string) => (c === "n" ? "\n" : c === "r" ? "\r" : c === '"' || c === "\\" ? c : whole));
    else if (sq) out[m[1]] = sq[1];
    else out[m[1]] = raw.replace(/(^|\s)#.*$/, "").trim();
  }
  return out;
}

export function loadMap(root = configRoot()): MiksyMap {
  const path = join(root, "map.yaml");
  // Форма — src/schema.ts (MAP_FORM)
  const m = checked<Partial<MiksyMap> & { skill_prefix?: string; tools?: MiksyMap["tools"] }>(yaml(path), MAP_FORM(), configRel(path, root));
  return { global: m.global ?? [], layers: m.layers ?? [],
    ...(m.skill_prefix !== undefined && { skillPrefix: m.skill_prefix }),
    ...(m.tools !== undefined && { tools: m.tools }) };
}

const listDir = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);

export function loadLayer(name: string, root = configRoot()): Layer {
  const dir = join(root, "layers", name);
  if (!existsSync(dir)) throw new Error(`Слой «${name}» упомянут в map.yaml, но каталога ${dir} нет`);
  return loadLayerDir(dir, name);
}

// Имена содержимого слоя — не могут быть именами организаций/проектов в дереве
export const LAYER_PARTS = new Set(["instructions", "mcp", "skills", "hooks", "policies"]);
// Зарезервированы, но miksy их не читает (не реализовано): каталог делает слоем, содержимое — нет
export const UNREAD_PARTS = ["hooks", "policies"];

// Каталоги hooks/ и policies/ в слоях — пути от конфигурации: для предупреждения sync и doctor
export function ignoredLayerParts(root = configRoot()): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory()) continue;
      if (UNREAD_PARTS.includes(e.name)) out.push(slash(relative(root, join(dir, e.name))));
      else if (!["instructions", "mcp", "skills"].includes(e.name)) walk(join(dir, e.name));
    }
  };
  walk(join(root, "layers"));
  return out;
}
export const ignoredText = (paths: string[]) =>
  `${paths.join(", ")}: каталоги hooks/ и policies/ miksy не читает (не реализовано) — агенты их содержимое не получат`;

const hasContent = (dir: string) =>
  existsSync(join(dir, "layer.yaml")) || [...LAYER_PARTS].some((p) => existsSync(join(dir, p)));

// Слои-дерево: layers/tree повторяет workspace. Корень — общий слой всех проектов,
// каталог Org/Team — слой для всего внутри workspace/Org/Team. Имена — без учёта регистра.
export function treeLayers(rel: string, root = configRoot()): Layer[] {
  const base = join(root, "layers", "tree");
  if (!existsSync(base)) return [];
  const out: Layer[] = hasContent(base) ? [loadLayerDir(base, "workspace")] : [];
  let dir = base;
  let name = "";
  for (const seg of rel ? rel.split("/") : []) {
    const hit = readdirSync(dir, { withFileTypes: true })
      .find((e) => e.isDirectory() && !LAYER_PARTS.has(e.name) && e.name.toLowerCase() === seg.toLowerCase());
    if (!hit) break;
    dir = join(dir, hit.name);
    name = name ? `${name}/${hit.name}` : hit.name;
    if (hasContent(dir)) out.push(loadLayerDir(dir, name));
  }
  return out;
}

// Каталоги дерева слоёв, которые отличаются только регистром (бывает на ФС с учётом регистра — Linux): применяется
// один — первый в порядке каталога, как его находят treeLayers и adopt (проверка 7a выпуска 0.2.1, B №2)
export function caseTwins(root = configRoot()): { names: string[]; used: string }[] {
  const out: { names: string[]; used: string }[] = [];
  const walk = (dir: string, rel: string) => {
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !LAYER_PARTS.has(e.name)); } catch { return; }
    const groups = new Map<string, string[]>();
    for (const e of entries) groups.set(e.name.toLowerCase(), [...(groups.get(e.name.toLowerCase()) ?? []), e.name]);
    for (const names of groups.values()) if (names.length > 1) out.push({ names: names.map((n) => rel + n), used: rel + names[0] });
    for (const e of entries) walk(join(dir, e.name), `${rel}${e.name}/`);
  };
  walk(join(root, "layers", "tree"), "");
  return out;
}

// Похожие имена каталогов — вероятная опечатка (расстояние Левенштейна — src/schema.ts)
const similar = (a: string, b: string) => {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  if (x === y) return false;
  if (Math.min(x.length, y.length) >= 3 && (x.includes(y) || y.includes(x))) return true;
  return Math.min(x.length, y.length) >= 4 && distance(x, y) <= 2;
};

// Корни из строки workspace (один корень в корне дерева) или готовый список
const asRoots = (workspace: string | Root[]): Root[] => (typeof workspace === "string" ? [{ path: slash(realpathSync.native(workspace)), tree: "" }] : workspace);

// Слои дерева, которые на этой машине ни к чему не применяются (нет такого каталога ни в одном корне).
// Проверяется только та часть дерева, куда смонтированы корни этой машины: раздел, над которым нет
// корня, — unmounted (для другой машины, не опечатка); часть недоступного корня (диск не подключён) не
// проверяется. Раздел без своего каталога сообщается один раз — его вложенные слои не перечисляются.
// suggestion — похожий каталог на том же уровне: вероятная опечатка или переименование. other — раздел верхнего
// уровня дерева (под основным корнем без tree): он может быть и разделом корня другой машины ({ path, tree: <раздел> }
// в её machine.yaml) — отсюда не отличить (рецензия 6x, B4)
export function orphanTreeDirs(workspace: string | Root[], root = configRoot()): { path: string; suggestion?: string; unmounted?: true; other?: true }[] {
  const roots = asRoots(workspace);
  const base = join(root, "layers", "tree");
  const out: { path: string; suggestion?: string; unmounted?: true; other?: true }[] = [];
  if (!existsSync(base)) return out;
  type Here = { dir: string; root: Root };
  const sameTree = (a: string, b: string) => treeAbove(a, b) && treeAbove(b, a);
  const mountsAt = (t: string) => roots.filter((r) => sameTree(r.tree, t));
  // Место строго выше места какого-то корня: ниже него есть смонтированное
  const aboveMount = (t: string) => roots.some((r) => treeAbove(t, r.tree) && !sameTree(t, r.tree));
  const live = (rs: Root[]): Here[] => rs.filter(rootExists).map((r) => ({ dir: r.path, root: r }));
  // Подкаталоги каталога корня — без вложенных корней (у них своё место в дереве)
  const childNames = (h: Here) => {
    const inner = new Set(innerRoots(h.root, roots).map((r) => rootKey(r.path)));
    try { return readdirSync(h.dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !inner.has(rootKey(child(h.dir, e.name)))).map((e) => e.name); }
    catch { return []; }
  };
  // covered — место под каким-то корнем; quiet — под недоступным корнем (не проверяется)
  const walk = (layerDir: string, rel: string, here: Here[], covered: boolean, quiet: boolean) => {
    const names = here.map((h) => ({ h, names: childNames(h) }));
    // По имени: порядок readdir зависит от файловой системы (на Linux — не алфавитный), вывод doctor — нет
    const entries = readdirSync(layerDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (!e.isDirectory() || LAYER_PARTS.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const mounts = mountsAt(r);
      const next: Here[] = [
        ...names.flatMap(({ h, names: n }) => { const m = n.find((x) => x.toLowerCase() === e.name.toLowerCase()); return m ? [{ dir: child(h.dir, m), root: h.root }] : []; }),
        ...live(mounts),
      ];
      const mutedHere = quiet || mounts.some((m) => !rootExists(m));
      if (next.length) { walk(join(layerDir, e.name), r, next, covered || mounts.length > 0, mutedHere); continue; }
      if (mounts.length) continue; // корень этого места недоступен — его часть не проверяется
      if (aboveMount(r)) { walk(join(layerDir, e.name), r, [], covered, quiet); continue; }
      if (!covered) { out.push({ path: r, unmounted: true }); continue; }
      if (quiet) continue;
      const near = names.flatMap((x) => x.names).find((n) => similar(n, e.name));
      out.push({ path: r, ...(near && { suggestion: rel ? `${rel}/${near}` : near }), ...(near && !rel && { other: true as const }) });
    }
  };
  const top = mountsAt("");
  walk(base, "", live(top), top.length > 0, top.some((m) => !rootExists(m)));
  return out;
}

// Все определения MCP-серверов во всех слоях конфигурации (каталоги с mcp/), в том числе не подключённых в map.yaml:
// для miksy mcp off/on и doctor — есть ли имя где-нибудь в слоях. Слой не читается — пропускается (ошибку покажет sync)
export function allLayerMcp(root = configRoot()): McpServer[] {
  return ungated(() => allMcp(root));
}
function allMcp(root: string): McpServer[] {
  const out: McpServer[] = [];
  const walk = (dir: string) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.isDirectory() && e.name === "mcp")) {
      try { out.push(...loadLayerDir(dir, slash(relative(join(root, "layers"), dir)) || "layers").mcp); } catch { /* битый слой */ }
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name)))
      if (e.isDirectory() && !LAYER_PARTS.has(e.name)) walk(join(dir, e.name));
  };
  walk(join(root, "layers"));
  return out;
}

export function loadLayerDir(dir: string, name: string): Layer {
  const metaPath = join(dir, "layer.yaml");
  // Форма — src/schema.ts (LAYER_FORM); ключи с ошибками в meta не попадают
  const meta = existsSync(metaPath)
    ? checked<{ description?: unknown; exclude?: string[]; import_skills?: Layer["importSkills"]; trust?: Layer["trust"]; target?: boolean; skill_secrets?: string[] }>(yaml(metaPath), LAYER_FORM(), configRel(metaPath))
    : {};
  const skillSecrets = [...new Set(meta.skill_secrets ?? [])];
  const imp = meta.import_skills;

  const instructions: Instruction[] = listDir(join(dir, "instructions"))
    .filter((f) => f.endsWith(".md"))
    .map((file) => ({ file, path: join(dir, "instructions", file) }));

  const skills: Skill[] = listDir(join(dir, "skills"))
    .filter((s) => existsSync(join(dir, "skills", s, "SKILL.md")))
    .map((s) => ({ name: s, dir: join(dir, "skills", s) }));

  const mcp: McpServer[] = listDir(join(dir, "mcp"))
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .flatMap((f) => {
      // Форма — src/schema.ts (MCP_FORM) и ровно одно из command и url; сервер с ошибкой не берётся (команда с воротами
      // откажет до записи, doctor и clean — без него)
      const doc = yaml<unknown>(join(dir, "mcp", f));
      const c = check(doc, MCP_FORM());
      const kind = doc && typeof doc === "object" && !Array.isArray(doc) ? mcpKind(doc as Record<string, unknown>) : null;
      const errors = [...c.errors, ...(kind ? [kind] : [])];
      report(configRel(join(dir, "mcp", f)), errors);
      if (errors.length) return [];
      const s = c.value as McpServer & { os?: Os | Os[] };
      s.name = String(s.name);
      // os строкой — как список из одной ОС
      if (typeof s.os === "string") s.os = [s.os];
      // Прежнее имя агента (agents: { gemini: … }) — синоним; заданное новым именем важнее
      if (s.agents && typeof s.agents === "object" && Object.keys(s.agents).some((k) => agentId(k) !== k))
        s.agents = Object.fromEntries(Object.entries(s.agents).sort(([a], [b]) => Number(agentId(a) === a) - Number(agentId(b) === b)).map(([k, v]) => [agentId(k), v]));
      return [s as McpServer];
    });

  return { name, dir, ...(meta.description !== undefined && { description: String(meta.description) }), exclude: meta.exclude ?? [], importSkills: imp,
    ...(meta.trust !== undefined && { trust: meta.trust as Layer["trust"] }), ...(meta.target === true && { target: true }), ...(skillSecrets.length && { skillSecrets }), instructions, skills, mcp };
}

// Все файлы настроек по форме (src/schema.ts): map.yaml, local/machine.yaml, все layer.yaml и mcp/*.yaml в layers/ (в
// том числе слоёв, не подключённых на этой машине). errors — по файлам (от корня конфигурации); unknown — неизвестные
// ключи «файл: путь ключа (может быть, …?)»; soft — замечания без отказа. Файл, который не разбирается как YAML, — в
// errors (сам разбор бросает загрузчик). Для doctor (всё), sync и explain (ошибки файлов, которые команда не читает, —
// предупреждением) и предупреждения о неизвестных ключах
export type ConfigScan = { errors: Map<string, string[]>; unknown: string[]; soft: string[] };
export function configScan(root = configRoot()): ConfigScan {
  const out: ConfigScan = { errors: new Map(), unknown: [], soft: [] };
  const file = (path: string, form: () => Field, more?: (doc: Record<string, unknown>) => { errors?: Finding[]; soft?: Finding[] }) => {
    if (!existsSync(path)) return;
    const rel = configRel(path, root);
    let doc: unknown;
    try { doc = parseYaml(readFileSync(path, "utf8")); }
    catch { out.errors.set(rel, [`${rel}: YAML не разбирается; проверьте синтаксис (содержимое не выводится)`]); return; }
    const c = check(doc, form());
    const x = doc && typeof doc === "object" && !Array.isArray(doc) && more ? more(doc as Record<string, unknown>) : {};
    const errors = [...c.errors, ...(x.errors ?? [])];
    if (errors.length) out.errors.set(rel, errors.map((e) => `${rel}: ${e.text}`));
    out.unknown.push(...c.unknown.map((e) => `${rel}: ${e.text}`));
    out.soft.push(...[...c.soft, ...(x.soft ?? [])].map((e) => `${rel}: ${e.text}`));
  };
  file(join(root, "map.yaml"), MAP_FORM, (d) => ({ soft: mapNotes(d) }));
  file(join(root, "local", "machine.yaml"), MACHINE_FORM);
  const walk = (dir: string) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isFile() && e.name === "layer.yaml") file(join(dir, e.name), LAYER_FORM);
      else if (e.isDirectory() && e.name === "mcp") {
        let defs: string[] = [];
        try { defs = readdirSync(join(dir, e.name)).filter((f) => /\.ya?ml$/.test(f)).sort(); } catch { /* нет доступа */ }
        for (const f of defs) file(join(dir, e.name, f), MCP_FORM, (d) => { const k = mcpKind(d); return { errors: k ? [k] : [] }; });
      } else if (e.isDirectory() && !LAYER_PARTS.has(e.name)) walk(join(dir, e.name));
    }
  };
  walk(join(root, "layers"));
  return out;
}
// Неизвестные ключи всех файлов настроек: «файл: путь ключа» (с подсказкой похожего имени)
export const unknownKeys = (root = configRoot()): string[] => configScan(root).unknown;
export const UNKNOWN_KEYS = "неизвестные ключи — miksy их не читает (опечатка или ключ более новой версии miksy)";
export const OTHER_ERRORS = "ошибки в файлах настроек, которые эта команда не читает, — исправьте, иначе откажет sync, которому они нужны (например, sync --all)";


// Прежние имена агентов в конфигурации (gemini — теперь antigravity): работают как синонимы, doctor
// подсказывает переименовать. local/machine.yaml (agents) и agents: в MCP слоёв — «файл: где — было → стало»
export function legacyAgentNames(root = configRoot()): string[] {
  const out: string[] = [];
  const read = (path: string): unknown => { try { return parseYaml(readFileSync(path, "utf8")); } catch { return null; } };
  const machine = read(join(root, "local", "machine.yaml")) as { agents?: unknown } | null;
  if (Array.isArray(machine?.agents))
    for (const a of machine.agents) if (typeof a === "string" && agentId(a) !== a) out.push(`local/machine.yaml: agents — ${a} → ${agentId(a)}`);
  const walk = (dir: string) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory() || e.name === "instructions" || e.name === "skills") continue;
      if (e.name !== "mcp") { walk(join(dir, e.name)); continue; }
      for (const f of readdirSync(join(dir, e.name)).filter((x) => /\.ya?ml$/.test(x)).sort()) {
        const s = read(join(dir, e.name, f)) as { agents?: unknown } | null;
        if (s?.agents && typeof s.agents === "object")
          for (const k of Object.keys(s.agents)) if (agentId(k) !== k) out.push(`${slash(relative(root, join(dir, e.name, f)))}: agents.${k} → agents.${agentId(k)}`);
      }
    }
  };
  walk(join(root, "layers"));
  return out;
}

// skill_secrets в layer.yaml: имена секретов из local/secrets.env, которые skills этого места получают через
// miksy secret (круг 11k) — список имён переменных
export function checkSkillSecrets(v: unknown, where: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(x)))
    throw new Error(`${where}: skill_secrets — список имён секретов из local/secrets.env, например [ACME_TOKEN]`);
  return [...new Set(v as string[])];
}

// Привязки map.yaml (layers: [{ use, match }]) с match шире одной организации (шаблон в первой части пути: *, **, ?, […],
// {…}), чей слой объявляет skill_secrets: эти имена получат skills всех подходящих организаций — как из global (круг 11l).
// Строка «map.yaml: layers[i] (match: …) → слой: имена»; битая карта или слой — пропуск (ошибку покажет загрузка)
export function wideSkillSecrets(root = configRoot()): string[] {
  return ungated(() => wide(root));
}
function wide(root: string): string[] {
  const out: string[] = [];
  let map: MiksyMap;
  try { map = loadMap(root); } catch { return out; }
  map.layers.forEach((e, i) => {
    if (typeof e?.match !== "string" || !/[*?[{]/.test(e.match.split("/")[0])) return;
    try {
      const names = loadLayer(e.use, root).skillSecrets ?? [];
      if (names.length) out.push(`map.yaml: layers[${i}] (match: ${e.match}) → слой ${e.use}: ${names.join(", ")}`);
    } catch { /* покажет загрузка */ }
  });
  return out;
}
export const WIDE_SKILL_SECRETS = "skill_secrets в слое привязки map.yaml с match шире одной организации — эти секреты miksy secret выдаст skills всех подходящих организаций, как из global; объявите их в слое организации (layers/tree/<организация>/layer.yaml)";

// Все объявления skill_secrets в слоях конфигурации: файл layer.yaml (от конфигурации) и имя — для doctor (объявлен, а
// значения в local/secrets.env нет). Ошибки разбора здесь не важны — их покажет загрузка слоя
export function declaredSkillSecrets(root = configRoot()): { file: string; name: string }[] {
  const out: { file: string; name: string }[] = [];
  const walk = (dir: string) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const meta = join(dir, "layer.yaml");
    if (existsSync(meta)) {
      try {
        const doc = yaml<{ skill_secrets?: unknown }>(meta);
        for (const name of checkSkillSecrets(doc?.skill_secrets, meta)) out.push({ file: slash(relative(root, meta)), name });
      } catch { /* покажет загрузка слоя */ }
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) if (e.isDirectory() && !LAYER_PARTS.has(e.name)) walk(join(dir, e.name));
  };
  walk(join(root, "layers"));
  return out;
}

// Пометки групп в дереве слоёв: rel — путь слоя (имена каталогов слоёв, «/»); "" — корень дерева. target: true —
// каталог workspace этого слоя становится целью-группой. Из файла читается только target — и ошибка только его
// (остальные ключи — дело загрузки слоя, если он применяется)
export function treeGroups(root = configRoot()): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    const meta = join(dir, "layer.yaml");
    if (existsSync(meta)) {
      const c = check(yaml(meta), LAYER_FORM());
      report(configRel(meta, root), c.errors.filter((e) => e.path === "target"), false);
      if ((c.value as { target?: unknown }).target === true) out.push(rel);
    }
    // Из каталогов, отличающихся только регистром, — тот, что применяется (первый в порядке каталога, как treeLayers и
    // caseTwins): пометка из другого не действует (проверка 7b, B №5)
    const dirs = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !LAYER_PARTS.has(e.name));
    const used = dirs.filter((e) => dirs.find((x) => x.name.toLowerCase() === e.name.toLowerCase()) === e);
    for (const e of used.sort((a, b) => a.name.localeCompare(b.name))) walk(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
  };
  const base = join(root, "layers", "tree");
  if (existsSync(base)) walk(base, "");
  return out;
}

// Секреты открытым текстом в слоях — слои лежат в git конфигурации, значение уйдёт в репо. Файл и место, без значений.
// mcp — значения в определениях MCP вместо ссылок ${ИМЯ}; skills — в файлах skills слоёв (круг 11h): файлы, похожие на
// секрет по имени (skillFileKind), и секреты в тексте (nakedInText; бинарные и больше 1 МБ — пропуск). Ссылки не
// разыменовываются, служебные каталоги (.git, node_modules) не обходятся. Файл, который git конфигурации игнорирует,
// не сообщается — в репо он не попадёт; git спрашивается один раз на весь список и только если что-то нашлось
export function layerSecrets(root = configRoot()): { mcp: string[]; skills: string[] } {
  const mcp: string[] = [];
  const found: { rel: string; line: string }[] = [];
  const skillWalk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!skillFileKind(e.name, true)) skillWalk(p);
        continue;
      }
      if (!e.isFile()) continue; // ссылки не разыменовываем: в git уходит ссылка, а не то, куда она ведёт
      const rel = slash(relative(root, p));
      if (skillFileKind(e.name, false) === "secret") {
        found.push({ rel, line: `${rel} — файл с секретами (по имени)` });
        continue;
      }
      let text: string | null = null;
      try {
        text = textFile(p);
      } catch {
        continue;
      }
      if (text) for (const n of nakedInText(text)) found.push({ rel, line: `${rel}:${n.line}: ${n.text}` });
    }
  };
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory()) continue;
      const p = join(dir, e.name);
      if (e.name === "skills") {
        skillWalk(p);
        continue;
      }
      if (e.name !== "mcp") {
        if (!["instructions", "hooks", "policies"].includes(e.name)) walk(p);
        continue;
      }
      for (const f of readdirSync(p).filter((x) => /\.ya?ml$/.test(x)).sort()) {
        let def: unknown;
        try {
          def = yaml(join(p, f));
        } catch {
          continue; // ошибку разбора покажет загрузка слоя
        }
        if (!def || typeof def !== "object") continue;
        const where = nakedSecrets(def as Record<string, unknown>);
        if (where.length) mcp.push(`${slash(relative(root, join(p, f)))}: ${where.join(", ")}`);
      }
    }
  };
  walk(join(root, "layers"));
  const ignored = gitIgnored(root, [...new Set(found.map((f) => f.rel))]);
  return { mcp, skills: found.filter((f) => !ignored.has(f.rel)).map((f) => f.line) };
}

// Совет для секретов в skills слоёв: подстановки ${ИМЯ} в файлах skill нет (DESIGN §3 п. 6) — совет MCP тут не годится;
// способы передать skill секрет («лестница») — в docs/layers.md, ссылка на раздел
export const SKILL_SECRETS_ADVICE =
  "уберите секрет из файлов skill — как передать его skill, docs/layers.md#секреты-в-skills; файл с секретами уберите из слоя или добавьте в .gitignore конфигурации";

// Какие из путей (относительно root, через «/») git игнорирует: .gitignore, info/exclude, глобальный excludesFile.
// Отслеживаемый файл игнорируемым не считается — он уже в репо. Один запуск git на весь список (-z: любые имена).
// root не git-репо или git сбоит — пустое множество: лучше сообщить лишнее, чем промолчать о секрете
export function gitIgnored(root: string, rels: string[]): Set<string> {
  if (!rels.length) return new Set();
  try {
    const r = gitSpawn(["-C", root, "check-ignore", "-z", "--stdin"], { stdin: Buffer.from(rels.join("\0") + "\0") });
    if (r.code !== 0) return new Set(); // 1 — ничего не игнорируется, 128 — не репо или сбой
    return new Set(r.out.split("\0").filter(Boolean));
  } catch {
    return new Set();
  }
}

export const SKIP_DIRS = new Set(["node_modules", "worktrees", "dist", "build", "vendor"]);

// git-репо внутри каталога (сам каталог не считается); stop — прекратить обход на первом найденном
// Служебные каталоги самого miksy (песочницы, тестовые репо, бэкапы с чужими репо) — не проекты
// и не делают проектом с вложенными проектами движок или конфигурацию
// Корни служебных каталогов канонизируются один раз (на конфигурацию): сами out/local/dist могут
// быть ссылками (config/local → другой диск). Кандидат канонизируется без отказа: нечитаемый
// каталог (EACCES) или битая ссылка сравниваются как есть и не роняют обход
let serviceRoots: { key: string; roots: string[] } | null = null;
export function serviceDir(p: string): boolean {
  const config = configRoot();
  const key = `${ENGINE}|${config}`;
  if (serviceRoots?.key !== key) {
    const roots = [ENGINE, config].flatMap((r) => ["out", "local", "dist"].map((d) => join(r, d)));
    serviceRoots = { key, roots: [...new Set(roots.flatMap((r) => { try { return [slash(r), canonical(r)]; } catch { return [slash(r)]; } }))] };
  }
  let q = slash(p);
  try { q = canonical(p); } catch { /* нет доступа или битая ссылка — сравниваем как есть */ }
  return serviceRoots.roots.some((r) => inside(q, r));
}

// Поиск проектов (круг 11q): уровни 1–SHALLOW_LEVELS от корня обхода — полностью; глубже — не больше DEEP_BUDGET
// папок на один обход. Обход в ширину: при нехватке бюджета теряется самое глубокое. Почему так — DESIGN, «Обход workspace»
export const SHALLOW_LEVELS = 7;
export const DEEP_BUDGET = 10_000;
// Обход упёрся в бюджет: корень, сколько папок глубже SHALLOW_LEVELS пройдено, где их больше всего (путь от корня — число)
export type WalkCut = { root: string; budget: number; heavy: [string, number][] };

// skipped — каталоги, пропущенные из-за прав (нет доступа): для предупреждения, а не отказа команды;
// skip — каталоги, куда обход не заходит (вложенные корни workspace: их обходят отдельно); cut — обход упёрся в бюджет
function reposUnder(root: string, stop = false, skipped?: (dir: string) => void, skip: string[] = [], cut?: (c: WalkCut) => void, budget = DEEP_BUDGET): string[] {
  const repos: string[] = [];
  const skipKeys = new Set(skip.map((s) => fold(slash(s))));
  // Обход — от канонического корня: ссылки он не открывает (Dirent ссылки — не каталог), поэтому пути внутри тоже
  // канонические и служебные каталоги сравниваются строкой, без realpath на каждую папку. Найденное — в форме root
  const given = trimSlash(slash(root));
  let base = given;
  try { base = trimSlash(canonical(root)); } catch { /* нет доступа — как есть */ }
  const shown = (p: string) => given + p.slice(base.length);
  serviceDir(base); // обновить корни служебных каталогов (конфигурация могла смениться)
  const service = (p: string) => serviceRoots!.roots.some((r) => inside(p, r));
  const queue = [base];
  const levels = [0];
  let deep = 0;
  const heavy = new Map<string, number>();
  outer: for (let i = 0; i < queue.length; i++) {
    if (stop && repos.length) break;
    const dir = queue[i];
    const level = levels[i] + 1;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      // нечитаемый каталог (EACCES) — пропускаем, не роняя обход
      if (["EACCES", "EPERM"].includes((e as NodeJS.ErrnoException).code ?? "")) skipped?.(shown(dir));
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const p = child(dir, e.name);
      if (service(p) || skipKeys.has(fold(shown(p)))) continue;
      if (level > SHALLOW_LEVELS) {
        if (deep >= budget) {
          cut?.({ root: given, budget, heavy: [...heavy].sort((a, b) => b[1] - a[1]).slice(0, 3) });
          break outer;
        }
        deep++;
        const key = p.slice(base.endsWith("/") ? base.length : base.length + 1).split("/").slice(0, 2).join("/");
        heavy.set(key, (heavy.get(key) ?? 0) + 1);
      }
      if (existsSync(join(p, ".git"))) repos.push(shown(p));
      queue.push(p);
      levels.push(level);
    }
  }
  return repos;
}

// Есть ли внутри каталога другие проекты (git-репо) — тогда его CLAUDE.local.md подхватили бы и они. Бюджет — как у
// поиска проектов, упор — молча (как раньше предел глубины)
export const containsProjects = (dir: string) => reposUnder(dir, true).length > 0;

export type Project = { abs: string; rel: string; nested: boolean; root: Root };

// Все проекты workspace (всех корней): git-репо + каталоги, где уже работал агент (реестры проектов).
// Вложенный корень обходится сам по себе — обход внешнего его пропускает. Каталог без git, внутри
// которого есть другие проекты (например, каталог организации), — не проект: его файлы подхватывались
// бы всеми вложенными проектами. Недоступный корень (диск не подключён) пропускается. rel — место в
// дереве слоёв. warn — пропущенные каталоги (нет доступа); cut — обход корня упёрся в бюджет папок (doctor, «Справочно»);
// budget — для тестов
export function listProjects(workspace: string | Root[], extra: string[] = [], warn?: (msg: string) => void, cut?: (c: WalkCut) => void, budget = DEEP_BUDGET): Project[] {
  const live = asRoots(workspace).filter(rootExists);
  const repos = new Set<string>();
  for (const r of live)
    for (const p of reposUnder(r.path, false, (d) => warn?.(`каталог ${d} пропущен при поиске проектов — нет доступа`), innerRoots(r, live).map((o) => o.path), cut, budget))
      repos.add(p);

  const under = (a: string, b: string) => inside(a, b) && !sameKey(a, b);
  // Каталоги внутри репо относятся к самому репо; сам корень — не проект.
  // Сначала канонический путь, потом проверка «внутри корня»: симлинк мог вести наружу
  const others = extra
    .map(slash)
    .filter((p) => existsSync(p))
    .flatMap((p) => { try { return [slash(realpathSync.native(p))]; } catch { return []; } })
    .filter((p) => { const at = locate(p, live); return !!at && at.rel !== "" && !serviceDir(p) && ![...repos].some((r) => under(p, r)); });
  const all = [...new Set([...repos, ...others])].sort();
  const isAncestor = (a: string) => all.some((b) => under(b, a));
  return all
    .filter((p) => repos.has(p) || !isAncestor(p))
    .map((abs) => { const at = locate(abs, live)!; return { abs, rel: at.tree, nested: isAncestor(abs), root: at.root }; });
}

// Проект — ближайший git-корень вверх от пути (в пределах его корня workspace), иначе сам каталог.
// Корень — самый глубокий из содержащих путь. rel — место в дереве слоёв; nested — внутри есть
// другие проекты
export function findProject(path: string, workspace: string | Root[]): Project {
  const roots = asRoots(workspace);
  // «X:» — корень диска, а не текущий каталог диска; каталога нет — понятная ошибка (корень недоступен?)
  const given = driveRoot(path);
  if (!existsSync(given)) {
    const abs = trimSlash(slash(resolve(given)));
    const away = locate(abs, roots)?.root;
    throw new Error(`${abs}: каталога нет${away && !rootExists(away) ? ` — корень ${away.path} недоступен (${away.away ?? "каталога нет"})` : ""}`);
  }
  const start = slash(realpathSync.native(given));
  const at = locate(start, roots);
  if (!at) throw new Error(`${start} вне workspace ${roots.map((r) => r.path).join(", ")}`);
  const ws = at.root.path;

  let dir = start;
  while (inside(dir, ws) && fold(dir) !== fold(ws)) {
    if (existsSync(join(dir, ".git"))) break;
    const up = slash(dirname(dir));
    if (up === dir) break;
    dir = up;
  }
  const abs = existsSync(join(dir, ".git")) ? dir : start;
  return { abs, rel: treeJoin(at.root.tree, slash(relative(ws, abs))), nested: containsProjects(abs), root: at.root };
}
