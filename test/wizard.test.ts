// Мастер setup: сценарии через интерфейс ввода (Ask) и подменённые действия с системой (System).
// Движок — копия examples в песочнице (<ws>/home/Miksy/miksy), конфигурация ищется рядом с ним;
// HOME, workspace и BUN_INSTALL — свои у каждого теста
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ask } from "../src/ask";
import { runCommand } from "../src/commands";
import { ENGINE, configRoot } from "../src/load";
import { canonical, inside } from "../src/paths";
import { layoutWarning, setup, type System } from "../src/setup";
import { put } from "./helpers";

type Step = { q: RegExp; a: string | (() => string) };

// Сценарий ответов: вопросы по порядку; неожиданный вопрос или конец сценария — ошибка теста
function scripted(steps: Step[], transcript: string[]): Ask & { left: () => number } {
  const next = (question: string): string => {
    const s = steps.shift();
    if (!s) throw new Error(`сценарий кончился, а мастер спрашивает: ${question}`);
    if (!s.q.test(question)) throw new Error(`ожидался вопрос ${s.q}, а мастер спрашивает: ${question}`);
    const a = typeof s.a === "function" ? s.a() : s.a;
    transcript.push(`? ${question} → ${a || "(Enter)"}`);
    return a;
  };
  return {
    yes: (q, def = false) => { const a = next(q); return a ? /^(y|д)/i.test(a) : def; },
    choose: (q, options, def) => { const a = next(`${q} [${options.map((o) => o.key).join("/")}]`); return a || def || null; },
    line: (q) => next(q) || null,
    left: () => steps.length,
  };
}

const win = process.platform === "win32";
// На Linux Node.js — только ссылка на скачивание (общего пакетного менеджера нет): вопроса об установке нет
const linux = process.platform === "linux";
const ifInstaller = (steps: Step[]): Step[] => (linux ? [] : steps);
// Окружение процесса — как до теста (мастер меняет MIKSY_CONFIG и PATH, тест — HOME и прочее)
let saved: Record<string, string | undefined> = {};
beforeEach(() => { saved = { ...process.env }; });
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

function fixture() {
  const dir = canonical(mkdtempSync(join(tmpdir(), "wizard-")));
  const ws = `${dir}/ws`;
  const engine = `${ws}/home/Miksy/miksy`;
  const home = `${dir}/home`;
  mkdirSync(home, { recursive: true });
  cpSync(join(ENGINE, "examples"), `${engine}/examples`, { recursive: true });
  put(`${engine}/src/cli.ts`, "// движок для теста\n");
  Object.assign(process.env, { HOME: home, USERPROFILE: home, BUN_INSTALL: `${dir}/bun`, SHELL: "/bin/zsh",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });
  delete process.env.MIKSY_CONFIG;
  // Программы машины: только то, что тест положил в bin
  const bin = new Map<string, string>([["git", "git"], ["claude", `${dir}/bin/claude`]]);
  const calls = { exec: [] as string[], userPath: [] as string[] };
  let userPath = "C:\\Windows";
  const sys: Partial<System> = {
    which: (c) => bin.get(c) ?? null,
    exec: (c) => { calls.exec.push(c); return 0; },
    userPath: { get: () => userPath, set: (v) => { calls.userPath.push(v); userPath = v; } },
    refreshPath: () => {},
  };
  const out: string[] = [];
  const wizard = (steps: Step[], opts: { yes?: boolean; force?: boolean } = {}) => {
    const ask = opts.yes ? null : scripted(steps, out);
    const orig = console.log;
    console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
    try {
      const code = setup({ ask, force: !!opts.force, run: runCommand, engine, sys, log: (s = "") => out.push(s) });
      const left = ask ? (ask as ReturnType<typeof scripted>).left() : 0;
      if (left) throw new Error(`мастер не задал ${left} вопросов сценария; вывод:\n${out.slice(-60).join("\n")}`);
      return code;
    } catch (e) {
      if (!/прервано|не задал/.test((e as Error).message)) (e as Error).message += `\nвывод:\n${out.slice(-40).join("\n")}`;
      throw e;
    } finally {
      console.log = orig;
      // Всё, что мастер нашёл и записал, — в песочнице теста
      expect(inside(configRoot(), dir)).toBe(true);
    }
  };
  const config = `${ws}/home/Miksy/miksy-config`;
  return { dir, ws, engine, home, config, bin, calls, out, wizard, text: () => out.join("\n") };
}

