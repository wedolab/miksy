// Цели без git. Пометка target: true в layer.yaml слоя дерева (miksy target) делает каталог workspace
// целью: miksy пишет ему настройки, как проекту (каталог над проектами — группа, рабочий каталог без
// git — обычная цель). И обратная сторона: каталоги на уровне проектов, которые не git-репо и не цели,
// настроек не получают — sync --all и doctor подсказывают их
import { existsSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { configRoot, containsProjects, LAYER_PARTS, parseYaml, serviceDir, SKIP_DIRS } from "./load";
import { canonical, child, fold, homeDir, inside, pathKey, sameKey, samePath, slash, driveRoot, trimSlash } from "./paths";
import { writeAtomic } from "./manifest";
import type { Group, TargetSpec } from "./registry";
import { innerRoots, locate, type Root, rootExists, treeJoin } from "./roots";


// Ближайший git-репо от каталога вверх до workspace (корень workspace — не проект): сам каталог или предок
function repoAbove(dir: string, ws: string): string | null {
  for (let d = dir; inside(d, ws) && !sameKey(d, ws); d = slash(dirname(d))) if (existsSync(join(d, ".git"))) return d;
  return null;
}

// Системные каталоги корня диска Windows (workspace на целом диске)
const SYSTEM = /^(\$.*|System Volume Information)$/i;

// Каталоги на уровне проектов, которые настроек не получат. Уровень проектов — непосредственные
// подкаталоги каждого корня workspace, а также каталогов слоёв дерева (организации и т. п.) и групп, если
// в них есть проекты. Не считаются:
// скрытые, системные и служебные (node_modules, служебные каталоги miksy), ссылки, сами каталоги
// слоёв дерева, вложенные корни (у них свой обход), git-репо и каталоги с git-репо внутри, цели (группы и
// проекты, где уже работал агент), всё внутри проекта. Возвращает места в дереве слоёв (у корня в корне
// дерева — пути от корня)
export function plainDirs(workspace: string | Root[], groups: Group[], targets: TargetSpec[], root = configRoot()): string[] {
  const roots = typeof workspace === "string" ? [{ path: canonical(workspace), tree: "" }] : workspace;
  const live = roots.filter(rootExists);
  const key = (p: string) => fold(pathKey(p));
  const isTarget = new Set(targets.flatMap((t) => (t.target.scope === "project" ? [key(t.target.dir)] : [])));
  const out = new Set<string>();
  for (const r of live) {
    const ws = r.path;
    // Вложенные корни — и недоступные: их точка монтирования (диск не подключён) — не «каталог без git», о них говорят
    // свои сообщения (выпуск 0.2.1, A7)
    const inner = new Set(innerRoots(r, roots).map((o) => key(o.path)));
    const parents = new Map<string, string>([[key(ws), ws]]);
    const layers = new Set<string>();
    // Каталоги корня по слоям дерева его места — без учёта регистра, как treeLayers
    const walk = (layer: string, dir: string) => {
      let names: string[];
      try { names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return; }
      for (const e of readdirSync(layer, { withFileTypes: true })) {
        if (!e.isDirectory() || LAYER_PARTS.has(e.name)) continue;
        const hit = names.find((n) => n.toLowerCase() === e.name.toLowerCase());
        if (!hit) continue;
        const p = child(dir, hit);
        if (inner.has(key(p))) continue;
        layers.add(key(p));
        parents.set(key(p), p);
        walk(join(layer, e.name), p);
      }
    };
    const tree = layerPath(r.tree, root);
    if (existsSync(tree)) walk(tree, ws);
    for (const g of groups) if (!g.root || sameKey(g.root.path, ws)) parents.set(key(g.abs), g.abs);

    for (const parent of parents.values()) {
      // Уровень проектов — рядом с проектами: каталог слоя или цель без проектов внутри (рабочий каталог,
      // организация, где ещё ничего не склонировано) — не родитель; внутри проекта — тоже
      if (repoAbove(parent, ws) || (!sameKey(parent, ws) && !containsProjects(parent))) continue;
      let entries;
      try { entries = readdirSync(parent, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name) || SYSTEM.test(e.name)) continue;
        const p = child(parent, e.name);
        if (inner.has(key(p)) || layers.has(key(p)) || isTarget.has(key(p)) || serviceDir(p) || existsSync(join(p, ".git")) || containsProjects(p)) continue;
        out.add(treeJoin(r.tree, slash(relative(ws, p))));
      }
    }
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

// Каталог для miksy target: путь от текущего каталога. Ошибка — вне всех корней workspace, сам корень,
// внутри проекта (git-репо), сам проект без вложенных проектов (настройки и так получает), служебный
// каталог miksy, каталог с домашним. Для --remove каталога может уже не быть. rel — место в дереве слоёв
export function targetDir(path: string, workspace: string | Root[], home: string, remove: boolean): { abs: string; rel: string } {
  const roots = typeof workspace === "string" ? [{ path: canonical(workspace), tree: "" }] : workspace;
  const given = trimSlash(slash(resolve(process.cwd(), driveRoot(path))));
  if (!existsSync(given) && !remove) throw new Error(`${given}: каталога нет`);
  // Пометка лежит в слое конфигурации, а не на диске: снять её можно и без диска — путь, который не раскрывается
  // (недоступный корень: нет диска, ссылка в никуда), — как записан (выпуск 0.2.1, A9)
  let abs = remove ? pathKey(given) : canonical(given);
  let at = locate(abs, roots);
  // Путь через корень-ссылку, назначение которой недоступно: путь такого корня — запомненное назначение
  // (load.ts: parseRoots), а набран путь через саму ссылку, как записан в local/machine.yaml (проверка 7a, B №4)
  if (!at && remove)
    for (const r of roots) {
      if (!r.away || !r.given) continue;
      const link = trimSlash(slash(resolve(process.cwd(), driveRoot(r.given.replace(/^~(?=$|[\\/])/, homeDir())))));
      if (!inside(given, link)) continue;
      const moved = trimSlash(`${r.path}${given.slice(link.length)}`);
      const hit = locate(moved, roots);
      if (hit) { abs = moved; at = hit; break; }
    }
  if (!at) throw new Error(`${abs} вне workspace ${roots.map((r) => r.path).join(", ")} — целью может быть только каталог внутри него`);
  const ws = at.root.path;
  if (!at.rel) throw new Error(`${abs} — сам workspace (корень): он не цель (общие настройки его проектов — слой layers/tree/${at.root.tree})`);
  const rel = at.tree;
  if (remove) return { abs, rel };
  const repo = repoAbove(slash(dirname(abs)), ws);
  if (repo) throw new Error(`${rel} внутри проекта ${treeJoin(at.root.tree, slash(relative(ws, repo)))} (git-репо): настройки получает проект целиком, отдельная цель внутри него не нужна`);
  if (existsSync(join(abs, ".git")) && !containsProjects(abs)) throw new Error(`${rel} — git-репо: это проект, настройки он получает и без пометки`);
  if (serviceDir(abs)) throw new Error(`${rel} — служебный каталог miksy`);
  if (inside(canonical(home), abs)) throw new Error(`${rel} содержит домашний каталог — для дома: miksy sync --global`);
  return { abs, rel };
}

// Каталог слоя дерева для пути workspace: существующие каталоги слоёв — без учёта регистра
export function layerPath(rel: string, root = configRoot()): string {
  let dir = join(root, "layers", "tree");
  for (const seg of rel.split("/")) {
    if (LAYER_PARTS.has(seg)) throw new Error(`${rel}: имя «${seg}» зарезервировано в слоях (${[...LAYER_PARTS].join(", ")}) — такой каталог целью не сделать`);
    const hit = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).find((e) => e.isDirectory() && e.name.toLowerCase() === seg.toLowerCase()) : undefined;
    dir = join(dir, hit?.name ?? seg);
  }
  return dir;
}

export type MarkPlan = { file: string; before: string | null; after: string | null };

// Новый текст layer.yaml: пометка дописывается (target: false — меняется на true) или снимается
// строкой; остальное — комментарии, ключи, порядок — как было. Проверка разбором: прочие ключи не
// изменились. after null — файл удалить (после снятия пометки в нём ничего не осталось)
export function markPlan(dir: string, remove: boolean): MarkPlan {
  const file = join(dir, "layer.yaml");
  const before = existsSync(file) ? readFileSync(file, "utf8") : null;
  const parse = (t: string) => {
    try { return (parseYaml(t) ?? {}) as Record<string, unknown>; }
    catch (e) { throw new Error(`${slash(file)}: YAML не разбирается — исправьте файл (${(e as Error).message})`); }
  };
  const doc = before === null ? {} : parse(before);
  if (typeof doc !== "object" || Array.isArray(doc)) throw new Error(`${slash(file)}: не словарь ключей`);
  const marked = doc.target === true;
  if (remove ? !marked : marked) return { file, before, after: before };
  const eol = before?.includes("\r\n") ? "\r\n" : "\n";
  let after: string | null;
  if (remove) {
    after = before!.replace(/^target:[ \t]*true[ \t]*(#[^\r\n]*)?(\r?\n|$)/m, "");
    if (!after.trim()) after = null;
  } else if (before === null) after = `target: true${eol}`;
  else if (/^target:/m.test(before)) after = before.replace(/^(target:[ \t]*)[^\s#]+/m, "$1true");
  else after = `${before}${before && !before.endsWith("\n") ? eol : ""}target: true${eol}`;
  // Прочие ключи — как были; иначе (пометка в flow-записи, многострочная) — вручную
  const rest = (d: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(d).filter(([k]) => k !== "target").sort()));
  const next = after === null ? {} : parse(after);
  if ((remove ? next.target !== undefined : next.target !== true) || rest(next) !== rest(doc))
    throw new Error(`${slash(file)}: пометку не изменить строкой — ${remove ? "уберите" : "задайте"} target: true вручную`);
  return { file, before, after };
}

// Запись плана; пустые каталоги слоя, оставшиеся после удаления файла, — тоже убрать (до layers/tree)
export function applyMark(p: MarkPlan, root = configRoot()) {
  if (p.after !== null) return writeAtomic(p.file, p.after);
  if (existsSync(p.file)) unlinkSync(p.file);
  const tree = join(root, "layers", "tree");
  for (let d = dirname(p.file); inside(d, tree) && !samePath(d, tree) && existsSync(d) && !readdirSync(d).length; d = dirname(d)) rmdirSync(d);
}

// Одна строка для sync --all и заголовок для doctor
export const plainText = (dirs: string[]) => `не git-репо — настроек не получат (${dirs.length}): ${dirs.join(", ")} — git init или miksy target <путь>`;
