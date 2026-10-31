// Что Gemini / Antigravity видит сейчас из ручных конфигов — для сравнения с тем, что сгенерирует miksy.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CurrentState } from "../../src/adapter";

// JSONC-толерантное чтение (комментарии, концевые запятые) — без npm-зависимостей.
export function readJsonc(path: string): Record<string, any> {
  if (!existsSync(path)) return {};
  const src = readFileSync(path, "utf8");
  if (!src.trim()) return {};
  let out = "";
  let str = "";
  let block = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (block) {
      if (c === "*" && n === "/") {
        block = false;
        i++;
      }
      continue;
    }
    if (str) {
      if (c === "\\") {
        out += c + (n ?? "");
        i++;
        continue;
      }
      if (c === str) str = "";
      out += c;
      continue;
    }
    if (c === '"' || c === "'") {
      str = c;
      out += c;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      block = true;
      i++;
      continue;
    }
    out += c;
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1")) ?? {};
  } catch {
    return {};
  }
}

// Строгий JSON без комментариев — только такой файл miksy готов сливать (иначе потеряет JSONC-форматирование).
// Пустой файл (0 байт — так его заводит Antigravity) — пустой объект, ядро сливает в него как в {}
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
