// Круг 10f: минимум Bun 1.4.3 (ошибка spawnSync в Bun до 1.4.3, oven-sh/bun#44581). Старый Bun не ломает miksy —
// doctor только предупреждает; версия Bun подменяется параметром, настоящий старый Bun не нужен
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { doctor } from "../src/doctor";
import { loadMachine } from "../src/load";
import { agentsFor } from "../src/registry";
import { MIN_BUN, oldBun } from "../src/version";
import { cliFixture } from "./helpers";

const WARN = "в версиях до 1.4.3 бывают редкие сбои запуска git. Обновите: bun upgrade";

describe("старый Bun", () => {
  test("минимум совпадает с engines в package.json", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { engines: { bun: string } };
    expect(pkg.engines.bun).toBe(`>=${MIN_BUN}`);
  });

  test("oldBun: до 1.4.3 — текст с версией, 1.4.3 и новее (и сборки canary) — ничего", () => {
    expect(oldBun("1.3.14")).toBe(`Bun 1.3.14 устарел: ${WARN}`);
    expect(oldBun("1.4.2")).toContain("Bun 1.4.2 устарел");
    expect(oldBun("0.9.0")).toContain("устарел");
    for (const v of ["1.4.3", "1.4.4", "1.5.0", "2.0.0", "1.4.3-canary.1+620b50f6a"]) expect(oldBun(v)).toBeNull();
    // Нечитаемая версия — не повод пугать
    expect(oldBun("")).toBeNull();
  });

  const saved = { config: process.env.MIKSY_CONFIG, home: process.env.HOME, profile: process.env.USERPROFILE };
  afterEach(() => {
    for (const [k, v] of [["MIKSY_CONFIG", saved.config], ["HOME", saved.home], ["USERPROFILE", saved.profile]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  test("doctor: старый Bun — предупреждение, не проблема; новый — без предупреждения", () => {
    const f = cliFixture();
    process.env.MIKSY_CONFIG = f.config;
    process.env.HOME = f.home;
    process.env.USERPROFILE = f.home;
    const machine = loadMachine(f.config);
    const old = doctor(agentsFor(machine), machine, false, "1.4.2");
    const fresh = doctor(agentsFor(machine), machine, false, "1.4.3");
    expect(old.text).toContain(`Предупреждение: Bun 1.4.2 устарел: ${WARN}.`);
    expect(fresh.text).not.toContain("устарел");
    // Код выхода doctor — от числа проблем: старый Bun его не меняет
    expect(old.problems).toBe(fresh.problems);
  }, 30000);
});
