// Доверие проектам Codex (src/adapter.ts: TrustSpec; ядро — src/trust.ts). Перенесено из src/trust.ts дословно (круг
// 10x-2): [projects."<путь>"] trust_level = "trusted" в ~/.codex/config.toml; командный .codex/config.toml проекта
import { readFileSync } from "node:fs";
import type { Inspected, TrustSpec } from "../../src/adapter";
import type { Machine } from "../../src/types";
import { canonical, pathKey } from "../../src/paths";
import { parseToml } from "../../src/toml";
import { masked, serverLine, shown, unreadable } from "../../src/trust";

// Командный .codex/config.toml: доверие загружает его целиком — серверы, notify и остальные настройки;
// отпечаток — весь разобранный документ
function codexConfig(file: string, rel: string): Inspected {
  let doc: any;
  try { doc = parseToml(readFileSync(file, "utf8")); }
  catch { return unreadable(file, rel); }
  const out = [`${rel}: конфиг Codex не от miksy — доверие загрузит его целиком`];
  for (const [n, d] of Object.entries<any>(doc.mcp_servers ?? {})) out.push(serverLine(rel, n, d));
  for (const [k, v] of Object.entries<any>(doc)) if (k !== "mcp_servers") out.push(`${rel}: ${shown(k)} = ${shown(masked(v, k))}`);
  return { lines: out, data: doc };
}

// В существующих записях Codex Windows — обычный путь с обратными слэшами
export function codexProjectKey(dir: string, machine: Machine, existing: string[]): string {
  const key = pathKey(dir);
  const match = existing.find((p) => pathKey(p.replace(/^\\\\\?\\/, "")) === key);
  if (match) return match;
  return machine.os === "windows" && /^[A-Za-z]:\//.test(dir)
    ? canonical(dir).replaceAll("/", "\\").toLowerCase() : canonical(dir);
}

export const codexTrust: TrustSpec = {
  file: ".codex/config.toml",
  format: "toml",
  field: "trust_level",
  // untrusted — явный ответ пользователя, его не меняем
  value: "trusted",
  keys: (dir, machine, existing) => [codexProjectKey(dir, machine, existing)],
  settings: [{ rel: ".codex/config.toml", read: codexConfig }],
  projectFile: ".codex/config.toml",
};
