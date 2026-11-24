// Файлы skill для адаптеров: путь внутри skill, содержимое (patch важнее диска), исполняемый ли, секретный ли.
// Бинарный файл без patch пропускается с warning — контракт передаёт только текст (DESIGN §8).
// Готовые файлы (item.files — импорт командных skills из git) берутся как есть, каталог не читается и фильтр
// доставки к ним не применяется: это файлы команды из её репо.
//
// Фильтр доставки skill из слоя (круг 11i, DESIGN §8.4):
// - служебное (.DS_Store, Thumbs.db, desktop.ini, каталог .git) — не доставляется, молча; node_modules и __pycache__
//   доставляются — скрипту skill они могут быть нужны;
// - ссылка на файл внутри слоёв конфигурации (<конфигурация>/layers) — копией содержимого; ссылка наружу (в том числе
//   в local/ — secrets.env с любым именем ссылки уехал бы в каждый проект — и на map.yaml) или битая — не доставляется, warning;
//   ссылка на каталог не обходится (как и раньше); сама папка skill (skills/, слой) — ссылка наружу или битая: skill не
//   доставляется целиком, warning (круг 11l);
// - файл, похожий на секрет по имени (skillFileKind; у ссылки — по имени цели, круг 11l): ссылка на файл секретов вне этого
//   skill — не доставляется, warning; git конфигурации его игнорирует — доставляется секретным
//   (0600 на macOS/Linux); иначе (отслеживается, не игнорируется, конфигурация не git) — не доставляется, warning
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { gitMemo } from "./git";
import { configRoot, gitIgnored } from "./load";
import { canonical, inside, slash } from "./paths";
import { skillFileKind } from "./secrets";
import type { RenderResult } from "./adapter";
import type { Action } from "./apply";
import type { Skill } from "./types";

export interface SkillFile {
  rel: string;
  content: string;
  executable: boolean; // у источника есть +x (скрипт) — на Windows битов нет, всегда false
  sensitive?: boolean; // файл-секрет, который git конфигурации игнорирует: пишется с правами 0600
}

// Только служебное, которое не доставляется; node_modules и __pycache__ (служебные для adopt и проверки слоёв) — нужны
const SKIP_DIR = /^\.git$/i;

// Файлы-секреты skills слоёв, которые git конфигурации игнорирует. Один запуск git на весь sync (gitMemo; без кеша —
// на вызов) и только если такие файлы есть: имена собираются обходом всех skills слоёв
function ignoredSecrets(root: string): Set<string> {
  return gitMemo(`skill-secrets-ignored|${root}`, () => {
    const rels: string[] = [];
    const walk = (dir: string, inSkills: boolean) => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (inSkills ? !SKIP_DIR.test(e.name) : !["instructions", "mcp", "hooks", "policies"].includes(e.name)) walk(p, inSkills || e.name === "skills");
        } else if (inSkills && skillFileKind(e.name, false) === "secret") rels.push(slash(relative(root, p)));
      }
    };
    walk(join(root, "layers"), false);
    return gitIgnored(root, rels);
  });
}

type Source = { rel: string; content: string; binary: boolean; executable: boolean; sensitive?: boolean };

