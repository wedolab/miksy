// Права файлов там, где chmod не действует (круг 12g): сетевой диск без прав (Linux CIFS без unix extensions,
// file_mode=0755), FAT с umask 022 (chmod — EPERM). Режим там показан открытым, а исправить его нельзя: без памяти план
// каждого sync предлагал бы «права 0700 …», а doctor — «Небезопасные права».
// - setMode: chmod и проверка, подействовал ли (права не шире заданных, +x на месте). Не подействовал (или EPERM,
//   ENOTSUP, EINVAL) — проба диска (свой временный файл рядом закрыть и проверить; кеш на точку): не закрылся и он —
//   точка монтирования файла (вверх по каталогам, пока то же устройство) запоминается; закрылся — дело в самом файле
//   (чужой владелец), всё как раньше: chmod в плане, проблема в doctor. Ошибки нет в обоих случаях;
// - точки — в учёте (Manifest.noModes): под ними план не предлагает chmod, doctor пишет одну строку «Справочно»;
//   подействовал под записанной точкой (диск перемонтировали с правами) — точка из учёта уходит;
// - local/ (секреты) — не здесь: диск без прав там — отказ записи (src/secretfiles.ts, noPermsText). Точка, внутри
//   которой local/, в учёт не попадает.
// На Windows права файлов проектов miksy не меняет — всё это только macOS и Linux.
import { chmodSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { inside, slash } from "./paths";

// Подмена для тестов (поддельная ФС без прав): chmod, режим и устройство файла
export const modeSys = {
  chmod: (p: string, mode: number) => chmodSync(p, mode),
  mode: (p: string) => statSync(p).mode,
  dev: (p: string) => statSync(p).dev,
};
const realSys = { ...modeSys };
export const resetModeSys = () => Object.assign(modeSys, realSys);

let known = new Set<string>(); // из учёта
let found = new Set<string>(); // найдены в этом запуске
let healed = new Set<string>(); // права снова действуют
export function resetModes() { known = new Set(); found = new Set(); healed = new Set(); probed = new Map(); }
// Учёт прочитан: записанные точки (найденное в этом запуске не теряется)
export function knownNoModes(list: string[] | undefined) { known = new Set(list ?? []); }

// Точка монтирования: самый верхний каталог с тем же устройством (st_dev), что и путь
export function mountPoint(path: string): string {
  let cur = path;
  let dev: number | bigint;
  for (;;) { try { dev = modeSys.dev(cur); break; } catch { const up = dirname(cur); if (up === cur) return slash(cur); cur = up; } }
  for (;;) {
    const up = dirname(cur);
    if (up === cur) return slash(cur);
    let d: number | bigint;
    try { d = modeSys.dev(up); } catch { return slash(cur); }
    if (d !== dev) return slash(cur);
    cur = up;
  }
}

// Точка без прав, внутри которой путь (из учёта или найденная сейчас), иначе null
export function noModeAt(path: string): string | null {
  if (process.platform === "win32") return null;
  for (const p of [...known, ...found]) if (!healed.has(p) && inside(path, p)) return p;
  return null;
}

// Под записанной точкой секретный файл закрыт — права там снова работают (на диске без прав режим всегда открыт):
// точка уходит из учёта при следующей записи учёта
export function modesWork(path: string) {
  const p = noModeAt(path);
  if (p) healed.add(p);
}

// Проба диска: свой временный файл в dir (нельзя — в точке) закрыть chmod 600 и проверить. true — права на диске
// работают. Файл не создать нигде — неизвестно: точку не записываем (не ослабляем защиту по догадке). Кеш — на точку,
// в рамках запуска
let probed = new Map<string, boolean>();
function probeWorks(point: string, dir: string): boolean {
  const hit = probed.get(point);
  if (hit !== undefined) return hit;
  let works = true;
  for (const d of [dir, point]) {
    const p = join(d, `.miksy-perms-probe-${process.pid}-${Math.random().toString(36).slice(2)}`);
    try { writeFileSync(p, "", { flag: "wx", mode: 0o600 }); }
    catch { continue; }
    try { works = tryChmod(p, 0o600) && (modeSys.mode(p) & 0o077) === 0; }
    catch { works = true; }
    finally { rmSync(p, { force: true }); }
    break;
  }
  probed.set(point, works);
  return works;
}

const IGNORED = new Set(["EPERM", "ENOTSUP", "EINVAL", "EOPNOTSUPP", "EROFS"]);
// chmod, который не роняет команду там, где ФС права не поддерживает: false — не вышло
export function tryChmod(path: string, mode: number): boolean {
  if (process.platform === "win32") return true;
  try { modeSys.chmod(path, mode); return true; }
  catch (e) { if (IGNORED.has((e as NodeJS.ErrnoException).code ?? "")) return false; throw e; }
}

// chmod с проверкой. verify — для файлов, где права важны (секретный, исполняемый): права не шире заданных и +x
// владельцу, если задан. true — подействовал (или проверять нечего)
export function setMode(path: string, mode: number, verify = true): boolean {
  if (process.platform === "win32") return true;
  const done = tryChmod(path, mode);
  if (!verify) return done;
  let ok = done;
  if (ok) {
    const actual = modeSys.mode(path) & 0o777;
    ok = (actual & 0o077 & ~mode) === 0 && (!(mode & 0o100) || (actual & 0o100) !== 0);
  }
  if (!ok) {
    // EPERM бывает и у чужого файла на обычном диске (~/.codex/config.toml, ставший root после sudo): точка тогда —
    // «/» или «/home», и запись её молча сняла бы защиту со всего тома. Поэтому сначала проба — свой временный файл
    // рядом (нельзя писать — в точке): закрылся — дело в самом файле, поведение прежнее (действие chmod в плане,
    // проблема в doctor), точку не записываем
    const point = mountPoint(path);
    if (probeWorks(point, dirname(path))) return false;
    found.add(point);
    healed.delete(point);
    return false;
  }
  // Подействовал под записанной точкой — права там снова работают (точка — та, что в учёте: после перемонтирования
  // устройство и граница тома могли смениться)
  modesWork(path);
  return true;
}

// Точки для учёта: записанные (base — из сохраняемого учёта; без тех, где права снова действуют) и найденные; без
// точек, внутри которых local/
export function noModesList(local: string, base: string[] = [...known]): string[] {
  return [...new Set([...base, ...found])].filter((p) => !healed.has(p) && !inside(local, p)).sort();
}
// Найдены в этом запуске впервые (для одной строки в sync)
export const freshNoModes = (local: string) => [...found].filter((p) => !known.has(p) && !inside(local, p)).sort();

export const noModesText = (point: string) =>
  `права файлов на ${point} не меняются (сетевой диск или ФС без прав — например, SMB или FAT): miksy больше не пытается их там менять; файлы настроек агентов там видны всем, у кого есть доступ к диску (значений секретов в них нет — они в local/)`;
