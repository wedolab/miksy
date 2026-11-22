// Свой корневой opencode.json без учёта (учёт забыт — clean --forget, диск вернулся): src/adapter.ts ownFile
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
