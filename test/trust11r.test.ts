// Круг 11r: trust --confirm говорит правду — сохранено решение, а поставлено ли доверие, и что делать, если нет
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { cliFixture, expectCode, put } from "./helpers";
import { allow, trusted } from "./fixes021b-helpers";

const codexTrusted = (home: string, dir: string) => {
  const p = `${home}/.codex/config.toml`;
  const projects = existsSync(p) ? ((Bun.TOML.parse(readFileSync(p, "utf8")) as any).projects ?? {}) : {};
  return Object.entries(projects).some(([k, v]) => k.replaceAll("\\", "/").toLowerCase() === dir.toLowerCase() && (v as any).trust_level === "trusted");
};

describe("trust --confirm: исход доверия (круг 11r)", () => {
  test("файл цели в конфликте: «доверие не поставлено», файл и sync --force; код 3; --force ставит доверие", () => {
    const f = cliFixture({ agents: ["codex"], projects: ["Grp/p1"] });
    const g = `${f.ws}/Grp`;
    put(`${f.config}/layers/tree/Grp/layer.yaml`, "target: true\n");
    put(`${f.config}/layers/tree/mcp/ctx.yaml`, "name: ctx\ncommand: node\nargs: [x.js]\n");
    // Поддельная шапка miksy и чужая настройка (рецензия 6z, п. 4)
    put(`${g}/.codex/config.toml`, "# Сгенерировано miksy: подделка. Не править — miksy sync перезапишет.\nnotify = [\"my-notify\"]\n");
    f.run(["sync", "--all", "--yes"]);
    const c = f.run(["trust", g, "--agent", "codex", "--confirm"]);
    expectCode(c, 3);
    expect(c.out).toContain("решение «доверять» сохранено в local/trust.json");
    expect(c.out).not.toContain("— записано");
    expect(c.out).toContain(`Codex Grp: доверие не поставлено — в конфликте файл ${g}/.codex/config.toml. Перезаписать его файлом miksy (бэкап будет) и поставить доверие: miksy sync "${g}" --agent codex --force`);
    expect(codexTrusted(f.home, g)).toBe(false);
    const s = f.run(["sync", g, "--agent", "codex", "--force"]);
    expectCode(s, 0);
    expect(codexTrusted(f.home, g)).toBe(true);
  }, 120000);

  test("обычное «да» и «нет»: решение сохранено; доверие поставлено или нет — без «не поставлено»", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const p = `${f.ws}/Org/p1`;
    allow(p);
    f.run(["sync", p]);
    const c = f.run(["trust", p, "--confirm"]);
    expectCode(c, 0);
    expect(c.out).toContain("решение «доверять» сохранено в local/trust.json");
    expect(c.out).toMatch(/доверие Claude .*\(добавить\)/);
    expect(c.out).not.toContain("не поставлено");
    expect(trusted(f.home, p)).toBe(true);
    // Отказ (другой проект): решение сохранено, «не поставлено» не говорится — доверия и не просили
    const q = `${f.ws}/Org/p2`;
    Bun.spawnSync(["git", "init", "-q", q]);
    allow(q);
    f.run(["sync", q]);
    const d = f.run(["trust", q, "--deny"]);
    expectCode(d, 0);
    expect(d.out).toContain("решение «не доверять» сохранено в local/trust.json");
    expect(d.out).not.toContain("не поставлено");
    expect(trusted(f.home, q)).toBe(false);
  }, 120000);

  test("агент без доверия проекту — «решать нечего», а не «настроек не от miksy нет»", () => {
    const f = cliFixture({ agents: ["opencode"], projects: ["Org/p1"] });
    const c = f.run(["trust", `${f.ws}/Org/p1`, "--confirm"]);
    expectCode(c, 0);
    expect(c.out).toContain("У opencode нет доверия проекту — решать нечего.");
    expect(c.out).not.toContain("Исполняемых настроек");
  }, 60000);
});
