import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { canonical, child, fold, homeDir, inside, sameKey, samePath, slash, driveRoot, trimSlash } from "./paths";
import { nakedSecrets } from "./secrets";
import { agentId } from "./agentid";
import { innerRoots, locate, type Root, rootExists, rootKey, treeAbove, treeJoin } from "./roots";
import type { MiksyMap, Instruction, Layer, Machine, McpServer, Os, Skill } from "./types";

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
export const configRoot = (): string => canonical(findConfig().replace(/^~(?=$|[\\/])/, homeDir()));

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


export function currentOs(): Os {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "linux";
}

// trust в machine.yaml и layer.yaml: { codex?: boolean, claude?: boolean }
function checkTrust(t: unknown, where: string) {
  if (t !== undefined && (!t || typeof t !== "object" || Array.isArray(t) || Object.entries(t).some(([k, v]) => !["codex", "claude"].includes(k) || typeof v !== "boolean")))
    throw new Error(`${where}: trust — объект { codex: boolean, claude: boolean }`);
}

export function loadMachine(root = configRoot()): Machine {
  const path = join(root, "local", "machine.yaml");
  if (!existsSync(path)) throw new Error(`Нет ${path}. Машина ещё не настроена — запусти: bun src/cli.ts setup`);
  const m = yaml<{ workspace?: unknown; vars?: Record<string, string>; agents?: string[]; trust?: Machine["trust"] }>(path);
  checkTrust(m?.trust, path);
  const roots = parseRoots(m?.workspace, slash(path), ledgerRoots(root));
  if (m.agents !== undefined && !(Array.isArray(m.agents) && m.agents.every((a) => typeof a === "string")))
    throw new Error(`${path}: agents — список агентов, например [claude, codex]`);
  return {
    workspace: roots[0].path,
    roots,
    os: currentOs(),
    home: slash(homeDir()),
    vars: m.vars ?? {},
    // Прежние имена агентов (gemini) — синонимы
    ...(m.agents && { agents: [...new Set(m.agents.map(agentId))] }),
    ...(m.trust && { trust: m.trust }),
  };
}

