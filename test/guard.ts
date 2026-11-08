// Защита прогона тестов от настоящего окружения пользователя (после инцидента: тест, запущенный
// версией, которая не видела песочную конфигурацию, записал sync в настоящий workspace).
// preload перехватывает Bun.spawn/Bun.spawnSync: запуск CLI движка (любой версии — <движок>/src/cli.ts)
// с командой, которая пишет (sync, clean, setup, adopt, trust, target, root, update), проверяется до старта. Куда такая версия
// могла бы писать, вычисляется независимо от того, какие переменные она понимает: домашний каталог, конфигурация (переменная → указатель в HOME → соседний каталог движка),
// workspace из её local/machine.yaml, пути в аргументах, каталог команды setup. Всё это обязано лежать в
// безопасных корнях (песочница preload, системный tmp) и не совпадать с настоящими HOME, конфигурацией и
// workspace. Иначе прогон останавливается (код 97) до запуска процесса.
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { canonical, fold, inside } from "../src/paths";

export type Real = { home: string[]; configs: string[]; workspaces: string[] };
type Env = Record<string, string | undefined>;

// update пишет в сам движок (git merge, переход на stable) и после обновления запускает setup и sync
const WRITE = new Set(["sync", "clean", "setup", "adopt", "trust", "target", "update", "root"]);
// Канонический путь. Не раскрывается: нет даже корня диска — сравнивается как записан (на диск, которого
// нет, ничего не записать; вне песочницы — по-прежнему отказ); есть существующая часть, а realpath не
// проходит (ссылка в никуда, цикл, нет доступа) — Unresolved: куда поведёт запись, неизвестно — остановка
class Unresolved extends Error {}
const lexists = (p: string) => { try { lstatSync(p); return true; } catch { return false; } };
const key = (p: string) => {
  try { return fold(canonical(p)); }
  catch (e) {
    let q = resolve(p);
    while (!lexists(q) && dirname(q) !== q) q = dirname(q);
    if (lexists(q)) throw new Unresolved((e as Error).message);
    return fold(resolve(p).replaceAll("\\", "/"));
  }
};
// Настоящие пути пользователя сравниваются без остановки: битая ссылка там — не повод отказать тесту
const realKey = (p: string) => { try { return key(p); } catch { return fold(resolve(p).replaceAll("\\", "/")); } };
const within = (p: string, roots: string[]) => roots.some((r) => inside(key(p), realKey(r)));
const isConfig = (dir: string) => existsSync(join(dir, "map.yaml"));
const pointer = (file: string, home: string) => {
  try {
    const v = readFileSync(file, "utf8").trim();
    return v ? v.replace(/^~(?=$|[\\/])/, home) : null;
  } catch { return null; }
};
// Корни workspace из local/machine.yaml: строка или список (путь либо { path, tree }) — все
function workspacesOf(config: string, home: string): string[] {
  try {
    const doc = Bun.YAML.parse(readFileSync(join(config, "local", "machine.yaml"), "utf8").replace(/^﻿/, "")) as { workspace?: unknown };
    const items = typeof doc?.workspace === "string" ? [doc.workspace] : Array.isArray(doc?.workspace) ? doc.workspace : [];
    return items.map((it) => (typeof it === "string" ? it : it && typeof it === "object" && typeof (it as { path?: unknown }).path === "string" ? (it as { path: string }).path : ""))
      .map((p) => p.trim()).filter(Boolean).map((p) => p.replace(/^~(?=$|[\\/])/, home).replace(/^([A-Za-z]:)$/, "$1/"));
  } catch { return []; }
}

// Настоящее окружение: снимается до подмены HOME, tmp и переменных в preload
export function realEnvironment(env: Env, engine: string, accountHome: string): Real {
  const home = [...new Set([env.USERPROFILE, env.HOME, accountHome].filter((h): h is string => !!h))];
  const configs = new Set<string>();
  if (env.MIKSY_CONFIG) configs.add(env.MIKSY_CONFIG);
  for (const h of home) { const p = pointer(join(h, ".miksy"), h); if (p) configs.add(p); }
  if (isConfig(join(engine, "..", "miksy-config"))) configs.add(join(engine, "..", "miksy-config"));
  const workspaces = [...configs].flatMap((c) => home.flatMap((h) => workspacesOf(c, h)));
  return { home, configs: [...configs], workspaces: [...new Set(workspaces)] };
}

