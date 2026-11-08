import { gitCaching, gitEnv, gitMemo } from "./git";
// Командные skills в репо проекта: поиск, склейка копий, проверка формы.
// Только чтение — файлы команды miksy не меняет.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Resolved, Skill } from "./types";

export type AgentId = string;

// Где агент сам находит skills проекта: <каталог>/<имя>/SKILL.md.
// По умолчанию; адаптер уточняет через skillDirs. opencode — проверено вживую (адаптер);
// antigravity — уточняет адаптер (.agents/skills, проверено вживую).
export const DEFAULT_READERS: Record<AgentId, string[]> = {
  claude: [".claude/skills"],
  codex: [".agents/skills"],
  opencode: [".agents/skills", ".claude/skills", ".opencode/skills", ".opencode/skill"],
  antigravity: [".gemini/skills"],
};

export interface SkillCopy {
  path: string; // каталог skill относительно проекта
  location: string; // каталог расположения или название нестандартного места
  seenBy: AgentId[]; // какие агенты находят skill по этому пути
  symlink: boolean;
  hash: string; // SKILL.md без учёта переводов строк
  name?: string;
  description?: string;
  issues: string[]; // агент не найдёт или не поймёт skill
  warnings: string[]; // работает, но хрупко
}

export interface TeamSkill {
  name: string;
  source: SkillCopy; // лучший источник для импорта
  copies: SkillCopy[];
  variants: number; // число разных содержимых среди копий
  seenBy: AgentId[]; // агенты, которые видят хотя бы одну корректную копию
}

export interface TeamCommand {
  path: string;
  location: string;
}

// Приоритет источника для импорта — порядок в списке
const PRIORITY = [".agents/skills", ".claude/skills", ".opencode/skills", ".opencode/skill", ".gemini/skills"];
// Частые нестандартные места — для понятных сообщений
const NONSTANDARD: { id: string; rx: RegExp }[] = [
  { id: "двойная вложенность", rx: /\/skills\/skills\/[^/]+$/ },
  { id: ".agents/<имя>", rx: /^\.agents\/(?!skills\/)[^/]+$/ },
  { id: ".codex/skills", rx: /^\.codex\/skills\/[^/]+$/ },
  { id: ".claude/commands/<имя>", rx: /^\.claude\/commands\/.+$/ },
];

const ROOTS = [".agents", ".claude", ".codex", ".gemini", ".opencode"];
const NAME_RX = /^[a-z0-9][a-z0-9-]{0,63}$/;

function frontmatter(text: string): Record<string, unknown> | null {
  const m = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return null;
  try {
    return (Bun.YAML.parse(m[1]) as Record<string, unknown>) ?? {};
  } catch {
    return null;
  }
}

// Кто из агентов находит skill в этом каталоге и как назвать расположение
function classify(dir: string, readers: Record<AgentId, string[]>) {
  const parent = dir.slice(0, dir.lastIndexOf("/"));
  const seenBy = Object.keys(readers).filter((a) => readers[a].includes(parent));
  if (seenBy.length) return { id: parent, seenBy, standard: true };
  return { id: NONSTANDARD.find((l) => l.rx.test(dir))?.id ?? parent, seenBy, standard: false };
}

// Файлы команды в агентных каталогах: путь → симлинк ли (git mode 120000)
function trackedFiles(dir: string): Map<string, boolean> {
  const r = Bun.spawnSync(["git", "-C", dir, "ls-files", "-s", "-z", "--", ...ROOTS], { env: gitEnv(), stdout: "pipe", stderr: "ignore" });
  const out = new Map<string, boolean>();
  if (r.exitCode !== 0) return out;
  for (const entry of r.stdout.toString().split("\0")) {
    const m = entry.match(/^(\d+) \S+ \d+\t(.+)$/);
    if (m) out.set(m[2], m[1] === "120000");
  }
  return out;
}

