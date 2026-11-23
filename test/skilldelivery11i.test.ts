// Круг 11i: фильтр доставки skills слоёв агентам. Служебное (.DS_Store, .git) — не доставляется, node_modules и
// __pycache__ — доставляются; ссылка внутри слоёв конфигурации — копией, наружу и битая — нет (с предупреждением);
// файл-секрет — только если git конфигурации его игнорирует (тогда 0600 на macOS/Linux), иначе нет (с предупреждением).
// Ранее доставленное, что теперь не доставляется, sync убирает по учёту
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { cliFixture, expectCode, gitInit, put } from "./helpers";

const POSIX = process.platform !== "win32";
// Ссылки на Windows без прав разработчика не создаются — эти проверки там пропускаются
const link = (target: string, path: string): boolean => {
  try {
    symlinkSync(target, path);
    return true;
  } catch {
    return false;
  }
};

const AGENT_DIRS = { claude: ".claude/skills", codex: ".agents/skills", antigravity: ".gemini/config/skills" };

describe("доставка skills слоёв агентам", () => {
  test("каждая строка таблицы: глобально, Claude, Codex, Antigravity", () => {
    const f = cliFixture({ agents: Object.keys(AGENT_DIRS) });
    const s = `${f.config}/layers/global/skills/deploy`;
    put(`${s}/SKILL.md`, "---\nname: deploy\ndescription: d\n---\nтело\n");
    put(`${s}/scripts/run.sh`, "echo ok\n");
    put(`${s}/node_modules/pkg/index.js`, "module.exports = 1;\n");
    put(`${s}/__pycache__/m.txt`, "cache\n");
    put(`${s}/.DS_Store`, "junk\n");
    put(`${s}/Thumbs.db`, "junk\n");
    put(`${s}/.git/config`, "[core]\n");
    put(`${s}/.env`, "X=1\n");
    put(`${s}/.env.example`, "X=\n");
    put(`${f.config}/layers/global/shared.txt`, "общий текст\n");
    put(`${f.dir}/outside/key.txt`, "снаружи\n");
    const inner = link(`${f.config}/layers/global/shared.txt`, `${s}/shared.txt`);
    const outer = link(`${f.dir}/outside/key.txt`, `${s}/outside.txt`);
    const broken = link(`${f.dir}/nowhere.txt`, `${s}/broken.txt`);

    const r = f.run(["sync", "--global"]);
    expectCode(r, 0);
    expect(r.out).toContain("skill deploy: .env похож на секрет и не исключён из git конфигурации — не доставлен");
    if (outer) expect(r.out).toContain("skill deploy: outside.txt — ссылка за пределы слоёв конфигурации, не доставлена");
    if (broken) expect(r.out).toContain("skill deploy: broken.txt — ссылка битая, не доставлена");
    for (const dir of Object.values(AGENT_DIRS)) {
      const d = `${f.home}/${dir}/deploy`;
      for (const p of ["SKILL.md", "scripts/run.sh", "node_modules/pkg/index.js", "__pycache__/m.txt", ".env.example"])
        expect([dir, p, existsSync(`${d}/${p}`)]).toEqual([dir, p, true]);
      for (const p of [".DS_Store", "Thumbs.db", ".git/config", ".env", "outside.txt", "broken.txt"])
        expect([dir, p, existsSync(`${d}/${p}`)]).toEqual([dir, p, false]);
      if (inner) expect(readFileSync(`${d}/shared.txt`, "utf8")).toBe("общий текст\n");
    }
  });

  test(".env, который git конфигурации игнорирует, доставляется с 0600; перестал игнорироваться — sync его убирает", () => {
    const f = cliFixture();
    const s = `${f.config}/layers/global/skills/deploy`;
    put(`${s}/SKILL.md`, "---\nname: deploy\ndescription: d\n---\nтело\n");
    put(`${s}/.env`, "X=1\n");
    gitInit(f.config);
    put(`${f.config}/.gitignore`, ".env\nlocal/\n");
    const delivered = `${f.home}/.claude/skills/deploy/.env`;
    const r = f.run(["sync", "--global"]);
    expectCode(r, 0);
    expect(r.out).not.toContain("похож на секрет");
    expect(readFileSync(delivered, "utf8")).toBe("X=1\n");
    if (POSIX) expect(statSync(delivered).mode & 0o777).toBe(0o600);

    // Убрали из .gitignore (файл уйдёт в git) — больше не доставляется, доставленный раньше убирается без конфликта
    put(`${f.config}/.gitignore`, "local/\n");
    const again = f.run(["sync", "--global"]);
    expectCode(again, 0);
    expect(again.out).toContain("skill deploy: .env похож на секрет");
    expect(existsSync(delivered)).toBe(false);
    expect(existsSync(`${f.home}/.claude/skills/deploy/SKILL.md`)).toBe(true);
  });

  // 11i-2: доставленный файл-секрет — отступление от «секреты только в local/»: sync говорит об этом один раз на
  // новую цель, doctor — в «Справочно» (не проблема), сколько мест получили копию
  test("копии файла-секрета: строка sync только при первой доставке в цель, doctor — «Справочно» с числом мест", () => {
    const f = cliFixture({ agents: ["claude", "codex"], projects: ["Org/p1", "Org/p2"] });
    const s = `${f.config}/layers/tree/Org/skills/deploy`;
    put(`${s}/SKILL.md`, "---\nname: deploy\ndescription: d\n---\nтело\n");
    put(`${s}/.env`, "VALUE-11i2-copy\n");
    gitInit(f.config);
    put(`${f.config}/.gitignore`, ".env\nlocal/\n");
    const first = f.run(["sync", `${f.ws}/Org/p1`]);
    expectCode(first, 0);
    const line = (out: string) => out.split("\n").filter((l) => l.includes("файл секретов .env скопирован в"));
    expect(line(first.out).length).toBe(2); // claude и codex
    expect(first.out).toContain("секрет хранится не только в local/secrets.env");
    expect(first.out).not.toContain("VALUE-11i2-copy");
    // Повторный sync той же цели — строки нет
    expect(line(f.run(["sync", `${f.ws}/Org/p1`]).out)).toEqual([]);
    // Новая цель — снова одна строка на агента
    expect(line(f.run(["sync", `${f.ws}/Org/p2`]).out).length).toBe(2);

    const d = f.run(["doctor"]);
    expect(d.out).toContain("Файлы секретов skills разложены по целям (секрет хранится не только в local/secrets.env;");
    expect(d.out).toContain("  deploy/.env → 4 места");
    expect(d.out).not.toContain("VALUE-11i2-copy");
    // Справочно, не проблема: раздел — после строки «Справочно»
    const info = d.out.indexOf("Справочно");
    expect(info).toBeGreaterThan(-1);
    expect(d.out.indexOf("Файлы секретов skills разложены")).toBeGreaterThan(info);
  });

  test("отслеживаемый .env не доставляется, хоть он и в .gitignore; проект — так же", () => {
    const f = cliFixture();
    const s = `${f.config}/layers/tree/Org/skills/deploy`;
    put(`${s}/SKILL.md`, "---\nname: deploy\ndescription: d\n---\nтело\n");
    put(`${s}/.env`, "X=1\n");
    gitInit(f.config);
    put(`${f.config}/.gitignore`, ".env\nlocal/\n");
    expect(Bun.spawnSync(["git", "-C", f.config, "add", "-f", "layers/tree/Org/skills/deploy/.env"]).exitCode).toBe(0);
    const r = f.run(["sync", `${f.ws}/Org/p1`]);
    expectCode(r, 0);
    expect(r.out).toContain("skill deploy: .env похож на секрет и не исключён из git конфигурации");
    expect(existsSync(`${f.ws}/Org/p1/.claude/skills/deploy/SKILL.md`)).toBe(true);
    expect(existsSync(`${f.ws}/Org/p1/.claude/skills/deploy/.env`)).toBe(false);
  });

  test("explain показывает то же предупреждение", () => {
    const f = cliFixture();
    const s = `${f.config}/layers/global/skills/deploy`;
    put(`${s}/SKILL.md`, "---\nname: deploy\ndescription: d\n---\nтело\n");
    put(`${s}/id_rsa`, "PRIVATE-11i-value\n");
    mkdirSync(`${f.home}`, { recursive: true });
    const r = f.run(["explain", "--global"]);
    expectCode(r, 0);
    expect(r.out).toContain("skill deploy: id_rsa похож на секрет");
    expect(r.out).not.toContain("PRIVATE-11i-value");
  });

  test("doctor: ссылка наружу — раздел «Файлы skills не доставлены», одна строка на файл", () => {
    const f = cliFixture({ agents: ["claude", "codex"] });
    const s = `${f.config}/layers/global/skills/deploy`;
    put(`${s}/SKILL.md`, "---\nname: deploy\ndescription: d\n---\nтело\n");
    put(`${f.dir}/outside/key.txt`, "снаружи\n");
    if (!link(`${f.dir}/outside/key.txt`, `${s}/outside.txt`)) return;
    const d = f.run(["doctor"]);
    expectCode(d, 1);
    expect(d.out).toContain("Файлы skills не доставлены (1)");
    expect(d.out).toContain("skill deploy: outside.txt — ссылка за пределы слоёв конфигурации, не доставлена");
  });

  // 11i-2: граница ссылок — <конфигурация>/layers, не вся конфигурация. Ссылка с невинным именем на local/secrets.env
  // (skillFileKind её не узнает) увезла бы секреты в каждый проект; на map.yaml — тоже не доставляется
  test("ссылка token → local/secrets.env и ссылка на map.yaml не доставляются", () => {
    const f = cliFixture();
    const s = `${f.config}/layers/global/skills/deploy`;
    put(`${s}/SKILL.md`, "---\nname: deploy\ndescription: d\n---\nтело\n");
    put(`${f.config}/local/secrets.env`, "TOKEN=SECRET-11i2-value\n");
    if (!link(`${f.config}/local/secrets.env`, `${s}/token`)) return; // Windows без прав на ссылки — проверяют Mac и Linux
    link(`${f.config}/map.yaml`, `${s}/map.yaml`);
    const r = f.run(["sync", "--global"]);
    expectCode(r, 0);
    expect(r.out).toContain("skill deploy: token — ссылка за пределы слоёв конфигурации, не доставлена");
    expect(r.out).toContain("skill deploy: map.yaml — ссылка за пределы слоёв конфигурации, не доставлена");
    expect(r.out).not.toContain("SECRET-11i2-value");
    expect(existsSync(`${f.home}/.claude/skills/deploy/token`)).toBe(false);
    expect(existsSync(`${f.home}/.claude/skills/deploy/map.yaml`)).toBe(false);
    expect(existsSync(`${f.home}/.claude/skills/deploy/SKILL.md`)).toBe(true);
  });
});
