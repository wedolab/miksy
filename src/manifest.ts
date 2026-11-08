import { createHash, randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { configRoot } from "./load";
import { inside, pathKey, slash } from "./paths";
import { splitToml } from "./toml";
import type { TrustRecord } from "./trust";
import { busyError } from "./locks";
import { packageVersion } from "./version";
import { agentId } from "./agentid";

// Что miksy записал на этой машине — по каждой цели (агент + глобально/проект)
export interface TargetState {
  files: Record<string, string>; // абсолютный путь → sha256 записанного содержимого
  merges: Record<string, Record<string, string[]>>; // файл → JSON(key) → имена, которыми владеем
  exclude: Record<string, string[]>; // .git/info/exclude → наши строки
  toml?: Record<string, { hash: string; names: string[]; definitions?: Record<string, string> }>; // MCP по именам и семантическим хешам
  blocks?: Record<string, string>; // общий markdown → хеш нашего блока
  originals?: Record<string, { path: string; hash: string; restoreBlock?: boolean }>; // неротируемая первая копия чужого файла
  trust?: Record<string, TrustRecord>; // JSON([файл, ...ключ]) → только добавленное miksy доверие
  links?: Record<string, string>; // канонический own-путь → исходная ссылка (не удалять при clean)
  aliases?: Record<string, string[]>; // прежние логические пути: тоже проверяются на защиту git
  secrets?: string[]; // имена секретов, файлы которых (local/secrets/<ИМЯ>) нужны записанным конфигам цели
  servers?: Record<string, string[]>; // MCP-сервер → секреты его записанной версии (keep сохраняет и их файлы)
  approvals?: Record<string, string[]>; // .claude/settings.local.json → серверы .mcp.json, одобренные miksy
  group?: true; // цель записана как цель-группа: после снятия пометки sync --all убирает её файлы
  // Доверие этой цели ставил miksy (Claude): остаётся, когда miksy снял доверие (команда добавила исполняемые
  // настройки и ждёт решения пользователя и т. п.), — ответы пользователя в окне Claude по-прежнему его (trust.ts:
  // dialogOwn); clean снимает. Записью учёта не считается
  everTrusted?: true;
}

// Отметка «проект забыт» (clean --forget, root remove --forget, «да» на вопрос «забыть?»): учёт этой машины помнит
// только факт и, для Claude, ставил ли miksy доверие проекту — без файлов, хешей и оригиналов. Только в таких
// проектах miksy убирает свои файлы без учёта, которые больше не пишет (apply.ts: «больше не нужен» по уликам):
// в общей облачной папке у каждой машины свой учёт, и файл miksy другой машины выглядит так же. Снимает первый
// sync или clean, дошедший до проекта (не --dry-run)
export type ForgottenMark = { trusted?: true };

export interface Manifest {
  version: 1;
  targets: Record<string, TargetState>;
  // Файлы local/secrets/<ИМЯ>, которые создал miksy: удаляются только они (чужие — никогда); поля нет —
  // учёт до 2г-2
  secretFiles?: string[];
  // Версия движка, который последним записал учёт (package.json): учёт более новой версии — doctor и
  // sync предупреждают «обновите движок». Поля нет — учёт до 0.1.0
  engine?: string;
  // Корни workspace: ключ — путь, как записан в machine.yaml (rootMemoryKey), значение — последний известный
  // настоящий путь. Корень-ссылка недоступен — его цели учёта остаются «недоступными», а не «пропавшими»
  roots?: Record<string, string>;
  // Забытые проекты: цель (агент|каталог, как ключ targets) → отметка (ForgottenMark)
  forgotten?: Record<string, ForgottenMark>;
}

export const manifestPath = () => join(configRoot(), "local", "state", "manifest.json");

export const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export const emptyState = (): TargetState => ({ files: {}, merges: {}, exclude: {} });

// Учёт цели — на записи внутри каталога dir (far) и остальные (near: ключи в домашних конфигах, доверие,
// обёртки в local/run). Без обращения к диску. clean каталога, до которого не дотянуться, убирает near, а
// far оставляет — по нему miksy узнает свои файлы, когда диск вернётся — или забывает (--forget)
const PARTS = ["files", "merges", "exclude", "toml", "blocks", "originals", "links", "aliases", "approvals"] as const;
export function splitState(st: TargetState, dir: string): { near: TargetState; far: TargetState } {
  const near = emptyState(), far = emptyState();
  const pick = (p: string) => (inside(p, dir) ? far : near);
  for (const part of PARTS)
    for (const [p, v] of Object.entries(st[part] ?? {})) ((pick(p)[part] ??= {}) as Record<string, unknown>)[p] = structuredClone(v);
  for (const [k, v] of Object.entries(st.trust ?? {})) {
    let file = "";
    try { file = String((JSON.parse(k) as unknown[])[0] ?? ""); } catch { /* ключ не разобрать — достижимое */ }
    (pick(file).trust ??= {})[k] = structuredClone(v);
  }
  if (st.secrets) near.secrets = [...st.secrets];
  if (st.servers) near.servers = structuredClone(st.servers);
  if (st.group) near.group = far.group = true;
  if (st.everTrusted) near.everTrusted = true;
  return { near, far };
}
// Сколько путей учёта лежит внутри каталога (файлы, блоки, слияния, exclude, одобрения)
export const strandedPaths = (st: TargetState) =>
  new Set([...Object.keys(st.files), ...Object.keys(st.blocks ?? {}), ...Object.keys(st.merges), ...Object.keys(st.exclude), ...Object.keys(st.toml ?? {}), ...Object.keys(st.approvals ?? {})]);
// Два непересекающихся состояния — в одно
export function joinStates(a: TargetState, b: TargetState): TargetState {
  const out = structuredClone(a);
  for (const part of PARTS) if (b[part] && Object.keys(b[part]!).length) out[part] = { ...(out[part] ?? {}), ...structuredClone(b[part]) } as never;
  if (b.trust && Object.keys(b.trust).length) out.trust = { ...out.trust, ...structuredClone(b.trust) };
  if (b.group) out.group = true;
  if (b.everTrusted) out.everTrusted = true;
  return out;
}

export class ManifestError extends Error {}

const record = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);
const names = (v: unknown): v is string[] => Array.isArray(v) && v.every((n) => typeof n === "string");
function validState(state: unknown): state is TargetState {
  if (!record(state) || ![state.files, state.merges, state.exclude].every(record)) return false;
  if (!Object.values(state.files).every((v) => typeof v === "string")) return false;
  if (!Object.values(state.exclude).every(names)) return false;
  for (const value of Object.values(state.merges)) {
    if (!record(value)) return false;
    for (const [key, valueNames] of Object.entries(value)) {
      const keyPath = JSON.parse(key);
      if (!names(keyPath) || !keyPath.length || !names(valueNames)) return false;
    }
  }
  if (state.toml !== undefined && (!record(state.toml) || !Object.values(state.toml).every((v) => record(v) && typeof v.hash === "string" && names(v.names)))) return false;
  if (state.links !== undefined && (!record(state.links) || !Object.values(state.links).every((v) => typeof v === "string"))) return false;
  if (state.aliases !== undefined && (!record(state.aliases) || !Object.values(state.aliases).every(names))) return false;
  if (state.secrets !== undefined && !names(state.secrets)) return false;
  if (state.servers !== undefined && (!record(state.servers) || !Object.values(state.servers).every(names))) return false;
  if (state.approvals !== undefined && (!record(state.approvals) || !Object.values(state.approvals).every(names))) return false;
  if (state.group !== undefined && state.group !== true) return false;
  if (state.everTrusted !== undefined && state.everTrusted !== true) return false;
  if (state.blocks !== undefined && (!record(state.blocks) || !Object.values(state.blocks).every((v) => typeof v === "string"))) return false;
  if (state.originals !== undefined && (!record(state.originals) || !Object.values(state.originals).every((v) => record(v) && typeof v.path === "string" && typeof v.hash === "string"))) return false;
  for (const t of Object.values(state.toml ?? {})) if (t.definitions !== undefined && (!record(t.definitions) || !Object.values(t.definitions).every((v) => typeof v === "string"))) return false;
  if (state.trust !== undefined && (!record(state.trust) || !Object.entries(state.trust).every(([id, v]) => names(JSON.parse(id)) && record(v) && ["json", "toml"].includes(v.format) && names(v.key) && [true, "trusted"].includes(v.value) && [undefined, false].includes(v.previous)))) return false;
  return true;
}

