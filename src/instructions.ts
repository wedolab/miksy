// Общий markdown: владеем только одним блоком, текст вокруг сохраняется побайтно.
import { createHash } from "node:crypto";

export const INSTRUCTIONS_BEGIN = "<!-- miksy:begin инструкции -->";
export const INSTRUCTIONS_END = "<!-- miksy:end -->";

const BEGIN_RX = new RegExp(String.raw`^<!-- miksy:begin[^\r\n]*-->(?:\r?\n|$)`, "gm");
const END_RX = new RegExp(String.raw`^<!-- miksy:end -->(?:\r?\n|$)`, "gm");

// Строка правил, похожая на маркер (правило про сам miksy), сдвигается пробелом: иначе файл
// перестал бы разбираться (повторные маркеры) после первого же sync
const escapeMarkers = (s: string) => s.replace(/^(?=<!-- miksy:(?:begin|end))/gm, " ");

export function instructionBlock(content: string, separator = false): string {
  return `${separator ? "\n<!-- miksy:begin инструкции separator -->" : INSTRUCTIONS_BEGIN}\n${escapeMarkers(content).replace(/\n?$/, "\n")}${INSTRUCTIONS_END}\n`;
}

// Хеш блока не зависит от концов строк: редактор Windows пересохраняет файл с CRLF
export const blockHash = (block: string) => createHash("sha256").update(block.replace(/\r\n/g, "\n")).digest("hex");

// hash — учтённый хеш блока: файл, записанный до экранирования маркеров (строка-маркер внутри
// блока), разбирается по нему — блоком считается пара маркеров с этим хешем
export function splitInstructions(text: string, hash?: string) {
  const starts = [...text.matchAll(BEGIN_RX)];
  const ends = [...text.matchAll(END_RX)];
  if (!starts.length && !ends.length) return { before: text, block: "", after: "" };
  const cut = (s: RegExpMatchArray, e: RegExpMatchArray) => {
    // Служебный перевод строки перед маркером-разделителем (в файле с CRLF — \r\n) принадлежит блоку
    const sep = s[0].includes(" separator -->") && s.index! > 0 && text[s.index! - 1] === "\n" ? (text[s.index! - 2] === "\r" ? 2 : 1) : 0;
    const start = s.index! - sep, end = e.index! + e[0].length;
    return { before: text.slice(0, start), block: text.slice(start, end), after: text.slice(end) };
  };
  if (starts.length === 1 && ends.length === 1 && starts[0].index! < ends[0].index!) return cut(starts[0], ends[0]);
  if (hash)
    for (const s of starts) for (const e of ends) {
      if (e.index! <= s.index!) continue;
      const parts = cut(s, e);
      if (blockHash(parts.block) === hash) return parts;
    }
  throw new Error("инструкции: повреждённые или повторные маркеры miksy — восстановите границы блока");
}

// Текст вне блока после его снятия: стык без перевода строки (чужой текст без LF + дописанное после
// блока) — один \n, иначе строки склеились бы
export function joinOutside(before: string, after: string): string {
  if (!before || !after || before.endsWith("\n") || after.startsWith("\n") || after.startsWith("\r\n")) return before + after;
  return `${before}${after.includes("\r\n") ? "\r\n" : "\n"}${after}`;
}
