// Файлы секретов local/secrets/<ИМЯ>: одно значение + LF, без CR (sh-read оставил бы \r).
// Доступ — только владельцу: 0600/0700 на macOS/Linux, ACL через icacls на Windows (каталог без
// наследования, только текущий пользователь; файлы наследуют). Без бэкапов и без хешей в учёте:
// значение не должно появиться ни в одной копии. Какие файлы нужны — объединение секретов всех
// целей учёта (TargetState.secrets); лишние удаляются.
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configRoot } from "./load";
import { type Manifest, writeAtomic } from "./manifest";
import { slash } from "./paths";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const secretsDir = (root = configRoot()) => slash(join(root, "local", "secrets"));
const win = process.platform === "win32";

export type SecretFileState = "create" | "update" | "same" | "missing";

// Что нужно сделать с файлом секрета: missing — значения нет в secrets.env (файл не создаётся)
export function secretFileState(name: string, secrets: Record<string, string>, dir = secretsDir()): SecretFileState {
  if (!(name in secrets)) return "missing";
  const path = join(dir, name);
  if (!existsSync(path)) return "create";
  try {
    return readFileSync(path, "utf8") === secrets[name] + "\n" ? "same" : "update";
  } catch {
    return "update";
  }
}

// Записывает файлы секретов names (только однострочные значения из secrets.env); возвращает
// строки для вывода — только имена; created — файлы, которые создал этот вызов (только они переходят
// во владение miksy: заранее положенный пользователем файл остаётся его)
export function writeSecretFiles(names: string[], secrets: Record<string, string>, dir = secretsDir()): { lines: string[]; created: string[] } {
  const lines: string[] = [];
  const created: string[] = [];
  const todo = names.filter((n) => NAME.test(n) && n in secrets && !/[\r\n]/.test(secrets[n]));
  if (!todo.length) return { lines, created };
  privateDir(dir);
  for (const n of todo) {
    const state = secretFileState(n, secrets, dir);
    if (state === "same") continue;
    // Ссылку пользователя (файл на другом томе) не перезаписываем через неё
    if (isLink(join(dir, n))) {
      lines.push(`  файл секрета ${n}: это ссылка — не перезаписываю (значение в secrets.env другое)`);
      continue;
    }
    writeAtomic(join(dir, n), secrets[n] + "\n", { sensitive: true });
    if (state === "create") created.push(n);
    lines.push(`  файл секрета ${n}: ${state === "create" ? "создан" : "обновлён"}`);
  }
  if (win && lines.length) protectFiles(dir);
  return { lines, created };
}

// Нужные файлы: секреты всех целей учёта
export const neededSecrets = (m: Manifest) => new Set(Object.values(m.targets).flatMap((t) => t.secrets ?? []));

// Обычный файл (не ссылка, в том числе битая): только такие miksy создаёт и удаляет
const plainFile = (p: string) => {
  try { return lstatSync(p).isFile(); } catch { return false; }
};

// Лишние файлы — созданные miksy (ledger — Manifest.secretFiles), которые больше не нужны ни одной
// цели, — удалить; dryRun — только список. Файл, который miksy не создавал (пользователь положил
// заранее), и ссылки не трогаются. removed — имена удалённых (убрать из учёта)
export function pruneSecretFiles(needed: Set<string>, dryRun: boolean, ledger: string[], dir = secretsDir()): { lines: string[]; removed: string[] } {
  if (!existsSync(dir)) return { lines: [], removed: [] };
  const extra = ledger.filter((n) => NAME.test(n) && !needed.has(n) && plainFile(join(dir, n)));
  if (!dryRun) for (const n of extra) rmSync(join(dir, n));
  return { lines: extra.map((n) => `  файл секрета ${n}: ${dryRun ? "будет удалён" : "удалён"} (больше не нужен ни одной цели)`), removed: extra };
}

// Каталог внутри local/ — ссылка (local/secrets, local/backups на другом томе): права её цели miksy не
// меняет (chmod/icacls по ссылке изменили бы чужой каталог), цель только проверяется. true — ссылка на
// закрытый каталог (писать можно); открытая или битая — отказ с указанием, что закрыть вручную
export function linkedDir(dir: string): boolean {
  if (!isLink(dir)) return false;
  let target: string;
  try { target = realpathSync(dir); }
  catch { throw new Error(`${slash(dir)}: битая ссылка внутри local/ — исправьте или удалите её`); }
  const why = aclProblem(target);
  if (why) throw new Error(`${slash(dir)} — ссылка на ${slash(target)}: ${why}; miksy права цели ссылки не меняет — закройте вручную`);
  return true;
}

// Каталог секретов: создаётся закрытым; ссылка — только проверка цели (linkedDir)
function privateDir(dir: string) {
  if (linkedDir(dir)) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!win) chmodSync(dir, 0o700);
  else if (aclProblem(dir)) protectDir(dir);
}

