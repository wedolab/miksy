// Фаза 0.2.0, исправления после седьмой проверки (out/phase-roots-fixes7.md, раздел B), мастер setup:
// B.3 — «Есть ещё папки с проектами?»: каталог, который сам проект (git-репо, проект основного корня), — объяснение
// и верный совет, как у root add, взять — только по явному «да»; B.4 — пути в кавычках во всех вопросах о путях.
// Тесты рецензента широкой проверки 6y (out/check6y/miksy2/test/zz-b-wizard.test.ts) — здесь
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ask } from "../src/ask";
import { runCommand } from "../src/commands";
import { ENGINE, configRoot } from "../src/load";
import { canonical, inside } from "../src/paths";
import { setup, type System } from "../src/setup";
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

const yamlOf = (f: { config: string }) => readFileSync(`${f.config}/local/machine.yaml`, "utf8");
// Начало мастера до вопроса о корнях: конфигурация из примера рядом с движком, без git
const start: Step[] = [{ q: /Откуда её взять/, a: "2" }, { q: /Где хранить/, a: "" }, { q: /git-репо/, a: "n" }];
// После вопросов о корнях: записать machine.yaml, команду не создавать, настройки агентам не писать
const finish: Step[] = [
  { q: /Записать local.machine\.yaml/, a: "y" },
  ...ifInstaller([{ q: /Выполнить «/, a: "n" }]), { q: /Создать команду/, a: "n" },
  { q: /полный план/, a: "" }, { q: /Записать настройки агентам сейчас/, a: "n" },
];

describe("B.3 — мастер: «Есть ещё папки с проектами?» — каталог, который сам проект", () => {
  test("git-репо вне workspace: объяснение и совет (корнем — папка, где он лежит), Enter — «нет», снова вопрос о папке; корень не добавлен", () => {
    const f = fixture();
    project(f.ws, "Acme/app");
    const repo = `${f.dir}/other/my-repo`;
    project(f.dir, "other/my-repo");
    const code = f.wizard([...start,
      { q: /Корень workspace/, a: "" }, { q: /Есть ещё папки/, a: repo }, { q: /Всё равно сделать .*корнем workspace/, a: "" }, { q: /Есть ещё папки/, a: "" },
      ...finish]);
    expect(code).toBe(0);
    const t = f.text();
    expect(t).toContain(`${repo} — git-репо: корнем workspace он станет папкой с проектами, а не проектом`);
    expect(t).toContain(`miksy root add "${f.dir}/other"`);
    expect(t).not.toContain("✓ ещё корень");
    expect(yamlOf(f)).not.toContain("my-repo");
  }, 120000);

  test("git-репо вне workspace: явное «да» — корень добавлен (ветка спрашивается как обычно)", () => {
    const f = fixture();
    project(f.ws, "Acme/app");
    const repo = `${f.dir}/other/my-repo`;
    project(f.dir, "other/my-repo");
    const code = f.wizard([...start,
      { q: /Корень workspace/, a: "" }, { q: /Есть ещё папки/, a: repo }, { q: /Всё равно сделать .*корнем workspace/, a: "y" },
      { q: /Ветка этой папки/, a: "" }, { q: /Есть ещё папки/, a: "" }, ...finish]);
    expect(code).toBe(0);
    expect(f.text()).toContain(`✓ ещё корень: ${repo}`);
    expect(yamlOf(f)).toContain("my-repo");
  }, 120000);

  test("проект основного корня: «он и так в workspace» и miksy sync; папка с проектами, которая сама git-репо, — без вопроса", () => {
    const f = fixture();
    project(f.ws, "Acme/app");
    const mono = `${f.dir}/mono`;
    project(f.dir, "mono");
    project(f.dir, "mono/inner");
    const code = f.wizard([...start,
      { q: /Корень workspace/, a: "" }, { q: /Есть ещё папки/, a: `${f.ws}/Acme/app` }, { q: /Всё равно сделать .*корнем workspace/, a: "n" },
      { q: /Есть ещё папки/, a: mono }, { q: /Ветка этой папки/, a: "" }, { q: /Есть ещё папки/, a: "" }, ...finish]);
    expect(code).toBe(0);
    const t = f.text();
    expect(t).toContain("Он и так в workspace и получает настройки: miksy sync");
    expect(t).toContain(`✓ ещё корень: ${mono}`);
  }, 120000);
});

describe("B.4 — мастер: путь в кавычках («Копировать как путь» Проводника)", () => {
  test("ещё одна папка в кавычках — взята как есть, ветка по умолчанию без кавычки (zz-b-wizard)", () => {
    const f = fixture();
    project(f.ws, "Acme/app");
    const other = `${f.dir}/My Cloud/Clients`;
    project(f.dir, "My Cloud/Clients/site");
    const shown = win ? other.replaceAll("/", "\\") : other;
    const code = f.wizard([...start,
      { q: /Корень workspace/, a: "" }, { q: /Есть ещё папки/, a: `"${shown}"` }, { q: /Ветка этой папки.*Enter — Clients\)/, a: "" }, { q: /Есть ещё папки/, a: "" },
      ...finish]);
    expect(code).toBe(0);
    const t = f.text();
    expect(t).toContain(`✓ ещё корень: ${other} → layers/tree/Clients`);
    expect(t).not.toContain("каталога сейчас нет");
    expect(yamlOf(f)).not.toContain('\\"');
  }, 120000);

  test("основной корень в кавычках (одинарных и двойных) — взят как есть", () => {
    for (const q of ['"', "'"]) {
      const f = fixture();
      project(f.ws, "Acme/app");
      const shown = win ? f.ws.replaceAll("/", "\\") : f.ws;
      const code = f.wizard([...start, { q: /Корень workspace/, a: `${q}${shown}${q}` }, { q: /Есть ещё папки/, a: "" }, ...finish]);
      expect(code).toBe(0);
      expect(yamlOf(f)).toContain(`workspace: ${JSON.stringify(f.ws)}`);
    }
  }, 120000);
});

describe("рецензия круга 6z", () => {
  test("п. 1: цель target: true основного корня — объяснение «цель (target: true)» и вопрос, как у root add; «нет» — не добавлена", () => {
    const f = fixture();
    project(f.ws, "Acme/app");
    put(`${f.ws}/Shared/notes.md`, "x\n");
    // Пометка — в слоях конфигурации, которую мастер создаст из примера (до вопроса о корнях)
    const mark = () => { put(`${f.config}/layers/tree/Shared/layer.yaml`, "target: true\n"); return ""; };
    const code = f.wizard([...start,
      { q: /Корень workspace/, a: mark }, { q: /Есть ещё папки/, a: `${f.ws}/Shared` }, { q: /Всё равно сделать .*корнем workspace/, a: "" }, { q: /Есть ещё папки/, a: "" },
      ...finish]);
    expect(code).toBe(0);
    const t = f.text();
    expect(t).toContain(`${f.ws}/Shared — цель (target: true) корня ${f.ws}`);
    expect(t).toContain("пометка target: true (layers/tree/Shared/layer.yaml) перестанет действовать");
    expect(t).not.toContain("✓ ещё корень");
  }, 120000);

  test("п. 5: пустые кавычки в «Есть ещё папки» — «нет», а не текущий каталог", () => {
    const f = fixture();
    project(f.ws, "Acme/app");
    const code = f.wizard([...start, { q: /Корень workspace/, a: "" }, { q: /Есть ещё папки/, a: '""' }, ...finish]);
    expect(code).toBe(0);
    expect(f.text()).not.toContain("✓ ещё корень");
  }, 120000);
});
