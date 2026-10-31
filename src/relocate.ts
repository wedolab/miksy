// Перенос каталогов: каталог цели или конфигурации переехал (переименование, другой диск) — учёт
// следует за ним. Новое место узнаётся по уликам, а не по имени:
// - конфигурация — пути local/ учёта под прежним корнем, которого больше нет, а обёртки с теми же
//   хешами лежат в local/ нынешней конфигурации;
// - каталог цели — внутри переехавшего родителя на том же относительном пути, иначе единственная
//   цель workspace без записей учёта, где все файлы, записанные в прежний каталог (own-файлы и блоки
//   инструкций), лежат на тех же относительных путях с теми же хешами.
// Перенос — в памяти (doctor и --dry-run учёт не меняют), sync и clean сохраняют. Записанное вне
// каталога под прежним путём (ключ проекта в ~/.claude.json, доверие) остаётся в учёте как было —
// план цели снимает его как ненужное и пишет под новым путём.
import { existsSync, readFileSync } from "node:fs";
import { blockHash, splitInstructions } from "./instructions";
import { type Manifest, normalizeManifest, sha, type TargetState } from "./manifest";
import { fold } from "./paths";

export type Move = { from: string; to: string; how: "config" | "files" | "parent" };

const under = (p: string, root: string) => {
  const a = fold(p), r = fold(root).replace(/\/+$/, "");
  return a === r || a.startsWith(r + "/");
};

// Путь после переездов: самый длинный подходящий прежний префикс
export function movePath(p: string, moves: Move[]): string {
  let best: Move | undefined;
  for (const m of moves) if (under(p, m.from) && (!best || m.from.length > best.from.length)) best = m;
  return best ? best.to + p.slice(best.from.replace(/\/+$/, "").length) : p;
}

const dirOf = (id: string) => id.slice(id.indexOf("|") + 1);
const text = (p: string): string | null => {
  try { return readFileSync(p, "utf8"); } catch { return null; }
};

type Evidence = { rel: string; hash: string; block: boolean };

// Файлы, записанные в каталог dir (own-файлы и блоки инструкций всех агентов), с хешами
function evidence(states: TargetState[], dir: string, skip: string[]): Evidence[] {
  const out: Evidence[] = [];
  for (const st of states) {
    const add = (p: string, hash: string, block: boolean) => {
      if (!under(p, dir) || fold(p) === fold(dir) || skip.some((s) => under(p, s))) return;
      out.push({ rel: p.slice(dir.replace(/\/+$/, "").length + 1), hash, block });
    };
    for (const [p, h] of Object.entries(st.files)) add(p, h, false);
    for (const [p, h] of Object.entries(st.blocks ?? {})) add(p, h, true);
  }
  return out;
}

function same(dir: string, e: Evidence): boolean {
  const t = text(`${dir}/${e.rel}`);
  if (t === null) return false;
  if (!e.block) return sha(t) === e.hash;
  try { return blockHash(splitInstructions(t, e.hash).block) === e.hash; } catch { return false; }
}

// Переезды по учёту. candidates — каталоги нынешних целей (канонические); вызывается, только если
// какой-то каталог учёта пропал
export function findMoves(m: Manifest, config: string, candidates: () => string[], exists: (p: string) => boolean = existsSync): Move[] {
  const moves: Move[] = [];
  const states = Object.values(m.targets);

  // 1. Конфигурация
  const roots = new Map<string, { rest: string; hash: string }[]>();
  for (const st of states) for (const [p, hash] of Object.entries(st.files)) {
    const hit = p.match(/^(.*)\/local\/(run\/.*)$/);
    if (hit) roots.set(hit[1], [...(roots.get(hit[1]) ?? []), { rest: hit[2], hash }]);
  }
  const lost = [...roots].filter(([r]) => fold(r) !== fold(config) && !exists(r));
  if (lost.length === 1) {
    const [root, files] = lost[0];
    const found = files.filter((f) => text(`${config}/local/${f.rest}`) !== null);
    if (found.length && found.every((f) => sha(text(`${config}/local/${f.rest}`)!) === f.hash)) moves.push({ from: root, to: config, how: "config" });
  }
  const skip = moves.map((mv) => `${mv.from}/local`);

  // 2. Каталоги целей: родители раньше вложенных
  const byDir = new Map<string, TargetState[]>();
  for (const [id, st] of Object.entries(m.targets)) {
    const dir = dirOf(id);
    if (dir !== "global") byDir.set(dir, [...(byDir.get(dir) ?? []), st]);
  }
  let pool: string[] | null = null;
  for (const dir of [...byDir.keys()].sort((a, b) => a.length - b.length)) {
    if (exists(dir)) continue;
    const mapped = movePath(dir, moves);
    if (mapped !== dir) {
      if (exists(mapped)) {
        if (!moves.some((mv) => fold(mv.from) === fold(dir))) moves.push({ from: dir, to: mapped, how: "parent" });
        continue;
      }
    }
    const ev = evidence(byDir.get(dir)!, dir, skip);
    if (!ev.length) continue;
    pool ??= candidates();
    const taken = new Set([...byDir.keys()].map((d) => fold(movePath(d, moves))).filter((d) => exists(d)));
    const hits = pool.filter((c) => !taken.has(fold(c)) && !moves.some((mv) => fold(mv.to) === fold(c)) && ev.every((e) => same(c, e)));
    if (hits.length === 1) moves.push({ from: dir, to: hits[0], how: "files" });
  }
  return moves;
}

// Учёт с перенесёнными путями: ключи файлов, слияний, exclude, TOML, блоков, оригиналов, ссылок,
// одобрений и цели. Ключи внутри конфигов агента (projects[<путь>] в ~/.claude.json, доверие) — как
// были: это записанное под прежним путём, его снимет план цели
export function applyMoves(m: Manifest, moves: Move[]): Manifest {
  if (!moves.length) return m;
  const mp = (p: string) => movePath(p, moves);
  const keys = <T>(o: Record<string, T> | undefined, f: (v: T) => T = (v) => v) =>
    o && Object.fromEntries(Object.entries(o).map(([k, v]) => [mp(k), f(v)]));
  const move = (st: TargetState): TargetState => {
    const out: TargetState = { ...st, files: keys(st.files)!, merges: keys(st.merges)!, exclude: keys(st.exclude)! };
    if (st.toml) out.toml = keys(st.toml);
    if (st.blocks) out.blocks = keys(st.blocks);
    if (st.originals) out.originals = keys(st.originals, (o) => ({ ...o, path: mp(o.path) }));
    if (st.links) out.links = keys(st.links, mp);
    if (st.aliases) out.aliases = keys(st.aliases, (l) => l.map(mp));
    if (st.approvals) out.approvals = keys(st.approvals);
    if (st.trust) out.trust = Object.fromEntries(Object.entries(st.trust).map(([id, r]) => {
      const [file, ...key] = JSON.parse(id);
      return [JSON.stringify([mp(file), ...key]), r];
    }));
    return out;
  };
  // Две записи на одном месте сливает normalizeManifest — как старые написания одного пути
  const entries = Object.entries(m.targets).map(([id, st]): [string, TargetState] => {
    const dir = dirOf(id);
    return [`${id.slice(0, id.indexOf("|") + 1)}${dir === "global" ? dir : mp(dir)}`, move(st)];
  });
  return normalizeManifest(m, entries);
}

export const HOW: Record<Move["how"], string> = {
  config: "конфигурация: обёртки найдены в нынешней local/",
  files: "по записанным файлам на новом месте",
  parent: "вместе с родительским каталогом",
};
