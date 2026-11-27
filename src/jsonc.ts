// JSON с комментариями (JSONC) — разбор с позициями и правка «на месте» (круг 11y). Конфиги агентов (opencode читает
// JSONC в любом своём файле) miksy меняет только в своих ключах: остальной текст — комментарии, отступы, порядок,
// концевые запятые, переводы строк (CRLF/LF), BOM — остаётся побайтно. Без зависимостей.
// Разбор — строгий JSON плюс комментарии // и /* */ и концевые запятые; строки — только в двойных кавычках

export type JNode =
  | { kind: "object"; start: number; end: number; members: JMember[]; value: Record<string, unknown> }
  | { kind: "array"; start: number; end: number; items: JNode[]; value: unknown[] }
  | { kind: "value"; start: number; end: number; value: unknown };
// start…end — от открывающей кавычки ключа до конца значения; comma — позиция запятой после значения
export type JMember = { key: string; start: number; value: JNode; comma?: number };
export type Jsonc = { value: unknown; comments: { start: number; end: number }[] };

export class JsoncError extends Error {}

const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
// Своё свойство (в том числе "__proto__"), как у JSON.parse
const put = (o: Record<string, unknown>, k: string, v: unknown) => {
  if (k === "__proto__") Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
  else o[k] = v;
};
const NUM = /true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

// Разбор. path === null — значение и комментарии; path — узлы объектов по этому пути (для правки), без значений:
// остальное только проходится (большой файл — без лишних объектов)
function scan(text: string, path: string[] | null): { value: unknown; root: JNode | null; comments: { start: number; end: number }[] } {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const n = text.length;
  const values = path === null;
  const comments: { start: number; end: number }[] = [];
  const fail = (what: string): never => {
    const before = text.slice(0, i);
    const line = before.split("\n").length;
    throw new JsoncError(`${what} (строка ${line}, столбец ${i - before.lastIndexOf("\n")})`);
  };
  const skip = () => {
    for (;;) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) { i++; continue; }
      if (c === 47 && text.charCodeAt(i + 1) === 47) {
        const s = i;
        while (i < n && text.charCodeAt(i) !== 10 && text.charCodeAt(i) !== 13) i++;
        comments.push({ start: s, end: i });
        continue;
      }
      if (c === 47 && text.charCodeAt(i + 1) === 42) {
        const s = i;
        const e = text.indexOf("*/", i + 2);
        if (e < 0) fail("комментарий /* не закрыт");
        i = e + 2;
        comments.push({ start: s, end: i });
        continue;
      }
      return;
    }
  };
  const str = (): string => {
    const s = i;
    let escaped = false;
    for (i++; i < n; i++) {
      const c = text.charCodeAt(i);
      if (c === 92) { escaped = true; i++; continue; }
      if (c === 34) break;
      if (c < 32) fail("управляющий символ в строке");
    }
    if (i >= n) fail("строка не закрыта");
    i++;
    if (!escaped) return text.slice(s + 1, i - 1);
    try { return JSON.parse(text.slice(s, i)); } catch { return fail("неверная строка"); }
  };
  // Объект или массив вне пути правки: только найти конец (строки, комментарии, скобки) — быстрым поиском; синтаксис
  // целиком проверяет разбор значения (план и сверка после правки)
  const SPECIAL = /["{}[\]/]/g;
  const pass = () => {
    let depth = 0;
    for (;;) {
      SPECIAL.lastIndex = i;
      const m = SPECIAL.exec(text);
      if (!m) { i = n; fail("неожиданный конец файла"); }
      i = m!.index;
      const c = text.charCodeAt(i);
      if (c === 34) {
        // Конец строки: кавычка без чётного числа обратных слэшей перед ней
        let j = i + 1;
        for (;;) {
          j = text.indexOf('"', j);
          if (j < 0) { i = n; fail("строка не закрыта"); }
          let k = j - 1;
          while (text.charCodeAt(k) === 92) k--;
          if ((j - 1 - k) % 2 === 0) break;
          j++;
        }
        i = j + 1;
        continue;
      }
      if (c === 47) {
        const s0 = i;
        skip();
        if (i === s0) fail("неожиданный символ «/»");
        continue;
      }
      i++;
      if (c === 123 || c === 91) depth++;
      else if (--depth === 0) return;
    }
  };
  // depth — глубина на пути (path); onPath — узел нужен
  const value = (depth: number, onPath: boolean): JNode => {
    skip();
    const s = i;
    const c = text.charCodeAt(i);
    if (!values && !onPath && (c === 123 || c === 91)) {
      pass();
      return c === 123 ? { kind: "object", start: s, end: i, members: [], value: {} } : { kind: "array", start: s, end: i, items: [], value: [] };
    }
    if (c === 123) {
      i++;
      const members: JMember[] = [];
      const obj: Record<string, unknown> | undefined = values ? {} : undefined;
      for (;;) {
        skip();
        if (text.charCodeAt(i) === 125) break;
        if (text.charCodeAt(i) !== 34) fail("ожидался ключ или }");
        const ks = i;
        const key = str();
        skip();
        if (text.charCodeAt(i) !== 58) fail("ожидалось :");
        i++;
        const v = value(depth + 1, onPath && !!path && depth < path.length && key === path[depth]);
        skip();
        const comma = text.charCodeAt(i) === 44 ? i : undefined;
        if (onPath) members.push({ key, start: ks, value: v, ...(comma !== undefined && { comma }) });
        if (obj) put(obj, key, v.value);
        if (comma !== undefined) { i++; continue; }
        if (text.charCodeAt(i) === 125) break;
        fail("ожидалось , или }");
      }
      i++;
      return { kind: "object", start: s, end: i, members, value: obj as Record<string, unknown> };
    }
    if (c === 91) {
      i++;
      const items: unknown[] | undefined = values ? [] : undefined;
      for (;;) {
        skip();
        if (text.charCodeAt(i) === 93) break;
        const v = value(depth + 1, false);
        items?.push(v.value);
        skip();
        if (text.charCodeAt(i) === 44) { i++; continue; }
        if (text.charCodeAt(i) === 93) break;
        fail("ожидалось , или ]");
      }
      i++;
      return { kind: "array", start: s, end: i, items: [], value: items as unknown[] };
    }
    if (c === 34) { const v = str(); return { kind: "value", start: s, end: i, value: v }; }
    NUM.lastIndex = i;
    const m = NUM.exec(text);
    if (!m) fail(i >= n ? "неожиданный конец файла" : `неожиданный символ «${text[i]}»`);
    i += m![0].length;
    const t = m![0];
    return { kind: "value", start: s, end: i, value: values ? (t === "true" ? true : t === "false" ? false : t === "null" ? null : Number(t)) : undefined };
  };
  skip();
  if (i >= n) return { value: undefined, root: null, comments };
  const root = value(0, true);
  skip();
  if (i < n) fail("лишний текст после значения");
  return { value: root.value, root, comments };
}

