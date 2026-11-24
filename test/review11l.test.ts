// Круг 11l: замечания независимой рецензии 11g–11k. miksy secret — место как у sync без пути (подпапка цели без git —
// слои цели), из служебного каталога — отказ, через ссылку на папку и в другом регистре — то же место; фильтр доставки
// — по цели ссылки, ссылка на файл секретов другого skill не доставляется; папка skill — ссылка наружу: skill не
// доставляется; строки с секретами — без текста строки; explain служебного пути не падает; doctor — не заданный
// секрет и широкая привязка — справка. Значения в тесте — искусственные
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { nakedInText } from "../src/secrets";
import { cliFixture, expectCode, gitInit, put } from "./helpers";

const WIN = process.platform === "win32";
const ACME = ["acme", "value", "11l", "Xy9"].join("-");
const TOOLS = ["tools", "value", "11l", "Kp4"].join("-");
const SUB = ["sub", "value", "11l", "Rt6"].join("-");
const PASS = ["Pa55", "word", "11l", "Zq"].join("");
const KEY = ["AbCd", "Ef12", "34Gh", "Ij56", "Kl78"].join("");

// Ссылка на файл: на Windows без прав разработчика не создаётся — проверка пропускается
const fileLink = (target: string, path: string): boolean => {
  try {
    symlinkSync(target, path);
    return true;
  } catch {
    return false;
  }
};
// Ссылка на папку: на Windows — junction (прав не нужно)
const dirLink = (target: string, path: string) => symlinkSync(target, path, WIN ? "junction" : "dir");

function fixture() {
  const f = cliFixture({ projects: ["Acme/app"] });
  put(`${f.config}/layers/tree/Acme/layer.yaml`, "skill_secrets: [ACME_TOKEN]\n");
  put(`${f.config}/layers/tree/Acme/tools/layer.yaml`, "target: true\nskill_secrets: [TOOLS_KEY]\n");
  put(`${f.config}/layers/tree/Acme/tools/sub/layer.yaml`, "skill_secrets: [SUB_KEY]\n");
  put(`${f.config}/local/secrets.env`, `ACME_TOKEN=${ACME}\nTOOLS_KEY=${TOOLS}\nSUB_KEY=${SUB}\n`);
  mkdirSync(`${f.ws}/Acme/tools/sub/deep`, { recursive: true });
  return f;
}

describe("11l: miksy secret — место", () => {
  test("подпапка цели без git (target: true) — слои цели, как у sync без пути, а не слои подпапки", () => {
    const f = fixture();
    for (const cwd of [`${f.ws}/Acme/tools`, `${f.ws}/Acme/tools/sub/deep`]) {
      const r = f.run(["secret", "TOOLS_KEY"], { cwd });
      expectCode(r, 0);
      expect(r.out).toBe(TOOLS);
    }
    const sub = f.run(["secret", "SUB_KEY"], { cwd: `${f.ws}/Acme/tools/sub` });
    expectCode(sub, 1);
    expect(sub.err).toContain("не объявлен для Acme/tools");
    expect(sub.out + sub.err).not.toContain(SUB);
  });

  test("служебный каталог — отказ без значения; ссылка на папку проекта — то же место", () => {
    const f = fixture();
    mkdirSync(`${f.config}/local/tmp`, { recursive: true });
    const svc = f.run(["secret", "ACME_TOKEN"], { cwd: `${f.config}/local/tmp` });
    expectCode(svc, 1);
    expect(svc.err).toContain("служебный каталог miksy");
    expect(svc.out + svc.err).not.toContain(ACME);
    dirLink(`${f.ws}/Acme/app`, `${f.dir}/app-link`);
    const viaLink = f.run(["secret", "ACME_TOKEN"], { cwd: `${f.dir}/app-link` });
    expectCode(viaLink, 0);
    expect(viaLink.out).toBe(ACME);
  });

  test.skipIf(!WIN)("Windows: путь в другом регистре — то же место", () => {
    const f = fixture();
    const r = f.run(["secret", "ACME_TOKEN"], { cwd: `${f.ws}/ACME/APP` });
    expectCode(r, 0);
    expect(r.out).toBe(ACME);
  });

  test("explain служебного каталога не падает: строка-пояснение вместо секретов", () => {
    const f = fixture();
    mkdirSync(`${f.config}/local/tmp`, { recursive: true });
    const r = f.run(["explain", `${f.config}/local/tmp`]);
    expectCode(r, 0);
    expect(r.out).toContain("Секреты для skills: служебный каталог miksy");
  });
});

