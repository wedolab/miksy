// Круг 11k: miksy secret <ИМЯ> — skill получает секрет из local/secrets.env в трубу. Только объявленные для места
// текущей папки (skill_secrets в layer.yaml слоёв: глобальные — везде, дерево — своим проектам); значение без перевода
// строки и больше ничего; отказ — без значения. Значения в тесте — искусственные
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadMachine } from "../src/load";
import { secretValue } from "../src/secretcmd";
import { cliFixture, expectCode, put, restoreEnv } from "./helpers";

const ACME = ["acme", "value", "11k", "Xy9"].join("-");
const OTHER = ["other", "value", "11k", "Qw7"].join("-");
const GLOBAL = ["global", "value", "11k", "Zz1"].join("-");
const values = [ACME, OTHER, GLOBAL];

function fixture() {
  const f = cliFixture({ projects: ["Acme/app", "Other/svc"] });
  put(`${f.config}/layers/global/layer.yaml`, "exclude: [skill.miksy]\nskill_secrets: [GLOBAL_KEY]\n");
  put(`${f.config}/layers/tree/Acme/layer.yaml`, "skill_secrets: [ACME_TOKEN, ACME_MISSING]\n");
  put(`${f.config}/layers/tree/Other/layer.yaml`, "skill_secrets: [OTHER_TOKEN]\n");
  put(`${f.config}/local/secrets.env`, `ACME_TOKEN=${ACME}\nOTHER_TOKEN=${OTHER}\nGLOBAL_KEY=${GLOBAL}\nUNDECLARED=${ACME}x\n`);
  mkdirSync(`${f.ws}/Acme/app/sub/deep`, { recursive: true });
  return f;
}

const noValue = (r: { out: string; err: string }) => {
  for (const v of values) {
    expect(r.out).not.toContain(v);
    expect(r.err).not.toContain(v);
  }
};

describe("miksy secret", () => {
  test("объявленный для места — значение без перевода строки и больше ничего; из подпапки — так же", () => {
    const f = fixture();
    for (const cwd of [`${f.ws}/Acme/app`, `${f.ws}/Acme/app/sub/deep`]) {
      const r = f.run(["secret", "ACME_TOKEN"], { cwd });
      expectCode(r, 0);
      expect(r.out).toBe(ACME);
      expect(r.err).toBe("");
    }
    // Объявленный в global — везде: в проекте любой организации и вне workspace
    expect(f.run(["secret", "GLOBAL_KEY"], { cwd: `${f.ws}/Other/svc` }).out).toBe(GLOBAL);
    expect(f.run(["secret", "GLOBAL_KEY"], { cwd: f.dir }).out).toBe(GLOBAL);
  });

  test("чужая организация, необъявленный, вне workspace — отказ без значения, с подсказкой, где объявить", () => {
    const f = fixture();
    const other = f.run(["secret", "OTHER_TOKEN"], { cwd: `${f.ws}/Acme/app` });
    expectCode(other, 1);
    expect(other.out).toBe("");
    expect(other.err).toContain("секрет OTHER_TOKEN не объявлен для Acme/app");
    expect(other.err).toContain("skill_secrets: [OTHER_TOKEN]");
    noValue(other);
    const undeclared = f.run(["secret", "UNDECLARED"], { cwd: `${f.ws}/Acme/app` });
    expectCode(undeclared, 1);
    expect(undeclared.out).toBe("");
    expect(undeclared.err).not.toContain(`${ACME}x`);
    const outside = f.run(["secret", "ACME_TOKEN"], { cwd: f.dir });
    expectCode(outside, 1);
    expect(outside.err).toContain("вне workspace");
    noValue(outside);
  });

  test("объявлен, но нет в secrets.env — понятная ошибка; имя не похоже на переменную — ошибка вызова", () => {
    const f = fixture();
    const r = f.run(["secret", "ACME_MISSING"], { cwd: `${f.ws}/Acme/app` });
    expectCode(r, 1);
    expect(r.err).toContain("секрет ACME_MISSING объявлен, но не задан в local/secrets.env");
    expect(r.out).toBe("");
    expectCode(f.run(["secret", "a-b"], { cwd: `${f.ws}/Acme/app` }), 2);
    expectCode(f.run(["secret"], { cwd: `${f.ws}/Acme/app` }), 2);
  });

  test("терминал: без --show отказ, с --show — значение", () => {
    const f = fixture();
    const saved = { ...process.env };
    try {
      process.env.MIKSY_CONFIG = f.config;
      const machine = loadMachine();
      expect(() => secretValue("ACME_TOKEN", `${f.ws}/Acme/app`, machine, true, false)).toThrow("значение в терминал не выводится");
      expect(secretValue("ACME_TOKEN", `${f.ws}/Acme/app`, machine, true, true)).toBe(ACME);
      expect(secretValue("ACME_TOKEN", `${f.ws}/Acme/app`, machine, false, false)).toBe(ACME);
    } finally {
      restoreEnv(saved);
    }
  });

  test("explain показывает имена и слои без значений; doctor — объявленный без значения", () => {
    const f = fixture();
    const e = f.run(["explain", `${f.ws}/Acme/app`]);
    expectCode(e, 0);
    expect(e.out).toContain("Секреты для skills (miksy secret; значения — в local/secrets.env)");
    expect(e.out).toMatch(/GLOBAL_KEY\s+global/);
    expect(e.out).toMatch(/ACME_TOKEN\s+Acme/);
    expect(e.out).toMatch(/ACME_MISSING\s+Acme\s+НЕТ в local\/secrets\.env/);
    expect(e.out).not.toContain("OTHER_TOKEN");
    noValue(e);
    const d = f.run(["doctor"]);
    expect(d.out).toContain("Секреты для skills не заданы (1)");
    expect(d.out).toContain("layers/tree/Acme/layer.yaml  skill_secrets: ACME_MISSING — нет в local/secrets.env");
    noValue(d);
  });

  test("неверный skill_secrets — ошибка слоя", () => {
    const f = fixture();
    put(`${f.config}/layers/tree/Acme/layer.yaml`, "skill_secrets: ACME_TOKEN\n");
    const r = f.run(["secret", "ACME_TOKEN"], { cwd: `${f.ws}/Acme/app` });
    expectCode(r, 1);
    expect(r.err).toContain("skill_secrets — список имён секретов");
  });

  // Windows: труба cmd передаёт байты как есть (в PowerShell 5.1 — нет: там строки и перевод строки; см. документацию)
  test.skipIf(process.platform !== "win32")("Windows: труба cmd доносит значение без перевода строки", () => {
    const f = fixture();
    const reader = `${f.dir}/reader.js`;
    put(reader, "let b='';process.stdin.on('data',d=>b+=d);process.stdin.on('end',()=>process.stdout.write(JSON.stringify(b)));\n");
    const bat = `${f.dir}/pipe.cmd`;
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    put(bat, `@"${process.execPath}" "${cli}" secret ACME_TOKEN | "${process.execPath}" "${reader}"\r\n`);
    const r = Bun.spawnSync(["cmd", "/c", bat], {
      cwd: `${f.ws}/Acme/app`,
      env: { ...process.env, MIKSY_CONFIG: f.config, HOME: f.home, USERPROFILE: f.home },
      stdout: "pipe", stderr: "pipe",
    });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout.toString())).toBe(ACME);
  });
});
