// Корни workspace: каталоги с проектами на этой машине (local/machine.yaml → workspace) и их места в
// дереве слоёв layers/tree. Конфигурация от машины не зависит: слой Clients/… применяется к тому, что
// на этой машине смонтировано в Clients, где бы этот каталог ни лежал. Две независимые функции —
// «путь → корень и место в дереве» (locate) и обратная «место в дереве → каталоги этой машины» (dirsOf):
// ими пользуются цели, группы, doctor и (в будущем) каталог workspace.
import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { basename } from "node:path";
import { canonical, child, fold, inside, sameKey, samePath, slash, driveRoot, trimSlash } from "./paths";

export interface Root {
  path: string; // канонический путь (realpath существующей части); недоступный — последний известный
  tree: string; // место в дереве слоёв (ветка): "" — корень layers/tree, иначе "Clients" или "A/B"
  away?: string; // недоступен сейчас — почему (нет диска, ссылка ведёт в никуда, каталога нет, пуст)
  given?: string; // путь, как записан в local/machine.yaml (сообщения, miksy root remove, ключ учёта)
}

export interface Place {
  root: Root;
  abs: string; // канонический путь
  rel: string; // путь от корня ("" — сам корень)
  tree: string; // путь в дереве слоёв ("" — корень дерева)
}

export const treeJoin = (...parts: string[]) => parts.filter(Boolean).join("/");

// Сравнение мест в дереве — без учёта регистра, как имена слоёв (treeLayers)
const segs = (t: string) => (t ? t.split("/") : []);
const sameSeg = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
// a — то же место, что b, или выше него
export function treeAbove(a: string, b: string): boolean {
  const x = segs(a), y = segs(b);
  return x.length <= y.length && x.every((s, i) => sameSeg(s, y[i]));
}

const canon = (p: string) => { try { return canonical(p); } catch { return slash(resolve(p)); } };

// Доступен ли корень: недоступный при загрузке (away) — нет до следующего запуска, даже если появился
export const rootExists = (r: Root) => { if (r.away) return false; try { return statSync(r.path).isDirectory(); } catch { return false; } };

// Корень, к которому относится путь: самый глубокий (вложенный корень — свой: внешний его не
// включает). null — путь вне всех корней
export function locate(path: string, roots: Root[]): Place | null {
  const abs = canon(path);
  let best: Root | null = null;
  for (const r of roots) if (inside(abs, r.path) && (!best || r.path.length > best.path.length)) best = r;
  if (!best) return null;
  const rel = slash(relative(best.path, abs));
  return { root: best, abs, rel, tree: treeJoin(best.tree, rel) };
}

// Корни, лежащие внутри корня r (вложенные): обход r их пропускает — у них свои места в дереве
export const innerRoots = (r: Root, roots: Root[]) =>
  roots.filter((o) => o !== r && inside(o.path, r.path) && !sameKey(o.path, r.path));

// Каталог — ссылка на каталог (симлинк, junction)?
const linkedDir = (parent: string, e: Dirent) => e.isSymbolicLink() && (() => { try { return statSync(join(parent, e.name)).isDirectory(); } catch { return false; } })();

// Каталоги этой машины для места в дереве слоёв: для каждого корня, чьё место — это место или выше,
// путь по именам каталогов без учёта регистра (как treeLayers). Каталог, который относится к более
// глубокому корню, — не этого корня (пропускается). link — путь идёт через ссылку на каталог
export function dirsOf(tree: string, roots: Root[], keepInner = false): { root: Root; dir: string; link: boolean }[] {
  const out: { root: Root; dir: string; link: boolean }[] = [];
  for (const r of roots) {
    if (!treeAbove(r.tree, tree) || !rootExists(r)) continue;
    let dir: string | null = r.path;
    let link = false;
    for (const seg of segs(tree).slice(segs(r.tree).length)) {
      const parent: string = dir!;
      let hit: Dirent | undefined;
      try { hit = readdirSync(parent, { withFileTypes: true }).find((e) => sameSeg(e.name, seg) && (e.isDirectory() || linkedDir(parent, e))); }
      catch { hit = undefined; }
      if (!hit) { dir = null; break; }
      link ||= hit.isSymbolicLink();
      dir = child(parent, hit.name);
    }
    if (!dir) continue;
    // Каталог вложенного корня — его, а не этого
    const at = locate(dir, roots);
    if (at && !sameKey(at.root.path, r.path) && !keepInner) continue;
    out.push({ root: r, dir, link });
  }
  return out;
}

