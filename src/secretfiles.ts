// Файлы секретов local/secrets/<ИМЯ>: одно значение + LF, без CR (sh-read оставил бы \r).
// Доступ — только владельцу: 0600/0700 на macOS/Linux, ACL через icacls на Windows (каталог без
// наследования, только текущий пользователь; файлы наследуют). Без бэкапов и без хешей в учёте:
// значение не должно появиться ни в одной копии. Какие файлы нужны — объединение секретов всех
// целей учёта (TargetState.secrets); лишние удаляются.
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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
  let wrote = false;
  const todo = names.filter((n) => NAME.test(n) && n in secrets && !/[\r\n]/.test(secrets[n]));
  if (!todo.length) return { lines, created };
  privateDir(dir);
  for (const n of todo) {
    const state = secretFileState(n, secrets, dir);
    if (state === "same") continue;
    // Ссылку пользователя (файл на другом томе) не перезаписываем через неё
    if (isLink(join(dir, n))) {
      lines.push(`  файл секрета ${n}: это ссылка — не перезаписываю${state === "update" ? " (значение в secrets.env другое)" : ""}`);
      continue;
    }
    writeAtomic(join(dir, n), secrets[n] + "\n", { sensitive: true });
    wrote = true;
    if (state === "create") created.push(n);
    lines.push(`  файл секрета ${n}: ${state === "create" ? "создан" : "обновлён"}`);
  }
  // Закрыть открытые файлы секретов рядом — только когда что-то записано (doctor говорит так же; повторная проверка 2
  // круга 8b, п. 5)
  if (win && wrote) protectFiles(dir);
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
  if (why) throw new Error(`${slash(dir)} — ссылка на ${slash(target)}: ${why}; miksy права цели ссылки не меняет — закройте вручную${SHELL}: ${closeCommand(target)}`);
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
  closeOwn(dir, true);
}

// Свой файл или папку (local/, а за ссылкой — то, что miksy создал сам: папки бэкапов и оригиналов, копию «до miksy»,
// файлы секретов) закрыть явно: без наследования, полный доступ только вам; папке — с наследованием вниз. Не зависит от
// того, как закрыта цель ссылки: /reset при цели без наследуемых записей оставил бы файл без доступа даже для вас
// (выпуск 0.2.2, круг 8d, E1). macOS, Linux — права задаёт mkdir/writeAtomic (0700/0600)
export function closeOwn(p: string, dir: boolean) {
  if (!win) return;
  if (icacls([native(p), "/inheritance:r", "/grant:r", `*${mySid()}:${dir ? "(OI)(CI)" : ""}F`]) !== 0) throw new Error(`${slash(p)}: icacls не изменил доступ`);
  for (const other of others(p)) {
    const sid = ({ SY: "S-1-5-18", BA: "S-1-5-32-544", BU: "S-1-5-32-545", AU: "S-1-5-11", WD: "S-1-1-0" } as Record<string, string>)[other] ?? other;
    if (icacls([native(p), "/remove:g", `*${sid}`]) !== 0) throw new Error(`${slash(p)}: icacls не убрал чужой доступ`);
  }
}

// Лежит ли путь за ссылкой внутри local/ (local/backups, local/secrets на другом томе и т. п.)
export function behindLink(p: string, config = configRoot()): boolean {
  const local = join(config, "local");
  const rel = relative(local, p);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
  let cur = local;
  for (const seg of rel.split(/[\\/]/).slice(0, -1)) {
    cur = join(cur, seg);
    if (isLink(cur)) return true;
  }
  return false;
}

const isLink = (p: string) => {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
};

// Обход local/ для прав. Ни в одну ссылку (junction, ссылка на папку или файл, битая) не заходит: её цель вне
// miksy (chmod или icacls по ссылке изменили бы чужие файлы — например, dotfiles за ссылкой в копии «до miksy»;
// выпуск 0.2.2, круг 8b, C1). paths — настоящие файлы и папки; links — ссылки (для проверки цели);
// linked — папки, внутри которых на любой глубине есть ссылка (icacls /t в них не запускается)
type Walk = { paths: string[]; links: string[]; linked: Set<string> };
function walkLocal(root: string): Walk {
  const w: Walk = { paths: [], links: [], linked: new Set() };
  const go = (dir: string): boolean => {
    w.paths.push(dir);
    let has = false;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) { w.links.push(p); has = true; }
      else if (e.isDirectory()) { if (go(p)) has = true; }
      else w.paths.push(p);
    }
    if (has) w.linked.add(dir);
    return has;
  };
  if (existsSync(root)) go(root);
  return w;
}

