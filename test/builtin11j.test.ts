// Круг 11j: встроенный skill miksy — поставляется движком (builtin/), раздаётся sync --global. Свой skills/miksy в
// глобальном слое заменяет его, exclude: [skill.miksy] выключает. Неизменённая копия прежнего образца не действует
// (doctor подсказывает удалить), изменённая — заменяет и «может отставать» (doctor; sync — когда встроенный сменился)
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN_DIR, CURRENT, PAST, skillHash } from "../src/builtin";
import { ENGINE } from "../src/load";
import { cliFixture, expectCode, put } from "./helpers";

const SKILL = join(BUILTIN_DIR, "skills", "miksy", "SKILL.md");
const builtinText = () => readFileSync(SKILL, "utf8");
const own = (config: string) => `${config}/layers/global/skills/miksy`;

describe("встроенный skill miksy", () => {
  test("сторож: хеш builtin/skills/miksy совпадает с CURRENT", () => {
    const h = skillHash(join(BUILTIN_DIR, "skills", "miksy"));
    if (h !== CURRENT)
      throw new Error(
        `builtin/skills/miksy изменён, а src/builtin.ts — нет. Допишите прежний хеш ${CURRENT} в PAST (с пометкой версии), ` +
          `а в CURRENT поставьте новый: ${h}. Иначе у пользователей неизменённые копии прежней версии будут считаться своими`,
      );
    expect(PAST).not.toContain(CURRENT);
  });

  test("прежние версии образца из истории git (если она есть) — в PAST", () => {
    // 0.1.0, 0.2.0, 0.2.1, 0.3.0–0.6.0, до 0.1.0: blob-и examples/config/layers/global/skills/miksy/SKILL.md
    const blobs = ["f14fc4360f33f377f1d3159d00c7387212f1f81d", "d3d7d96fe780109dec220fedb6254af38977e8bb", "0dbc3fcc6afb7f680d0110fde0cb7f1bd2e7f807",
      "e41ccbd8588dc1281a5648e6d18f0f030c702403", "1f070b5ab1dac5eb23953bed83a8584f3f5a9aa1"];
    for (const b of blobs) {
      const r = Bun.spawnSync(["git", "-C", ENGINE, "cat-file", "blob", b], { stdout: "pipe", stderr: "pipe" });
      if (r.exitCode !== 0) continue; // клон без истории (CI) — проверить нечем
      const f = cliFixture();
      put(`${f.dir}/old/SKILL.md`, r.stdout.toString());
      expect([b, PAST.includes(skillHash(`${f.dir}/old`))]).toEqual([b, true]);
    }
  });

  test("доставляется глобально всем агентам; explain --global показывает слой; exclude выключает", () => {
    const f = cliFixture({ builtin: true, agents: ["claude", "codex"] });
    const s = f.run(["sync", "--global"]);
    expectCode(s, 0);
    for (const dir of [".claude/skills", ".agents/skills"]) expect(readFileSync(`${f.home}/${dir}/miksy/SKILL.md`, "utf8")).toBe(builtinText());
    const e = f.run(["explain", "--global"]);
    expect(e.out).toContain("miksy (встроенный) → global");
    expect(e.out).toMatch(/miksy\s+miksy \(встроенный\)/);
    // Выключить: exclude в глобальном слое — доставленное sync убирает по учёту
    put(`${f.config}/layers/global/layer.yaml`, "exclude: [skill.miksy]\n");
    expectCode(f.run(["sync", "--global"]), 0);
    expect(existsSync(`${f.home}/.claude/skills/miksy/SKILL.md`)).toBe(false);
    // Проекты встроенный не получают
    expectCode(f.run(["sync", `${f.ws}/Org/p1`]), 0);
    expect(existsSync(`${f.ws}/Org/p1/.claude/skills/miksy`)).toBe(false);
  });

  test("неизменённая копия (в том числе CRLF и BOM) не действует: доставляется встроенный, doctor подсказывает git rm", () => {
    const f = cliFixture({ builtin: true });
    put(`${own(f.config)}/SKILL.md`, "﻿" + builtinText().replace(/\n/g, "\r\n"));
    expectCode(f.run(["sync", "--global"]), 0);
    expect(readFileSync(`${f.home}/.claude/skills/miksy/SKILL.md`, "utf8")).toBe(builtinText());
    const e = f.run(["explain", "--global"]);
    expect(e.out).toContain("неизменённая копия прежнего образца, не действует (действует встроенный)");
    const d = f.run(["doctor"]);
    expect(d.out).toContain("layers/global/skills/miksy — неизменённая копия прежнего образца skill miksy: не действует");
    expect(d.out).toContain("rm -r layers/global/skills/miksy");
  });

  test("своя замена: доставляется она; doctor — «может отставать»; sync — строка только при смене встроенного", () => {
    const f = cliFixture({ builtin: true });
    put(`${own(f.config)}/SKILL.md`, "---\nname: miksy\ndescription: мой\n---\nсвой текст\n");
    const first = f.run(["sync", "--global"]);
    expectCode(first, 0);
    expect(first.out).toContain("layers/global/skills/miksy заменяет встроенный skill miksy и может отставать от него");
    expect(first.out).toContain("git diff --no-index");
    expect(readFileSync(`${f.home}/.claude/skills/miksy/SKILL.md`, "utf8")).toContain("свой текст");
    // Встроенный не менялся — повторный sync молчит
    expect(f.run(["sync", "--global"]).out).not.toContain("заменяет встроенный");
    // «Встроенный сменился» (в учёте другой хеш) — строка снова, один раз; --dry-run учёт не меняет
    const manifest = `${f.config}/local/state/manifest.json`;
    const m = JSON.parse(readFileSync(manifest, "utf8"));
    put(manifest, JSON.stringify({ ...m, builtinSkill: "0".repeat(64) }, null, 2));
    expect(f.run(["sync", "--global", "--dry-run"]).out).toContain("заменяет встроенный");
    expect(f.run(["sync", "--global"]).out).toContain("заменяет встроенный");
    expect(f.run(["sync", "--global"]).out).not.toContain("заменяет встроенный");
    expect(f.run(["doctor"]).out).toContain("заменяет встроенный skill miksy и может отставать");
  });

  test("переход учёта: своя копия убрана — встроенный пишется обновлением, без конфликта", () => {
    const f = cliFixture({ builtin: true, agents: ["claude", "codex"] });
    put(`${own(f.config)}/SKILL.md`, "---\nname: miksy\ndescription: старый\n---\nстарый текст\n");
    expectCode(f.run(["sync", "--global"]), 0);
    rmSync(own(f.config), { recursive: true });
    const r = f.run(["sync", "--global"]);
    expectCode(r, 0);
    expect(r.out).not.toContain("КОНФЛИКТ");
    for (const dir of [".claude/skills", ".agents/skills"]) expect(readFileSync(`${f.home}/${dir}/miksy/SKILL.md`, "utf8")).toBe(builtinText());
  });

  test("образец конфигурации (setup) больше не содержит skill miksy", () => {
    expect(existsSync(join(ENGINE, "examples", "config", "layers", "global", "skills", "miksy"))).toBe(false);
    expect(existsSync(SKILL)).toBe(true);
  });
});
