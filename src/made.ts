// Что создал miksy (круг 11v): папки и файлы-обёртки, которых не было до первой записи miksy. По этому учёту sync и
// clean убирают начисто: опустевшую папку и файл, где после снятия своего не осталось ничего, кроме созданного miksy.
// Чего здесь нет (было до miksy, чужое, записано версией до 11v), не удаляется никогда. Учёт общий для машины, а не
// цели: одну папку делят цели и агенты (~/.agents/skills), её уберёт clean той, после которой она опустеет
import { existsSync, lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fold, inside, pathKey, slash } from "./paths";

// Путь записи — как его писал miksy (без раскрытия ссылок): папку, которую потом заменили ссылкой (junction), учёт не
// переносит на то, куда она ведёт
const norm = (p: string) => slash(resolve(p));
const same = (a: string, b: string) => fold(norm(a)) === fold(norm(b));
export const madeDir = (made: Made | undefined, p: string) => !!made?.dirs?.some((d) => same(d, p));
export const madeFile = (made: Made | undefined, p: string): string[] | undefined => Object.entries(made?.files ?? {}).find(([f]) => same(f, p))?.[1];
export const madeKeys = (made: Made | undefined, p: string): string[] => Object.entries(made?.keys ?? {}).find(([f]) => same(f, p))?.[1] ?? [];

// dirs — папки; files — файл-обёртка → пути объектов JSON, которые создал miksy (JSON-массив ключей; у TOML пусто);
// keys — файл, который был до miksy, → пути объектов, которые создал в нём miksy (круг 11y: опустевший такой объект
// clean убирает и на верхнем уровне — «"mcp": {}» не остаётся)
export type Made = { dirs?: string[]; files?: Record<string, string[]>; keys?: Record<string, string[]> };

const names = (v: unknown): v is string[] => Array.isArray(v) && v.every((n) => typeof n === "string");
export const validMade = (v: unknown): v is Made => !!v && typeof v === "object" && !Array.isArray(v)
  && ((v as Made).dirs === undefined || names((v as Made).dirs))
  && ((v as Made).files === undefined || (!!(v as Made).files && typeof (v as Made).files === "object" && Object.values((v as Made).files!).every(names)))
  && ((v as Made).keys === undefined || (!!(v as Made).keys && typeof (v as Made).keys === "object" && Object.values((v as Made).keys!).every(names)));

// Ключи без повторов (переезд каталога — map), пустое — прочь
export function normalizeMade(m: Made | undefined, map: (p: string) => string = (p) => p): Made | undefined {
  if (!m) return undefined;
  const dirs = [...new Set((m.dirs ?? []).map((d) => norm(map(d))))].sort();
  const lists = (from: Record<string, string[]> | undefined) => {
    const out: Record<string, string[]> = {};
    for (const [f, list] of Object.entries(from ?? {})) {
      const key = norm(map(f));
      out[key] = [...new Set([...(out[key] ?? []), ...list])].sort();
    }
    return out;
  };
  const files = lists(m.files);
  const keys = Object.fromEntries(Object.entries(lists(m.keys)).filter(([, l]) => l.length));
  const out: Made = { ...(dirs.length && { dirs }), ...(Object.keys(files).length && { files }), ...(Object.keys(keys).length && { keys }) };
  return out.dirs || out.files || out.keys ? out : undefined;
}

// Перед записью файла: недостающие папки между корнем цели (проект, дом — не включая его) и файлом
export function noteDirs(made: Made | undefined, file: string, root: string | undefined) {
  if (!made || !root) return;
  for (let d = slash(dirname(file)); inside(d, root) && pathKey(d) !== pathKey(root) && !existsSync(d); d = slash(dirname(d)))
    if (!madeDir(made, d)) (made.dirs ??= []).push(norm(d));
}