// Место корня в дереве слоёв: имена каталогов через «/» — без .., «.», дисков и имён частей слоя
export function checkTree(tree: string): string | null {
  const t = slash(tree).trim().replace(/^\/+|\/+$/g, "");
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
export const rootMemoryKey = (given: string) => fold(trimSlash(slash(resolve(driveRoot(given.replace(/^~(?=$|[\\/])/, homeDir()))))));

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
// У дополнительных корней ветка дерева (tree) обязательна и у всех корней — своя: иначе правила одной
// ветки молча доставались бы папкам с тем же именем в другом корне. Один каталог дважды (повтор,
// junction, симлинк) — ошибка: сравниваются настоящие пути. Недоступный корень (нет диска, ссылка в
// никуда, каталога нет; пуст, а в учёте есть его цели — точка монтирования без диска) — не ошибка: away,
// путь — последний известный настоящий из учёта (memory), иначе как записан
export function parseRoots(value: unknown, file: string, memory?: LedgerRoots): Root[] {
  const usage = `${file}: workspace — путь или список корней: путь, либо { path: <путь>, tree: <ветка дерева слоёв, например Clients> }`;
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
      throw new Error(`${file}: tree «${raw.tree}» корня ${given} — ветка дерева слоёв: имена каталогов через «/» (например, Clients), без «..», дисков и имён ${[...LAYER_PARTS].join(", ")}`);
    if (i > 0 && !tree)
      throw new Error(`${file}: у корня ${given} не указана ветка дерева слоёв — укажите: { path: ${JSON.stringify(given)}, tree: <ветка, например Clients> }. У дополнительных корней ветка обязательна: без неё правила основного корня молча доставались бы папкам с теми же именами`);
    const busy = roots.find((r) => tree && r.tree.toLowerCase() === tree.toLowerCase());
    if (busy) throw new Error(`${file}: tree: ${tree} уже у корня ${busy.given} — выберите корню ${given} другое имя ветки (общие правила для нескольких корней — слоем в map.yaml, README «Несколько корней workspace»)`);
    const expanded = given.replace(/^~(?=$|[\\/])/, homeDir());
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
  const m = yaml<Partial<MiksyMap> & { skill_prefix?: unknown; tools?: unknown }>(path) ?? {};
  if (m.skill_prefix !== undefined && (typeof m.skill_prefix !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(m.skill_prefix)))
    throw new Error(`${slash(path)}: skill_prefix — строка из букв, цифр, «-», «_», «.», например miksy-`);
  const tools = m.tools ?? {};
  const list = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x);
  if (typeof tools !== "object" || Array.isArray(tools) || Object.entries(tools as object).some(([k, t]) =>
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || !t || typeof t !== "object" || !list(t.find)
    || (t.install !== undefined && (typeof t.install !== "object" || Object.entries(t.install).some(([os, s]) => !["windows", "macos", "linux"].includes(os) || typeof s !== "string")))))
    throw new Error(`${slash(path)}: tools — { ИМЯ: { find: [команда, …], install: { windows|macos|linux: как установить } } }`);
  return { global: m.global ?? [], layers: m.layers ?? [],
    ...(m.skill_prefix !== undefined && { skillPrefix: m.skill_prefix as string }),
    ...(m.tools !== undefined && { tools: tools as MiksyMap["tools"] }) };
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

// Расстояние Левенштейна — для поиска опечаток в именах каталогов
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

const similar = (a: string, b: string) => {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  if (x === y) return false;
  if (Math.min(x.length, y.length) >= 3 && (x.includes(y) || y.includes(x))) return true;
  return Math.min(x.length, y.length) >= 4 && distance(x, y) <= 2;
};

// Корни из строки workspace (один корень в корне дерева) или готовый список
const asRoots = (workspace: string | Root[]): Root[] => (typeof workspace === "string" ? [{ path: slash(realpathSync.native(workspace)), tree: "" }] : workspace);

// Слои дерева, которые на этой машине ни к чему не применяются (нет такого каталога ни в одном корне).
// Проверяется только та часть дерева, куда смонтированы корни этой машины: ветка, над которой нет
// корня, — unmounted (для другой машины, не опечатка); часть недоступного корня (диск не подключён) не
// проверяется. Ветка без своего каталога сообщается один раз — её вложенные слои не перечисляются.
// suggestion — похожий каталог на том же уровне: вероятная опечатка или переименование. other — ветка верхнего
// уровня дерева (под основным корнем без tree): она может быть и веткой корня другой машины ({ path, tree: <ветка> }
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

function loadLayerDir(dir: string, name: string): Layer {
  const metaPath = join(dir, "layer.yaml");
  const meta = existsSync(metaPath)
    ? yaml<{ description?: string; exclude?: string[]; import_skills?: unknown; trust?: unknown; target?: unknown }>(metaPath) ?? {}
    : {};
  checkTrust(meta.trust, `${name}/layer.yaml`);
  checkTarget(meta.target, `${name}/layer.yaml`);
  const imp = meta.import_skills;
  if (imp !== undefined && imp !== "auto" && imp !== "all" && imp !== false && !(Array.isArray(imp) && imp.every((x) => typeof x === "string")))
    throw new Error(`${name}/layer.yaml: import_skills — auto, all, false или список имён`);

  const instructions: Instruction[] = listDir(join(dir, "instructions"))
    .filter((f) => f.endsWith(".md"))
    .map((file) => ({ file, path: join(dir, "instructions", file) }));

  const skills: Skill[] = listDir(join(dir, "skills"))
    .filter((s) => existsSync(join(dir, "skills", s, "SKILL.md")))
    .map((s) => ({ name: s, dir: join(dir, "skills", s) }));

  const mcp: McpServer[] = listDir(join(dir, "mcp"))
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .map((f) => {
      const s = yaml<McpServer>(join(dir, "mcp", f));
      if (!s?.name) throw new Error(`${name}/mcp/${f}: нет поля name`);
      if (!s.command && !s.url) throw new Error(`${name}/mcp/${f}: нужно command или url`);
      // Прежнее имя агента (agents: { gemini: … }) — синоним; заданное новым именем важнее
      if (s.agents && typeof s.agents === "object" && Object.keys(s.agents).some((k) => agentId(k) !== k))
        s.agents = Object.fromEntries(Object.entries(s.agents).sort(([a], [b]) => Number(agentId(a) === a) - Number(agentId(b) === b)).map(([k, v]) => [agentId(k), v]));
      return s;
    });

  return { name, dir, description: meta.description, exclude: meta.exclude ?? [], importSkills: imp as Layer["importSkills"],
    ...(meta.trust !== undefined && { trust: meta.trust as Layer["trust"] }), ...(meta.target === true && { target: true }), instructions, skills, mcp };
}

// Ключи, которые miksy читает: остальные — опечатка или ключ более новой версии (sync и doctor
// предупреждают; значения не проверяются здесь — это делают loadMap и loadLayerDir)
const MAP_KEYS = ["global", "layers", "skill_prefix", "tools"];
const MAP_ENTRY_KEYS = ["use", "match", "os"];
const LAYER_KEYS = ["description", "exclude", "import_skills", "trust", "target"];

// Неизвестные ключи map.yaml (и его привязок) и всех layer.yaml в layers/: «файл: ключ». Файл, который не
// разбирается, пропускается — об ошибке скажет загрузка
export function unknownKeys(root = configRoot()): string[] {
  const out: string[] = [];
  const read = (path: string): unknown => { try { return parseYaml(readFileSync(path, "utf8")); } catch { return null; } };
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const map = read(join(root, "map.yaml"));
  if (isObj(map)) {
    for (const k of Object.keys(map)) if (!MAP_KEYS.includes(k)) out.push(`map.yaml: ${k}`);
    for (const list of ["global", "layers"]) {
      const v = map[list];
      if (Array.isArray(v)) v.forEach((e, i) => {
        if (isObj(e)) for (const k of Object.keys(e)) if (!MAP_ENTRY_KEYS.includes(k)) out.push(`map.yaml: ${list}[${i}].${k}`);
      });
    }
  }
  const walk = (dir: string) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isFile() && e.name === "layer.yaml") {
        const doc = read(join(dir, e.name));
        if (isObj(doc)) for (const k of Object.keys(doc)) if (!LAYER_KEYS.includes(k)) out.push(`${slash(relative(root, join(dir, e.name)))}: ${k}`);
      } else if (e.isDirectory() && !LAYER_PARTS.has(e.name)) walk(join(dir, e.name));
    }
  };
  walk(join(root, "layers"));
  return out;
}

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

