// Границы файловой системы: куда miksy вправе писать и что вправе удалять.
// Путь сравнивается в каноническом виде: симлинки и junction в существующей части пути раскрыты,
// `..` свёрнуты. Цель должна оставаться внутри своего корня (проект или домашний каталог).
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const slash = (p: string) => p.replaceAll("\\", "/");

// macOS бывает регистрозависимой: существующее написание определяет realpath.
export const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
export function pathKey(p: string): string {
  try { return canonical(p); }
  // Битая ссылка не имеет физической идентичности. Сохраняем исходный ключ
  // для диагностики; escapes/guard откажут в записи или удалении.
  catch { return slash(resolve(p)); }
}
export const samePath = (a: string, b: string) => fold(canonical(a)) === fold(canonical(b));

// Own-файл MCP нужен ради keep (пропущенный сервер, записанный раньше), только если он уже записан
// miksy: на первом sync сохранять нечего, пустой файл лишь конфликтовал бы с файлом пользователя
export const keepOwn = (ctx: { keep?: string[]; ownedFiles: string[] } | undefined, abs: string) =>
  !!ctx?.keep?.length && ctx.ownedFiles.some((f) => fold(pathKey(f)) === fold(pathKey(abs)));

// Bun может кешировать os.homedir() до preload. Окружение имеет приоритет.
export function homeDir(): string {
  const home = (process.platform === "win32" ? process.env.USERPROFILE ?? process.env.HOME : process.env.HOME ?? process.env.USERPROFILE) || homedir();
  try { return canonical(home); }
  catch (e) { throw new Error(`домашний каталог ${slash(home)} не раскрывается: ${(e as Error).message}`); }
}

const exists = (p: string) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

// Канонический путь: realpath ближайшего существующего предка + несуществующий остаток.
// Битый симлинк в пути — ошибка: куда он поведёт после создания цели, неизвестно
export function canonical(path: string): string {
  let p = resolve(path);
  const rest: string[] = [];
  while (!exists(p)) {
    const up = dirname(p);
    if (up === p) break;
    rest.unshift(basename(p));
    p = up;
  }
  let real: string;
  try {
    real = realpathSync.native(p);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new Error(`${slash(p)}: ${code === "EACCES" || code === "EPERM" ? "нет доступа (права каталога)"
      : code === "ELOOP" ? "цикл симлинков"
      : code === "ENOENT" || code === "ENOTDIR" ? "симлинк указывает на несуществующий путь"
      : `путь не раскрывается (${code ?? "ошибка"})`}`);
  }
  return slash(rest.length ? join(real, ...rest) : real);
}

// Лежит ли path внутри root (или совпадает с ним). Без обращения к диску.
// На Windows relative() для другого диска возвращает абсолютный путь — это «снаружи»
export function inside(path: string, root: string): boolean {
  const rel = relative(fold(resolve(root)), fold(resolve(path)));
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

// null — путь (после раскрытия симлинков) внутри одного из корней; иначе причина отказа
export function escapes(path: string, ...roots: string[]): string | null {
  try {
    const real = canonical(path);
    if (roots.some((r) => inside(real, canonical(r)))) return null;
    const plain = slash(resolve(path));
    const where = roots.map(slash).join(" или ");
    return fold(real) === fold(plain) ? `путь вне ${where}` : `путь ведёт через симлинк в ${real} — вне ${where}`;
  } catch (e) {
    return (e as Error).message;
  }
}

// Для записи и удаления: ошибка, если путь вышел за корни
export function guard(path: string, ...roots: string[]) {
  const why = escapes(path, ...roots);
  if (why) throw new Error(`${path}: ${why} — не трогаю`);
}

// Относительный путь из адаптера или учёта: без .., без абсолютного начала и диска
export function safeRelative(p: string): boolean {
  const s = slash(p);
  return !!s && !isAbsolute(s) && !/^[A-Za-z]:/.test(s) && !s.split("/").some((x) => x === ".." || x === ".");
}
