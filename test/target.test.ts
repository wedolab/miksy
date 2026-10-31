// Цели без git: каталоги без git на уровне проектов (подсказка в sync --all и doctor) и команда
// miksy target [<путь>] [--remove] [--dry-run] — пометка target: true в layer.yaml слоя дерева
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import type { Ask } from "../src/ask";
import { runCommand } from "../src/commands";
import { cliFixture, put } from "./helpers";

const real = (p: string) => realpathSync.native(p).replaceAll("\\", "/");
const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : null);

test("explain: каталог вне workspace — глобальный срез без ошибки", () => {
  const f = cliFixture();
  mkdirSync(`${f.dir}/elsewhere`);
  const r = f.run(["explain", `${f.dir}/elsewhere`]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("вне workspace — только глобальные настройки");
  expect(r.out).toContain("global");
  expect(r.out).not.toContain("см. `miksy explain` без пути");
}, 30000);

// Проекты Acme/app, Studio/site, Acme/withrepo/inner; слои Acme и Org (группа Org с проектом Org/svc);
// каталоги без git — на уровне проектов и там, где их искать не нужно
function fixture(agents = ["claude"]) {
  const f = cliFixture({ agents, projects: ["Acme/app", "Studio/site", "Org/svc", "Acme/withrepo/inner"] });
  put(`${f.config}/layers/tree/Acme/instructions/10-acme.md`, "# rule acme\n");
  put(`${f.config}/layers/tree/Org/layer.yaml`, "target: true\n");
  put(`${f.config}/layers/tree/Acme/known/layer.yaml`, "description: слой каталога без проектов\n");
  for (const d of ["Acme/MyTasks/notes", "Acme/app/sub", "Acme/.hidden", "Acme/node_modules/x", "Acme/known/x", "Notes", "Studio/drafts", "Org/work", "Org/svc/docs", ".cache"])
    mkdirSync(`${f.ws}/${d}`, { recursive: true });
  const ws = real(f.ws);
  // Команда в этом процессе «в терминале»: ответы на вопросы да/нет — по порядку
  const ask = (args: string[], answers: boolean[], cwd = f.dir) => {
    const saved = { ...process.env }, dir = process.cwd(), log = console.log, out: string[] = [];
    Object.assign(process.env, { MIKSY_CONFIG: f.config, HOME: f.home, USERPROFILE: f.home });
    process.chdir(cwd);
    console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
    const questions: string[] = [];
    const io: Ask = {
      yes: (q) => { questions.push(q); if (!answers.length) throw new Error(`лишний вопрос: ${q}`); return answers.shift()!; },
      choose: () => null,
      line: () => null,
    };
    try { return { code: runCommand(args[0], args.slice(1), { ask: io }), out: out.join("\n"), questions }; }
    finally {
      console.log = log;
      process.chdir(dir);
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  };
  return { ...f, ws, ask };
}

describe("каталоги без git на уровне проектов", () => {
  test("sync --all — одной строкой, doctor — справочно (не проблема); остальные каталоги не показываются", () => {
    const f = fixture();
    const plan = f.run(["sync", "--all", "--dry-run"]);
    expect(plan.code).toBe(0);
    expect(plan.out).toContain("  не git-репо — настроек не получат (3): Acme/MyTasks, Notes, Org/work — git init или miksy target <путь>");
    expect(plan.out.match(/не git-репо/g)?.length).toBe(1);
    expect(f.run(["sync", "--global"]).code).toBe(0);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    const doc = f.run(["doctor"]);
    expect(doc.out).toContain("Всё синхронизировано");
    expect(doc.code).toBe(0);
    expect(doc.out).toMatch(/Справочно:[\s\S]*Каталоги без git на уровне проектов \(3\) — настроек не получат: git init в каталоге или miksy target <путь>:\n  Acme\/MyTasks\n  Notes\n  Org\/work/);
    // clean --all — без подсказки
    expect(f.run(["clean", "--all", "--dry-run"]).out).not.toContain("не git-репо");
  }, 60000);

  test("git init — каталог становится проектом и пропадает из подсказки", () => {
    const f = fixture();
    Bun.spawnSync(["git", "init", "-q", `${f.ws}/Notes`]);
    expect(f.run(["sync", "--all", "--dry-run"]).out).toContain("не git-репо — настроек не получат (2): Acme/MyTasks, Org/work");
  }, 30000);
});

describe("miksy target", () => {
  test("пометка: layer.yaml создаётся; без терминала — подсказка sync; цель в sync --all, explain, projects", () => {
    const f = fixture();
    const r = f.run(["target", "Acme/MyTasks"], { cwd: f.ws });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Acme/MyTasks: сделать целью — layers/tree/Acme/MyTasks/layer.yaml: создать с target: true");
    expect(r.out).toContain(`Дальше: miksy sync "${f.ws}/Acme/MyTasks"`);
    expect(read(`${f.config}/layers/tree/Acme/MyTasks/layer.yaml`)).toBe("target: true\n");
    const plan = f.run(["sync", "--all", "--dry-run"]);
    expect(plan.out).toContain("цели без git (1): Acme/MyTasks");
    expect(plan.out).toContain("группы (1): Org");
    // Подкаталоги цели без проектов внутри — не уровень проектов
    expect(plan.out).toContain("не git-репо — настроек не получат (2): Notes, Org/work");
    expect(plan.out).toMatch(/Acme\/MyTasks \(цель без git\)/);
    expect(f.run(["projects"]).out).toMatch(/^Acme\/MyTasks\s+\(цель без git: target: true/m);
    expect(f.run(["explain", `${f.ws}/Acme/MyTasks`]).out).toContain("Цель без git");
    // Повтор — уже цель
    expect(f.run(["target", `${f.ws}/Acme/MyTasks`]).out).toContain("Acme/MyTasks: уже цель");
    // Записали — правила слоёв дерева в каталоге
    expect(f.run(["sync", `${f.ws}/Acme/MyTasks`]).code).toBe(0);
    expect(read(`${f.ws}/Acme/MyTasks/CLAUDE.local.md`)).toContain("# rule acme");
  }, 60000);

  test("без пути — текущий каталог; в терминале «да» — sync этой цели; над проектами — sync --all", () => {
    const f = fixture();
    const r = f.ask(["target"], [true], `${f.ws}/Notes`);
    expect(r.code).toBe(0);
    expect(r.questions).toEqual(["Записать настройки в Notes сейчас (miksy sync Notes)?"]);
    expect(read(`${f.config}/layers/tree/Notes/layer.yaml`)).toBe("target: true\n");
    expect(read(`${f.ws}/Notes/CLAUDE.local.md`)).toContain("miksy:begin");
    // Каталог над проектами — sync --all (правила Claude ниже пересчитаются с группой)
    const g = f.ask(["target", `${f.ws}/Studio`], [false]);
    expect(g.questions[0]).toContain("miksy sync --all");
    expect(g.out).toContain("Позже: miksy sync --all");
  }, 30000);

  test("существующий layer.yaml дополняется: комментарии и ключи сохраняются; target: false → true", () => {
    const f = fixture();
    const text = "# мой слой\ndescription: слой без проектов  # пояснение\n\nexclude: [mcp.x]\n";
    put(`${f.config}/layers/tree/Acme/known/layer.yaml`, text);
    expect(f.run(["target", `${f.ws}/Acme/known`, "--dry-run"]).out).toContain("--dry-run: ничего не записано.");
    expect(read(`${f.config}/layers/tree/Acme/known/layer.yaml`)).toBe(text);
    expect(f.run(["target", `${f.ws}/Acme/known`]).code).toBe(0);
    expect(read(`${f.config}/layers/tree/Acme/known/layer.yaml`)).toBe(text + "target: true\n");
    // Регистр слоя — как в конфигурации (каталог workspace Notes, слой notes); CRLF и комментарий сохраняются
    put(`${f.config}/layers/tree/notes/layer.yaml`, "description: заметки\r\ntarget: false # пока нет\r\n");
    expect(f.run(["target", `${f.ws}/Notes`]).code).toBe(0);
    expect(read(`${f.config}/layers/tree/notes/layer.yaml`)).toBe("description: заметки\r\ntarget: true # пока нет\r\n");
  }, 30000);

  test("ошибки: вне workspace, сам workspace, внутри проекта, проект, нет каталога, зарезервированное имя", () => {
    const f = fixture();
    mkdirSync(`${f.dir}/outside`);
    mkdirSync(`${f.ws}/Acme/skills`, { recursive: true });
    const err = (path: string) => { const r = f.run(["target", path]); expect(r.code).toBe(1); return r.err; };
    expect(err(`${f.dir}/outside`)).toContain("вне workspace");
    expect(err(f.ws)).toContain("сам workspace");
    expect(err(`${f.ws}/Acme/app/sub`)).toContain("внутри проекта Acme/app");
    expect(err(`${f.ws}/Acme/app`)).toContain("git-репо: это проект");
    expect(err(`${f.ws}/Acme/nope`)).toContain("каталога нет");
    expect(err(`${f.ws}/Acme/skills`)).toContain("зарезервировано");
    expect(f.run(["target", "a", "b"]).code).toBe(2);
    expect(existsSync(`${f.config}/layers/tree/Acme/app/layer.yaml`)).toBe(false);
  }, 30000);

  test("--remove: пометка снимается (пустой файл и каталоги слоя — удаляются), записанное — убирается clean", () => {
    // opencode не ведёт реестра проектов, который пополнял бы sync: без пометки каталог — уже не цель
    const f = fixture(["opencode"]);
    expect(f.run(["target", `${f.ws}/Acme/MyTasks`]).code).toBe(0);
    expect(f.run(["sync", `${f.ws}/Acme/MyTasks`]).code).toBe(0);
    expect(existsSync(`${f.ws}/Acme/MyTasks/opencode.json`)).toBe(true);
    const dry = f.run(["target", `${f.ws}/Acme/MyTasks`, "--remove", "--dry-run"]);
    expect(dry.out).toContain("layers/tree/Acme/MyTasks/layer.yaml: удалить (в нём ничего не останется)");
    expect(existsSync(`${f.config}/layers/tree/Acme/MyTasks/layer.yaml`)).toBe(true);
    const r = f.ask(["target", `${f.ws}/Acme/MyTasks`, "--remove"], [true]);
    expect(r.code).toBe(0);
    expect(r.questions).toEqual(["Убрать то, что miksy записал в Acme/MyTasks (miksy clean Acme/MyTasks)?"]);
    expect(existsSync(`${f.config}/layers/tree/Acme/MyTasks`)).toBe(false);
    expect(existsSync(`${f.config}/layers/tree/Acme/instructions/10-acme.md`)).toBe(true);
    expect(existsSync(`${f.ws}/Acme/MyTasks/opencode.json`)).toBe(false);
    // Снова — снимать нечего
    expect(f.run(["target", `${f.ws}/Acme/MyTasks`, "--remove"]).out).toContain("не помечен целью");
  }, 60000);

  test("--remove у слоя с другими ключами — убирается только строка; без терминала — подсказка clean", () => {
    const f = fixture(["opencode"]);
    put(`${f.config}/layers/tree/Acme/known/layer.yaml`, "description: d\ntarget: true\nexclude: []\n");
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    const r = f.run(["target", `${f.ws}/Acme/known`, "--remove"]);
    expect(r.code).toBe(0);
    expect(read(`${f.config}/layers/tree/Acme/known/layer.yaml`)).toBe("description: d\nexclude: []\n");
    expect(r.out).toContain(`Дальше: miksy clean "${f.ws}/Acme/known"`);
  }, 60000);

  test("--remove с Claude: clean убирает и запись реестра, созданную sync; где агент работал сам — предупреждение", () => {
    const f = fixture();
    const dir = `${f.ws}/Acme/MyTasks`;
    for (const d of [dir, `${f.ws}/Notes`]) {
      expect(f.run(["target", d]).code).toBe(0);
      expect(f.run(["sync", d]).code).toBe(0);
    }
    // sync записал доверие в ~/.claude.json: запись projects[<каталог>] — только от miksy
    const r = f.ask(["target", dir, "--remove"], [true]);
    expect(r.questions).toEqual(["Убрать то, что miksy записал в Acme/MyTasks (miksy clean Acme/MyTasks)?"]);
    expect(existsSync(`${dir}/CLAUDE.local.md`)).toBe(false);
    expect(r.out).not.toContain("Внимание");
    // Больше не цель: снова в подсказке
    expect(f.run(["sync", "--all", "--dry-run"]).out).toContain("не git-репо — настроек не получат (2): Acme/MyTasks, Org/work");
    // В Notes Claude работал сам: в его записи реестра есть свои ключи
    const cfg = JSON.parse(readFileSync(`${f.home}/.claude.json`, "utf8"));
    const key = Object.keys(cfg.projects).find((k) => k.toLowerCase().endsWith("/notes"))!;
    cfg.projects[key].allowedTools = [];
    put(`${f.home}/.claude.json`, JSON.stringify(cfg, null, 2));
    const n = f.ask(["target", `${f.ws}/Notes`, "--remove"], [true]);
    expect(existsSync(`${f.ws}/Notes/CLAUDE.local.md`)).toBe(false);
    expect(n.out).toContain("Внимание: Notes и без пометки — проект: в нём работал агент");
  }, 60000);

  test("группа над проектами: --remove — sync --all убирает файлы бывшей группы", () => {
    const f = fixture();
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(existsSync(`${f.ws}/Org/CLAUDE.local.md`)).toBe(true);
    const r = f.ask(["target", `${f.ws}/Org`, "--remove"], [true]);
    expect(r.code).toBe(0);
    expect(r.questions[0]).toContain("miksy sync --all");
    expect(read(`${f.config}/layers/tree/Org/layer.yaml`)).toBeNull();
    expect(r.out).toContain("пометка target: true снята: Org");
    expect(existsSync(`${f.ws}/Org/CLAUDE.local.md`)).toBe(false);
  }, 60000);
});
