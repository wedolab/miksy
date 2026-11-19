// Windows: процесс под администратором (повышенный токен, «Обязательная метка\Высокий уровень» S-1-16-12288 в
// whoami /groups). Под ним запрет доступа к своим папкам не действует (у администратора — обход и владение), и тесты,
// которые проверяют отказ при закрытой папке, проверяли бы не то — такие тесты под администратором пропускаются с
// причиной в названии (круг 10e). Узнаётся один раз на процесс; на macOS и Linux — false (там root — getuid)
import { test } from "bun:test";
import { join } from "node:path";

let cached: boolean | undefined;
export function elevated(): boolean {
  if (cached !== undefined) return cached;
  if (process.platform !== "win32") return (cached = false);
  const r = Bun.spawnSync([join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe"), "/groups", "/fo", "csv", "/nh"], { stdout: "pipe", stderr: "pipe" });
  return (cached = r.exitCode === 0 && /"S-1-16-12288"/.test(r.stdout.toString()));
}

export const ELEVATED_WHY = "под администратором запрет доступа не действует";

// test.skipIf(skip), а под администратором — test.skip с причиной в названии (в отчёте видно, почему пропущен).
// acl = false — обычный test.skipIf(skip) (вариант того же теста, на который запрет не влияет)
export function aclTest(skip: boolean, name: string, fn: () => unknown, timeout?: number, acl = true) {
  if (acl && !skip && elevated()) return test.skip(`${name} — пропуск: ${ELEVATED_WHY}`, fn as () => void);
  return test.skipIf(skip)(name, fn as () => void, timeout);
}