// local/ целиком может быть ссылкой (перенесён на другой том): права — у каталога назначения
function localRoot(dir: string): string {
  if (!isLink(dir)) return dir;
  try { return realpathSync(dir); }
  catch { throw new Error(`${slash(dir)}: ссылка local/ ведёт в несуществующий каталог`); }
}

// Ссылка в копии «до miksy» (local/backups/before-miksy-*/…) ведёт к собственным файлам пользователя, как до miksy:
// ни цель, ни битость не проверяются (выпуск 0.2.2, круг 8b, C1)
function inCopy(root: string, link: string): boolean {
  const [top, copy, ...rest] = relative(root, link).split(/[\\/]/);
  const norm = (s: string) => (win ? s.toLowerCase() : s);
  return rest.length > 0 && norm(top) === "backups" && norm(copy).startsWith("before-miksy-");
}

// Ссылки внутри local/ (кроме копии «до miksy»): цель только проверяется — открытая или битая ссылка — предупреждение
function linkProblems(root: string, links: string[]): string[] {
  return links.filter((l) => !inCopy(root, l) && !(samePathKey(l, join(root, "backups")) || under(join(root, "backups"), l))).flatMap((l) => {
    let target: string;
    try { target = realpathSync(l); } catch { return [`${slash(l)}: битая ссылка внутри local/ — исправьте или удалите её`]; }
    const why = aclProblem(target);
    return why ? [`${slash(l)} → ${slash(target)}: ${why} — это ссылка: miksy права её цели не меняет, закройте вручную${SHELL}: ${closeCommand(target)}`] : [];
  });
}

// Готовая команда, которая закрывает цель ссылки владельцу (выпуск 0.2.2, круг 8c, C11). Windows: /reset снимает все
// явные записи (и ваши), /inheritance:r — унаследованные, /grant:r оставляет полный доступ вам; папке — с наследованием
// (OI)(CI), файлу — без него (иначе у файла не осталось бы записей); без /T — только сама цель. Путь — в одинарных
// кавычках оболочки: PowerShell удваивает ' и ‘ ’ ‚ ‛, sh — '\''. macOS, Linux: папка — 700, файл — 600
export function closeCommand(target: string, dir = (() => { try { return statSync(target).isDirectory(); } catch { return false; } })()): string {
  if (!win) return `chmod ${dir ? "700" : "600"} '${target.replaceAll("'", "'\\''")}'`;
  const q = `'${native(target).replace(/['‘’‚‛]/g, "$&$&")}'`;
  return `icacls ${q} /reset; icacls ${q} /inheritance:r /grant:r '*${mySid()}:${dir ? "(OI)(CI)" : ""}F'`;
}
// Закрыть папку и всё в ней (свои папки miksy за ссылкой): папку — как closeCommand, затем каждый элемент внутри — к
// наследованию от неё, по одному и сверху вниз, ссылки пропускаются (их объект и цель не меняются). Не icacls /t: он
// заходит в junction. Сверху вниз — и для папок без единой записи прав (так их оставляла 0.2.1 при цели без
// наследования): владелец может сбросить права, а прочесть папку — только после сброса (круг 8d, рецензия A №1)
function closeTreeCommand(dir: string): string {
  if (!win) return `chmod -R go-rwx '${dir.replaceAll("'", "'\\''")}'`;
  const q = `'${native(dir).replace(/['‘’‚‛]/g, "$&$&")}'`;
  return `${closeCommand(dir, true)}; function Reset-MiksyTree($d) { Get-ChildItem -LiteralPath $d -Force | Where-Object { -not ($_.Attributes -band 1024) } | ForEach-Object { icacls $_.FullName /reset /q | Out-Null; if ($_.PSIsContainer) { Reset-MiksyTree $_.FullName } } }; Reset-MiksyTree ${q}`;
}
// Где выполнять команду — до двоеточия: после него только сама команда (её выполняют как есть; рецензия B круга 8c, п. 4)
const SHELL = win ? " (PowerShell)" : "";

const samePathKey = (a: string, b: string) => (win ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b));

