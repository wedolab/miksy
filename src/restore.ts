// miksy restore — вернуть настройки агентов из копии «до miksy» (local/backups/before-miksy-<метка>/, её делает мастер,
// вопрос 3). Круг 10c: вместо длинной команды оболочки из мастера и «Как удалить» (выпуски 0.2.2–0.2.3) — то же правило
// в коде, без оболочки и кавычек:
// - пути в копии — от домашнего каталога; .claude.json не возвращается никогда (в нём вход и список проектов Claude):
//   называются только имена его MCP-серверов;
// - возвращается только то, что лежит в каталогах настроек агентов (AGENT_DIRS: всё, что мастер когда-либо копировал,
//   и соседние файлы тех же каталогов); остальное в папке — «пропущено» по именам (неверный путь копии не разложит
//   посторонние файлы по домашнему каталогу);
// - файл пишется в существующий на месте (r+ и усечение): сквозь ссылки пользователя (dotfiles), права и скрытый
//   атрибут сохраняются; на месте настоящая папка — «не возвращён»; затираемое — сначала в бэкап запуска (backup);
// - ссылка из копии — ссылкой: POSIX — та же записанная цель; Windows — на папку junction (прав администратора не
//   нужно; относительная цель — от папки ссылки), на файл — символическая ссылка. Та же ссылка уже на месте — пропуск;
//   иначе новая создаётся рядом (<имя>.miksy-new) и встаёт на место прежней; при неудаче остаток убирается;
// - ошибка по файлу — строка «не возвращён: … — причина», остальное возвращается; повторять безопасно.
import { chmodSync, closeSync, copyFileSync, existsSync, ftruncateSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join, relative, resolve, win32 } from "node:path";
import { behindLink, closeOwn, ensurePrivateLocal, refuseBackupPath } from "./secretfiles";
import { ADAPTERS } from "./registry";
import { homeDir, slash } from "./paths";
import { loadManifest, type Manifest, writeAtomic } from "./manifest";
import { agentId } from "./agentid";
import { UsageError } from "./args";
import type { Ask } from "./ask";
import { configRoot, loadMachine } from "./load";
import { files } from "./plural";
import { Cancelled } from "./commands";
import { linkIsDir, resetLinkKinds } from "./setup";

const win = process.platform === "win32";

// Что мастер копировал в before-miksy: homeConfig адаптеров. Список не менялся с первой версии мастера (2026-10-28,
// до 0.1.0) по 0.2.3 — сверено по тегам; прежние пути остаются здесь, даже если адаптер их уберёт
const EVER_COPIED = [
  ".claude.json", ".claude/CLAUDE.md", ".claude/settings.json", ".claude/skills",
  ".codex/config.toml", ".codex/AGENTS.md", ".codex/AGENTS.override.md", ".agents/skills",
  ".config/opencode/opencode.json", ".config/opencode/opencode.jsonc", ".config/opencode/AGENTS.md", ".config/opencode/skills",
  ".gemini/GEMINI.md", ".gemini/config", ".gemini/antigravity-ide/mcp_config.json", ".gemini/antigravity-cli/mcp_config.json",
];
// Каталоги настроек агентов: папка каждого скопированного пути (.claude, .codex, .agents, .config/opencode, .gemini).
// Всё внутри — настройки агента, даже если мастер такой файл не копировал (копия, собранная руками, архив tar)
export const AGENT_DIRS = [...new Set([...EVER_COPIED, ...Object.values(ADAPTERS).flatMap((a) => a.homeConfig ?? [])]
  .map((r) => r.split("/").slice(0, r.startsWith(".config/") ? 2 : 1).join("/")).filter((d) => d !== ".claude.json"))];
const CLAUDE_JSON = ".claude.json";
// Не возвращаются никогда, как и ~/.claude.json: файлы входа и рабочее состояние агентов — то, что агент пишет сам во
// время работы (история, сессии, кэши, служебные номера, логи), а не настройки. Старое затёрло бы нынешний вход, историю
// и сессии. Мастер их не копирует (его пути — EVER_COPIED, ни один сюда не попадает; тест); бывают в копии, собранной
// руками или не мастером (круг 10c-3, М5). Папка — со всем содержимым
const NOT_RESTORED = [
  // вход
  ".claude/.credentials.json", ".claude/.claude.json" /* при CLAUDE_CONFIG_DIR=~/.claude */, ".codex/auth.json",
  ".gemini/oauth_creds.json", ".gemini/google_accounts.json", ".gemini/google_account_id",
  // Claude Code: копии .claude.json, история и сессии по проектам (там же память проектов), задачи, снимки оболочки,
  // история правок, служебное; local — своя установка Claude (старая откатила бы версию)
  ".claude/backups", ".claude/projects", ".claude/todos", ".claude/tasks", ".claude/plans", ".claude/history.jsonl",
  ".claude/shell-snapshots", ".claude/session-env", ".claude/file-history", ".claude/ide", ".claude/statsig",
  ".claude/telemetry", ".claude/debug", ".claude/logs", ".claude/cache", ".claude/paste-cache", ".claude/stats-cache.json",
  ".claude/local", ".claude/downloads",
  // Codex: сессии, история, логи, снимки оболочки, служебные кэши и номера
  ".codex/sessions", ".codex/archived_sessions", ".codex/history.jsonl", ".codex/log", ".codex/logs",
  ".codex/shell_snapshots", ".codex/tmp", ".codex/cache", ".codex/version.json", ".codex/models_cache.json",
  ".codex/internal_storage.json",
  // Antigravity и Gemini CLI: номера установки, чаты и контрольные точки (tmp, history), беседы и память Antigravity
  ".gemini/installation_id", ".gemini/user_id", ".gemini/tmp", ".gemini/history", ".gemini/antigravity/brain",
  ".gemini/antigravity/conversations", ".gemini/antigravity/implicit", ".gemini/antigravity/code_tracker",
  ".gemini/antigravity/annotations", ".gemini/antigravity/browser_recordings", ".gemini/antigravity/playground",
  // opencode: зависимости плагинов (ставит сам; состояние opencode — вне ~/.config/opencode)
  ".config/opencode/node_modules",
];
// Базы и логи в папках агентов (state_5.sqlite Codex и т. п.) — тоже состояние, под любым именем
const STATE_FILE = /\.(log|sqlite|sqlite-wal|sqlite-shm|sqlite-journal|db|db-wal|db-shm)$/i;