export function loadManifest(path = manifestPath()): Manifest {
  let m: Manifest;
  try {
    m = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { version: 1, targets: {} };
    if (m?.version !== 1 || !m.targets || typeof m.targets !== "object" || Array.isArray(m.targets)) throw new Error();
    if (m.secretFiles !== undefined && !names(m.secretFiles)) throw new Error();
    if (m.forgotten !== undefined && (!record(m.forgotten) || !Object.entries(m.forgotten).every(([id, v]) => id.includes("|") && record(v) && [undefined, true].includes(v.trusted)))) throw new Error();
    for (const [id, state] of Object.entries(m.targets)) {
      if (!id.includes("|") || !validState(state)) throw new Error();
    }
  } catch {
    throw new ManifestError(`${path}: учёт повреждён или недоступен. Сохраните копию и восстановите manifest.json (предыдущая версия — manifest.json.bak рядом); doctor продолжит проверку без учёта. Не удаляйте учёт: это потеряет сведения о владении.`);
  }
  return normalizeManifest(m);
}

// Ключи — канонические пути (старые написания и перенесённые каталоги сливаются в одну запись) и
// нынешние имена агентов: записи прежнего имени (gemini|…) переходят к новому (antigravity|…) со всем
// владением — записанное не становится чужим
export function normalizeManifest(m: Manifest, entries: [string, TargetState][] = Object.entries(m.targets)): Manifest {
  const targets: Manifest["targets"] = {};
  for (const [id, state] of entries) {
    const split = id.indexOf("|");
    const dir = id.slice(split + 1);
    const key = `${agentId(id.slice(0, split))}|${dir === "global" ? dir : pathKey(dir)}`;
    // Две записи одной цели (старые написания пути) сливаются тем же отображением, что и пути внутри
    targets[key] = mergeStates(targets[key] ?? emptyState(), state);
  }
  // Учёт до 2г-2 поля не знал: созданными miksy считаются нужные целям учёта. Поле сохраняется и
  // пустым — иначе следующая загрузка снова вывела бы его из секретов целей и захватила бы файлы,
  // которые miksy не создавал (Г8)
  const secretFiles = m.secretFiles ?? [...new Set(Object.values(targets).flatMap((t) => t.secrets ?? []))].sort();
  const roots = record(m.roots) ? Object.fromEntries(Object.entries(m.roots).filter(([, v]) => typeof v === "string")) : undefined;
  // Отметки «проект забыт» — под тем же ключом, что цель учёта
  const forgotten: Record<string, ForgottenMark> = {};
  for (const [id, v] of Object.entries(m.forgotten ?? {})) {
    const split = id.indexOf("|");
    const key = `${agentId(id.slice(0, split))}|${pathKey(id.slice(split + 1))}`;
    forgotten[key] = { ...(forgotten[key]?.trusted || v.trusted ? { trusted: true as const } : {}) };
  }
  return { version: 1, ...(typeof m.engine === "string" && { engine: m.engine }), targets, secretFiles, ...(roots && Object.keys(roots).length && { roots }),
    ...(Object.keys(forgotten).length > 0 && { forgotten }) };
}