describe("11l: фильтр доставки — по цели ссылки и по папке skill", () => {
  test("ссылка на git-ignored файл секретов: из своего skill — секретной копией, из чужого — не доставляется", () => {
    const f = cliFixture();
    const own = `${f.config}/layers/global/skills/notes`;
    const other = `${f.config}/layers/tree/Acme/skills/db`;
    put(`${own}/SKILL.md`, "---\nname: notes\ndescription: d\n---\nтело\n");
    put(`${own}/.env`, "OWN=1\n");
    put(`${other}/SKILL.md`, "---\nname: db\ndescription: d\n---\nтело\n");
    put(`${other}/.env`, "DB=1\n");
    gitInit(f.config);
    put(`${f.config}/.gitignore`, ".env\nlocal/\n");
    const foreign = fileLink(`${other}/.env`, `${own}/notes.txt`);
    const mine = fileLink(`${own}/.env`, `${own}/cfg.txt`);
    if (!foreign || !mine) return; // Windows без прав на ссылки
    const r = f.run(["sync", "--global"]);
    expectCode(r, 0);
    expect(r.out).toContain("skill notes: notes.txt — ссылка на файл секретов вне этого skill, не доставлена");
    expect(existsSync(`${f.home}/.claude/skills/notes/notes.txt`)).toBe(false);
    // Своя ссылка на свой файл секретов — как сам файл: секретная копия и строка о первой копии
    expect(existsSync(`${f.home}/.claude/skills/notes/cfg.txt`)).toBe(true);
    expect(r.out).toContain("skill notes: файл секретов cfg.txt скопирован");
    const d = f.run(["doctor"]);
    expect(d.out).toContain("Файлы skills не доставлены");
    expect(d.out).toContain("notes.txt — ссылка на файл секретов вне этого skill");
  });

  test("папка skill — ссылка (junction) наружу: skill не доставляется целиком; внутрь слоёв — доставляется", () => {
    const f = cliFixture();
    put(`${f.dir}/private/foo/SKILL.md`, "---\nname: foo\ndescription: d\n---\nтело\n");
    put(`${f.dir}/private/foo/config.json`, `{"token":"${KEY}"}\n`);
    put(`${f.config}/layers/shared/bar/SKILL.md`, "---\nname: bar\ndescription: d\n---\nтело\n");
    mkdirSync(`${f.config}/layers/global/skills`, { recursive: true });
    dirLink(`${f.dir}/private/foo`, `${f.config}/layers/global/skills/foo`);
    dirLink(`${f.config}/layers/shared/bar`, `${f.config}/layers/global/skills/bar`);
    const r = f.run(["sync", "--global"]);
    expectCode(r, 0);
    expect(r.out).toContain("skill foo: папка skill — ссылка за пределы слоёв конфигурации, skill не доставлен");
    expect(r.out).not.toContain("не исключён из git");
    expect(existsSync(`${f.home}/.claude/skills/foo`)).toBe(false);
    expect(existsSync(`${f.home}/.claude/skills/bar/SKILL.md`)).toBe(true);
    const d = f.run(["doctor"]);
    expect(d.out).toContain("skill foo: папка skill — ссылка за пределы слоёв конфигурации");
  });
});

describe("11l: секреты в тексте — без текста строки", () => {
  test("строка с двумя значениями: ни одно не в выводе; что найдено — вид и имя ключа", () => {
    const line = `{"url":"https://u:${PASS}@host","apiKey":"${KEY}","note":"обычный текст"}`;
    const found = nakedInText(`# skill\n${line}\n`);
    expect(found).toEqual([{ line: 2, text: "пароль в адресе, ключ apiKey" }]);
    const all = JSON.stringify(found);
    for (const v of [PASS, KEY, "обычный текст", "host"]) expect(all).not.toContain(v);
  });

  test("sync и doctor: файл и строка без значений", () => {
    const f = cliFixture();
    put(`${f.config}/layers/global/skills/deploy/SKILL.md`, `---\nname: deploy\ndescription: d\n---\n{"url":"https://u:${PASS}@h","apiKey":"${KEY}"}\n`);
    const s = f.run(["sync", "--global", "--dry-run"]);
    expect(s.out).toContain("layers/global/skills/deploy/SKILL.md:5: пароль в адресе, ключ apiKey");
    const d = f.run(["doctor"]);
    for (const out of [s.out + s.err, d.out + d.err]) for (const v of [PASS, KEY]) expect(out).not.toContain(v);
  });
});

describe("11l: doctor и sync — справка о skill_secrets", () => {
  test("объявленный, но не заданный — в «Справочно», не проблема", () => {
    const f = cliFixture();
    const before = f.run(["doctor"]);
    put(`${f.config}/layers/tree/Org/layer.yaml`, "skill_secrets: [ORG_MISSING]\n");
    const d = f.run(["doctor"]);
    expect(d.code).toBe(before.code);
    const info = d.out.indexOf("Справочно:");
    expect(info).toBeGreaterThan(-1);
    expect(d.out.indexOf("Секреты для skills не заданы (1)")).toBeGreaterThan(info);
    expect(d.out).toContain("layers/tree/Org/layer.yaml  skill_secrets: ORG_MISSING — нет в local/secrets.env");
  });

  test("привязка map.yaml с match шире одной организации и skill_secrets — предупреждение sync и справка doctor", () => {
    const f = cliFixture();
    put(`${f.config}/map.yaml`, "global:\n  - { use: global }\nlayers:\n  - { use: shared, match: \"*/p1\" }\n  - { use: own, match: \"Org/*\" }\n");
    put(`${f.config}/layers/shared/layer.yaml`, "skill_secrets: [SHARED_KEY]\n");
    put(`${f.config}/layers/own/layer.yaml`, "skill_secrets: [OWN_KEY]\n");
    const s = f.run(["sync", "--global", "--dry-run"]);
    expect(s.out).toContain("предупреждение: skill_secrets в слое привязки map.yaml с match шире одной организации");
    expect(s.out).toContain("map.yaml: layers[0] (match: */p1) → слой shared: SHARED_KEY");
    expect(s.out).not.toContain("слой own");
    const d = f.run(["doctor"]);
    expect(d.out).toContain("Секреты для skills в широкой привязке (1)");
    expect(d.out.indexOf("Секреты для skills в широкой привязке")).toBeGreaterThan(d.out.indexOf("Справочно:"));
  });
});
