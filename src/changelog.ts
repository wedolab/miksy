// CHANGELOG.md движка: разбор записей по версиям — для miksy update (что изменилось между версиями) и
// команды выпуска scripts/release.ts (номер следующей версии, запись «Не выпущено» → «X.Y.Z — дата").
// Формат (DESIGN §12): «## Не выпущено» сверху, затем «## X.Y.Z — ГГГГ-ММ-ДД» от новых к старым; внутри
// записи — разделы «### Новое», «### Исправлено», «### Ломает», «### После обновления»
// Без зависимостей от остального движка: модуль использует и scripts/release.ts

export const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

// Сравнение номеров X.Y.Z (можно с «v»): <0 — a старше b. Не номер — считается 0.0.0
export function compareVersions(a: string, b: string): number {
  const p = (v: string) => (SEMVER.exec(v.replace(/^v/, "")) ?? [0, 0, 0, 0]).slice(1).map(Number);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

export const SECTIONS = ["Новое", "Исправлено", "Ломает", "После обновления"] as const;
export type Section = (typeof SECTIONS)[number];
export const UNRELEASED = "Не выпущено";

export type Entry = {
  version: string | null; // null — «Не выпущено»
  date?: string;
  sections: Partial<Record<Section, string[]>>; // строки раздела (без пустых по краям)
  loose: string[]; // текст записи вне разделов
};

const HEAD = /^## (.+?)\s*$/;
const ENTRY = new RegExp(`^(?:${UNRELEASED}|(\\d+\\.\\d+\\.\\d+)(?: — (\\d{4}-\\d{2}-\\d{2}))?)$`);
const SUB = /^### (.+?)\s*$/;

const trim = (lines: string[]) => {
  let a = 0, b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
};

// Записи по порядку файла. Непонятный заголовок записи или раздела — ошибка с номером строки
export function parseChangelog(text: string): { intro: string[]; entries: Entry[] } {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const intro: string[] = [];
  const entries: Entry[] = [];
  let cur: Entry | null = null;
  let sec: Section | null = null;
  lines.forEach((line, i) => {
    const h = HEAD.exec(line);
    if (h) {
      const m = ENTRY.exec(h[1]);
      if (!m) throw new Error(`CHANGELOG.md, строка ${i + 1}: заголовок «${h[1]}» — ожидается «${UNRELEASED}» или «X.Y.Z — ГГГГ-ММ-ДД»`);
      cur = { version: m[1] ?? null, ...(m[2] && { date: m[2] }), sections: {}, loose: [] };
      entries.push(cur);
      sec = null;
      return;
    }
    if (!cur) { intro.push(line); return; }
    const s = SUB.exec(line);
    if (s) {
      if (!(SECTIONS as readonly string[]).includes(s[1])) throw new Error(`CHANGELOG.md, строка ${i + 1}: раздел «${s[1]}» — допустимы ${SECTIONS.join(", ")}`);
      sec = s[1] as Section;
      (cur as Entry).sections[sec] ??= [];
      return;
    }
    if (sec) (cur as Entry).sections[sec]!.push(line);
    else (cur as Entry).loose.push(line);
  });
  for (const e of entries) {
    for (const k of Object.keys(e.sections) as Section[]) e.sections[k] = trim(e.sections[k]!);
    e.loose = trim(e.loose);
  }
  return { intro: trim(intro), entries };
}

export const hasSection = (e: Entry, s: Section) => (e.sections[s] ?? []).some((l) => l.trim());
export const isEmpty = (e: Entry) => !SECTIONS.some((s) => hasSection(e, s)) && !e.loose.length;

// Записи выпущенных версий в (from, to] — от новой к старой; from null — все до to
export function entriesBetween(entries: Entry[], from: string | null, to: string): Entry[] {
  return entries.filter((e) => e.version && compareVersions(e.version, to) <= 0 && (!from || compareVersions(e.version, from) > 0))
    .sort((a, b) => compareVersions(b.version!, a.version!));
}

// Следующий номер по записи «Не выпущено» (SemVer): 0.x — «Ломает» или «Новое» → MINOR, иначе PATCH;
// с 1.0 — «Ломает» → MAJOR, «Новое» → MINOR, иначе PATCH. Пустая запись — null (выпускать нечего)
export function nextVersion(current: string, e: Entry): string | null {
  if (isEmpty(e)) return null;
  const m = SEMVER.exec(current);
  if (!m) throw new Error(`версия «${current}» — не X.Y.Z`);
  const [M, n, p] = m.slice(1).map(Number);
  if (hasSection(e, "Ломает")) return M === 0 ? `0.${n + 1}.0` : `${M + 1}.0.0`;
  if (hasSection(e, "Новое")) return `${M}.${n + 1}.0`;
  return `${M}.${n}.${p + 1}`;
}

// Текст записи для показа и GitHub Release: только непустые разделы
export function entryText(e: Entry, opts: { title?: boolean } = {}): string {
  const out: string[] = [];
  if (opts.title !== false) out.push(`## ${e.version ? `${e.version}${e.date ? ` — ${e.date}` : ""}` : UNRELEASED}`, "");
  if (e.loose.length) out.push(...e.loose, "");
  for (const s of SECTIONS) if (hasSection(e, s)) out.push(`### ${s}`, "", ...e.sections[s]!, "");
  return out.join("\n").trimEnd();
}

// Пустая запись «Не выпущено» — шаблон: разделы без строк
export const unreleasedTemplate = () => [`## ${UNRELEASED}`, "", ...SECTIONS.flatMap((s) => [`### ${s}`, ""])].join("\n");

// Выпуск: «Не выпущено» → «X.Y.Z — дата» (только непустые разделы), сверху — новая пустая «Не выпущено».
// Текст вокруг записей (вступление, остальные записи) не меняется
export function releaseText(text: string, version: string, date: string): string {
  const { entries } = parseChangelog(text);
  const un = entries.find((e) => e.version === null);
  if (!un) throw new Error(`в CHANGELOG.md нет записи «${UNRELEASED}»`);
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## ${UNRELEASED}`);
  let end = lines.findIndex((l, i) => i > start && HEAD.test(l));
  if (end < 0) end = lines.length;
  const released = entryText({ ...un, version, date });
  const tail = lines.slice(end);
  return [...lines.slice(0, start), unreleasedTemplate(), released, ...(tail.length ? ["", ...tail] : [""])].join("\n");
}
