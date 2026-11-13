// Бэкапы перед изменением файлов: local/backups/<метка запуска>/<путь файла>.
// Одна метка на запуск (процесс), одна копия файла за запуск — состояние до запуска;
// хранятся последние KEEP_RUNS запусков; каталоги 0700, файлы 0600.
// Значений секретов в копиях запусков нет (решение 2026-10-27, вариант а): значение из
// local/secrets.env заменяется на <secret:ИМЯ> без порчи данных (src/mask.ts): в JSON и TOML — только
// строки (синтаксис сохраняется, копия разбирается), в прочих файлах — диапазоны байтов. Откат по такой
// копии и затем sync восстанавливают обёртки. Оригиналы (originals/) — точные копии: clean возвращает
// их как были; их защищают права local/. Ссылка local/backups — права её цели не меняются (linkedDir).
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configRoot, loadSecrets } from "./load";
import { sha } from "./manifest";
import { guard } from "./bounds";
import { hasValues, maskFile, type Values } from "./mask";
import { behindLink, closeOwn, linkedDir, refuseBackupPath } from "./secretfiles";

export const KEEP_RUNS = 20;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

let run: { root: string; stamp: string; done: Set<string>; values: Values } | null = null;

// Копия без значений: файл, где значений нет, копируется как есть (в том числе двоичный)
export function scrubbedCopy(src: string, dst: string, values: Values) {
  const data = readFileSync(src);
  if (!hasValues(data, values)) return copyFileSync(src, dst);
  writeFileSync(dst, maskFile(data, src, values), { mode: 0o600 });
}

import { pathKey as fold } from "./paths";

// Новый запуск: следующая копия создаст новую метку (тесты; процесс CLI — один запуск)
export function newBackupRun() {
  run = null;
}

// Путь копии файла внутри каталога запуска: полный путь без «:» диска (D:/x/y → D/x/y)
export const backupRel = (path: string) => path.replace(/^([A-Za-z]):/, "$1").replace(/^\/+/, "");
// Каталог бэкапов текущего запуска (null — копий ещё не было)
export const runDir = () => (run ? join(run.root, run.stamp).replaceAll("\\", "/") : null);

// Новая папка за ссылкой (local/backups на другом томе) — своя: закрыть сразу, что бы ни наследовала цель (круг 8d, E1)
function mkdirPrivate(dir: string, config = configRoot()) {
  if (linkedDir(dir)) return;
  const fresh = !existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dir, 0o700);
  else if (fresh && behindLink(dir, config)) closeOwn(dir, true);
}

// Удаляет старые запуски сверх KEEP_RUNS (только каталоги с меткой; ручные — не трогаем)
function rotate(root: string, keep: string) {
  // Ссылку (запуск, который вы сделали ссылкой) не удаляем и в неё не заходим (выпуск 0.2.2, круг 8d, A №6)
  const stamps = readdirSync(root, { withFileTypes: true }).filter((e) => STAMP.test(e.name) && e.name !== keep && !e.isSymbolicLink()).map((e) => e.name).sort();
  for (const old of stamps.slice(0, Math.max(0, stamps.length - (KEEP_RUNS - 1))))
    rmSync(join(root, old), { recursive: true, force: true });
}

export function backup(path: string, config = configRoot()) {
  if (!existsSync(path)) return;
  const root = join(config, "local", "backups");
  // Ссылка на пути с открытой или несуществующей целью — отказ на каждом вызове, не только первом за процесс; запуск
  // (run) — только после проверки: rotate за такую ссылку не ходит (выпуск 0.2.2, круг 8c, C10)
  const stamp = run && run.root === root ? run.stamp : new Date().toISOString().replace(/[:.]/g, "-");
  const dst = join(root, stamp, backupRel(path));
  refuseBackupPath(dst, config);
  if (!run || run.root !== root) {
    const next = { root, stamp, done: new Set<string>(), values: Object.entries(loadSecrets(config)) };
    mkdirPrivate(root, config);
    mkdirPrivate(join(root, stamp), config);
    rotate(root, stamp);
    run = next;
  }
  if (run.done.has(fold(path))) return;
  run.done.add(fold(path));
  // Промежуточные каталоги — тоже 0700
  const dirs: string[] = [];
  for (let d = dirname(dst); !existsSync(d); d = dirname(d)) dirs.unshift(d);
  for (const d of dirs) mkdirPrivate(d, config);
  scrubbedCopy(path, dst, run.values);
  if (process.platform !== "win32") chmodSync(dst, 0o600);
}

// Копия до захвата: отдельная ветка, rotate рассматривает только метки запусков. Копии неизменяемы:
// первая — originals/<путь>; новый цикл владения (захват после clean) с другим содержимым —
// originals/<путь>.miksy-<хеш>, учёт указывает на актуальную. written — копия записана сейчас
// (та же версия уже лежит — новой записи нет)
export function originalBackup(path: string, config = configRoot()): { path: string; hash: string; written: boolean } {
  const root = join(config, "local", "backups", "originals");
  const base = join(root, path.replaceAll("\\", "/").replace(/^([A-Za-z]):/, "$1").replace(/^\/+/, ""));
  const hash = sha(readFileSync(path, "utf8"));
  const dst = !existsSync(base) || sha(readFileSync(base, "utf8")) === hash ? base : `${base}.miksy-${hash.slice(0, 16)}`;
  // Сначала замок C10: его текст говорит, что делать (ссылка в originals — заменить папкой); guard — запасной
  // (рецензия A круга 8d, №2)
  refuseBackupPath(dst, config);
  guard(dst, root);
  const dirs: string[] = [];
  for (let d = dirname(dst); !existsSync(d); d = dirname(d)) dirs.unshift(d);
  for (const d of dirs) mkdirPrivate(d, config);
  const written = !existsSync(dst);
  if (written) copyFileSync(path, dst, 1); // COPYFILE_EXCL: копия никогда не перезаписывается
  if (process.platform !== "win32") chmodSync(dst, 0o600);
  const saved = sha(readFileSync(dst, "utf8"));
  if (saved !== hash) throw new Error(`${dst}: копия оригинала не совпадает с файлом — захват отменён`);
  return { path: dst.replaceAll("\\", "/"), hash: saved, written };
}
