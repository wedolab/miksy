import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { canonical, homeDir, inside, samePath, slash } from "./paths";
import { nakedSecrets } from "./secrets";
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
  const m = yaml<{ workspace?: string; vars?: Record<string, string>; agents?: string[]; trust?: Machine["trust"] }>(path);
  checkTrust(m?.trust, path);
  if (!m?.workspace) throw new Error(`${path}: не задан workspace`);
  if (m.agents !== undefined && !(Array.isArray(m.agents) && m.agents.every((a) => typeof a === "string")))
    throw new Error(`${path}: agents — список агентов, например [claude, codex]`);
  return {
    workspace: canonical(m.workspace.replace(/^~(?=$|[\\/])/, homeDir())),
    os: currentOs(),
    home: slash(homeDir()),
    vars: m.vars ?? {},
    ...(m.agents && { agents: m.agents }),
    ...(m.trust && { trust: m.trust }),
  };
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

// Слои дерева, которые на этой машине ни к чему не применяются (нет такого каталога в workspace).
// Ветка без своего каталога сообщается один раз — её вложенные слои не перечисляются.
// suggestion — похожий каталог на том же уровне: вероятная опечатка или переименование.
export function orphanTreeDirs(workspace: string, root = configRoot()): { path: string; suggestion?: string }[] {
  const base = join(root, "layers", "tree");
  const out: { path: string; suggestion?: string }[] = [];
  const walk = (layerDir: string, wsDir: string, rel: string) => {
    if (!existsSync(layerDir)) return;
    const wsNames = existsSync(wsDir) ? readdirSync(wsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];
    // По имени: порядок readdir зависит от файловой системы (на Linux — не алфавитный), вывод doctor — нет
    const entries = readdirSync(layerDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (!e.isDirectory() || LAYER_PARTS.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const match = wsNames.find((n) => n.toLowerCase() === e.name.toLowerCase());
      if (match) {
        walk(join(layerDir, e.name), join(wsDir, match), r);
        continue;
      }
      const near = wsNames.find((n) => similar(n, e.name));
      out.push({ path: r, ...(near && { suggestion: rel ? `${rel}/${near}` : near }) });
    }
  };
  walk(base, workspace, "");
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
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)))
      if (e.isDirectory() && !LAYER_PARTS.has(e.name)) walk(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
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

// skipped — каталоги, пропущенные из-за прав (нет доступа): для предупреждения, а не отказа команды
function reposUnder(root: string, stop = false, skipped?: (dir: string) => void): string[] {
  const repos: string[] = [];
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
      const p = `${dir}/${e.name}`;
      if (serviceDir(p)) continue;
      if (existsSync(join(p, ".git"))) repos.push(p);
      walk(p, depth + 1);
    }
  };
  walk(slash(root), 0);
  return repos;
}

// Есть ли внутри каталога другие проекты (git-репо) — тогда его CLAUDE.local.md подхватили бы и они
export const containsProjects = (dir: string) => reposUnder(dir, true).length > 0;

// Все проекты workspace: git-репо + каталоги, где уже работал Claude (ключи ~/.claude.json).
// Каталог без git, внутри которого есть другие проекты (например, каталог организации), — не проект:
// его файлы подхватывались бы всеми вложенными проектами. warn — пропущенные каталоги (нет доступа)
export function listProjects(workspace: string, extra: string[] = [], warn?: (msg: string) => void): { abs: string; rel: string; nested: boolean }[] {
  const ws = slash(realpathSync.native(workspace));
  const repos = new Set(reposUnder(ws, false, (d) => warn?.(`каталог ${d} пропущен при поиске проектов — нет доступа`)));

  const under = (a: string, b: string) => inside(a, b) && !samePath(a, b);
  // Каталоги внутри репо относятся к самому репо.
  // Сначала канонический путь, потом проверка «внутри workspace»: симлинк мог вести наружу
  const others = extra
    .map(slash)
    .filter((p) => existsSync(p))
    .flatMap((p) => { try { return [slash(realpathSync.native(p))]; } catch { return []; } })
    .filter((p) => under(p, ws) && !serviceDir(p) && ![...repos].some((r) => under(p, r)));
  const all = [...new Set([...repos, ...others])].sort();
  const isAncestor = (a: string) => all.some((b) => under(b, a));
  return all
    .filter((p) => repos.has(p) || !isAncestor(p))
    .map((abs) => ({ abs, rel: slash(relative(ws, abs)), nested: isAncestor(abs) }));
}

// Проект — ближайший git-корень вверх от пути (в пределах workspace), иначе сам каталог.
// nested — внутри есть другие проекты
export function findProject(path: string, workspace: string): { abs: string; rel: string; nested: boolean } {
  const ws = slash(realpathSync.native(workspace));
  const start = slash(realpathSync.native(path));
  const within = (p: string) => inside(p, ws);
  if (!within(start)) throw new Error(`${start} вне workspace ${ws}`);

  let dir = start;
  while (within(dir) && dir !== ws) {
    if (existsSync(join(dir, ".git"))) break;
    const up = slash(dirname(dir));
    if (up === dir) break;
    dir = up;
  }
  const abs = existsSync(join(dir, ".git")) ? dir : start;
  return { abs, rel: slash(relative(ws, abs)), nested: containsProjects(abs) };
}
