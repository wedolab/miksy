// Ограниченный TOML writer: значения JSON и таблицы MCP; чтение/валидация — Bun.
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";

// Хеш значения, а не оформления: редактор Codex меняет кавычки, порядок ключей и комментарии.
export function definitionHash(value: unknown): string {
  // codex mcp add удаляет пустой args у stdio-серверов (0.160/0.163); отсутствие = [].
  if (object(value) && Array.isArray(value.args) && !value.args.length) {
    value = { ...value }; delete (value as Record<string, unknown>).args;
  }
  const stable = (v: any): any => Array.isArray(v) ? v.map(stable) : object(v)
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v;
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

export const TOML_BEGIN = "# >>> miksy (сгенерировано, не править)";
export const TOML_END = "# <<< miksy";
const MARK_START = new RegExp(String.raw`^# >>> miksy[^\r\n]*(?:\r?\n|$)`, "gm");
const MARK_STOP = new RegExp(String.raw`^# <<< miksy[^\r\n]*(?:\r?\n|$)`, "gm");
const isBegin = (line: string) => line === TOML_BEGIN;
const isEnd = (line: string) => line === TOML_END;
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

export function parseToml(text: string): Record<string, any> {
  try { return Bun.TOML.parse(text); } catch { throw new Error("TOML: файл или управляемый блок не разбирается"); }
}

export function tomlValue(value: unknown): string {
  // Bun 1.3.14 меняет местами \\t и \\f при чтении TOML; Unicode-формы
  // корректны и для Bun, и для нативного парсера Codex.
  if (typeof value === "string") return JSON.stringify(value)
    .replace(/\\./g, (s) => s === "\\t" ? "\\u0009" : s === "\\f" ? "\\u000C" : s)
    .replace(/\u007f/g, "\\u007F");
  if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (object(value)) return `{ ${Object.entries(value).map(([k, v]) => `${tomlValue(k)} = ${tomlValue(v)}`).join(", ")} }`;
  throw new Error("TOML: поддерживаются только строки, конечные числа, boolean, массивы и объекты (без null)");
}

export function mcpTables(servers: Record<string, unknown>): string {
  const lines: string[] = [];
  function table(key: string[], values: Record<string, unknown>) {
    lines.push(`[${key.map(tomlValue).join(".")}]`);
    for (const [k, v] of Object.entries(values)) if (!object(v)) lines.push(`${tomlValue(k)} = ${tomlValue(v)}`);
    for (const [k, v] of Object.entries(values)) if (object(v)) {
      lines.push("");
      table([...key, k], v);
    }
  }
  for (const [name, def] of Object.entries(servers)) {
    if (!object(def)) throw new Error("TOML: определение MCP-сервера должно быть объектом");
    if (lines.length) lines.push("");
    table(["mcp_servers", name], def);
  }
  return lines.length ? lines.join("\n") + "\n" : "";
}

export interface TomlParts {
  before: string; // текст до блока (без служебного перевода строки блока)
  after: string; // текст после блока: Codex дописывает сюда trust проектов
  outside: string; // before + after — весь текст вне блока
  block: string;
  servers: Record<string, unknown>;
  external: Record<string, unknown>;
}

// Текст вне блока целиком; если служебный перевод строки был единственным разделителем — сохранить его
const join2 = (before: string, after: string) => before + (after && before && !before.endsWith("\n") ? "\n" : "") + after;

export function splitToml(text: string): TomlParts {
  // Ошибки Bun могут содержать секретную строку: наружу только общий диагноз.
  const parse = parseToml;
  const full = parse(text);
  const starts = [...text.matchAll(MARK_START)];
  const ends = [...text.matchAll(MARK_STOP)];
  if (!starts.length && !ends.length) return { before: text, after: "", outside: text, block: "", servers: {}, external: full.mcp_servers ?? {} };
  if (starts.length !== 1 || ends.length !== 1) throw new Error("TOML: повреждённые или повторные маркеры miksy");
  const start = starts[0], end = ends[0];
  if (!isBegin(start[0].trimEnd()) || !isEnd(end[0].trimEnd()) || end.index! < start.index!)
    throw new Error("TOML: неизвестные или переставленные маркеры miksy");
  let offset = start.index!;
  // Добавленный нами разделитель принадлежит блоку; исходный текст вне блока не меняется.
  if (offset > 0 && text[offset - 1] === "\n") offset -= 1;
  const close = end.index! + end[0].length;
  const before = text.slice(0, offset);
  const after = text.slice(close);
  const outside = join2(before, after);
  const body = text.slice(start.index! + start[0].length, end.index);
  const parsed = parse(body);
  if (Object.keys(parsed).some((key) => key !== "mcp_servers") || !object(parsed.mcp_servers)
      || Object.values(parsed.mcp_servers).some((v) => !object(v)))
    throw new Error("TOML: в блоке разрешены только таблицы MCP");
  const first = body.split(/\r?\n/).find((line) => line.trim() && !line.trim().startsWith("#"));
  if (!first?.trim().startsWith("[")) throw new Error("TOML: блок должен начинаться с таблицы MCP");
  for (const line of body.split(/\r?\n/).filter((s) => s.trim().startsWith("["))) {
    const probe = parse(line + "\n__miksy_probe__ = 1\n");
    if (Object.keys(probe).length !== 1 || !object(probe.mcp_servers)
        || Object.values(probe.mcp_servers).some((v) => !object(v)))
      throw new Error("TOML: в блоке разрешены только [mcp_servers.<name>] и их подтаблицы");
  }
  const base = parse(outside);
  const external = base.mcp_servers ?? {};
  if (Object.keys(parsed.mcp_servers).some((name) => Object.hasOwn(external, name)))
    throw new Error("TOML: имя MCP определено и вне блока, и внутри него");
  const expected = { ...base, mcp_servers: { ...external, ...parsed.mcp_servers } };
  // Защита от маркеров внутри многострочных TOML-строк, от неоднозначной области таблиц и от хвоста
  // после блока, который без заголовка таблицы продолжил бы последнюю таблицу блока.
  if (!isDeepStrictEqual(full, expected)) throw new Error("TOML: маркеры не ограничивают самостоятельные таблицы MCP");
  return { before, after, outside, block: text.slice(offset, close), servers: parsed.mcp_servers, external };
}

// Блок заменяется на месте (текст до и после сохраняется побайтно); нового блока ещё не было — в конец файла
export function replaceTomlBlock(parts: TomlParts, servers: Record<string, unknown>): string {
  for (const name of Object.keys(servers)) if (Object.hasOwn(parts.external, name))
    throw new Error(`TOML: имя MCP ${name} уже есть вне блока`);
  const tables = mcpTables(servers);
  // Bun допускает расширение inline-таблицы, но TOML/Codex запрещает его.
  if (tables && /^\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*=/m.test(parts.outside))
    throw new Error("TOML: mcp_servers задан присваиванием вне блока; безопасно добавить таблицы нельзя");
  const block = tables ? `\n${TOML_BEGIN}\n${tables}${TOML_END}\n` : "";
  const content = block ? parts.before + block + parts.after : join2(parts.before, parts.after);
  try { Bun.TOML.parse(content); } catch { throw new Error("TOML: итоговый файл не разбирается; запись отменена"); }
  return content;
}

// Заголовки таблиц вне строк/комментариев. Сам TOML проверяет Bun; сканер нужен только для
// диапазонов исходного текста, чтобы не сериализовать чужие настройки и комментарии.
export function tableSections(text: string): { start: number; end: number; key: string[] }[] {
  parseToml(text);
  const headers: { start: number; end: number; key: string[] }[] = [];
  let quote = "", triple = false, lineStart = true;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (quote === '"' && c === "\\") { i++; continue; }
      if (triple ? text.slice(i, i + 3) === quote.repeat(3) : c === quote) {
        if (triple) i += 2;
        quote = ""; triple = false;
      }
      lineStart = c === "\n";
      continue;
    }
    if (lineStart && c === "[") {
      const end = text.indexOf("\n", i);
      const line = text.slice(i, end < 0 ? text.length : end);
      const doc = parseToml(line + "\n__miksy_probe__ = true\n");
      const key: string[] = [];
      let node: any = doc;
      while (node && !Object.hasOwn(node, "__miksy_probe__")) {
        if (Array.isArray(node)) node = node[0];
        else { const ks = Object.keys(node); if (ks.length !== 1) break; key.push(ks[0]); node = node[ks[0]]; }
      }
      headers.push({ start: i, end: text.length, key });
    }
    if (c === "#") { const e = text.indexOf("\n", i); if (e < 0) break; i = e; lineStart = true; continue; }
    if (c === '"' || c === "'") {
      quote = c; triple = text.slice(i, i + 3) === c.repeat(3); if (triple) i += 2;
    }
    if (c === "\n") lineStart = true;
    else if (c !== " " && c !== "\t" && c !== "\r") lineStart = false;
  }
  for (let i = 0; i < headers.length - 1; i++) headers[i].end = headers[i + 1].start;
  return headers;
}

