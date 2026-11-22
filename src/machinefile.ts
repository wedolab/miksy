// Правка одного ключа верхнего уровня в local/machine.yaml строками: остальное в файле (другие ключи, комментарии,
// BOM, переводы строк) не меняется. Проверка разбором: прочие ключи не изменились, ключ — ровно ожидаемый.
// workspace — src/rootfile.ts (root add/remove), список строк (mcp_off) — rewriteList (miksy mcp off/on)
import { parseYaml } from "./load";

// Область ключа: строка ключа и строки его значения (отступ, пустые, комментарии — до следующего ключа верхнего
// уровня). quoted — и ключ в кавычках («"key": …»); head — где в строке ключа начинается значение
export function keyRegion(lines: string[], key: string, quoted = false): { at: number; end: number; head: number } | null {
  const name = (l: string) => (l.startsWith(`${key}:`) ? key.length + 1
    : quoted ? (l.match(new RegExp(`^(["'])${key}\\1\\s*:`))?.[0].length ?? -1) : -1);
  const at = lines.findIndex((l) => name(l) >= 0);
  if (at < 0) return null;
  let end = at + 1;
  // Элементы списка бывают и без отступа («- a» под «key:»)
  while (end < lines.length && (/^\s/.test(lines[end]) || /^-( |$)/.test(lines[end]) || /^\s*(#.*)?$/.test(lines[end]))) end++;
  // Хвостовые пустые строки и комментарии без отступа — уже не значение ключа
  while (end > at + 1 && /^(#.*)?$/.test(lines[end - 1])) end--;
  return { at, end, head: name(lines[at]) };
}

export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
// Остальные ключи файла — для проверки, что правка их не задела
export const restOf = (d: Record<string, unknown>, key: string) =>
  JSON.stringify(Object.fromEntries(Object.entries(d).filter(([k]) => k !== key).sort(([a], [b]) => a.localeCompare(b))));

// BOM в начале (PowerShell 5.1, Блокнот) — сохраняется, как был; loadMachine его тоже принимает
export const keepBom = (source: string, edit: (text: string) => string) => {
  const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
  return bom + edit(source.slice(bom.length));
};

// Без кавычек — только имя, которое YAML прочтёт строкой: начинается с буквы или «_» (123, 1e3, 0x1F, 07 — числа)
const plainText = (s: string) => (/^[A-Za-z_][A-Za-z0-9._-]*$/.test(s) && !/^(true|false|null|yes|no|on|off|~)$/i.test(s) ? s : JSON.stringify(s));

// Новый текст machine.yaml: key = items (список строк). Пустой список — ключ убирается. Блочный список правится
// по строкам (оставшиеся элементы и комментарии при них — как были), прочие формы записываются заново блочным
export function rewriteList(source: string, key: string, items: string[]): string {
  return keepBom(source, (text) => {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = text.split(/\r?\n/);
    const doc = (parseYaml(text) ?? {}) as Record<string, unknown>;
    const old = Array.isArray(doc[key]) ? (doc[key] as unknown[]) : [];
    const r = keyRegion(lines, key, true);
    // Ключ есть, но записан так, что строкой его не найти (сложная форма YAML), — не дописывать второй
    if (!r && key in doc) throw new Error(`local/machine.yaml: ${key} не изменить строками — поправьте файл вручную`);
    const block = (indent: string) => [`${key}:`, ...items.map((it) => `${indent}- ${plainText(it)}`)];
    let next: string[];
    if (!r) {
      if (!items.length) return text;
      // В конец файла; последний перевод строки — после списка
      const tail = lines.length && lines[lines.length - 1] === "" ? 1 : 0;
      next = [...lines.slice(0, lines.length - tail), ...block("  "), ""];
    } else if (!items.length) {
      next = [...lines.slice(0, r.at), ...lines.slice(r.end)];
    } else {
      const head = lines[r.at].slice(r.head).trim();
      const body = lines.slice(r.at + 1, r.end);
      const lead = (l: string) => l.match(/^\s*/)![0];
      const starts = body.flatMap((l, i) => (/^\s*-( |$)/.test(l) ? [i] : []));
      const indent = starts.length ? lead(body[starts[0]]) : "  ";
      const own = starts.filter((i) => lead(body[i]) === indent);
      if ((!head || head.startsWith("#")) && own.length && own.length === old.length) {
        // Элемент с комментариями после него — как был; новый — строкой
        const chunks = own.map((s, k) => body.slice(s, k + 1 < own.length ? own[k + 1] : body.length));
        const out = items.flatMap((it) => {
          const i = old.findIndex((o) => o === it);
          return i >= 0 ? chunks[i] : [`${indent}- ${plainText(it)}`];
        });
        next = [...lines.slice(0, r.at + 1), ...body.slice(0, own[0]), ...out, ...lines.slice(r.end)];
      } else {
        // Строка или flow-список — заново, блочным списком; комментарий строки ключа остаётся при ней
        const comment = head.match(/(^|\s)#.*$/)?.[0]?.trim();
        const [first, ...more] = block("  ");
        next = [...lines.slice(0, r.at), `${first}${comment ? ` ${comment}` : ""}`, ...more, ...lines.slice(r.end)];
      }
    }
    const after = next.join(eol);
    let parsed: Record<string, unknown>;
    try { parsed = (parseYaml(after) ?? {}) as Record<string, unknown>; } catch { parsed = {}; }
    if (restOf(parsed, key) !== restOf(doc, key) || !same(parsed[key] ?? [], items))
      throw new Error(`local/machine.yaml: ${key} не изменить строками — поправьте файл вручную`);
    return after;
  });
}