// Проект workspace с git
function project(ws: string, rel: string) {
  mkdirSync(`${ws}/${rel}`, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", `${ws}/${rel}`]);
}

const userMcp = (home: string, servers: Record<string, unknown>) =>
  put(`${home}/.claude.json`, JSON.stringify({ mcpServers: servers }, null, 2));

describe("мастер setup", () => {
  test("новая конфигурация из примера: все шаги, запись и проверка", () => {
    const f = fixture();
    project(f.ws, "Acme/app");
    userMcp(f.home, { mine: { type: "stdio", command: "node", args: ["x.js"] } });
    // PATH процесса уже с каталогом команды (так бывает после установки программ), а в оболочке его нет —
    // мастер всё равно спрашивает про PATH
    process.env.MIKSY_ORIGINAL_PATH = win ? "C:\\Windows" : "/usr/bin:/bin";
    process.env[win ? "Path" : "PATH"] = `${f.dir}/bun/bin${win ? ";" : ":"}${process.env[win ? "Path" : "PATH"] ?? ""}`;
    const code = f.wizard([
      { q: /Откуда её взять/, a: "2" },
      { q: /Где хранить конфигурацию/, a: "" },
      { q: /git-репо и записать первый коммит/, a: "y" },
      { q: /Корень workspace/, a: "" },
      { q: /Записать local\/machine\.yaml/, a: "y" },
      { q: /Скопировать это в/, a: "" },
      ...ifInstaller([{ q: /Выполнить «.*node/i, a: "" }]),
      { q: /Создать команду/, a: "" },
      { q: win ? /пользовательский PATH/ : /дописать в ~\/\.zshrc/, a: "" },
      { q: /Перенести в конфигурацию/, a: "1" },
      { q: /Записать в слой/, a: "y" },
      { q: /полный план/, a: "v" },
      { q: /Записать настройки агентам сейчас/, a: "y" },
    ]);
    expect(code).toBe(0);
    const t = f.text();
    // 1. Конфигурация рядом с движком, git-репо с коммитом
    expect(existsSync(`${f.config}/map.yaml`)).toBe(true);
    expect(Bun.spawnSync(["git", "-C", f.config, "log", "--oneline"]).stdout.toString()).toContain("Initial miksy config");
    // local/ в git не попадает; конфигурация лежит в workspace — она и проект (CLAUDE.local.md скрыт exclude)
    const status = Bun.spawnSync(["git", "-C", f.config, "status", "--porcelain", "--ignored"]).stdout.toString();
    expect(status).toContain("!! local/");
    expect(status.split("\n").filter((l) => l.startsWith("??"))).toEqual(["?? layers/global/mcp/"]);
    expect(t).toContain("remote add origin");
    // 2. machine.yaml
    const machine = Bun.YAML.parse(readFileSync(`${f.config}/local/machine.yaml`, "utf8")) as { workspace: string; agents: string[] };
    expect(canonical(machine.workspace)).toBe(canonical(f.ws));
    expect(machine.agents).toEqual(["claude"]);
    expect(t).toMatch(/не найдены: codex, opencode, gemini — miksy их не ставит.*README/);
    // 3. Копия настроек до записи — исходный ~/.claude.json
    const backups = readdirSync(`${f.config}/local/backups`).filter((d) => d.startsWith("before-miksy-"));
    expect(backups.length).toBe(1);
    expect(JSON.parse(readFileSync(`${f.config}/local/backups/${backups[0]}/.claude.json`, "utf8")).mcpServers.mine).toBeTruthy();
    expect(t).toMatch(win ? /robocopy ".*before-miksy-.*" \$env:USERPROFILE \/E/ : /cp -R ".*before-miksy-.*\/\." ~\//);
    // 4. npx для context7: показана команда установки, без «да» не выполнена
    expect(t).toMatch(/Node\.js \(npx\): нужна серверам context7/);
    expect(f.calls.exec).toEqual([]);
    // 5. Команда и PATH
    expect(existsSync(`${f.dir}/bun/bin/${win ? "miksy.cmd" : "miksy"}`)).toBe(true);
    if (win) expect(f.calls.userPath).toEqual([`C:\\Windows;${f.dir.replaceAll("/", "\\")}\\bun\\bin`]);
    else expect(readFileSync(`${f.home}/.zshrc`, "utf8")).toBe(`# miksy\nexport PATH="${f.dir}/bun/bin:$PATH"\n`);
    // 6. adopt: сервер в глобальном слое
    expect(readFileSync(`${f.config}/layers/global/mcp/mine.yaml`, "utf8")).toContain(`command: "node"`);
    // 8. Сводка плана и полный план по v
    expect(t).toMatch(/глобально: создать \d+/);
    expect(t).toMatch(/проекты и группы: создать \d+/);
    expect(t).toContain("--dry-run: ничего не записано.");
    // 9. Запись: правила в ~/.claude/CLAUDE.md и в проекте, MCP mine — теперь от miksy
    expect(readFileSync(`${f.home}/.claude/CLAUDE.md`, "utf8")).toContain("miksy:begin");
    expect(existsSync(`${f.ws}/Acme/app/CLAUDE.local.md`)).toBe(true);
    // 10. Проверка
    expect(t).toMatch(/10\. Проверка/);
    expect(t).toContain("Процитируй первую строку раздела");
  }, 120000);

  test("конфигурация из git (локальный bare-репо), отказ от записи", () => {
    const f = fixture();
    // Своя конфигурация в git на «другой машине»
    const src = `${f.dir}/src-config`;
    cpSync(join(ENGINE, "examples", "config"), src, { recursive: true });
    put(`${src}/layers/tree/instructions/10-mine.md`, "# моё правило\n");
    for (const a of [["init", "-q"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "c"]]) Bun.spawnSync(["git", "-C", src, ...a]);
    const bare = `${f.dir}/config.git`;
    Bun.spawnSync(["git", "clone", "-q", "--bare", src, bare]);
    const code = f.wizard([
      { q: /Откуда её взять/, a: "1" },
      { q: /Адрес git-репо конфигурации/, a: `${f.dir}/нет-такого.git` },
      { q: /Адрес git-репо конфигурации/, a: bare },
      { q: /Корень workspace/, a: "" },
      { q: /Записать local\/machine\.yaml/, a: "y" },
      ...ifInstaller([{ q: /Выполнить «/, a: "n" }]),
      { q: /Создать команду/, a: "n" },
      { q: /полный план/, a: "" },
      { q: /Записать настройки агентам сейчас/, a: "n" },
    ]);
    expect(code).toBe(0);
    const t = f.text();
    expect(t).toContain("Не удалось скачать конфигурацию");
    expect(t).toContain("gh auth login");
    expect(readFileSync(`${f.config}/layers/tree/instructions/10-mine.md`, "utf8")).toBe("# моё правило\n");
    expect(t).toMatch(/у агентов ещё нет глобальных настроек — копировать нечего/);
    // Отказ от записи: ни учёта, ни файлов агентов
    expect(existsSync(`${f.config}/local/state/manifest.json`)).toBe(false);
    expect(existsSync(`${f.home}/.claude/CLAUDE.md`)).toBe(false);
    expect(t).toContain("Не записано. Позже: miksy sync --global и miksy sync --all");
  }, 120000);

  test("продолжение после прерывания: сделанное не переспрашивается", () => {
    const f = fixture();
    project(f.ws, "Acme/app");
    // Свой skill на месте skill miksy из примера — конфликт первого sync
    put(`${f.home}/.claude/skills/miksy/SKILL.md`, "# мой skill\n");
    // Прерывание на шаге 4 (Ctrl+C — исключение из вопроса)
    expect(() => f.wizard([
      { q: /Откуда её взять/, a: "2" },
      { q: /Где хранить конфигурацию/, a: "" },
      { q: /git-репо/, a: "n" },
      { q: /Корень workspace/, a: "" },
      { q: /Записать local\/machine\.yaml/, a: "y" },
      { q: /Скопировать это в/, a: "y" },
      { q: linux ? /Создать команду/ : /Выполнить «/, a: () => { throw new Error("прервано"); } },
    ])).toThrow("прервано");
    f.out.length = 0;
    // Повтор: конфигурация, machine.yaml и копия уже есть — первый вопрос про программы
    f.bin.set("npx", "npx");
    const code = f.wizard([
      { q: /Создать команду/, a: "y" },
      { q: win ? /пользовательский PATH/ : /дописать в ~\/\.zshrc/, a: "n" },
      { q: /полный план/, a: "" },
      { q: /Записать настройки агентам сейчас/, a: "y" },
      { q: /Заменить эти файлы/, a: "y" },
    ]);
    expect(code).toBe(0);
    const t = f.text();
    expect(t).toMatch(/1\. Конфигурация[\s\S]*✓ есть:/);
    expect(t).toContain("✓ local/machine.yaml уже есть");
    expect(t).toMatch(/✓ уже есть: .*before-miksy-/);
    expect(t).toContain("✓ всё нужное есть");
    // Конфликт первого sync показан на шаге 6, после записи заменён по явному «да», оригинал сохранён
    expect(t).toMatch(/Конфликты первого sync \(1\)[\s\S]*skills\/miksy\/SKILL\.md: файл существует и создан не miksy/);
    expect(readFileSync(`${f.home}/.claude/skills/miksy/SKILL.md`, "utf8")).not.toBe("# мой skill\n");
    const originals = `${f.config}/local/backups/originals`;
    const saved = readdirSync(originals, { recursive: true }).map(String).find((p) => p.replaceAll("\\", "/").endsWith(".claude/skills/miksy/SKILL.md"));
    expect(saved && readFileSync(`${originals}/${saved}`, "utf8")).toBe("# мой skill\n");
    // Третий запуск: всё сделано — вопросов о записи нет, план без изменений
    f.out.length = 0;
    f.wizard([
      { q: win ? /пользовательский PATH/ : /дописать в ~\/\.zshrc/, a: "n" },
      { q: /полный план/, a: "" },
      { q: /Записать настройки агентам сейчас/, a: "n" },
    ]);
    expect(f.text()).toMatch(/глобально: изменений нет/);
    expect(f.text()).toMatch(/miksy уже записывал|✓ уже есть: .*before-miksy-/);
  }, 120000);

  test("adopt по пунктам: перенести, оставить (запоминается), пропустить все", () => {
    const f = fixture();
    project(f.ws, "Acme/app");
    userMcp(f.home, { one: { type: "stdio", command: "node", args: ["1.js"] }, two: { type: "stdio", command: "node", args: ["2.js"] } });
    put(`${f.ws}/Acme/app/.claude/skills/my-skill/SKILL.md`, "---\nname: my-skill\ndescription: d\n---\n");
    f.bin.set("npx", "npx");
    f.bin.set("node", "node");
    const base: Step[] = [
      { q: /Откуда её взять/, a: "2" }, { q: /Где хранить/, a: "" }, { q: /git-репо/, a: "n" },
      { q: /Корень workspace/, a: "" }, { q: /Записать local\/machine\.yaml/, a: "y" },
      { q: /Скопировать это в/, a: "n" }, { q: /Создать команду/, a: "n" },
    ];
    f.wizard([
      ...base,
      // one — глобально; two — оставить; skill проекта — в слой Acme
      { q: /Перенести в конфигурацию.*\[1\/2\/0\/s\]/, a: "1" }, { q: /Записать в слой/, a: "y" },
      { q: /Перенести в конфигурацию.*\[1\/2\/0\/s\]/, a: "0" },
      { q: /Перенести в конфигурацию.*\[1\/2\/3\/4\/0\/s\]/, a: "3" }, { q: /Скопировать в слой/, a: "y" },
      { q: /полный план/, a: "" }, { q: /Записать настройки/, a: "n" },
    ]);
    expect(existsSync(`${f.config}/layers/global/mcp/one.yaml`)).toBe(true);
    expect(existsSync(`${f.config}/layers/global/mcp/two.yaml`)).toBe(false);
    expect(existsSync(`${f.config}/layers/tree/Acme/skills/my-skill/SKILL.md`)).toBe(true);
    expect(f.text()).toMatch(/MCP-сервер one — claude, глобально/);
    expect(f.text()).toMatch(/skill my-skill — claude.*в проекте Acme\/app/);
    // Повтор: two оставлен — не спрашивается; новая добавка three — «пропустить все»
    userMcp(f.home, { one: { type: "stdio", command: "node", args: ["1.js"] }, two: { type: "stdio", command: "node", args: ["2.js"] }, three: { type: "http", url: "https://x.example/mcp" } });
    f.out.length = 0;
    f.wizard([
      // Отказ от копии и команды в прошлый раз — не «сделано»: спрашивается снова
      { q: /Скопировать это в/, a: "n" }, { q: /Создать команду/, a: "n" },
      { q: /Перенести в конфигурацию/, a: "s" },
      { q: /полный план/, a: "" }, { q: /Записать настройки/, a: "n" },
    ]);
    expect(f.text()).toMatch(/MCP-сервер three/);
    expect(f.text()).not.toMatch(/MCP-сервер two/);
    expect(f.text()).toContain("ещё 1 вы раньше оставили у агентов");
  }, 120000);

  test("программа для MCP, перенесённого adopt, проверяется сразу; уже предложенная установка — не повторно", () => {
    const f = fixture();
    project(f.ws, "Acme/app");
    userMcp(f.home, { fetcher: { type: "stdio", command: "uvx", args: ["mcp-server-fetch"] }, mine: { type: "stdio", command: "node", args: ["x.js"] } });
    f.wizard([
      { q: /Откуда её взять/, a: "2" }, { q: /Где хранить/, a: "" }, { q: /git-репо/, a: "n" },
      { q: /Корень workspace/, a: "" }, { q: /Записать local\/machine\.yaml/, a: "y" },
      { q: /Скопировать это в/, a: "n" },
      // Шаг 4: только npx (context7 из примера); uvx и node — ещё не в слоях
      ...ifInstaller([{ q: /Выполнить «.*node/i, a: "n" }]),
      { q: /Создать команду/, a: "n" },
      { q: /Перенести в конфигурацию/, a: "1" }, { q: /Записать в слой/, a: "y" },
      { q: /Перенести в конфигурацию/, a: "1" }, { q: /Записать в слой/, a: "y" },
      // Сразу после переноса: uv для fetcher; Node.js уже предлагался — без вопроса
      { q: /Выполнить «.*astral\.sh\/uv/, a: "n" },
      { q: /полный план/, a: "" }, { q: /Записать настройки/, a: "n" },
    ]);
    const t = f.text();
    expect(t).toMatch(/Программы для перенесённых серверов:\n(.*\n)*• uv \(uvx\): нужна серверам fetcher — нет в PATH/);
    expect(t).toMatch(/• Node\.js \(node\): нужна серверам mine — нет в PATH\n  (установка предложена выше|скачать): /);
    expect(t.indexOf("Программы для перенесённых серверов")).toBeLessThan(t.indexOf("8. План"));
  }, 120000);

  test("секреты: ожидание заполнения файла, значения не печатаются", () => {
    const f = fixture();
    project(f.ws, "p");
    f.bin.set("npx", "npx");
    const steps: Step[] = [
      { q: /Откуда её взять/, a: "2" }, { q: /Где хранить/, a: "" }, { q: /git-репо/, a: "n" },
      { q: /Корень workspace/, a: () => { put(`${f.config}/layers/tree/mcp/demo.yaml`, "name: demo\ncommand: npx\nargs: [demo]\nenv:\n  A: ${DEMO_A}\n  B: ${DEMO_B}\n"); return ""; } },
      { q: /Записать local\/machine\.yaml/, a: "y" },
      { q: /Создать команду/, a: "n" },
      // Enter без изменений — ещё нет обоих; затем A записан — остался B; затем s — позже
      { q: /Заполните файл сейчас/, a: "" },
      { q: /Заполните файл сейчас/, a: () => { writeFileSync(`${f.config}/local/secrets.env`, "DEMO_A=secret-value-a\n"); return ""; } },
      { q: /Заполните файл сейчас/, a: "s" },
      { q: /полный план/, a: "" }, { q: /Записать настройки/, a: "n" },
    ];
    f.wizard(steps);
    const t = f.text();
    expect(t).toMatch(/Не заданы \(2\):\n  DEMO_A  — нужен слоям: workspace\n  DEMO_B/);
    expect(t).toMatch(/Ещё не заданы \(1\):\n  DEMO_B/);
    expect(t).toContain("Серверы без секрета sync пропустит");
    expect(t).toMatch(/пропущены серверы \(1\):\n    demo — не заданы переменные DEMO_B/);
    expect(t).not.toContain("secret-value-a");
    expect(t).toContain(`${f.config}/local/secrets.env`);
  }, 120000);

  test("--yes: только безопасная часть — без копии, PATH, установки, adopt и sync", () => {
    const f = fixture();
    userMcp(f.home, { mine: { type: "stdio", command: "node" } });
    expect(f.wizard([], { yes: true })).toBe(0);
    expect(existsSync(`${f.config}/map.yaml`)).toBe(true);
    expect(existsSync(`${f.config}/local/machine.yaml`)).toBe(true);
    expect(existsSync(`${f.dir}/bun/bin/${win ? "miksy.cmd" : "miksy"}`)).toBe(true);
    expect(existsSync(`${f.config}/.git`)).toBe(false);
    expect(existsSync(`${f.config}/local/backups`) && readdirSync(`${f.config}/local/backups`).some((d) => d.startsWith("before-miksy-"))).toBe(false);
    expect(f.calls).toEqual({ exec: [], userPath: [] });
    expect(existsSync(`${f.home}/.zshrc`)).toBe(false);
    expect(existsSync(`${f.config}/local/state/manifest.json`)).toBe(false);
    expect(existsSync(`${f.config}/layers/global/mcp/mine.yaml`)).toBe(false);
    expect(f.text()).toContain("Без вопросов (--yes или нет терминала)");
  }, 60000);

  test("--yes: программы серверов MCP — отчёт с командой установки; заметка о подготовке машины", () => {
    const f = fixture();
    project(f.ws, "p");
    put(`${f.config}/local.example/README.md`, "# Подготовка машины\n");
    expect(f.wizard([], { yes: true })).toBe(0);
    const t = f.text();
    expect(t).toMatch(/• Node\.js \(npx\): нужна серверам context7 — нет в PATH\n  (установить|скачать): (brew install node|winget install OpenJS\.NodeJS\.LTS|https:\/\/nodejs\.org)/);
    expect(f.calls.exec).toEqual([]);
    expect(t).toContain(`В вашей конфигурации есть заметка о подготовке машины — то, что miksy не настраивает сам (например, профили облачных CLI): ${f.config}/local.example/README.md. Прочитайте её.`);
    expect(t).not.toContain("Внешние настройки");
  }, 60000);

  test("--yes --backup: копия настроек агентов без вопросов, остальное — как --yes", () => {
    const f = fixture();
    userMcp(f.home, { mine: { type: "stdio", command: "node" } });
    put(`${f.home}/.claude/settings.json`, "{}\n");
    const ask = null;
    const out: string[] = [];
    expect(setup({ ask, force: false, backup: true, run: runCommand, engine: f.engine, sys: { which: (c) => f.bin.get(c) ?? null, exec: () => 1 }, log: (s = "") => out.push(s) })).toBe(0);
    const backups = readdirSync(`${f.config}/local/backups`).filter((d) => d.startsWith("before-miksy-"));
    expect(backups.length).toBe(1);
    expect(JSON.parse(readFileSync(`${f.config}/local/backups/${backups[0]}/.claude.json`, "utf8")).mcpServers.mine).toBeTruthy();
    expect(existsSync(`${f.config}/local/backups/${backups[0]}/.claude/settings.json`)).toBe(true);
    expect(out.join("\n")).toMatch(/✓ копия: .*before-miksy-.*\(файлов: 2\)/);
    expect(existsSync(`${f.config}/local/state/manifest.json`)).toBe(false);
    // Повтор: копия уже есть — вторую не делает
    out.length = 0;
    setup({ ask, force: false, backup: true, run: runCommand, engine: f.engine, sys: { which: (c) => f.bin.get(c) ?? null }, log: (s = "") => out.push(s) });
    expect(readdirSync(`${f.config}/local/backups`).filter((d) => d.startsWith("before-miksy-")).length).toBe(1);
    expect(out.join("\n")).toMatch(/✓ уже есть: .*before-miksy-/);
  }, 60000);

  test("раскладка не как на первой машине — одно предупреждение, ничего не меняется", () => {
    const f = fixture();
    // На «первой машине» движок и конфигурация лежали в Tools/Miksy (цель), здесь — в home/Miksy
    put(`${f.config}/layers/tree/Tools/Miksy/layer.yaml`, "target: true\n");
    expect(f.wizard([], { yes: true })).toBe(0);
    const t = f.text();
    const warn = `в конфигурации есть слой Tools/Miksy (target: true), а движок лежит в ${f.engine} — на первой машине он был в ${f.ws}/Tools/Miksy/miksy`;
    expect(t.split(warn).length).toBe(2);
    expect(existsSync(`${f.ws}/Tools`)).toBe(false);
  }, 60000);
});

describe("проверка раскладки (layoutWarning)", () => {
  const sandbox = () => {
    const dir = canonical(mkdtempSync(join(tmpdir(), "layout-")));
    // Конфигурация — вне workspace: проверка смотрит только на её слои и имя
    const config = `${dir}/cfg/miksy-config`;
    return { dir, ws: `${dir}/ws`, config, layer: (rel: string, text = "") => put(`${config}/layers/tree/${rel}/layer.yaml`, text) };
  };
  const engineAt = (ws: string, rel: string) => { mkdirSync(`${ws}/${rel}`, { recursive: true }); return `${ws}/${rel}`; };

  test("как на первой машине (home/Miksy/{miksy,miksy-config}) — молча", () => {
    const s = sandbox();
    s.layer("home/Miksy", "target: true\n");
    s.layer("home/Miksy/miksy");
    expect(layoutWarning(s.ws, engineAt(s.ws, "home/Miksy/miksy"), s.config)).toBeNull();
  });

  test("рядом miksy и miksy-config, проекты в других каталогах, слоя Miksy нет — молча", () => {
    const s = sandbox();
    s.layer("Acme", "target: true\n");
    s.layer("Acme/app");
        expect(layoutWarning(`${s.dir}/Projects`, engineAt(s.dir, "Projects/miksy"), s.config)).toBeNull();
    // Слой проекта движка под его настоящим именем — движок там, где ждёт слой
    s.layer("home/miksy");
    expect(layoutWarning(s.ws, engineAt(s.ws, "home/miksy"), s.config)).toBeNull();
  });

  test("слой Miksy есть, а движок лежит рядом с ним — предупреждение; регистр — отдельной строкой", () => {
    const s = sandbox();
    s.layer("home/Miksy", "target: true\n");
    const engine = engineAt(s.ws, "home/miksy");
    const w = layoutWarning(s.ws, engine, s.config)!;
    expect(w).toContain(`слой home/Miksy (target: true), а движок лежит в ${engine} — на первой машине он был в ${s.ws}/home/Miksy/miksy`);
    // Windows и macOS: home/Miksy — тот же каталог, что home/miksy
    const insensitive = existsSync(`${s.ws}/home/MIKSY`);
    expect(w.includes("не различает регистр")).toBe(insensitive);
  });

  test("слой с именем движка (Tools/miksy), а движок в другом каталоге — предупреждение", () => {
    const s = sandbox();
    s.layer("Tools/miksy");
    const w = layoutWarning(s.ws, engineAt(s.dir, "elsewhere/miksy"), s.config)!;
    expect(w).toContain(`слой Tools/miksy, а движок лежит в ${s.dir}/elsewhere/miksy — на первой машине он был в ${s.ws}/Tools/miksy`);
  });
});
