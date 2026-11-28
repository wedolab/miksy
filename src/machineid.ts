// Номер этой машины (круг 10z) — метка блока miksy в .git/info/exclude проекта (src/excludeblocks.ts): у каждой машины в
// общей папке свой блок. Номер = первые 12 hex SHA-256 от "miksy-machine\0" + номер компьютера + "\0" + соль (решение
// владельца):
// - номер компьютера даёт система: Windows — MachineGuid (HKLM\SOFTWARE\Microsoft\Cryptography, reg query), macOS —
//   IOPlatformUUID (ioreg -rd1 -c IOPlatformExpertDevice), Linux — /etc/machine-id, иначе /var/lib/dbus/machine-id.
//   Не отдала — пусто: номер из одной соли;
// - соль — 16 случайных байт (криптостойкий генератор) в local/state/machine-salt, создаётся один раз, при первой записи
//   блока (doctor и --dry-run её не создают). Клоны виртуальных машин из одного образа (одинаковый номер компьютера),
//   сделанные до установки miksy, получают разные соли. Соль в резервной копии local/ не мешает: на другом компьютере
//   другой номер компьютера; на том же после восстановления — прежний номер. Две учётки на одном компьютере
//   различаются солью (у каждой свой local/); переименование пользователя номер не меняет.
// Номер компьютера никуда не пишется (ни в общую папку, ни в журналы, ни в вывод); сам номер на диск не кешируется —
// иначе копия local/ унесла бы его на другой компьютер. Номер компьютера берётся один раз за запуск (DESIGN §8.3,
// «Машины в общей папке»)
import { slash } from "./paths";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configRoot } from "./load";
import { type Manifest, writeAtomic } from "./manifest";
import { machinesIn } from "./excludeblocks";

// Источник номера компьютера: подменяется в тестах (поддельная система). run — вывод программы или null (не запустилась,
// ненулевой код, тайм-аут); read — текст файла или null (нет файла)
export type HardwareSource = { platform: string; run: (cmd: string[]) => string | null; read: (path: string) => string | null };

// Полные пути системных программ (не из PATH: чужая программа с тем же именем в PATH дала бы свой «номер»)
const sys = (exe: string) => join(process.env.SystemRoot ?? "C:\\Windows", "System32", exe);
const realSource = (): HardwareSource => ({
  platform: process.platform,
  run: (cmd) => {
    try {
      const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore", timeout: 20000 });
      return r.exitCode === 0 && !r.signalCode ? r.stdout.toString() : null;
    } catch { return null; }
  },
  read: (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } },
});

// Номер компьютера от системы: строка; "" — источника на этой ОС нет (номер из одной соли); null — сбой (программа не
// запустилась, ненулевой код, тайм-аут, вывод не разобран): номер неизвестен
export function computerId(src: HardwareSource): string | null {
  if (src.platform === "win32") {
    const out = src.run([sys("reg.exe"), "query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"]);
    return out?.match(/MachineGuid\s+REG_SZ\s+(\S+)/i)?.[1]?.toLowerCase() ?? null;
  }
  if (src.platform === "darwin") {
    const out = src.run(["/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice"]);
    return out?.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1]?.toLowerCase() ?? null;
  }
  for (const p of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    const id = (src.read(p) ?? "").trim().toLowerCase();
    if (id) return id;
  }
  return "";
}

export const idFrom = (computer: string, salt: string) =>
  createHash("sha256").update(`miksy-machine\0${computer}\0${salt}`).digest("hex").slice(0, 12);

// Один раз за запуск (undefined — ещё не спрашивали)
let computer: string | null | undefined;
let source: HardwareSource | null = null;
export function setHardwareSource(s: HardwareSource | null) { source = s; computer = undefined; }
const thisComputer = () => (computer === undefined ? (computer = computerId(source ?? realSource())) : computer);

// Сбой получения номера компьютера в этом запуске (null — нет или ещё не спрашивали): блоки exclude в проектах с git
// не пишутся, своё и чужое там не решается (apply.ts), команда пишет одну строку и выходит с кодом 3
export const MACHINE_UNKNOWN = "номер машины не получен (сбой системной команды, которая сообщает номер компьютера)";
export const machineIdProblem = (): string | null => (computer === null ? MACHINE_UNKNOWN : null);

