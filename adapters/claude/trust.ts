// Доверие проектам Claude (src/adapter.ts: TrustSpec; ядро — src/trust.ts). Перенесено из src/trust.ts дословно (круг
// 10x-2): что доверие Claude выполнит без вопроса, ответы пользователя в окне Claude, одобрение серверов .mcp.json
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Inspected, RenderResult, TrustSpec } from "../../src/adapter";
import { sha } from "../../src/manifest";
import { fingerprint, masked, readJsonFile, serverLine, shown, teamFiles, unreadable } from "../../src/trust";
import { projectKeys } from "./current";

// .claude/settings*.json: только то, что Claude выполняет или применяет без вопроса в доверенном
// проекте (ключи EXEC — целиком в отпечатке). skip — ключи, которые не считаются (свои, см. ownSkip)
const EXEC = ["hooks", "permissions", "env", "apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "otelHeadersHelper", "statusLine", "fileSuggestion", "enableAllProjectMcpServers", "enabledMcpjsonServers"];
function claudeSettings(file: string, rel: string, skip: (doc: any) => any = (d) => d): Inspected {
  const { doc: raw, bad } = readJsonFile(file);
  if (bad || !raw || typeof raw !== "object" || Array.isArray(raw)) return unreadable(file, rel);
  const doc = skip(structuredClone(raw));
  const out: string[] = [];
  if (doc.hooks && typeof doc.hooks === "object") {
    for (const [event, groups] of Object.entries<any>(doc.hooks))
      for (const g of Array.isArray(groups) ? groups : [groups])
        for (const h of Array.isArray(g?.hooks) ? g.hooks : [g]) {
          const { type, command: cmd, ...rest } = h && typeof h === "object" ? h : { type: undefined, command: undefined };
          const what = typeof cmd === "string" ? cmd : `${shown(type ?? "?")}${Object.keys(rest).length ? " " + shown(rest) : ""}`;
          out.push(`${rel}: хук ${shown(event)}${g?.matcher ? ` [${shown(g.matcher)}]` : ""}: ${shown(what)}`);
        }
  }
  const p = doc.permissions && typeof doc.permissions === "object" ? doc.permissions : {};
  if (Array.isArray(p.allow) && p.allow.length) out.push(`${rel}: разрешено без вопроса: ${shown(p.allow)}`);
  if (p.defaultMode && p.defaultMode !== "default") out.push(`${rel}: режим разрешений ${shown(p.defaultMode)}`);
  if (Array.isArray(p.additionalDirectories) && p.additionalDirectories.length) out.push(`${rel}: дополнительные каталоги: ${shown(p.additionalDirectories)}`);
  if (doc.env && typeof doc.env === "object" && Object.keys(doc.env).length) out.push(`${rel}: переменные окружения: ${shown(masked(doc.env))}`);
  for (const k of ["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "otelHeadersHelper"]) if (doc[k]) out.push(`${rel}: ${k}: ${shown(doc[k])}`);
  for (const k of ["statusLine", "fileSuggestion"]) if (doc[k]?.command) out.push(`${rel}: ${k}: ${shown(doc[k].command)}`);
  if (doc.enableAllProjectMcpServers === true) out.push(`${rel}: включает все серверы .mcp.json без вопроса`);
  if (Array.isArray(doc.enabledMcpjsonServers) && doc.enabledMcpjsonServers.length) out.push(`${rel}: включает серверы .mcp.json: ${shown(doc.enabledMcpjsonServers)}`);
  return out.length ? { lines: out, data: Object.fromEntries(EXEC.filter((k) => k in doc).map((k) => [k, doc[k]])) } : null;
}

function mcpJson(file: string, rel: string): Inspected {
  const { doc, bad } = readJsonFile(file);
  if (bad || !doc || typeof doc !== "object") return unreadable(file, rel);
  const servers = doc.mcpServers && typeof doc.mcpServers === "object" ? doc.mcpServers : {};
  const lines = Object.entries<any>(servers).map(([n, d]) => serverLine(rel, n, d));
  return lines.length ? { lines, data: servers } : null;
}

// Ключи settings.local.json, которые Claude пишет сам по ответу пользователя в своих диалогах
// («всегда разрешать», /add-dir, одобрение серверов .mcp.json)
const DIALOG = (doc: any) => {
  if (doc.permissions && typeof doc.permissions === "object") {
    for (const k of ["allow", "ask", "deny", "additionalDirectories"]) delete doc.permissions[k];
    if (!Object.keys(doc.permissions).length) delete doc.permissions;
  }
  for (const k of ["enabledMcpjsonServers", "disabledMcpjsonServers", "enableAllProjectMcpServers"]) delete doc[k];
  return doc;
};

// Отпечаток ответов пользователя в окне Claude (ключи DIALOG) в .claude/settings.local.json каталога — хеш, без
// самих ответов. Отметка «доверие ставил miksy» после clean (Manifest.trustedBefore) хранит его: своими остаются
// только ответы, которые были в папке в момент clean (выпуск 0.2.1, проверка 7a, A №1)
// own — одобрения серверов, которые записал miksy (учёт TargetState.approvals): в отпечаток не входят. Тогда отпечаток
// при sync (одобрения на месте) и при сравнении после clean недоступной папки (одобрения ещё на месте) или после
// clean доступной (уже убраны) — один и тот же; пустые списки — как отсутствующие (проверка 7b, A №1; круг 7c)
export function dialogPrint(dir: string, own: string[] = []): string {
  let text: string;
  try { text = readFileSync(join(dir, ".claude/settings.local.json"), "utf8"); } catch { return sha("{}"); }
  let doc: any;
  try { doc = JSON.parse(text); } catch { return sha("bad:" + text); }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return sha("bad:" + text);
  const out: Record<string, unknown> = {};
  const perms = doc.permissions && typeof doc.permissions === "object" ? doc.permissions : {};
  for (const k of ["allow", "ask", "deny", "additionalDirectories"]) if (Object.hasOwn(perms, k)) out[`permissions.${k}`] = perms[k];
  for (const k of ["enabledMcpjsonServers", "disabledMcpjsonServers", "enableAllProjectMcpServers"]) if (Object.hasOwn(doc, k)) out[k] = doc[k];
  if (Array.isArray(out.enabledMcpjsonServers)) out.enabledMcpjsonServers = out.enabledMcpjsonServers.filter((n) => !own.includes(n as string));
  for (const [k, v] of Object.entries(out)) if (Array.isArray(v) && !v.length) delete out[k];
  return sha(JSON.stringify(out));
}

// Серверы командного .mcp.json (git-цель — отслеживаемый, в том числе за ссылкой; без git — на диске):
// имена и строки «что выполнится»; fingerprint — от полных определений серверов
export function mcpJsonServers(dir: string, git: boolean): { names: string[]; lines: string[]; fingerprint: string } | null {
  const file = join(dir, ".mcp.json");
  if (!existsSync(file) || (git && !teamFiles(dir, [".mcp.json"]).size)) return null;
  const r = mcpJson(file, ".mcp.json");
  const servers = r && r.data && typeof r.data === "object" && !("raw" in (r.data as object)) ? Object.keys(r.data as object) : [];
  if (!r || !servers.length) return null;
  return { names: servers, lines: r.lines, fingerprint: fingerprint([[".mcp.json", r.data]]) };
}

// Claude в проекте: headersHelper выполняется только при доверии
const helpers = (result: RenderResult) => [...new Set(result.files.flatMap((f) => f.mode === "merge" && f.key[0] === "projects"
  ? Object.entries(f.data as Record<string, any>).filter(([, d]) => d?.headersHelper).map(([n]) => n) : []))];

export const claudeTrust: TrustSpec = {
  file: ".claude.json",
  format: "json",
  table: "projects",
  field: "hasTrustDialogAccepted",
  value: true,
  // Claude: false — значение по умолчанию новой записи проекта (вопрос не задавался; в Zed он не задаётся), а не отказ
  unasked: false,
  keys: (dir, machine, existing) => { const p = projectKeys(dir, machine.os, existing); return [p.canonical, ...p.variants]; },
  settings: [
    { rel: ".claude/settings.json", read: claudeSettings, shared: true },
    { rel: ".claude/settings.local.json", read: claudeSettings, personal: true },
    { rel: ".mcp.json", read: mcpJson, shared: true },
  ],
  dialog: {
    file: ".claude/settings.local.json",
    strip: DIALOG,
    print: dialogPrint,
    // Заголовок ответов в окне Claude в вопросе о доверии (когда они не свои пользователя: доверие ставил не miksy, «да»
    // не было, — папку скопировали, она общая с коллегой или это первая запись miksy)
    title: "ответы в окне Claude («да, больше не спрашивать» и т. п.) — ваши или того, кто работал в этой папке:",
    groupSkip: ".claude",
  },
  // Одобрение серверов командного .mcp.json: Claude (2.1.311) читает его из .claude/settings.local.json проекта
  // (enabledMcpjsonServers; поле в ~/.claude.json сам переносит туда) и только в доверенном проекте; отслеживаемый git
  // файл не читает
  approvals: {
    file: ".claude/settings.local.json",
    source: ".mcp.json",
    keys: { enabled: "enabledMcpjsonServers", disabled: "disabledMcpjsonServers", all: "enableAllProjectMcpServers" },
    servers: mcpJsonServers,
    title: "серверы .mcp.json (Claude)",
    ask: "Одобрить серверы .mcp.json для Claude",
    also: " (и одобрить серверы .mcp.json)",
    adviceRefused: (where, why) => `Claude: ${where}/.claude/settings.local.json — ${why}: одобрение серверов .mcp.json miksy туда не пишет (отслеживаемый файл Claude не читает); одобрите серверы в Claude (/mcp)`,
    adviceUntrusted: (where, names) => `Claude: ${where} — проект не доверенный в Claude: одобрение серверов .mcp.json (${names.join(", ")}) снимается, без доверия Claude их всё равно не запускает. Доверитесь проекту в окне Claude — miksy sync вернёт одобрение (а если серверы сменились — спросит о них)`,
  },
  untrustedAdvice: (result) => {
    const h = helpers(result);
    return h.length ? `Claude: проект не доверенный — headersHelper (${h.join(", ")}) не выполнится, сервер получит 401; причина — в «нет доверия» выше` : null;
  },
};