// Хеш записи, для которой при миграции нашлись разные значения и ни одно не совпало с диском:
// цель получает обычный конфликт этого файла («изменён вручную»), --force разрешает с бэкапом
export const UNKNOWN_HASH = "unknown";

// Миграция в памяти: dry-run не переписывает ни учёт, ни файлы цели.
export function canonicalState(state: TargetState): TargetState {
  return mergeStates(emptyState(), state);
}

// Добавляет записи from в into (уже канонический). Одно отображение старый→новый (pathKey) для
// всех структур: files, merges, exclude, toml, links и aliases — после переезда родителя
// защита симлинка и логические пути остаются под тем же ключом, что и сам файл
function mergeStates(into: TargetState, from: TargetState): TargetState {
  for (const part of ["files", "merges", "exclude", "toml", "blocks", "originals"] as const) {
    for (const [p, value] of Object.entries(from[part] ?? {})) {
      const key = pathKey(p);
      if (part === "files" && isLink(p)) (into.links ??= {})[key] ??= p;
      if (part !== "exclude") rememberPath(into, p);
      mergeEntry(part, (into[part] ??= {}) as Record<string, unknown>, key, value);
    }
  }
  for (const [p, link] of Object.entries(from.links ?? {})) (into.links ??= {})[pathKey(p)] ??= link;
  for (const [p, list] of Object.entries(from.aliases ?? {})) {
    const key = pathKey(p);
    (into.aliases ??= {})[key] = [...new Set([...(into.aliases[key] ?? []), ...list])];
  }
  if (from.secrets?.length) into.secrets = [...new Set([...(into.secrets ?? []), ...from.secrets])].sort();
  for (const [n, list] of Object.entries(from.servers ?? {})) (into.servers ??= {})[n] = [...new Set([...(into.servers[n] ?? []), ...list])].sort();
  for (const [p, list] of Object.entries(from.approvals ?? {})) (into.approvals ??= {})[pathKey(p)] = [...new Set([...(into.approvals[pathKey(p)] ?? []), ...list])].sort();
  if (from.trust) into.trust = { ...into.trust, ...structuredClone(from.trust) };
  if (from.group) into.group = true;
  if (from.everTrusted) into.everTrusted = true;
  return into;
}

