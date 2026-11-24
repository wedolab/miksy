// Встроенный слой движка (круг 11j): то, что поставляется вместе с miksy и обновляется с ним, — сейчас только skill
// miksy (как менять конфигурацию через miksy). Раздаётся глобальной цели (домашние каталоги агентов) первым слоем:
// любой глобальный слой пользователя со своим skills/miksy его заменяет, exclude: [skill.miksy] — выключает.
// Прежде skill копировался в конфигурацию из образца (setup) и дальше не обновлялся. Переход: неизменённая копия
// прежнего образца (хеш из PAST или совпадает со встроенным) не действует — действует встроенный; изменённая
// остаётся заменой, doctor говорит, что она отстаёт, sync — когда встроенный сменился с прошлого sync этой машины
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ENGINE, loadLayerDir } from "./load";
import { quoteArg, slash } from "./paths";
import { skillFileKind } from "./secrets";
import type { Layer } from "./types";

export const BUILTIN_DIR = join(ENGINE, "builtin");
export const BUILTIN_LAYER = "miksy (встроенный)";
export const BUILTIN_SKILL = "miksy";

// Хеши выпущенных версий образца skill miksy (examples/config/layers/global/skills/miksy до 0.6.1), skillHash:
// 0.1.0, 0.2.0, 0.2.1, 0.3.0–0.6.0 и предвыпускная (до 0.1.0). Меняете builtin/skills/miksy — допишите сюда прежний
// хеш (CURRENT) и поставьте новый в CURRENT: копии прежней версии у пользователей перестанут действовать сами
export const PAST: readonly string[] = [
  "07050dff385de84e40567104cdbe3223d4155c1703b9154c71149f7c28079289", // 0.1.0
  "8239f09102bc95d9399e993c022cfa56ae811b0258e2faf3c929b5369a00b463", // 0.2.0
  "89c71136222345e20b5862871a32d6026d8d3f9c4a3566fd04e0b399549f69d4", // 0.2.1
  "ea1e4b81a2ecb3b64d77d3a090488f4031a6ebe888d7b8b1fb5c4f84380d0830", // 0.3.0–0.6.0
  "5031adff4011914968bc69830f9af4dc897979d0dc7dc62b1fd0f3b40c50e4d9", // до 0.1.0
  "1e9f4850e8c3a5588da42ee5d0340ff21fffbcb5f457f75414a6aae0a41c881c", // 0.6.1 до miksy secret (c978f9b)
  "9652396a54e71fa19507325df1a721e94389daa400070620861d0ec32608c0f2", // 0.6.1 до честной оговорки об изоляции (69ffd8e)
];
// Хеш нынешнего builtin/skills/miksy — сторож: test/builtin11j.test.ts сверяет его с каталогом
export const CURRENT = "fdfd93b46cbb1292ff58bca2accc7f8f6fba0b2b9ab6ae7e5b37f43c8f495c89";

// Хеш skill для сравнения копий: все файлы (без служебных .DS_Store и т. п.), путь и содержимое; CRLF → LF, без BOM —
// копия, прошедшая через git с autocrlf или Блокнот, та же
export function skillHash(dir: string): string {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (!skillFileKind(e.name, true)) walk(p);
      } else if (e.isFile() && skillFileKind(e.name, false) !== "junk") files.push(p);
    }
  };
  walk(dir);
  const h = createHash("sha256");
  for (const p of files.map((f) => ({ f, rel: slash(relative(dir, f)) })).sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) {
    const text = readFileSync(p.f, "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
    h.update(`${p.rel}\0${text}\0`);
  }
  return h.digest("hex");
}

// Встроенный слой; null — каталога нет (движок собран без него)
export function builtinLayer(): Layer | null {
  return existsSync(BUILTIN_DIR) ? loadLayerDir(BUILTIN_DIR, BUILTIN_LAYER) : null;
}

export type BuiltinCopy = { layer: string; dir: string; stale: boolean };

// skill miksy в глобальных слоях пользователя: stale — неизменённая копия прежнего образца (или совпадает со
// встроенным), она не действует; иначе — своя замена встроенного
export function builtinCopies(layers: Layer[]): BuiltinCopy[] {
  const current = existsSync(join(BUILTIN_DIR, "skills", BUILTIN_SKILL)) ? skillHash(join(BUILTIN_DIR, "skills", BUILTIN_SKILL)) : null;
  return layers.flatMap((l) => l.skills.filter((s) => s.name === BUILTIN_SKILL).map((s) => {
    const h = skillHash(s.dir);
    return { layer: l.name, dir: s.dir, stale: PAST.includes(h) || h === current };
  }));
}

// Слои глобальной цели: встроенный первым, из слоёв пользователя убраны неизменённые копии прежнего образца
export function withBuiltin(layers: Layer[]): { layers: Layer[]; copies: BuiltinCopy[] } {
  const builtin = builtinLayer();
  if (!builtin) return { layers, copies: [] };
  const copies = builtinCopies(layers);
  const stale = new Set(copies.filter((c) => c.stale).map((c) => c.dir));
  const cleaned = layers.map((l) => (l.skills.some((s) => stale.has(s.dir)) ? { ...l, skills: l.skills.filter((s) => !stale.has(s.dir)) } : l));
  return { layers: [builtin, ...cleaned], copies };
}

// Хеш встроенного skill miksy; null — каталога нет
export const builtinHash = (): string | null => {
  const dir = join(BUILTIN_DIR, "skills", BUILTIN_SKILL);
  return existsSync(dir) ? skillHash(dir) : null;
};

// Строки doctor («Справочно») о копиях skill miksy в глобальных слоях пользователя; root — конфигурация
export function builtinCopyText(c: BuiltinCopy, root: string): string {
  const rel = slash(relative(root, c.dir));
  if (c.stale)
    return `${rel} — неизменённая копия прежнего образца skill ${BUILTIN_SKILL}: не действует, агенты получают встроенный (он обновляется вместе с miksy). Удалить копию: git -C ${quoteArg(slash(root))} rm -r ${rel}`;
  return `${rel} заменяет встроенный skill ${BUILTIN_SKILL} и может отставать от него (встроенный обновляется вместе с miksy). ` +
    `Сравнить: git diff --no-index ${quoteArg(slash(join(BUILTIN_DIR, "skills", BUILTIN_SKILL)))} ${quoteArg(slash(c.dir))}. Вернуть встроенный — удалите копию; оставить свой — ничего не делайте`;
}
