import { createHash } from "node:crypto";
import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Action } from "./apply";
import type { RenderResult, Target } from "./adapter";
import type { Machine } from "./types";
import type { ForgottenMark, Manifest, TargetState } from "./manifest";
import { emptyState, sha, writeAtomic } from "./manifest";
import { canonical, fold, pathKey, slash } from "./paths";
import { protectedBy, trackedPaths } from "./git";
import { escapes } from "./bounds";
import { configRoot } from "./load";
import { parseToml, removeField, removeTables, tableSections, tomlValue } from "./toml";
import { projectKeys } from "../adapters/claude/current";
import { type Move, movePath } from "./relocate";

// Политика доверия проектов (решение 2026-10-27). Miksy — единственный «диалог доверия» (Zed его не
// показывает): по умолчанию доверие Claude и Codex ставится цели, куда miksy доставил конфигурацию
// агента, включая группы. Исключение — цель с исполняемыми настройками агента команды
// (executableSettings): доверие только при trust: { <агент>: true } в слое или после «да» пользователя
// (вопрос в конце ручного sync, miksy trust); ответ запоминается в local/trust.json (отпечаток — без ответов
// пользователя в окне Claude: они его, когда доверие ставил miksy, слой разрешает или пользователь уже сказал «да» —
// dialogOwn; круг 6x). false в
// local/machine.yaml — окончательный, слой может только запретить. Своё доверие miksy снимает, когда
// пропало основание: clean, запрет, появились исполняемые настройки без решения, отказ пользователя,
// miksy больше ничего не доставляет агенту.

// previous — значение до miksy, которое clean возвращает (Claude: false — «вопрос о доверии ещё
// не задавался», так Claude создаёт запись проекта; отказ Claude не сохраняет)
export type TrustRecord = { format: "json" | "toml"; key: string[]; value: true | "trusted"; previous?: false };
export type TrustAction = TrustRecord & { kind: "trust"; abs: string; remove?: boolean; beforeHash: string; roots: string[] };
// Одобрение серверов командного .mcp.json (Claude): add — добавить в enabledMcpjsonServers, remove —
// убрать своё; own — одобренные miksy после действия (учёт TargetState.approvals)
export type ApproveAction = { kind: "approve"; abs: string; add: string[]; remove: string[]; own: string[]; beforeHash: string; roots: string[] };
export type TrustAgent = "claude" | "codex";
// mcpjson — отдельное решение об одобрении серверов .mcp.json (доверие Claude уже есть)
export type DecisionKind = TrustAgent | "mcpjson";
// Цель, где доверие ждёт решения пользователя (или уже отклонено): что будет выполняться; files —
// учтённые файлы (полное содержимое — в них). mcp — у цели есть серверы .mcp.json: «да» доверию Claude
// одобряет и их (отпечаток — только серверов)
export type PendingTrust = { dir: string; rel: string; agent: DecisionKind; fingerprint: string; lines: string[]; files: string[]; declined?: boolean; mcp?: { fingerprint: string } };
export const trustId = (file: string, key: string[]) => JSON.stringify([pathKey(file), ...key]);
export const trustValue = (doc: any, key: string[]) => key.reduce((v, k) => v?.[k], doc);
export function readTrust(file: string, format: "json" | "toml") {
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  try { return { text, doc: format === "json" ? JSON.parse(text || "{}") : parseToml(text) }; }
  catch { throw new Error(`${file}: конфиг доверия не разбирается — не меняю`); }
}
export const AGENT_TITLE: Record<DecisionKind, string> = { claude: "Claude", codex: "Codex", mcpjson: "серверы .mcp.json (Claude)" };

// ---- исполняемые настройки агента ----

// Показ: чужой текст в терминал — целиком (массив — в JSON-форме: границы аргументов видны), без
// управляющих символов (escape-последовательностей): они — \xNN. Значения ключей, похожих на секрет
// (env, заголовки), — скрыты: длина видна, само значение — в файле
const shown = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v) ?? String(v)).replace(/[\x00-\x1f\x7f-\x9f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
const SECRETISH = /KEY|TOKEN|SECRET|PASS|AUTH|CREDENTIAL|COOKIE|SESSION/i;
const masked = (v: unknown, key = ""): unknown =>
  typeof v === "string" ? (SECRETISH.test(key) ? `<скрыто: ${v.length} симв.>` : v)
    : Array.isArray(v) ? v.map((x) => masked(x, key))
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, masked(x, k)])) : v;

// Отпечаток решения — от полной канонической структуры учитываемых настроек (значения, границы
// массивов, env, весь документ Codex), а не от текста показа. FP — версия: отпечатки 2г (хеш показа,
// неполные) с ней не совпадают — такие согласия спрашиваются заново
const FP = "v2:";
const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as any)[k])])) : v);
const fingerprint = (data: unknown) => FP + createHash("sha256").update(JSON.stringify(canon(data))).digest("hex");

function readJsonFile(file: string): { doc?: any; bad?: true } {
  try { return { doc: JSON.parse(readFileSync(file, "utf8")) }; }
  catch { return { bad: true }; }
}

// Учтённый файл: строки показа и данные отпечатка (null — исполняемого нет)
type Inspected = { lines: string[]; data: unknown } | null;
const unreadable = (file: string, rel: string): Inspected => ({ lines: [`${rel}: не разбирается — содержимое не проверено`], data: { raw: readFileSync(file, "utf8") } });

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

