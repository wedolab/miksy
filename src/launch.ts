// Доставка секретов MCP-серверу без значений в конфигах агента (Р1, вариант B′).
// Значения лежат только в local/secrets/<ИМЯ> (одна строка, доступ — только владельцу,
// src/secretfiles.ts). В конфиг агента попадает путь к сгенерированному скрипту:
// - stdio-сервер — обёртка: sh читает файлы секретов, export, exec сервера; .cmd (Windows) —
//   chcp 65001, set /p VAR=<файл, запуск сервера (cmd.exe остаётся родителем);
// - HTTP-сервер — helper заголовков (тот же sh/.cmd печатает JSON и завершается: Claude
//   headersHelper, Codex http_headers_helper), {file:путь} (opencode) или мост (src/bridge.ts):
//   stdio-сервер для агента, пересылающий запросы на HTTP с заголовками из файлов секретов.
// Скрипты — own-файлы base "local" (local/run/<агент>/<цель>/): учёт, clean и doctor — как у
// остальных файлов. Значений секретов скрипты не содержат: только имена и пути.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { RenderedFile, Target } from "./adapter";
import { fold, pathKey, slash } from "./paths";
import type { McpServer, Os } from "./types";
import { BRIDGE_RESET, bridgeEnv, type Part, parts, serverSecrets } from "./vars";

// Сочетание, которое этот способ доставки передать не может: сервер пропускается с сообщением
export class DeliveryError extends Error {}

export interface Launcher {
  os: Os;
  secretsDir: string; // абсолютный каталог файлов секретов
  secretPath(name: string): string; // абсолютный путь файла секрета (прямые слэши)
  stdio(s: McpServer): string; // путь обёртки для command
  helper(s: McpServer): string; // строка-команда helper-а заголовков для shell агента (helperCommand)
  bridge(s: McpServer): string; // путь обёртки моста для command
  files(): RenderedFile[]; // сгенерированные скрипты (по одному на сервер и способ)
  kept(name: string): RenderedFile[]; // уже записанные скрипты сервера (keep): как лежат на диске
}

export interface LaunchOptions {
  os: Os;
  local: string; // каталог local/ конфигурации
  agent: string;
  target: Target;
  bun: string; // исполняемый файл Bun для моста
  engine: string; // каталог движка (src/bridge.ts)
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

// Имя файла из имени сервера/цели: только безопасные символы; изменённое — с хешем (без коллизий)
function safeName(s: string): string {
  const clean = s.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 60) || "_";
  return clean === s ? s : `${clean}-${sha(s).slice(0, 6)}`;
}

// Способ доставки — часть имени скрипта: stdio-сервер «x-headers» и helper сервера «x» не совпадут
type Kind = "stdio" | "headers" | "bridge";
// Имя скрипта сервера: читаемая часть и хеш точного имени (с регистром) и способа — «GitHub» и «github»
// различаются и на файловой системе без учёта регистра
export function scriptName(server: string, kind: Kind): string {
  const clean = server.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 40) || "_";
  return `${clean}-${kind}-${sha(`${kind}\0${server}`).slice(0, 8)}`;
}
// Имена до фазы 2г-2 (без хеша): обёртки сохранённых keep-ом серверов, записанные раньше
const legacyNames = (server: string) => [safeName(server), `${safeName(server)}-headers`, `${safeName(server)}-bridge`];

// Каталог скриптов цели: global или <имя каталога проекта>-<хеш пути>
export function targetSlug(target: Target): string {
  if (target.scope === "global") return "global";
  return `${safeName(basename(target.dir)).slice(0, 40)}-${sha(fold(pathKey(target.dir))).slice(0, 8)}`;
}

export { BRIDGE_RESET };

// Bun для обёрток моста. process.execPath — реальный путь: у Homebrew/scoop в нём версия
// (…/Cellar/bun/1.4.3/bin/bun, …\scoop\apps\bun\1.3.14\bun.exe), после обновления Bun такой путь
// пропадает и мосты падают. Берётся путь без версии, который ведёт на тот же файл: bun из PATH,
// ~/.bun/bin, scoop current, <prefix>/bin Homebrew; иначе — как есть
export function stableBun(exec: string, candidates = bunCandidates(exec)): string {
  const key = (p: string) => { try { return fold(slash(realpathSync(p))); } catch { return null; } };
  const target = key(exec);
  if (!target) return exec;
  return candidates.find((c) => c && key(c) === target) ?? exec;
}
function bunCandidates(exec: string): string[] {
  const exe = process.platform === "win32" ? "bun.exe" : "bun";
  return [...new Set([Bun.which("bun") ?? "", join(homedir(), ".bun", "bin", exe),
    exec.replace(/([\\/]apps[\\/]bun[\\/])[^\\/]+(?=[\\/])/i, "$1current"),
    exec.replace(/[\\/]Cellar[\\/]bun[\\/][^\\/]+[\\/]bin[\\/]bun$/, "/bin/bun")])].filter((c) => c && c !== exec);
}

