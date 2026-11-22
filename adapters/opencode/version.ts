// Основная версия opencode по установке (сводка окружения: doctor, мастер) — src/adapter.ts programMajor
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { slash } from "../../src/paths";
import { real } from "../../src/environ";

const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };

// Официальный установщик (opencode.ai/install — 1.x, opencode.ai/v2/install — 2.x) кладёт opencode в
// ~/.opencode/bin. Установщик 2.x рядом всегда пишет команду совместимости opencode2 — маленький скрипт,
// который запускает opencode из того же каталога; установщик 1.x её не пишет (а opencode2 — большая
// программа: так раньше ставили 2.x рядом с 1.x). Возвращает основную версию или null — не этот случай
function installerMajor(exe: string): number | null {
  for (const p of [slash(exe), (() => { try { return slash(realpathSync(exe)); } catch { return null; } })()]) {
    if (!p || !/\/\.opencode\/bin\/opencode(\.exe|\.cmd)?$/i.test(p)) continue;
    const dir = dirname(p);
    const shim = ["opencode2", "opencode2.cmd"].map((n) => join(dir, n)).find(isFile);
    let small = "";
    try { if (shim && statSync(shim).size < 4096) small = readFileSync(shim, "utf8"); } catch { /* нет доступа — как без скрипта */ }
    return /opencode(\.exe)?["\s]/.test(small) ? 2 : 1;
  }
  return null;
}

// Основная версия opencode — по пакету, из которого он установлен (npm: opencode-ai — 1.x, @opencode/cli
// — 2.x; Homebrew — по каталогу Cellar; официальный установщик — по команде opencode2 рядом); иначе —
// неизвестна. Сам opencode не запускается: проверка только читает (opencode 2.x при запуске поднимает
// фоновый сервис)
export function opencodeMajor(exe: string): number | null {
  const where = [slash(exe), slash(real(exe))];
  try { if (statSync(exe).size < 65536) where.push(readFileSync(exe, "utf8")); } catch { /* нет доступа — по пути */ }
  const text = where.join("\n").replaceAll("\\", "/");
  if (/node_modules\/opencode-ai\//.test(text)) return 1;
  if (/node_modules\/@opencode\/cli\//.test(text)) return 2;
  const brew = text.match(/Cellar\/opencode\/(\d+)\./);
  return brew ? Number(brew[1]) : installerMajor(exe);
}

