// Круг 11g: перенос skill в слой (adopt, мастер setup) не уносит в git конфигурации файлы, похожие на секреты, и
// служебное; секреты открытым текстом в скопированных файлах показываются с маской, копирование не останавливается
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptSkill } from "../src/adopt";
import { nakedInText, skillFileKind } from "../src/secrets";
import { cliFixture, expectCode, put } from "./helpers";

// Значения похожих на настоящие токенов собираются по частям: в исходнике теста целого токена нет
const TOKEN = ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");
const KEY = ["Zx9", "Qw8Er7Ty6Ui5Op4As3Df2"].join("");

describe("11g: какие файлы skill не переносятся", () => {
  test("секреты по имени (без учёта регистра), образцы и .pub — переносятся, служебное — нет", () => {
    for (const n of [".env", ".ENV", ".env.local", ".env.production", ".envrc", "server.pem", "tls.KEY", "cert.p12", "cert.pfx",
      "app.jks", "id_rsa", "ID_RSA", "id_ed25519", "id_ecdsa_sk", ".npmrc", ".pypirc", ".netrc", "_netrc", ".pgpass",
      ".git-credentials", ".htpasswd", "credentials.json", "Credentials-prod.json", "client_secret_123.json",
      "service-account.json", "vault.kdbx", "secrets.env"])
      expect([n, skillFileKind(n, false)]).toEqual([n, "secret"]);
    for (const n of [".env.example", ".ENV.Sample", ".env.template", ".env.dist", "id_rsa.pub", "id_ed25519.PUB", "SKILL.md",
      "keys.md", "env.ts", "credentials.md", "monkey.txt", "README.md"])
      expect([n, skillFileKind(n, false)]).toEqual([n, null]);
    for (const n of [".DS_Store", "thumbs.db", "Desktop.ini"]) expect(skillFileKind(n, false)).toBe("junk");
    for (const n of [".git", "node_modules", "__pycache__", ".GIT"]) expect(skillFileKind(n, true)).toBe("junk");
    expect(skillFileKind("scripts", true)).toBeNull();
  });

  test("секреты в тексте: файл и строка, значение замаскировано; обычный текст и ссылки ${…} — без предупреждения", () => {
    const text = [
      "# skill", `token: ${TOKEN}`, `API_KEY=${KEY}`, "url: postgres://user:pa55word@db/x",
      "Authorization: Bearer ${GITHUB_TOKEN}", "api_key: ${API_KEY}", "author: Vladimir", "password: <ваш пароль>",
    ].join("\n");
    const found = nakedInText(text);
    expect(found.map((f) => f.line)).toEqual([2, 3, 4]);
    const all = JSON.stringify(found);
    for (const v of [TOKEN, KEY, "pa55word"]) expect(all).not.toContain(v);
    expect(found[1].text).toBe("API_KEY=<secret>");
  });
});

describe("11g: adopt skill", () => {
  const skill = (dir: string) => {
    put(`${dir}/SKILL.md`, "---\nname: tool\ndescription: d\n---\n");
    put(`${dir}/scripts/run.sh`, `#!/bin/sh\nexport API_KEY=${KEY}\n`);
    put(`${dir}/.env`, "A=1\n");
    put(`${dir}/.env.example`, "A=\n");
    put(`${dir}/sub/deeper/.ENV.local`, "A=1\n");
    put(`${dir}/keys/ID_RSA`, "x\n");
    put(`${dir}/keys/id_rsa.pub`, "ssh-ed25519 AAAA\n");
    put(`${dir}/.DS_Store`, "x");
    put(`${dir}/node_modules/x/index.js`, "x");
    put(`${dir}/.git/HEAD`, "ref: x\n");
  };

  test("функция: вложенные папки, план и копия совпадают", () => {
    const root = mkdtempSync(join(tmpdir(), "adopt11g-")).replaceAll("\\", "/");
    put(`${root}/layers/tree/.keep`, "");
    skill(`${root}/src`);
    const plan = adoptSkill(`${root}/src`, "tool", "workspace", root, true);
    expect(existsSync(`${root}/layers/tree/skills/tool`)).toBe(false);
    expect([...plan.files].sort()).toEqual([".env.example", "SKILL.md", "keys/id_rsa.pub", "scripts/run.sh"]);
    expect([...plan.secret].sort()).toEqual([".env", "keys/ID_RSA", "sub/deeper/.ENV.local"]);
    expect([...plan.junk].sort()).toEqual([".DS_Store", ".git/", "node_modules/"]);
    expect(plan.naked).toEqual(["scripts/run.sh:2: export API_KEY=<secret>"]);
    const done = adoptSkill(`${root}/src`, "tool", "workspace", root);
    expect(done).toEqual(plan);
    const dst = `${root}/layers/tree/skills/tool`;
    for (const f of plan.files) expect(existsSync(`${dst}/${f}`)).toBe(true);
    for (const f of [".env", "keys/ID_RSA", "sub/deeper/.ENV.local", ".DS_Store", "node_modules", ".git", "sub"])
      expect([f, existsSync(`${dst}/${f}`)]).toEqual([f, false]);
  });

  test("команда: --dry-run и запись говорят, что не скопировано и как перенести; значения в выводе нет", () => {
    const f = cliFixture({ agents: ["claude"] });
    skill(`${f.ws}/Org/p1/.claude/skills/tool`);
    const args = ["adopt", `${f.ws}/Org/p1`, "tool", "--to", "workspace"];
    const dry = f.run([...args, "--dry-run"]);
    expectCode(dry, 0);
    for (const r of [dry, f.run([...args, "--yes"])]) {
      expect(r.out).toContain("Не скопировано (похоже на секрет): .env, keys/ID_RSA, sub/deeper/.ENV.local");
      expect(r.out).toContain("docs/layers.md#секреты-в-skills");
      expect(r.out).toContain("Не скопировано (служебное): .DS_Store, .git/, node_modules/");
      expect(r.out).toContain("scripts/run.sh:2: export API_KEY=<secret>");
      expect(r.out).not.toContain(KEY);
    }
    expect(dry.out).toContain("--dry-run: ничего не записано.");
    expect(existsSync(`${f.config}/layers/tree/skills/tool/SKILL.md`)).toBe(true);
    expect(existsSync(`${f.config}/layers/tree/skills/tool/.env`)).toBe(false);
    expect(existsSync(`${f.config}/layers/tree/skills/tool/scripts/run.sh`)).toBe(true);
  }, 60000);
});
