import type { Machine, McpServer, Os, Resolved } from "./types";

const REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

// Ссылка на секрет в определении MCP после подстановки ядра. Значение секрета ядро адаптеру не
// передаёт: адаптер доставляет его штатным механизмом агента (обёртка, helper, {file:}, мост —
// src/launch.ts). Метка не может прийти из слоя (NUL) и не содержит значения: если адаптер
// оставит её в файле, ядро откажет в записи (registry.ts), а не подставит значение.
export const SECRET_MARK = "\u0000miksy-secret:";
export const secretRef = (name: string) => `${SECRET_MARK}${name}\u0000`;
const MARK_RX = /\u0000miksy-secret:([A-Za-z_][A-Za-z0-9_]*)\u0000/g;

// Части строки: текст и ссылки на секреты по порядку
export type Part = string | { secret: string };
export function parts(s: string): Part[] {
  const out: Part[] = [];
  let at = 0;
  for (const m of s.matchAll(MARK_RX)) {
    if (m.index! > at) out.push(s.slice(at, m.index));
    out.push({ secret: m[1] });
    at = m.index! + m[0].length;
  }
  if (at < s.length || !out.length) out.push(s.slice(at));
  return out;
}
export const refsIn = (s: string | undefined): string[] => (s ? [...s.matchAll(MARK_RX)].map((m) => m[1]) : []);
// Строка целиком — одна ссылка (env: GITLAB_TOKEN: ${TOKEN})
export const wholeRef = (s: string): string | null => {
  const p = parts(s);
  return p.length === 1 && typeof p[0] !== "string" ? p[0].secret : null;
};
// Все секреты сервера (command, args, env, headers, url)
export function serverSecrets(s: McpServer): string[] {
  const all = [s.command, s.url, ...(s.args ?? []), ...Object.values(s.env ?? {}), ...Object.values(s.headers ?? {})].flatMap(refsIn);
  return [...new Set(all)];
}

export interface SkippedMcp {
  name: string;
  vars: string[]; // каких переменных не хватило
  why?: string; // иная причина: значение секрета нельзя доставить (многострочное, недопустимые символы)
  item: McpServer; // определение со ссылками — адаптеру для решения о keep
}

// Как агент доставляет секрет заголовка HTTP-сервера (объявляет адаптер): helper заголовков (Claude,
// Codex), {file:} (opencode), мост (Antigravity). Секрет в URL — мост у всех
export type HttpDelivery = "helper" | "file" | "bridge";

// Переменные окружения, которые обёртка моста сбрасывает (если слой не задал их в env сервера): прокси
// и TLS увели бы запрос с секретными заголовками через чужой прокси или открыли MITM; BUN_OPTIONS
// добавил бы --preload, BUN_CONFIG_VERBOSE_FETCH печатает заголовки запроса, NODE_OPTIONS — то же для Node.
// Из env HTTP-сервера мосту передаются только они: удалённому серверу env не нужен
export const BRIDGE_RESET = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "BUN_OPTIONS", "BUN_CONFIG_VERBOSE_FETCH", "NODE_OPTIONS"];
export const bridgeEnv = (key: string) => BRIDGE_RESET.some((r) => r.toLowerCase() === key.toLowerCase());

// Способ доставки сервера: stdio — обёртка; HTTP — мост, если секрет в URL, иначе способ агента
export type Delivery = "stdio" | HttpDelivery;