// Значение и комментарии. Строгий JSON — быстрым JSON.parse (комментариев в нём нет)
export function parseJsonc(text: string): Jsonc {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (!body.trim()) return { value: undefined, comments: [] };
  try { return { value: JSON.parse(body), comments: [] }; } catch { /* JSONC или ошибка — свой разбор */ }
  const r = scan(text, null);
  return { value: r.value, comments: r.comments };
}

// Разбор файла как значения: пустой (или только пробелы и комментарии) — {}
export const readJsoncText = (text: string): any => parseJsonc(text).value ?? {};

// Сравнение значений без учёта порядка ключей
export function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, k) => sameValue(x, b[k]));
  if (plain(a) && plain(b)) {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameValue(a[k], b[k]));
  }
  return Object.is(a, b) || a === b;
}

// Стиль файла: перевод строки и шаг отступа (по первой строке с отступом перед ключом)
function style(text: string): { eol: string; unit: string } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lead = text.split(/\r?\n/).map((l) => /^([ \t]+)"/.exec(l)?.[1]).filter((x): x is string => !!x);
  if (!lead.length) return { eol, unit: "  " };
  return { eol, unit: lead.some((l) => l.startsWith("\t")) ? "\t" : " ".repeat(Math.min(...lead.map((l) => l.length))) };
}
const lineStart = (text: string, at: number) => { let k = at; while (k > 0 && text[k - 1] !== "\n") k--; return k; };
const indentAt = (text: string, at: number) => /^[ \t]*/.exec(text.slice(lineStart(text, at)))![0];
// Конец строки после позиции: только пробелы и комментарии до перевода строки — позиция перед ним, иначе null
function restOfLine(text: string, at: number, comments: { start: number; end: number }[]): number | null {
  let k = at;
  for (;;) {
    while (text[k] === " " || text[k] === "\t") k++;
    const c = comments.find((x) => x.start === k && (text[k + 1] === "/" || !text.slice(x.start, x.end).includes("\n")));
    if (c) { k = c.end; continue; }
    break;
  }
  return k >= text.length || text[k] === "\n" || text[k] === "\r" ? k : null;
}
const eolLen = (text: string, at: number) => (text[at] === "\r" && text[at + 1] === "\n" ? 2 : text[at] === "\n" || text[at] === "\r" ? 1 : 0);
// Только пробелы между началом строки и позицией
const ownLine = (text: string, at: number) => !text.slice(lineStart(text, at), at).trim();

