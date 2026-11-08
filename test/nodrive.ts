// Путь на диске, которого нет: Windows — свободная буква диска, POSIX — под несуществующим каталогом
// верхнего уровня (как отключённый сетевой диск или не запущенное облачное хранилище)
import { existsSync } from "node:fs";

export function missingDrive(name = "Projects"): string {
  if (process.platform !== "win32") return `/miksy-no-such-volume-${process.pid}/${name}`;
  for (const l of "QRSTUVWXYZPONMLKJIH") if (!existsSync(`${l}:/`)) return `${l}:/${name}`;
  throw new Error("нет свободной буквы диска для теста");
}