// ---- sh ----

const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const shExpr = (p: Part[], esc: (s: string) => string = (s) => s) =>
  p.map((x) => (typeof x === "string" ? shq(esc(x)) : `"$h_${x.secret}"`)).join("") || "''";
// Текст комментария sh: без управляющих символов (перевод строки в имени каталога начал бы команду)
const shComment = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, "_");

function shPreamble(title: string, dir: string, names: string[], read: string[]): string[] {
  const lines = ["#!/bin/sh", `# Сгенерировано miksy: ${shComment(title)}. Не править — miksy sync перезапишет.`];
  if (!names.length) return lines;
  lines.push(`d=${shq(dir)}`, `for n in ${names.join(" ")}; do`,
    `  [ -r "$d/$n" ] || { echo "miksy: нет файла секрета $n ($d/$n) — выполните miksy sync" >&2; exit 1; }`, "done");
  for (const n of read) lines.push(`IFS= read -r h_${n} < "$d/${n}"`);
  return lines;
}

// ---- cmd ----

// Текст внутри "…" строки .cmd: %VAR% раскрывается до разбора (поэтому %% — литерал), внутри кавычек
// & | < > ^ ( ) — литералы; " внутри переключил бы кавычки и открыл спецсимволы — не допускается
function cmdText(s: string, what: string): string {
  if (s.includes('"')) throw new DeliveryError(`${what} содержит " — в .cmd-обёртке Windows не передаётся`);
  if (/[\r\n\u0000]/.test(s)) throw new DeliveryError(`${what} содержит перевод строки`);
  return s.replaceAll("%", "%%");
}
// Копия секрета в .cmd — h.<ИМЯ>: точки нет ни в имени секрета, ни в имени переменной слоя (ENV_NAME),
// поэтому копии не пересекаются с переменными сервера и служебными (cmd не различает регистр)
const cmdVar = (n: string) => `h.${n}`;
const cmdPart = (p: Part[], what: string) => p.map((x) => (typeof x === "string" ? cmdText(x, what) : `%${cmdVar(x.secret)}%`)).join("");
// Аргумент: в кавычках; обратные слэши в конце удваиваются (иначе \" — литеральная кавычка для CRT)
function cmdArg(p: Part[], what: string): string {
  const body = cmdPart(p, what);
  const last = p[p.length - 1];
  return `"${typeof last === "string" ? body.replace(/(\\+)$/, "$1$1") : body}"`;
}
// Команда: путь — с обратными слэшами; в кавычках, если есть что-то кроме простых символов
function cmdCommand(c: string): string {
  const p = /[\\/]/.test(c) ? c.replaceAll("/", "\\") : c;
  return /^[A-Za-z0-9_.:\\-]+$/.test(p) ? p : `"${cmdText(p, `command ${c}`)}"`;
}
const label = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");