const key = (s: string) => (win ? s.toLowerCase() : s);
const under = (rel: string, dir: string) => key(rel) === key(dir) || key(rel).startsWith(key(dir) + "/");
// Без учёта регистра и на macOS (файловая система по умолчанию его не различает: .Credentials.json — тот же файл;
// рецензия 10c-2, М4); лишний пропуск на Linux безопаснее, чем затёртый вход
const notRestored = (rel: string, file: boolean) => {
  const r = rel.toLowerCase();
  return NOT_RESTORED.some((l) => r === l.toLowerCase() || r.startsWith(l.toLowerCase() + "/")) || (file && STATE_FILE.test(r));
};
export const NOT_RESTORED_FOR_TEST = { NOT_RESTORED, EVER_COPIED, notRestored };
// Путь копии внутри каталога агента / папка на пути к нему (.config над .config/opencode)
const agentPath = (rel: string) => AGENT_DIRS.some((d) => under(rel, d));
const onTheWay = (rel: string) => AGENT_DIRS.some((d) => under(d, rel));

export type Item = { rel: string; src: string; link?: { to: string; dir: boolean | null } };
export type Plan = {
  copy: string;
  add: Item[]; // на месте ничего нет
  overwrite: (Item & { was: string })[]; // на месте другое: файл (изменился после установки) или другая ссылка
  same: Item[]; // уже на месте
  blocked: (Item & { why: string })[]; // не вернётся (на месте папка)
  skipped: string[]; // не настройки агентов
  notRestored: string[]; // файлы входа и рабочее состояние агентов: не возвращаются
  claude: ClaudePlan | null; // MCP-серверы Claude из .claude.json копии
};

// MCP-серверы Claude: переносятся только недостающие имена (общие — mcpServers верхнего уровня, проекта —
// projects["<путь>"].mcpServers); то же имя с тем же определением — «уже на месте», с другим — не трогаем, называем.
// Проекта нет в нынешнем файле — запись проекта создаётся только с mcpServers (Claude дополняет остальное сам, как у
// проекта, который он ещё не открывал); нынешнего ~/.claude.json нет или его не прочитать — перенос не идёт
export type ClaudeServer = { project?: string; name: string; liveKey?: string };
export type ClaudePlan = {
  add: (ClaudeServer & { newProject?: boolean })[];
  same: ClaudeServer[];
  clash: ClaudeServer[];
  problem?: string; // перенос не идёт: почему (исправимо — код 1)
  warning?: string; // перенос не идёт, исправлять нечего (копия повреждена) — предупреждение, код по остальному
  data?: { global: Record<string, unknown>; projects: Record<string, Record<string, unknown>> }; // определения из копии
};

// Копии в local/backups: before-miksy-*, по метке (самая ранняя — первая)
export function findCopies(config: string): string[] {
  const root = join(config, "local", "backups");
  let names: string[] = [];
  try { names = readdirSync(root); } catch { return []; }
  return names.filter((n) => /^before-miksy-/.test(n)).filter((n) => { try { return statSync(join(root, n)).isDirectory(); } catch { return false; } })
    .sort().map((n) => slash(join(root, n)));
}

const STAMP = /^(before-miksy-)?(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})$/;

// Какая копия: без аргумента — самая ранняя; метка (с before-miksy- или без) — из local/backups; иначе путь к папке
export function pickCopy(config: string, arg?: string): { copy: string | null; all: string[]; why?: string } {
  const all = findCopies(config);
  if (arg === undefined) return all.length ? { copy: all[0], all } : { copy: null, all, why: "none" };
  const m = arg.match(STAMP);
  if (m) {
    const hit = all.find((c) => c.endsWith(`/before-miksy-${m[2]}`));
    return hit ? { copy: hit, all } : { copy: null, all, why: "stamp" };
  }
  const p = resolve(process.cwd(), arg);
  try { if (statSync(p).isDirectory()) return { copy: slash(p), all }; } catch { /* ниже */ }
  return { copy: null, all, why: "path" };
}

