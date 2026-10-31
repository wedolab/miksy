// miksy adopt — поднять добавку агента (MCP или skill) в слой miksy.
import { appendFileSync, chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { guard } from "./bounds";
import { envLine, nakedSecrets, redact, redactArgs, SECRET_KEY } from "./secrets";
import { LAYER_PARTS, loadSecrets, configRoot } from "./load";
import type { Machine, McpServer } from "./types";

import { slash } from "./paths";

// Каталог слоя по уровню: global | workspace | путь в дереве (Org, Org/Team, Org/proj)
// Уровень — только имена каталогов через «/»: без .., абсолютных путей, дисков и обратной косой;
// итоговый каталог (после раскрытия симлинков) — внутри layers/ конфигурации
export function layerDir(level: string, root = configRoot()): string {
  if (/^\//.test(level) || /^[A-Za-z]:/.test(level) || level.includes("\\"))
    throw new Error(`«${level}»: уровень — global, workspace или путь в дереве (Org/Team), не путь на диске`);
  const l = level.replace(/\/+$/g, "");
  if (l === "global") return join(root, "layers", "global");
  if (l === "" || l === "workspace") return join(root, "layers", "tree");
  const parts = l.split("/");
  if (parts.some((s) => !s || s === "." || s === ".." || !NAME.test(s)))
    throw new Error(`«${level}»: недопустимый уровень — только имена каталогов дерева через «/»`);
  if (parts.some((s) => LAYER_PARTS.has(s))) throw new Error(`«${level}»: имена ${[...LAYER_PARTS].join(", ")} зарезервированы`);
  const dir = join(root, "layers", "tree", ...parts);
  guard(dir, join(root, "layers"));
  return dir;
}

// Имя MCP или skill становится именем файла/каталога в слое
const NAME = /^[^\\/:*?"<>|\0]+$/;
export function checkName(name: string) {
  if (!NAME.test(name) || name === "." || name === ".." || name.startsWith("."))
    throw new Error(`«${name}»: недопустимое имя для файла в слое`);
}

const envName = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");

// Определение MCP из формата любого агента (Claude, Codex, opencode, Gemini) в формат miksy.
// Секреты — значения env/headers с «секретными» именами, флаги --token=…/--api-key …, пароли в URL
// и строках подключения, ?token= в URL, токены с узнаваемым префиксом, то же в raw агента — уходят
// в secrets (возвращаются отдельно), в слое остаются ссылки ${ИМЯ}; пути машины — в переменные.
// open — места, где осталось похожее на секрет, но не распознанное (показать пользователю)
export function fromNative(
  name: string,
  def: Record<string, unknown>,
  agent: string,
  machine: Machine,
  level: string,
  existingSecrets: Record<string, string> = {},
): { server: McpServer; secrets: Record<string, string>; open: string[] } {
  const d = { ...def } as Record<string, any>;
  const s: McpServer = { name };
  const prefix = envName(level === "" || level === "workspace" ? "workspace" : level);
  const secrets: Record<string, string> = {};

  // Имя переменной: то же значение уже есть — та же ссылка; занятое имя с другим значением — суффикс
  const pickSecret = (hint: string, value: string): string => {
    const all = { ...existingSecrets, ...secrets };
    const same = Object.entries(all).find(([, v]) => v === value)?.[0];
    if (same) return `\${${same}}`;
    const base = `${prefix}_${envName(hint)}`;
    let n = base;
    for (let i = 2; n in all; i++) n = `${base}_${i}`;
    secrets[n] = value;
    return `\${${n}}`;
  };
  const refFor = (base: string) => (value: string, hint: string) => pickSecret(hint ? `${base}_${hint}` : base, value);

  // Пути машины → переменные (длинные значения первыми, без учёта регистра на Windows)
  const varsByLen = [
    ...Object.entries(machine.vars),
    ["WORKSPACE", machine.workspace],
    ["HOME", machine.home],
  ].sort((a, b) => b[1].length - a[1].length);
  const unpath = (v: string) => {
    let out = slash(v);
    for (const [k, val] of varsByLen) {
      const p = slash(val);
      if (!p) continue;
      const i = machine.os === "windows" ? out.toLowerCase().indexOf(p.toLowerCase()) : out.indexOf(p);
      if (i >= 0) out = out.slice(0, i) + `\${${k}}` + out.slice(i + p.length);
    }
    return out;
  };
  // env/headers: значение по «секретному» имени — целиком; Bearer-токен заголовка — <имя сервера>_TOKEN
  const secretMap = (m: Record<string, unknown> | undefined, isHeader: boolean) => {
    if (!m) return undefined;
    return Object.fromEntries(
      Object.entries(m).map(([k, v]) => {
        const ref = (value: string, hint: string) => (isHeader && hint === "TOKEN" ? pickSecret(`${name}_TOKEN`, value) : refFor(k)(value, hint));
        return [k, unpath(redact(String(v), ref, SECRET_KEY.test(k)))];
      }),
    );
  };
  const args = (list: unknown[]) => redactArgs(list.map(String), refFor(name)).map(unpath);

  // stdio: command (+args); у opencode command — массив, env называется environment
  const cmd = d.command;
  if (Array.isArray(cmd)) {
    s.command = unpath(String(cmd[0]));
    if (cmd.length > 1) s.args = args(cmd.slice(1));
  } else if (typeof cmd === "string") {
    s.command = unpath(cmd);
    if (Array.isArray(d.args) && d.args.length) s.args = args(d.args);
  }
  const env = d.env ?? d.environment;
  if (env && Object.keys(env).length) s.env = secretMap(env, false);

  // http: url (у Gemini бывает serverUrl), заголовки (у Codex — http_headers)
  const url = d.url ?? d.serverUrl ?? d.httpUrl;
  if (typeof url === "string") s.url = redact(url, refFor(name));
  const headers = d.headers ?? d.http_headers;
  if (headers && Object.keys(headers).length) s.headers = secretMap(headers, true);

  if (!s.command && !s.url) throw new Error(`MCP ${name}: не удалось понять определение (нет command/url)`);

  // Всё остальное, специфичное для агента, — в его raw; секреты и там выносятся
  const known = new Set(["type", "command", "args", "env", "environment", "url", "serverUrl", "httpUrl", "headers", "http_headers", "enabled"]);
  const scrub = (v: unknown, key: string): unknown => {
    if (typeof v === "string") return unpath(redact(v, refFor(`${name}_${key}`), SECRET_KEY.test(key)));
    if (Array.isArray(v)) return v.every((x) => typeof x === "string") ? redactArgs(v, refFor(`${name}_${key}`)) : v.map((x) => scrub(x, key));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x, k)]));
    return v;
  };
  const extra = Object.fromEntries(Object.entries(d).filter(([k]) => !known.has(k)).map(([k, v]) => [k, scrub(v, k)]));
  if (Object.keys(extra).length) s.agents = { [agent]: { raw: extra } };
  return { server: s, secrets, open: nakedSecrets(s as unknown as Record<string, unknown>) };
}

