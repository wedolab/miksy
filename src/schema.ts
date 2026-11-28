// Форма файлов настроек miksy (круг 12f): map.yaml, layer.yaml, mcp/<имя>.yaml и local/machine.yaml — одно описание и
// проверка по нему (без зависимостей npm).
// - неизвестный ключ на любом уровне — предупреждение: опечатка или ключ более новой версии miksy; с подсказкой
//   похожего известного имени;
// - известный ключ не той формы или с недопустимым значением — ошибка: команда, которая читает файл, откажет до записи
//   (src/load.ts, configGate). Пропустить ключ — тоже записать агентам не то (без exclude, trust или skip они получат
//   лишнее), поэтому отказ, а не пропуск;
// - мягкое замечание (soft) — предупреждение: агентам такой ключ не пишется (description) или ничего не меняет.
// null (ключ без значения) — как отсутствие ключа. Числа и true/false там, где ждут строку для агента (args, env,
// headers, vars, name), допускаются — пишутся строкой, как и раньше. Значения в сообщения не попадают (в слоях бывают
// секреты), кроме перечислений (os, import_skills, agents.<агент>)
import { ADAPTERS } from "./agents";

type Shape =
  | { t: "str"; re?: RegExp } // непустая строка (re — её вид)
  | { t: "scalar" } // строка, число или true/false
  | { t: "bool" }
  | { t: "enum"; of: readonly unknown[] }
  | { t: "list"; of: Shape; min?: number; item?: Field } // item — что ожидается от элемента (иначе — как от списка)
  | { t: "obj"; keys: Record<string, Field>; strict?: boolean } // strict: чужой ключ — ошибка, а не предупреждение
  | { t: "dict"; of: Shape; key?: RegExp } // произвольные имена ключей (env, headers, vars, tools)
  | { t: "any" }
  | { t: "either"; of: Shape[] };
// want — что ожидается (для человека), example — строка-пример; need — обязательный; soft — не та форма — предупреждение
export type Field = { shape: Shape; want: string; example?: string; need?: boolean; soft?: boolean };

export type Finding = { path: string; text: string };
export type Checked = { value: unknown; errors: Finding[]; unknown: Finding[]; soft: Finding[] };

const BAD = Symbol("bad");
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const join = (path: string, k: string | number) => (typeof k === "number" ? `${path}[${k}]` : path ? `${path}.${k}` : k);

// Расстояние Левенштейна — для подсказок опечаток (и в именах каталогов дерева, src/load.ts)
export function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
// Ближайшее известное имя: отличается на 1–2 буквы или одно содержит другое
export function nearest(name: string, known: string[]): string | undefined {
  const x = name.toLowerCase();
  const scored = known.map((k) => {
    const y = k.toLowerCase();
    const near = x !== y && ((Math.min(x.length, y.length) >= 3 && (x.includes(y) || y.includes(x))) || (Math.min(x.length, y.length) >= 3 && distance(x, y) <= 2));
    return { k, d: near ? distance(x, y) : Infinity };
  }).filter((s) => s.d < Infinity).sort((a, b) => a.d - b.d);
  return scored[0]?.k;
}

const shown = (v: unknown) => (typeof v === "string" || typeof v === "number" || typeof v === "boolean") && String(v).length <= 40;

function walk(v: unknown, s: Shape, f: Field, path: string, out: Checked): unknown {
  const bad = (p = path, value?: unknown): typeof BAD => {
    const val = value !== undefined && shown(value) ? ` «${String(value)}»` : "";
    (f.soft ? out.soft : out.errors).push({ path: p, text: `${p}${val} — ${f.want}${f.example ? `, например ${f.example}` : ""}` });
    return BAD;
  };
  switch (s.t) {
    case "any": return v;
    case "str": return typeof v === "string" && v.trim() && (!s.re || s.re.test(v)) ? v : bad(path, s.re && typeof v === "string" ? v : undefined);
    case "scalar": return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : bad();
    case "bool": return typeof v === "boolean" ? v : bad(path, v);
    case "enum": return s.of.includes(v) ? v : bad(path, v);
    case "list": {
      if (!Array.isArray(v)) return bad();
      if (s.min && v.length < s.min) return bad();
      const items = v.map((x, i) => walk(x, s.of, s.item ?? f, join(path, i), out));
      return items.includes(BAD) ? BAD : items;
    }
    case "dict": {
      if (!isObj(v)) return bad();
      const res: Record<string, unknown> = {};
      let broken = false;
      for (const [k, x] of Object.entries(v)) {
        if (s.key && !s.key.test(k)) { bad(join(path, k)); broken = true; continue; }
        const r = walk(x, s.of, f, join(path, k), out);
        if (r === BAD) broken = true;
        else res[k] = r;
      }
      return broken ? BAD : res;
    }
    case "obj": return object(v, s, path, out, f);
    case "either": {
      for (const o of s.of) {
        const tmp: Checked = { value: undefined, errors: [], unknown: [], soft: [] };
        const r = walk(v, o, { ...f, soft: false }, path, tmp);
        if (r !== BAD && !tmp.errors.length) { out.unknown.push(...tmp.unknown); out.soft.push(...tmp.soft); return r; }
      }
      return bad(path, v);
    }
  }
}

