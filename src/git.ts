// Обращения к git. Сбой git (не установлен, повреждённый индекс, «dubious ownership»…) — GitError:
// вызывающий отказывается от записи, а не считает файл «не отслеживаемым».
import { existsSync, lstatSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

export class GitError extends Error {}

import { canonical, fold, inside, slash } from "./paths";

// IDE/direnv могут передать чужой индекс, git-dir, worktree или pathspec-настройки — их убираем.
// Конфигурацию (GIT_CONFIG_*: safe.directory в CI и контейнерах) оставляем: без неё git ответил бы
// «dubious ownership», и все файлы цели получили бы «сбой git»
const REPO_ENV = /^GIT_(DIR|WORK_TREE|INDEX_FILE|INDEX_VERSION|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|(LITERAL|GLOB|NOGLOB|ICASE)_PATHSPECS)$/i;
export const gitEnv = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !REPO_ENV.test(k))), LC_ALL: "C", LANGUAGE: "C" });

// Причина сбоя git для текста ошибки: первая строка stderr (обычно «fatal: …» — суть), последняя — если другая, и код;
// пусто — так и сказано (круг 10d-6: на macOS GitHub пойман код 128 без единой строки). В stderr git — пути, не секреты
export function gitWhy(err: string, code: number | null): string {
  const lines = err.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return `код ${code}, git ничего не написал`;
  const last = lines[lines.length - 1];
  return `${lines[0]}${lines.length > 1 && last !== lines[0] ? ` … ${last}` : ""} (код ${code})`;
}

// Запуск git — один на всю программу (git.ts, apply.ts, version.ts, update.ts). Пустой ответ там, где git обязан
// ответить, — ровно один повтор, без пауз (круг 10d-6: на macOS GitHub пойманы «код 0, пустой stdout» и «код 128,
// пустой stderr» — ответ git не дошёл; пустой путь становился текущим каталогом, пустая ошибка — «сбоем git»).
// Причина — ошибка Bun до 1.4.3 (spawnSync регистрирует опрос в чужом цикле событий, oven-sh/bun#44581); минимум
// теперь 1.4.3 (круг 10f), повтор оставлен для тех, кто ещё на старом Bun (doctor предупреждает):
// - код ≠ 0 и stderr пуст (git при отказе пишет причину; молчат только режимы -q — им лишний запуск не вредит);
// - код 0 и stdout пуст, если needOut (rev-parse, describe и т. п. при успехе всегда печатают).
// Не повторяется: код null (git убит или вышел по тайм-ауту — повтор удвоил бы ожидание, у update до 6 минут) и
// readOnly: false — команды, которые меняют репо (checkout, merge, fetch в update): повтор после частичного успеха дал
// бы чужую ошибку («branch already exists») вместо настоящей. Второй ответ — как есть: что с ним делать, решает
// вызывающий (пустой путь — ошибка, а не значение)
export type GitResult = { code: number | null; out: string; err: string; bytes: Buffer };
type Spawn = (argv: string[], opts: { env: Record<string, string | undefined>; timeout?: number; stdin?: Buffer }) => { exitCode: number | null; stdout: Buffer; stderr: Buffer };
const realSpawn: Spawn = (argv, opts) => Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", ...opts });
let spawnGit: Spawn = realSpawn;
// Только для тестов: подменить запуск git (null — настоящий)
export function setGitSpawnForTest(fn: Spawn | null) { spawnGit = fn ?? realSpawn; }

export function gitSpawn(args: string[], o: { needOut?: boolean; readOnly?: boolean; env?: Record<string, string | undefined>; timeout?: number; stdin?: Buffer } = {}): GitResult {
  const once = (): GitResult => {
    const r = spawnGit(["git", ...args], { env: o.env ?? gitEnv(), ...(o.timeout && { timeout: o.timeout }), ...(o.stdin && { stdin: o.stdin }) });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString(), bytes: Buffer.from(r.stdout) };
  };
  const r = once();
  if (r.code === null || o.readOnly === false) return r;
  const lost = (r.code !== 0 && !r.err.trim()) || (r.code === 0 && !!o.needOut && !r.out.trim());
  return lost ? once() : r;
}

// Сообщения git — на английском, чтобы отличать «не репо» от сбоя
function run(dir: string, args: string[], needOut = false) {
  try {
    const r = gitSpawn(["-C", dir, ...args], { needOut });
    return { code: r.code, out: r.out, err: r.err.trim() };
  } catch (e) {
    throw new GitError(`git не запускается: ${(e as Error).message}`);
  }
}