// Определение сервера целиком: команда, аргументы (границы видны), env, url, заголовки (значения,
// похожие на секрет, скрыты)
const server = (rel: string, n: string, d: unknown) => `${rel}: MCP ${shown(n)}: ${shown(masked(d))}`;

function mcpJson(file: string, rel: string): Inspected {
  const { doc, bad } = readJsonFile(file);
  if (bad || !doc || typeof doc !== "object") return unreadable(file, rel);
  const servers = doc.mcpServers && typeof doc.mcpServers === "object" ? doc.mcpServers : {};
  const lines = Object.entries<any>(servers).map(([n, d]) => server(rel, n, d));
  return lines.length ? { lines, data: servers } : null;
}

// Командный .codex/config.toml: доверие загружает его целиком — серверы, notify и остальные настройки;
// отпечаток — весь разобранный документ
function codexConfig(file: string, rel: string): Inspected {
  let doc: any;
  try { doc = parseToml(readFileSync(file, "utf8")); }
  catch { return unreadable(file, rel); }
  const out = [`${rel}: конфиг Codex не от miksy — доверие загрузит его целиком`];
  for (const [n, d] of Object.entries<any>(doc.mcp_servers ?? {})) out.push(server(rel, n, d));
  for (const [k, v] of Object.entries<any>(doc)) if (k !== "mcp_servers") out.push(`${rel}: ${shown(k)} = ${shown(masked(v, k))}`);
  return { lines: out, data: doc };
}

const CANDIDATES: Record<TrustAgent, { rel: string; read: (file: string, rel: string, skip?: (doc: any) => any) => Inspected; noGit?: boolean }[]> = {
  claude: [
    { rel: ".claude/settings.json", read: claudeSettings, noGit: true },
    { rel: ".claude/settings.local.json", read: claudeSettings, noGit: true },
    { rel: ".mcp.json", read: mcpJson, noGit: true },
  ],
  codex: [{ rel: ".codex/config.toml", read: codexConfig, noGit: true }],
};

// Что из файлов цели — своё (по учёту): own-файлы miksy (хеш на диске = записанный), одобрения
// miksy в settings.local.json; dialog — ответы пользователя в окне Claude в неотслеживаемом settings.local.json
// (DIALOG) — его: их нет в вопросе о доверии, и доверию они не мешают (dialogOwn)
// written — файлы, которые этот же план записывает (--force поверх правки): после записи они его, и вопроса о
// содержимом, которого уже не будет, нет (рецензия 6z, п. 3)
export type OwnFiles = { files?: Record<string, string>; approvals?: string[]; dialog?: boolean; written?: string[] };
export const ownFiles = (prev: TargetState, dir: string, dialog = false): OwnFiles => ({
  files: prev.files,
  approvals: prev.approvals?.[pathKey(join(dir, ".claude/settings.local.json"))] ?? [],
  dialog,
});
// Доверие этой цели ставил miksy: стоит сейчас (учёт доверия), стояло раньше (TargetState.everTrusted: снято, пока
// исполняемые настройки команды ждут решения пользователя, и т. п.) или стояло до «забыть» (отметка «проект забыт»)
export const trustedByMiksy = (prev: TargetState, mark?: ForgottenMark) =>
  Object.keys(prev.trust ?? {}).length > 0 || prev.everTrusted === true || mark?.trusted === true;
// Ответы пользователя в окне Claude («да, больше не спрашивать», одобрения серверов .mcp.json) — его, если доверие
// ставил miksy (trustedByMiksy), в слое trust: true для Claude или пользователь уже сказал «да» на вопрос miksy о
// доверии Claude этому проекту (даже если с тех пор команда что-то поменяла — тогда в вопросе только её изменения).
// Иначе (папку скопировали у кого-то, она общая с коллегой) — они в вопросе. Отпечаток решения от этого не зависит:
// ответов Claude в нём нет никогда (executableSettings)
export const dialogOwn = (prev: TargetState, dir: string, layer: boolean, mark?: ForgottenMark) =>
  trustedByMiksy(prev, mark) || layer || loadDecisions()[pathKey(dir)]?.claude?.answer === "yes";

// Заголовок ответов в окне Claude в вопросе о доверии (когда они не свои пользователя: доверие ставил не miksy, «да»
// не было, — папку скопировали, она общая с коллегой или это первая запись miksy)
export const DIALOG_TITLE = "ответы в окне Claude («да, больше не спрашивать» и т. п.) — ваши или того, кто работал в этой папке:";
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
// Одобрения серверов .mcp.json, которые записал miksy в settings.local.json каталога (по учёту цели)
export const ownApprovals = (st: TargetState | undefined, dir: string): string[] =>
  st?.approvals?.[pathKey(join(dir, ".claude/settings.local.json"))] ?? [];
// Учёт цели для решения о доверии: с отметкой «доверие ставил miksy» после clean (Manifest.trustedBefore) — если
// ответы в окне Claude с момента clean не менялись (отпечаток тот же). Изменились — они в вопросе, как в 0.2.0
export function trustState(m: Manifest, id: string): TargetState | undefined {
  const st = m.targets[id];
  const print = m.trustedBefore?.[id];
  if (print === undefined || st?.everTrusted) return st;
  const dir = id.slice(id.indexOf("|") + 1);
  return print === dialogPrint(dir, ownApprovals(st, dir)) ? { ...(st ?? emptyState()), everTrusted: true } : st;
}