function object(v: unknown, s: Extract<Shape, { t: "obj" }>, path: string, out: Checked, parent?: Field): unknown {
  if (!isObj(v)) {
    if (parent) {
      (parent.soft ? out.soft : out.errors).push({ path, text: `${path} — ${parent.want}${parent.example ? `, например ${parent.example}` : ""}` });
      return BAD;
    }
    out.errors.push({ path, text: `файл — ожидается набор «ключ: значение»${Array.isArray(v) ? ", а не список" : ""}` });
    return BAD;
  }
  const res: Record<string, unknown> = {};
  let broken = false;
  const known = Object.keys(s.keys);
  for (const [k, x] of Object.entries(v)) {
    const field = s.keys[k];
    const p = join(path, k);
    if (!field) {
      if (s.strict && parent) { out.errors.push({ path: p, text: `${p} — ${parent.want}${parent.example ? `, например ${parent.example}` : ""}` }); broken = true; continue; }
      const near = nearest(k, known);
      out.unknown.push({ path: p, text: `${p}${near ? ` (может быть, ${join(path, near)}?)` : ""}` });
      continue;
    }
    if (x === null || x === undefined) continue;
    const r = walk(x, field.shape, field, p, out);
    if (r === BAD) { if (!field.soft) broken = true; }
    else res[k] = r;
  }
  for (const [k, field] of Object.entries(s.keys)) {
    if (field.need && (v[k] === null || v[k] === undefined)) {
      const p = join(path, k);
      out.errors.push({ path: p, text: `нет ${p} — ${field.want}${field.example ? `, например ${field.example}` : ""}` });
      broken = true;
    }
  }
  // Ошибка во вложенном — объект целиком непригоден (верхний уровень файла остаётся: его ключи проверены по одному)
  return broken && parent ? BAD : res;
}

// ---- формы файлов ----

const OS = ["windows", "macos", "linux"] as const;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const agentIds = () => Object.values(ADAPTERS).map((a) => a.id);
const trustIds = () => Object.values(ADAPTERS).filter((a) => a.trust).map((a) => a.id);
const aliasIds = () => Object.values(ADAPTERS).flatMap((a) => a.aliases ?? []);

const osField = (): Field => ({ shape: { t: "either", of: [{ t: "enum", of: OS }, { t: "list", of: { t: "enum", of: OS }, min: 1 }] },
  want: "windows, macos или linux (или их список)", example: "os: [windows, macos]" });
// В сообщении — в обратном порядке списка адаптеров: так оно выглядело до круга 10x-2 ({ codex: boolean, claude: boolean })
const trustField = (): Field => {
  const ids = trustIds();
  return { shape: { t: "obj", strict: true, keys: Object.fromEntries(ids.map((id) => [id, { shape: { t: "bool" }, want: "true или false" } as Field])) },
    want: `объект { ${[...ids].reverse().map((id) => `${id}: boolean`).join(", ")} }`, example: `trust: { ${ids[0]}: true }` };
};

const entry = (layers: boolean): Field => ({
  shape: { t: "obj", keys: {
    use: { shape: { t: "str" }, want: "имя слоя — каталог в layers/", example: layers ? "{ match: \"*/infra-*\", use: infra }" : "{ use: global }", need: true },
    match: { shape: { t: "str" }, want: "шаблон места в дереве слоёв (строка)", example: "\"*/infra-*\"" },
    os: osField(),
  } },
  want: layers ? "{ match: <шаблон>, use: <слой> }" : "{ use: <слой> }", example: layers ? "{ match: \"*/infra-*\", use: infra }" : "{ use: global }",
});

export const MAP_FORM = (): Field => ({ want: "", shape: { t: "obj", keys: {
  global: { shape: { t: "list", of: entry(false).shape, item: entry(false) }, want: "список слоёв для домашнего каталога агентов: { use: <слой> }", example: "global: [{ use: global }]" },
  layers: { shape: { t: "list", of: entry(true).shape, item: entry(true) }, want: "список привязок слоёв по шаблону: { match: <шаблон>, use: <слой> }", example: "layers: [{ match: \"*/infra-*\", use: infra }]" },
  skill_prefix: { shape: { t: "str", re: /^[A-Za-z0-9][A-Za-z0-9._-]*$/ }, want: "строка из букв, цифр, «-», «_», «.»", example: "miksy-" },
  tools: { shape: { t: "dict", key: NAME, of: { t: "obj", keys: {
    find: { shape: { t: "list", of: { t: "str" }, min: 1 }, want: "список команд для поиска в PATH", example: "find: [github-mcp-server]", need: true },
    install: { shape: { t: "obj", keys: Object.fromEntries(OS.map((o) => [o, { shape: { t: "str" }, want: "как установить (команда или ссылка)" } as Field])) }, want: "{ windows|macos|linux: как установить }", example: "install: { macos: brew install … }" },
  } } }, want: "{ ИМЯ: { find: [команда, …], install: { windows|macos|linux: как установить } } }", example: "tools: { GH: { find: [gh] } }" },
} } });