// Отказ записи бэкапов (выпуск 0.2.2, круг 8c, C10; рецензия A круга 8c, п. 1, 3, 4, 9). Текст — что не так, два выхода,
// готовая команда — последней (её можно скопировать до конца строки). Ответ запоминается на процесс
const refusals = new Map<string, string | null>();
const remember = (p: string, f: () => string | null): string | null => {
  const key = resolve(p);
  if (!refusals.has(key)) refusals.set(key, f());
  return refusals.get(key)!;
};
const isDirAt = (p: string) => { try { return statSync(p).isDirectory(); } catch { return true; } };
const NOT_HERE = "miksy не пишет туда бэкапы и копии ваших файлов (в них бывают токены)";
// Ссылка с открытой, нечитаемой или несуществующей целью
function linkRefusal(p: string): string | null {
  return remember(p, () => {
    if (!isLink(p)) return null;
    // Ссылка внутри папки оригиналов (originals/C и глубже): сквозь неё оригинал не пишется никогда (guard), как ни
    // закрой цель, — выход один: заменить её обычной папкой (круг 8d, A №3)
    const deep = /\/backups\/originals\/[^/]/i.test(slash(p));
    let target: string;
    try { target = realpathSync(p); }
    catch { return `${slash(p)}: битая ссылка внутри local/ — ${NOT_HERE}. ${deep ? "Замените" : "Исправьте ссылку или замените"} её обычной папкой ${slash(p)} (оригиналы ваших файлов, если были, остались в её прежней цели — скопируйте их сюда; шаги — README, сообщение «… ссылка на …: … miksy не пишет туда бэкапы»)`; }
    let why: string | null;
    try { why = aclProblem(target); } catch (e) { why = `права не прочитать (${(e as Error).message})`; }
    const replace = `${isDirAt(target) ? "обычной папкой" : "обычным файлом"} ${slash(p)} с содержимым цели (там оригиналы ваших файлов, по ним clean их возвращает; шаги — README, сообщение «… ссылка на …: … miksy не пишет туда бэкапы»)`;
    // Внутри originals — отказ и при закрытой цели: сквозь ссылку там не пишется (рецензия A круга 8d, №2)
    if (deep) return `${slash(p)} — ссылка на ${slash(target)}${why ? `: ${why}` : ""}. Внутри папки оригиналов miksy не пишет сквозь ссылку, даже если её цель закрыта, — ${NOT_HERE}. Замените эту ссылку ${replace}`;
    if (!why) return null;
    return `${slash(p)} — ссылка на ${slash(target)}: ${why}. ${NOT_HERE}. Выход — закрыть цель или заменить эту ссылку ${replace}. Закрыть цель${SHELL}: ${closeCommand(target)}`;
  });
}
// Настоящая папка за закрытой ссылкой (originals — в неё пишутся точные копии), открытая другим. Только Windows: на
// macOS и Linux через закрытую цель (700) другие к ней не пройдут (повторная проверка 1 круга 8c, п. 3)
function openRefusal(p: string): string | null {
  if (!win) return null;
  return remember(p, () => {
    let why: string | null;
    try { why = aclProblem(p) ?? noAccess(p); } catch (e) { why = `права не прочитать (${(e as Error).message})`; }
    if (!why) return null;
    // Закрыть всё поддерево за один раз (ссылки команда пропускает): папку оригиналов, если путь в ней, иначе саму папку
    // (круг 8d, E1; рецензия A №1)
    const top = slash(p).match(/^(.*\/backups\/originals)(?:\/|$)/i)?.[1];
    return top
      ? `${slash(p)}: ${why}. ${NOT_HERE}. Закройте папку оригиналов и всё в ней${SHELL}: ${closeTreeCommand(top)}`
      : `${slash(p)}: ${why}. ${NOT_HERE}. Закройте папку и всё в ней${SHELL}: ${closeTreeCommand(p)}`;
  });
}
// Папка, которую не прочесть даже вам: права без единой записи (0.2.1 и раньше сбрасывали их сквозь ссылку, а у цели без
// наследования наследовать нечего) — для aclProblem она «закрыта» (рецензия A круга 8d, №1)
function noAccess(p: string): string | null {
  try { readdirSync(p); return null; }
  catch (e) { return ["EPERM", "EACCES"].includes((e as NodeJS.ErrnoException).code ?? "") ? "нет доступа даже вам (папка без записей прав — так её оставляли 0.2.1 и раньше, когда цель ссылки закрыта без наследования)" : null; }
}
const under = (dir: string, p: string) => { const r = relative(dir, p); return r !== "" && !r.startsWith("..") && !isAbsolute(r); };