// Отслеживается ли файл командой: по индексу, а через ссылку (каталог-симлинк, файл-ссылка) — общей
// защитой git (protectedBy: логический путь, родительские ссылки, физическая цель)
function teamFiles(dir: string, rels: string[]): Set<string> {
  const team = new Set(trackedPaths(dir, rels));
  for (const rel of rels) {
    const abs = join(dir, rel);
    if (!team.has(rel) && existsSync(abs) && fold(canonical(abs)) !== fold(slash(resolve(abs))) && protectedBy(abs)) team.add(rel);
  }
  return team;
}

// Исполняемые настройки агента в каталоге.
// git-цель: файлы команды (в индексе, в том числе за ссылкой) — целиком; неотслеживаемые (решение
// 2026-10-27, Г3, вариант а) — тоже, кроме своего по учёту (own): own-файл miksy с записанным хешем
// (.codex/config.toml), одобрения miksy в settings.local.json и ответы пользователя в окне Claude (DIALOG) там же:
// в отпечаток решения они не входят никогда (иначе «да» совпадало бы только при том же состоянии доверия miksy —
// качели, рецензия 6w), в показ (вопрос) — когда они не свои пользователя (own.dialog, dialogOwn).
// Без git (группа, подкаталог группы) — .claude/settings.json и .mcp.json на диске целиком, settings.local.json —
// как неотслеживаемый в git-цели (одобрения miksy и ответы пользователя в окне Claude — по own; хуки, env и прочие
// исполняемые ключи — всегда: папка может быть общей с коллегой, рецензия 6x, A1), .codex/config.toml — тоже как
// неотслеживаемый: свой только с записанным хешем (рецензия 6y, A1).
// fingerprint — от полной структуры (FP): команда изменила настройки — решение спрашивается заново;
// legacy — отпечаток прежнего расчёта (0.1.x и круги до 6x: ответы Claude входили в него, когда доверие ставил не
// miksy), если он другой: «да» с ним принимается и переносится на новый (trustPlan: renew);
// files — учтённые файлы (для показа: полное содержимое — в них)
export function executableSettings(dir: string, git: boolean, agent: TrustAgent, own: OwnFiles = {}): { lines: string[]; fingerprint: string; files: string[]; legacy?: string } | null {
  const list = CANDIDATES[agent].filter((c) => (git || c.noGit) && existsSync(join(dir, c.rel)));
  if (!list.length) return null;
  const team = git ? teamFiles(dir, list.map((c) => c.rel)) : new Set<string>();
  const found: [string, unknown][] = [], past: [string, unknown][] = [], lines: string[] = [], files: string[] = [];
  for (const c of list) {
    const abs = join(dir, c.rel);
    const show = (r: Inspected) => { if (r) { lines.push(...r.lines); files.push(abs.replaceAll("\\", "/")); } };
    // Неотслеживаемый файл: в git-цели — не в индексе; без git — settings.local.json (личный файл Claude: ответы
    // пользователя в окне Claude и одобрения miksy в нём — как в git-проекте; остальное — исполняемые настройки) и
    // .codex/config.toml (свой — только с записанным хешем: правка или подмена после доверия miksy — чужое, как в
    // git-проекте; рецензия 6y, A1)
    if (git ? !team.has(c.rel) : c.rel !== ".claude/settings.json" && c.rel !== ".mcp.json") {
      const recorded = own.files?.[pathKey(abs)];
      if (own.written?.includes(pathKey(abs)) || (recorded && recorded === sha(readFileSync(abs, "utf8")))) continue;
      if (c.rel === ".claude/settings.local.json") {
        const mine = (doc: any) => {
          if (Array.isArray(doc.enabledMcpjsonServers)) doc.enabledMcpjsonServers = doc.enabledMcpjsonServers.filter((n: unknown) => !own.approvals?.includes(n as string));
          if (Array.isArray(doc.enabledMcpjsonServers) && !doc.enabledMcpjsonServers.length) delete doc.enabledMcpjsonServers;
          return doc;
        };
        const core = c.read(abs, c.rel, (doc) => DIALOG(mine(doc)));
        const full = c.read(abs, c.rel, mine);
        if (core) found.push([c.rel, core.data]);
        if (full) past.push([c.rel, full.data]);
        // Ответы в окне Claude в показе (не свои пользователя) — отдельной строкой: это не настройки команды
        if (own.dialog || !full) show(core);
        else {
          const dialog = full.lines.filter((l) => !core?.lines.includes(l));
          show({ lines: [...(core?.lines ?? []), ...(dialog.length ? [DIALOG_TITLE, ...dialog.map((l) => `  ${l}`)] : [])], data: full.data });
        }
        continue;
      }
    }
    const r = c.read(abs, c.rel);
    if (r) { found.push([c.rel, r.data]); past.push([c.rel, r.data]); }
    show(r);
  }
  if (!lines.length) return null;
  const fp = fingerprint(found), legacy = fingerprint(past);
  return { lines, fingerprint: fp, files, ...(legacy !== fp && { legacy }) };
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

// ---- решения пользователя: local/trust.json ----

// alone — «да» серверам .mcp.json на отдельный вопрос о них (пишет 0.2.1): действует и при «нет» доверию Claude
// (пользователь доверился проекту сам в окне Claude). Пара «нет» + «да» серверам без отметки — от 0.2.0 (там «нет»
// не отзывало прежнее «да» серверам): серверы она не одобряет, miksy спросит (выпуск 0.2.1, проверка 7a, A №2)
type Decision = { answer: "yes" | "no"; fingerprint: string; date: string; alone?: true };
type Decisions = Record<string, { rel?: string } & Partial<Record<DecisionKind, Decision>>>;
const decisionsPath = () => join(configRoot(), "local", "trust.json").replaceAll("\\", "/");
// Переехавшие каталоги (src/relocate.ts): решение прежнего пути — решение нового (отпечаток — от
// содержимого настроек, путь в него не входит)
let movedDecisions: { moves: Move[]; rel: (dir: string) => string } | null = null;
export function moveDecisions(moves: Move[], rel: (dir: string) => string) {
  movedDecisions = moves.length ? { moves, rel } : null;
}
function readDecisions(): { all: Decisions; moved: boolean } {
  const p = decisionsPath();
  if (!existsSync(p)) return { all: {}, moved: false };
  let all: Decisions;
  try { all = JSON.parse(readFileSync(p, "utf8")).decisions ?? {}; }
  catch { throw new Error(`${p}: не разбирается — решения о доверии не прочитаны; исправьте или удалите файл`); }
  if (!movedDecisions) return { all, moved: false };
  const out: Decisions = {};
  let moved = false;
  for (const [dir, d] of Object.entries(all)) {
    const to = movePath(dir, movedDecisions.moves);
    if (to === dir) { out[dir] = { ...out[dir], ...d }; continue; }
    moved = true;
    out[pathKey(to)] = { ...d, ...out[pathKey(to)], rel: movedDecisions.rel(pathKey(to)) };
  }
  return { all: out, moved };
}
export const loadDecisions = (): Decisions => readDecisions().all;
// sync и clean сохраняют перенос (doctor и --dry-run — нет)
export function saveMovedDecisions(): boolean {
  const { all, moved } = readDecisions();
  if (moved) writeAtomic(decisionsPath(), JSON.stringify({ version: 1, decisions: all }, null, 2) + "\n", { sensitive: true });
  return moved;
}
export function saveDecision(p: PendingTrust, answer: "yes" | "no") {
  const all = loadDecisions();
  const entry = (all[pathKey(p.dir)] ??= {});
  entry.rel = p.rel;
  const date = new Date().toISOString().slice(0, 10);
  entry[p.agent] = { answer, fingerprint: p.fingerprint, date, ...(p.agent === "mcpjson" && answer === "yes" && { alone: true as const }) };
  // «Да» доверию Claude видело и серверы .mcp.json (они в списке) — одобряет и их. «Нет» отзывает и прежнее «да»
  // серверам: иначе, доверься пользователь проекту сам в окне Claude, sync одобрил бы их по старому «да» (выпуск 0.2.1,
  // A2); серверы в списке — «нет» и им (вопроса о них нет, пересмотреть — miksy trust <проект>)
  if (p.agent === "claude" && p.mcp) entry.mcpjson = { answer, fingerprint: p.mcp.fingerprint, date };
  else if (p.agent === "claude" && answer === "no") delete entry.mcpjson;
  writeAtomic(decisionsPath(), JSON.stringify({ version: 1, decisions: all }, null, 2) + "\n", { sensitive: true });
}
// «Да» прежнего расчёта (executableSettings: legacy) — на новый отпечаток: ответ и дата те же. sync сохраняет
// (doctor и --dry-run — нет: «да» принимается и без переноса)
export type TrustRenew = { dir: string; agent: DecisionKind; from: string; to: string };
export function renewDecision(r: TrustRenew): boolean {
  const all = loadDecisions();
  const d = all[pathKey(r.dir)]?.[r.agent];
  if (d?.answer !== "yes" || d.fingerprint !== r.from) return false;
  d.fingerprint = r.to;
  writeAtomic(decisionsPath(), JSON.stringify({ version: 1, decisions: all }, null, 2) + "\n", { sensitive: true });
  return true;
}

// Список «нужно решение» для вывода sync/doctor/trust
export function pendingText(list: PendingTrust[]): string[] {
  return list.flatMap((p) => [`  ${p.rel || p.dir} — ${AGENT_TITLE[p.agent]}:`, ...p.lines.map((l) => `      ${l}`),
    ...(p.files.length ? [`      полное содержимое (скрытые значения — тоже) — в файлах: ${p.files.join(", ")}`] : [])]);
}
export const AGENT_NOTE = "Агенту: не подтверждай доверие сам (и одобрение серверов .mcp.json) — покажи этот список пользователю и спроси. Решение записывает пользователь: miksy trust <проект> в терминале; агент — только после явного «да» пользователя в чате: miksy trust <проект> --confirm (отказ — --deny).";

// Вопрос (read — строка ответа: терминал или мастер setup): y — да, n — нет (запоминается), пусто —
// решить позже (не запоминается)
export function askTrust(p: PendingTrust, read: (question: string) => string | null = (q) => prompt(q)): "yes" | "no" | null {
  const what = p.agent === "mcpjson" ? `Одобрить серверы .mcp.json для Claude в ${p.rel || p.dir}`
    : `Доверять ${AGENT_TITLE[p.agent]} в ${p.rel || p.dir}${p.mcp ? " (и одобрить серверы .mcp.json)" : ""}`;
  const a = read(`${what}? [y/N] (y — да; n — нет, больше не спрашивать; Enter — решить позже)`)?.trim().toLowerCase();
  if (a && /^(y|yes|д|да)$/.test(a)) return "yes";
  if (a && /^(n|no|н|нет)$/.test(a)) return "no";
  return null;
}

// Подкаталоги группы без своего git: Claude наследует доверие группы на них (ищет его вверх до корня
// ФС, когда git-корня нет) — их исполняемые настройки применились бы без вопроса. Вложенные группы
// и git-репо (свой корень доверия) не обходятся; глубина и число каталогов ограничены
const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", "dist", "build", "target"]);
export function inheritedExec(group: string, otherGroups: string[], dialog = false, limit = 20000): { dir: string; lines: string[] }[] {
  const out: { dir: string; lines: string[] }[] = [];
  const skip = new Set(otherGroups.map((g) => pathKey(g)));
  let seen = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || seen++ > limit) return;
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name === ".claude" || e.name === ".miksy") continue;
      const sub = `${dir}/${e.name}`;
      if (existsSync(join(sub, ".git")) || skip.has(pathKey(sub))) continue;
      const exec = executableSettings(sub, false, "claude", { dialog });
      if (exec) out.push({ dir: sub, lines: exec.lines });
      walk(sub, depth + 1);
    }
  };
  walk(group.replaceAll("\\", "/"), 1);
  return out;
}

