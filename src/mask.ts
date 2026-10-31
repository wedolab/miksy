// Маскировка значений секретов без порчи данных (решение 2026-10-27 о бэкапах; рецензия 2г, Г5).
// Значение заменяется меткой <secret:ИМЯ>:
// - JSON и TOML — только строки (ключи и значения; в TOML ещё комментарии): строка декодируется,
//   маскируется и кодируется заново, только если изменилась; числа, true/false, разметка — как были,
//   результат разбирается;
// - прочие файлы — замена диапазонов байтов, остальные байты (в том числе не UTF-8) — как были;
// - объекты (сообщения JSON-RPC моста) — по строкам до сериализации, служебные поля не трогаются.
// Значение короче MIN символов совпадало бы с чем угодно: оно маскируется только там, где строка
// равна ему целиком (строковое значение JSON/TOML, строка сообщения моста); в тексте прочих файлов —
// нет (ограничение; sync предупреждает о таких секретах).
import { parseToml, tomlValue } from "./toml";

export const MIN = 4;
export type Values = [name: string, value: string][];

const label = (n: string) => `<secret:${n}>`;
const long = (values: Values) => values.filter(([, v]) => v.length >= MIN).sort((a, b) => b[1].length - a[1].length);

// Формы длинного значения внутри строки: как есть, JSON-экранирование (строка несёт вложенный JSON),
// URL-кодирование
const forms = (v: string) => [...new Set([v, JSON.stringify(v).slice(1, -1), encodeURIComponent(v), encodeURI(v)])];

// Содержимое строки: длинные значения — вхождения; короткие — только строка целиком
export function maskString(s: string, values: Values): string {
  for (const [n, v] of values) if (v && v.length < MIN && s === v) return label(n);
  let out = s;
  for (const [n, v] of long(values)) for (const f of forms(v)) if (out.includes(f)) out = out.split(f).join(label(n));
  return out;
}

// Свободный текст (диагностика): длинные — вхождения, короткие — отдельным словом
export function maskText(s: string, values: Values): string {
  let out = maskString(s, values.filter(([, v]) => v.length >= MIN));
  for (const [n, v] of values)
    if (v && v.length < MIN) out = out.replace(new RegExp(`(?<![A-Za-z0-9])${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "g"), label(n));
  return out;
}

// Значение JSON целиком: строки и ключи — maskString; keep — ключи верхнего уровня, которые не трогаются
export function maskValue(v: unknown, values: Values, keep: string[] = []): unknown {
  if (typeof v === "string") return maskString(v, values);
  if (Array.isArray(v)) return v.map((x) => maskValue(x, values));
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => (keep.includes(k) ? [k, x] : [maskString(k, values), maskValue(x, values)])));
  return v;
}

// Текст JSON: строковые токены по месту; null — не JSON
export function maskJson(text: string, values: Values): string | null {
  try { JSON.parse(text); } catch { return null; }
  let out = "";
  let i = 0;
  for (let q = text.indexOf('"'); q >= 0; q = text.indexOf('"', i)) {
    let j = q + 1;
    while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
    const token = text.slice(q, j + 1);
    const value: string = JSON.parse(token);
    const masked = maskString(value, values);
    out += text.slice(i, q) + (masked === value ? token : JSON.stringify(masked));
    i = j + 1;
  }
  return out + text.slice(i);
}

// Текст TOML: строки (все четыре вида) и комментарии по месту; изменённая строка — базовой строкой
// TOML; null — не TOML или итог не разбирается
export function maskToml(text: string, values: Values): string | null {
  try { parseToml(text); } catch { return null; }
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "#") {
      const e = text.indexOf("\n", i);
      const end = e < 0 ? text.length : e;
      out += maskString(text.slice(i, end), values.filter(([, v]) => v.length >= MIN));
      i = end;
      continue;
    }
    if (c !== '"' && c !== "'") { out += c; i++; continue; }
    const delim = text.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
    let j = i + delim.length;
    while (!text.startsWith(delim, j)) j += c === '"' && text[j] === "\\" ? 2 : 1;
    // """a"""" — кавычки сразу перед закрывающими принадлежат строке (до двух)
    let end = j + delim.length;
    if (delim.length === 3) while (end < text.length && text[end] === c && end - j < 5) end++;
    const token = text.slice(i, end);
    const value: string = parseToml(`v = ${token}`).v;
    const masked = maskString(value, values);
    out += masked === value ? token : tomlValue(masked);
    i = end;
  }
  try { parseToml(out); } catch { return null; }
  return out;
}

// Байты: диапазоны длинных значений (как есть, JSON- и TOML-экранирование) → метка; остальное как было
export function maskBytes(data: Buffer, values: Values): Buffer {
  const all = long(values).flatMap(([n, v]) => [...new Set([v, JSON.stringify(v).slice(1, -1), tomlValue(v).slice(1, -1)])].map((f) => [Buffer.from(f), Buffer.from(label(n))] as const))
    .sort((a, b) => b[0].length - a[0].length);
  const out: Buffer[] = [];
  let i = 0;
  for (;;) {
    let at = -1, hit: (typeof all)[number] | undefined;
    for (const f of all) {
      const k = data.indexOf(f[0], i);
      if (k >= 0 && (at < 0 || k < at)) { at = k; hit = f; }
    }
    if (!hit) break;
    out.push(data.subarray(i, at), hit[1]);
    i = at + hit[0].length;
  }
  out.push(data.subarray(i));
  return Buffer.concat(out);
}

// Файл целиком: JSON/TOML (по расширению или разбору) — по строкам, иначе — по байтам
export function maskFile(data: Buffer, name: string, values: Values): Buffer {
  let text: string | null = null;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { /* не UTF-8 — байты */ }
  if (text !== null) {
    const toml = /\.toml$/i.test(name);
    const masked = toml ? maskToml(text, values) : maskJson(text, values);
    if (masked !== null) return Buffer.from(masked);
  }
  return maskBytes(data, values);
}

// Есть ли в данных что маскировать (быстрая проверка до разбора)
export function hasValues(data: Buffer, values: Values): boolean {
  return values.some(([, v]) => v && (v.length < MIN ? data.includes(Buffer.from(v))
    : [v, JSON.stringify(v).slice(1, -1), tomlValue(v).slice(1, -1), encodeURIComponent(v)].some((f) => data.includes(Buffer.from(f)))));
}
