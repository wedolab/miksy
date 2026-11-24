// Круг 11h: doctor и sync замечают секреты в skills слоёв — файлы, похожие на секрет по имени, и секреты в тексте.
// Файл, который git конфигурации игнорирует, не сообщается (в репо не попадёт); конфигурация без git — сообщается всё.
// Значения не печатаются; совет — свой, не «${ИМЯ}» (в файлах skill подстановки нет)
import { describe, expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { layerSecrets } from "../src/load";
import { cliFixture, expectCode, gitInit, put } from "./helpers";

// Значения собираются из частей: в исходнике теста нет готового токена
const TOKEN = ["glpat", "skillvalue1234567890"].join("-");
const PASS = ["s3cr", "etPassw0rdXyz9Kq4"].join(""); // от 20 символов — иначе suspicious не сочтёт токеном

const skill = (config: string, name = "deploy") => `${config}/layers/global/skills/${name}`;

describe("секреты в skills слоёв", () => {
  test("текст и файл-секрет: путь и строка, значения скрыты; образцы, бинарные и ссылки — молчат", () => {
    const f = cliFixture();
    put(`${skill(f.config)}/SKILL.md`, `---\nname: deploy\n---\nвызов: curl -H "Authorization: Bearer ${TOKEN}"\n`);
    put(`${skill(f.config)}/scripts/run.sh`, `#!/bin/sh\nexport API_KEY=${PASS}\necho ok\n`);
    put(`${skill(f.config)}/.env`, "X=1\n");
    put(`${skill(f.config)}/.env.example`, `API_KEY=${PASS}\n`.replace(PASS, "changeme"));
    put(`${skill(f.config)}/node_modules/pkg/.env`, "X=1\n");
    put(`${f.config}/layers/tree/Org/skills/s/SKILL.md`, `db: postgres://u:${PASS}@host/db\n`);
    put(`${skill(f.config)}/blob.bin`, `\0${TOKEN}`);
    let linked = true;
    try {
      symlinkSync(`${skill(f.config)}/.env`, `${skill(f.config)}/link.env`);
    } catch {
      linked = false; // Windows без прав на ссылки — проверка ссылки пропускается
    }
    const r = layerSecrets(f.config);
    expect(r.mcp).toEqual([]);
    const paths = r.skills.map((l) => l.replace(/ — .*$|:\d+:.*$/, ""));
    expect(paths).toEqual([
      "layers/global/skills/deploy/.env",
      "layers/global/skills/deploy/scripts/run.sh", // порядок — localeCompare, без учёта регистра
      "layers/global/skills/deploy/SKILL.md",
      "layers/tree/Org/skills/s/SKILL.md",
    ]);
    expect(r.skills).toContain("layers/global/skills/deploy/SKILL.md:4: токен Bearer");
    expect(r.skills).toContain("layers/global/skills/deploy/scripts/run.sh:2: ключ API_KEY");
    const all = r.skills.join("\n");
    for (const v of [TOKEN, PASS]) expect(all).not.toContain(v);
    if (linked) expect(all).not.toContain("link.env");
  });

  test("игнорируемое git конфигурации молчит, отслеживаемое — нет; без git — всё", () => {
    const f = cliFixture();
    put(`${skill(f.config)}/.env`, "X=1\n");
    put(`${skill(f.config, "other")}/.env`, "X=1\n");
    put(`${skill(f.config, "other")}/SKILL.md`, `token: ${TOKEN}\n`);
    // Без git — сообщается всё
    expect(layerSecrets(f.config).skills.length).toBe(3);
    gitInit(f.config);
    put(`${f.config}/.gitignore`, ".env\nlayers/global/skills/other/SKILL.md\n");
    const r = layerSecrets(f.config).skills;
    expect(r).toEqual([]);
    // Отслеживаемый файл уйдёт в репо, хоть он и в .gitignore
    const add = Bun.spawnSync(["git", "-C", f.config, "add", "-f", "layers/global/skills/deploy/.env"]);
    expect(add.exitCode).toBe(0);
    expect(layerSecrets(f.config).skills).toEqual(["layers/global/skills/deploy/.env — файл с секретами (по имени)"]);
  });

  test("sync и doctor предупреждают своим советом, значение не печатают", () => {
    const f = cliFixture();
    put(`${skill(f.config)}/SKILL.md`, `---\nname: deploy\n---\nAPI_TOKEN=${PASS}\n`);
    put(`${skill(f.config)}/.env`, "X=1\n");
    const s = f.run(["sync", "--global", "--dry-run"]);
    expect(s.out).toContain("ВНИМАНИЕ: секреты в skills слоёв");
    expect(s.out).toContain("layers/global/skills/deploy/SKILL.md:4: ключ API_TOKEN");
    expect(s.out).toContain("layers/global/skills/deploy/.env — файл с секретами");
    expect(s.out).toContain("docs/layers.md#секреты-в-skills");
    expect(s.out).not.toContain("в слое оставьте");
    expect(s.out).not.toContain(PASS);
    const d = f.run(["doctor"]);
    expectCode(d, 1);
    expect(d.out).toContain("Секреты в skills слоёв (2)");
    expect(d.out).toContain("layers/global/skills/deploy/SKILL.md:4: ключ API_TOKEN");
    expect(d.out).not.toContain("Секреты открытым текстом в слоях");
    expect(d.out).not.toContain(PASS);
  });
});