function readSkillDir(item: Skill, warnings: string[]): Source[] {
  const root = configRoot();
  // Граница ссылок — каталог слоёв, не вся конфигурация: в ней local/ с секретами
  let realLayers = join(root, "layers");
  try { realLayers = canonical(realLayers); } catch { /* как есть */ }
  // Сама папка skill слоя (или skills/, или весь слой) может быть ссылкой или junction (круг 11l): её цель должна быть
  // внутри слоёв конфигурации, иначе skill не доставляется целиком — как ссылка на файл наружу. Skill не из слоёв
  // конфигурации (встроенный skill движка) этой проверки не проходит — он не в git конфигурации
  const realSkill = (() => { try { return canonical(item.dir); } catch { return null; } })(); // null — битая
  const fromLayers = inside(slash(item.dir), slash(join(root, "layers")));
  if (fromLayers && (!realSkill || !inside(realSkill, realLayers))) {
    warnings.push(`skill ${item.name}: папка skill — ссылка ${realSkill ? "за пределы слоёв конфигурации" : "битая"}, skill не доставлен`);
    return [];
  }
  // Файл-секрет git конфигурации игнорирует — по каноническому пути (ссылки и папки-ссылки git не разыменовывает)
  const ignored = (real: string) => {
    if (!inside(real, realLayers)) return false; // не в слоях — не в git конфигурации
    const rel = `layers/${slash(relative(realLayers, real))}`;
    return ignoredSecrets(root).has(rel) || gitMemo(`skill-secret-ignored|${root}|${rel}`, () => gitIgnored(root, [rel])).has(rel);
  };
  const out: Source[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = slash(relative(item.dir, path));
      const l = lstatSync(path);
      if (l.isDirectory()) {
        if (!SKIP_DIR.test(name)) walk(path);
        continue;
      }
      // Цель ссылки (канонически); у обычного файла — только для файла-секрета (ниже): обход node_modules без лишних вызовов
      const link = l.isSymbolicLink();
      let real: string | null = null;
      if (link) {
        try { real = canonical(path); } catch { /* битая */ }
        if (!real || !inside(real, realLayers)) {
          warnings.push(`skill ${item.name}: ${rel} — ссылка ${real ? "за пределы слоёв конфигурации" : "битая"}, не доставлена`);
          continue;
        }
      }
      let st;
      try { st = statSync(path); } catch { continue; }
      if (!st.isFile()) continue; // ссылка на каталог не обходится
      // Вид файла — по тому, что доставляется: у ссылки — по её цели (круг 11l), а не по имени ссылки
      const kind = skillFileKind(real ? basename(real) : name, false);
      if (kind === "junk") continue;
      let sensitive = false;
      if (kind === "secret") {
        // Ссылка на файл секретов другого skill (или вне skill) — не доставляется: секрет одного skill (часто — другой
        // организации) не должен уходить с чужим skill
        if (real && (!realSkill || !inside(real, realSkill))) {
          warnings.push(`skill ${item.name}: ${rel} — ссылка на файл секретов вне этого skill, не доставлена`);
          continue;
        }
        if (!ignored(real ?? canonical(path))) {
          warnings.push(`skill ${item.name}: ${rel} похож на секрет и не исключён из git конфигурации — не доставлен; уберите его из слоя или добавьте в .gitignore конфигурации (как передать skill секрет — docs/layers.md#секреты-в-skills)`);
          continue;
        }
        sensitive = true;
      }
      const raw = readFileSync(path);
      out.push({
        rel,
        content: raw.toString("utf8"),
        binary: raw.includes(0),
        executable: process.platform !== "win32" && (st.mode & 0o111) !== 0,
        ...(sensitive && { sensitive: true }),
      });
    }
  };
  walk(item.dir);
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

// Пометки файла skill для адаптера: +x, секретный (0600 и пометка копии секрета), командный
export function skillFileFlags(item: Skill, f: SkillFile): { executable?: true; sensitive?: true; skillSecret?: string; team?: true } {
  return {
    ...(f.executable && { executable: true as const }),
    ...(f.sensitive && { sensitive: true as const, skillSecret: `${item.name}/${f.rel}` }),
    ...(item.team && { team: true as const }),
  };
}

export function skillFiles(item: Skill, warnings: string[]): SkillFile[] {
  const out: SkillFile[] = [];
  const source: Source[] = item.files ? item.files.map((f) => ({ ...f, binary: !!f.binary })) : readSkillDir(item, warnings);
  for (const f of source) {
    const patch = item.patch?.[f.rel];
    if (patch === undefined && f.binary) {
      warnings.push(`skill ${item.name}: бинарный файл ${f.rel} пропущен (контракт передаёт только текст)`);
      continue;
    }
    // BOM перед шапкой SKILL.md (PowerShell 5.1, Блокнот): Codex такой skill не загружает — «missing YAML
    // frontmatter». В остальных файлах BOM может быть нужен (.ps1 для PowerShell 5.1) — их не трогаем
    const content = patch ?? f.content;
    out.push({ rel: f.rel, content: f.rel === "SKILL.md" ? content.replace(/^﻿/, "") : content, executable: f.executable, ...(f.sensitive && { sensitive: true }) });
  }
  return out;
}

// Совет при копиях файлов-секретов skills: как держать секрет в одном месте — docs/layers.md (лестница способов)
export const SKILL_SECRET_COPY_ADVICE = "как держать его в одном месте — docs/layers.md#секреты-в-skills";

// Строки sync о файлах-секретах skills, которые эта цель получает впервые (действие «новый»); при следующих sync файл
// уже записан — строки нет. Путь — без значения
export function skillSecretCopies(result: RenderResult, actions: Action[]): string[] {
  const out: string[] = [];
  for (const f of result.files) {
    if (f.mode !== "own" || !f.skillSecret) continue;
    const a = actions.find((x) => x.kind === "write" && x.why === "новый" && slash(x.abs).endsWith(`/${f.path}`));
    if (a) out.push(`skill ${f.skillSecret.split("/")[0]}: файл секретов ${f.skillSecret.slice(f.skillSecret.indexOf("/") + 1)} скопирован в ${slash(a.abs)} — секрет хранится не только в local/secrets.env; ${SKILL_SECRET_COPY_ADVICE}`);
  }
  return out;
}