// ---- Windows ACL ----

const sys = (exe: string) => join(process.env.SystemRoot ?? "C:\\Windows", "System32", exe);
let sid: string | undefined;
function mySid(): string {
  if (!sid) {
    const r = Bun.spawnSync([sys("whoami.exe"), "/user", "/fo", "csv", "/nh"], { stdout: "pipe", stderr: "pipe" });
    const m = new TextDecoder("latin1").decode(r.stdout).trim().match(/,"(S-[0-9-]+)"$/);
    if (!m) throw new Error("не удалось узнать SID текущего пользователя (whoami /user)");
    sid = m[1];
  }
  return sid;
}

const native = (p: string) => p.replaceAll("/", "\\");
function icacls(args: string[]): number {
  return Bun.spawnSync([sys("icacls.exe"), ...args], { stdout: "pipe", stderr: "pipe" }).exitCode ?? 1;
}

// Каталог: без наследования, полный доступ только текущему пользователю (с наследованием вниз);
// файлы наследуют. Явная чужая запись (если была) — заменяется сбросом файла до наследования
function protectDir(dir: string) {
  if (icacls([native(dir), "/inheritance:r", "/grant:r", `*${mySid()}:(OI)(CI)F`]) !== 0) throw new Error(`${dir}: icacls не изменил доступ`);
  for (const other of others(dir)) {
    const sid = ({ SY: "S-1-5-18", BA: "S-1-5-32-544", BU: "S-1-5-32-545", AU: "S-1-5-11", WD: "S-1-1-0" } as Record<string, string>)[other] ?? other;
    if (icacls([native(dir), "/remove:g", `*${sid}`]) !== 0) throw new Error(`${dir}: icacls не убрал чужой доступ`);
  }
}

const isLink = (p: string) => {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
};

// Пути local/ для прав. Ссылки (secrets.env на зашифрованном томе и т. п.) не обходятся и не
// меняются — их цель вне miksy (chmod по ссылке изменил бы чужой файл); links — для проверки
function localPaths(dir: string, links: string[] = []): string[] {
  if (!existsSync(dir)) return [];
  return [dir, ...readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) { links.push(p); return []; }
    return e.isDirectory() ? localPaths(p, links) : [p];
  })];
}

// local/ целиком может быть ссылкой (перенесён на другой том): права — у каталога назначения
function localRoot(dir: string): string {
  if (!isLink(dir)) return dir;
  try { return realpathSync(dir); }
  catch { throw new Error(`${slash(dir)}: ссылка local/ ведёт в несуществующий каталог`); }
}

// Ссылки внутри local/: цель только проверяется — открытая или битая ссылка — предупреждение
function linkProblems(links: string[]): string[] {
  return links.flatMap((l) => {
    let target: string;
    try { target = realpathSync(l); } catch { return [`${slash(l)}: битая ссылка внутри local/ — пропущена`]; }
    const why = aclProblem(target);
    return why ? [`${slash(l)} → ${slash(target)}: ${why} — это ссылка: miksy права её цели не меняет, закройте вручную`] : [];
  });
}

