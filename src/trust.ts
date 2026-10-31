import { createHash } from "node:crypto";
import { type Dirent, existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Action } from "./apply";
import type { RenderResult, Target } from "./adapter";
import type { Machine } from "./types";
import type { TargetState } from "./manifest";
import { sha, writeAtomic } from "./manifest";
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
// (вопрос в конце ручного sync, miksy trust); ответ запоминается в local/trust.json. false в
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
    { rel: ".claude/settings.local.json", read: claudeSettings },
    { rel: ".mcp.json", read: mcpJson, noGit: true },
  ],
  codex: [{ rel: ".codex/config.toml", read: codexConfig }],
};

// Что из файлов цели — своё (по учёту): own-файлы miksy (хеш на диске = записанный), одобрения
// miksy в settings.local.json; trusted — доверие цели поставил miksy (в доверенном проекте Claude
// сам пишет в settings.local.json ответы пользователя из своих диалогов)
export type OwnFiles = { files?: Record<string, string>; approvals?: string[]; trusted?: boolean };
export const ownFiles = (prev: TargetState, dir: string): OwnFiles => ({
  files: prev.files,
  approvals: prev.approvals?.[pathKey(join(dir, ".claude/settings.local.json"))] ?? [],
  trusted: Object.keys(prev.trust ?? {}).length > 0,
});

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
// (.codex/config.toml), одобрения miksy в settings.local.json, а в доверенном miksy проекте —
// ответы пользователя в диалогах Claude (DIALOG) там же.
// Без git (группа, подкаталог группы) — .claude/settings.json и .mcp.json на диске (settings.local.json
// Claude пишет сам, свой .codex/config.toml пишет miksy).
// fingerprint — от полной структуры (FP): команда изменила настройки — решение спрашивается заново;
// files — учтённые файлы (для показа: полное содержимое — в них)
export function executableSettings(dir: string, git: boolean, agent: TrustAgent, own: OwnFiles = {}): { lines: string[]; fingerprint: string; files: string[] } | null {
  const list = CANDIDATES[agent].filter((c) => (git || c.noGit) && existsSync(join(dir, c.rel)));
  if (!list.length) return null;
  const team = git ? teamFiles(dir, list.map((c) => c.rel)) : new Set<string>();
  const found: { rel: string; lines: string[]; data: unknown }[] = [];
  for (const c of list) {
    const abs = join(dir, c.rel);
    let skip: ((doc: any) => any) | undefined;
    if (git && !team.has(c.rel)) {
      const recorded = own.files?.[pathKey(abs)];
      if (recorded && recorded === sha(readFileSync(abs, "utf8"))) continue;
      if (c.rel === ".claude/settings.local.json") skip = (doc) => {
        if (Array.isArray(doc.enabledMcpjsonServers)) doc.enabledMcpjsonServers = doc.enabledMcpjsonServers.filter((n: unknown) => !own.approvals?.includes(n as string));
        if (Array.isArray(doc.enabledMcpjsonServers) && !doc.enabledMcpjsonServers.length) delete doc.enabledMcpjsonServers;
        return own.trusted ? DIALOG(doc) : doc;
      };
    }
    const r = c.read(abs, c.rel, skip);
    if (r) found.push({ rel: c.rel, ...r });
  }
  if (!found.length) return null;
  return { lines: found.flatMap((f) => f.lines), fingerprint: fingerprint(found.map((f) => [f.rel, f.data])), files: found.map((f) => join(dir, f.rel).replaceAll("\\", "/")) };
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

type Decision = { answer: "yes" | "no"; fingerprint: string; date: string };
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
  entry[p.agent] = { answer, fingerprint: p.fingerprint, date };
  // «Да» доверию Claude видело и серверы .mcp.json (они в списке) — одобряет и их
  if (p.agent === "claude" && answer === "yes" && p.mcp) entry.mcpjson = { answer, fingerprint: p.mcp.fingerprint, date };
  writeAtomic(decisionsPath(), JSON.stringify({ version: 1, decisions: all }, null, 2) + "\n", { sensitive: true });
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
export function inheritedExec(group: string, otherGroups: string[], limit = 20000): { dir: string; lines: string[] }[] {
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
      const exec = executableSettings(sub, false, "claude");
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
// git): одобрения пишутся только туда, куда план пишет остальные файлы
export function trustPlan(result: RenderResult, target: Target, machine: Machine, prev: TargetState, actions: Action[], agent: string,
  refuse: (path: string) => string | null = (p) => (protectedBy(p) ? "файл отслеживается git" : null)):
  { actions: Action[]; missing: string[]; pending?: PendingTrust; advice: string[] } {
  const out: Action[] = [], missing: string[] = [], advice: string[] = [];
  let pending: PendingTrust | undefined;
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
    const local = join(target.dir, ".claude/settings.local.json").replaceAll("\\", "/");
    const mine = ownFiles(prev, target.dir);
    const exec = clean || off ? null : executableSettings(target.dir, !!target.git, a, mine);
    const decisions = exec ? loadDecisions()[pathKey(target.dir)] : undefined;
    const decision = decisions?.[a];
    const declined = decision?.answer === "no";
    const approved = fromLayer?.item === true || (decision?.answer === "yes" && decision.fingerprint === exec?.fingerprint);
    const mcp = a === "claude" && exec ? mcpJsonServers(target.dir, !!target.git) : null;
    if (exec && !approved) pending = { dir: target.dir, rel: target.rel, agent: a, fingerprint: exec.fingerprint, lines: exec.lines, files: exec.files, ...(declined && { declined: true }), ...(mcp && { mcp: { fingerprint: mcp.fingerprint } }) };

    // Одобрение серверов командного .mcp.json: Claude (2.1.311) читает его из .claude/settings.local.json
    // проекта (enabledMcpjsonServers; поле в ~/.claude.json сам переносит туда) и только в доверенном
    // проекте; отслеживаемый git файл не читает. Основание — trust: true в слое или «да» пользователя
    // (доверию Claude при этих серверах или отдельно серверам). Решения пользователя (одобренные и
    // отклонённые им самим) не трогаются; своё одобрение снимается, когда основания нет
    const approvals = () => {
      if (a !== "claude") return;
      const ours = mine.approvals!;
      if (!mcp && !ours.length) return;
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
      const basis = fromLayer?.item === true || (decision?.answer === "yes" && decision.fingerprint === exec?.fingerprint)
        || (mcpDecision?.answer === "yes" && mcpDecision.fingerprint === mcp?.fingerprint);
      const eligible = trusted && !clean && !off && !team && doc.enableAllProjectMcpServers !== true;
      const want = eligible && basis && mcp ? mcp.names.filter((n) => !disabled.includes(n)) : [];
      const add = want.filter((n) => !enabled.includes(n));
      const own = [...new Set([...ours.filter((n) => want.includes(n) && enabled.includes(n)), ...add])].sort();
      const remove = ours.filter((n) => !want.includes(n) && enabled.includes(n));
      if (add.length || remove.length || JSON.stringify([...ours].sort()) !== JSON.stringify(own)) {
        const refusal = escapes(local, target.dir) || gitWhy;
        if (refusal && (add.length || remove.length)) out.push({ kind: "conflict", abs: local, why: `${refusal} — одобрение серверов .mcp.json не меняю` });
        else out.push({ kind: "approve", abs: local, add, remove, own, beforeHash: sha(exists ? readFileSync(local, "utf8") : ""), roots: [target.dir] });
      }
      if (team && mcp && !clean) advice.push(`Claude: ${target.rel || target.dir}/.claude/settings.local.json — ${gitWhy}: одобрение серверов .mcp.json miksy туда не пишет (отслеживаемый файл Claude не читает); одобрите серверы в Claude (/mcp)`);
      const unapproved = mcp && eligible && !basis ? mcp.names.filter((n) => !enabled.includes(n) && !disabled.includes(n)) : [];
      if (unapproved.length && !pending)
        pending = { dir: target.dir, rel: target.rel, agent: "mcpjson", fingerprint: mcp!.fingerprint, lines: mcp!.lines, files: [join(target.dir, ".mcp.json").replaceAll("\\", "/")], ...(mcpDecision?.answer === "no" && { declined: true }) };
    };
    // Почему доверия быть не должно (null — должно)
    const why: string | null = clean ? "clean" : off ? offWhy
      : exec && !approved ? (declined ? "пользователь отказал в доверии (miksy trust)"
        : `нужно решение пользователя: исполняемые настройки агента команды (${exec.lines.length}) — miksy trust ${target.rel || target.dir}`)
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
  return { actions: out, missing, ...(pending && { pending }), advice };
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
