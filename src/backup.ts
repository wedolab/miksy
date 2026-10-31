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
import { linkedDir } from "./secretfiles";

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

// Каталог бэкапов текущего запуска (null — копий ещё не было)
export const runDir = () => (run ? join(run.root, run.stamp).replaceAll("\\", "/") : null);

function mkdirPrivate(dir: string) {
  if (linkedDir(dir)) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dir, 0o700);
}

// Удаляет старые запуски сверх KEEP_RUNS (только каталоги с меткой; ручные — не трогаем)
function rotate(root: string, keep: string) {
  const stamps = readdirSync(root).filter((d) => STAMP.test(d) && d !== keep).sort();
  for (const old of stamps.slice(0, Math.max(0, stamps.length - (KEEP_RUNS - 1))))
    rmSync(join(root, old), { recursive: true, force: true });
}

export function backup(path: string, config = configRoot()) {
  if (!existsSync(path)) return;
  const root = join(config, "local", "backups");
  if (!run || run.root !== root) {
    run = { root, stamp: new Date().toISOString().replace(/[:.]/g, "-"), done: new Set(), values: Object.entries(loadSecrets(config)) };
    mkdirPrivate(root);
    mkdirPrivate(join(root, run.stamp));
    rotate(root, run.stamp);
  }
  if (run.done.has(fold(path))) return;
  run.done.add(fold(path));
  const dst = join(root, run.stamp, path.replace(/^([A-Za-z]):/, "$1").replace(/^\/+/, ""));
  // Промежуточные каталоги — тоже 0700
  const dirs: string[] = [];
  for (let d = dirname(dst); !existsSync(d); d = dirname(d)) dirs.unshift(d);
  for (const d of dirs) mkdirPrivate(d);
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
  guard(dst, root);
  const dirs: string[] = [];
  for (let d = dirname(dst); !existsSync(d); d = dirname(d)) dirs.unshift(d);
  for (const d of dirs) mkdirPrivate(d);
  const written = !existsSync(dst);
  if (written) copyFileSync(path, dst, 1); // COPYFILE_EXCL: копия никогда не перезаписывается
  if (process.platform !== "win32") chmodSync(dst, 0o600);
  const saved = sha(readFileSync(dst, "utf8"));
  if (saved !== hash) throw new Error(`${dst}: копия оригинала не совпадает с файлом — захват отменён`);
  return { path: dst.replaceAll("\\", "/"), hash: saved, written };
}