// Значение для вставки: в многострочном объекте — с отступами файла, в однострочном — одной строкой
function render(value: unknown, multiline: boolean, indent: string, st: { eol: string; unit: string }): string {
  return multiline ? JSON.stringify(value, null, st.unit).split("\n").join(st.eol + indent) : JSON.stringify(value);
}

// Изменить файл: поставить value по пути (undefined — удалить член). Недостающие объекты по пути создаются. Не объект
// на пути — ошибка (вызывающий сверяет результат и отказывает)
export function editJsonc(text: string, path: string[], value: unknown): string {
  if (!path.length) throw new JsoncError("пустой путь");
  const parsed = scan(text, path);
  if (!parsed.root || parsed.root.kind !== "object") throw new JsoncError("в файле не объект JSON");
  const st = style(text);
  let obj = parsed.root;
  for (let d = 0; d < path.length; d++) {
    const last = d === path.length - 1;
    const m = [...obj.members].reverse().find((x) => x.key === path[d]);
    if (!m) {
      if (value === undefined) return text;
      const nested = path.slice(d + 1).reduceRight<unknown>((v, k) => ({ [k]: v }), value);
      return insertMember(text, obj, path[d], nested, st, parsed.comments);
    }
    if (last) return value === undefined ? removeMember(text, obj, m, parsed.comments) : replaceValue(text, obj, m, value, st);
    if (m.value.kind !== "object") throw new JsoncError(`${path.slice(0, d + 1).join(".")} — не объект`);
    obj = m.value;
  }
  return text;
}

const isMultiline = (text: string, o: { start: number; end: number }) => /[\r\n]/.test(text.slice(o.start, o.end));

function replaceValue(text: string, obj: Extract<JNode, { kind: "object" }>, m: JMember, value: unknown, st: { eol: string; unit: string }): string {
  const multiline = isMultiline(text, obj) || isMultiline(text, m.value);
  return text.slice(0, m.value.start) + render(value, multiline, indentAt(text, m.start), st) + text.slice(m.value.end);
}