// Отказ записи в local/backups — для команды целиком (privateLocal, --dry-run, doctor, начало пишущих команд): ссылка
// local/backups или любая ссылка глубше (кроме ссылок копии «до miksy» — по ним miksy не пишет) с открытой или
// несуществующей целью; local/backups — ссылка на закрытую цель, а папка originals за ней открыта. links — ссылки
// local/ из уже сделанного обхода (иначе обход local/backups). null — писать можно
export function backupsRefusal(dir = join(configRoot(), "local"), links?: string[]): string | null {
  if (!existsSync(dir)) return null;
  let root: string;
  try { root = resolve(localRoot(dir)); } catch { return null; }
  const b = join(root, "backups");
  try {
    if (isLink(b)) {
      const r = linkRefusal(b);
      if (r) return r;
      const o = join(b, "originals");
      if (isLink(o)) return linkRefusal(o);
      if (!win) return null;
      // Свои папки за ссылкой: originals открыта или без доступа для вас, папка запуска без доступа (их оставила 0.2.1 —
      // rotate падал бы на ней в каждом запуске). Одна команда на всю цель: закрыть её и сбросить права всего внутри к
      // наследованию, ссылки пропускаются (круг 8d, E1; рецензия A №1)
      const bad: [string, string][] = [];
      if (existsSync(o)) { let why: string | null; try { why = aclProblem(o) ?? noAccess(o); } catch (e) { why = `права не прочитать (${(e as Error).message})`; } if (why) bad.push([o, why]); }
      for (const e of readdirSync(b, { withFileTypes: true }))
        if (e.isDirectory() && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(e.name)) { const why = noAccess(join(b, e.name)); if (why) bad.push([join(b, e.name), why]); }
      if (!bad.length) return null;
      const [p, why] = bad[0];
      return `${slash(p)}${bad.length > 1 ? ` (и ещё ${bad.length - 1})` : ""}: ${why}. ${NOT_HERE}. Закройте папку бэкапов и всё в ней${SHELL}: ${closeTreeCommand(realpathSync(b))}`;
    }
    if (!existsSync(b)) return null;
    // Только на пути записи: originals и всё под ней; старые папки запусков и копии «до miksy» miksy не пишет (A №6)
    const o = join(b, "originals");
    for (const l of (links ?? walkLocal(b).links).filter((l) => samePathKey(l, o) || under(o, l))) {
      const r = linkRefusal(l);
      if (r) return r;
    }
    return null;
  } catch (e) { return `${slash(b)}: права не прочитать (${(e as Error).message}) — ${NOT_HERE}`; }
}

// Запасной замок для каждой записи в local/backups (backup, originalBackup, копия «до miksy»): ссылка на пути от local/ до
// dst с открытой или несуществующей целью — отказ; за ссылкой на закрытую цель — и открытая папка на пути
export function refuseBackupPath(dst: string, config = configRoot()): void {
  const local = join(config, "local");
  const rel = relative(local, dst);
  if (rel.startsWith("..") || isAbsolute(rel)) return;
  let p = local;
  let behind = false;
  for (const seg of rel.split(/[\\/]/).slice(0, -1)) {
    p = join(p, seg);
    try { lstatSync(p); } catch { break; }
    const r = isLink(p) ? linkRefusal(p) : behind ? openRefusal(p) : null;
    if (r) throw new Error(r);
    if (isLink(p)) behind = true;
  }
}

// Части local/ для icacls (Windows). Папка без ссылок внутри — целиком (tree: /t). Папка, внутри которой есть ссылка, —
// сама и её элементы по отдельности; ссылки — никак. Без ссылок — одна часть: весь local/ (один снимок, как раньше).
// open — корень всегда по элементам (сброс: сам корень закрывает protectDir)
type Part = { path: string; tree: boolean };
function parts(root: string, w: Walk, open = false): Part[] {
  const out: Part[] = [];
  const go = (dir: string) => {
    if (!w.linked.has(dir) && !(open && dir === root)) return void out.push({ path: dir, tree: true });
    out.push({ path: dir, tree: false });
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) go(p);
      else out.push({ path: p, tree: false });
    }
  };
  go(root);
  return out;
}

