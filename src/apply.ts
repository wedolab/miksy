import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, rmdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { RenderResult, Target } from "./adapter";
import { canonical, escapes, guard, inside, safeRelative } from "./bounds";
import { fold, pathKey, slash } from "./paths";
import { headerMark, miksyOpencodeJson } from "./marks";
import { GitError, gitEnv, protectedBy, trackedPaths } from "./git";
import { backup, originalBackup, runDir } from "./backup";
import { blockHash, instructionBlock, joinOutside, splitInstructions } from "./instructions";
import { type ApproveAction, editTrustToml, readTrust, trustId, trustPlan, trustValue, type TrustAction } from "./trust";
import { canonicalState, emptyState, type ForgottenMark, pruneState, rememberPath, removeFile, repairMode, sha, type TargetState, UNKNOWN_HASH, writeAtomic } from "./manifest";
import type { Machine } from "./types";
import { configRoot } from "./load";
import { ensurePrivateLocal } from "./secretfiles";
import { AGENT_ALIASES } from "./agentid";
import { definitionHash, mcpTables, ownedTomlParts, parseToml, replaceOwnedMcp, splitToml } from "./toml";

// roots — где путь обязан остаться после раскрытия симлинков (проект, домашний каталог);
// apply перепроверяет непосредственно перед записью и удалением
// known — файл (блок) miksy, которого не было в учёте (miksyMade): берётся обратно без оригинала
export type Action = { sensitive?: boolean; original?: boolean; restoreBlock?: boolean; beforeHash?: string; known?: boolean } & (
  | TrustAction
  | ApproveAction
  | { kind: "write"; abs: string; content: string; why: "новый" | "обновление"; executable?: boolean; roots?: string[] }
  | { kind: "adopt"; abs: string; content: string; executable?: boolean }
  // Только права (секретный файл открыт группе, скрипту не хватает +x): chmod без перезаписи и бэкапа
  | { kind: "chmod"; abs: string; mode: number; roots?: string[] }
  | { kind: "forget-merge"; abs: string; key: string[]; beforeHash: string }
  | { kind: "delete"; abs: string; roots?: string[] }
  | { kind: "restore"; abs: string; source: string; sourceHash: string; roots: string[] }
  | { kind: "block"; abs: string; content: string; hash: string | null; roots: string[] }
  // Снять файл с учёта цели, не удаляя: им владеет другая цель
  | { kind: "release"; abs: string; owner: string }
  | { kind: "merge"; abs: string; key: string[]; set: Record<string, unknown>; remove: string[]; adopt: string[]; own: string[]; roots?: string[]; beforeHash?: string }
  | { kind: "toml"; abs: string; content: string; beforeHash: string; names: string[]; definitions?: Record<string, string>; written?: string[]; roots?: string[] }
  // lines — итоговые строки блока; pre — на время apply (ещё и удаляемые файлы): пишется до файлов
  // unrecorded — строки не записываются в учёт (clean цели без учёта: оставшиеся строки — от забытого учёта)
  | { kind: "exclude"; abs: string; roots?: string[]; lines: string[]; pre?: string[]; owner: string; unrecorded?: boolean }
  | { kind: "conflict"; abs: string; why: string });

const UNKNOWN_WHY = "учёт: при миграции для файла нашлись разные записи — хеш неизвестен, проверьте файл (--force перезапишет, бэкап будет)";


const readJson = (p: string) => {
  if (!existsSync(p)) return {};
  const t = readFileSync(p, "utf8").trim();
  return t ? JSON.parse(t) : {};
};
const get = (o: any, key: string[]) => key.reduce((x, k) => (x == null ? undefined : x[k]), o);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function setAt(o: any, key: string[], value: unknown) {
  let x = o;
  for (const k of key.slice(0, -1)) x = x[k] ??= {};
  x[key[key.length - 1]] = value;
}

// Файл exclude проекта. Worktree хранит info/exclude в общем git-dir основного репо — тогда
// shared: блок помечается каталогом worktree, иначе worktree и основной репо перетирали бы блоки друг друга
function excludeFile(dir: string): { path: string; shared: boolean; root: string } | null {
  const git = join(dir, ".git");
  if (!existsSync(git)) return null;
  if (lstatSync(git).isDirectory()) return { path: join(git, "info", "exclude").replaceAll("\\", "/"), shared: false, root: canonical(git) };
  const r = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--git-path", "info/exclude", "--git-dir", "--git-common-dir"], {
    stdout: "pipe",
    stderr: "pipe",
    env: gitEnv(),
  });
  if (r.exitCode !== 0) throw new GitError(`git exclude для ${dir}: ${r.stderr.toString().trim() || `код ${r.exitCode}`}`);
  const [path, gitDir, common] = r.stdout.toString().trim().split(/\r?\n/).map((p) => resolve(dir, p).replaceAll("\\", "/"));
  return { path, shared: canonical(gitDir) !== canonical(common), root: canonical(common) };
}

// Первый существующий родитель пути (до base), который не каталог
function occupiedParent(path: string, base: string): string | null {
  for (let d = dirname(path); inside(d, base) && !inside(base, d); d = dirname(d))
    if (existsSync(d) && !statSync(d).isDirectory()) return d;
  return null;
}

// Строки exclude: файлы проекта; для skills и plugins — их каталоги, если в каталоге нет чужого
// файла с конфликтом (open): тогда — точные строки файлов, чтобы чужой файл оставался виден git
export function excludeLines(paths: string[], open: string[] = []): string[] {
  const lines = paths.map((p) => {
    const m = p.match(/^(\.(?:claude|codex|agents|opencode)\/skills\/[^/]+)\//) ?? p.match(/^(\.agents\/plugins\/[^/]+)\//);
    if (m && !open.some((o) => fold(o).startsWith(fold(m[1] + "/")))) return "/" + m[1] + "/";
    return "/" + p;
  });
  return [...new Set(lines)].sort();
}

// Файл проекта, который явно сделал miksy, хотя учёта о нём нет (учёт забыт — clean --forget, а диск вернулся).
// Только улики самого miksy:
// - шапка «Сгенерировано miksy» в начале файла (marks.ts: headerMark);
// - у файла с блоком инструкций (block) — блок miksy как блок: пара маркеров на своих строках;
// - собственный корневой opencode.json miksy (marks.ts: miksyOpencodeJson);
// - файл без метки (skills, plugin.json, …) — только если его текст тот же, что miksy записал бы сейчас
//   (rendered), и его уже покрывает строка блока miksy в .git/info/exclude проекта (covered): этот блок
//   остаётся на диске после «забыть» — до него miksy не дотянулся. Точная строка файла — улика всегда: её
//   miksy пишет только для своего файла. Строка каталога скрывает весь каталог — улика, только пока учёт ничего
//   не помнит о файлах цели в проекте (fresh): когда учёт цели есть, он и знает, что писал miksy, —
//   незаписанный файл под строкой каталога (заметки пользователя в каталоге skill) — чужой. Решает вызывающий.
// Путь (каталог плагина miksy) и совпадение текста сами по себе — не улика: такой файл мог положить
// пользователь, он берётся с оригиналом. Неотслеживаемость git проверяет вызывающий
export function miksyMade(path: string, opts: { rendered?: string; covered?: boolean; block?: boolean } = {}): boolean {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return false; }
  if (headerMark(text)) return true;
  if (/(^|\/)opencode\.json$/.test(slash(path)) && miksyOpencodeJson(text)) return true;
  if (opts.block) {
    try { if (splitInstructions(text).block) return true; } catch { /* повреждённые маркеры — не улика */ }
  }
  return opts.rendered !== undefined && !!opts.covered && text === opts.rendered;
}

// Покрывает ли строка блока exclude (точная строка файла или строка каталога) путь проекта rel
export const coveredBy = (lines: string[], rel: string) => lines.some((l) => l === `/${rel}` || (l.endsWith("/") && `/${rel}`.startsWith(l)));

// Файлы под каталогом (относительные пути проекта); ссылки не раскрываются
function filesUnder(dir: string, rel: string): string[] {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((e) => e.isDirectory() ? filesUnder(join(dir, e.name), `${rel}/${e.name}`) : e.isFile() ? [`${rel}/${e.name}`] : []);
}