// Корни машины; Machine без roots (собранный вручную) — один корень workspace в корне дерева
export const machineRoots = (m: { workspace: string; roots?: Root[] }): Root[] => m.roots ?? [{ path: canon(m.workspace), tree: "" }];

// Место в дереве для каталога (учёт, бывшие группы): вне корней — сам путь
export const treeOf = (dir: string, roots: Root[]) => locate(dir, roots)?.tree ?? slash(dir);

// Как показать корень: путь и место в дереве
export const rootText = (r: Root) => `${r.path}${r.tree ? ` → layers/tree/${r.tree}` : ""}`;

// Ближайший корень, внутри которого лежит корень r (r — вложенный), или null
export function outerRoot(r: Root, roots: Root[]): Root | null {
  let best: Root | null = null;
  for (const o of roots) if (o !== r && inside(r.path, o.path) && !sameKey(r.path, o.path) && (!best || o.path.length > best.path.length)) best = o;
  return best;
}

// Вложенный корень — справка, не предупреждение: его папки относятся к нему, обход внешнего их пропускает
export const nestedText = (r: Root, o: Root) =>
  `корень ${r.path} внутри корня ${o.path}, место в дереве — layers/tree${r.tree ? `/${r.tree}` : ""} (его папки относятся к нему, обход ${o.path} их пропускает)`;

// Совпадение ветки: место корня r в дереве занято существующим каталогом другого корня — слои ветки
// получили бы оба (папка Clients в основном корне и корень с tree: Clients). Вложенный корень на своём
// естественном месте (ветка = его путь во внешнем корне) — не совпадение, а он сам. Только доступные корни
export function treeClashes(roots: Root[]): { root: Root; other: Root; dir: string }[] {
  const out: { root: Root; other: Root; dir: string }[] = [];
  for (const r of roots) {
    if (!r.tree) continue;
    for (const d of dirsOf(r.tree, roots)) if (d.root !== r && !sameKey(d.dir, r.path)) out.push({ root: r, other: d.root, dir: d.dir });
  }
  return out;
}
export const clashText = (c: { root: Root; other: Root; dir: string }) =>
  `ветка layers/tree/${c.root.tree} корня ${c.root.path} совпадает с папкой ${c.dir} корня ${c.other.path}: слои этой ветки получат обе. Если это не задумано — смените tree корня или переименуйте папку; общие правила для нескольких корней задают явно — слоем в map.yaml (README, «Несколько корней workspace»)`;

// Имена частей слоя (load.ts: LAYER_PARTS) — не имена веток
const PARTS = ["instructions", "mcp", "skills", "hooks", "policies"];

// Ветка для нового корня по имени его папки: допустимое имя (не имя части слоя, без «.» и пробелов по
// краям), не занятое другим корнем (без учёта регистра). Корень диска — по букве диска
export function suggestTree(path: string, taken: string[]): string {
  const p = trimSlash(slash(path));
  const base = (basename(p) || p.replace(/[:/]+/g, "")).replace(/^[\s.]+|[\s.]+$/g, "") || "Root";
  const name = PARTS.includes(base.toLowerCase()) ? `${base}-root` : base;
  const used = new Set(taken.map((t) => t.toLowerCase()));
  let out = name;
  for (let i = 2; used.has(out.toLowerCase()); i++) out = `${name}-${i}`;
  return out;
}

// Ключ сравнения путей корней (повтор, junction, симлинк — один каталог)
export const rootKey = (p: string) => fold(canon(p));