const readTarget = (p: string) => readlinkSync(p).replace(/^\\\\\?\\/, "");
const normLink = (s: string) => key(s.replaceAll("\\", "/").replace(/^\/\/\?\//, "").replace(/\/+$/, ""));
const isLinkAt = (p: string) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

// Что нужно на месте: для ссылки на Windows — цель как её запишет junction (относительная раскрыта от папки ссылки)
function wanted(item: Item, t: string): string {
  const to = item.link!.to;
  return win && item.link!.dir && !win32.isAbsolute(to) ? win32.resolve(dirname(t), to) : to;
}

function sameBytes(a: string, b: string): boolean {
  try { return readFileSync(a).equals(readFileSync(b)); } catch { return false; }
}

export function planRestore(copy: string, home: string): Plan {
  const plan: Plan = { copy, add: [], overwrite: [], same: [], blocked: [], skipped: [], notRestored: [], claude: null };
  const items: Item[] = [];
  // Папку или файл копии не прочитать (права) — «не вернётся» с причиной, остальное — дальше (как прежняя команда)
  const unreadable = "в копии не прочитать: проверьте права на папку копии (откройте её владельцу) и повторите";
  const walk = (dir: string, rel: string) => {
    let names: string[];
    try { names = readdirSync(dir).sort(); }
    catch { if (!rel) throw new Error(`папку копии ${slash(dir)} не прочитать: проверьте права на неё`); plan.blocked.push({ rel: rel + "/", src: dir, why: unreadable }); return; }
    for (const name of names) {
      const src = join(dir, name), r = rel ? `${rel}/${name}` : name;
      let st: ReturnType<typeof lstatSync>;
      try { st = lstatSync(src); } catch { plan.blocked.push({ rel: r, src, why: unreadable }); continue; }
      if (!rel && name === CLAUDE_JSON) { plan.claude = claudePlan(src, join(home, CLAUDE_JSON)); continue; }
      const isDir = st.isDirectory() && !st.isSymbolicLink();
      if (agentPath(r) && notRestored(r, !isDir)) { plan.notRestored.push(isDir ? r + "/" : r); continue; }
      if (st.isDirectory() && !st.isSymbolicLink()) {
        if (agentPath(r) || onTheWay(r)) walk(src, r);
        else plan.skipped.push(r + "/");
        continue;
      }
      if (!agentPath(r)) { plan.skipped.push(r); continue; }
      if (st.isSymbolicLink()) {
        let to: string;
        try { to = readTarget(src); } catch { plan.blocked.push({ rel: r, src, why: "ссылку в копии не прочитать" }); continue; }
        items.push({ rel: r, src, link: { to, dir: null } });
      } else if (st.isFile()) items.push({ rel: r, src });
    }
  };
  walk(copy, "");
  // Вид ссылок на Windows (папка или файл; у битой — через PowerShell, один запуск на копию)
  resetLinkKinds();
  const links = items.filter((i) => i.link);
  for (const i of links) i.link!.dir = win ? linkIsDir(i.src, links) : null;

  for (const item of items) {
    const t = join(home, item.rel);
    let here: ReturnType<typeof lstatSync> | null = null;
    try { here = lstatSync(t); } catch { /* нет */ }
    let dirHere = false;
    try { dirHere = statSync(t).isDirectory(); } catch { /* нет или битая ссылка */ }
    if (item.link) {
      if (here?.isSymbolicLink()) {
        let now = "";
        try { now = readTarget(t); } catch { /* ниже — «другая» */ }
        // Windows: относительная цель ссылки на месте — от её папки, как у той, что поставит restore (рецензия 10c-2, М6)
        const nowAbs = win && now && !win32.isAbsolute(now) ? win32.resolve(dirname(t), now) : now;
        if (normLink(now) === normLink(wanted(item, t)) || normLink(nowAbs) === normLink(wanted(item, t)) || normLink(now) === normLink(item.link.to)) plan.same.push(item);
        else plan.overwrite.push({ ...item, was: `ссылка → ${slash(now)}` });
      } else if (here?.isDirectory()) plan.blocked.push({ ...item, why: "на этом месте папка" });
      else if (here) plan.overwrite.push({ ...item, was: "файл" });
      else plan.add.push(item);
    } else {
      if (dirHere) plan.blocked.push({ ...item, why: "на этом месте папка" });
      else if (!here) plan.add.push(item);
      else if (here.isSymbolicLink() && !existsSync(t)) plan.add.push(item); // битая ссылка пользователя: файл появится по ней
      else if (sameBytes(t, item.src)) plan.same.push(item);
      else plan.overwrite.push({ ...item, was: "файл" });
    }
  }
  return plan;
}

type ClaudeDoc = { mcpServers?: Record<string, unknown>; projects?: Record<string, { mcpServers?: Record<string, unknown> } & Record<string, unknown>> } & Record<string, unknown>;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const readDoc = (path: string): ClaudeDoc => {
  const j = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
  if (!isObj(j)) throw new Error("не объект JSON");
  return j as ClaudeDoc;
};
const sameDef = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
// Своё свойство с любым именем (и __proto__: обычное присваивание его не создаёт; повторная проверка 10c-2)
const own = (o: Record<string, unknown>, k: string, v: unknown) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });

// Что перенести из .claude.json копии в нынешний (значения в вывод не идут: в env и заголовках бывают токены)
export function claudePlan(copyJson: string, liveJson: string): ClaudePlan {
  const plan: ClaudePlan = { add: [], same: [], clash: [] };
  let copy: ClaudeDoc;
  // Копия повреждена — исправлять нечего: предупреждение, не ошибка (рецензия 10c-2, С4); текст разбора в вывод не идёт:
  // в нём кусок файла (М3)
  try { copy = readDoc(copyJson); }
  catch (e) {
    // Повреждён (не JSON) — исправлять нечего: предупреждение; не прочитать (права, папка) — исправимо: код 1
    if (e instanceof SyntaxError || (e as Error).message === "не объект JSON")
      return { ...plan, warning: "серверы Claude из копии не прочитать — файл копии .claude.json повреждён; нужны — добавьте их Claude заново (claude mcp add)" };
    return { ...plan, problem: "файл копии .claude.json не прочитать (нет доступа или это не файл) — проверьте права на него и повторите miksy restore" };
  }
  const global = isObj(copy.mcpServers) ? copy.mcpServers : {};
  const projects: Record<string, Record<string, unknown>> = {};
  for (const [p, v] of Object.entries(isObj(copy.projects) ? copy.projects : {}))
    if (isObj(v) && isObj(v.mcpServers) && Object.keys(v.mcpServers).length) projects[p] = v.mcpServers;
  plan.data = { global, projects };
  if (!Object.keys(global).length && !Object.keys(projects).length) return plan;
  if (!existsSync(liveJson)) return { ...plan, problem: "~/.claude.json нет: запустите Claude один раз, закройте его и повторите miksy restore" };
  let live: ClaudeDoc;
  try { live = readDoc(liveJson); } catch { return { ...plan, problem: "~/.claude.json не прочитать (испорчен или занят): закройте Claude и повторите miksy restore" }; }
  const sort = (here: Record<string, unknown> | undefined, from: Record<string, unknown>, project?: string, liveKey?: string, newProject?: boolean) => {
    for (const [name, def] of Object.entries(from)) {
      const s: ClaudeServer = { ...(project !== undefined && { project, liveKey }), name };
      // Object.hasOwn: имена вроде constructor не путаются со свойствами объекта (рецензия 10c-2, М1)
      if (!here || !Object.hasOwn(here, name)) plan.add.push({ ...s, ...(newProject && { newProject }) });
      else (sameDef(here[name], def) ? plan.same : plan.clash).push(s);
    }
  };
  sort(isObj(live.mcpServers) ? live.mcpServers : undefined, global);
  const liveProjects = isObj(live.projects) ? live.projects : {};
  // Ключ проекта в нынешнем файле: тот же путь; на Windows — без учёта регистра и вида косых (C:/Users/X = c:\users\x)
  const norm = (k: string) => (win ? k.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase() : k);
  for (const [p, servers] of Object.entries(projects)) {
    const lk = Object.hasOwn(liveProjects, p) ? p : Object.keys(liveProjects).find((k) => norm(k) === norm(p)) ?? p;
    const lp = liveProjects[lk];
    sort(isObj(lp) && isObj(lp.mcpServers) ? lp.mcpServers : undefined, servers, p, lk, !isObj(lp));
  }
  return plan;
}

// Дописать недостающие серверы в ~/.claude.json: перечитать файл перед записью (Claude мог его переписать), только
// недостающие имена, остальное — как было; запись — как у sync (JSON с отступом 2, атомарно, сквозь ссылку)
export function applyClaude(plan: ClaudePlan, liveJson: string, save: (path: string) => void): { added: ClaudeServer[]; error?: string } {
  if (!plan.add.length || !plan.data) return { added: [] };
  try {
    const text = readFileSync(liveJson, "utf8");
    const doc = readDoc(liveJson);
    const added: ClaudeServer[] = [];
    for (const s of plan.add) {
      const from = s.project === undefined ? plan.data.global : plan.data.projects[s.project];
      let holder: Record<string, unknown>;
      if (s.project === undefined) holder = doc;
      else {
        if (!isObj(doc.projects)) doc.projects = {};
        const ps = doc.projects as Record<string, Record<string, unknown>>;
        const k = s.liveKey ?? s.project;
        if (!isObj(ps[k])) own(ps, k, {});
        holder = ps[k];
      }
      if (!isObj(holder.mcpServers)) holder.mcpServers = {};
      const servers = holder.mcpServers as Record<string, unknown>;
      if (Object.hasOwn(servers, s.name)) continue; // появился между планом и записью — не трогаем
      own(servers, s.name, from[s.name]);
      added.push(s);
    }
    if (!added.length) return { added };
    // Бэкап не вышел — файл не трогаем; причину (в ней нет содержимого файла) — в вывод
    try { save(liveJson); } catch (e) { return { added: [], error: `~/.claude.json не сохранить в бэкап — файл не тронут (${(e as Error).message})` }; }
    writeAtomic(liveJson, JSON.stringify(doc, null, 2) + (text.endsWith("\n") ? "\n" : ""), { sensitive: true });
    return { added };
  } catch (e) {
    // Ошибка разбора — без текста: в нём кусок файла, а там вход и токены (рецензия 10c-2, М3); ошибки файловой системы —
    // по коду, без содержимого
    const code = (e as NodeJS.ErrnoException)?.code;
    const why = e instanceof SyntaxError || (e as Error).message === "не объект JSON"
      ? "не прочитать (повреждён или изменился во время работы): закройте Claude и повторите miksy restore"
      : code === "EBUSY" || code === "EPERM" || code === "EACCES" ? "занят или нет доступа: закройте Claude и повторите miksy restore"
      : `не записан (${code ?? "ошибка записи"}): закройте Claude и повторите miksy restore`;
    return { added: [], error: `~/.claude.json ${why}` };
  }
}

