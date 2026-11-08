// miksy root add/remove: правка ключа workspace в local/machine.yaml строками — остальное в файле (vars,
// agents, trust, комментарии) не меняется. Строка workspace (один корень) становится списком. Блочный
// список правится по строкам (комментарии внутри сохраняются), прочие формы (flow-список) записываются
// заново. Проверка разбором: прочие ключи не изменились, workspace — ровно ожидаемый список
import { parseYaml } from "./load";

export type RootItem = string | { path: string; tree?: string };

const itemText = (it: RootItem) =>
  typeof it === "string" ? JSON.stringify(it) : it.tree ? `{ path: ${JSON.stringify(it.path)}, tree: ${JSON.stringify(it.tree)} }` : JSON.stringify(it.path);

// Область ключа workspace: строка ключа и строки его значения (отступ, пустые, комментарии — до
// следующего ключа верхнего уровня)
function region(lines: string[]): { at: number; end: number } | null {
  const at = lines.findIndex((l) => /^workspace:/.test(l));
  if (at < 0) return null;
  let end = at + 1;
  // Элементы списка бывают и без отступа («- a» под «workspace:»)
  while (end < lines.length && (/^\s/.test(lines[end]) || /^-( |$)/.test(lines[end]) || /^\s*(#.*)?$/.test(lines[end]))) end++;
  // Хвостовые пустые строки и комментарии без отступа — уже не значение workspace
  while (end > at + 1 && /^(#.*)?$/.test(lines[end - 1])) end--;
  return { at, end };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const rest = (d: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(d).filter(([k]) => k !== "workspace").sort(([a], [b]) => a.localeCompare(b))));

// Новый текст machine.yaml: workspace = items (полный новый список). keep — индекс в старом списке для
// каждого нового элемента (-1 — новый): по нему блочный список правится строками
export function rewriteRoots(source: string, items: RootItem[], keep: number[]): string {
  // BOM в начале (PowerShell 5.1, Блокнот) — сохраняется, как был; loadMachine его тоже принимает
  const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
  return bom + rewrite(source.slice(bom.length), items, keep);
}

function rewrite(text: string, items: RootItem[], keep: number[]): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const doc = (parseYaml(text) ?? {}) as Record<string, unknown>;
  const r = region(lines);
  if (!r) throw new Error("в local/machine.yaml нет ключа workspace");
  const head = lines[r.at].replace(/^workspace:[ \t]*/, "");
  const block = !head || head.startsWith("#");
  let next: string[] | null = null;
  // Остался один корень без ветки — строкой, как пишет мастер (0.1.x список не понимает): элемент — как был
  // записан (кавычки, комментарий), если это был элемент блочного списка
  const only = items.length === 1 && (typeof items[0] === "string" || !items[0].tree) ? items[0] : null;
  if (only !== null) {
    const body = lines.slice(r.at + 1, r.end);
    const own = block && typeof only === "string" ? body.filter((l) => /^\s*-( |$)/.test(l))[keep[0]] : undefined;
    const text = own?.replace(/^\s*-\s*/, "") || itemText(typeof only === "string" ? only : only.path);
    next = [...lines.slice(0, r.at), `workspace: ${text}`, ...lines.slice(r.end)];
  }
  if (!next && block) {
    // Элементы блочного списка: строки «- …» с отступом первого элемента и их продолжение
    const body = lines.slice(r.at + 1, r.end);
    const lead = (l: string) => l.match(/^\s*/)![0];
    const starts = body.flatMap((l, i) => (/^\s*-( |$)/.test(l) ? [i] : []));
    const indent = starts.length ? lead(body[starts[0]]) : "  ";
    const own = starts.filter((i) => lead(body[i]) === indent);
    if (own.length && own.length === (Array.isArray(doc.workspace) ? doc.workspace.length : -1)) {
      const chunks = own.map((s, k) => {
        // Комментарии и пустые строки после элемента — с ним
        return body.slice(s, k + 1 < own.length ? own[k + 1] : body.length);
      });
      const out: string[] = [];
      for (const [i, from] of keep.entries()) out.push(...(from >= 0 ? chunks[from] : [`${indent}- ${itemText(items[i])}`]));
      next = [...lines.slice(0, r.at + 1), ...body.slice(0, own[0]), ...out, ...lines.slice(r.end)];
    }
  }
  if (!next) {
    // Строка или flow-список — заново, блочным списком; комментарий строки ключа остаётся при ней
    const comment = head.match(/\s#.*$/)?.[0]?.trim();
    const scalar = typeof doc.workspace === "string" && !head.startsWith("[") && !head.startsWith("{");
    const first = scalar && keep[0] === 0 ? head.replace(/\s+#.*$/, "") : null;
    next = [...lines.slice(0, r.at), `workspace:${comment ? ` ${comment}` : ""}`,
      ...items.map((it, i) => `  - ${i === 0 && first !== null ? first : itemText(it)}`), ...lines.slice(r.end)];
  }
  const after = next.join(eol);
  let parsed: Record<string, unknown>;
  try { parsed = (parseYaml(after) ?? {}) as Record<string, unknown>; } catch { parsed = {}; }
  const norm = (v: unknown) => (typeof v === "string" ? v : v && typeof v === "object" ? { path: (v as { path?: unknown }).path, tree: (v as { tree?: unknown }).tree ?? undefined } : v);
  const want = only !== null ? [typeof only === "string" ? only : only.path] : items;
  if (rest(parsed) !== rest(doc) || (only === null && !Array.isArray(parsed.workspace)) || !same(rootItems(parsed.workspace).map(norm), want.map(norm)))
    throw new Error("local/machine.yaml: workspace не изменить строками — поправьте файл вручную");
  return after;
}

// Список корней как записан: строка — один элемент
export const rootItems = (v: unknown): RootItem[] => (typeof v === "string" ? [v] : Array.isArray(v) ? (v as RootItem[]) : []);
