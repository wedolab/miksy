// Файлы skill для адаптеров: путь внутри skill, содержимое (patch важнее диска), исполняемый ли.
// Бинарный файл без patch пропускается с warning — контракт передаёт только текст (DESIGN §8).
// Готовые файлы (item.files — импорт из git) берутся как есть, каталог не читается.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Skill } from "./types";

export interface SkillFile {
  rel: string;
  content: string;
  executable: boolean; // у источника есть +x (скрипт) — на Windows битов нет, всегда false
}

export function skillFiles(item: Skill, warnings: string[]): SkillFile[] {
  const out: SkillFile[] = [];
  const source = item.files ?? readdirSync(item.dir, { recursive: true, encoding: "utf8" }).sort().flatMap((name) => {
    const path = join(item.dir, name);
    const st = statSync(path);
    if (!st.isFile()) return [];
    const raw = readFileSync(path);
    return [{
      rel: name.replaceAll("\\", "/"),
      content: raw.toString("utf8"),
      binary: raw.includes(0),
      executable: process.platform !== "win32" && (st.mode & 0o111) !== 0,
    }];
  });
  for (const f of source) {
    const patch = item.patch?.[f.rel];
    if (patch === undefined && f.binary) {
      warnings.push(`skill ${item.name}: бинарный файл ${f.rel} пропущен (контракт передаёт только текст)`);
      continue;
    }
    // BOM перед шапкой SKILL.md (PowerShell 5.1, Блокнот): Codex такой skill не загружает — «missing YAML
    // frontmatter». В остальных файлах BOM может быть нужен (.ps1 для PowerShell 5.1) — их не трогаем
    const content = patch ?? f.content;
    out.push({ rel: f.rel, content: f.rel === "SKILL.md" ? content.replace(/^﻿/, "") : content, executable: f.executable });
  }
  return out;
}
