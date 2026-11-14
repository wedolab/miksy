// Выпуск 0.2.1, часть A (out/phase-021.md), мастер setup: A6 — «Есть ещё папки с проектами?»: подкаталог git-репо —
// объяснение, совет и вопрос, как у самого репо (рецензент исполнителя 6z, п. 7:
// out/reviewer-tests/review6z-miksy/test/zz-review6z-wizard.test.ts, «подкаталог git-репо»); A11 — setup --force,
// основным стал бывший дополнительный корень: точная команда вернуть прежний основной (с --tree) и о переносе слоёв.
// Заготовка мастера — как в test/roots-fixes7-wizard.test.ts
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

describe("A6 — мастер: подкаталог git-репо", () => {
  test("подкаталог git-репо вне workspace: объяснение и совет (корнем — папка, где лежит репо), Enter — «нет», снова вопрос о папке", () => {
    const f = fixture();
    project(f.ws, "Acme/app");
    project(f.dir, "other/repo");
    const src = `${f.dir}/other/repo/src`;
    mkdirSync(src, { recursive: true });
    const code = f.wizard([...start,
      { q: /Корень workspace/, a: "" }, { q: /Есть ещё папки/, a: src }, { q: /Всё равно сделать .*корнем workspace/, a: "" }, { q: /Есть ещё папки/, a: "" },
      ...finish]);
    expect(code).toBe(0);
    const t = f.text();
    expect(t).toContain(`${src} — папка внутри git-репо ${f.dir}/other/repo`);
    expect(t).toContain(`miksy root add "${f.dir}/other"`);
    expect(t).not.toContain("✓ ещё корень");
    expect(yamlOf(f)).not.toContain("repo/src");
  }, 120000);
});

describe("A11 — setup --force: основным стал бывший дополнительный корень", () => {
  test("прежний основной без ветки: команда вернуть — с --tree и о переносе слоёв layers/tree/<папка> под ветку", () => {
    const f = fixture();
    const drive = `${f.dir}/drive`;
    project(drive, "Client1/site");
    project(f.ws, "Acme/app");
    expect(f.wizard([], { yes: true })).toBe(0);
    put(`${f.config}/local/machine.yaml`, `workspace:\n  - "${f.ws}"\n  - { path: "${drive}", tree: Clients }\nagents: [claude]\n`);
    f.out.length = 0;
    const code = f.wizard([
      { q: /Корень workspace/, a: drive },
      { q: /Есть ещё папки/, a: "" },
      { q: /Записать local\/machine\.yaml/, a: "y" },
      ...ifInstaller([{ q: /Выполнить «/, a: "n" }]),
      { q: /нет в PATH|Создать команду/, a: "n" },
      { q: /полный план/, a: "" },
      { q: /Записать настройки агентам сейчас/, a: "n" },
    ], { force: true });
    expect(code).toBe(0);
    const t = f.text();
    const cmd = t.match(/Вернуть его: 1\) .*; 2\) (miksy root add "[^"]+" --tree (\S+)) \(docs\/roots\.md/);
    expect(cmd?.[1]).toBe(`miksy root add "${f.ws}" --tree ${cmd?.[2]}`);
    expect(t).toContain(`его слои из layers/tree/<папка>/… перенесите в layers/tree/${cmd?.[2]}/<папка>/…`);
    // Предложенная ветка свободна: не Clients (она теперь у основного)
    expect(cmd?.[2]).not.toBe("Clients");
  }, 120000);
});

describe("рецензия 0.2.1 A, п. 5 — подсказка setup --force с пробелом в имени папки", () => {
  test("прежний основной «My Projects»: ветка в команде — в кавычках, команда разбирается", () => {
    const f = fixture();
    const drive = `${f.dir}/drive`, old = `${f.dir}/My Projects`;
    project(drive, "Client1/site");
    project(old, "Acme/app");
    expect(f.wizard([], { yes: true })).toBe(0);
    put(`${f.config}/local/machine.yaml`, `workspace:\n  - "${old}"\n  - { path: "${drive}", tree: Clients }\nagents: [claude]\n`);
    f.out.length = 0;
    const code = f.wizard([
      { q: /Корень workspace/, a: drive },
      { q: /Есть ещё папки/, a: "" },
      { q: /Записать local\/machine\.yaml/, a: "y" },
      ...ifInstaller([{ q: /Выполнить «/, a: "n" }]),
      { q: /нет в PATH|Создать команду/, a: "n" },
      { q: /полный план/, a: "" },
      { q: /Записать настройки агентам сейчас/, a: "n" },
    ], { force: true });
    expect(code).toBe(0);
    expect(f.text()).toContain(`2) miksy root add "${old}" --tree "My Projects" (docs/roots.md`);
  }, 120000);
});