// Пути объектов документа JSON (кроме корня): ["a"], ["a","b"]…
export function objectPaths(doc: unknown, prefix: string[] = []): string[] {
  if (!plain(doc)) return [];
  return Object.entries(doc).flatMap(([k, v]) => plain(v) ? [JSON.stringify([...prefix, k]), ...objectPaths(v, [...prefix, k])] : []);
}
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// После записи файла-обёртки: файла не было — он создан miksy со всеми объектами; был и создан miksy раньше — к его
// объектам добавляются новые, исчезнувшие уходят (объект, который потом заведёт агент, — не созданный miksy)
export function noteFile(made: Made | undefined, file: string, existed: boolean, before: unknown, after: unknown) {
  if (!made) return;
  const mine = madeFile(made, file);
  if (existed && !mine) {
    // Файл был до miksy: какие объекты в нём создал miksy (круг 11y). Учёт до этой версии их не знает — остаток {}
    const keys = createdAfter(madeKeys(made, file), before, after);
    for (const f of Object.keys(made.keys ?? {})) if (same(f, file)) delete made.keys![f];
    if (keys.length) (made.keys ??= {})[norm(file)] = keys;
    if (made.keys && !Object.keys(made.keys).length) delete made.keys;
    return;
  }
  forgetMade(made, file);
  (made.files ??= {})[norm(file)] = createdAfter(mine ?? [], existed ? before : {}, after);
}
// Объекты после записи, созданные miksy: его прежние и новые (которых не было до записи)
export function createdAfter(mine: string[], before: unknown, after: unknown): string[] {
  const had = new Set(objectPaths(before));
  return objectPaths(after).filter((p) => mine.includes(p) || !had.has(p)).sort();
}

// Файл-обёртка — только созданное miksy: каждый ключ — пустой объект или объект, созданный miksy; TOML — пустой текст
export function skeleton(doc: unknown, created: string[], prefix: string[] = []): boolean {
  if (!plain(doc)) return false;
  return Object.entries(doc).every(([k, v]) => plain(v) && created.includes(JSON.stringify([...prefix, k])) && skeleton(v, created, [...prefix, k]));
}
export const blankText = (text: string) => !text.trim();
// То же без учёта: только пустые объекты (подсказка «остались пустые» для учёта прежней версии)
export const emptyShape = (doc: unknown): boolean => plain(doc) && Object.values(doc).every(emptyShape);

// Ссылка (symlink, junction) — сам путь или его папка до корня (не включая корень): не удалять, не ходить
export function linkOnWay(path: string, root: string): boolean {
  for (let p = slash(path); inside(p, root) && pathKey(p) !== pathKey(root); p = slash(dirname(p))) {
    try { if (lstatSync(p).isSymbolicLink()) return true; } catch { return true; }
  }
  return false;
}

export function forgetMade(made: Made | undefined, path: string) {
  if (!made) return;
  if (made.dirs) made.dirs = made.dirs.filter((d) => !same(d, path));
  for (const f of Object.keys(made.files ?? {})) if (same(f, path)) delete made.files![f];
  for (const f of Object.keys(made.keys ?? {})) if (same(f, path)) delete made.keys![f];
}

// Записи внутри корней этой записи (проект, дом), которых больше нет или которые стали ссылкой (или чем-то другим), —
// прочь; сами пути не трогаются. Записи вне них (другие проекты, недоступный диск) остаются
export function pruneMade(made: Made | undefined, roots: string[]) {
  if (!made) return;
  const live = (p: string, dir: boolean) => {
    if (!roots.some((r) => inside(p, r))) return true;
    try { const s = lstatSync(p); return !s.isSymbolicLink() && (dir ? s.isDirectory() : s.isFile()); }
    catch { return false; }
  };
  if (made.dirs) made.dirs = made.dirs.filter((d) => live(d, true));
  for (const f of Object.keys(made.files ?? {})) if (!live(f, false)) delete made.files![f];
  for (const f of Object.keys(made.keys ?? {})) if (!live(f, false)) delete made.keys![f];
  if (made.dirs && !made.dirs.length) delete made.dirs;
  if (made.files && !Object.keys(made.files).length) delete made.files;
  if (made.keys && !Object.keys(made.keys).length) delete made.keys;
}