// Снимок ACL по частям. Папка без ссылок — icacls /save /t (строки — от её родителя). Папка со ссылкой внутри — маска
// «папка\*» без /t (её прямые элементы, строки — имена) и сама папка, если это корень (остальные — элементы маски
// родителя). Ключ — полный путь в нижнем регистре. Файлы отдельно не читаются: их дают маски
function snapshot(root: string, w: Walk): Map<string, string> {
  const acl = new Map<string, string>();
  const tmp = join(tmpdir(), `miksy-local-acl-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
  const read = (path: string, flags: string[], base: string) => {
    try {
      if (icacls([native(path), "/save", tmp, ...flags]) !== 0) throw new Error(`icacls не прочитал ${slash(path)}`);
      const lines = readFileSync(tmp, "utf16le").split(/\r?\n/);
      for (let i = 0; i + 1 < lines.length; i += 2) if (lines[i]) acl.set(join(base, lines[i]).toLowerCase(), lines[i + 1]);
    } finally { rmSync(tmp, { force: true }); }
  };
  for (const p of parts(root, w)) {
    if (p.tree) read(p.path, ["/t", "/q", "/L"], dirname(p.path));
    else if (w.linked.has(p.path)) {
      if (p.path === root) read(p.path, ["/q"], dirname(p.path));
      read(join(p.path, "*"), ["/q", "/L"], p.path);
    }
  }
  return acl;
}
// Проверка прав local/: только настоящие файлы и папки (обход без ссылок). Windows — снимок ACL по частям (без ссылок —
// один на всё дерево: doctor не запускает icacls отдельно для тысяч бэкапов). bad — открытые пути (sync/setup
// закроют); links — ссылки с открытой или несуществующей целью (кроме копии «до miksy»); open — открытые пути полностью,
// в нижнем регистре (что сбрасывать), null — проверка не удалась (сбрасывать всё)
function scan(dir: string): { bad: string[]; links: string[]; open: Set<string> | null; refuse: string | null } {
  // Ссылки local/backups с открытой целью — это отказ (backupsRefusal), не «открытые пути»
  if (!existsSync(dir)) return { bad: [], links: [], open: new Set(), refuse: null };
  try {
    const root = resolve(localRoot(dir));
    const w = walkLocal(root);
    const linked = linkProblems(root, w.links);
    const refuse = backupsRefusal(root, w.links);
    const bad: string[] = [];
    const open = new Set<string>();
    if (!win) {
      for (const p of w.paths) { const why = aclProblem(p); if (why) { bad.push(`${slash(p)}: ${why}`); open.add(p.toLowerCase()); } }
      return { bad, links: linked, open, refuse };
    }
    const me = mySid();
    // Без ссылок — как 0.2.1: один снимок /t, строки подряд, без карты путей (скорость; выпуск 0.2.2, круг 8c, C13).
    // icacls никуда не заходит — все строки снимка — пути local/; не прочитал что-то — код не 0 (ошибка ниже)
    if (!w.links.length) {
      const tmp = join(tmpdir(), `miksy-local-acl-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
      try {
        if (icacls([native(root), "/save", tmp, "/t", "/q", "/L"]) !== 0) throw new Error("icacls не прочитал local/");
        const lines = readFileSync(tmp, "utf16le").split(/\r?\n/);
        for (let i = 0; i + 1 < lines.length; i += 2) {
          const foreign = foreignAces(lines[i + 1], me);
          if (!foreign.length) continue;
          bad.push(`${lines[i]}: доступ есть не только у владельца (${foreign.join(", ")})`);
          open.add(join(dirname(root), lines[i]).toLowerCase());
        }
      } finally { rmSync(tmp, { force: true }); }
      return { bad, links: linked, open, refuse };
    }
    const acl = snapshot(root, w);
    // Только пути обхода: строки снимка вне него (если icacls куда-то зашёл) — не пути local/
    for (const p of w.paths) {
      const sddl = acl.get(p.toLowerCase());
      const shown = relative(dirname(root), p);
      const foreign = sddl === undefined ? [] : foreignAces(sddl, me);
      if (sddl === undefined) bad.push(`${shown}: icacls не прочитал права`);
      else if (foreign.length) bad.push(`${shown}: доступ есть не только у владельца (${foreign.join(", ")})`);
      else continue;
      open.add(p.toLowerCase());
    }
    return { bad, links: linked, open, refuse };
  } catch (e) { return { bad: [(e as Error).message], links: [], open: null, refuse: backupsRefusal(dir) }; }
}
// refuse — запись в local/backups будет отказана (C10): --dry-run и doctor говорят то же, что настоящий запуск
export function checkLocalAccess(dir = join(configRoot(), "local")): { bad: string[]; links: string[]; refuse: string | null } {
  const { bad, links, refuse } = scan(dir);
  return { bad, links, refuse };
}

