// Возврат копии «до miksy» в ~/.claude.json (src/adapter.ts: RestoreHome; ядро — src/restore.ts): файл целиком не
// возвращается (в нём вход и список проектов), дописываются недостающие MCP-серверы Claude. Перенесено из src/restore.ts
// дословно (круг 10x-2)
import { existsSync, readFileSync } from "node:fs";
import type { RestoreHome } from "../../src/adapter";
import { writeAtomic } from "../../src/manifest";
import { slash } from "../../src/paths";

const win = process.platform === "win32";

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


const where = (s: ClaudeServer) => (s.project === undefined ? s.name : `${s.name} (проект ${slash(s.project)})`);

export const claudeRestoreHome: RestoreHome = {
  file: ".claude.json",
  plan: claudePlan,
  apply: (m, live, save) => applyClaude(m as ClaudePlan, live, save),
  describe: (m, later) => {
    const out = ["\n~/.claude.json целиком не возвращается: в нём Claude хранит вход и список проектов."];
    if (m.add.length && !m.problem) out.push(`  Допишу MCP-серверы Claude из копии (${m.add.length}): ${m.add.map((s) => where(s) + (s.newProject ? " — проекта нет в списке Claude, запись проекта появится" : "")).join(", ")}`);
    if (m.clash.length) out.push(`  Не трогаю — на месте сервер с тем же именем, но другой (${m.clash.length}): ${m.clash.map(where).join(", ")}`);
    if (m.same.length) out.push(`  Уже на месте: ${m.same.map(where).join(", ")}`);
    if (m.problem) out.push(`  MCP-серверы Claude не перенесу: ${m.problem}.`);
    if (m.warning) out.push(`  Предупреждение: ${m.warning}. Остальное это не задерживает.`);
    if (later.length) out.push(`  Серверы проектов Claude перенесу после miksy clean --all (в ~/.claude.json ещё серверы проектов, записанные miksy): ${later.map(where).join(", ")}`);
    return out;
  },
  doneNote: (m) => `${m.clash.length ? " (кроме серверов Claude с тем же именем — они ваши)" : ""}${m.warning ? " (кроме серверов Claude — см. предупреждение)" : ""}`,
  added: (items) => `✓ MCP-серверы Claude дописаны в ~/.claude.json: ${items.map(where).join(", ")}`,
  failed: (error) => `не перенесены MCP-серверы Claude — ${error}`,
};
