// Улики самого miksy, по которым он узнаёт свой файл без учёта (учёт забыт — clean --forget, а диск вернулся).
// Ядро (apply.ts: miksyMade) и адаптер opencode. Путь и совпадение текста сами по себе — не улика

// Шапка в начале файла: «<!-- Сгенерировано miksy …» (markdown) или «# Сгенерировано miksy …» (TOML). Та же
// фраза где-то в середине текста — не улика: её мог процитировать пользователь
export const headerMark = (text: string) => /^﻿?(?:<!-- |# )Сгенерировано miksy\b/.test(text);

// Корневой opencode.json, который пишет miksy: только $schema, instructions и mcp, и instructions ведут в
// .opencode/miksy.md. Без instructions свой файл от чужого не отличить — не узнаётся. Отслеживаемый git —
// всегда файл команды (проверяет вызывающий)
export function miksyOpencodeJson(text: string): boolean {
  try {
    const doc = JSON.parse(text) as Record<string, unknown>;
    return !!doc && typeof doc === "object" && !Array.isArray(doc) && Object.keys(doc).every((k) => ["$schema", "instructions", "mcp"].includes(k))
      && Array.isArray(doc.instructions) && doc.instructions.includes(".opencode/miksy.md");
  } catch { return false; }
}