// Один ACL-снимок на всё дерево: doctor не запускает icacls отдельно для тысяч бэкапов.
// bad — открытые пути (sync/setup закроют); links — ссылки с открытой или несуществующей целью
export function checkLocalAccess(dir = join(configRoot(), "local")): { bad: string[]; links: string[] } {
  if (!existsSync(dir)) return { bad: [], links: [] };
  try {
    const root = localRoot(dir);
    const links: string[] = [];
    const paths = localPaths(root, links);
    const linked = linkProblems(links);
    if (!win) return { bad: paths.flatMap((p) => { const why = aclProblem(p); return why ? [`${slash(p)}: ${why}`] : []; }), links: linked };
    const tmp = join(tmpdir(), `miksy-local-acl-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
    try {
      if (icacls([native(root), "/save", tmp, "/t", "/q", "/L"]) !== 0) throw new Error("icacls не прочитал local/");
      const lines = readFileSync(tmp, "utf16le").split(/\r?\n/);
      const bad: string[] = [];
      for (let i = 0; i + 1 < lines.length; i += 2) {
        const aces = [...lines[i + 1].matchAll(/\(([A-Z]+);[^;]*;[^;]*;[^;]*;[^;]*;([^)]+)\)/g)];
        if (aces.some((a) => a[1] === "A" && a[2] !== mySid())) bad.push(`${lines[i]}: доступ есть не только у владельца`);
      }
      return { bad, links: linked };
    } finally { rmSync(tmp, { force: true }); }
  } catch (e) { return { bad: [(e as Error).message], links: [] }; }
}

// Закрыть local/ владельцу: сначала проверка (один снимок), исправление — только если есть открытые
// пути (Windows: не обходить ACL десятков тысяч бэкапов при каждом sync). fixed — права менялись;
// warnings — ссылки внутри local/ (их цель не меняется)
export function privateLocal(dir = join(configRoot(), "local")): { fixed: boolean; warnings: string[] } {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const root = localRoot(dir);
  const before = checkLocalAccess(root);
  if (!before.bad.length) return { fixed: false, warnings: before.links };
  if (win) {
    protectDir(root);
    for (const e of readdirSync(root))
      if (icacls([native(join(root, e)), "/reset", "/t", "/q", "/L"]) !== 0) throw new Error(`${root}: icacls не закрыл вложенные файлы`);
  } else for (const p of localPaths(root)) chmodSync(p, statSync(p).isDirectory() || (statSync(p).mode & 0o100) ? 0o700 : 0o600);
  const after = checkLocalAccess(root);
  if (after.bad.length) throw new Error(`local/ не закрыт: ${after.bad[0]}`);
  return { fixed: true, warnings: after.links };
}

const secured = new Map<string, { fixed: boolean; warnings: string[] }>();
export function ensurePrivateLocal(dir = join(configRoot(), "local")): { fixed: boolean; warnings: string[] } {
  if (secured.has(dir)) return { fixed: false, warnings: [] };
  const r = privateLocal(dir);
  secured.set(dir, r);
  return r;
}
function protectFiles(dir: string) {
  for (const n of readdirSync(dir).filter((x) => NAME.test(x) && plainFile(join(dir, x))))
    if (others(join(dir, n)).length) icacls([native(join(dir, n)), "/reset"]);
}

// Разрешающие записи ACL не текущего пользователя (SID или псевдоним SDDL: SY, BA, …).
// SDDL — через icacls /save: без локализованных имён и кодовых страниц
function others(path: string): string[] {
  const tmp = join(tmpdir(), `miksy-acl-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
  try {
    if (icacls([native(path), "/save", tmp]) !== 0) throw new Error(`${slash(path)}: icacls не прочитал доступ`);
    const sddl = readFileSync(tmp, "utf16le").split(/\r?\n/)[1] ?? "";
    const aces = [...sddl.matchAll(/\(([A-Z]+);[^;]*;[^;]*;[^;]*;[^;]*;([^)]+)\)/g)];
    return [...new Set(aces.filter((a) => a[1] === "A" && a[2] !== mySid()).map((a) => a[2]))];
  } finally {
    rmSync(tmp, { force: true });
  }
}

// null — доступ только у владельца; иначе что не так (для doctor)
export function aclProblem(path: string): string | null {
  if (!win) {
    const mode = statSync(path).mode & 0o777;
    return mode & 0o077 ? `права ${mode.toString(8).padStart(4, "0")} — нужен доступ только владельцу (${statSync(path).isDirectory() ? "0700" : "0600"})` : null;
  }
  const list = others(path);
  return list.length ? `доступ есть не только у владельца: ${list.join(", ")}` : null;
}

// Doctor: нужные файлы есть и закрыты, лишних (созданных miksy — ledger) нет, содержимое совпадает
// с secrets.env; чужие файлы — справочно
export function checkSecretFiles(needed: Map<string, string[]>, secrets: Record<string, string>, ledger: string[] = [], dir = secretsDir()): { problems: string[]; info: string[] } {
  const problems: string[] = [];
  const info: string[] = [];
  if (existsSync(dir)) {
    const why = aclProblem(dir);
    if (why) problems.push(`${dir}: ${why} — miksy sync исправит`);
  }
  for (const [n, users] of [...needed].sort()) {
    const path = join(dir, n);
    const who = users.join(", ");
    const state = secretFileState(n, secrets, dir);
    if (!existsSync(path)) {
      problems.push(state === "missing"
        ? `${n}: не задан в local/secrets.env и файла нет — серверы не запустятся (${who})`
        : `${n}: нет файла секрета — miksy sync создаст (${who})`);
      continue;
    }
    if (state === "missing") info.push(`${n}: не задан в local/secrets.env — файл от прошлого sync оставлен, пока сервер записан (${who})`);
    else if (state === "update") problems.push(`${n}: файл секрета устарел (значение в secrets.env другое) — miksy sync обновит`);
    let why: string | null;
    try { why = aclProblem(path); } catch { why = "не читается (битая ссылка?)"; }
    if (why) problems.push(`${slash(path)}: ${why}`);
  }
  if (existsSync(dir))
    for (const n of readdirSync(dir).filter((x) => NAME.test(x) && !needed.has(x))) {
      if (ledger.includes(n) && plainFile(join(dir, n))) problems.push(`${n}: лишний файл секрета (не нужен ни одной цели) — miksy sync удалит`);
      else info.push(`${n}: файл в local/secrets не от miksy (или ссылка) — не нужен ни одной цели, miksy его не трогает`);
    }
  return { problems, info };
}