// Кеш ответов git на время одной команды CLI (cacheGit): miksy сам индекс не меняет, а без кеша
// sync --all запускал git на каждый файл (обёртки local/run, файлы дома, каждый агент заново).
// По умолчанию выключен: тесты в одном процессе меняют репо между вызовами
let cache: { repo: Map<string, string | null | GitError>; index: Map<string, Index | GitError>; other: Map<string, unknown> } | null = null;
export function cacheGit(on = true) {
  cache = on ? { repo: new Map(), index: new Map(), other: new Map() } : null;
}

export const gitCaching = () => cache !== null;

// Прочие ответы git (командные skills из коммита) — тот же кеш, по ключу
export function gitMemo<T>(key: string, fn: () => T): T {
  if (!cache) return fn();
  if (!cache.other.has(key)) cache.other.set(key, fn());
  return cache.other.get(key) as T;
}

// Корень git-репо, в котором лежит каталог; null — каталог не в репо
export function repoOf(dir: string): string | null {
  let d = dir;
  while (!existsSync(d) && dirname(d) !== d) d = dirname(d);
  const key = fold(slash(d));
  const hit = cache?.repo.get(key);
  if (hit instanceof GitError) throw hit;
  if (hit !== undefined) return hit;
  // Путь без ссылок: его текстовые родители — те же каталоги, где ищет git
  let real = "", realPath = "";
  if (cache) try { realPath = canonical(d); real = fold(realPath); } catch { /* нет доступа — только сам каталог */ }
  // Каталог за ссылкой (junction, symlink): git ищет репо от физического пути (chdir — getcwd; проверено на Windows для
  // junction и symlink, macOS/Linux так всегда) — ответ тот же, что для пути без ссылок, а у него работает подсказка
  // родителя: ссылки на skills внутри проекта не запускают git каждая (круг 10k)
  if (cache && real && real !== key) {
    const top = repoOf(realPath);
    cache.repo.set(key, top);
    return top;
  }
  // Известный ответ родителя: каталог внутри уже найденного репо, и между ними нет другого .git —
  // тот же корень (соседние каталоги local/run/<агент>/<цель>, подкаталоги проекта)
  if (cache && real === key)
    for (let p = slash(d); !existsSync(join(p, ".git")) && slash(dirname(p)) !== p; ) {
      p = slash(dirname(p));
      const up = cache.repo.get(fold(p));
      if (typeof up === "string") {
        cache.repo.set(key, up);
        return up;
      }
    }
  const r = run(d, ["rev-parse", "--show-toplevel"], true);
  let top: string | null | GitError;
  // Код 0 без пути (и после повтора) — сбой, а не «корень = текущий каталог» (canonical("") — это cwd; круг 10d-6)
  if (r.code === 0 && !r.out.trim()) top = new GitError(`git rev-parse в ${slash(d)}: git ничего не ответил (код 0)`);
  else if (r.code === 0) top = canonical(r.out.trim());
  else if (/not a git repository/i.test(r.err)) top = null;
  else top = new GitError(`git rev-parse в ${slash(d)}: ${gitWhy(r.err, r.code)}`);
  if (cache) {
    cache.repo.set(key, top);
    // Каталоги между d и корнем репо дают тот же ответ: git ищет ближайший .git вверх, и между d и
    // найденным корнем другого нет. «Не репо» на родителей не переносится (граница файловых систем)
    if (typeof top === "string" && real === key && inside(key, top))
      for (let p = slash(d); fold(p) !== fold(top) && slash(dirname(p)) !== p; ) {
        p = slash(dirname(p));
        cache.repo.set(fold(p), top);
      }
  }
  if (top instanceof GitError) throw top;
  return top;
}

