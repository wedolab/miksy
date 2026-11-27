// Что Antigravity видит сейчас из ручных конфигов — для сравнения с тем, что сгенерирует miksy.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CurrentState } from "../../src/adapter";
import { readJsoncText } from "../../src/jsonc";

// JSONC-толерантное чтение (комментарии, концевые запятые, BOM) — общий разбор src/jsonc.ts (круг 11y); не разобрать — {}
export function readJsonc(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  try { return readJsoncText(readFileSync(path, "utf8")); } catch { return {}; }
}

// Строгий JSON без комментариев — только такой файл miksy сливает: Antigravity не читает комментарии, концевые запятые
// и BOM (agy 1.5.9 вживую, круг 11z): файл не читается целиком. Пустой файл (0 байт — так его заводит Antigravity) — пустой объект, ядро сливает в него как в {}
export function strictJson(path: string): boolean {
  if (!existsSync(path)) return false;
  const src = readFileSync(path, "utf8");
  if (!src.trim()) return true;
  try {
    JSON.parse(src);
    return true;
  } catch {
    return false;
  }
}

export function currentGlobal(home: string): CurrentState {
  const instructionFiles: string[] = [];
  for (const rel of [".gemini/GEMINI.md", ".gemini/config/GEMINI.md", ".gemini/config/AGENTS.md"]) {
    const abs = join(home, rel);
    if (existsSync(abs)) instructionFiles.push(abs.replaceAll("\\", "/"));
  }

  const mcp: CurrentState["mcp"] = {};
  // CLI и IDE читают mcp_config.json раздельно:
  // CLI -> ~/.gemini/config/mcp_config.json (также ~/.gemini/antigravity-cli/mcp_config.json)
  // IDE -> ~/.gemini/antigravity-ide/mcp_config.json
  for (const rel of [
    ".gemini/config/mcp_config.json",
    ".gemini/antigravity-ide/mcp_config.json",
    ".gemini/antigravity-cli/mcp_config.json",
  ]) {
    const abs = join(home, rel);
    if (!existsSync(abs)) continue;
    const data = readJsonc(abs);
    if (data.mcpServers && typeof data.mcpServers === "object") {
      for (const [name, def] of Object.entries(data.mcpServers)) {
        if (!mcp[name] && def && typeof def === "object") {
          if ((def as Record<string, unknown>).disabled === true) continue;
          mcp[name] = { source: abs.replaceAll("\\", "/"), def: def as Record<string, unknown> };
        }
      }
    }
  }

  return { instructionFiles, mcp };
}

export function currentProject(dir: string, home: string): CurrentState {
  const instructionFiles: string[] = [];
  for (const rel of [
    "GEMINI.md",
    "AGENTS.md",
    ".agents/plugins/miksy/rules/AGENTS.md",
  ]) {
    const abs = join(dir, rel);
    if (existsSync(abs)) instructionFiles.push(abs.replaceAll("\\", "/"));
  }
  const rulesDir = join(dir, ".agents", "rules");
  if (existsSync(rulesDir) && statSync(rulesDir).isDirectory()) {
    for (const f of readdirSync(rulesDir)) {
      if (f.endsWith(".md")) instructionFiles.push(join(rulesDir, f).replaceAll("\\", "/"));
    }
  }

  const mcp: CurrentState["mcp"] = {};
  const mcpPath = join(dir, ".agents", "plugins", "miksy", "mcp_config.json");
  if (existsSync(mcpPath)) {
    const data = readJsonc(mcpPath);
    if (data.mcpServers && typeof data.mcpServers === "object") {
      for (const [name, def] of Object.entries(data.mcpServers)) {
        if (def && typeof def === "object") {
          mcp[name] = { source: mcpPath.replaceAll("\\", "/"), def: def as Record<string, unknown> };
        }
      }
    }
  }

  return { instructionFiles, mcp };
}