// Один разбор на проект за команду CLI (gitMemo): его спрашивает каждый агент
export const scanTeamSkills = (dir: string, readers: Record<AgentId, string[]> = DEFAULT_READERS) =>
  gitMemo(`scan|${dir}|${JSON.stringify(readers)}`, () => scan(dir, readers));

function scan(
  dir: string,
  readers: Record<AgentId, string[]>,
): { skills: TeamSkill[]; commands: TeamCommand[]; git: boolean } {
  if (!existsSync(join(dir, ".git"))) return { skills: [], commands: [], git: false };
  const files = trackedFiles(dir);
  const copies: SkillCopy[] = [];
  const commands: TeamCommand[] = [];

  // Кандидаты: каталоги с SKILL.md и симлинки на каталоги (git хранит их одной записью)
  const candidates: { skillDir: string; skillMd: string; symlink: boolean; broken?: string; asFile?: boolean }[] = [];
  for (const [file, isLink] of files) {
    const skillMd = file.match(/^(.+)\/SKILL\.md$/i);
    if (skillMd) {
      candidates.push({ skillDir: skillMd[1], skillMd: join(dir, file), symlink: isLink });
      continue;
    }
    if (isLink && !file.endsWith(".md")) {
      // На диске — настоящая ссылка/junction (каталог) или, без поддержки симлинков, файл с путём
      const abs = join(dir, file);
      let target = abs;
      // Без поддержки симлинков git выгружает ссылку файлом с путём — агенты через неё ничего не видят
      const asFile = existsSync(abs) && !statSync(abs).isDirectory();
      if (asFile) target = resolve(dirname(abs), readFileSync(abs, "utf8").trim());
      if (existsSync(join(target, "SKILL.md"))) {
        candidates.push({ skillDir: file, skillMd: join(target, "SKILL.md"), symlink: true, asFile });
      } else if (existsSync(target) && statSync(target).isDirectory()) {
        // Ссылка на каталог со skills (например, .claude/commands → .agents): каждый вложенный skill — копия
        for (const e of readdirSync(target, { withFileTypes: true }))
          if (e.isDirectory() && existsSync(join(target, e.name, "SKILL.md")))
            candidates.push({ skillDir: `${file}/${e.name}`, skillMd: join(target, e.name, "SKILL.md"), symlink: true, asFile });
      } else {
        // Куда указывает ссылка — из самого git-объекта
        const blob = Bun.spawnSync(["git", "-C", dir, "cat-file", "-p", `:${file}`], { env: gitEnv(), stdout: "pipe", stderr: "ignore" });
        const to = blob.exitCode === 0 ? blob.stdout.toString().trim() : target;
        candidates.push({ skillDir: file, skillMd: join(target, "SKILL.md"), symlink: true, broken: to });
      }
      continue;
    }
    const cmd = file.match(/^(\.claude\/commands|\.opencode\/commands?)\/.+\.md$/);
    if (cmd) commands.push({ path: file, location: cmd[1] });
  }

  for (const { skillDir, skillMd, symlink, broken, asFile } of candidates) {
    const loc = classify(skillDir, readers);
    const issues: string[] = []; // агент skill не найдёт или не поймёт
    const warnings: string[] = []; // работает, но хрупко или неаккуратно
    const text = existsSync(skillMd) ? readFileSync(skillMd, "utf8") : "";
    if (broken) issues.push(`битый симлинк → ${broken.replaceAll("\\", "/")}`);
    else if (!text) issues.push("SKILL.md не найден");
    const fm = frontmatter(text);
    const dirName = skillDir.split("/").pop()!;
    const name = typeof fm?.name === "string" ? fm.name : undefined;
    const description = typeof fm?.description === "string" ? fm.description : undefined;

    if (!loc.standard) issues.push(`нестандартный путь (${loc.id}) — ни один агент не находит skill здесь`);
    if (asFile) issues.push("симлинк выгружен файлом с путём (нет поддержки симлинков) — на этой машине агенты skill не видят");
    else if (symlink && !broken) warnings.push("через симлинк — на машине без поддержки симлинков (Windows без Developer Mode) не сработает");
    if (text && !fm) issues.push("нет frontmatter (--- name/description ---)");
    else if (text) {
      if (!name) issues.push("нет name");
      else if (name !== dirName) warnings.push(`name «${name}» не совпадает с каталогом «${dirName}»`);
      if (name && !NAME_RX.test(name)) issues.push(`недопустимое имя «${name}» (a-z, 0-9, дефис, до 64)`);
      if (!description) issues.push("нет description — агент не поймёт, когда skill нужен");
      else if (description.length > 1024) warnings.push(`description длиннее 1024 символов (${description.length})`);
    }

    copies.push({
      path: skillDir,
      location: loc.id,
      seenBy: loc.seenBy,
      symlink,
      hash: createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex").slice(0, 12),
      name,
      description,
      issues,
      warnings,
    });
  }

  // Склейка копий по имени (frontmatter, иначе каталог)
  const groups = new Map<string, SkillCopy[]>();
  for (const c of copies) {
    const key = c.name ?? c.path.split("/").pop()!;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  // Источник для импорта — настоящие файлы: без битых ссылок и не через симлинк, затем по месту
  const rank = (c: SkillCopy) => {
    const i = PRIORITY.indexOf(c.location);
    const unreadable = c.issues.some((x) => x.startsWith("битый") || x.startsWith("SKILL.md") || x.startsWith("нет frontmatter") || x.startsWith("симлинк выгружен"));
    return (unreadable ? 1000 : 0) + (c.symlink ? 100 : 0) + (i < 0 ? 50 : i);
  };
  const skills = [...groups].map(([name, list]) => {
    const sorted = [...list].sort((a, b) => rank(a) - rank(b));
    const valid = list.filter((c) => !c.issues.length);
    return {
      name,
      source: sorted[0],
      copies: sorted,
      variants: new Set(list.map((c) => c.hash)).size,
      seenBy: Object.keys(readers).filter((a) => valid.some((c) => c.seenBy.includes(a))),
    };
  });
  return { skills: skills.sort((a, b) => a.name.localeCompare(b.name)), commands, git: true };
}

// Имя, понятное всем агентам: a-z, 0-9, дефис, до 64
export function safeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

// Механическая правка frontmatter: name совпадает с каталогом доставки
function patchName(text: string, name: string): string {
  return text.replace(/^(﻿?---\r?\n)([\s\S]*?)(\r?\n---)/, (_, open: string, body: string, close: string) =>
    /^name:.*$/m.test(body) ? open + body.replace(/^name:.*$/m, `name: ${name}`) + close : `${open}name: ${name}\n${body}${close}`,
  );
}

type TreeEntry = { mode: string; type: string; sha: string; path: string };

// Записи последнего коммита (HEAD) по путям (сам путь и всё внутри); null — git не смог (нет коммитов,
// сбой). С кешем команды (gitCaching) — всё дерево репо одним запросом, иначе запрос по путям
function lsTree(dir: string, paths: string[]): TreeEntry[] | null {
  if (!gitCaching()) return lsTreeQuery(dir, paths);
  const all = gitMemo(`tree|${dir}`, () => lsTreeQuery(dir, []));
  return all && all.filter((e) => paths.some((p) => e.path === p || e.path.startsWith(p + "/")));
}

function lsTreeQuery(dir: string, paths: string[]): TreeEntry[] | null {
  const r = Bun.spawnSync(["git", "--literal-pathspecs", "-C", dir, "ls-tree", "-r", "-z", "HEAD", "--", ...paths], { env: gitEnv(), stdout: "pipe", stderr: "ignore" });
  if (r.exitCode !== 0) return null;
  return r.stdout.toString().split("\0").filter(Boolean).flatMap((e) => {
    const m = e.match(/^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/s);
    return m ? [{ mode: m[1], type: m[2], sha: m[3], path: m[4] }] : [];
  });
}

// Содержимое blob-объектов. С кешем команды — сразу все файлы агентных каталогов репо (ROOTS) одним
// запросом; недостающие (цель ссылки вне них) — дозапросом
function blobs(dir: string, shas: string[]): Map<string, Buffer> {
  if (!gitCaching()) return blobsQuery(dir, shas);
  const known = gitMemo(`blobs|${dir}`, () =>
    blobsQuery(dir, (lsTree(dir, ROOTS) ?? []).filter((e) => e.type === "blob").map((e) => e.sha)));
  const missing = shas.filter((s) => !known.has(s));
  if (missing.length) for (const [k, v] of blobsQuery(dir, missing)) known.set(k, v);
  return new Map(shas.filter((s) => known.has(s)).map((s) => [s, known.get(s)!]));
}

// Один вызов git cat-file --batch
function blobsQuery(dir: string, shas: string[]): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (!shas.length) return out;
  const r = Bun.spawnSync(["git", "-C", dir, "cat-file", "--batch"], { stdin: Buffer.from([...new Set(shas)].join("\n") + "\n"), env: gitEnv(), stdout: "pipe", stderr: "ignore" });
  if (r.exitCode !== 0) throw new Error("git cat-file не прочитал объекты");
  const buf = Buffer.from(r.stdout);
  for (let i = 0; i < buf.length; ) {
    const nl = buf.indexOf(10, i);
    const [sha, type, size] = buf.subarray(i, nl).toString().split(" ");
    if (type === "missing" || size === undefined) { i = nl + 1; continue; }
    out.set(sha, buf.subarray(nl + 1, nl + 1 + Number(size)));
    i = nl + 1 + Number(size) + 1;
  }
  return out;
}