// Закрыть local/ владельцу: сначала проверка, исправление — только если есть открытые пути (Windows: не обходить ACL
// десятков тысяч бэкапов при каждом sync). Только настоящие файлы и папки, в ссылки не заходит. fixed — права менялись;
// warnings — ссылки внутри local/ (их цель не меняется)
export function privateLocal(dir = join(configRoot(), "local")): { fixed: boolean; warnings: string[] } {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const root = resolve(localRoot(dir));
  const before = scan(root);
  // Отказ в начале команды, до любой записи (C10)
  if (before.refuse) throw new Error(before.refuse);
  if (!before.bad.length) return { fixed: false, warnings: before.links };
  const w = walkLocal(root);
  if (win) {
    // Наследование от закрытого local/ сквозь junction и ссылку на папку не идёт (проверено, круг 8b). Сбрасываются только
    // части, где проверка нашла открытые пути (проверка не удалась — все): иначе рядом со ссылкой — запуск icacls на каждую
    // соседнюю папку и файл (рецензия A круга 8b, п. 1). Файл — без /t: с /t icacls сбросил бы и одноимённые файлы во
    // всех вложенных папках, в том числе за ссылками
    const open = before.open;
    const has = (p: Part) => {
      if (!open) return true;
      const k = p.path.toLowerCase();
      return open.has(k) || (p.tree && [...open].some((o) => o.startsWith(k + "\\")));
    };
    protectDir(root);
    for (const p of parts(root, w, true))
      if (p.path !== root && has(p) && icacls([native(p.path), "/reset", ...(p.tree ? ["/t"] : []), "/q", "/L"]) !== 0)
        throw new Error(`${slash(p.path)}: icacls не закрыл доступ`);
  } else for (const p of w.paths) chmodSync(p, statSync(p).isDirectory() || (statSync(p).mode & 0o100) ? 0o700 : 0o600);
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
    if (others(join(dir, n)).length) closeOwn(join(dir, n), false);
}