// owner — id агента: в общих файлах проекта (.git/info/exclude) у каждого агента свой блок.
// owners — файлы других целей (канонический путь → цель): второй владелец одного файла — конфликт
// mark — отметка «проект забыт» этой цели (manifest.forgotten): только с ней план убирает файлы miksy без учёта,
// которые miksy больше не пишет
export function plan(result: RenderResult, target: Target, machine: Machine, prev: TargetState, force: boolean, owner = "miksy", owners: Map<string, string> = new Map(), mark?: ForgottenMark): Action[] {
  machine = { ...machine, home: canonical(machine.home), workspace: pathKey(machine.workspace) };
  // clean каталога, которого нет (диск не подключён): путь не раскрывается — как записан; писать в него
  // clean не будет, а записи учёта внутри недоступного каталога сюда не приходят (commands.ts: splitState)
  if (target.scope === "project") target = { ...target, dir: result.clean ? pathKey(target.dir) : canonical(target.dir) };
  prev = canonicalState(prev);
  const actions: Action[] = [];
  // local/ конфигурации: сгенерированные обёртки и helper-ы секретов (base "local")
  const localRoot = canonical(join(configRoot(), "local"));
  const rootOf = (base: "home" | "project" | "local") => (base === "local" ? localRoot : base === "project" && target.scope === "project" ? target.dir : machine.home);
  // Секретные пути: из рендера и всё, где учёт уже держит наши MCP (keep единственного сервера:
  // адаптер файл не вернул, но права уже записанного файла с секретом всё равно закрываем)
  // Слитые ключи — всегда MCP: секретны и merge-файлы рендера (иначе первая запись и следующий план
  // расходились бы в правах)
  const sensitivePaths = new Set([
    ...result.files.filter((f) => f.sensitive || f.mode === "merge").map((f) => pathKey(join(rootOf(f.base), f.path))),
    ...Object.keys(prev.merges), ...Object.keys(prev.toml ?? {}),
  ]);
  const finish = (list: Action[]) => markSensitive(list, sensitivePaths);
  // Права, до которых надо исправить существующий файл; null — исправлять нечего (или Windows)
  const modeFix = (p: string, executable = false): number | null =>
    process.platform === "win32" || !existsSync(p) ? null : repairMode(statSync(p).mode, { sensitive: sensitivePaths.has(pathKey(p)), executable });
  const abs = (base: "home" | "project" | "local", p: string) => join(rootOf(base), p).replaceAll("\\", "/");
  // Пути из учёта: файлы — внутри цели и в local/ (обёртки секретов); общие файлы со слитыми
  // ключами — ещё и в домашнем каталоге
  const fileRoots = [target.scope === "project" ? target.dir : machine.home, localRoot];
  const mergeRoots = target.scope === "project" ? [target.dir, machine.home] : [machine.home];
  // Git: файл, отслеживаемый git проекта (команды) или любым репо вокруг ~ (dotfiles), не пишем
  // и не удаляем — даже с --force. Сбой git — тоже отказ, а не «не отслеживается»
  const projectPaths = result.files.filter((f) => f.base === "project" && safeRelative(f.path)).map((f) => f.path);
  let tracked = new Set<string>();
  let projectGitError: string | null = null;
  try {
    if (target.scope === "project") tracked = new Set(trackedPaths(target.dir, projectPaths));
  } catch (e) {
    projectGitError = (e as Error).message;
  }
  // Вложенное git-репо (или submodule) между файлом и корнем цели: индекс цели файла не видит,
  // exclude цели на него не действует — файл принадлежит вложенному репо
  const nestedRepo = (p: string): string | null => {
    // local/ конфигурации — служебные файлы miksy (обёртки секретов): их владелец miksy, даже
    // если конфигурация лежит внутри цели (группа home/Miksy) и сама — git-репо
    if (target.scope !== "project" || !inside(p, target.dir) || inside(p, localRoot)) return null;
    for (let d = dirname(p); inside(d, target.dir) && !inside(target.dir, d); d = dirname(d))
      if (existsSync(join(d, ".git"))) return slash(d);
    return null;
  };
  // Каталог-коллекция (skills, plugins), который команда версионирует: личный файл лёг бы среди
  // командных и был бы скрыт exclude (С22). Проверяется логический и физический путь
  const teamDirs = new Map<string, boolean>();
  const teamCollection = (path: string): string | null => {
    if (target.scope !== "project") return null;
    for (const p of new Set([path, pathKey(path)])) {
      if (!inside(p, target.dir)) continue;
      const m = relative(target.dir, p).replaceAll("\\", "/").match(/^(\.(?:claude|codex|agents|opencode)\/skills|\.agents\/plugins)\/[^/]+\//);
      if (!m) continue;
      if (!teamDirs.has(m[1])) teamDirs.set(m[1], trackedPaths(target.dir, [m[1]]).length > 0);
      if (teamDirs.get(m[1])) return m[1];
    }
    return null;
  };
  const gitChecked = new Map<string, string | null>();
  const gitRefusal = (path: string): string | null => {
    if (gitChecked.has(path)) return gitChecked.get(path)!;
    let why: string | null = null;
    try {
      const real = canonical(path);
      const nested = nestedRepo(path) ?? nestedRepo(real);
      if (nested) {
        why = `путь внутри вложенного git-репо ${nested}: файл принадлежит ему, exclude проекта на него не действует (даже с --force)`;
        gitChecked.set(path, why);
        return why;
      }
      let top: string | null = null;
      if (target.scope === "project" && inside(path, target.dir) && real === path) {
        if (projectGitError) throw new Error(projectGitError);
        const rel = relative(target.dir, path).replaceAll("\\", "/");
        // Обычные проектные пути уже проверены одним запросом. Ссылки требуют
        // отдельной проверки логического пути, предков и физической цели.
        if (tracked.has(rel) || (!projectPaths.includes(rel) && trackedPaths(target.dir, [rel]).length)) top = target.dir;
      } else top = protectedBy(path);
      // Прежние логические пути защищают, только пока ведут к тому же файлу: перенаправленная
      // ссылка указывает на чужой объект, и его git-статус к этому файлу не относится
      for (const alias of prev.aliases?.[pathKey(path)] ?? []) {
        if (top) break;
        if (pathKey(alias) === pathKey(path)) top = protectedBy(alias);
      }
      if (top) why = `файл или симлинк отслеживается git-репо ${top} — принадлежит команде (даже с --force)`;
    } catch (e) {
      why = `сбой git: ${(e as Error).message}`;
    }
    gitChecked.set(path, why);
    return why;
  };

  // .git/info/exclude проекта и строки блока miksy этого агента (под прежним именем — тоже). Строки — улика
  // для файлов без метки (miksyMade: covered), а в конце плана блок пересчитывается
  let ex: ReturnType<typeof excludeFile> = null;
  let exError: string | null = null;
  if (target.scope === "project" && !projectGitError) {
    try { ex = excludeFile(target.dir); } catch (e) { exError = (e as Error).message; }
  }
  const blockOwner = ex?.shared ? `${owner}@${target.dir}` : owner;
  const legacy = legacyOwner(blockOwner);
  const exText = ex && !escapes(ex.path, ex.root) && existsSync(ex.path) ? readFileSync(ex.path, "utf8") : "";
  const legacyBlock = !!legacy && blockRx(legacy).test(exText);
  const current = legacyBlock ? [...new Set([...excludeBlock(exText, blockOwner), ...excludeBlock(exText, legacy!)])].sort() : excludeBlock(exText, blockOwner);
  const relOf = (p: string) => relative(target.scope === "project" ? target.dir : machine.home, p).replaceAll("\\", "/");
  // Учёт ничего не помнит о файлах цели в проекте (учёт забыт — clean --forget, диск вернулся; или цель новая):
  // только тогда строка блока exclude — улика для файла без метки (miksyMade)
  const fresh = target.scope === "project" && !Object.keys(prev.files).some((p) => inside(p, target.dir)) && !Object.keys(prev.blocks ?? {}).length;
  // Файл проекта под строкой блока (точной — всегда, каталога — только fresh): по логическому пути и по
  // физическому (через свою ссылку каталога)
  const coveredRel = (rel: string) => current.includes(`/${rel}`) || (fresh && coveredBy(current, rel));
  const covered = (rel: string, path: string) => target.scope === "project" && (coveredRel(rel) || (inside(pathKey(path), target.dir) && coveredRel(relOf(pathKey(path)))));

  // Файлы целиком
  const wanted = new Set<string>();
  for (const f of result.files) {
    if (f.mode !== "own") continue;
    const path = abs(f.base, f.path);
    wanted.add(pathKey(path));
    const roots = [rootOf(f.base)];
    const outside = !safeRelative(f.path) ? "путь адаптера выходит за пределы цели" : escapes(path, ...roots);
    if (outside) {
      actions.push({ kind: "conflict", abs: path, why: `${outside} — не пишу` });
      continue;
    }
    const git = gitRefusal(path);
    if (git) {
      actions.push({ kind: "conflict", abs: path, why: `${git} — не пишу` });
      continue;
    }
    // Родительский путь занят файлом (например, командный симлинк, выгруженный как файл)
    const blocker = occupiedParent(path, rootOf(f.base));
    if (blocker) {
      actions.push({ kind: "conflict", abs: path, why: `путь занят файлом ${blocker} (симлинк команды?) — не пишу` });
      continue;
    }
    // Импортированные и личные skills размещаются по одним правилам.
    let team: string | null = null;
    try { team = teamCollection(path); }
    catch (e) { team = `(сбой git: ${(e as Error).message})`; }
    if (team) {
      actions.push({ kind: "conflict", abs: path, why: `каталог ${team} версионирует команда (в индексе есть её файлы) — личный файл не кладу: он лежал бы среди командных и был бы скрыт exclude` +
        (pathKey(path) in prev.files && existsSync(path) ? "; записанный раньше остаётся как есть, обновления не доставляются — удалите его вручную, если не нужен" : "") });
      continue;
    }
    // Уже свой (двойное владение из учёта прежних версий) — не блокируем: clean другой цели его отпустит
    const taken = !(pathKey(path) in prev.files) && owners.get(pathKey(path));
    if (taken) {
      actions.push({ kind: "conflict", abs: path, why: `этот файл (${pathKey(path)}) уже принадлежит цели ${taken} — общая ссылка каталогов? Не пишу: у файла один владелец` });
      continue;
    }
    const exists = existsSync(path);
    if (exists && statSync(path).isDirectory()) {
      actions.push({ kind: "conflict", abs: path, why: "на этом месте каталог — не пишу" });
      continue;
    }
    const onDisk = exists ? sha(readFileSync(path, "utf8")) : null;
    const recorded = prev.files[pathKey(path)];
    if (f.block) {
      try {
        const text = exists ? readFileSync(path, "utf8") : "";
        const old = prev.blocks?.[pathKey(path)];
        const parts = splitInstructions(text, old);
        if (recorded && exists && onDisk !== recorded && !force) throw new Error("инструкции: файл изменён вручную после последнего sync — миграция в блок остановлена");
        // Файла нет (удалён) — пишется заново, как own-файл; блок пропал из существующего файла или изменён — конфликт
        if (old && exists && !parts.block && !force) throw new Error("инструкции: управляемый блок удалён из файла вручную (--force вернёт блок)");
        if (old && parts.block && blockHash(parts.block) !== old && !force) throw new Error("инструкции: управляемый блок изменён вручную (--force перезапишет только блок)");
        // Прежний own-файл совпал с учётом: его содержимое теперь принадлежит блоку.
        // При --force пользователь явно разрешил замену прежнего own-файла; оригинал сохраняем.
        const before = recorded ? "" : parts.before;
        const after = recorded ? "" : parts.after;
        // Файл пересохранён с CRLF — блок пишется так же (иначе каждый sync переписывал бы его)
        const lf = instructionBlock(f.content, !!before && !before.endsWith("\n"));
        const block = parts.block.includes("\r\n") ? lf.replace(/\n/g, "\r\n") : lf;
        const content = before + block + after;
        // Блок miksy в файле проекта без учёта (учёт забыт, диск вернулся): тот же, что miksy записал бы
        // сейчас, — берётся обратно сам, без оригинала; другой — конфликт, --force перезапишет только блок
        const known = !!parts.block && !old && !recorded && f.base === "project" && target.scope === "project";
        if (parts.block && !old && !recorded && !force && !(known && blockHash(parts.block) === sha(lf)))
          throw new Error(known ? "инструкции: блок miksy, которого нет в учёте, отличается от того, что miksy записал бы сейчас (--force перезапишет только блок, бэкап будет)" : "инструкции: блок создан не miksy (--force возьмёт под учёт)");
        if (content !== text || old !== sha(lf)) actions.push({ kind: "block", abs: path, content, hash: sha(lf), beforeHash: sha(text), roots,
          ...(known && { known: true }),
          ...(recorded && onDisk !== recorded && { restoreBlock: true }),
          ...((exists && !known && ((!recorded && !old && !!text) || (recorded && onDisk !== recorded))) && { original: true }) });
      } catch (e) { actions.push({ kind: "conflict", abs: path, why: (e as Error).message }); }
      continue;
    }
    let content = f.content;
    let retained = false;
    if (f.mcp && result.keep?.length && exists && recorded) {
      // Только проверенная предыдущая версия: ручная правка не становится источником секретов.
      if (onDisk !== recorded) {
        actions.push({ kind: "conflict", abs: path, why: "MCP keep: файл изменён вручную — сохранение пропущенных серверов невозможно" });
        continue;
      }
      try {
        const parse = f.mcp.format === "json" ? JSON.parse : parseToml;
        const old = parse(readFileSync(path, "utf8"))[f.mcp.key] ?? {};
        const doc = parse(content);
        const fresh = doc[f.mcp.key] ?? {};
        const servers: Record<string, unknown> = {};
        // Сохраняем порядок старого документа: отсутствие секрета не создаёт лишнюю запись.
        for (const n of Object.keys(old)) {
          if (n in fresh) servers[n] = fresh[n];
          else if (result.keep.includes(n)) { servers[n] = old[n]; retained = true; }
        }
        Object.assign(servers, fresh);
        if (retained) {
          if (f.mcp.format === "json") { doc[f.mcp.key] = servers; content = JSON.stringify(doc, null, 2) + "\n"; }
          else content = content.split(/(?=^\[)/m)[0] + mcpTables(servers);
        }
      } catch {
        actions.push({ kind: "conflict", abs: path, why: "MCP keep: предыдущий конфиг не разбирается — не меняю" });
        continue;
      }
    }
    if (retained) sensitivePaths.add(pathKey(path));
    // Чужой файл берётся с оригиналом (clean вернёт его), даже если совпал с выводом miksy или лежит в каталоге
    // плагина miksy. Файл miksy без учёта (учёт забыт — clean --forget, диск вернулся; miksyMade — только по
    // уликам miksy, только в проекте) — без оригинала: восстанавливать нечего, clean его удалит
    const known = f.base === "project" && target.scope === "project" && exists && !recorded && miksyMade(path, { rendered: content, covered: covered(f.path, path) });
    // known — и у конфликта и перезаписи узнанного файла: для проверки доверия в sync он свой, а не чужой конфиг; в
    // просмотре miksy trust конфликтный — чужой (trust.ts, own)
    const x = { ...(f.executable && { executable: true }), roots, beforeHash: onDisk ?? sha(""), ...(exists && !recorded && !known && { original: true }), ...(known && { known: true }) };
    if (!exists) actions.push({ kind: "write", abs: path, content, why: "новый", ...x });
    else if (onDisk === sha(content)) {
      // Содержимое то же: взять под учёт (adopt исправит и права) или исправить только права —
      // скрипту не хватает +x, секретный файл открыт группе (chmod, без перезаписи и бэкапа)
      const mode = modeFix(path, !!f.executable);
      if (recorded !== onDisk) actions.push({ kind: "adopt", abs: path, content, ...x });
      else if (mode !== null) actions.push({ kind: "chmod", abs: path, mode, roots });
    }
    else if (recorded === UNKNOWN_HASH && !force) actions.push({ kind: "conflict", abs: path, why: UNKNOWN_WHY });
    else if (!recorded && !force) actions.push({ kind: "conflict", abs: path, ...(known && { known: true }), why: known
      ? "файл miksy, которого нет в учёте, отличается от того, что miksy записал бы сейчас (--force перезапишет, бэкап будет)"
      : "файл существует и создан не miksy (--force перезапишет, бэкап будет)" });
    else if (recorded && onDisk !== recorded && !force) actions.push({ kind: "conflict", abs: path, why: "изменён вручную после последнего sync (--force перезапишет, бэкап будет)" });
    else actions.push({ kind: "write", abs: path, content, why: "обновление", ...x });
  }
  for (const [path, recorded] of Object.entries(prev.files)) {
    if (wanted.has(path) || !existsSync(path)) continue;
    // Тем же файлом владеет другая цель (учёт прежних версий) — отпускаем без удаления
    if (owners.has(path)) {
      actions.push({ kind: "release", abs: path, owner: owners.get(path)! });
      continue;
    }
    const outside = escapes(path, ...fileRoots);
    if (outside) {
      actions.push({ kind: "conflict", abs: path, why: `${outside} — не удаляю` });
      continue;
    }
    // Ссылку (dotfiles) не удаляем: ни её, ни файл, на который она указывает
    if (lstatSync(path).isSymbolicLink() || prev.links?.[path]) {
      actions.push({ kind: "conflict", abs: path, why: "больше не нужен, но это симлинк — не удаляю ни ссылку, ни её цель; уберите вручную" });
      continue;
    }
    if (!statSync(path).isFile()) {
      actions.push({ kind: "conflict", abs: path, why: "больше не нужен, но на этом месте уже не файл — не удаляю" });
      continue;
    }
    const git = gitRefusal(path);
    if (git) {
      actions.push({ kind: "conflict", abs: path, why: `больше не нужен, но ${git} — не удаляю` });
      continue;
    }
    const hash = sha(readFileSync(path, "utf8"));
    const original = prev.originals?.[path];
    if (original && hash !== recorded) actions.push({ kind: "conflict", abs: path, why: `изменён вручную после захвата — оригинал для восстановления: ${original.path}` });
    else if (original) actions.push({ kind: "restore", abs: path, source: original.path, sourceHash: original.hash, roots: fileRoots, beforeHash: hash });
    else if (hash === recorded || (force && !(owner === "codex" && !result.clean && /\/\.agents\/skills\//.test(path) && result.files.some((f) => f.base === "project" && f.path.startsWith(".codex/skills/")))))
      actions.push({ kind: "delete", abs: path, roots: fileRoots, beforeHash: hash });
    else actions.push({ kind: "conflict", abs: path, why: recorded === UNKNOWN_HASH ? `больше не нужен, но ${UNKNOWN_WHY}` : "больше не нужен, но изменён вручную — не удаляю" });
  }

  for (const [path, hash] of Object.entries(prev.blocks ?? {})) {
    if (wanted.has(path)) continue;
    try {
      const refusal = escapes(path, ...mergeRoots) || gitRefusal(path);
      if (refusal) throw new Error(refusal);
      const text = existsSync(path) ? readFileSync(path, "utf8") : "";
      const parts = splitInstructions(text, hash);
      const original = prev.originals?.[path];
      if (original?.restoreBlock) {
        if (parts.before || parts.after || blockHash(parts.block) !== hash)
          throw new Error(`изменён вручную после захвата — оригинал для восстановления: ${original.path}`);
        actions.push({ kind: "restore", abs: path, source: original.path, sourceHash: original.hash, beforeHash: sha(text), roots: mergeRoots });
        continue;
      }
      if (parts.block && blockHash(parts.block) !== hash && !force) throw new Error("инструкции: управляемый блок изменён вручную — не удаляю");
      actions.push({ kind: "block", abs: path, content: joinOutside(parts.before, parts.after), hash: null, beforeHash: sha(text), roots: mergeRoots });
    } catch (e) { actions.push({ kind: "conflict", abs: path, why: (e as Error).message }); }
  }

  // Файл (блок) miksy, которого нет в учёте и который miksy больше не пишет (учёт забыт — clean --forget, диск
  // вернулся, а слои с тех пор поменялись или в проекте появился вложенный репо): убирается, как свой ненужный, —
  // с бэкапом; у блока — только блок. Только в проекте с отметкой «проект забыт» (mark): учёт у каждой машины свой,
  // а .git/info/exclude в общей облачной папке — общий, и файл miksy другой машины выглядит так же (рецензия 6w);
  // без отметки такие файлы не трогаются, как до 6w. Улики — обе сразу: блок miksy как блок или шапка
  // «Сгенерировано miksy» в начале файла, и точная строка этого файла в блоке miksy этого агента в .git/info/exclude
  // (её miksy пишет только для своего файла). Без точной строки (файл скопирован из другого проекта, цель без git),
  // файл git, файл вложенного репо, ссылка — не трогаются. clean забытой цели — так же.
  // Канонический путь → что делается (удалить файл или убрать блок); строки блока exclude этих файлов (логический и
  // физический путь) уходят вместе с ними, у удаляемого — после удаления
  const gone = new Map<string, "delete" | "block">();
  const goneLines = new Map<string, "delete" | "block">();
  for (const line of target.scope === "project" && mark ? current : []) {
    const r = line.slice(1);
    if (line.endsWith("/") || !safeRelative(r)) continue;
    const path = abs("project", r);
    const key = pathKey(path);
    if (gone.has(key)) { goneLines.set(line, gone.get(key)!); continue; }
    if (wanted.has(key) || key in prev.files || key in (prev.blocks ?? {}) || owners.has(key) || !inside(key, target.dir)) continue;
    try { if (lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) continue; } catch { continue; }
    if (gitRefusal(path) || gitRefusal(key)) continue;
    const text = readFileSync(key, "utf8");
    let parts: ReturnType<typeof splitInstructions> | null = null;
    try { parts = splitInstructions(text); } catch { /* повреждённые маркеры — не улика */ }
    if (parts?.block) actions.push({ kind: "block", abs: key, content: joinOutside(parts.before, parts.after), hash: null, beforeHash: sha(text), roots: [target.dir], known: true });
    else if (headerMark(text)) actions.push({ kind: "delete", abs: key, roots: fileRoots, beforeHash: sha(text), known: true });
    else continue;
    gone.set(key, parts?.block ? "block" : "delete");
    goneLines.set(line, gone.get(key)!);
  }

  // Слияние ключей: владеем отдельными именами внутри объекта (например, MCP-серверами)
  const merges = new Map<string, { abs: string; key: string[]; data: Record<string, unknown>; optional: boolean; roots: string[]; secret: string[] }>();
  for (const f of result.files) {
    if (f.mode !== "merge" || f.format !== "json") continue;
    const path = abs(f.base, f.path);
    const roots = [rootOf(f.base)];
    if (!safeRelative(f.path)) {
      actions.push({ kind: "conflict", abs: path, why: "путь адаптера выходит за пределы цели — не сливаю" });
      continue;
    }
    merges.set(pathKey(path) + "\0" + JSON.stringify(f.key), { abs: path, key: f.key, data: f.data as Record<string, unknown>, optional: !!f.optional, roots, secret: f.secretKeys ?? [] });
  }
  for (const [file, keys] of Object.entries(prev.merges))
    for (const k of Object.keys(keys))
      if (!merges.has(file + "\0" + k)) merges.set(file + "\0" + k, { abs: file, key: JSON.parse(k), data: {}, optional: true, roots: mergeRoots, secret: [] });
  // Чужой merge-файл внутри git-проекта (opencode.json команды, ещё не закоммиченный) не скрыт exclude:
  // git add -A взял бы и подставленный секрет. Серверы с секретами в него не сливаем (С2)
  const visibleToGit = (path: string) => target.scope === "project" && inside(path, target.dir) && existsSync(join(target.dir, ".git"));

  const keep = new Set(result.keep ?? []);
  const docs = new Map<string, any>();
  const hashes = new Map<string, string>(); // хеш файла на момент плана — apply сверяет перед записью
  const refused = new Set<string>();
  const chmodded = new Set<string>();
  for (const { abs: path, key, data, optional, roots, secret } of merges.values()) {
    if (refused.has(path)) continue;
    const outside = escapes(path, ...roots);
    if (outside) {
      refused.add(path);
      actions.push({ kind: "conflict", abs: path, why: `${outside} — не сливаю ключи` });
      continue;
    }
    const git = gitRefusal(path);
    if (git) {
      refused.add(path);
      actions.push({ kind: "conflict", abs: path, why: `${git} — не сливаю ключи` });
      continue;
    }
    if (!docs.has(path)) {
      // Битый JSON — конфликт этого файла, а не падение всего sync
      try {
        docs.set(path, readJson(path));
        hashes.set(path, fileHash(path));
      } catch {
        refused.add(path);
        actions.push({ kind: "conflict", abs: path, why: "файл не разбирается как JSON — не сливаю ключи; исправьте файл и повторите sync" });
        continue;
      }
    }
    const parent = get(docs.get(path), key.slice(0, -1));
    if (optional && parent == null) {
      if (prev.merges[pathKey(path)]?.[JSON.stringify(key)])
        actions.push({ kind: "forget-merge", abs: path, key, beforeHash: hashes.get(path)! });
      continue;
    }
    const current: Record<string, unknown> = get(docs.get(path), key) ?? {};
    const owned = prev.merges[pathKey(path)]?.[JSON.stringify(key)] ?? [];
    const set: Record<string, unknown> = {};
    const adopt: string[] = [];
    const own: string[] = [];
    const leaks = visibleToGit(path) ? new Set(secret) : new Set<string>();
    for (const [name, value] of Object.entries(data)) {
      if (leaks.has(name)) {
        // Записанный раньше остаётся как был (и в учёте); новое значение секрета не пишем
        if (owned.includes(name) && name in current) own.push(name);
        actions.push({ kind: "conflict", abs: `${path} ${JSON.stringify(key)}.${name}`, why: "сервер с секретом не сливаю в чужой файл проекта: он виден git (exclude скрывает только файлы miksy), git add отправил бы в репо команды ссылки на обёртки и файлы секретов этой машины (у остальных opencode не запустится). Удалите или переименуйте этот файл — miksy создаст свой, скрытый exclude; либо уберите секрет из определения сервера" });
        continue;
      }
      if (name in current && !owned.includes(name)) {
        if (same(current[name], value)) { adopt.push(name); own.push(name); }
        else if (force) { set[name] = value; own.push(name); }
        else actions.push({ kind: "conflict", abs: `${path} ${JSON.stringify(key)}.${name}`, why: "ключ уже есть и создан не miksy" });
        continue;
      }
      own.push(name);
      if (!same(current[name], value)) set[name] = value;
    }
    // Сервер пропущен (нет переменных), но записан раньше — остаётся как был и в учёте
    for (const n of owned) if (!(n in data) && keep.has(n) && n in current) own.push(n);
    const remove = owned.filter((n) => !(n in data) && n in current && !keep.has(n));
    if (Object.keys(set).length || remove.length || adopt.length || !same([...owned].sort(), [...own].sort()))
      actions.push({ kind: "merge", abs: path, key, set, remove, adopt, own, roots, beforeHash: hashes.get(path)! });
    else if (!chmodded.has(path)) {
      const mode = modeFix(path);
      if (mode !== null) { chmodded.add(path); actions.push({ kind: "chmod", abs: path, mode, roots }); }
    }
  }
  // Файл и сливается (другой ключ), и только исправляет права — достаточно слияния: оно пишет 0600
  for (let i = actions.length - 1; i >= 0; i--) {
    const a = actions[i];
    if (a.kind === "chmod" && actions.some((b) => b.kind === "merge" && b.abs === a.abs)) actions.splice(i, 1);
  }

  // TOML: единственный управляемый MCP-блок, с отдельным учётом для clean.
  const toml = new Map<string, { abs: string; data: Record<string, unknown>; roots: string[] }>();
  for (const f of result.files) {
    if (f.mode !== "merge" || f.format !== "toml") continue;
    const path = abs(f.base, f.path);
    if (f.key.length !== 1 || f.key[0] !== "mcp_servers") throw new Error("TOML merge поддерживает только key: [mcp_servers]");
    if (toml.has(pathKey(path))) throw new Error("TOML merge: повторное описание одного файла");
    if (!safeRelative(f.path)) {
      actions.push({ kind: "conflict", abs: path, why: "путь адаптера выходит за пределы цели — не меняю TOML" });
      continue;
    }
    toml.set(pathKey(path), { abs: path, data: f.data as Record<string, unknown>, roots: [rootOf(f.base)] });
  }
  for (const path of Object.keys(prev.toml ?? {})) if (!toml.has(path)) toml.set(path, { abs: path, data: {}, roots: mergeRoots });
  for (const { abs: path, data: wantedData, roots } of toml.values()) {
    let data = wantedData;
    try {
      const outside = escapes(path, ...roots);
      if (outside) throw new Error(`${outside} — не меняю TOML`);
      const git = gitRefusal(path);
      if (git) throw new Error(`${git} — не меняю TOML`);
      const text = existsSync(path) ? readFileSync(path, "utf8") : "";
      const recorded = prev.toml?.[pathKey(path)];
      const parts = ownedTomlParts(text, !!recorded?.definitions);
      if (parts.block && !recorded) throw new Error("TOML: блок не учтён miksy — сначала miksy adopt --global <имя> --to global --agent codex; --force не захватывает чужие имена");
      if (recorded && !recorded.definitions && sha(parts.block) !== recorded.hash && !force)
        throw new Error(recorded.hash === UNKNOWN_HASH ? `TOML: ${UNKNOWN_WHY}` : "TOML: управляемый блок изменён или удалён вручную (--force перезапишет только блок)");
      const current = parseToml(text).mcp_servers ?? {};
      const definitions = recorded?.definitions ?? Object.fromEntries((recorded?.names ?? []).filter((n) => n in parts.servers).map((n) => [n, definitionHash(parts.servers[n])]));
      const conflicts = new Set<string>();
      for (const n of recorded?.names ?? []) {
        if ((!Object.hasOwn(current, n) || definitionHash(current[n]) !== definitions[n]) && !force) {
          conflicts.add(n);
          actions.push({ kind: "conflict", abs: `${path} mcp_servers.${n}`, why: "TOML: таблица изменена или удалена вручную (--force перехватит учтённое имя)" });
        }
      }
      for (const n of Object.keys(data)) if (Object.hasOwn(current, n) && !recorded?.names.includes(n)) {
        conflicts.add(n);
        actions.push({ kind: "conflict", abs: `${path} mcp_servers.${n}`, why: "TOML: имя MCP уже есть вне владения miksy; сначала miksy adopt --global <имя> --to global --agent codex" });
      }
      data = Object.fromEntries(Object.entries(data).filter(([n]) => !conflicts.has(n)));
      // Пропущенный сервер (нет переменных), записанный раньше, остаётся в блоке как был
      // (порядок — как в записанном блоке, иначе блок переписывался бы без изменений по сути)
      const kept = (recorded?.names ?? []).filter((n) => keep.has(n) && !conflicts.has(n) && !(n in data) && Object.hasOwn(current, n));
      if (kept.length) {
        const ordered: Record<string, unknown> = {};
        for (const n of recorded!.names) if (n in data || kept.includes(n)) ordered[n] = n in data ? data[n] : current[n];
        data = { ...ordered, ...data };
      }
      const replace = [...new Set([...(recorded?.names ?? []), ...Object.keys(data)])].filter((n) => !conflicts.has(n));
      // При конфликте одной таблицы другие продолжают синхронизироваться; конфликтная сохраняет старый хеш.
      const content = replace.length ? replaceOwnedMcp(text, replace, data, !!recorded?.definitions) : text;
      const names = [...new Set([...Object.keys(data), ...(recorded?.names ?? []).filter((n) => conflicts.has(n))])];
      const nextDefinitions = Object.fromEntries(names.map((n) => [n, conflicts.has(n) ? definitions[n] : definitionHash(data[n])]));
      if (content !== text || (names.length > 0 && (!recorded?.definitions || !same(recorded.definitions, nextDefinitions))) || (recorded && !names.length))
        actions.push({ kind: "toml", abs: path, content, beforeHash: sha(text), names, definitions: nextDefinitions, written: Object.keys(data), roots });
      else if (!conflicts.size) {
        const mode = modeFix(path);
        if (mode !== null) actions.push({ kind: "chmod", abs: path, mode, roots });
      }
    } catch (e) {
      actions.push({ kind: "conflict", abs: path, why: (e as Error).message });
    }
  }

  // Один путь и удаляется (наш файл из учёта), и сливается (чужой файл) — признак ошибки владения:
  // apply удалил бы файл и создал заново из одних наших ключей. Не трогаем ни то, ни другое
  const mergePaths = new Set([...[...merges.values()].map((m) => m.abs), ...toml.keys()]);
  const clash = new Set(actions.filter((a) => a.kind === "delete" && mergePaths.has(a.abs)).map((a) => a.abs));
  for (let i = actions.length - 1; i >= 0; i--) {
    const a = actions[i];
    if (clash.has(a.abs) && (a.kind === "delete" || a.kind === "merge" || a.kind === "toml")) actions.splice(i, 1);
  }
  for (const path of clash)
    actions.push({ kind: "conflict", abs: path, why: "в одном плане файл и удаляется, и сливается (смена владения?) — не трогаю; проверьте файл и учёт" });

  // Скрипт local/run, который больше не нужен (переименование 2г-2, смена способа доставки), удаляется,
  // только когда все его потребители переключены: конфиг агента с конфликтом (правлен вручную, чужая
  // таблица TOML) остаётся прежним и ссылается на старый скрипт — тот сохраняется вместе с учётом (Г6)
  const runRoot = join(localRoot, "run");
  const stale = actions.filter((a) => a.kind === "delete" && inside(a.abs, runRoot));
  if (stale.length) {
    const consumers = [...new Set(actions.filter((a) => a.kind === "conflict").map((a) => conflictFile(a.abs)).filter((p): p is string => !!p && !inside(p, localRoot)))]
      .map((p) => fold(readFileSync(p, "utf8").replace(/\\\\/g, "/").replace(/\\/g, "/")));
    for (const a of stale) {
      const rel = fold(relative(localRoot, a.abs).replaceAll("\\", "/"));
      if (consumers.some((text) => text.includes(rel))) actions.splice(actions.indexOf(a), 1);
    }
  }

  // Доверие и одобрение серверов .mcp.json — до exclude: файл одобрений (.claude/settings.local.json)
  // скрыт от git, пока в нём одобрения miksy
  const trust = trustPlan(result, target, machine, prev, actions, owner, gitRefusal, current, mark);
  actions.push(...trust.actions);

  // .git/info/exclude: у каждого агента свой блок; сверяемся с файлом, а не с учётом —
  // блок мог быть стёрт (в т.ч. старым общим блоком другого агента).
  // Строка нужна, пока файл miksy лежит в проекте: нужные сейчас файлы и записанные раньше,
  // которые не удаляются (конфликт). Удаляемые остаются в блоке до конца apply
  // clean проекта, о котором учёт ничего не помнит (учёт забыт — clean --forget, диск вернулся; или проект в общей
  // облачной папке, записанный другой машиной): из блока exclude уходят только строки файлов, которые этот clean
  // убирает по уликам (только с отметкой «проект забыт»: шапка или блок и точная строка); остальные строки не трогаем —
  // за ними файлы miksy, которые без вывода miksy не узнать (miksyMade); снять строки — открыть их git. Вернуть под
  // учёт — sync, затем clean
  const forgotten = !!result.clean && !Object.keys(prev.files).length && !Object.keys(prev.blocks ?? {}).length
    && !Object.keys(prev.exclude ?? {}).length && !Object.values(prev.approvals ?? {}).some((ns) => ns.length);
  if (target.scope === "project" && !projectGitError && forgotten && ex && goneLines.size && !escapes(ex.path, ex.root)) {
    const lines = current.filter((l) => !goneLines.has(l));
    const pre = [...new Set([...lines, ...[...goneLines].filter(([, k]) => k === "delete").map(([l]) => l)])].sort();
    // Оставшиеся строки — не в учёт: цель по-прежнему «без учёта», и повторный clean их тоже не снимет
    actions.push({ kind: "exclude", abs: ex.path, roots: [ex.root], lines, ...(!same(pre, lines) && { pre }), owner: blockOwner, unrecorded: true });
  }
  if (target.scope === "project" && !projectGitError && !forgotten) {
    if (exError) actions.push({ kind: "conflict", abs: `${target.dir}/.git`, why: `сбой git: ${exError} — exclude не меняю` });
    if (ex) {
      const refusal = escapes(ex.path, ex.root);
      if (refusal) {
        actions.push({ kind: "conflict", abs: ex.path, why: `${refusal} — exclude не меняю` });
        // Без защиты exclude новые проектные файлы не должны появиться.
        return finishTrust(actions.filter((a) => a.kind === "conflict" || !inside(a.abs, target.dir)));
      }
      const rel = (p: string) => relative(target.dir, p).replaceAll("\\", "/");
      const inProject = (p: string) => inside(p, target.dir);
      const conflicts = actions.filter((a) => a.kind === "conflict");
      const conflicted = new Set(conflicts.map((a) => pathKey(a.abs)));
      const kept = [...Object.keys(prev.files), ...Object.keys(prev.blocks ?? {})]
        .filter((p) => conflicted.has(p) && inProject(p) && existsSync(p)).map(rel);
      const deleting = actions.filter((a) => a.kind === "delete" && inProject(a.abs)).map((a) => rel(a.abs));
      const taking = new Set(actions.filter((a) => a.kind === "write" || a.kind === "adopt" || (a.kind === "block" && a.hash)).map((a) => pathKey(a.abs)));
      // Строка — по логическому пути и по физическому: через свою ссылку каталога (.codex → physical)
      // файл лежит в physical/, и строка логического пути git его не скрывает (С7)
      const ownedPaths = projectPaths.filter((p) => !tracked.has(p)).flatMap((p) => {
        const key = pathKey(join(target.dir, p));
        if (!(key in prev.files || key in (prev.blocks ?? {}) || taking.has(key))) return [];
        return inProject(key) && rel(key) !== p ? [p, rel(key)] : [p];
      });
      // Файлы miksy вне учёта, которые этот план пишет, но не берёт (конфликт: отличаются от нынешнего вывода), —
      // только по уликам miksy (miksyMade) и только под строкой, которая уже есть в блоке: строку не снимаем —
      // иначе git увидит сгенерированный файл, и его можно закоммитить в репо проекта. Новых строк для них не
      // добавляем, и строку каталога, в котором чужой конфликтный файл, в точную строку такого файла не сужаем
      // (С8; рецензия 6w): точная строка — улика «файл miksy» (выше: ненужный файл с меткой убирается), а её miksy
      // пишет только для файла из учёта или взятого этим планом. Файл, которого нет в выводе: в забытом проекте с
      // меткой под точной строкой его план убирает (выше); sync проекта без отметки «забыт» его точную строку
      // оставляет (файл miksy другой машины в общей облачной папке: снять строку — открыть его git; круг 6x);
      // остальные (с меткой под строкой каталога, без метки) и при clean git увидит, когда строка не нужна файлам
      // miksy (docs/uninstall.md: убрать вручную)
      const rendered = new Map(result.files.filter((f) => f.base === "project" && f.mode === "own").map((f) => [f.path, f]));
      // Отслеживается git — не скрываем (сбой git — считаем отслеживаемым: не прятать то, о чём ничего не известно)
      const untracked = (r: string) => {
        if (tracked.has(r)) return false;
        if (projectPaths.includes(r)) return true;
        try { return trackedPaths(target.dir, [r]).length === 0; } catch { return false; }
      };
      const made = (r: string) => {
        const abs = join(target.dir, r);
        const f = rendered.get(r);
        // Блок как улика — у файла с блоком в выводе и у файла под точной строкой блока (CLAUDE.local.md, который
        // miksy сейчас не пишет: например, в проекте появился вложенный репо)
        return existsSync(abs) && statSync(abs).isFile() && untracked(r)
          && miksyMade(abs, { rendered: f?.content, covered: coveredRel(r), block: !!f?.block || current.includes(`/${r}`) });
      };
      // Файлы, из которых этот план убирает своё: удаление, снятие блока, возврат оригинала
      const removing = new Set(actions.filter((a) => inProject(a.abs) && (a.kind === "delete" || a.kind === "restore" || (a.kind === "block" && !a.hash))).map((a) => rel(a.abs)));
      const marked = [...new Set(current.flatMap((l) => {
        const r = l.replace(/^\//, "").replace(/\/$/, "");
        if (!r) return [];
        return l.endsWith("/") ? filesUnder(join(target.dir, r), r) : [r];
      }))].filter((r) => !removing.has(r) && !goneLines.has(`/${r}`)
        && (wanted.has(pathKey(join(target.dir, r))) || (!result.clean && current.includes(`/${r}`))) && made(r));
      // Чужие файлы, на которые выдан конфликт, строкой каталога не скрываем (С8): не из учёта и не miksy
      const open = conflicts.filter((a) => inProject(a.abs) && existsSync(a.abs) && statSync(a.abs).isFile() && !(pathKey(a.abs) in prev.files) && !marked.includes(rel(a.abs)))
        .flatMap((a) => [rel(a.abs), rel(pathKey(a.abs))]);
      // Файл одобрений серверов .mcp.json, пока в нём есть одобренные miksy (после этого плана)
      const approvals = new Set(Object.entries(prev.approvals ?? {}).filter(([, ns]) => ns.length).map(([p]) => p));
      for (const a of actions) if (a.kind === "approve") { if (a.own.length) approvals.add(pathKey(a.abs)); else approvals.delete(pathKey(a.abs)); }
      const approvalPaths = [...approvals].filter((p) => inProject(p) && !tracked.has(rel(p))).map(rel);
      // Строка файла miksy вне учёта — та, что уже есть в блоке; строка каталога, в котором чужой конфликтный
      // файл, сужается до строки самого файла
      const markedLines = marked.flatMap((r) => current.filter((c) => coveredBy([c], r))
        .filter((c) => !c.endsWith("/") || !open.some((o) => fold(`/${o}`).startsWith(fold(c)))));
      const lines = [...new Set([...excludeLines([...ownedPaths, ...kept, ...approvalPaths], open), ...markedLines])].sort();
      const pre = [...new Set([...lines, ...excludeLines(deleting).filter((l) => current.includes(l)), ...[...goneLines].filter(([, k]) => k === "delete").map(([l]) => l)])].sort();
      // Блок под прежним именем агента (miksy:gemini): его строки — текущие, запись заменит его новым
      if (!same(current, lines) || !same(pre, lines) || legacyBlock)
        actions.push({ kind: "exclude", abs: ex.path, roots: [ex.root], lines, ...(!same(pre, lines) && { pre }), owner: blockOwner });
    }
  }
  return finishTrust(actions);

  // Итог плана доверия — в предупреждения и решение, ждущее пользователя
  function finishTrust(list: Action[]): Action[] {
    for (const msg of trust.missing.filter((m) => !m.endsWith("будет добавлено при sync"))) {
      const warning = `${owner}: нет доверия — ${msg}`;
      if (!result.warnings.includes(warning)) result.warnings.push(warning);
    }
    for (const msg of trust.advice) {
      if (!result.warnings.includes(msg)) result.warnings.push(msg);
      if (!result.advice?.includes(msg)) (result.advice ??= []).push(msg);
    }
    if (trust.pending) result.trustPending = trust.pending;
    else delete result.trustPending;
    if (trust.renew) result.trustRenew = trust.renew;
    else delete result.trustRenew;
    if (trust.own) result.trustOwn = trust.own;
    else delete result.trustOwn;
    return finish(list);
  }
}

// Файл, к которому относится конфликт: путь целиком или путь до « ключ» (слияние, таблица TOML)
function conflictFile(abs: string): string | null {
  const file = (p: string) => existsSync(p) && statSync(p).isFile();
  if (file(abs)) return abs;
  for (let i = abs.lastIndexOf(" "); i > 0; i = abs.lastIndexOf(" ", i - 1)) if (file(abs.slice(0, i))) return abs.slice(0, i);
  return null;
}

// sensitive — на каждом выходе из plan: действие с секретным путём пишет 0600
function markSensitive(actions: Action[], sensitivePaths: Set<string>): Action[] {
  for (const a of actions) if (a.kind !== "conflict" && sensitivePaths.has(pathKey(a.abs))) a.sensitive = true;
  return actions;
}

const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const begin = (owner: string) => `# >>> miksy:${owner} (сгенерировано, не править)`;
const end = (owner: string) => `# <<< miksy:${owner}`;
// Блок агента
const blockRx = (owner: string, flags = "m") =>
  new RegExp(`\\n?^# >>> miksy:${escapeRx(owner)} \\(сгенерировано, не править\\)$[\\s\\S]*?^# <<< miksy:${escapeRx(owner)}$\\n?`, flags);
// Владелец блока под прежним именем агента (gemini → antigravity; «агент@каталог» — общий exclude worktree)
function legacyOwner(owner: string): string | null {
  const at = owner.indexOf("@");
  const id = at < 0 ? owner : owner.slice(0, at);
  const old = Object.keys(AGENT_ALIASES).find((k) => AGENT_ALIASES[k] === id);
  return old ? old + (at < 0 ? "" : owner.slice(at)) : null;
}

// Только решение о доверии (miksy trust, ответ в конце sync): из блока exclude плана берётся одна
// строка — файла одобрений. Остальные строки — как в файле сейчас (прочие изменения рендера — дело
// sync). Добавление — до записи одобрения (pre), снятие — после снятия своих одобрений
export function approvalExclude(planned: Action[], dir: string): Extract<Action, { kind: "exclude" }> | null {
  const ex = planned.find((a): a is Extract<Action, { kind: "exclude" }> => a.kind === "exclude");
  const approves = planned.filter((a): a is ApproveAction => a.kind === "approve");
  if (!ex || !approves.length) return null;
  const line = (a: ApproveAction) => "/" + relative(canonical(dir), a.abs).replaceAll("\\", "/");
  const current = excludeBlock(existsSync(ex.abs) ? readFileSync(ex.abs, "utf8") : "", ex.owner);
  const add = approves.filter((a) => a.own.length).map(line).filter((l) => ex.lines.includes(l));
  const drop = approves.filter((a) => !a.own.length).map(line).filter((l) => !ex.lines.includes(l));
  const lines = [...new Set([...current.filter((l) => !drop.includes(l)), ...add])].sort();
  const pre = [...new Set([...current, ...add])].sort();
  if (same(lines, current) && same(pre, current)) return null;
  const { pre: _, ...rest } = ex;
  return { ...rest, lines, ...(!same(pre, lines) && { pre }) };
}

// Строки блоков miksy в .git/info/exclude проекта: агента owner (и под его прежним именем) или всех агентов
// (owner не задан). Сбой git, нет репо — пусто
export function miksyExcludeLines(dir: string, owner?: string): string[] {
  let ex: ReturnType<typeof excludeFile> = null;
  try { ex = excludeFile(dir); } catch { return []; }
  if (!ex || escapes(ex.path, ex.root) || !existsSync(ex.path)) return [];
  const text = readFileSync(ex.path, "utf8");
  if (!owner) return [...text.matchAll(/^# >>> miksy:\S+ \(сгенерировано, не править\)$([\s\S]*?)^# <<< miksy:/gm)]
    .flatMap((m) => m[1].split(/\r?\n/).filter((l) => l && !l.startsWith("# ")));
  const blockOwner = ex.shared ? `${owner}@${dir}` : owner;
  const legacy = legacyOwner(blockOwner);
  return [...excludeBlock(text, blockOwner), ...(legacy ? excludeBlock(text, legacy) : [])];
}

export function excludeBlock(text: string, owner: string): string[] {
  const m = text.match(blockRx(owner));
  return m ? m[0].split(/\r?\n/).filter((l) => l && !l.startsWith("# ")) : [];
}

export function describe(a: Action): string {
  switch (a.kind) {
    case "write": return `  записать (${a.why})  ${a.abs}`;
    case "adopt": return `  взять под учёт       ${a.abs} (${a.known ? "файл miksy, которого не было в учёте" : "содержимое уже совпадает"})`;
    case "chmod": return `  права ${a.mode.toString(8).padStart(4, "0")}           ${a.abs} (содержимое не меняется)`;
    case "forget-merge": return `  снять с учёта        ${a.abs} ${JSON.stringify(a.key)} (родитель отсутствует)`;
    case "delete": return `  удалить              ${a.abs}${a.known ? " (файл miksy, которого не было в учёте, — больше не нужен)" : ""}`;
    case "restore": return `  восстановить оригинал ${a.abs} ← ${a.source}`;
    case "block": return `  блок инструкций     ${a.abs} (${a.known ? (a.hash ? "взять под учёт — блок miksy, которого не было в учёте" : "убрать только блок — блок miksy, которого не было в учёте, больше не нужен") : a.hash ? "обновить" : "убрать только блок"})`;
    case "trust": return `  доверие ${a.format === "toml" ? "Codex" : "Claude"}     ${a.key[1]} (${a.remove ? "снять своё" : "добавить"})`;
    case "approve": return `  одобрение .mcp.json  ${a.abs}: ${[...a.add.map((n) => `+ ${n}`), ...a.remove.map((n) => `- ${n} (снять своё)`)].join(", ") || (a.known ? `взять под учёт — одобрения miksy, которых не было в учёте (${a.own.join(", ")})` : "учёт")}`;
    case "release": return `  снять с учёта        ${a.abs} (файлом владеет и цель ${a.owner} — не удаляю)`;
    case "merge":
      return [
        `  слить                ${a.abs}  ${JSON.stringify(a.key)}`,
        ...Object.keys(a.set).map((n) => `      + ${n}`),
        ...a.remove.map((n) => `      - ${n}`),
        ...a.adopt.map((n) => `      = ${n} (уже совпадает, берём под учёт)`),
      ].join("\n");
    case "toml": return `  блок TOML            ${a.abs}: ${a.names.join(", ") || "(удалить блок)"}`;
    case "exclude": return `  .git/info/exclude    ${a.abs} [${a.owner}]: ${a.lines.join(", ") || "(очистить блок)"}`;
    case "conflict": return `  КОНФЛИКТ             ${a.abs}: ${a.why}`;
  }
}

// Файл изменился между планом и записью (например, сессия агента переписала ~/.claude.json)
export class StaleError extends Error {}

const fileHash = (p: string) => sha(existsSync(p) ? readFileSync(p, "utf8") : "");

// План и запись; если общий файл изменился после планирования — ещё один план по свежему
// содержимому (новые чужие ключи станут конфликтами), затем отказ. first — уже показанный план
export function applyPlanned(
  makePlan: (prev: TargetState) => Action[],
  prev: TargetState,
  first?: Action[],
  onReplan?: (actions: Action[]) => void,
): { state: TargetState; actions: Action[] } {
  let state = prev;
  let actions = first ?? makePlan(prev);
  for (let attempt = 0; ; attempt++) {
    try {
      return { state: apply(actions, state).state, actions };
    } catch (e) {
      if (!(e instanceof StaleError) || attempt >= 1) throw e;
      state = (e as Error & { partialState?: TargetState }).partialState ?? state;
      actions = makePlan(state);
      onReplan?.(actions);
    }
  }
}

// Выполняет действия (кроме конфликтов) и возвращает новое состояние цели.
// Бэкапы — src/backup.ts: одна метка на запуск, одна копия файла за запуск
// Сообщения apply для пользователя (сохранён оригинал): печатает CLI (onApplyNote); в тестах — тишина
let note: (line: string) => void = () => {};
export const onApplyNote = (f: (line: string) => void) => { note = f; };

export function apply(actions: Action[], prev: TargetState): { state: TargetState; backupDir: string | null } {
  if (actions.some((a) => a.kind !== "conflict")) ensurePrivateLocal();
  const state: TargetState = structuredClone(canonicalState(prev ?? emptyState()));
  try {
    return applyInto(actions, state);
  } catch (e) {
    // Уже выполненное должно попасть в учёт, иначе записанные файлы станут «чужими»
    (e as Error & { partialState?: TargetState }).partialState = state;
    throw e;
  }
}

function applyInto(actions: Action[], state: TargetState): { state: TargetState; backupDir: string | null } {
  // exclude — до файлов: новый файл скрыт от git с момента появления; удаляемые — пока не удалены
  const excludes = actions.filter((a): a is Extract<Action, { kind: "exclude" }> => a.kind === "exclude");
  for (const a of excludes) writeExclude(a, a.pre ?? a.lines, state);
  // Скрипты local/run удаляются последними — после записи всех потребителей (конфигов агента): сбой
  // записи конфига оставляет и прежний скрипт, на который тот ссылается (Г6)
  const run = join(configRoot(), "local", "run");
  const late = actions.filter((a) => a.kind === "delete" && inside(a.abs, run));
  for (const a of actions) {
    if ("roots" in a && a.roots) guard(a.abs, ...a.roots);
    if (["write", "adopt", "delete", "restore", "block"].includes(a.kind) && a.beforeHash !== undefined && fileHash(a.abs) !== a.beforeHash)
      throw new StaleError(`${a.abs}: файл изменился после планирования — повторите sync`);
    if (a.original && !state.originals?.[pathKey(a.abs)]) {
      const { written, ...copy } = originalBackup(a.abs);
      (state.originals ??= {})[pathKey(a.abs)] = { ...copy, ...(a.restoreBlock && { restoreBlock: true }) };
      note(written ? `  Оригинал сохранён: ${copy.path}` : `  Оригинал: ${copy.path} (та же версия сохранена раньше)`);
    }
    if (a.kind === "write") {
      if (a.roots) guard(a.abs, ...a.roots);
      if (a.abs.endsWith("/.codex/config.toml")) parseToml(a.content);
      backup(a.abs);
      writeAtomic(a.abs, a.content, { executable: a.executable, sensitive: a.sensitive });
      if (a.abs.endsWith("/.codex/config.toml")) parseToml(readFileSync(a.abs, "utf8"));
      if (lstatSync(a.abs).isSymbolicLink()) (state.links ??= {})[pathKey(a.abs)] = a.abs;
      state.files[pathKey(a.abs)] = sha(a.content);
      rememberPath(state, a.abs);
    } else if (a.kind === "block") {
      guard(a.abs, ...a.roots);
      backup(a.abs);
      // Пустым считается только пустой текст: пробелы и пустые строки вне блока — чужие, файл остаётся
      if (a.content.length || state.links?.[pathKey(a.abs)] || (existsSync(a.abs) && lstatSync(a.abs).isSymbolicLink())) writeAtomic(a.abs, a.content);
      else if (existsSync(a.abs)) removeFile(a.abs);
      if (existsSync(a.abs) && lstatSync(a.abs).isSymbolicLink()) (state.links ??= {})[pathKey(a.abs)] = a.abs;
      delete state.files[pathKey(a.abs)];
      if (a.hash) (state.blocks ??= {})[pathKey(a.abs)] = a.hash;
      else {
        delete state.blocks?.[pathKey(a.abs)];
        delete state.originals?.[pathKey(a.abs)];
      }
      if (!Object.keys(state.blocks ?? {}).length) delete state.blocks;
      if (!Object.keys(state.originals ?? {}).length) delete state.originals;
      rememberPath(state, a.abs);
    } else if (a.kind === "restore") {
      guard(a.abs, ...a.roots);
      guard(a.source, join(configRoot(), "local/backups/originals"));
      if (fileHash(a.source) !== a.sourceHash) throw new Error(`${a.source}: оригинал повреждён — восстановление отменено`);
      backup(a.abs);
      writeAtomic(a.abs, readFileSync(a.source, "utf8"), { sensitive: a.sensitive });
      delete state.files[pathKey(a.abs)];
      delete state.originals?.[pathKey(a.abs)];
      delete state.blocks?.[pathKey(a.abs)];
      if (!Object.keys(state.blocks ?? {}).length) delete state.blocks;
      if (!Object.keys(state.originals ?? {}).length) delete state.originals;
      pruneState(state);
    } else if (a.kind === "release") {
      delete state.files[pathKey(a.abs)];
      pruneState(state);
    } else if (a.kind === "chmod") {
      if (a.roots) guard(a.abs, ...a.roots);
      if (process.platform !== "win32") chmodSync(a.abs, a.mode);
    } else if (a.kind === "adopt") {
      const mode = process.platform === "win32" ? null : repairMode(statSync(a.abs).mode, { sensitive: a.sensitive, executable: a.executable });
      if (mode !== null) chmodSync(a.abs, mode);
      if (lstatSync(a.abs).isSymbolicLink()) (state.links ??= {})[pathKey(a.abs)] = a.abs;
      state.files[pathKey(a.abs)] = sha(a.content);
      rememberPath(state, a.abs);
    } else if (a.kind === "forget-merge") {
      if (fileHash(a.abs) !== a.beforeHash) throw new StaleError(`${a.abs}: файл изменился перед снятием ключа с учёта`);
      const keys = state.merges[pathKey(a.abs)];
      if (keys) {
        delete keys[JSON.stringify(a.key)];
        if (!Object.keys(keys).length) delete state.merges[pathKey(a.abs)];
      }
    } else if (a.kind === "delete") {
      if (!late.includes(a)) remove(a, state);
    } else if (a.kind === "toml") {
      const text = existsSync(a.abs) ? readFileSync(a.abs, "utf8") : "";
      if (a.roots) guard(a.abs, ...a.roots);
      if (sha(text) !== a.beforeHash) throw new StaleError(`TOML изменился после планирования: ${a.abs}; повторите sync`);
      parseToml(a.content);
      backup(a.abs);
      writeAtomic(a.abs, a.content, { sensitive: a.sensitive });
      parseToml(readFileSync(a.abs, "utf8"));
      state.toml ??= {};
      if (a.names.length) state.toml[pathKey(a.abs)] = { hash: sha(splitToml(a.content).block), names: a.names,
        definitions: a.definitions ?? Object.fromEntries(a.names.map((n) => [n, definitionHash(parseToml(a.content).mcp_servers[n])])) };
      else delete state.toml[pathKey(a.abs)];
      rememberPath(state, a.abs);
      if (!Object.keys(state.toml).length) delete state.toml;
    }
  }

  // Одобрение серверов .mcp.json: только свои имена в enabledMcpjsonServers; остальное в файле — как было
  for (const a of actions) {
    if (a.kind !== "approve") continue;
    guard(a.abs, ...a.roots);
    if (fileHash(a.abs) !== a.beforeHash) throw new StaleError(`${a.abs} изменился после планирования — одобрение не меняю; повторите sync`);
    if (a.add.length || a.remove.length) {
      backup(a.abs);
      const doc = readJson(a.abs);
      const list: string[] = (Array.isArray(doc.enabledMcpjsonServers) ? doc.enabledMcpjsonServers : []).filter((n: string) => !a.remove.includes(n));
      for (const n of a.add) if (!list.includes(n)) list.push(n);
      if (list.length) doc.enabledMcpjsonServers = list;
      else delete doc.enabledMcpjsonServers;
      if (Object.keys(doc).length) writeAtomic(a.abs, JSON.stringify(doc, null, 2) + "\n");
      else if (existsSync(a.abs)) removeFile(a.abs);
    }
    if (a.own.length) (state.approvals ??= {})[pathKey(a.abs)] = a.own;
    else delete state.approvals?.[pathKey(a.abs)];
    if (!Object.keys(state.approvals ?? {}).length) delete state.approvals;
  }

  // Слияния — по файлу: перечитать непосредственно перед записью, применить все ключи, записать атомарно
  const byFile = new Map<string, (Extract<Action, { kind: "merge" }> | TrustAction)[]>();
  for (const a of actions) if (a.kind === "merge" || a.kind === "trust") byFile.set(a.abs, [...(byFile.get(a.abs) ?? []), a]);
  for (const [file, list] of byFile) {
    for (const a of list) if (a.roots) guard(file, ...a.roots);
    // План строился по другому содержимому: решения о конфликтах могли устареть
    if (list.some((a) => a.beforeHash !== undefined && a.beforeHash !== fileHash(file)))
      throw new StaleError(`${file} изменился после планирования (другой процесс?) — не сливаю; повторите sync`);
    backup(file);
    const tomlTrust = list.some((a) => a.kind === "trust" && a.format === "toml");
    let text = existsSync(file) ? readFileSync(file, "utf8") : "";
    const doc = tomlTrust ? parseToml(text) : readJson(file);
    for (const a of list) {
      if (a.kind === "trust") {
        if (tomlTrust) text = editTrustToml(text, a);
        else if (!a.remove) setAt(doc, a.key, a.value);
        // Снять своё: вернуть значение до miksy (Claude false) или убрать поле
        else if (trustValue(doc, a.key) === a.value) {
          if (a.previous !== undefined) setAt(doc, a.key, a.previous);
          else delete get(doc, a.key.slice(0, -1))[a.key.at(-1)!];
        }
        continue;
      }
      const obj: Record<string, unknown> = { ...(get(doc, a.key) ?? {}) };
      Object.assign(obj, a.set);
      for (const n of a.remove) delete obj[n];
      setAt(doc, a.key, obj);
    }
    // Объекты, опустевшие после снятия своего (ключ проекта, созданный sync, — projects[<путь>]),
    // уходят вместе с ним; верхний уровень (projects, mcpServers в корне) остаётся
    if (!tomlTrust) for (const a of list) {
      const removed = a.kind === "merge" ? a.remove.length > 0 && !Object.keys(a.set).length : !!a.remove;
      if (!removed) continue;
      const path = a.kind === "merge" ? a.key : a.key.slice(0, -1);
      for (let i = path.length; i >= 2; i--) {
        const v = get(doc, path.slice(0, i));
        if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length) break;
        delete get(doc, path.slice(0, i - 1))[path[i - 1]];
      }
    }
    if (tomlTrust) parseToml(text);
    writeAtomic(file, tomlTrust ? text : JSON.stringify(doc, null, 2), { sensitive: true });
    // Учёт доверия меняется только после подтверждённого изменения файла
    const written = list.some((a) => a.kind === "trust") ? readTrust(file, tomlTrust ? "toml" : "json").doc : null;
    for (const a of list)
      if (a.kind === "trust" && (a.remove ? trustValue(written, a.key) === a.value : trustValue(written, a.key) !== a.value))
        throw new Error(`${file}: доверие ${a.key[1]} не ${a.remove ? "снято" : "записано"} — учёт доверия не меняю`);
    for (const a of list) {
      if (a.kind === "trust") {
        const id = trustId(file, a.key);
        if (a.remove) delete state.trust?.[id];
        else (state.trust ??= {})[id] = { format: a.format, key: a.key, value: a.value, ...(a.previous !== undefined && { previous: a.previous }) };
        if (!Object.keys(state.trust ?? {}).length) delete state.trust;
        continue;
      }
      const k = JSON.stringify(a.key);
      state.merges[pathKey(file)] ??= {};
      if (a.own.length) state.merges[pathKey(file)][k] = a.own;
      else delete state.merges[pathKey(file)][k];
      rememberPath(state, file);
    }
    if (!Object.keys(state.merges[pathKey(file)] ?? {}).length) delete state.merges[pathKey(file)];
  }

  for (const a of late) if (a.kind === "delete") remove(a, state);

  // Всё удалено — блок сужается до итоговых строк
  for (const a of excludes) if (a.pre) writeExclude(a, a.lines, state);

  for (const f of Object.keys(state.files)) if (!existsSync(f)) delete state.files[f];
  // exclude репо, которого больше нет (каталог цели удалён): строки скрывать негде
  for (const f of Object.keys(state.exclude)) if (!existsSync(f)) delete state.exclude[f];
  pruneState(state);
  return { state, backupDir: runDir() };
}

function remove(a: Extract<Action, { kind: "delete" }>, state: TargetState) {
  if (a.roots) guard(a.abs, ...a.roots);
  if (lstatSync(a.abs).isSymbolicLink()) throw new Error(`${a.abs}: стал симлинком после планирования — не удаляю`);
  backup(a.abs);
  removeFile(a.abs);
  pruneSkillDirs(a.abs);
  delete state.files[pathKey(a.abs)];
  pruneState(state);
}

// Опустевшие каталоги удалённого skill (<…>/skills/<имя>/…) — вверх до каталога skills, не включая его:
// иначе после переименования или удаления skill у агентов остаются пустые каталоги со старым именем.
// Не удалось (каталог открыт) — не страшно, агенты пустой каталог без SKILL.md не читают
function pruneSkillDirs(file: string) {
  const parts = slash(file).split("/");
  const at = parts.lastIndexOf("skills");
  if (at < 0 || parts.length - at < 3) return;
  const root = parts.slice(0, at + 1).join("/");
  for (let d = slash(dirname(file)); d.length > root.length; d = slash(dirname(d))) {
    try {
      if (readdirSync(d).length) return;
      rmdirSync(d);
    } catch { return; }
  }
}

function writeExclude(a: Extract<Action, { kind: "exclude" }>, lines: string[], state: TargetState) {
  if (a.roots) guard(a.abs, ...a.roots);
  const text = existsSync(a.abs) ? readFileSync(a.abs, "utf8") : "";
  backup(a.abs);
  const block = lines.length ? `\n${begin(a.owner)}\n${lines.join("\n")}\n${end(a.owner)}\n` : "\n";
  // Блок агента под прежним именем (miksy:gemini) заменяется блоком под новым
  const legacy = legacyOwner(a.owner);
  const without = legacy ? text.replace(blockRx(legacy, "gm"), "\n") : text;
  writeAtomic(a.abs, without.replace(blockRx(a.owner, "gm"), "\n").replace(/\n*$/, "") + block);
  if (a.unrecorded) return;
  if (lines.length) state.exclude[pathKey(a.abs)] = lines;
  else delete state.exclude[pathKey(a.abs)];
}

// Проверка, что наши ключи на месте (открытые сессии агента могут перезаписать файл своей копией)
export function verifyMerges(state: TargetState, written?: Action[]): string[] {
  const lost: string[] = [];
  for (const [file, keys] of Object.entries(state.merges)) {
    const checked = written ? Object.fromEntries(Object.entries(keys).map(([k, names]) => [k, names.filter((n) => written.some((a) =>
      a.kind === "merge" && pathKey(a.abs) === pathKey(file) && JSON.stringify(a.key) === k && (n in a.set || a.adopt.includes(n))))]).filter(([, ns]) => (ns as string[]).length)) : keys;
    if (!Object.keys(checked).length) continue;
    let doc: unknown;
    try {
      doc = readJson(file);
    } catch {
      lost.push(`${file} не разбирается как JSON`);
      continue;
    }
    for (const [k, names] of Object.entries(checked)) {
      const obj = get(doc, JSON.parse(k)) ?? {};
      for (const n of names) if (!(n in obj)) lost.push(`${file} ${k}.${n}`);
    }
  }
  for (const [file, recorded] of Object.entries(state.toml ?? {})) {
    const names = written ? recorded.names.filter((n) => written.some((a) => a.kind === "toml" && pathKey(a.abs) === pathKey(file) && (a.written ?? a.names).includes(n))) : recorded.names;
    if (!names.length) continue;
    try {
      const text = readFileSync(file, "utf8");
      const servers = parseToml(text).mcp_servers ?? {};
      if (!recorded.definitions && sha(splitToml(text).block) !== recorded.hash) lost.push(`${file} управляемый блок изменён`);
      for (const name of names) if (!Object.hasOwn(servers, name) || (recorded.definitions && definitionHash(servers[name]) !== recorded.definitions[name])) lost.push(`${file} mcp_servers.${name}`);
    } catch { lost.push(`${file} управляемый блок отсутствует или повреждён`); }
  }
  for (const [id, rec] of Object.entries(state.trust ?? {})) {
    const [file] = JSON.parse(id);
    if (written && !written.some((a) => a.kind === "trust" && !a.remove && trustId(a.abs, a.key) === id)) continue;
    try { if (trustValue(readTrust(file, rec.format).doc, rec.key) !== rec.value) lost.push(`${file} доверие ${rec.key[1]}`); }
    catch { lost.push(`${file} конфиг доверия не разбирается`); }
  }
  for (const [file, names] of Object.entries(state.approvals ?? {})) {
    if (written && !written.some((a) => a.kind === "approve" && a.add.length && pathKey(a.abs) === file)) continue;
    try {
      const list = readJson(file).enabledMcpjsonServers;
      for (const n of names) if (!Array.isArray(list) || !list.includes(n)) lost.push(`${file} enabledMcpjsonServers.${n}`);
    } catch { lost.push(`${file} не разбирается как JSON`); }
  }
  return lost;
}
