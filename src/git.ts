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

// Сообщения git — на английском, чтобы отличать «не репо» от сбоя
function run(dir: string, args: string[]) {
  try {
    const r = Bun.spawnSync(["git", "-C", dir, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: gitEnv(),
    });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString().trim() };
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
  let real = "";
  if (cache) try { real = fold(canonical(d)); } catch { /* нет доступа — только сам каталог */ }
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
  const r = run(d, ["rev-parse", "--show-toplevel"]);
  let top: string | null | GitError;
  if (r.code === 0) top = canonical(r.out.trim());
  else if (/not a git repository/i.test(r.err)) top = null;
  else top = new GitError(`git rev-parse в ${slash(d)}: ${r.err.split("\n").pop() || `код ${r.code}`}`);
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
type Index = { files: Map<string, Set<string>>; dirs: Map<string, Set<string>> };
function indexOf(dir: string): Index {
  const key = fold(slash(dir));
  const hit = cache!.index.get(key);
  if (hit instanceof GitError) throw hit;
  if (hit) return hit;
  const r = run(dir, ["ls-files", "-z"]);
  if (r.code !== 0) {
    const e = new GitError(`git ls-files в ${slash(dir)}: ${r.err.split("\n").pop() || `код ${r.code}`}`);
    cache!.index.set(key, e);
    throw e;
  }
  const index: Index = { files: new Map(), dirs: new Map() };
  const add = (m: Map<string, Set<string>>, p: string) => {
    const k = p.toLowerCase();
    const s = m.get(k);
    if (s) s.add(p);
    else m.set(k, new Set([p]));
  };
  for (const l of r.out.split("\0")) {
    if (!l) continue;
    add(index.files, l);
    for (let i = l.indexOf("/"); i > 0; i = l.indexOf("/", i + 1)) add(index.dirs, l.slice(0, i));
  }
  cache!.index.set(key, index);
  return index;
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
  if (r.code !== 0) throw new GitError(`git ls-files в ${slash(dir)}: ${r.err.split("\n").pop() || `код ${r.code}`}`);
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
