// Замок записи в этом же процессе (круг 8e, F6): мастер и команды через runCommand в тесте, помощники тестов пишут
// функциями node:fs (синхронными, с обратным вызовом, fs.promises и node:fs/promises, потоками записи) и Bun.write —
// только в безопасные корни (песочница preload, системный tmp). Иначе — ошибка до записи и отметка: даже если код под
// тестом поймает ошибку, preload в конце прогона его остановит. Не охвачены: Bun.file() из файлового дескриптора,
// вывод подпроцесса в файл (Bun.spawn с stdout: Bun.file), перенаправления Bun.$ — ни src, ни тесты ими не пишут.
// Первый файл preload (bunfig.toml) и без import из "node:fs": Bun связывает импорт по имени (import { writeFileSync }
// from "node:fs") при первом таком импорте в процессе — подмена после него до импортов по имени не доходит (опыт круга
// 8e). Корни задаёт test/preload.ts (configureFsGuard); до этого замок ничего не проверяет
/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs") as Record<string, any>;
const fsp = require("node:fs/promises") as Record<string, any>;
const path = require("node:path") as typeof import("node:path");

const win = process.platform === "win32";
const foldCase = (p: string) => (win || process.platform === "darwin" ? p.toLowerCase() : p);
const realpath = fs.realpathSync.native as (p: string) => string;
const lstat = fs.lstatSync as (p: string) => { isSymbolicLink(): boolean };
const readlink = fs.readlinkSync as (p: string) => string;
const lexists = (p: string) => { try { lstat(p); return true; } catch { return false; } };
const norm = (p: string) => foldCase(p.replaceAll("\\", "/").replace(/\/+$/, ""));
// Канонический путь: существующая часть раскрыта (ссылки, регистр); ссылка в никуда — по её записанной цели (запись по
// ней создаёт файл там); несуществующий хвост — как записан. own — сам последний элемент не раскрывается (удаление или
// переименование ссылки трогает её саму, не цель)
function canon(p: string, own = false, depth = 0): string {
  const abs = path.resolve(p);
  if (own) { const parent = path.dirname(abs); return parent === abs ? norm(abs) : `${canon(parent, false, depth)}/${foldCase(path.basename(abs))}`; }
  let head = abs, tail = "";
  while (!lexists(head) && path.dirname(head) !== head) { tail = path.join(path.basename(head), tail); head = path.dirname(head); }
  try { return norm(path.join(realpath(head), tail)); }
  catch {
    // Не раскрывается: ссылка в никуда — по её цели; иначе (нет доступа и т. п.) — как записан
    try {
      if (depth < 20 && lstat(head).isSymbolicLink()) { const t = readlink(head); return canon(path.join(path.resolve(path.dirname(head), t), tail), false, depth + 1); }
      const parent = path.dirname(head);
      if (depth < 20 && parent !== head) return canon(path.join(parent, path.basename(head), tail), true, depth + 1).replace(/\/+$/, "");
    } catch { /* как записан */ }
    return norm(path.join(head, tail));
  }
}
const under = (p: string, root: string) => p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);

export const fsViolations: string[] = [];
let roots: string[] | null = null;
export function configureFsGuard(safe: string[]) { roots = safe.map((r) => canon(r)); }

function check(fn: string, target: unknown, own = false) {
  if (!roots || typeof target === "number" || target === undefined || target === null) return; // дескриптор проверен при открытии
  const p = target instanceof URL ? Bun.fileURLToPath(target) : Buffer.isBuffer(target) ? target.toString() : String(target);
  const c = canon(p, own);
  if (roots.some((r) => under(c, r))) return;
  const why = `${fn}: ${p} — запись мимо песочницы`;
  fsViolations.push(why);
  throw new Error(`ОСТАНОВЛЕНО (test/fsguard.ts): ${why}`);
}

// Какие аргументы — пути записи; own — сам элемент (ссылка), а не её цель
type Arg = [number, boolean?];
const writes: Record<string, Arg[]> = {
  writeFile: [[0]], appendFile: [[0]], mkdir: [[0]], rename: [[0, true], [1, true]], copyFile: [[1]], cp: [[1]],
  rm: [[0, true]], unlink: [[0, true]], rmdir: [[0, true]], symlink: [[1, true]], link: [[1, true]], chmod: [[0]],
  lchmod: [[0, true]], truncate: [[0]], utimes: [[0]], lutimes: [[0, true]], mkdtemp: [[0]], createWriteStream: [[0]],
};
const C = fs.constants as Record<string, number>;
const WRITE_FLAGS = C.O_WRONLY | C.O_RDWR | C.O_CREAT | C.O_TRUNC | C.O_APPEND;
const flagged = (flags: unknown) => flags !== undefined && (typeof flags === "number" ? (flags & WRITE_FLAGS) !== 0 : /[wa+]/.test(String(flags)));
function wrap(target: Record<string, any>, fn: string, at: Arg[], label: string) {
  const orig = target[fn];
  if (typeof orig !== "function") return;
  target[fn] = function (this: unknown, ...a: any[]) {
    for (const [i, own] of at) check(label, a[i], own);
    return orig.apply(this, a);
  };
}
for (const [fn, at] of Object.entries(writes)) {
  if (fn !== "createWriteStream") wrap(fs, `${fn}Sync`, at, `${fn}Sync`);
  wrap(fs, fn, at, fn);                                    // с обратным вызовом; createWriteStream
  if (fn !== "createWriteStream") wrap(fsp, fn, at, `promises.${fn}`);
  if (fs.promises && fs.promises !== fsp && fn !== "createWriteStream") wrap(fs.promises, fn, at, `promises.${fn}`);
}
// open с флагом записи (O_WRONLY, O_RDWR, O_CREAT, O_TRUNC или строка с w, a, +)
for (const [target, fn, label] of [[fs, "openSync", "openSync"], [fs, "open", "open"], [fsp, "open", "promises.open"]] as const) {
  const orig = target[fn];
  if (typeof orig !== "function") continue;
  target[fn] = function (this: unknown, ...a: any[]) { if (flagged(a[1])) check(label, a[0]); return orig.apply(this, a); };
}
// Bun.write: путь, URL или Bun.file(путь)
const bunWrite = Bun.write;
Bun.write = ((dest: any, ...rest: any[]) => {
  if (typeof dest === "string" || dest instanceof URL) check("Bun.write", dest);
  else if (dest && typeof dest.name === "string") check("Bun.write", dest.name);
  return (bunWrite as any)(dest, ...rest);
}) as typeof Bun.write;
// Bun.file(путь): методы записи write, writer, delete — та же проверка (выпуск 0.2.3, часть C). Свойства задаются на
// самом объекте файла; не удалось (объект закрыт для записи) — без проверки, как прежде
const bunFile = Bun.file;
Bun.file = ((p: any, ...rest: any[]) => {
  const f = (bunFile as any)(p, ...rest);
  const name = typeof p === "string" ? p : p instanceof URL ? Bun.fileURLToPath(p) : null;
  if (name) for (const m of ["write", "writer", "delete", "unlink"]) {
    const orig = f[m];
    if (typeof orig !== "function") continue;
    try { Object.defineProperty(f, m, { value: (...a: any[]) => { check(`Bun.file().${m}`, name, m === "delete" || m === "unlink"); return orig.apply(f, a); }, configurable: true }); } catch { /* как прежде */ }
  }
  return f;
}) as typeof Bun.file;