// Путь в одинарных кавычках оболочки пользователя: PowerShell удваивает ' и ‘ ’ ‚ ‛ ($ и ` в них буквальны), sh — '\''
// (как closeCommand; рецензия 10c-2, С1)
export const quotePath = (p: string, windows = win) => windows
  ? `'${p.replaceAll("/", "\\").replace(/['‘’‚‛]/g, "$&$&")}'`
  : `'${p.replaceAll("'", "'\\''")}'`;
export const readOnlyHint = (t: string, windows = win) => `файл «только для чтения»: снимите пометку — ${windows ? "attrib -r" : "chmod u+w"} ${quotePath(t, windows)}`;

// Причина ошибки — простыми словами и что сделать
export function reason(e: unknown, item: Item, t: string): string {
  const code = (e as NodeJS.ErrnoException)?.code ?? "";
  if (code === "COPY") return "в копии не прочитать: проверьте права на файл копии";
  if (code === "BACKUP") return `нынешний файл не удалось сохранить в бэкап — файл не тронут (${(e as Error).message.replace(/^бэкап не записан: /, "")})`;
  if (code === "MIKSYNEW") return (e as Error).message;
  if (code === "EISDIR") return "на этом месте папка: посмотрите, что в ней; не нужна — удалите или переименуйте её";
  if (code === "EBUSY") return "файл занят: закройте агентов и редакторы";
  // «Только для чтения»: файл пишется сквозь ссылку пользователя — пометка у её цели (её и назвать); ссылку из копии
  // restore ставит вместо того, что на месте, — пометка у самого файла на месте, не у цели ссылки
  let readOnly = false, at = t;
  try {
    if (!item.link) { at = realpathSync(t); readOnly = !(statSync(at).mode & 0o200); }
    else readOnly = !isLinkAt(t) && !(statSync(t).mode & 0o200);
  } catch { /* нет */ }
  if (readOnly) return readOnlyHint(slash(at));
  // Ссылку (на файл или — когда junction не вышел — на папку) Windows не дала создать (рецензия 10c-2, М7)
  if (item.link && win && item.link.dir !== null && (code === "EPERM" || code === "EACCES"))
    return `Windows не дала создать ссылку${item.link.dir ? " на папку" : " на файл"}: включите режим разработчика (Параметры → Система → Для разработчиков) или запустите miksy restore в PowerShell от имени администратора`;
  if (code === "EPERM" || code === "EACCES") return win ? "нет доступа или файл занят: закройте агентов и редакторы" : "нет доступа: проверьте права на файл и папку";
  if (code === "ENOTDIR") return "на пути к файлу — файл вместо папки: посмотрите, что это за файл; не нужен — удалите или переименуйте его";
  if (code === "EEXIST") return `рядом лежит ${slash(t)}.miksy-new (не ссылка) — посмотрите, что в нём; не нужен — удалите`;
  if (code === "ENOENT") return "на месте или на пути к файлу — ссылка, которая ведёт в несуществующую папку: исправьте или удалите эту ссылку";
  return (e as Error)?.message ?? String(e);
}

// Записать в файл на месте: r+ и усечение — сквозь ссылку пользователя, права и скрытый атрибут остаются
function writeInPlace(t: string, data: Buffer) {
  let fd: number;
  try { fd = openSync(t, "r+"); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    fd = openSync(t, "w", 0o600);
  }
  try {
    ftruncateSync(fd, 0);
    for (let off = 0; off < data.length;) off += writeSync(fd, data, off, data.length - off, off);
  } finally { closeSync(fd); }
}

// Убрать ссылку (не то, куда она ведёт); не ссылка — ничего
function dropLink(p: string) {
  if (!isLinkAt(p)) return;
  try { unlinkSync(p); } catch (e) { if (win) rmdirSync(p); else throw e; }
}

function makeLink(item: Item, t: string, at: string) {
  const to = wanted(item, t);
  if (!win) return symlinkSync(item.link!.to, at);
  const dir = item.link!.dir;
  if (dir === null) return symlinkSync(item.link!.to, at);
  if (!dir) return symlinkSync(item.link!.to, at, "file");
  if (!/^[\\/]{2}/.test(to)) { try { return symlinkSync(to, at, "junction"); } catch { /* ниже — символическая */ } }
  symlinkSync(item.link!.to, at, "dir");
}

// replacedLinks — ссылки пользователя, которые restore заменил: в бэкап они не сохраняются (только куда вели) — ссылка в
// local/backups прошла бы через проверки прав local/ и шаги отката docs/update.md, рассчитанные только на before-miksy-*
// (рецензия 10c-2, С2: выбран честный вывод, а не хранение ссылкой)
export type Result = { done: string[]; failed: { rel: string; why: string }[]; replacedLinks: { rel: string; to: string }[] };
// Файловые операции, которые тест подменяет (неудачное переименование на Windows — рецензия 10c-2, С3)
export type Ops = { rename: (from: string, to: string) => void };