// Какие файлы git выгружает в рабочую копию с CRLF при LF в репо (i/lf w/crlf). С кешем команды —
// весь индекс одним запросом
function checkoutCrlf(dir: string, paths: string[]): Set<string> {
  if (!paths.length) return new Set();
  if (!gitCaching()) return crlfQuery(dir, paths);
  const all = gitMemo(`eol|${dir}`, () => crlfQuery(dir, []));
  return new Set(paths.filter((p) => all.has(p)));
}

function crlfQuery(dir: string, paths: string[]): Set<string> {
  const r = Bun.spawnSync(["git", "--literal-pathspecs", "-C", dir, "ls-files", "--eol", "-z", "--", ...paths], { env: gitEnv(), stdout: "pipe", stderr: "ignore" });
  if (r.exitCode !== 0) return new Set();
  const out = new Set<string>();
  for (const e of r.stdout.toString().split("\0")) {
    const m = e.match(/^i\/(\S*)\s+w\/(\S*)\s+attr\/[^\t]*\t(.+)$/s);
    if (m && m[1] === "lf" && m[2] === "crlf") out.add(m[3]);
  }
  return out;
}

// Куда ведёт ссылка из git (путь относительно репо); null — за пределы репо или абсолютный путь
function linkInRepo(from: string, to: string): string | null {
  if (/^([A-Za-z]:)?[\\/]/.test(to)) return null;
  const parts: string[] = from.split("/").slice(0, -1);
  for (const seg of to.replaceAll("\\", "/").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/") || null;
}

// Файлы командного skill из последнего коммита: незакоммиченное, неотслеживаемое и ignored
// (например, .env) не попадает. Симлинки (каталог skill или файл в нём) раскрываются только
// в пределах репо — по объектам git, без чтения рабочей копии
// Один разбор на skill за команду CLI (gitMemo); предупреждения повторяются каждому агенту
export function committedSkill(dir: string, path: string, warn: (s: string) => void): Skill["files"] | null {
  const r = gitMemo(`skill|${dir}|${path}`, () => {
    const warnings: string[] = [];
    return { files: readCommitted(dir, path, (w) => warnings.push(w)), warnings };
  });
  for (const w of r.warnings) warn(w);
  return r.files;
}

function readCommitted(dir: string, path: string, warn: (s: string) => void, depth = 0): Skill["files"] | null {
  const entries = lsTree(dir, [path]);
  if (!entries) return warn(`${path}: нет в последнем коммите (git ls-tree HEAD не удался) — не доставлен`), null;
  const self = entries.find((e) => e.path === path && e.mode === "120000");
  if (self) {
    const to = blobs(dir, [self.sha]).get(self.sha)?.toString("utf8") ?? "";
    const target = linkInRepo(path, to);
    if (!target || depth > 4) return warn(`${path}: симлинк ведёт за пределы репо (${to}) — не доставлен`), null;
    return readCommitted(dir, target, warn, depth + 1);
  }
  const inside = entries.filter((e) => e.path.startsWith(path + "/"));
  if (!inside.length) {
    // Симлинк может быть выше по пути (.claude/skills → ../.agents/skills): раскрываем по объектам git
    const parts = path.split("/");
    for (let i = parts.length - 1; i > 0; i--) {
      const prefix = parts.slice(0, i).join("/");
      const link = lsTree(dir, [prefix])?.find((e) => e.path === prefix && e.mode === "120000");
      if (!link) continue;
      const to = blobs(dir, [link.sha]).get(link.sha)?.toString("utf8") ?? "";
      const target = linkInRepo(prefix, to);
      if (!target || depth > 4) return warn(`${path}: ${prefix} — симлинк за пределы репо (${to}) — не доставлен`), null;
      return readCommitted(dir, [target, ...parts.slice(i)].join("/"), warn, depth + 1);
    }
    return warn(`${path}: нет в последнем коммите (или ведёт во вложенное репо) — не доставлен`), null;
  }
  const files: { rel: string; repoPath: string; sha: string; executable: boolean }[] = [];
  for (const e of inside) {
    const rel = e.path.slice(path.length + 1);
    if (e.mode === "100644" || e.mode === "100755") files.push({ rel, repoPath: e.path, sha: e.sha, executable: e.mode === "100755" });
    else if (e.mode === "120000") {
      const to = blobs(dir, [e.sha]).get(e.sha)?.toString("utf8") ?? "";
      const target = linkInRepo(e.path, to);
      const hit = target ? lsTree(dir, [target])?.find((x) => x.path === target && (x.mode === "100644" || x.mode === "100755")) : undefined;
      if (hit) files.push({ rel, repoPath: hit.path, sha: hit.sha, executable: hit.mode === "100755" });
      else warn(`${path}: ссылка ${rel} → ${to} ведёт за пределы репо или не на файл — не скопирована`);
    }
  }
  const data = blobs(dir, files.map((f) => f.sha));
  const crlf = checkoutCrlf(dir, files.map((f) => f.repoPath));
  return files.map((f) => {
    const raw = data.get(f.sha) ?? Buffer.alloc(0);
    const binary = raw.includes(0);
    const text = raw.toString("utf8");
    // Переводы строк — как в выгрузке git (core.autocrlf, .gitattributes eol), содержимое — из коммита
    const content = !binary && crlf.has(f.repoPath) ? text.replace(/\r?\n/g, "\r\n") : text;
    return { rel: f.rel, content, executable: f.executable, binary };
  }).sort((a, b) => a.rel.localeCompare(b.rel));
}

// Добавляет к конфигу проекта командные skills, которые агент сам не видит.
// Skills слоёв (ручные исправления) перекрывают командные с тем же именем.
export function withTeamSkills(
  cfg: Resolved,
  projectDir: string,
  agent: string,
  readers: Record<AgentId, string[]> = DEFAULT_READERS,
): { cfg: Resolved; warnings: string[] } {
  const setting = cfg.importSkills;
  if (!setting || setting.item === false) return { cfg, warnings: [] };
  const warnings: string[] = [];
  const { skills } = scanTeamSkills(projectDir, readers);
  const wanted = Array.isArray(setting.item) ? skills.filter((s) => (setting.item as string[]).includes(s.name)) : skills;
  if (Array.isArray(setting.item))
    for (const n of setting.item) if (!skills.some((s) => s.name === n)) warnings.push(`import_skills (${setting.layer}): в репо нет skill «${n}»`);

  const own = new Set(cfg.skills.map((s) => s.item.name));
  const excluded = new Set(cfg.skillExcludes ?? []);
  const added: Resolved["skills"] = [];
  for (const s of wanted) {
    if (s.seenBy.includes(agent as AgentId) || excluded.has(s.name)) continue;
    const name = safeName(s.name);
    if (own.has(name)) continue;
    const src = s.source;
    const files = committedSkill(projectDir, src.path, (w) => warnings.push(`skill ${s.name}: ${w}`));
    if (!files) continue;
    const text = files.find((f) => f.rel === "SKILL.md")?.content ?? "";
    const fm = text && frontmatter(text);
    if (!fm) { warnings.push(`skill ${s.name}: ${text ? "нет frontmatter" : "SKILL.md нет в коммите"} — не доставлен; исправленную версию можно положить в слой проекта`); continue; }
    if (typeof fm.description !== "string" || !fm.description) { warnings.push(`skill ${s.name}: нет description — не доставлен; исправленную версию можно положить в слой проекта`); continue; }
    if (s.variants > 1) warnings.push(`skill ${s.name}: копии в репо расходятся (${s.variants} варианта), взят ${src.path}`);
    added.push({
      item: { name, dir: join(projectDir, src.path).replaceAll("\\", "/"), team: true, files, ...(fm.name !== name && { patch: { "SKILL.md": patchName(text, name) } }) },
      layer: `репо:${src.path}`,
    });
  }
  // auto: много недоступных агенту skills — каждый занимает место в контексте; решение за проектом
  if (setting.item === "auto" && added.length > AUTO_LIMIT) {
    warnings.push(
      `командных skills, которых ${agent} не видит: ${added.length} (больше ${AUTO_LIMIT}) — не доставлены; ` +
        "в слое проекта укажи import_skills: all или список имён",
    );
    return { cfg, warnings };
  }
  return { cfg: { ...cfg, skills: [...added, ...cfg.skills] }, warnings };
}

export const AUTO_LIMIT = 30;

export function formatTeamSkills(rel: string, r: ReturnType<typeof scanTeamSkills>, mine: AgentId[]): string {
  const out: string[] = [`Проект ${rel}`];
  if (!r.git) return out.concat("  не git-репо — командных skills нет").join("\n");
  if (!r.skills.length && !r.commands.length) return out.concat("  командных skills нет").join("\n");
  for (const s of r.skills) {
    const missing = mine.filter((a) => !s.seenBy.includes(a));
    out.push(
      `  ${s.name}  копий: ${s.copies.length}${s.variants > 1 ? `, РАЗНЫХ вариантов: ${s.variants}` : ""}` +
        `  видят: ${s.seenBy.join(", ") || "никто"}${missing.length ? `  не видят: ${missing.join(", ")}` : ""}`,
    );
    for (const c of s.copies) {
      out.push(`    ${c === s.source ? "*" : " "} ${c.path}  [${c.hash}]`);
      for (const i of c.issues) out.push(`        ! ${i}`);
      for (const w of c.warnings) out.push(`        ~ ${w}`);
    }
  }
  if (r.commands.length) out.push(`  команды (.md, не skills): ${r.commands.map((c) => c.path).join(", ")}`);
  out.push("  (* — источник для импорта; ! — ошибка, ~ — предупреждение)");
  return out.join("\n");
}
