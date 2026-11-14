// Круг 10a (справка): README разнесён на README.md и docs/*.md. Ссылки не должны вести в пустоту:
// - подсказки и комментарии src/, scripts/, install.sh, install.ps1 вида «(docs/roots.md, «Раздел»)», «README, «Раздел»», «README движка: «Раздел»» —
//   файл есть, заголовок с таким текстом есть; «…, сообщение «…»» — куски сообщения есть в файле;
// - markdown-ссылки [текст](файл#якорь) в документах движка — файл есть, якорь (по правилу GitHub) есть
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

const ENGINE = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ENGINE, p), "utf8");
const DOCS = ["README.md", "README.en.md", "CHANGELOG.md", "RELEASING.md", "DESIGN.md", "INSTALL-AGENT.md", "CONTRIBUTING.md",...readdirSync(join(ENGINE, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`)];

// Текст без блоков кода (```…```) — ссылки и заголовки в них не считаются
const prose = (text: string) => text.replace(/^```[\s\S]*?^```/gm, "");
const headings = (file: string) => [...prose(read(file)).matchAll(/^#{1,6} +(.+?) *#* *$/gm)].map((m) => m[1].trim());
// Якорь GitHub: нижний регистр, без разметки и знаков препинания (кроме - и _), пробел → -; повтор — суффикс -1, -2
function anchors(file: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const h of headings(file)) {
    const text = h.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*_]/g, (c) => (c === "_" ? "_" : ""));
    const base = text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/ /g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
}

describe("ссылки из программы и установщиков на документацию", () => {
  const refs: { at: string; file: string; kind: "раздел" | "сообщение"; text: string }[] = [];
  const walk = (d: string): string[] => readdirSync(join(ENGINE, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : e.name.endsWith(".ts") ? [`${d}/${e.name}`] : []));
  // Тексты для человека: программа, скрипты выпуска и установщики (их подсказки видят до установки — круг 10a-2)
  for (const f of [...walk("src"), ...walk("scripts"), "install.sh", "install.ps1"]) {
    read(f).split("\n").forEach((line, i) => {
      for (const m of line.matchAll(/\b(README|docs\/[a-z-]+\.md)(?: движка)?(?:,| —|:)? (?:раздел )?(?:\(?)«([^»]+)»(?:,? «([^»]+)»)?/g)) {
        const file = m[1] === "README" ? "README.md" : m[1];
        for (const t of [m[2], m[3]].filter(Boolean)) refs.push({ at: `${f}:${i + 1}`, file, kind: "раздел", text: t });
      }
      for (const m of line.matchAll(/\b(docs\/[a-z-]+\.md), сообщение «(.+?)»\)/g)) refs.push({ at: `${f}:${i + 1}`, file: m[1], kind: "сообщение", text: m[2] });
    });
  }

  test("ссылки найдены (проверка сама не пустая)", () => {
    expect(refs.length).toBeGreaterThan(10);
    expect(refs.some((r) => r.file.startsWith("docs/"))).toBe(true);
  });

  test("каждая ведёт на существующий файл и раздел", () => {
    const bad = refs.filter((r) => {
      if (!existsSync(join(ENGINE, r.file))) return true;
      if (r.kind === "сообщение") return !r.text.split("…").map((s) => s.trim().replace(/:$/, "")).filter((s) => s.length > 3).every((s) => read(r.file).includes(s));
      return !headings(r.file).includes(r.text);
    }).map((r) => `${r.at}: ${r.file} «${r.text}»`);
    expect(bad).toEqual([]);
  });
});

describe("ссылки внутри документации", () => {
  test("каждая [текст](файл#якорь) ведёт на существующий файл и заголовок", () => {
    const bad: string[] = [];
    for (const doc of DOCS) {
      for (const m of prose(read(doc)).matchAll(/\]\(([^)\s]+)\)/g)) {
        const href = m[1];
        if (/^(https?:|mailto:)/.test(href)) continue;
        const [path, anchor] = href.split("#");
        const target = path ? normalize(join(dirname(doc), decodeURIComponent(path))).replaceAll("\\", "/") : doc;
        if (!existsSync(join(ENGINE, target))) { bad.push(`${doc}: ${href} — нет файла ${target}`); continue; }
        if (anchor && target.endsWith(".md") && !anchors(target).has(decodeURIComponent(anchor))) bad.push(`${doc}: ${href} — нет раздела в ${relative(".", target)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("README ведёт на каждый файл docs/", () => {
    const readme = read("README.md");
    const missing = DOCS.filter((f) => f.startsWith("docs/") && !readme.includes(`](${f}`));
    expect(missing).toEqual([]);
  });
});
