// Поиск секретов в определениях MCP: значения env/headers, аргументы командной строки, URL
// (user:pass@, ?token=), строки подключения БД, raw агента. Общий для adopt (вынести в
// local/secrets.env), compare (маскировать) и проверки слоёв (секреты открытым текстом).
import { readFileSync, statSync } from "node:fs";

// Имя ключа/флага, по которому значение — секрет целиком
export const SECRET_KEY = /(token|secret|password|passwd|pwd|credential|authorization|api[_-]?key|apikey|auth)/i;

// Токены с узнаваемым префиксом — где бы ни встретились
const PREFIXED = /\b(sk-[A-Za-z0-9_-]{10,}|glpat-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|dop_v1_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|y0_[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|AQVN[A-Za-z0-9_-]{20,}|t1\.[A-Za-z0-9_.-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+)/g;

// Части строки, которые секретны сами по себе. Значение — последняя группа, совпадение им заканчивается;
// hint — подсказка для имени переменной по группам
const PARTS: { rx: RegExp; hint: (g: string[]) => string }[] = [
  // scheme://user:ПАРОЛЬ@host — URL и строки подключения (postgres://, mongodb+srv://, redis://…)
  { rx: /([a-z][a-z0-9+.-]*:\/\/[^\s/@:]*:)([^\s/@]+)(?=@)/gi, hint: () => "PASSWORD" },
  // ?token=… &api_key=… в URL
  { rx: /([?&]([a-z0-9_.-]*(?:token|key|secret|password|passwd|pwd|auth|sig|signature)[a-z0-9_.-]*)=)([^&#\s]+)/gi, hint: (g) => g[1] },
  // Password=…; (ADO/JDBC/ODBC) и password=… (libpq key=value)
  { rx: /((?:^|[;\s])(password|pwd|passwd)\s*=\s*)([^;\s]+)/gi, hint: (g) => g[1] },
  // Authorization: Bearer … / Basic … / Token …
  { rx: /(\b(Bearer|Basic|Token)\s+)([A-Za-z0-9._~+/=-]{8,})/g, hint: () => "TOKEN" },
];

export const isRef = (s: string) => /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(s.trim());
const hasRef = (s: string) => /\$\{[A-Za-z_]/.test(s);

// Заменяет секретные части строки: replace(значение, подсказка) → ссылка или маска.
// whole — ключ похож на секрет: если частей не нашлось, секретно всё значение (подсказка "").
// Ссылки ${…} не трогаются
export function redact(text: string, replace: (value: string, hint: string) => string, whole = false): string {
  if (!text || isRef(text)) return text;
  let hit = false;
  let out = text;
  for (const { rx, hint } of PARTS) {
    out = out.replace(rx, (...args) => {
      const match = args[0] as string;
      const groups = args.slice(1, -2) as string[];
      const value = groups[groups.length - 1];
      if (!value || hasRef(value) || value.startsWith("<secret")) return match;
      hit = true;
      return match.slice(0, match.length - value.length) + replace(value, hint(groups));
    });
  }
  out = out.replace(PREFIXED, (v) => {
    hit = true;
    return replace(v, "TOKEN");
  });
  if (!hit && whole && !hasRef(text)) return replace(text, "");
  return out;
}

// Аргументы командной строки: --token=…, --api-key …, плюс части строк (URL, токены)
export function redactArgs(args: string[], replace: (value: string, hint: string) => string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const flag = a.match(/^(--?[A-Za-z0-9][\w-]*)=(.*)$/s);
    if (flag && SECRET_KEY.test(flag[1]) && flag[2] && !looksLikePath(flag[2])) {
      out.push(`${flag[1]}=${redact(flag[2], (v, h) => replace(v, h || flag[1]), true)}`);
      continue;
    }
    out.push(redact(a, replace));
    const next = args[i + 1];
    if (/^--?[A-Za-z0-9][\w-]*$/.test(a) && SECRET_KEY.test(a) && next !== undefined && !next.startsWith("-") && !looksLikePath(next)) {
      out.push(redact(next, (v, h) => replace(v, h || a), true));
      i++;
    }
  }
  return out;
}

const looksLikePath = (s: string) => /^(~|\.{1,2}|[A-Za-z]:)?[\\/]/.test(s) || /^\$\{[A-Z_]+\}[\\/]/.test(s);

// Похоже на случайный токен: длинное, буквы и цифры вперемешку, высокая энтропия, не путь и не URL
export function suspicious(s: string): boolean {
  if (s.length < 20 || hasRef(s) || /[\s\\/:@]/.test(s)) return false;
  if (!/[a-z]/.test(s) || !/[A-Z0-9]/.test(s) || !/\d/.test(s)) return false;
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h > 3.5;
}

// Где в определении MCP (в формате miksy или raw агента) остались значения, похожие на секрет.
// Только места, не значения. Ссылки ${…} не считаются
export function nakedSecrets(def: Record<string, unknown>, path = ""): string[] {
  const out: string[] = [];
  const visit = (v: unknown, where: string, key: string) => {
    if (typeof v === "string") {
      const found = redact(v, () => "\u0000", SECRET_KEY.test(key)).includes("\u0000");
      if (found || suspicious(v)) out.push(where);
    } else if (Array.isArray(v)) {
      if (v.every((x) => typeof x === "string")) {
        redactArgs(v as string[], () => "\u0000").forEach((x, i) => {
          if (x.includes("\u0000") || suspicious(v[i] as string)) out.push(`${where}[${i}]`);
        });
      } else v.forEach((x, i) => visit(x, `${where}[${i}]`, key));
    } else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) visit(x, where ? `${where}.${k}` : k, k);
    }
  };
  visit(def, path, "");
  return out;
}

// Маска для показа: известные значения секретов → <secret:ИМЯ>, распознанные части → <secret>
export function maskText(s: string, known: Record<string, string>): string {
  let out = s;
  for (const [name, v] of Object.entries(known).sort((a, b) => b[1].length - a[1].length))
    if (v.length >= 4) out = out.split(v).join(`<secret:${name}>`);
  return redact(out, () => "<secret>");
}

// secrets.env: строка KEY=значение; значение с пробелами, кавычками, #, переводами строк — в двойных
// кавычках с экранированием (\n, \r, \", \\); парсер — loadSecrets
export function envLine(name: string, value: string): string {
  if (/^[A-Za-z0-9_./:@+,=-]*$/.test(value) && !value.includes("#")) return `${name}=${value}`;
  const esc = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r");
  return `${name}="${esc}"`;
}

// Файлы, которые в слой (и в git конфигурации) не переносятся: похожие на секреты — по имени, без учёта регистра.
// Окружение и ключи (.env*, .envrc direnv, *.pem, *.key, PKCS#12, Java keystore, SSH-ключи без .pub), учётные данные программ
// (.npmrc, .pypirc, .netrc, .pgpass, .git-credentials, .htpasswd), JSON с учётными данными (credentials*.json,
// client_secret*.json, service-account*.json), хранилища паролей (*.kdbx), secrets.env самого miksy.
// Образцы .env (.example, .sample, .template, .dist) — переносятся: в них нет значений
const SECRET_FILE = new RegExp(
  "^(\\.env(\\..+)?|.+\\.(pem|key|p12|pfx|jks|keystore|kdbx)|id_(rsa|dsa|ecdsa|ed25519)(_sk)?(\\..+)?|" +
  "[._]netrc|\\.envrc|\\.npmrc|\\.pypirc|\\.pgpass|\\.git-credentials|\\.htpasswd|secrets\\.env|" +
  "(credentials|client_secret|service[-_]account)[^/]*\\.json)$", "i");
const SECRET_SAMPLE = /^\.env\.(example|sample|template|dist)$|\.pub$/i;
// Служебное: файлы ОС и каталоги программ — skill они не нужны
const JUNK_FILE = /^(\.DS_Store|Thumbs\.db|desktop\.ini)$/i;
const JUNK_DIR = /^(\.git|node_modules|__pycache__)$/i;

export function skillFileKind(name: string, dir: boolean): "secret" | "junk" | null {
  if (dir) return JUNK_DIR.test(name) ? "junk" : null;
  if (JUNK_FILE.test(name)) return "junk";
  return SECRET_FILE.test(name) && !SECRET_SAMPLE.test(name) ? "secret" : null;
}

// Секреты открытым текстом в файле skill: строки с распознанными частями (URL с паролем, ?token=, Bearer, токены
// с префиксом) и ключ: значение / KEY=значение (в том числе в середине строки — JSON, YAML в одну строку), где имя
// похоже на секрет, а значение — на случайный токен. Текст строки не выводится (круг 11l: в нём могли остаться
// нераспознанные значения) — только что найдено: вид и имя ключа или параметра
const ASSIGN = /(?:^|[\s{,;(])(?:export\s+)?["']?([A-Za-z_][\w.-]*)["']?\s*[:=]\s*["']?([^"'\s#,;}]+)/g;
const PREFIX = /^(sk-|glpat-|gh[pousr]_|github_pat_|dop_v1_|xox[abpr]-|y0_|AKIA|AQVN|t1\.|eyJ)/;
const KIND = ["пароль в адресе", "параметр %s в адресе", "пароль в строке подключения (%s)", "токен %s"];
export function nakedInText(text: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  text.split(/\r?\n/).forEach((l, i) => {
    const what: string[] = [];
    const add = (w: string) => { if (!what.includes(w)) what.push(w); };
    const seen: string[] = []; // значения, уже найденные частями, — ключ с тем же значением не повторяем
    PARTS.forEach(({ rx }, k) => {
      for (const m of l.matchAll(rx)) {
        const value = m[m.length - 1];
        if (!value || hasRef(value) || value.startsWith("<secret")) continue;
        seen.push(value);
        add(KIND[k].replace("%s", m[2]));
      }
    });
    for (const m of l.matchAll(PREFIXED)) {
      if (seen.some((v) => v.includes(m[0]))) continue; // уже найден частью (Bearer ghp_…)
      seen.push(m[0]);
      add(`токен ${m[0].match(PREFIX)?.[0] ?? ""}…`);
    }
    for (const m of l.matchAll(ASSIGN)) if (SECRET_KEY.test(m[1]) && suspicious(m[2]) && !seen.some((v) => m[2].includes(v))) add(`ключ ${m[1]}`);
    if (what.length) out.push({ line: i + 1, text: what.join(", ") });
  });
  return out;
}

// Текст файла для поиска секретов; null — больше 1 МБ (размер — до чтения) или бинарный (NUL в первых 8 КБ)
export const textFile = (path: string): string | null => {
  if (statSync(path).size > 1 << 20) return null;
  const b = readFileSync(path);
  if (b.subarray(0, 8192).includes(0)) return null;
  return b.toString("utf8");
};
