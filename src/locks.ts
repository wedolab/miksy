// Кто держит файл: Windows — Restart Manager (rstrtmgr.dll через Bun FFI, без прав администратора),
// macOS/Linux — lsof, если он есть. Только для текста ошибки: сбой поиска — пустой список, не исключение
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export type Holder = { pid: number; name: string };

// RM_PROCESS_INFO: RM_UNIQUE_PROCESS (PID + FILETIME) = 12, strAppName WCHAR[256] = 512,
// strServiceShortName WCHAR[64] = 128, ApplicationType, AppStatus, TSSessionId, bRestartable = 16
const RM_INFO = 668;
const ERROR_MORE_DATA = 234;

function windowsHolders(path: string): Holder[] {
  const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi");
  const lib = dlopen("rstrtmgr.dll", {
    RmStartSession: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.u32 },
    RmRegisterResources: { args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.u32 },
    RmGetList: { args: [FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
    RmEndSession: { args: [FFIType.u32], returns: FFIType.u32 },
  });
  try {
    const session = new Uint32Array(1);
    const key = new Uint16Array(64); // CCH_RM_SESSION_KEY + 1 с запасом: ключ сессии пишет сама функция
    if (lib.symbols.RmStartSession(session, 0, key) !== 0) return [];
    try {
      const name = Buffer.from(resolve(path).replaceAll("/", "\\") + "\0", "utf16le");
      const names = new BigUint64Array([BigInt(ptr(name))]);
      if (lib.symbols.RmRegisterResources(session[0], 1, names, 0, null, 0, null) !== 0) return [];
      const needed = new Uint32Array(1), count = new Uint32Array(1), reasons = new Uint32Array(1);
      let info = new Uint8Array(RM_INFO);
      // Список может вырасти между вызовами — несколько попыток с новым размером
      for (let attempt = 0; attempt < 3; attempt++) {
        count[0] = info.length / RM_INFO;
        const r = lib.symbols.RmGetList(session[0], needed, count, info, reasons);
        if (r === ERROR_MORE_DATA) {
          info = new Uint8Array(RM_INFO * (needed[0] + 2));
          continue;
        }
        if (r !== 0) return [];
        const view = Buffer.from(info.buffer);
        return Array.from({ length: count[0] }, (_, i) => {
          const at = i * RM_INFO;
          const text = view.toString("utf16le", at + 12, at + 12 + 512);
          return { pid: view.readUInt32LE(at), name: text.slice(0, text.indexOf("\0") >>> 0).trim() };
        });
      }
      return [];
    } finally {
      lib.symbols.RmEndSession(session[0]);
    }
  } finally {
    lib.close();
  }
}

// lsof -F pc: строки «p<PID>» и «c<команда>» на процесс; код 1 — никто не держит
function lsofHolders(path: string): Holder[] {
  const lsof = Bun.which("lsof") ?? ["/usr/sbin/lsof", "/usr/bin/lsof"].find(existsSync);
  if (!lsof) return [];
  const r = Bun.spawnSync([lsof, "-F", "pc", "--", path], { stdout: "pipe", stderr: "ignore", timeout: 5000 });
  const out: Holder[] = [];
  for (const line of r.stdout.toString().split("\n")) {
    if (line.startsWith("p")) out.push({ pid: Number(line.slice(1)), name: "" });
    else if (line.startsWith("c") && out.length) out[out.length - 1].name = line.slice(1);
  }
  return out.filter((h) => h.pid !== process.pid);
}

export function whoLocks(path: string): Holder[] {
  if (!existsSync(path)) return [];
  try {
    return process.platform === "win32" ? windowsHolders(path) : lsofHolders(path);
  } catch {
    return [];
  }
}

// «Zed (PID 1234)»; несколько держателей — через запятую; никого не нашли — null
export function holdersText(path: string): string | null {
  const list = whoLocks(path);
  if (!list.length) return null;
  const names = list.map((h) => `${h.name || "процесс"} (PID ${h.pid})`).join(", ");
  return list.length === 1 ? `его держит ${names} — закройте эту программу` : `его держат ${names} — закройте эти программы`;
}

// Ошибка ФС «занято» (EBUSY/EPERM/EACCES) с названием держателя; иная ошибка — как есть
export function busyError(path: string, e: unknown, what: string): Error {
  const code = (e as NodeJS.ErrnoException)?.code ?? "";
  if (!["EBUSY", "EPERM", "EACCES"].includes(code)) return e as Error;
  const who = holdersText(path);
  return new Error(`${path}: файл занят другим процессом или только для чтения — ${what}; ${who ? `${who} и повторите` : "закройте программу и повторите"}`);
}