// Разрешающие записи ACL не текущего пользователя (SID или псевдоним SDDL: SY, BA, …).
// SDDL — через icacls /save: без локализованных имён и кодовых страниц
function others(path: string): string[] {
  const tmp = join(tmpdir(), `miksy-acl-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
  try {
    if (icacls([native(path), "/save", tmp]) !== 0) throw new Error(`${slash(path)}: icacls не прочитал доступ`);
    return foreignAces(readFileSync(tmp, "utf16le").split(/\r?\n/)[1] ?? "", mySid());
  } finally {
    rmSync(tmp, { force: true });
  }
}

// Разрешающие записи SDDL не для me. Встроенные учётки машины SDDL пишет сокращением, а не SID: «LA» —
// Администратор (…-500, так работают раннеры GitHub Windows), «LG» — Гость (…-501). Иначе miksy счёл бы
// свою же запись чужой, удалил её и закрыл local/ от самого себя
export function foreignAces(sddl: string, me: string): string[] {
  const alias: Record<string, string> = { LA: "-500", LG: "-501" };
  const mine = (t: string) => t === me || (alias[t] !== undefined && me.endsWith(alias[t]));
  const aces = [...sddl.matchAll(/\(([A-Z]+);[^;]*;[^;]*;[^;]*;[^;]*;([^)]+)\)/g)];
  return [...new Set(aces.filter((a) => a[1] === "A" && !mine(a[2])).map((a) => a[2]))];
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
  // local/secrets — ссылка (каталог на другом томе): права за ней miksy не меняет (выпуск 0.2.2, круг 8b, C1). Строки —
  // ровно о том, что делает sync (рецензия A круга 8b, п. 4; повторная проверка, п. 3, 4): цель ссылки открыта или её
  // нет — sync туда не пишет (linkedDir), закрыть вручную; цель закрыта — файл секрета за ссылкой sync закрывает, только
  // когда пишет: записанный файл закрыт всегда (writeAtomic: 0600, на Windows — права закрытой цели), а на Windows при
  // любой записи в каталог закрываются и остальные открытые файлы секретов в нём (protectFiles). Права смотрятся у цели:
  // icacls по самой ссылке читал бы права её объекта
  const linked = isLink(dir);
  let target: string | null = null;
  try { target = linked ? realpathSync(dir) : null; } catch { /* битая — ниже */ }
  const targetWhy = !linked ? null : target ? aclProblem(target) : "битая ссылка внутри local/ — исправьте или удалите её";
  // Готовая команда — в конце строки (C11): что закрыть, miksy знает сам
  const manual = (p: string) => { let t = p; try { t = realpathSync(p); } catch { /* битая */ } return ` — это ссылка: miksy права её цели не меняет, закройте вручную${SHELL}: ${closeCommand(t)}`; };
  if (linked) {
    // Цель открыта или ссылка битая — writeSecretFiles отказывает (linkedDir): sync пропускает цель, которой нужны эти секреты
    if (targetWhy) problems.push(`${dir}${target ? ` → ${slash(target)}` : ""}: ${targetWhy}; пока так, miksy sync туда не пишет и цели, которым нужны эти секреты, может пропускать («ОШИБКА (цель пропущена): файлы секретов не записаны …»)${target ? `. Это ссылка: miksy права её цели не меняет, закройте вручную${SHELL}: ${closeCommand(target)}` : ""}`);
  } else if (existsSync(dir)) {
    const why = aclProblem(dir);
    if (why) problems.push(`${dir}: ${why} — miksy sync исправит`);
  }
  const behind = (p: string) => targetWhy ? "" : win
    ? ` — файл за ссылкой local/secrets: miksy закрывает такие файлы, когда записывает в этот каталог файл секрета (значение в secrets.env новое или изменилось); до тех пор закройте вручную${SHELL}: ${closeCommand(p, false)}`
    : ` — файл за ссылкой local/secrets: miksy закрывает его, когда записывает в него (значение в secrets.env изменилось); до тех пор закройте вручную${SHELL}: ${closeCommand(p, false)}`;
  // Цель ссылки открыта или её нет — sync не пишет (linkedDir)
  const blocked = targetWhy ? `, когда ${target ? "каталог за ссылкой local/secrets будет закрыт" : "ссылка local/secrets будет исправлена"} (строка выше)` : "";
  for (const [n, users] of [...needed].sort()) {
    const path = join(dir, n);
    const who = users.join(", ");
    const state = secretFileState(n, secrets, dir);
    // Битый файл-ссылка: sync его не перезаписывает и не создаёт файл (повторная проверка 3 круга 8b, п. 4)
    if (!existsSync(path) && isLink(path)) {
      problems.push(`${n}: файл секрета — битая ссылка: miksy её не перезаписывает — исправьте или удалите её (${who})`);
      continue;
    }
    if (!existsSync(path)) {
      problems.push(state === "missing"
        ? `${n}: не задан в local/secrets.env и файла нет — серверы не запустятся (${who})`
        : `${n}: нет файла секрета — miksy sync создаст${blocked} (${who})`);
      continue;
    }
    if (state === "missing") info.push(`${n}: не задан в local/secrets.env — файл от прошлого sync оставлен, пока сервер записан (${who})`);
    else if (state === "update") problems.push(`${n}: ${isLink(path) ? "файл секрета — ссылка: miksy её не перезаписывает (значение в secrets.env другое или файл не читается — проверьте цель ссылки)" : `файл секрета устарел (значение в secrets.env другое) — miksy sync обновит${blocked}`}`);
    let why: string | null;
    try { why = aclProblem(path); } catch { why = "не читается (битая ссылка?)"; }
    // Файл-ссылку sync не перезаписывает и не закрывает; свой файл за ссылкой local/secrets — как сказано выше (behind)
    if (why) problems.push(`${slash(path)}: ${why}${isLink(path) ? manual(path) : linked ? (targetWhy ? ` — ${target ? "каталог за ссылкой local/secrets открыт" : "ссылка local/secrets битая"} (строка выше): miksy туда не пишет` : behind(path)) : ""}`);
  }
  if (existsSync(dir))
    for (const n of readdirSync(dir).filter((x) => NAME.test(x) && !needed.has(x))) {
      if (ledger.includes(n) && plainFile(join(dir, n))) problems.push(`${n}: лишний файл секрета (не нужен ни одной цели) — miksy sync удалит`);
      else info.push(`${n}: файл в local/secrets не от miksy (или ссылка) — не нужен ни одной цели, miksy его не трогает`);
    }
  return { problems, info };
}