// Ограничения значения секрета по месту в определении и способу доставки (выбран до проверки).
// Значение известно только ядру; доставка его не видит, поэтому проверка — здесь. Общее: файл
// секрета хранит одну строку (без перевода строки и NUL). Обёртка .cmd (Windows: stdio и env моста)
// читает файл через set /p (не длиннее 1023 байт) и подставляет %VAR% внутри кавычек, где " ломает
// разбор; helper заголовков печатает JSON без экранирования значения (" и \ нельзя, только ASCII) и
// на Windows тоже читает set /p. Мост и {file:} читают файл сами — им достаточно одной строки
function valueProblem(name: string, value: string, where: "env" | "env-part" | "arg" | "header" | "url", os: Os, how: Delivery, key = ""): string | null {
  if (/[\r\n\u0000]/.test(value)) return `многострочное значение секрета ${name} (или NUL) — файл секрета хранит одну строку`;
  if (how !== "stdio" && (where === "env" || where === "env-part") && (how !== "bridge" || !bridgeEnv(key)))
    return `секрет ${name} в env HTTP-сервера (${key}) не доставляется: удалённому серверу переменные окружения не передаются${how === "bridge" ? " (мосту — только прокси/TLS)" : ""} — перенесите его в headers`;
  // set /p в .cmd: stdio-обёртка, env моста, helper заголовков
  const viaCmd = os === "windows" && (how === "stdio" || (how === "bridge" && where !== "url" && where !== "header") || (how === "helper" && where === "header"));
  if (viaCmd && Buffer.byteLength(value) > 1023)
    return `значение секрета ${name} длиннее 1023 байт — .cmd-${how === "helper" ? "helper" : "обёртка"} Windows (set /p) его не прочитает`;
  if (how === "helper" && where === "header" && /["\\]/.test(value))
    return `значение секрета ${name} в заголовке содержит " или \\ — helper заголовков их не экранирует`;
  if (how === "helper" && where === "header" && /[^\x20-\x7e]/.test(value))
    return `значение секрета ${name} в заголовке — не ASCII: helper печатает значение HTTP-заголовка — только печатные ASCII`;
  if (viaCmd && (where === "arg" || where === "env-part") && value.includes('"'))
    return `значение секрета ${name} содержит " — в аргументах и составных переменных .cmd-обёртки Windows не передаётся`;
  if (viaCmd && where === "arg" && value.endsWith("\\"))
    return `значение секрета ${name} в аргументе заканчивается на \\ — .cmd-обёртка Windows передала бы его искажённым`;
  return null;
}

// Подставляет ${VAR} в определения MCP (command, args, url, env, headers и raw агентов).
// Встроенные (HOME, WORKSPACE) и машинные (local/machine.yaml) — значениями; секреты
// (local/secrets.env) — ссылками secretRef(ИМЯ): значение в определение не попадает никогда.
// Сервер, которому не хватает переменной или чей секрет нельзя доставить, исключается из
// resolved (skipped) — остальное генерируется. agent — серверы со skip для этого агента
// переменных не требуют; секрет в raw агента не поддерживается (raw подмешивается как есть)
export function substitute(
  r: Resolved,
  machine: Machine,
  secrets: Record<string, string>,
  opts: { agent?: string; http?: HttpDelivery } = {},
): { resolved: Resolved; missing: string[]; skipped: SkippedMcp[]; secretServers: string[]; usedSecrets: string[]; serverUses: Record<string, string[]>; empty: { server: string; name: string }[] } {
  const builtin: Record<string, string> = { HOME: machine.home, WORKSPACE: machine.workspace };
  const missing = new Set<string>();
  const skipped: SkippedMcp[] = [];
  // Какие секреты используются и в каких серверах — по ним ядро раскладывает файлы секретов
  const secretServers = new Set<string>();
  const usedSecrets = new Set<string>();
  const serverUses: Record<string, string[]> = {};
  const empty: { server: string; name: string }[] = [];
  const isSecret = (name: string) => !(name in builtin) && !(name in machine.vars) && name in secrets;

  const mcp = r.mcp.flatMap(({ item, layer }) => {
    if (opts.agent && item.agents?.[opts.agent] === "skip") return [{ item, layer }];
    const lacking = new Set<string>();
    const used = new Set<string>();
    const problems: string[] = [];
    // Способ доставки выбирается до проверки значений: ограничения у каждого свои
    const how: Delivery = !item.url ? "stdio" : [...item.url.matchAll(REF)].some((m) => isSecret(m[1])) ? "bridge" : opts.http ?? "helper";
    const sub = (s: string, where: "command" | "env" | "arg" | "header" | "url" | "raw", key?: string) => {
      const whole = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(s);
      return s.replace(REF, (ref, name: string) => {
        if (name in builtin) return builtin[name];
        if (name in machine.vars) return machine.vars[name];
        if (!(name in secrets)) {
          lacking.add(name);
          return ref;
        }
        used.add(name);
        if (where === "command") problems.push(`секрет ${name} в command не поддерживается — передайте его через env или args`);
        else if (where === "raw") problems.push(`секрет ${name} в agents.${opts.agent}.raw не поддерживается — raw подмешивается в конфиг агента как есть`);
        else {
          const p = valueProblem(name, secrets[name], where === "env" && !whole ? "env-part" : where, machine.os, how, key);
          if (p) problems.push(p);
        }
        return secretRef(name);
      });
    };
    const subMap = (m: Record<string, string> | undefined, where: "env" | "header") =>
      m && Object.fromEntries(Object.entries(m).map(([k, v]) => [k, sub(String(v), where, k)]));
    const deep = (v: unknown): unknown =>
      typeof v === "string" ? sub(v, "raw")
      : Array.isArray(v) ? v.map(deep)
      : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)]))
      : v;
    // raw других агентов этому агенту не нужен: секрет в чужом raw не мешает
    const agents = item.agents && Object.fromEntries(Object.entries(item.agents).map(([id, a]) =>
      [id, a === "skip" || (opts.agent && id !== opts.agent) ? a : deep(a)])) as McpServer["agents"];
    const s: McpServer = {
      ...item,
      command: item.command && sub(item.command, "command"),
      args: item.args?.map((a) => sub(String(a), "arg")),
      url: item.url && sub(item.url, "url"),
      env: subMap(item.env, "env"),
      headers: subMap(item.headers, "header"),
      ...(agents && { agents }),
    };
    if (lacking.size || problems.length) {
      for (const v of lacking) missing.add(v);
      skipped.push({ name: item.name, vars: [...lacking], ...(problems.length && { why: [...new Set(problems)].join("; ") }), item: s });
      return [];
    }
    if (used.size) {
      secretServers.add(item.name);
      serverUses[item.name] = [...used].sort();
    }
    for (const n of used) {
      usedSecrets.add(n);
      if (secrets[n] === "") empty.push({ server: item.name, name: n });
    }
    return [{ item: s, layer }];
  });

  return { resolved: { ...r, mcp }, missing: [...missing], skipped, secretServers: [...secretServers], usedSecrets: [...usedSecrets], serverUses, empty };
}