// Вернуть по плану; save(t) — бэкап затираемого файла до записи (путь копии или undefined)
export function applyRestore(plan: Plan, home: string, save: (path: string) => string | void, ops: Ops = { rename: renameSync }): Result {
  const res: Result = { done: [], replacedLinks: [], failed: plan.blocked.map((b) => ({ rel: b.rel, why: b.why === "на этом месте папка" ? "на этом месте папка: посмотрите, что в ней; не нужна — удалите или переименуйте её" : b.why })) };
  for (const item of [...plan.add, ...plan.overwrite]) {
    const t = join(home, item.rel);
    try {
      // Файл копии — прочитать до всего остального: не прочитать — на месте ничего не трогаем
      let data: Buffer | null = null;
      if (!item.link) try { data = readFileSync(item.src); } catch { throw Object.assign(new Error("копия"), { code: "COPY" }); }
      mkdirSync(dirname(t), { recursive: true });
      // Затираемый файл (и файл за ссылкой пользователя) — в бэкап до записи; бэкап не вышел — файл не трогаем
      let isFile = false, saved: string | void = undefined;
      try { isFile = statSync(t).isFile(); } catch { /* нет */ }
      if (isFile && (!item.link || !isLinkAt(t))) {
        try { saved = save(t); } catch (e) { throw Object.assign(new Error(`бэкап не записан: ${(e as Error).message}`), { code: (e as NodeJS.ErrnoException).code === "EBUSY" ? "EBUSY" : "BACKUP" }); }
      }
      if (!item.link) {
        try { if (statSync(t).isDirectory()) throw Object.assign(new Error("папка"), { code: "EISDIR" }); } catch (e) { if ((e as NodeJS.ErrnoException).code === "EISDIR") throw e; }
        writeInPlace(t, data!);
      } else {
        const here = (() => { try { lstatSync(t); return true; } catch { return false; } })();
        if (here && !isLinkAt(t) && lstatSync(t).isDirectory()) throw Object.assign(new Error("папка"), { code: "EISDIR" });
        // Прежняя ссылка на месте: куда вела и папка ли — чтобы назвать её и при неудаче поставить обратно
        let old: { to: string; dir: boolean } | null = null;
        // Вид битой ссылки (папка или файл) — как у копии: linkIsDir (у битой junction stat не работает)
        if (isLinkAt(t)) { try { old = { to: readTarget(t), dir: (() => { try { return statSync(t).isDirectory(); } catch { resetLinkKinds(); return !!linkIsDir(t, [{ src: t }]); } })() }; } catch { /* не прочитать */ } }
        const n = here ? `${t}.miksy-new` : t;
        dropLink(`${t}.miksy-new`);
        try { makeLink(item, t, n); }
        catch (e) { if (here) try { dropLink(n); } catch { /* остаток уберёт следующий запуск */ } throw e; }
        if (here) {
          let removed = false;
          try {
            // POSIX: rename ставит ссылку на место файла или ссылки атомарно; Windows: прежнее убрать, затем переименовать
            if (win) { if (isLinkAt(t)) dropLink(t); else unlinkSync(t); removed = true; }
            ops.rename(n, t);
          } catch (e) {
            if (!removed) { try { dropLink(n); } catch { /* как выше */ } throw e; }
            // Прежнее уже убрано, новое не встало (антивирус, индексатор держат ссылку): вернуть прежнее; не вышло —
            // сказать про остаток <имя>.miksy-new (рецензия 10c-2, С3)
            let back = false;
            try {
              if (old) symlinkSync(old.dir && win && !win32.isAbsolute(old.to) ? win32.resolve(dirname(t), old.to) : old.to, t, old.dir ? "junction" : "file");
              else if (saved) copyFileSync(saved, t);
              back = !!old || !!saved;
            } catch { back = false; }
            const code = (e as NodeJS.ErrnoException)?.code ?? "ошибка";
            const name = t.slice(Math.max(t.lastIndexOf("/"), t.lastIndexOf("\\")) + 1);
            if (back) {
              try { dropLink(n); } catch { /* остаток уберёт следующий запуск */ }
              throw Object.assign(new Error(`новую ссылку не удалось поставить на место (${code}) — прежн${old ? "яя ссылка возвращена" : "ий файл возвращён"}; закройте агентов и редакторы и повторите miksy restore`), { code: "MIKSYNEW" });
            }
            throw Object.assign(new Error(`на месте пусто: новая ссылка не встала (${code}) и осталась рядом как ~/${item.rel}.miksy-new — переименуйте её в ${name} (PowerShell: Rename-Item -LiteralPath ${quotePath(slash(n))} ${quotePath(name)}) или повторите miksy restore${saved ? `; прежний файл — в бэкапе ${slash(saved)}` : old ? `; прежняя ссылка вела на ${slash(old.to)}` : ""}`), { code: "MIKSYNEW" });
          }
          if (old) res.replacedLinks.push({ rel: item.rel, to: slash(old.to) });
        }
      }
      res.done.push(item.rel);
    } catch (e) { res.failed.push({ rel: item.rel, why: reason(e, item, t) }); }
  }
  return res;
}

// Учёт miksy. Домашние цели (sync --global любого агента) — отказ: копия легла бы под файлы miksy, и clean убрал бы её как
// свою. Цели проектов в домашние файлы не пишут, кроме Claude: его серверы проектов — в ~/.claude.json
// (projects["<путь>"].mcpServers) — их перенос ждёт clean --all (рецензия 10c, №1); остальное копии не мешает
export function ledgerBlock(manifest: Manifest): { home: string[]; projects: number; claudeProjects: number } {
  const ids = Object.keys(manifest.targets);
  const agentOf = (id: string) => agentId(id.slice(0, id.indexOf("|")));
  const home = [...new Set(ids.filter((id) => id.endsWith("|global")).map(agentOf))].sort();
  const projects = ids.filter((id) => !id.endsWith("|global"));
  return { home, projects: projects.length, claudeProjects: projects.filter((id) => agentOf(id) === "claude").length };
}

