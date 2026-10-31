import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Adapter, CurrentState, RenderResult, Target } from "./adapter";
import { DeliveryError, type Launcher } from "./launch";
import { guard, safeRelative } from "./bounds";
import { trackedPaths } from "./git";
import { maskText, redactArgs } from "./secrets";
import type { Machine, Resolved } from "./types";
import { instructionBlock } from "./instructions";

const norm = (s: string) => s.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();

// Метка песочницы: только в таком каталоге sync --out удаляет и перезаписывает <out>/<agent>
export const SANDBOX_MARK = ".miksy-sandbox";

// Песочница — несуществующий, пустой или помеченный miksy каталог; иначе отказ до любых записей.
// dryRun — только проверка, без создания каталога и метки
export function prepareSandbox(out: string, dryRun: boolean) {
  if (existsSync(out)) {
    if (!statSync(out).isDirectory()) throw new Error(`${out}: это файл, а не каталог песочницы`);
    if (readdirSync(out).length && !existsSync(join(out, SANDBOX_MARK)))
      throw new Error(`${out}: каталог не пуст и не песочница miksy (нет ${SANDBOX_MARK}) — укажите пустой или новый каталог`);
  }
  if (dryRun) return;
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, SANDBOX_MARK), "Песочница miksy sync --out: сгенерированные конфиги для просмотра. Каталог можно удалить.\n");
}

// Запись результата адаптера в песочницу: <out>/<agent>/{home,project}/...
// merge-файлы пишутся как <path>.merge.json — что именно будет влито и куда
export function writeSandbox(out: string, agent: string, result: RenderResult): string[] {
  if (!existsSync(join(out, SANDBOX_MARK))) throw new Error(`${out}: не песочница miksy`);
  const root = join(out, agent);
  rmSync(root, { recursive: true, force: true });
  const written: string[] = [];
  for (const f of result.files) {
    if (!safeRelative(f.path)) throw new Error(`${f.path}: путь адаптера выходит за пределы песочницы`);
    const path = f.mode === "own" ? join(root, f.base, f.path) : join(root, f.base, `${f.path}.merge.${written.length}.json`);
    guard(path, root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, f.mode === "own" ? (f.block ? instructionBlock(f.content) : f.content) : JSON.stringify({ format: f.format, key: f.key, data: f.data }, null, 2) + "\n");
    written.push(path.replaceAll("\\", "/"));
  }
  return written;
}

// Файлы проекта, которые надо скрыть от git через .git/info/exclude; отслеживаемые — конфликт.
// Сбой git — GitError (не «не отслеживается»)
export function gitStatusOf(dir: string, paths: string[]): { exclude: string[]; tracked: string[] } {
  const tracked = trackedPaths(dir, paths);
  return { exclude: paths.filter((p) => !tracked.includes(p)), tracked };
}

// Определение для показа: значения секретов замаскированы с обеих сторон — и у того, что даст miksy,
// и у того, что сейчас в конфиге агента (там секреты лежат значениями)
function summarize(def: Record<string, unknown>, secrets: Record<string, string> = {}): string {
  const m = (s?: string) => s === undefined ? undefined : maskText(s, secrets);
  const d = def as { type?: string; command?: string | string[]; args?: string[]; url?: string; env?: object; environment?: object; headers?: object; http_headers?: object };
  const command = Array.isArray(d.command) ? d.command[0] : d.command;
  const args = Array.isArray(d.command) ? d.command.slice(1) : d.args;
  const keys = (o?: object) => (o ? Object.keys(o).sort().join(",") : "");
  return JSON.stringify({
    type: d.type ?? (d.url ? "http" : "stdio"),
    command: m(command?.replaceAll("\\", "/")),
    args: args && redactArgs(args, () => "<secret>").map((a) => m(a.replaceAll("\\", "/"))),
    url: m(d.url),
    env: keys(d.env ?? d.environment),
    headers: keys(d.headers ?? d.http_headers),
  });
}

// Текущее значение по шаблону слоя: на месте <secret:ИМЯ> в текущем конфиге — значение секрета,
// возможно старое (после ротации), его не знает ни secrets.env, ни распознавание шаблонов
// (ключ в пути URL). Совпало с текущим секретом — <secret:ИМЯ>, иначе <secret>
const SECRET_SLOT = /<secret:([A-Za-z_][A-Za-z0-9_]*)>/g;
const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function byTemplate(cur: unknown, tpl: unknown, secrets: Record<string, string>): unknown {
  if (Array.isArray(cur) && Array.isArray(tpl) && cur.length === tpl.length) return cur.map((c, i) => byTemplate(c, tpl[i], secrets));
  if (typeof cur !== "string" || typeof tpl !== "string" || !tpl.includes("<secret:")) return cur;
  const parts = tpl.split(SECRET_SLOT);
  const m = cur.match(new RegExp(`^${parts.map((p, i) => (i % 2 ? "([\\s\\S]+?)" : escapeRx(p))).join("")}$`));
  if (!m) return cur;
  let i = 0;
  return tpl.replace(SECRET_SLOT, (whole, name: string) => (m[++i] === secrets[name] ? whole : "<secret>"));
}