// Начала строк вне строковых значений: строка внутри """…""" или '''…''' — часть значения, а не
// ключ (правка поля по такому началу не заденет текст многострочной строки)
export function lineStarts(text: string): number[] {
  const out = [0];
  let quote = "", triple = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (quote === '"' && c === "\\") { i++; continue; }
      if (triple ? text.slice(i, i + 3) === quote.repeat(3) : c === quote) {
        if (triple) i += 2;
        quote = ""; triple = false;
      }
      continue;
    }
    if (c === "#") { const e = text.indexOf("\n", i); if (e < 0) break; i = e - 1; continue; }
    if (c === '"' || c === "'") { quote = c; triple = text.slice(i, i + 3) === c.repeat(3); if (triple) i += 2; continue; }
    if (c === "\n") out.push(i + 1);
  }
  return out;
}

// Удаляет поле key таблицы table (точное имя): строку ключа вне строковых значений; итог сверяется
// разбором — изменилось только это поле, иначе ошибка (текст не меняется)
export function removeField(text: string, table: string[], key: string): string {
  const section = tableSections(text).find((s) => s.key.length === table.length && s.key.every((k, i) => k === table[i]));
  if (!section) throw new Error("TOML: таблица не найдена");
  const starts = lineStarts(text);
  const rx = new RegExp(`^[ \\t]*(?:${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|"${key}"|'${key}')[ \\t]*=`);
  const hits = starts.filter((s) => s >= section.start && s < section.end && rx.test(text.slice(s, s + key.length + 64)));
  if (hits.length !== 1) throw new Error(`TOML: поле ${key} не найдено однозначно — не меняю`);
  const next = starts.find((s) => s > hits[0]) ?? text.length;
  const out = text.slice(0, hits[0]) + text.slice(next);
  const expected = structuredClone(parseToml(text));
  let node: any = expected;
  for (const k of table) node = node?.[k];
  if (node) delete node[key];
  if (!isDeepStrictEqual(parseToml(out), expected)) throw new Error(`TOML: поле ${key} не удалось удалить безопасно — не меняю`);
  return out;
}