const saltFile = (config: string) => join(config, "local", "state", "machine-salt");
// Соль: строка; null — файла нет; false — файл испорчен (не 32 hex)
function readSalt(config: string): string | null | false {
  try {
    if (!existsSync(saltFile(config))) return null;
    const s = readFileSync(saltFile(config), "utf8").trim();
    return /^[0-9a-f]{32}$/.test(s) ? s : false;
  } catch { return false; }
}
export const saltProblem = (config = configRoot()): string | null =>
  readSalt(config) === false ? `${slash(saltFile(config))} испорчен (ожидалось 32 знака 0-9a-f): номер этой машины не определить. Удалите файл — sync создаст новый номер; блоки exclude с прежним номером станут блоками «другой машины» (miksy doctor подскажет, как вернуть их своими)` : null;

// Номер этой машины. null — соли ещё нет (своих блоков с меткой нет), номер компьютера не получен или соль испорчена
// (machineIdProblem, saltProblem)
export function machineId(config = configRoot()): string | null {
  const salt = readSalt(config);
  if (!salt) return null;
  const c = thisComputer();
  return c === null ? null : idFrom(c, salt);
}
export const machineUnknown = (config = configRoot()) => thisComputer() === null || readSalt(config) === false;

// Номер для записи блока: соли нет — создаётся (испорченную не перезаписываем: отказ). Номер компьютера не получен —
// отказ (план такого не допускает)
export function ensureMachineId(config = configRoot()): string {
  let salt = readSalt(config);
  if (salt === false) throw new Error(saltProblem(config)!);
  const c = thisComputer();
  if (c === null) throw new Error(MACHINE_UNKNOWN);
  if (!salt) {
    salt = randomBytes(16).toString("hex");
    writeAtomic(saltFile(config), salt + "\n", { sensitive: true });
  }
  return idFrom(c, salt);
}

// План проекта с git, отложенный из-за неизвестного номера (apply.ts) — причина для итоговой строки команды (commands.ts,
// doctor.ts); сбрасывается в начале каждой команды
let skipped: string | null = null;
export const noteSkipped = (config = configRoot()) => { skipped ??= machineIdProblem() ?? saltProblem(config) ?? MACHINE_UNKNOWN; };
export const skippedReason = () => skipped;
export const resetSkipped = () => { skipped = null; };
export const restoreSkipped = (s: string | null) => { skipped = s; };

// Файлы exclude проектов учёта, где есть блок с номером id (любого агента)
export function blocksOf(manifest: Manifest, id: string): string[] {
  const files = new Set(Object.values(manifest.targets).flatMap((st) => Object.keys(st.exclude ?? {})));
  return [...files].filter((f) => { try { return machinesIn(readFileSync(f, "utf8")).includes(id); } catch { return false; } }).sort();
}

// Номер, под которым учёт записывает блоки (Manifest.machine): ставится, когда учёт впервые помнит строки exclude, и
// меняется на нынешний, только когда блоков с прежним номером в проектах учёта не осталось (sync --machine-was их
// перемечает; иначе doctor подсказывает). true — учёт изменился
// was — номер из sync --machine-was: блоков с ним в проектах учёта не осталось — он уходит из Manifest.machineOther
export function noteMachine(manifest: Manifest, config = configRoot(), was?: string): boolean {
  let changed = false;
  if (was && manifest.machineOther?.includes(was) && !blocksOf(manifest, was).length) {
    manifest.machineOther = manifest.machineOther.filter((x) => x !== was);
    if (!manifest.machineOther.length) delete manifest.machineOther;
    changed = true;
  }
  const id = machineId(config);
  if (!id || manifest.machine === id) return changed;
  if (manifest.machine ? blocksOf(manifest, manifest.machine).length > 0 : !Object.values(manifest.targets).some((st) => Object.keys(st.exclude ?? {}).length)) return changed;
  manifest.machine = id;
  return true;
}