// ---- план ----

const ADD = "будет добавлено при sync";

// refuse — защита git из плана (gitRefusal: файл команды, в том числе за ссылкой; вложенное репо; сбой
// git): одобрения пишутся только туда, куда план пишет остальные файлы. excluded — строки блока miksy этого
// агента в .git/info/exclude проекта (улика своих одобрений, когда учёт их забыл). mark — отметка «проект забыт»
// (доверие до «забыть» ставил miksy — ответы пользователя в окне Claude его). renew — «да» прежнего расчёта на новый
export function trustPlan(result: RenderResult, target: Target, machine: Machine, prev: TargetState, actions: Action[], agent: string,
  refuse: (path: string) => string | null = (p) => (protectedBy(p) ? "файл отслеживается git" : null), excluded: string[] = [], mark?: ForgottenMark):
  { actions: Action[]; missing: string[]; pending?: PendingTrust; advice: string[]; renew?: TrustRenew; own?: OwnFiles } {
  const out: Action[] = [], missing: string[] = [], advice: string[] = [];
  let pending: PendingTrust | undefined;
  let renew: TrustRenew | undefined;
  let own: OwnFiles | undefined;
  if (target.scope !== "project" || !["codex", "claude"].includes(agent)) return { actions: out, missing, advice };
  const a = agent as TrustAgent;
  const clean = result.clean === true;
  const file = join(machine.home, a === "codex" ? ".codex/config.toml" : ".claude.json").replaceAll("\\", "/");
  const format = a === "codex" ? "toml" : "json";
  // Claude в проекте: headersHelper выполняется только при доверии
  const helpers = a === "claude" ? [...new Set(result.files.flatMap((f) => f.mode === "merge" && f.key[0] === "projects"
    ? Object.entries(f.data as Record<string, any>).filter(([, d]) => d?.headersHelper).map(([n]) => n) : []))] : [];
  let trusted = false;
  try {
    const { text, doc } = readTrust(file, format);
    const roots = [canonical(machine.home)];
    const refusal = escapes(file, ...roots) || (protectedBy(file) ? "конфиг доверия отслеживается git" : null);
    // false в machine.yaml окончателен; слой только запрещает (false) или разрешает исполняемые настройки (true)
    const fromLayer = result.trust?.[a];
    const machineOff = machine.trust?.[a] === false;
    const off = machineOff || fromLayer?.item === false;
    const offWhy = machineOff ? "автодоверие выключено в local/machine.yaml (окончательно: слой его не включает)" : `доверие запрещено в слое ${fromLayer?.layer} (trust в layer.yaml)`;
    // Доставка: strict — записано без конфликта в этом плане (основание добавить); rendered — адаптер
    // что-то даёт агенту в цель, пусть и с конфликтом (основание оставить уже поставленное)
    const projectConfig = pathKey(join(target.dir, ".codex/config.toml"));
    const successful = (path: string) => !actions.some((x) => x.kind === "conflict" && pathKey(x.abs) === pathKey(path));
    const ownMerge = (f: RenderResult["files"][number]) => f.mode === "merge" && f.key[0] === "projects" && Object.keys(f.data as object).length > 0;
    const rendered = a === "codex"
      ? result.files.some((f) => f.base === "project" && f.path === ".codex/config.toml")
      : result.files.some((f) => f.base === "project" || ownMerge(f));
    const strict = a === "codex"
      ? result.files.some((f) => f.base === "project" && f.path === ".codex/config.toml" && successful(projectConfig))
      : result.files.some((f) => f.base === "project" && successful(join(target.dir, f.path)))
        || result.files.some((f) => ownMerge(f) && f.mode === "merge" && (
          actions.some((x) => x.kind === "merge" && x.own.length && JSON.stringify(x.key) === JSON.stringify(f.key))
          || ((prev.merges[pathKey(file)]?.[JSON.stringify(f.key)] ?? []).some((n) => Object.hasOwn(f.data as object, n)) && trustValue(doc, f.key.slice(0, 2)) !== undefined)));
    // Исполняемые настройки агента и решение о них
    // Свои — и файлы miksy без учёта, узнанные этим планом (учёт был забыт — clean --forget, диск вернулся):
    // берётся обратно, перезаписывается, конфликтует с нынешним выводом или убирается как ненужный. Иначе их
    // прежний текст выглядел бы чужим конфигом агента: вопрос о доверии к своему же файлу, а доверие — только
    // со следующего sync. Хеш — того, что на диске сейчас
    const known = Object.fromEntries(actions.flatMap((x) => (x.known && x.kind !== "approve" && existsSync(x.abs) ? [[pathKey(x.abs), sha(readFileSync(x.abs, "utf8"))]] : [])));
    const local = join(target.dir, ".claude/settings.local.json").replaceAll("\\", "/");
    const written = actions.filter((x) => x.kind === "write").map((x) => pathKey(x.abs));
    // Одобрения серверов .mcp.json, которые записал miksy, когда учёт их забыл: файл одобрений под точной строкой
    // блока miksy claude в exclude (её miksy пишет, только пока в файле его одобрения), не файл git; кандидаты —
    // одобренные в файле серверы командного .mcp.json. Своими они станут, только если miksy одобрил бы их сейчас
    // (basis ниже): одобрения пишет и сам Claude, когда пользователь одобряет сервер в его окне
    const recordedApprovals = prev.approvals?.[pathKey(local)] ?? [];
    let regained: string[] = [];
    if (a === "claude" && !clean && !off && !recordedApprovals.length && excluded.includes("/.claude/settings.local.json") && existsSync(local) && !(target.git && refuse(local))) {
      const { doc, bad } = readJsonFile(local);
      const servers = !bad && doc && typeof doc === "object" && !Array.isArray(doc) && doc.enableAllProjectMcpServers !== true ? mcpJsonServers(target.dir, !!target.git) : null;
      const names = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
      if (servers) regained = names(doc.enabledMcpjsonServers).filter((n) => servers.names.includes(n) && !names(doc.disabledMcpjsonServers).includes(n));
    }
    // Исполняемые настройки агента, решения пользователя о них и основание одобрить серверы .mcp.json — при
    // данных своих одобрениях. Ответы пользователя в окне Claude — его (dialogOwn): доверие ставил miksy, слой
    // trust: true или «да» пользователя доверию Claude здесь (решения грузятся, только когда есть что решать)
    const ownDialog = a === "claude" && (trustedByMiksy(prev, mark) || fromLayer?.item === true);
    const judge = (approvals: string[]) => {
      const st = { ...prev, files: { ...prev.files, ...known }, approvals: { ...prev.approvals, ...(approvals.length > 0 && { [pathKey(local)]: approvals }) } };
      const see = (dialog: boolean) => (clean || off ? null : executableSettings(target.dir, !!target.git, a, { ...ownFiles(st, target.dir, dialog), written }));
      let exec = see(ownDialog);
      const decisions = exec ? loadDecisions()[pathKey(target.dir)] : undefined;
      if (exec && a === "claude" && !ownDialog && decisions?.claude?.answer === "yes") exec = see(true);
      const decision = decisions?.[a];
      // «Да» прежнего расчёта (с ответами Claude в отпечатке) — принимается и переносится на новый
      const old = !!exec?.legacy && decision?.answer === "yes" && decision.fingerprint === exec.legacy;
      const approved = fromLayer?.item === true || (decision?.answer === "yes" && (decision.fingerprint === exec?.fingerprint || old));
      const mcp = a === "claude" && exec ? mcpJsonServers(target.dir, !!target.git) : null;
      // «Да» серверам при «нет» доверию Claude — только отдельное (alone): пара от 0.2.0 — не основание
      const basis = approved || (decisions?.mcpjson?.answer === "yes" && decisions.mcpjson.fingerprint === mcp?.fingerprint
        && (decisions.claude?.answer !== "no" || decisions.mcpjson.alone === true));
      return { exec, decisions, decision, approved, mcp, basis, old };
    };
    let j = judge(regained);
    if (regained.length && !j.basis) { regained = []; j = judge([]); }
    const { exec, decisions, decision, approved, mcp } = j;
    // Свои файлы и одобрения для просмотра miksy trust <проект> (src/commands.ts) — то, что план берёт: учёт и
    // узнанные после «забыть», кроме конфликтных (рецензия 6y, A4). Шапку «Сгенерировано miksy» мог оставить кто
    // угодно (копия папки, архив): такой файл sync не берёт и доверия по нему не ставит (конфликт — не доставка), а
    // просмотр показывает его чужим, и решение о нём можно записать. Вопроса sync о нём нет (рецензия 6w, п. 3:
    // свой файл после «забыть» при изменившихся слоях — конфликт без вопроса, --force — доверие в том же запуске)
    const conflicting = new Set(actions.filter((x) => x.kind === "conflict").map((x) => pathKey(x.abs)));
    const accepted = Object.fromEntries(Object.entries(known).filter(([k]) => !conflicting.has(k)));
    own = { files: { ...prev.files, ...accepted }, approvals: regained.length ? regained : (prev.approvals?.[pathKey(local)] ?? []) };
    if (j.old && exec) renew = { dir: target.dir, agent: a, from: decision!.fingerprint, to: exec.fingerprint };
    const declined = decision?.answer === "no";
    if (exec && !approved) pending = { dir: target.dir, rel: target.rel, agent: a, fingerprint: exec.fingerprint, lines: exec.lines, files: exec.files, ...(declined && { declined: true }), ...(mcp && { mcp: { fingerprint: mcp.fingerprint } }) };

    // Одобрение серверов командного .mcp.json: Claude (2.1.311) читает его из .claude/settings.local.json
    // проекта (enabledMcpjsonServers; поле в ~/.claude.json сам переносит туда) и только в доверенном
    // проекте; отслеживаемый git файл не читает. Основание — trust: true в слое или «да» пользователя
    // (доверию Claude при этих серверах или отдельно серверам). Решения пользователя (одобренные и
    // отклонённые им самим) не трогаются; своё одобрение снимается, когда основания нет
    const approvals = () => {
      if (a !== "claude") return;
      if (!mcp && !recordedApprovals.length) return;
      const exists = existsSync(local);
      const settings = exists ? readJsonFile(local) : { doc: {} };
      if (settings.bad || !settings.doc || typeof settings.doc !== "object" || Array.isArray(settings.doc)) {
        out.push({ kind: "conflict", abs: local, why: "не разбирается как JSON — одобрение серверов .mcp.json не меняю" });
        return;
      }
      const doc = settings.doc;
      const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
      const enabled = list(doc.enabledMcpjsonServers), disabled = list(doc.disabledMcpjsonServers);
      // Файл команды (в том числе за ссылкой) или вне защиты git — одобрения не пишутся
      const gitWhy = target.git ? refuse(local) : null;
      const team = !!gitWhy;
      const mcpDecision = decisions?.mcpjson;
      const basis = j.basis;
      const eligible = trusted && !clean && !off && !team && doc.enableAllProjectMcpServers !== true;
      const want = eligible && basis && mcp ? mcp.names.filter((n) => !disabled.includes(n)) : [];
      // Свои — по учёту и узнанные (только те, что miksy одобряет сейчас; остальные в файле — чужие, не снимаются)
      const back = regained.filter((n) => want.includes(n) && enabled.includes(n));
      const ours = [...new Set([...recordedApprovals, ...back])];
      const add = want.filter((n) => !enabled.includes(n));
      const own = [...new Set([...ours.filter((n) => want.includes(n) && enabled.includes(n)), ...add])].sort();
      const remove = ours.filter((n) => !want.includes(n) && enabled.includes(n));
      const refusal = escapes(local, target.dir) || gitWhy;
      if (add.length || remove.length || JSON.stringify([...recordedApprovals].sort()) !== JSON.stringify(own)) {
        if (refusal && (add.length || remove.length)) out.push({ kind: "conflict", abs: local, why: `${refusal} — одобрение серверов .mcp.json не меняю` });
        else out.push({ kind: "approve", abs: local, add, remove, own, beforeHash: sha(exists ? readFileSync(local, "utf8") : ""), roots: [target.dir], ...(back.length > 0 && { known: true }) });
      }
      if (team && mcp && !clean) advice.push(`Claude: ${target.rel || target.dir}/.claude/settings.local.json — ${gitWhy}: одобрение серверов .mcp.json miksy туда не пишет (отслеживаемый файл Claude не читает); одобрите серверы в Claude (/mcp)`);
      // Неодобренные — и те, чьё одобрение этот же план снимает (своё без основания): вопрос в том же sync, а не в
      // следующем (проверка 7b, A №2)
      const unapproved = mcp && eligible && !basis ? mcp.names.filter((n) => (!enabled.includes(n) || remove.includes(n)) && !disabled.includes(n)) : [];
      if (unapproved.length && !pending)
        pending = { dir: target.dir, rel: target.rel, agent: "mcpjson", fingerprint: mcp!.fingerprint, lines: mcp!.lines, files: [join(target.dir, ".mcp.json").replaceAll("\\", "/")], ...(mcpDecision?.answer === "no" && { declined: true }) };
      // Одобрение miksy снимается, а вопроса в этом запуске нет: проект не доверенный в Claude (вы сняли доверие сами;
      // доверие miksy здесь не ставил — «нет» доверию Claude), а прежний отказ не переспрашивается. Вопрос о серверах
      // не поможет — без доверия Claude их не запускает; подсказка — что будет дальше (выпуск 0.2.2, A2: правило R2 и
      // для этого пути). Есть вопрос (сменились настройки, доверие снимает сам miksy) — подсказки нет: ответ решает.
      // Не в clean, не при запрете trust: false и не когда файл одобрений менять нельзя (конфликт)
      const asked = !!pending && !pending.declined;
      if (remove.length && !trusted && !clean && !off && !team && !refusal && !asked && !Object.keys(prev.trust ?? {}).length)
        advice.push(`Claude: ${target.rel || target.dir} — проект не доверенный в Claude: одобрение серверов .mcp.json (${remove.join(", ")}) снимается, без доверия Claude их всё равно не запускает. Доверитесь проекту в окне Claude — miksy sync вернёт одобрение (а если серверы сменились — спросит о них)`);
    };
    // Почему доверия быть не должно (null — должно)
    const why: string | null = clean ? "clean" : off ? offWhy
      : exec && !approved ? (declined ? "пользователь отказал в доверии (miksy trust)"
        : `нужно решение пользователя: исполняемые настройки агента не от miksy (${exec.lines.length}) — miksy trust ${target.rel || target.dir}`)
      : !exec && !rendered ? "miksy не доставляет конфигурацию для этого агента (командный файл или нечего доставлять)"
      : null;
    if (why !== null) {
      for (const [id, rec] of Object.entries(prev.trust ?? {})) {
        const [p] = JSON.parse(id);
        if (pathKey(p) !== pathKey(file)) throw new Error("учёт доверия указывает на другой файл — не меняю");
        if (refusal) throw new Error(refusal);
        const cur = trustValue(doc, rec.key);
        if (cur !== undefined && cur !== rec.value) missing.push(`доверие изменено пользователем: ${rec.key[1]} — оставлено`);
        out.push({ kind: "trust", abs: file, ...rec, remove: true, beforeHash: sha(text), roots });
        if (!clean) missing.push(`${rec.key[1]}: ${why} — доверие, поставленное miksy, снимается`);
      }
      if (clean) {
        approvals();
        return { actions: out, missing, advice };
      }
    }
    const keys = a === "codex"
      // В существующих записях Codex Windows — обычный путь с обратными слэшами.
      ? [codexProjectKey(target.dir, machine, Object.keys(doc.projects ?? {}))]
      : (() => { const p = projectKeys(target.dir, machine.os, Object.keys(doc.projects ?? {})); return [p.canonical, ...p.variants]; })();
    // Своё доверие прежнему пути цели (каталог переехал, учёт перенесён) — снимается: под нынешним
    // путём оно ставится по тем же правилам
    if (why === null) for (const [id, rec] of Object.entries(prev.trust ?? {})) {
      if (keys.includes(rec.key[1])) continue;
      if (pathKey(JSON.parse(id)[0]) !== pathKey(file)) throw new Error("учёт доверия указывает на другой файл — не меняю");
      if (refusal) throw new Error(refusal);
      out.push({ kind: "trust", abs: file, ...rec, remove: true, beforeHash: sha(text), roots });
    }
    for (const k of keys) {
      const key = ["projects", k, a === "codex" ? "trust_level" : "hasTrustDialogAccepted"];
      const value = a === "codex" ? "trusted" as const : true as const;
      const cur = trustValue(doc, key);
      const recorded = Object.hasOwn(prev.trust ?? {}, trustId(file, key));
      if (why !== null && recorded) continue; // снимается выше
      // Чужое доверие не берём под учёт; поставленное пользователем — его решение, вопрос не нужен
      if (cur === value) { trusted = true; if (!recorded) pending = undefined; continue; }
      // Claude: false — значение по умолчанию новой записи проекта (вопрос не задавался; в Zed он не
      // задаётся), а не отказ. Codex: untrusted — явный ответ пользователя, его не меняем
      const notAsked = a === "claude" && cur === false;
      const reason = why ?? (!approved && !strict ? "miksy не доставляет конфигурацию для этого агента (командный файл или конфликт)"
        : refusal ? refusal
        : cur !== undefined && !notAsked ? "пользователь уже задал другое значение доверия — не меняю" : ADD);
      // Отказ пользователя — только в справке doctor, не в предупреждениях
      if (!declined) missing.push(`${k}: ${reason}`);
      if (reason === ADD) {
        trusted = true;
        out.push({ kind: "trust", abs: file, format, key, value, ...(notAsked && { previous: false as const }), beforeHash: sha(text), roots });
      }
    }
    approvals();
  } catch (e) {
    missing.push((e as Error).message);
    out.push({ kind: "conflict", abs: file, why: (e as Error).message });
  }
  // Итог согласован с планом: предупреждение о headersHelper — только если доверия после sync не будет
  if (helpers.length && !trusted && !clean)
    advice.push(`Claude: проект не доверенный — headersHelper (${helpers.join(", ")}) не выполнится, сервер получит 401; причина — в «нет доверия» выше`);
  return { actions: out, missing, ...(pending && { pending }), advice, ...(renew && { renew }), ...(own && { own }) };
}