function insertMember(text: string, obj: Extract<JNode, { kind: "object" }>, key: string, value: unknown, st: { eol: string; unit: string }, comments: { start: number; end: number }[]): string {
  const k = JSON.stringify(key);
  const objIndent = indentAt(text, obj.start);
  const ms = obj.members;
  if (!ms.length) {
    const inner = text.slice(obj.start + 1, obj.end - 1);
    // Многострочно, если объект уже многострочный или стоит в многострочном файле
    const multiline = /[\r\n]/.test(text);
    if (!multiline) return text.slice(0, obj.start + 1) + `${k}: ${render(value, false, "", st)}` + text.slice(obj.end - 1);
    const indent = objIndent + st.unit;
    const member = `${indent}${k}: ${render(value, true, indent, st)}`;
    if (!inner.trim()) return text.slice(0, obj.start) + `{${st.eol}${member}${st.eol}${objIndent}}` + text.slice(obj.end);
    // Внутри только комментарии: строка перед закрывающей скобкой
    const close = obj.end - 1;
    if (ownLine(text, close)) { const at = lineStart(text, close); return text.slice(0, at) + member + st.eol + text.slice(at); }
    return text.slice(0, close) + st.eol + member + st.eol + objIndent + text.slice(close);
  }
  const last = ms[ms.length - 1];
  const multiline = isMultiline(text, obj);
  if (!multiline) {
    const at = last.comma !== undefined ? last.comma + 1 : last.value.end;
    const piece = last.comma !== undefined ? ` ${k}: ${render(value, false, "", st)},` : `, ${k}: ${render(value, false, "", st)}`;
    return text.slice(0, at) + piece + text.slice(at);
  }
  const indent = ownLine(text, last.start) ? indentAt(text, last.start) : objIndent + st.unit;
  const member = `${indent}${k}: ${render(value, true, indent, st)}`;
  const after = last.comma !== undefined ? last.comma + 1 : last.value.end;
  const eolAt = restOfLine(text, after, comments);
  if (eolAt === null) {
    // После последнего члена на той же строке что-то ещё (закрывающая скобка): с новой строки перед ним
    const piece = (last.comma !== undefined ? "" : ",") + st.eol + member + (last.comma !== undefined ? "," : "");
    return text.slice(0, after) + piece + st.eol + objIndent + text.slice(after).replace(/^[ \t]*/, "");
  }
  const line = st.eol + member + (last.comma !== undefined ? "," : "");
  const comma = last.comma !== undefined ? "" : ",";
  return text.slice(0, last.value.end) + comma + text.slice(last.value.end, eolAt) + line + text.slice(eolAt);
}

function removeMember(text: string, obj: Extract<JNode, { kind: "object" }>, m: JMember, comments: { start: number; end: number }[]): string {
  const ms = obj.members;
  const idx = ms.indexOf(m);
  const end = m.comma !== undefined ? m.comma + 1 : m.value.end;
  const own = ownLine(text, m.start);
  const eolAt = restOfLine(text, end, comments);
  if (ms.length === 1) {
    // Единственный член: члена отдельной строкой нет — строка целиком; объект без комментариев внутри — {}
    const kept = comments.some((c) => c.start > obj.start && c.end < obj.end && (c.end <= m.start || c.start >= end) && !(eolAt !== null && c.start >= end && c.end <= eolAt));
    if (!kept) return text.slice(0, obj.start) + "{}" + text.slice(obj.end);
    if (own && eolAt !== null) { const s = lineStart(text, m.start); return text.slice(0, s) + text.slice(eolAt + eolLen(text, eolAt)); }
    return text.slice(0, m.start) + text.slice(end);
  }
  if (own && eolAt !== null) {
    const s = lineStart(text, m.start);
    let out = text.slice(0, s) + text.slice(eolAt + eolLen(text, eolAt));
    // Последний член без концевой запятой: запятая предыдущего больше не нужна
    if (idx === ms.length - 1 && m.comma === undefined) {
      const prev = ms[idx - 1];
      if (prev.comma !== undefined) out = out.slice(0, prev.comma) + out.slice(prev.comma + 1);
    }
    return out;
  }
  // В одной строке: член с его запятой; последний — вместе с запятой предыдущего
  if (idx === ms.length - 1 && m.comma === undefined) {
    const prev = ms[idx - 1];
    return text.slice(0, prev.value.end) + text.slice(m.value.end);
  }
  const next = ms[idx + 1];
  return text.slice(0, m.start) + text.slice(next ? next.start : end);
}
// Привести текст к ожидаемому значению: правки только там, где значения расходятся (объекты — вглубь по ключам,
// остальное — замена). Порядок: удаление, замена, вставка новых ключей в конец объекта
export function editToValue(text: string, before: unknown, after: unknown, prefix: string[] = []): string {
  if (!plain(before) || !plain(after)) throw new JsoncError("корень — не объект");
  let out = text;
  for (const k of Object.keys(before)) if (!Object.prototype.hasOwnProperty.call(after, k)) out = editJsonc(out, [...prefix, k], undefined);
  for (const [k, v] of Object.entries(after)) {
    if (!Object.prototype.hasOwnProperty.call(before, k)) { out = editJsonc(out, [...prefix, k], v); continue; }
    const was = before[k];
    if (was === v || sameValue(was, v)) continue;
    if (plain(was) && plain(v)) out = editToValue(out, was, v, [...prefix, k]);
    else out = editJsonc(out, [...prefix, k], v);
  }
  return out;
}