// Простой YAML для определения MCP: строки в двойных кавычках (валидный YAML)
export function mcpYaml(s: McpServer, comment?: string): string {
  const q = (v: string) => JSON.stringify(v);
  const key = (k: string) => (/^[A-Za-z_][\w-]*$/.test(k) ? k : q(k));
  const lines: string[] = comment ? [`# ${comment}`] : [];
  const block = (obj: Record<string, unknown>, indent: string) => {
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) lines.push(`${indent}${key(k)}: [${v.map((x) => q(String(x))).join(", ")}]`);
      else if (v && typeof v === "object") {
        lines.push(`${indent}${key(k)}:`);
        block(v as Record<string, unknown>, indent + "  ");
      } else if (typeof v === "string") lines.push(`${indent}${key(k)}: ${q(v)}`);
      else lines.push(`${indent}${key(k)}: ${JSON.stringify(v)}`);
    }
  };
  block(s as unknown as Record<string, unknown>, "");
  return lines.join("\n") + "\n";
}

// dryRun — только проверки и путь файла слоя, без записи
export function adoptMcp(server: McpServer, secrets: Record<string, string>, level: string, comment: string, root = configRoot(), dryRun = false): string {
  checkName(server.name);
  const dir = join(layerDir(level, root), "mcp");
  const file = join(dir, `${server.name}.yaml`);
  guard(file, join(root, "layers"));
  if (existsSync(file)) throw new Error(`${slash(relative(root, file))} уже существует`);
  if (dryRun) return slash(relative(root, file));
  // Сначала секреты: слой не должен ссылаться на значения, которых нет
  if (Object.keys(secrets).length) addSecrets(secrets, root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, mcpYaml(server, comment));
  return slash(relative(root, file));
}

// Дописать секреты в local/secrets.env: значения экранируются (перевод строки не ломает файл),
// новый файл — 0600
export function addSecrets(secrets: Record<string, string>, root = configRoot()) {
  const path = join(root, "local", "secrets.env");
  const have = loadSecrets(root);
  const add = Object.entries(secrets).filter(([k]) => !(k in have));
  if (!add.length) return;
  mkdirSync(dirname(path), { recursive: true });
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = add.map(([k, v]) => envLine(k, v)).join("\n") + "\n";
  if (!existsSync(path)) writeFileSync(path, lines, { mode: 0o600 });
  else appendFileSync(path, (text && !text.endsWith("\n") ? "\n" : "") + lines);
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

// Копирование skill в слой. Симлинки не разыменовываем: ссылка могла вести за пределы skill
// (ключи, .env). dryRun — только список того, что будет скопировано
export function adoptSkill(srcDir: string, name: string, level: string, root = configRoot(), dryRun = false) {
  checkName(name);
  const dst = join(layerDir(level, root), "skills", name);
  guard(dst, join(root, "layers"));
  if (existsSync(dst)) throw new Error(`${slash(relative(root, dst))} уже существует`);
  const files: string[] = [];
  const skipped: string[] = [];
  const walk = (from: string) => {
    for (const e of readdirSync(from)) {
      const f = join(from, e);
      const st = lstatSync(f);
      if (st.isSymbolicLink()) skipped.push(slash(relative(srcDir, f)));
      else if (st.isDirectory()) walk(f);
      else if (st.isFile()) files.push(slash(relative(srcDir, f)));
    }
  };
  walk(srcDir);
  if (!dryRun)
    for (const f of files) {
      mkdirSync(dirname(join(dst, f)), { recursive: true });
      copyFileSync(join(srcDir, f), join(dst, f));
    }
  return { dir: slash(relative(root, dst)), files, skipped };
}