const tilde = (rel: string) => `~/${rel}`;
const where = (s: ClaudeServer) => (s.project === undefined ? s.name : `${s.name} (проект ${slash(s.project)})`);
const stampOf = (c: string) => c.slice(c.lastIndexOf("/before-miksy-") + "/before-miksy-".length);

// Затираемое — точной копией (без замены секретов заглушками, вне ротации запусков) в
// local/backups/before-restore-<метка>/, пути от ~ — как в копии «до miksy»: её можно вернуть той же командой
function exactSaver(config: string, home: string) {
  let dir: string | null = null;
  const save = (p: string) => {
    if (!dir) {
      // Своя новая папка на каждый запуск: два запуска в одну секунду (или возврат из прежней before-restore) не пишут
      // в одну папку и не затирают копию, из которой идёт возврат (повторная проверка 10c, №1)
      const base = join(config, "local", "backups", `before-restore-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
      let d = base;
      for (let i = 2; existsSync(d); i++) d = `${base}-${i}`;
      refuseBackupPath(join(d, "x"), config);
      mkdirSync(join(config, "local", "backups"), { recursive: true, mode: 0o700 });
      mkdirSync(d, { mode: 0o700 }); // не recursive: уже есть — ошибка, а не запись поверх
      if (behindLink(d, config)) closeOwn(d, true);
      // Точные копии (секреты, вход Claude) — под закрытым local/, как у sync и мастера
      ensurePrivateLocal(join(config, "local"));
      dir = d;
    }
    const dst = join(dir, relative(home, p));
    mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
    copyFileSync(p, dst);
    if (!win) chmodSync(dst, 0o600);
    return dst;
  };
  return { save, dir: () => (dir ? slash(dir) : null) };
}

// miksy restore [<копия>] [--dry-run] [--yes]: код 0 — всё на месте; 1 — не вернулось хоть что-то, отказ, копии нет.
// --dry-run — тот же код, что дал бы запуск (по плану)
export function runRestore(arg: string | undefined, flags: Record<string, string>, ask: Ask | null, log = console.log): number {
  const config = configRoot();
  const home = homeDir();
  const dry = "dry-run" in flags;
  const picked = pickCopy(config, arg);
  const backups = slash(join(config, "local", "backups"));
  if (!picked.copy) {
    const others = picked.all.length ? `\nКопии на этой машине: ${picked.all.map(stampOf).join(", ")} — miksy restore <метка>.` : "";
    if (picked.why === "none") log(`Копии «до miksy» нет (в ${backups}/ нет папок before-miksy-…): мастер установки её не делал —\nна вопрос «Копия настроек агентов» ответили «нет», ставили без вопросов (setup --yes без --backup) или miksy уже\nзаписывал настройки до мастера. Вернуть прежнее можно архивом из «Установки вручную», если вы его делали\n(docs/uninstall.md, шаг 3).`);
    else if (picked.why === "stamp") log(`Копии с меткой ${arg} нет в ${backups}/.${others}`);
    else log(`Копии нет: ${slash(resolve(process.cwd(), arg!))} — такой папки нет.${others || " Копии в local/backups ищет miksy restore без аргумента."}`);
    return 1;
  }
  const ledger = ledgerBlock(loadManifest());
  if (ledger.home.length) {
    let agents: string[] | undefined;
    try { agents = loadMachine(config).agents?.map(agentId); } catch { /* machine.yaml нет — все агенты */ }
    const extra = agents ? ledger.home.filter((a) => !agents!.includes(a)) : [];
    log(`miksy ещё записан в домашние настройки агентов (${ledger.home.join(", ")}): копия легла бы под его файлы, и следующий\nmiksy clean убрал бы её как свою. Сначала уберите записанное miksy:`);
    if (extra.length < ledger.home.length) log("  miksy clean --global");
    for (const a of extra) log(`  miksy clean --global --agent ${a}`);
    log("Если clean назвал конфликты (файлы, которые правили руками), посмотрите их; убрать и их — та же команда с --force\n(с бэкапом). Затем снова miksy restore. Ничего не записано.");
    return 1;
  }

  const plan = planRestore(picked.copy, home);
  const c = plan.claude;
  // Серверы проектов Claude, записанные miksy, ещё в ~/.claude.json: перенос — после clean --all
  // Общие серверы переносятся, серверов проектов не касаемся (рядом могут быть серверы miksy — не «ваши»)
  let later: ClaudeServer[] = [];
  if (c && ledger.claudeProjects && !c.problem) {
    later = [...c.add, ...c.clash, ...c.same].filter((s) => s.project !== undefined);
    c.add = c.add.filter((s) => s.project === undefined);
    c.clash = c.clash.filter((s) => s.project === undefined);
    c.same = c.same.filter((s) => s.project === undefined);
  }
  log(`Копия «до miksy»: ${picked.copy}`);
  if (arg === undefined && picked.all.length > 1)
    log(`  (копий ${picked.all.length}; взята самая ранняя; другая — miksy restore ${picked.all.slice(1).map(stampOf).join(" или ")})`);
  if (ledger.projects) log("  В проектах ещё записано то, что добавил miksy. Если удаляете его совсем — сначала miksy clean --all.");
  const linkNote = (i: Item) => (i.link ? ` → ${slash(i.link.to)} (ссылка)` : "");
  log("");
  if (plan.add.length) log(`Вернётся (нет на месте, ${plan.add.length}):\n${plan.add.map((i) => `  ${tilde(i.rel)}${linkNote(i)}`).join("\n")}`);
  // «После установки» — только про копию мастера; другая папка (before-restore, архив) — просто «отличается» (10c-2, М8)
  const why = /^before-miksy-/i.test(picked.copy.slice(picked.copy.lastIndexOf("/") + 1)) ? "изменилось после установки" : "отличается от копии";
  const links = plan.overwrite.some((i) => i.was.startsWith("ссылка")) ? " (ссылка не сохраняется — только куда вела, в итоге)" : "";
  if (plan.overwrite.length) log(`Затрёт — ${why}; нынешние файлы сохранятся в бэкап${links} (${plan.overwrite.length}):\n${plan.overwrite.map((i) => `  ${tilde(i.rel)}${linkNote(i)}${i.was === "файл" ? "" : ` (сейчас ${i.was})`}`).join("\n")}`);
  if (plan.blocked.length) log(`Не вернётся (${plan.blocked.length}):\n${plan.blocked.map((i) => `  ${tilde(i.rel)} — ${i.why}`).join("\n")}`);
  if (plan.same.length) log(`Уже на месте: ${files(plan.same.length)}.`);
  if (plan.notRestored.length) log(`Не возвращается — файлы входа и рабочее состояние агентов (история, сессии; старое затёрло бы нынешнее): ${plan.notRestored.join(", ")}`);
  if (plan.skipped.length) log(`Пропущено — не настройки агентов (${plan.skipped.length}): ${plan.skipped.join(", ")}`);
  if (c && (c.add.length || c.clash.length || c.same.length || c.problem || c.warning || later.length)) {
    log("\n~/.claude.json целиком не возвращается: в нём Claude хранит вход и список проектов.");
    if (c.add.length && !c.problem) log(`  Допишу MCP-серверы Claude из копии (${c.add.length}): ${c.add.map((s) => where(s) + (s.newProject ? " — проекта нет в списке Claude, запись проекта появится" : "")).join(", ")}`);
    if (c.clash.length) log(`  Не трогаю — на месте сервер с тем же именем, но другой (${c.clash.length}): ${c.clash.map(where).join(", ")}`);
    if (c.same.length) log(`  Уже на месте: ${c.same.map(where).join(", ")}`);
    if (c.problem) log(`  MCP-серверы Claude не перенесу: ${c.problem}.`);
    if (c.warning) log(`  Предупреждение: ${c.warning}. Остальное это не задерживает.`);
    if (later.length) log(`  Серверы проектов Claude перенесу после miksy clean --all (в ~/.claude.json ещё серверы проектов, записанные miksy): ${later.map(where).join(", ")}`);
  }
  const work = plan.add.length + plan.overwrite.length + (c && !c.problem ? c.add.length : 0);
  const known = plan.blocked.length > 0 || !!c?.problem || later.length > 0; // не всё вернётся — уже по плану
  if (!work) {
    if (known) log("\nИсправьте то, что названо выше, и запустите miksy restore ещё раз — повторять безопасно. Ничего не записано.");
    else log(`\nВсё из копии уже на месте${c?.clash.length ? " (кроме серверов Claude с тем же именем — они ваши)" : ""}${c?.warning ? " (кроме серверов Claude — см. предупреждение)" : ""}. Ничего не записано.`);
    return known ? 1 : 0;
  }
  if (dry) { log("\n--dry-run: ничего не записано."); return known ? 1 : 0; }
  log("\nЗакройте агентов (Claude Code, Codex, opencode, Antigravity) и редакторы: открытая сессия может записать свои\nнастройки поверх.");
  if (!("yes" in flags)) {
    if (!ask) throw new UsageError("miksy restore затирает файлы — без терминала только после явного «да» пользователя: miksy restore --yes (план — --dry-run)");
    if (!ask.yes("Вернуть?", false)) throw new Cancelled();
  }
  const saver = exactSaver(config, home);
  const res = applyRestore(plan, home, saver.save);
  const cl = c && !c.problem ? applyClaude(c, join(home, CLAUDE_JSON), saver.save) : { added: [] as ClaudeServer[] };
  log("");
  if (res.done.length) log(`✓ вернулось: ${files(res.done.length)}`);
  if (cl.added.length) log(`✓ MCP-серверы Claude дописаны в ~/.claude.json: ${cl.added.map(where).join(", ")}`);
  if (saver.dir()) log(`  прежние версии затёртых файлов — в ${saver.dir()}/`);
  if (res.replacedLinks.length) log(`  заменённые ссылки (в бэкап не сохраняются) вели на: ${res.replacedLinks.map((l) => `${tilde(l.rel)} → ${l.to}`).join(", ")}`);
  for (const f of res.failed) log(`не возвращён: ${tilde(f.rel)} — ${f.why}`);
  if ("error" in cl && cl.error) log(`не перенесены MCP-серверы Claude — ${cl.error}`);
  const bad = res.failed.length > 0 || !!("error" in cl && cl.error) || !!c?.problem || later.length > 0;
  if (bad) log("Исправьте то, что названо выше, и запустите miksy restore ещё раз — повторять безопасно.");
  return bad ? 1 : 0;
}
