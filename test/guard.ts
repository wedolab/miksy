// Защита прогона тестов от настоящего окружения пользователя (после инцидента: тест, запущенный
// версией, которая не видела песочную конфигурацию, записал sync в настоящий workspace).
// preload перехватывает Bun.spawn/Bun.spawnSync: запуск CLI движка (любой версии — <движок>/src/cli.ts)
// с командой, которая пишет (sync, clean, setup, adopt, trust, target, update), проверяется до старта. Куда такая версия
// могла бы писать, вычисляется независимо от того, какие переменные она понимает: домашний каталог, конфигурация (переменная → указатель в HOME → соседний каталог движка),
// workspace из её local/machine.yaml, пути в аргументах, каталог команды setup. Всё это обязано лежать в
// безопасных корнях (песочница preload, системный tmp) и не совпадать с настоящими HOME, конфигурацией и
// workspace. Иначе прогон останавливается (код 97) до запуска процесса.
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { canonical, fold, inside } from "../src/paths";

export type Real = { home: string[]; configs: string[]; workspaces: string[] };
type Env = Record<string, string | undefined>;

// update пишет в сам движок (git merge, переход на stable) и после обновления запускает setup и sync
const WRITE = new Set(["sync", "clean", "setup", "adopt", "trust", "target", "update"]);
const key = (p: string) => fold(canonical(p));
const within = (p: string, roots: string[]) => roots.some((r) => inside(key(p), key(r)));
const isConfig = (dir: string) => existsSync(join(dir, "map.yaml"));
const pointer = (file: string, home: string) => {
  try {
    const v = readFileSync(file, "utf8").trim();
    return v ? v.replace(/^~(?=$|[\\/])/, home) : null;
  } catch { return null; }
};
function workspaceOf(config: string, home: string): string | null {
  try {
    const doc = Bun.YAML.parse(readFileSync(join(config, "local", "machine.yaml"), "utf8")) as { workspace?: unknown };
    return typeof doc?.workspace === "string" && doc.workspace.trim() ? doc.workspace.trim().replace(/^~(?=$|[\\/])/, home) : null;
  } catch { return null; }
}

// Настоящее окружение: снимается до подмены HOME, tmp и переменных в preload
export function realEnvironment(env: Env, engine: string, accountHome: string): Real {
  const home = [...new Set([env.USERPROFILE, env.HOME, accountHome].filter((h): h is string => !!h))];
  const configs = new Set<string>();
  if (env.MIKSY_CONFIG) configs.add(env.MIKSY_CONFIG);
  for (const h of home) { const p = pointer(join(h, ".miksy"), h); if (p) configs.add(p); }
  if (isConfig(join(engine, "..", "miksy-config"))) configs.add(join(engine, "..", "miksy-config"));
  const workspaces = [...configs].flatMap((c) => home.map((h) => workspaceOf(c, h)).filter((w): w is string => !!w));
  return { home, configs: [...configs], workspaces: [...new Set(workspaces)] };
}

// Причина отказа (null — запуск безопасен или это не запуск CLI движка с записью)
export function unsafeSpawn(argv: string[], opts: { env?: Env; cwd?: string }, real: Real, safe: string[]): string | null {
  const at = argv.findIndex((a) => /[\\/]src[\\/]cli\.ts$/.test(a));
  if (at < 0 || !WRITE.has(argv[at + 1] ?? "")) return null;
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const cmd = argv[at + 1];
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(cwd, p));
  const engine = dirname(dirname(abs(argv[at])));
  const home = (process.platform === "win32" ? env.USERPROFILE ?? env.HOME : env.HOME ?? env.USERPROFILE) ?? "";
  const problems: string[] = [];
  const check = (what: string, p: string | null) => {
    if (!p) return;
    const hit = [...real.home.filter((h) => key(h) === key(p)), ...real.configs.filter((c) => within(p, [c])), ...real.workspaces.filter((w) => within(p, [w]) || within(w, [p]))];
    if (hit.length || !within(p, safe)) problems.push(`${what}: ${p}${hit.length ? ` — настоящий ${hit[0]}` : " — вне песочницы"}`);
  };
  if (!home) problems.push("HOME не задан — процесс взял бы настоящий домашний каталог");
  check("HOME", home);
  // Конфигурация: переменная → указатель → соседний каталог; не найдена — setup создал бы соседний
  // каталог движка
  const sibling = join(engine, "..", "miksy-config");
  const config = env.MIKSY_CONFIG ? env.MIKSY_CONFIG.replace(/^~(?=$|[\\/])/, home)
    : pointer(join(home, ".miksy"), home) ?? (isConfig(sibling) ? sibling : isConfig(engine) ? engine : cmd === "setup" ? sibling : null);
  check("конфигурация (miksy-config)", config && abs(config));
  if (config) check(`workspace из ${config}/local/machine.yaml`, workspaceOf(abs(config), home));
  if (cmd === "setup" || cmd === "update") check("каталог команды (BUN_INSTALL)", env.BUN_INSTALL ?? join(home, ".bun"));
  // update меняет git-клон движка, из которого запущен: это должна быть копия в песочнице
  if (cmd === "update") check("движок (update меняет его git-клон)", engine);
  // Пути в аргументах: цель sync/clean/adopt/trust и --out (значения --agent и --to — не пути)
  const args = argv.slice(at + 2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^--(agent|to)$/.test(a)) { i++; continue; }
    if (a === "--out") { check("--out", abs(args[++i] ?? "")); continue; }
    if (a.startsWith("--out=")) { check("--out", abs(a.slice(6))); continue; }
    if (!a.startsWith("-") && (/[\\/]/.test(a) || a === "." || a === "..")) check("путь в аргументах", abs(a));
  }
  return problems.length ? `тест запускает «${cmd}» в настоящем окружении пользователя:\n  ${problems.join("\n  ")}` : null;
}

// Перехват: отказ — сообщение и остановка всего прогона
export function installGuard(real: Real, safe: string[]) {
  const stop = (argv: string[], opts: { env?: Env; cwd?: string } = {}) => {
    const why = unsafeSpawn(argv.map(String), opts, real, safe);
    if (!why) return;
    console.error(`\nОСТАНОВЛЕНО (test/guard.ts): ${why}\n`);
    process.exit(97);
  };
  const spawnSync = Bun.spawnSync, spawn = Bun.spawn;
  const split = (a: any, b: any): [string[], any] => (Array.isArray(a) ? [a, b ?? {}] : [a?.cmd ?? [], a ?? {}]);
  Bun.spawnSync = ((a: any, b?: any) => { const [argv, o] = split(a, b); stop(argv, o); return spawnSync(a, b); }) as typeof Bun.spawnSync;
  Bun.spawn = ((a: any, b?: any) => { const [argv, o] = split(a, b); stop(argv, o); return spawn(a, b); }) as typeof Bun.spawn;
}