// target в layer.yaml слоя дерева: true — каталог workspace этого слоя становится целью-группой
function checkTarget(t: unknown, where: string) {
  if (t !== undefined && typeof t !== "boolean") throw new Error(`${where}: target — true или false (цель-группа)`);
}

// Пометки групп в дереве слоёв: rel — путь слоя (имена каталогов слоёв, «/»); "" — корень дерева
export function treeGroups(root = configRoot()): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    const meta = join(dir, "layer.yaml");
    if (existsSync(meta)) {
      const t = (yaml<{ target?: unknown }>(meta) ?? {}).target;
      checkTarget(t, `${rel || "workspace"}/layer.yaml`);
      if (t === true) out.push(rel);
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

// Секреты открытым текстом в MCP слоёв (вместо ссылок ${ИМЯ}): файл и место, без значений.
// Слои лежат в git конфигурации — значение уйдёт в репо
export function layerSecrets(root = configRoot()): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = join(dir, e.name);
      if (e.name !== "mcp") {
        if (!["instructions", "skills", "hooks", "policies"].includes(e.name)) walk(p);
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
        if (where.length) out.push(`${slash(relative(root, join(p, f)))}: ${where.join(", ")}`);
      }
    }
  };
  walk(join(root, "layers"));
  return out;
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

// skipped — каталоги, пропущенные из-за прав (нет доступа): для предупреждения, а не отказа команды;
// skip — каталоги, куда обход не заходит (вложенные корни workspace: их обходят отдельно)
function reposUnder(root: string, stop = false, skipped?: (dir: string) => void, skip: string[] = []): string[] {
  const repos: string[] = [];
  const skipKeys = new Set(skip.map((s) => fold(slash(s))));
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || (stop && repos.length)) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      // нечитаемый каталог (EACCES) — пропускаем, не роняя обход
      if (["EACCES", "EPERM"].includes((e as NodeJS.ErrnoException).code ?? "")) skipped?.(dir);
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const p = child(dir, e.name);
      if (serviceDir(p) || skipKeys.has(fold(p))) continue;
      if (existsSync(join(p, ".git"))) repos.push(p);
      walk(p, depth + 1);
    }
  };
  walk(slash(root), 0);
  return repos;
}

// Есть ли внутри каталога другие проекты (git-репо) — тогда его CLAUDE.local.md подхватили бы и они
export const containsProjects = (dir: string) => reposUnder(dir, true).length > 0;

export type Project = { abs: string; rel: string; nested: boolean; root: Root };

// Все проекты workspace (всех корней): git-репо + каталоги, где уже работал агент (реестры проектов).
// Вложенный корень обходится сам по себе — обход внешнего его пропускает. Каталог без git, внутри
// которого есть другие проекты (например, каталог организации), — не проект: его файлы подхватывались
// бы всеми вложенными проектами. Недоступный корень (диск не подключён) пропускается. rel — место в
// дереве слоёв. warn — пропущенные каталоги (нет доступа)
export function listProjects(workspace: string | Root[], extra: string[] = [], warn?: (msg: string) => void): Project[] {
  const live = asRoots(workspace).filter(rootExists);
  const repos = new Set<string>();
  for (const r of live)
    for (const p of reposUnder(r.path, false, (d) => warn?.(`каталог ${d} пропущен при поиске проектов — нет доступа`), innerRoots(r, live).map((o) => o.path)))
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