// Строка-команда helper-а заголовков: агент выполняет её shell-ом — Claude `shell: true` (sh -c;
// Windows — cmd /d /s /c "…"), Codex — sh -c / %COMSPEC% /Q /D /C "…". Путь — данные, не код:
// sh — целиком в '…' ('\'' для '); cmd — всегда в "…" (& | < > ^ ( ) — литералы), а % и ! — вне
// кавычек с ^ ("…"^%"…"): %ИМЯ% раскрывается и внутри кавычек
export function helperCommand(path: string, os: Os): string {
  if (os !== "windows") return shq(path);
  if (/["\r\n]/.test(path)) throw new DeliveryError(`путь helper-а содержит " или перевод строки — в строке-команде cmd не передаётся`);
  return `"${path.replace(/[%!]/g, (c) => `"^${c}"`)}"`;
}
// Текст комментария rem: без % (раскрывается и в rem) и спецсимволов
const remText = (s: string) => s.replace(/[%"^&|<>!\r\n]/g, "_");

// setlocal DisableDelayedExpansion: ! в путях и тексте — литерал, даже если отложенное раскрытие
// включено в реестре (DelayedExpansion) или cmd запущен с /V:ON
function cmdPreamble(title: string, dir: string, names: string[], whole: Map<string, string>, read: string[]): string[] {
  const d = cmdText(dir.replaceAll("/", "\\"), "каталог секретов");
  const lines = ["@chcp 65001 >nul", "@echo off", "setlocal DisableDelayedExpansion", `rem Сгенерировано miksy: ${remText(title)}. Не править - miksy sync перезапишет.`];
  for (const n of names) lines.push(`if not exist "${d}\\${n}" goto missing`);
  // Переменная окружения целиком из секрета — прямо set /p: значение не разбирается cmd вовсе
  for (const [env, n] of whole) lines.push(`set "${env}="`, `set /p ${env}=<"${d}\\${n}"`);
  for (const n of read) lines.push(`set "${cmdVar(n)}="`, `set /p ${cmdVar(n)}=<"${d}\\${n}"`);
  return lines;
}
function cmdMissing(server: string, dir: string, names: string[]): string[] {
  if (!names.length) return [];
  return [":missing", `echo miksy: нет файла секрета для MCP-сервера ${label(server)} (${names.join(", ")}) в "${cmdText(dir.replaceAll("/", "\\"), "каталог секретов")}" - выполните miksy sync 1>&2`, "exit /b 1"];
}

// ---- генераторы ----

export function createLauncher(o: LaunchOptions): Launcher {
  const win = o.os === "windows";
  const secretsDir = slash(join(o.local, "secrets"));
  const runRel = `run/${safeName(o.agent)}/${targetSlug(o.target)}`;
  const made = new Map<string, RenderedFile>();
  const where = o.target.scope === "global" ? "глобально" : o.target.rel || o.target.dir;
  const native = (rel: string) => {
    const p = slash(join(o.local, rel));
    return win ? p.replaceAll("/", "\\") : p;
  };
  const put = (file: string, content: string) => {
    const rel = `${runRel}/${file}`;
    // Файловая система может не различать регистр: два разных скрипта — никогда в один файл
    const clash = made.get(fold(rel));
    if (clash && clash.mode === "own" && clash.content !== content) throw new Error(`${rel}: два разных скрипта получили одно имя файла (ошибка miksy)`);
    made.set(fold(rel), { base: "local", path: rel, mode: "own", content, executable: true });
    return native(rel);
  };

  // Обёртка: env и argv из частей; check — какие файлы секретов обязаны существовать; reset —
  // переменные окружения, которые снять до env слоя; cwd — каталог запуска
  const wrapper = (s: McpServer, file: string, title: string, argv: string[], env: Record<string, string>, check: string[], o: { reset?: string[]; cwd?: string } = {}) => {
    for (const k of Object.keys(env)) if (!ENV_NAME.test(k)) throw new DeliveryError(`имя переменной окружения «${k}» недопустимо для обёртки`);
    const envParts = Object.entries(env).map(([k, v]) => [k, parts(v)] as const);
    const argParts = argv.map(parts);
    const names = [...new Set([...check, ...serverSecrets({ name: s.name, args: argv, env })])];
    if (parts(argv[0]).some((x) => typeof x !== "string")) throw new DeliveryError("секрет в command не поддерживается");
    if (!win) {
      const read = names.filter((n) => serverSecrets({ name: s.name, args: argv, env }).includes(n));
      const lines = shPreamble(title, secretsDir, names, read);
      if (o.cwd) lines.push(`cd ${shq(o.cwd)} || exit 1`);
      if (o.reset?.length) lines.push(`unset ${o.reset.join(" ")}`);
      for (const [k, p] of envParts) lines.push(`${k}=${shExpr(p)}; export ${k}`);
      lines.push(`exec ${shq(argv[0])} ${argParts.slice(1).map((p) => shExpr(p)).join(" ")}${argv.length > 1 ? " " : ""}"$@"`);
      return put(`${file}.sh`, lines.join("\n") + "\n");
    }
    const whole = new Map<string, string>();
    for (const [k, p] of envParts) if (p.length === 1 && typeof p[0] !== "string") whole.set(k, p[0].secret);
    const read = names.filter((n) => argParts.some((p) => p.some((x) => typeof x !== "string" && x.secret === n))
      || envParts.some(([k, p]) => !whole.has(k) && p.some((x) => typeof x !== "string" && x.secret === n)));
    const lines = cmdPreamble(title, secretsDir, names, whole, read);
    if (o.cwd) lines.push(`cd /d "${cmdText(o.cwd.replaceAll("/", "\\"), "каталог запуска")}" || exit /b 1`);
    // cmd не различает регистр: HTTPS_PROXY и https_proxy — одна переменная
    for (const k of o.reset ?? []) if (!Object.keys(env).some((e) => e.toLowerCase() === k.toLowerCase())) lines.push(`set "${k}="`);
    for (const [k, p] of envParts) if (!whole.has(k)) lines.push(`set "${k}=${cmdPart(p, `env ${k}`)}"`);
    // Внутренние копии секретов очищаются в той же строке: %h.…% уже раскрыты при её разборе
    const clear = read.map((n) => `set "${cmdVar(n)}=" & `).join("");
    lines.push(`${clear}${cmdCommand(argv[0])}${argParts.slice(1).map((p, i) => " " + cmdArg(p, `аргумент ${i + 1}`)).join("")} %*`, "exit /b");
    lines.push(...cmdMissing(s.name, secretsDir, names));
    return put(`${file}.cmd`, lines.join("\r\n") + "\r\n");
  };

  return {
    os: o.os,
    secretsDir,
    secretPath: (n) => `${secretsDir}/${n}`,
    stdio(s) {
      if (!s.command) throw new DeliveryError("нет command");
      return wrapper(s, scriptName(s.name, "stdio"), `MCP-сервер ${s.name} (${o.agent}, ${where})`, [s.command, ...(s.args ?? [])], s.env ?? {}, []);
    },
    helper(s) {
      const headers = Object.entries(s.headers ?? {});
      for (const [k, v] of headers) {
        if (!HEADER_NAME.test(k)) throw new DeliveryError(`имя заголовка «${k}» недопустимо`);
        if (parts(v).some((x) => typeof x === "string" && /[^\x20-\x7e]/.test(x))) throw new DeliveryError(`заголовок ${k}: значение HTTP-заголовка — только ASCII`);
      }
      const names = serverSecrets({ name: s.name, headers: s.headers });
      const title = `заголовки MCP-сервера ${s.name} (${o.agent}, ${where})`;
      const file = scriptName(s.name, "headers");
      // JSON целиком из частей: текст JSON-экранируется при генерации; значения секретов проверены
      // ядром (ASCII, без " и \), подставляются как есть
      // escText — для текста значений (cmd: без "), структура JSON — как есть
      const json = (escText: (t: string) => string): Part[] => {
        const body: Part[] = [];
        headers.forEach(([k, v], i) => body.push(`${i ? "," : "{"}"${k}":"`, ...parts(v).map((x) => (typeof x === "string" ? escText(JSON.stringify(x).slice(1, -1)) : x)), '"'));
        body.push(headers.length ? "}" : "{}");
        return body.reduce<Part[]>((acc, x) => {
          if (typeof x === "string" && typeof acc[acc.length - 1] === "string") acc[acc.length - 1] += x;
          else acc.push(x);
          return acc;
        }, []);
      };
      let path: string;
      if (!win) {
        const lines = shPreamble(title, secretsDir, names, names);
        lines.push(`printf '%s\n' ${shExpr(json((t) => t))}`);
        path = put(`${file}.sh`, lines.join("\n") + "\n");
      } else {
        // helper запускается в консоли агента (Codex — %COMSPEC% /C), а не в своей: chcp изменил бы
        // кодовую страницу терминала пользователя. Скрипт — ASCII; путь с не-ASCII — chcp 65001 на
        // время чтения и возврат прежней страницы
        const d = cmdText(secretsDir.replaceAll("/", "\\"), "каталог секретов");
        const utf8 = /[^\x00-\x7f]/.test(d);
        // Прежняя страница — числом (set /a) в служебной miksy_cp: копии секретов — h.<ИМЯ>, не совпадут
        const restore = utf8 ? ["if %miksy_cp% GTR 0 chcp %miksy_cp% >nul"] : [];
        const lines = ["@echo off", "setlocal DisableDelayedExpansion",
          ...(utf8 ? ["set /a miksy_cp=0", `for /f "tokens=2 delims=:." %%c in ('chcp') do set /a "miksy_cp=%%c" >nul 2>&1`, "chcp 65001 >nul"] : []),
          `rem miksy: headers helper for MCP server ${label(s.name)}. Do not edit - miksy sync overwrites it.`];
        for (const n of names) lines.push(`if not exist "${d}\\${n}" goto missing`);
        for (const n of names) lines.push(`set "${cmdVar(n)}="`, `set /p ${cmdVar(n)}=<"${d}\\${n}"`);
        // Значения внутри "…" JSON — в кавычках cmd: & | < > ^ литералы; % удваивается; " в тексте
        // значения (\" после JSON-экранирования) переключил бы кавычки — отказ
        const noQuote = (t: string) => (t.includes('"') ? cmdText(t, "значение заголовка") : t);
        const echo = json(noQuote).map((x) => (typeof x === "string" ? x.replaceAll("%", "%%") : `%${cmdVar(x.secret)}%`)).join("");
        lines.push(`echo ${echo}`, ...restore, "exit /b 0");
        if (names.length) lines.push(":missing", `echo miksy: secret file missing for MCP server ${label(s.name)} (${names.join(", ")}) - run miksy sync 1>&2`, ...restore, "exit /b 1");
        path = put(`${file}.cmd`, lines.join("\r\n") + "\r\n");
      }
      return helperCommand(path, o.os);
    },
    bridge(s) {
      if (!s.url) throw new DeliveryError("нет url");
      // Мосту — шаблоны {secret:ИМЯ}: значения он читает из файлов сам, обёртка проверяет их наличие
      const tpl = (v: string) => parts(v).map((x) => (typeof x === "string" ? x : `{secret:${x.secret}}`)).join("");
      const names = serverSecrets(s);
      // Bun без .env и bunfig.toml каталога сессии (пустой конфиг движка), из каталога секретов
      const argv = [o.bun, "--no-env-file", `--config=${slash(join(o.engine, "src", "bridge.bunfig.toml"))}`, slash(join(o.engine, "src", "bridge.ts")),
        "--name", s.name, "--secrets", secretsDir, "--url", tpl(s.url),
        ...Object.entries(s.headers ?? {}).flatMap(([k, v]) => {
          if (!HEADER_NAME.test(k)) throw new DeliveryError(`имя заголовка «${k}» недопустимо`);
          return ["--header", `${k}=${tpl(v)}`];
        })];
      // Прокси/TLS — только заданные в env сервера в слое; остальной env HTTP-сервера мосту не нужен
      const env = Object.fromEntries(Object.entries(s.env ?? {}).filter(([k]) => bridgeEnv(k)));
      return wrapper(s, scriptName(s.name, "bridge"), `мост MCP-сервера ${s.name} (${o.agent}, ${where})`, argv, env, names, { reset: BRIDGE_RESET, cwd: secretsDir });
    },
    files: () => [...made.values()],
    kept(name) {
      return [...(["stdio", "headers", "bridge"] as const).map((k) => scriptName(name, k)), ...legacyNames(name)].flatMap((f) => [".sh", ".cmd"].map((e) => `${runRel}/${f}${e}`))
        .filter((rel) => existsSync(join(o.local, rel)))
        .map((rel) => ({ base: "local" as const, path: rel, mode: "own" as const, content: readFileSync(join(o.local, rel), "utf8"), executable: true }));
    },
  };
}