export const LAYER_FORM = (): Field => ({ want: "", shape: { t: "obj", keys: {
  description: { shape: { t: "scalar" }, want: "строка (описание слоя; агентам не пишется)", soft: true },
  exclude: { shape: { t: "list", of: { t: "str", re: /^(mcp|skill|instructions)\..+/ } }, want: "список: mcp.<имя>, skill.<имя>, instructions.<файл>", example: "exclude: [mcp.linear, skill.deploy]" },
  import_skills: { shape: { t: "either", of: [{ t: "enum", of: ["auto", "all", false] }, { t: "list", of: { t: "str" } }] }, want: "auto, all, false или список имён", example: "import_skills: auto" },
  trust: trustField(),
  target: { shape: { t: "bool" }, want: "true или false (цель-группа)", example: "target: true" },
  skill_secrets: { shape: { t: "list", of: { t: "str", re: NAME } }, want: "список имён секретов из local/secrets.env", example: "skill_secrets: [ACME_TOKEN]" },
} } });

export const MCP_FORM = (): Field => {
  const ids = agentIds();
  const agent: Field = { shape: { t: "either", of: [{ t: "enum", of: ["skip"] }, { t: "obj", keys: {
    raw: { shape: { t: "dict", of: { t: "any" } }, want: "объект — подмешивается в настройки агента как есть", example: "raw: { timeout: 60 }", need: true },
  } }] }, want: "skip (этому агенту не подключать) или { raw: { … } }", example: `${ids[0]}: skip` };
  return { want: "", shape: { t: "obj", keys: {
    name: { shape: { t: "scalar" }, want: "имя сервера", example: "name: gitlab", need: true },
    command: { shape: { t: "str" }, want: "команда запуска — строка (аргументы — в args)", example: "command: npx" },
    url: { shape: { t: "str" }, want: "адрес удалённого (HTTP) сервера — строка", example: "url: https://tracker.example/mcp" },
    args: { shape: { t: "list", of: { t: "scalar" } }, want: "список аргументов", example: "args: [-y, \"@scope/pkg\"]" },
    env: { shape: { t: "dict", of: { t: "scalar" } }, want: "объект «ИМЯ: значение»", example: "env: { API_URL: https://… }" },
    headers: { shape: { t: "dict", of: { t: "scalar" } }, want: "объект «Заголовок: значение»", example: "headers: { Authorization: Bearer ${TOKEN} }" },
    os: osField(),
    agents: { shape: { t: "obj", keys: Object.fromEntries([...ids, ...aliasIds()].map((id) => [id, agent])) }, want: "объект { <агент>: skip или { raw: { … } } }", example: `agents: { ${ids[0]}: skip }` },
  } } };
};

export const MACHINE_FORM = (): Field => {
  const ids = agentIds();
  return { want: "", shape: { t: "obj", keys: {
    workspace: { shape: { t: "any" }, want: "путь или список корней" }, // форму проверяет parseRoots
    vars: { shape: { t: "dict", of: { t: "scalar" } }, want: "объект «ИМЯ: значение» — пути к программам для ${ИМЯ} в слоях", example: "vars: { PYTHON: /usr/bin/python3 }" },
    agents: { shape: { t: "list", of: { t: "str" } }, want: "список агентов", example: `[${ids.slice(0, 2).join(", ")}]` },
    trust: trustField(),
    mcp_off: { shape: { t: "list", of: { t: "str" } }, want: "список имён MCP-серверов, выключенных на этой машине", example: "mcp_off: [gitlab]" },
  } } };
};

// Проверка документа по форме файла. value — документ без ключей с ошибками (верхний уровень) — чтобы команда,
// которая не откажет (clean, doctor), не споткнулась о них
export function check(doc: unknown, form: Field): Checked {
  const out: Checked = { value: undefined, errors: [], unknown: [], soft: [] };
  if (doc === null || doc === undefined) { out.value = {}; return out; }
  const r = object(doc, form.shape as Extract<Shape, { t: "obj" }>, "", out);
  out.value = r === BAD ? {} : r;
  return out;
}

// Сервер MCP: ровно одно из command и url
export function mcpKind(doc: Record<string, unknown>): Finding | null {
  const has = (k: string) => doc[k] !== undefined && doc[k] !== null;
  if (has("command") && has("url")) return { path: "command", text: "command и url вместе — нужно одно: command (сервер запускается у вас) или url (удалённый сервер)" };
  if (!has("command") && !has("url")) return { path: "command", text: "нет command или url — нужно одно: command (сервер запускается у вас) или url (удалённый сервер)" };
  return null;
}

// Привязка map.yaml без match ничего не делает — предупреждение (не ошибка: агентам она ничего не пишет)
export function mapNotes(doc: Record<string, unknown>): Finding[] {
  const layers = Array.isArray(doc.layers) ? doc.layers : [];
  return layers.flatMap((e, i) => (isObj(e) && (e.match === undefined || e.match === null)
    ? [{ path: `layers[${i}]`, text: `layers[${i}] — нет match: слой не применяется ни к одному проекту; например { match: "*/infra-*", use: infra } (слой для домашнего каталога — в global)` }] : []));
}