export function rememberPath(state: TargetState, path: string) {
  const key = pathKey(path), logical = slash(resolve(path));
  if (key !== logical) (state.aliases ??= {})[key] = [...new Set([...(state.aliases[key] ?? []), logical])];
}

// Сведения о путях, которыми miksy больше не владеет (файл удалён, ключи сняты)
export function pruneState(state: TargetState) {
  const live = new Set([...Object.keys(state.files), ...Object.keys(state.merges), ...Object.keys(state.toml ?? {}), ...Object.keys(state.blocks ?? {})]);
  for (const k of Object.keys(state.aliases ?? {})) if (!live.has(k)) delete state.aliases![k];
  for (const k of Object.keys(state.links ?? {})) if (!(k in state.files) && !(k in (state.blocks ?? {}))) delete state.links![k];
  if (state.aliases && !Object.keys(state.aliases).length) delete state.aliases;
  if (state.links && !Object.keys(state.links).length) delete state.links;
}

const diskText = (p: string): string | null => {
  try { return readFileSync(p, "utf8"); } catch { return null; }
};

function mergeEntry(part: "files" | "merges" | "exclude" | "toml" | "blocks" | "originals", dest: Record<string, any>, key: string, value: any) {
  if (!(key in dest)) { dest[key] = structuredClone(value); return; }
  if (part === "merges") {
    for (const [k, names] of Object.entries<string[]>(value))
      dest[key][k] = [...new Set([...(dest[key][k] ?? []), ...names])];
  } else if (part === "exclude") dest[key] = [...new Set([...dest[key], ...value])].sort();
  else if (JSON.stringify(dest[key]) !== JSON.stringify(value)) {
    // Разные записи одного файла: та, что совпадает с диском, иначе «хеш неизвестен» —
    // конфликт одной записи, а не отказ всего учёта
    const text = diskText(key);
    if (part === "files") dest[key] = [dest[key], value].find((h) => text !== null && h === sha(text)) ?? UNKNOWN_HASH;
    else if (part === "blocks") dest[key] = UNKNOWN_HASH;
    else if (part === "originals") throw new ManifestError(`учёт: разные оригиналы для ${key} — восстановите manifest.json`);
    else {
      const block = text === null ? null : sha(splitToml(text).block);
      dest[key] = [dest[key], value].find((t) => t.hash === block)
        ?? { hash: UNKNOWN_HASH, names: [...new Set([...dest[key].names, ...value.names])] };
    }
  }
}

// Канонический путь файла → другая цель, которая им владеет (кроме цели id)
export function otherOwners(manifest: Manifest, id: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [other, st] of Object.entries(manifest.targets)) if (other !== id) for (const p of Object.keys(st.files)) out.set(p, other);
  return out;
}