// Как агент получит сервер: без секретов — как есть; stdio — обёрткой; HTTP — штатным механизмом
// агента (http: helper заголовков, {file:} или мост); секрет в URL — только мост
export type Delivered =
  | { kind: "plain"; server: McpServer }
  | { kind: "stdio"; command: string }
  | { kind: "helper"; url: string; helper: string }
  | { kind: "file"; url: string; headers: Record<string, string> };

export function deliver(s: McpServer, launch: Launcher | undefined, http: "helper" | "file" | "bridge"): Delivered {
  if (!serverSecrets(s).length) return { kind: "plain", server: s };
  if (!launch) throw new DeliveryError("секрет без доставки (ошибка вызова адаптера)");
  if (!s.url) return { kind: "stdio", command: launch.stdio(s) };
  const inUrl = parts(s.url).some((x) => typeof x !== "string");
  if (inUrl || http === "bridge") return { kind: "stdio", command: launch.bridge(s) };
  if (http === "helper") return { kind: "helper", url: s.url, helper: launch.helper(s) };
  const headers = Object.fromEntries(Object.entries(s.headers ?? {}).map(([k, v]) =>
    [k, parts(v).map((x) => (typeof x === "string" ? x : `{file:${launch.secretPath(x.secret)}}`)).join("")]));
  return { kind: "file", url: s.url, headers };
}

// Серверы цели в формате агента. Сочетание, которое агент получить не может (DeliveryError), —
// пропуск сервера с сообщением; skip для агента — сообщение, как раньше
export function nativeServers(
  mcp: { item: McpServer }[],
  agent: string,
  native: (s: McpServer, launch?: Launcher) => Record<string, unknown> | null,
  launch: Launcher | undefined,
  warnings: string[],
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(mcp.flatMap(({ item }) => {
    try {
      const n = native(item, launch);
      if (!n) warnings.push(`mcp ${item.name}: для ${agent} указан skip`);
      return n ? [[item.name, n]] : [];
    } catch (e) {
      if (!(e instanceof DeliveryError)) throw e;
      warnings.push(`mcp ${item.name}: ${e.message} — сервер пропущен (значение секрета в конфиг не пишется)`);
      return [];
    }
  }));
}
