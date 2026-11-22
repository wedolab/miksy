// Блоки miksy в .git/info/exclude проекта. У каждого агента свой блок, а с круга 10z — у каждой машины свой: проект в
// общей папке (облако, NAS) видят две машины, и у каждой свой miksy со своим учётом. Машина пишет и снимает только свой
// блок (с меткой своего номера — src/machineid.ts); строки блоков других машин — улика «файл другой машины» (DESIGN
// §8.3, «Машины в общей папке»). Блок без метки — записанный прежней версией: свой, если его строки есть в учёте этой
// машины (apply.ts), иначе другой машины на прежней версии. Прежние версии ищут точный заголовок без метки — блоки с
// меткой они не видят и не трогают.
//   # >>> miksy:claude (машина 7f3a9c41d2e0; сгенерировано, не править)
//   /CLAUDE.local.md
//   # <<< miksy:claude (машина 7f3a9c41d2e0)
// owner — id агента (под прежним именем — тоже), у общего exclude worktree — «агент@каталог»
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type ExcludeBlock = { owner: string; machine: string | null; lines: string[] };

const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const MACHINE_RX = "[0-9a-f]{6,32}";

export const beginLine = (owner: string, machine: string | null) =>
  machine ? `# >>> miksy:${owner} (машина ${machine}; сгенерировано, не править)` : `# >>> miksy:${owner} (сгенерировано, не править)`;
export const endLine = (owner: string, machine: string | null) => (machine ? `# <<< miksy:${owner} (машина ${machine})` : `# <<< miksy:${owner}`);

// Тело блока: строки до строки конца, но не через начало другого блока miksy (блок без строки конца не «проглатывает»
// следующие); \r в конце строк заголовков терпится (файл пересохранён с CRLF)
const BODY = "(?:(?!^# >>> miksy:)[\\s\\S])*?";
const EOL = "\\r?$";

// Блок owner одной машины (machine: null — без метки); edge — с соседними переводами строк (для удаления)
export const blockRx = (owner: string, machine: string | null, flags = "m", edge = true) =>
  new RegExp(`${edge ? "\\n?" : ""}^${escapeRx(beginLine(owner, machine))}${EOL}${BODY}^${escapeRx(endLine(owner, machine))}${EOL}${edge ? "\\n?" : ""}`, flags);

const linesIn = (block: string) => block.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l && !l.startsWith("# "));

// Все блоки owner: без метки и всех машин
export function blocksOf(text: string, owner: string): ExcludeBlock[] {
  const out: ExcludeBlock[] = [];
  const plain = text.match(blockRx(owner, null));
  if (plain) out.push({ owner, machine: null, lines: linesIn(plain[0]) });
  const o = escapeRx(owner);
  const rx = new RegExp(`^# >>> miksy:${o} \\(машина (${MACHINE_RX}); сгенерировано, не править\\)${EOL}(${BODY})^# <<< miksy:${o} \\(машина \\1\\)${EOL}`, "gm");
  for (const m of text.matchAll(rx)) if (!out.some((b) => b.machine === m[1])) out.push({ owner, machine: m[1], lines: linesIn(m[2]) });
  return out;
}

// Строки всех блоков miksy (любого агента и машины)
export function allMiksyLines(text: string): string[] {
  return [...text.matchAll(new RegExp(`^# >>> miksy:(\\S+) \\((?:машина ${MACHINE_RX}; )?сгенерировано, не править\\)${EOL}(${BODY})^# <<< miksy:\\1(?: \\(машина ${MACHINE_RX}\\))?${EOL}`, "gm"))]
    .flatMap((m) => linesIn(m[2]));
}

// Машины, чьи блоки есть в файле (любого агента); null — блок без метки
export function machinesIn(text: string): (string | null)[] {
  return [...text.matchAll(new RegExp(`^# >>> miksy:\\S+ \\((?:машина (${MACHINE_RX}); )?сгенерировано, не править\\)${EOL}`, "gm"))].map((m) => m[1] ?? null);
}

// Убрать блок (в начале файла — без пустой первой строки); set — заменить блок на месте (нет блока — дописать в конец)
export function removeBlock(text: string, owner: string, machine: string | null): string {
  const out = text.replace(blockRx(owner, machine, "gm"), "\n");
  return out !== text && !text.startsWith("\n") ? out.replace(/^\n/, "") : out;
}
export function setBlock(text: string, owner: string, machine: string | null, lines: string[], append = true): string {
  if (!lines.length) return removeBlock(text, owner, machine);
  const body = `${beginLine(owner, machine)}\n${lines.join("\n")}\n${endLine(owner, machine)}`;
  if (!append && blockRx(owner, machine, "m", false).test(text)) return text.replace(blockRx(owner, machine, "m", false), () => body);
  return removeBlock(text, owner, machine).replace(/\n*$/, "") + `\n${body}\n`;
}

// Покрывает ли строка блока exclude (точная строка файла или строка каталога) путь проекта rel
export const coveredBy = (lines: string[], rel: string) => lines.some((l) => l === `/${rel}` || (l.endsWith("/") && `/${rel}`.startsWith(l)));

// Есть ли за строкой файл: точная строка — файл (или что-то) на месте, строка каталога — в каталоге есть файлы.
// Строку без файла может снять любая машина — скрывать нечего (облако может принести exclude раньше файлов: тогда
// машина-хозяин вернёт строку своим следующим sync)
export function lineAlive(dir: string, line: string): boolean {
  const rel = line.replace(/^\//, "").replace(/\/$/, "");
  if (!rel || rel.split("/").includes("..")) return true;
  const p = join(dir, rel);
  if (!line.endsWith("/")) return existsSync(p);
  const any = (d: string): boolean => {
    let names: string[];
    try { names = readdirSync(d); } catch { return false; }
    return names.some((n) => { try { return statSync(join(d, n)).isDirectory() ? any(join(d, n)) : true; } catch { return true; } });
  };
  return any(p);
}

// Файл exclude каталога (обычный репо: .git/info/exclude) — текст или ""
export function excludeText(dir: string): string {
  const p = join(dir, ".git", "info", "exclude");
  try { return existsSync(p) && statSync(join(dir, ".git")).isDirectory() ? readFileSync(p, "utf8") : ""; } catch { return ""; }
}