// Перед первой записью учёта за запуск — копия прежнего manifest.json (manifest.json.bak)
const savedOnce = new Set<string>();
export function saveManifest(m: Manifest, path = manifestPath()) {
  mkdirSync(dirname(path), { recursive: true });
  if (!savedOnce.has(path) && existsSync(path)) copyFileSync(path, `${path}.bak`);
  savedOnce.add(path);
  const { version, engine: _, ...rest } = m;
  writeAtomic(path, JSON.stringify({ version, engine: packageVersion(), ...rest }, null, 2) + "\n");
}

// Запись через временный файл и rename: на диске либо старое содержимое, либо новое целиком.
// - симлинк: пишем в его цель, ссылка остаётся ссылкой (dotfiles); битый симлинк — отказ;
// - права существующего файла сохраняются (0600 у ~/.claude.json); executable — добавить +x;
// - временный файл рядом с целью, имя уникально, создаётся эксклюзивно;
// - rename не удался (Windows: файл открыт другим процессом) — повторы, затем отказ.
//   Прямой записи нет: при сбое посередине она оставила бы обрезанный файл.
export function writeAtomic(path: string, content: string, opts: { executable?: boolean; sensitive?: boolean } = {}) {
  const target = linkTarget(path);
  mkdirSync(dirname(target), { recursive: true });
  const local = join(configRoot(), "local");
  if (inside(target, local)) {
    opts = { ...opts, sensitive: true };
    if (process.platform !== "win32") for (let d = dirname(target); inside(d, local); d = dirname(d)) chmodSync(d, 0o700);
  }
  const mode = opts.sensitive ? (opts.executable ? 0o700 : 0o600) : fileMode(existsSync(target) ? statSync(target).mode & 0o7777 : undefined, !!opts.executable);
  const tmp = `${target}.miksy-tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, content, { flag: "wx", mode: 0o600 });
  try {
    // mode при создании урезается umask — выставляем явно
    if (process.platform !== "win32") chmodSync(tmp, mode ?? (0o666 & ~process.umask()));
    renameRetrying(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function linkTarget(path: string): string {
  if (!isLink(path)) return path;
  try {
    return realpathSync(path);
  } catch {
    throw new Error(`${path}: симлинк указывает на несуществующий файл — не пишу`);
  }
}

const isLink = (path: string) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

// Права нового содержимого: существующие сохраняются; исполняемому — +x там, где есть чтение.
// undefined — права по умолчанию для нового файла
export function fileMode(existing: number | undefined, executable: boolean): number | undefined {
  if (existing === undefined) return executable ? 0o755 : undefined;
  return executable ? existing | ((existing & 0o444) >> 2) : existing;
}

// Права, до которых надо исправить существующий файл (null — исправлять нечего).
// Секретный: закрыт от группы и остальных — проверяется (mode & 0o077), а не ровно 0600: на exFAT
// chmod 600 даёт 0700, файл всё равно закрыт. Исполняемый: +x там, где есть чтение (секретному — владельцу)
export function repairMode(mode: number, o: { sensitive?: boolean; executable?: boolean }): number | null {
  const cur = mode & 0o7777;
  let m = cur;
  if (o.sensitive) m = (m & ~0o077) | 0o600;
  if (o.executable && (m & 0o111) === 0) m |= o.sensitive ? 0o100 : (m & 0o444) >> 2;
  if (o.sensitive && (cur & 0o077) === 0 && (!o.executable || (cur & 0o111) !== 0)) return null;
  return m === cur ? null : m;
}

// Удаление файла: «занят» — с названием держателя (Windows: файл открыт без FILE_SHARE_DELETE)
export function removeFile(path: string) {
  try { rmSync(path); }
  catch (e) { throw busyError(path, e, "не удалён"); }
}

function renameRetrying(from: string, to: string) {
  for (const wait of [50, 100, 200, 400, 800, 0]) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      if (!["EPERM", "EBUSY", "EACCES"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
      if (!wait) throw busyError(to, e, "не изменён");
      Bun.sleepSync(wait);
    }
  }
}