// Сравнение: что агент видит сейчас и что даст miksy.
// Источники внутри проекта — файлы команды: они остаются, miksy их не заменяет.
export function compare(adapter: Adapter, cfg: Resolved, current: CurrentState, projectDir?: string, secrets: Record<string, string> = {}, launch?: Launcher): string[] {
  const show = (def: Record<string, unknown>, tpl?: Record<string, unknown> | null) => {
    if (!tpl) return summarize(def, secrets);
    const masked = { ...def };
    for (const k of ["url", "command", "args"]) if (k in def) masked[k] = byTemplate(def[k], tpl[k], secrets);
    return summarize(masked, secrets);
  };
  const inProject = (src: string) => !!projectDir && src.toLowerCase().startsWith(projectDir.toLowerCase() + "/");
  const out: string[] = ["MCP (текущие определения → слои miksy; ограничения записи — в предупреждениях)"];
  const native = (item: Resolved["mcp"][number]["item"]) => {
    try {
      return adapter.nativeMcp(item, launch);
    } catch (e) {
      if (e instanceof DeliveryError) return null;
      throw e;
    }
  };
  const generated = new Map(cfg.mcp.map(({ item, layer }) => [item.name, { def: native(item), layer }]));
  const names = [...new Set([...Object.keys(current.mcp), ...generated.keys()])].sort();
  if (!names.length) out.push("  —");
  for (const n of names) {
    const cur = current.mcp[n];
    const gen = generated.get(n);
    if (cur && inProject(cur.source))
      out.push(
        !gen ? `  · ${n}  остаётся (файл проекта)`
        : gen.def && show(cur.def, gen.def) === show(gen.def) ? `  ! ${n}  слой ${gen.layer} дублирует командный из ${cur.source} (определения совпадают)`
        : `  ! ${n}  слой ${gen.layer} перекроет командный из ${cur.source} — определения РАЗНЫЕ`,
      );
    else if (cur && !gen) out.push(`  - ${n}  уйдёт (сейчас из ${cur.source})`);
    else if (!cur && gen) out.push(`  + ${n}  появится (слой ${gen.layer})`);
    else if (cur && gen?.def) {
      const was = show(cur.def, gen.def);
      const same = was === show(gen.def);
      out.push(`  ${same ? "=" : "~"} ${n}  ${same ? "совпадает" : `отличается: было ${was}\n        станет ${show(gen.def)}`}`);
    }
  }

  out.push("", "Инструкции (фрагменты miksy → где они сейчас)");
  const texts = [
    ...current.instructionFiles.map((f) => ({ f, t: norm(readFileSync(f, "utf8")) })),
    ...(current.instructionTexts ?? []).map(({ source, text }) => ({ f: source, t: norm(text) })),
  ];
  const allLines = new Set(texts.flatMap((x) => x.t.split("\n").map((l) => l.trim())));
  for (const { item, layer } of cfg.instructions) {
    const t = norm(readFileSync(item.path, "utf8"));
    const hit = texts.find((x) => x.t.includes(t));
    const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
    const fresh = lines.filter((l) => !allLines.has(l)).length;
    out.push(
      `  ${hit ? "=" : fresh ? "+" : "≈"} ${layer}/${item.file}  ` +
        (hit ? `есть в ${hit.f}` : fresh ? `новых строк: ${fresh} из ${lines.length}` : "все строки есть в текущих, но разбиты иначе"),
    );
  }
  out.push("", `Текущие файлы инструкций, которые ${adapter.id} сейчас загружает`);
  for (const f of current.instructionFiles) out.push(`  ${inProject(f) ? "· остаётся (файл проекта)" : "  "} ${f}`);
  for (const { source } of current.instructionTexts ?? []) out.push(`    ${source}`);
  return out;
}

// rendered — renderFor (секреты ссылками, обёртки — файлы base "local" в <out>/<агент>/local/)
export function syncOut(adapter: Adapter, rendered: { result: RenderResult; cfg: Resolved; missing: string[] }, target: Target, machine: Machine, out: string, dryRun = false, secrets: Record<string, string> = {}, launch?: Launcher) {
  const { result, cfg, missing } = rendered;
  const count = dryRun ? result.files.length : writeSandbox(out, adapter.id, result).length;
  const lines = [`Адаптер ${adapter.id}: ${count} файл(ов) ${dryRun ? "были бы записаны в" : "→"} ${join(out, adapter.id).replaceAll("\\", "/")}`];
  for (const f of result.files) lines.push(`  ${f.mode === "own" ? "файл " : "слить"}  ${f.base === "home" ? "~" : f.base === "local" ? "<конфигурация>/local" : "<проект>"}/${f.path}${f.mode === "merge" ? `  ключ ${JSON.stringify(f.key)}` : ""}`);

  if (target.scope === "project") {
    const projectFiles = result.files.filter((f) => f.base === "project").map((f) => f.path);
    try {
      const { exclude, tracked } = gitStatusOf(target.dir, projectFiles);
      if (exclude.length) lines.push("", "В .git/info/exclude проекта", ...exclude.map((p) => "  " + p));
      for (const p of tracked) result.warnings.push(`${p} отслеживается git проекта — это файл команды, писать в него нельзя`);
    } catch (e) {
      result.warnings.push(`${(e as Error).message} — sync в этот проект ничего не запишет`);
    }
  }
  for (const m of missing) result.warnings.push(`переменная ${m} не задана`);
  if (result.warnings.length) lines.push("", "Предупреждения", ...result.warnings.map((w) => "  " + w));

  if (adapter.current)
    lines.push("", ...compare(adapter, cfg, adapter.current(target, machine), target.scope === "project" ? target.dir : undefined, secrets, launch));
  return lines.join("\n");
}