// Причина отказа (null — запуск безопасен или это не запуск CLI движка с записью)
export function unsafeSpawn(argv: string[], opts: { env?: Env; cwd?: string }, real: Real, safe: string[]): string | null {
  const at = argv.findIndex((a) => /[\\/]src[\\/]cli\.ts$/.test(a));
  if (at < 0 || !WRITE.has(argv[at + 1] ?? "")) return null;
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const cmd = argv[at + 1];
  // «X:» движок понимает как корень диска X:/ (paths.ts: driveRoot), а не как текущий каталог диска
  const abs = (p: string) => { const d = p.replace(/^([A-Za-z]:)$/, "$1/"); return isAbsolute(d) ? d : resolve(cwd, d); };
  const engine = dirname(dirname(abs(argv[at])));
  const home = (process.platform === "win32" ? env.USERPROFILE ?? env.HOME : env.HOME ?? env.USERPROFILE) ?? "";
  const problems: string[] = [];
  const check = (what: string, p: string | null) => {
    if (!p) return;
    try {
      const hit = [...real.home.filter((h) => realKey(h) === key(p)), ...real.configs.filter((c) => within(p, [c])), ...real.workspaces.filter((w) => within(p, [w]) || inside(realKey(w), key(p)))];
      if (hit.length || !within(p, safe)) problems.push(`${what}: ${p}${hit.length ? ` — настоящий ${hit[0]}` : " — вне песочницы"}`);
    } catch (e) {
      if (!(e instanceof Unresolved)) throw e;
      problems.push(`${what}: ${p} — путь не раскрывается (${e.message}): куда пойдёт запись, неизвестно`);
    }
  };
  if (!home) problems.push("HOME не задан — процесс взял бы настоящий домашний каталог");
  check("HOME", home);
  // Конфигурация: переменная → указатель → соседний каталог; не найдена — setup создал бы соседний
  // каталог движка
  const sibling = join(engine, "..", "miksy-config");
  const config = env.MIKSY_CONFIG ? env.MIKSY_CONFIG.replace(/^~(?=$|[\\/])/, home)
    : pointer(join(home, ".miksy"), home) ?? (isConfig(sibling) ? sibling : isConfig(engine) ? engine : cmd === "setup" ? sibling : null);
  check("конфигурация (miksy-config)", config && abs(config));
  if (config) for (const w of workspacesOf(abs(config), home)) check(`workspace из ${config}/local/machine.yaml`, abs(w));
  if (cmd === "setup" || cmd === "update") check("каталог команды (BUN_INSTALL)", env.BUN_INSTALL ?? join(home, ".bun"));
  // update меняет git-клон движка, из которого запущен: это должна быть копия в песочнице
  if (cmd === "update") check("движок (update меняет его git-клон)", engine);
  // Пути в аргументах: цель sync/clean/adopt/trust и --out (значения --agent и --to — не пути)
  const args = argv.slice(at + 2);
  // sync и target без пути пишут в проект текущего каталога: он — тоже цель
  const positional = args.filter((a, i) => !a.startsWith("-") && !/^--(agent|to|out|tree)$/.test(args[i - 1] ?? ""));
  if ((cmd === "sync" && !args.some((a) => a === "--global" || a === "--all")) || cmd === "target")
    if (!positional.length) check("текущий каталог (команда без пути)", cwd);
  // root add без пути делает корнем workspace текущий каталог (и может сразу записать sync --all)
  if (cmd === "root" && positional[0] === "add" && positional.length < 2) check("текущий каталог (команда без пути)", cwd);
  if (cmd === "root" && positional.length >= 2) check("путь в аргументах", abs(positional[1]));
  // Путь цели — и без косой (sync p1 — каталог p1 от каталога запуска): у sync, clean, trust, target —
  // первый позиционный, у adopt без --global — тоже (второй — имя добавки)
  const named = ["sync", "clean", "trust", "target"].includes(cmd) || (cmd === "adopt" && !args.includes("--global"));
  if (named && positional.length) check("путь в аргументах", abs(positional[0]));
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^--(agent|to|tree)$/.test(a)) { i++; continue; }
    if (a === "--out") { check("--out", abs(args[++i] ?? "")); continue; }
    if (a.startsWith("--out=")) { check("--out", abs(a.slice(6))); continue; }
    if (!a.startsWith("-") && (/[\\/]/.test(a) || a === "." || a === "..")) check("путь в аргументах", abs(a));
  }
  return problems.length ? `тест запускает «${cmd}» в настоящем окружении пользователя:\n  ${problems.join("\n  ")}` : null;
}

// Перехват: отказ — сообщение и остановка всего прогона.
// Запуск без env получает песочное окружение явно (копию process.env на момент запуска): Bun на Windows
// (1.3.14) отдаёт такому подпроцессу исходное окружение процесса bun — настоящий USERPROFILE, без MIKSY_CONFIG
// и без подмен preload. Защита проверяет запуск по тому окружению, которое подпроцесс действительно получит, а
// git и прочие программы в тестах не читают настройки пользователя (глобальный gitignore и т. п.)
export function installGuard(real: Real, safe: string[]) {
  const stop = (argv: string[], opts: { env?: Env; cwd?: string } = {}) => {
    const why = unsafeSpawn(argv.map(String), opts, real, safe);
    if (!why) return;
    console.error(`\nОСТАНОВЛЕНО (test/guard.ts): ${why}\n`);
    process.exit(97);
  };
  const spawnSync = Bun.spawnSync, spawn = Bun.spawn;
  const sandboxed = (a: any, b: any): [any, any] => (Array.isArray(a)
    ? [a, { ...(b ?? {}), env: b?.env ?? { ...process.env } }]
    : [{ ...(a ?? {}), env: a?.env ?? { ...process.env } }, b]);
  const split = (a: any, b: any): [string[], any] => (Array.isArray(a) ? [a, b ?? {}] : [a?.cmd ?? [], a ?? {}]);
  Bun.spawnSync = ((a: any, b?: any) => { [a, b] = sandboxed(a, b); const [argv, o] = split(a, b); stop(argv, o); return spawnSync(a, b); }) as typeof Bun.spawnSync;
  Bun.spawn = ((a: any, b?: any) => { [a, b] = sandboxed(a, b); const [argv, o] = split(a, b); stop(argv, o); return spawn(a, b); }) as typeof Bun.spawn;
}

