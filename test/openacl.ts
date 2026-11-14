// Круг 9c (тесты GitHub Windows после 0.2.3): «открытая» цель в тестах — явной чужой записью, а не только наследованием
// от временной папки. Раннер GitHub работает под встроенным Администратором (…-500): его временная папка доступна только
// ему, SYSTEM и «Администраторам», а для него эти записи свои (foreignAces, ADMIN_OWN) — унаследованные права цель не
// открывают. Запись «Пользователей» или Everyone чужая для любой учётной записи
import { readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foreignAces } from "../src/secretfiles";

const win = process.platform === "win32";
const sys = (exe: string) => join(process.env.SystemRoot ?? "C:\\Windows", "System32", exe);
const nat = (p: string) => p.replaceAll("/", "\\");

export const USERS = "*S-1-5-32-545";
export const EVERYONE = "*S-1-1-0";

// Открыть каталог или файл другим: явная запись на чтение (наследование не трогается — унаследованные записи остаются).
// macOS, Linux — 0755 / 0644
export function openToOthers(p: string, who: string = EVERYONE) {
  const dir = statSync(p).isDirectory();
  if (!win) return Bun.spawnSync(["chmod", dir ? "755" : "644", p]);
  const r = Bun.spawnSync([sys("icacls.exe"), nat(p), "/grant", `${who}:${dir ? "(OI)(CI)" : ""}(R)`], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`icacls /grant ${p}: ${r.stdout.toString()}${r.stderr.toString()}`);
  return r;
}

// Подстановка учётной записи …-500 (здесь её нет): чужие для неё явные (не унаследованные) разрешающие записи пути.
// Унаследованные не в счёт: у временной папки раннера это только SYSTEM, «Администраторы» и он сам, а здесь в ней могут
// быть и другие учётные записи — проверка зависела бы от машины. Пусто — у встроенного Администратора цель не была бы
// открытой, и тест на GitHub не получил бы ожидаемого отказа
export function foreignForBuiltinAdmin(p: string): string[] {
  if (!win) return ["(не Windows)"];
  const me = new TextDecoder("latin1").decode(Bun.spawnSync([sys("whoami.exe"), "/user", "/fo", "csv", "/nh"], { stdout: "pipe" }).stdout).trim().match(/,"(S-[0-9-]+)"$/)![1];
  const admin = me.replace(/-[0-9]+$/, "-500");
  const tmp = join(tmpdir(), `miksy-acl500-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
  try {
    Bun.spawnSync([sys("icacls.exe"), nat(p), "/save", tmp], { stdout: "pipe", stderr: "pipe" });
    const sddl = readFileSync(tmp, "utf16le").split(/\r?\n/)[1] ?? "";
    const explicit = [...sddl.matchAll(/\(([A-Z]+);([^;]*);[^)]*\)/g)].filter((a) => !/ID/.test(a[2])).map((a) => a[0]).join("");
    // Ваша запись — запись того, кто запускает тесты; на раннере это и есть …-500: не чужая
    return foreignAces(`D:${explicit}`, admin).filter((t) => t !== me);
  } finally {
    rmSync(tmp, { force: true });
  }
}