export function codexProjectKey(dir: string, machine: Machine, existing: string[]): string {
  const key = pathKey(dir);
  const match = existing.find((p) => pathKey(p.replace(/^\\\\\?\\/, "")) === key);
  if (match) return match;
  return machine.os === "windows" && /^[A-Za-z]:\//.test(dir)
    ? canonical(dir).replaceAll("/", "\\").toLowerCase() : canonical(dir);
}

// Точная правка единственного поля проекта по разбору TOML (строка ключа вне многострочных строк,
// итог сверяется); другие поля, таблицы и комментарии остаются.
export function editTrustToml(text: string, a: TrustAction): string {
  const [root, project, field] = a.key;
  const doc = parseToml(text), cur = trustValue(doc, a.key);
  if (a.remove && cur !== a.value) return text;
  const section = tableSections(text).find((s) => s.key.length === 2 && s.key[0] === root && s.key[1] === project);
  if (!section) {
    if (a.remove) return text;
    if (doc[root]?.[project] !== undefined) throw new Error("TOML: trust задан inline — не меняю");
    return text + (text && !text.endsWith("\n") ? "\n" : "") + `[${root}.${tomlValue(project)}]\n${field} = ${tomlValue(a.value)}\n`;
  }
  if (!a.remove) return text.slice(0, section.end) + (section.end > 0 && text[section.end - 1] !== "\n" ? "\n" : "") + `${field} = ${tomlValue(a.value)}\n` + text.slice(section.end);
  const fields = doc[root][project];
  if (Object.keys(fields).length === 1) return removeTables(text, [root, project]);
  return removeField(text, [root, project], field);
}