export function removeTables(text: string, prefix: string[]): string {
  const parts = tableSections(text).filter((h) => prefix.every((k, i) => h.key[i] === k));
  let out = text;
  for (const h of parts.reverse()) out = out.slice(0, h.start) + out.slice(h.end);
  const expected = structuredClone(parseToml(text));
  let node: any = expected;
  for (const k of prefix.slice(0, -1)) node = node?.[k];
  if (node) delete node[prefix.at(-1)!];
  // Пустые неявные родители исчезают вместе с последней дочерней таблицей.
  const prune = (o: any): any => object(o) ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, prune(v)])
    .filter(([, v]) => !object(v) || Object.keys(v).length)) : o;
  if (!isDeepStrictEqual(prune(parseToml(out)), prune(expected)))
    throw new Error("TOML: таблица задана inline или неоднозначно; безопасно изменить по имени нельзя");
  return out;
}

export function ownedTomlParts(text: string, tracked = false): TomlParts {
  try { return splitToml(text); }
  catch (e) {
    if (!tracked) throw e;
    const stripped = text.replace(MARK_START, "").replace(MARK_STOP, "");
    if (!isDeepStrictEqual(parseToml(text), parseToml(stripped))) throw e;
    return splitToml(stripped);
  }
}

export function replaceOwnedMcp(text: string, names: string[], data: Record<string, unknown>, tracked = false): string {
  const parts = ownedTomlParts(text, tracked);
  // Обычный блок: остаётся на прежнем месте, включая исходный prefix без перевода строки.
  if (parts.block && Object.keys(parts.servers).every((n) => names.includes(n)) && names.every((n) => !(n in parts.external)))
    return replaceTomlBlock(parts, data);
  let outside = parts.block ? parts.before + parts.block.replace(MARK_START, "").replace(MARK_STOP, "") + parts.after : parts.outside;
  for (const name of names) outside = removeTables(outside, ["mcp_servers", name]);
  return replaceTomlBlock(splitToml(outside), data);
}