// Индекс каталога одним запросом (для кеша): полные пути в нижнем регистре и каталоги-префиксы
// (нижний регистр → варианты написания)
// modes — путь как в индексе → режим git (120000 — ссылка): им пользуется разбор командных skills (teamskills.ts), чтобы
// не спрашивать git второй раз (круг 10k)
type Index = { files: Map<string, Set<string>>; dirs: Map<string, Set<string>>; modes: Map<string, string> };
function indexOf(dir: string): Index {
  const key = fold(slash(dir));
  const hit = cache!.index.get(key);
  if (hit instanceof GitError) throw hit;
  if (hit) return hit;
  const r = run(dir, ["ls-files", "-s", "-z"]);
  if (r.code !== 0) {
    const e = new GitError(`git ls-files в ${slash(dir)}: ${gitWhy(r.err, r.code)}`);
    cache!.index.set(key, e);
    throw e;
  }
  const index: Index = { files: new Map(), dirs: new Map(), modes: new Map() };
  const add = (m: Map<string, Set<string>>, p: string) => {
    const k = p.toLowerCase();
    const s = m.get(k);
    if (s) s.add(p);
    else m.set(k, new Set([p]));
  };
  for (const e of r.out.split("\0")) {
    const m = e.match(/^(\d+) \S+ \d+\t(.+)$/s);
    if (!m) continue;
    const l = m[2];
    index.modes.set(l, m[1]);
    add(index.files, l);
    for (let i = l.indexOf("/"); i > 0; i = l.indexOf("/", i + 1)) add(index.dirs, l.slice(0, i));
  }
  cache!.index.set(key, index);
  return index;
}

// Записи индекса репо (путь → режим) из кеша команды; null — кеша нет (запрос — свой)
export function indexModes(dir: string): Map<string, string> | null {
  return cache ? indexOf(dir).modes : null;
}

// Совпадение с индексом только регистром (:(icase)): отслеживаемое, если это не два разных
// существующих файла. Файла нет на диске — тоже отслеживаемое: на регистронезависимой ФС запись
// создала бы изменение командного файла; на регистрозависимой — ложный конфликт, безопасная сторона
const caseOnly = (dir: string, q: string, same: string) => {
  const a = join(dir, q), b = join(dir, same);
  return !(existsSync(a) && existsSync(b) && canonical(a) !== canonical(b));
};

// Какие из путей (относительно dir) отслеживаются git. Путь-каталог отслеживается,
// если отслеживается что-то внутри него. Каталог не в репо — ничего не отслеживается
export function trackedPaths(dir: string, paths: string[]): string[] {
  if (!paths.length || !repoOf(dir)) return [];
  // С кешем — весь индекс каталога одним запросом; пути вне каталога (../) — запросом по ним
  if (cache && paths.every((p) => !/^(\.\.?(\/|$)|\/|[A-Za-z]:)/.test(slash(p)))) {
    const index = indexOf(dir);
    return paths.filter((p) => {
      const q = slash(p);
      const same = [...(index.files.get(q.toLowerCase()) ?? []), ...(index.dirs.get(q.toLowerCase()) ?? [])];
      return same.includes(q) || same.some((s) => caseOnly(dir, q, s));
    });
  }
  const r = run(dir, ["ls-files", "-s", "-z", "--", ...paths.map((p) => `:(icase,literal)${slash(p)}`)]);
  if (r.code !== 0) throw new GitError(`git ls-files в ${slash(dir)}: ${gitWhy(r.err, r.code)}`);
  const listed = r.out.split("\0").filter(Boolean).map((p) => p.slice(p.indexOf("\t") + 1));
  return paths.filter((p) => {
    const q = slash(p);
    return listed.some((l) => {
      if (l === q || l.startsWith(q + "/")) return true;
      const same = l.length === q.length ? l : l.slice(0, q.length);
      if (same.toLowerCase() !== q.toLowerCase() || (same.length < l.length && l[q.length] !== "/")) return false;
      return caseOnly(dir, q, same);
    });
  });
}

// Отслеживается ли абсолютный путь каким-либо git-репо (например, dotfiles-репо в ~).
// Возвращает корень репо или null
export function trackedBy(abs: string): string | null {
  // Раскрываем родителей, но саму ссылку проверяем как запись индекса.
  const logical = join(canonical(dirname(abs)), basename(abs));
  const top = repoOf(dirname(logical));
  if (!top) return null;
  const rel = slash(relative(top, logical));
  return trackedPaths(top, [rel]).length ? top : null;
}

// Проверяем ссылку, её цель и каждую ссылку выше по логическому пути.
export function protectedBy(abs: string): string | null {
  const direct = trackedBy(abs);
  if (direct) return direct;
  for (let p = resolve(abs); dirname(p) !== p; p = dirname(p)) {
    if (existsSync(p) && lstatSync(p).isSymbolicLink()) {
      const top = trackedBy(p);
      if (top) return top;
    }
  }
  const real = canonical(abs);
  return real === slash(abs) ? null : trackedBy(real);
}

// Коллекция команды: учитываем и логический каталог, и физическую цель ссылки.
export function teamCollection(dir: string, rel: string): boolean {
  const abs = join(dir, rel);
  return trackedPaths(dir, [rel]).length > 0 || !!protectedBy(abs);
}
