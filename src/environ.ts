// Окружение машины: то, из-за чего агент не получит или получит не те настройки, хотя слои и sync в
// порядке, — несколько установок одной программы, переменные, меняющие каталог настроек агента,
// конфигурация не та, что рядом с движком. Только сообщения (doctor — «Справочно», мастер setup —
// шаг программ): ничего не удаляется и не меняется
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonical, fold, samePath, slash } from "./paths";
import type { Os } from "./types";

type Env = Record<string, string | undefined>;

export interface EnvInput {
  env: Env;
  home: string;
  os: Os;
  bun: string; // Bun этого процесса (путь без версии): его запоминают команда miksy и обёртки моста
  agents: string[]; // агенты машины: переменные каталогов настроек — только их
  engine: string;
  config: string; // конфигурация, с которой работает этот запуск
}

// Программы, у которых вторая установка путает: Bun (команда miksy и мосты), агенты, команды
// MCP-серверов. npx не проверяется отдельно: npm обновляет себя в свой каталог (%APPDATA%\npm),
// а Node.js — один (node)
const PROGRAMS: { name: string; cmds: string[] }[] = [
  { name: "Bun", cmds: ["bun"] },
  { name: "Claude Code", cmds: ["claude"] },
  { name: "Codex", cmds: ["codex"] },
  { name: "opencode", cmds: ["opencode"] },
  { name: "Antigravity (agy)", cmds: ["agy"] },
  { name: "Node.js", cmds: ["node"] },
  { name: "uv", cmds: ["uv"] },
  { name: "Python", cmds: ["python3", "python"] },
];

const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
// Один файл — одна установка: ссылки (Homebrew) раскрываются; scoop — shim и каталог версии
const real = (p: string) => {
  let r: string;
  try { r = fold(slash(realpathSync(p))); } catch { r = fold(slash(p)); }
  return r.replace(/\/scoop\/(?:shims\/([^/]+)\.exe|apps\/([^/]+)\/[^/]+\/[^/]+\.exe)$/i, (_m, shim, app) => `/scoop/${(shim ?? app).toLowerCase()}`);
};
const pathOf = (env: Env) => env[Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH"] ?? "";

// Установки программы: по одной на каталог PATH (по порядку — первая используется), затем известные
// места вне PATH (extra). Псевдонимы Windows (Microsoft\WindowsApps — заглушки магазина, ссылки
// App Installer) — не установки. Один и тот же файл (ссылки Homebrew) — одна установка
export function installs(cmds: string[], env: Env, os: Os, extra: string[] = []): string[] {
  const win = os === "windows";
  const exts = win ? [".exe", ".cmd", ".bat"] : [""];
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (p: string) => {
    const k = real(p);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(slash(p));
  };
  for (const dir of pathOf(env).split(win ? ";" : ":")) {
    if (!dir || (win && /[\\/]microsoft[\\/]windowsapps[\\/]?$/i.test(dir))) continue;
    const hit = cmds.flatMap((c) => exts.map((e) => join(dir, c + e))).find(isFile);
    if (hit) add(hit);
  }
  for (const p of extra) if (isFile(p)) add(p);
  return out;
}

// Где ещё бывает Bun вне PATH — только каталог официального установщика ($BUN_INSTALL/bin, ~/.bun/bin):
// его подхватывает install.sh и туда setup кладёт команду miksy. Homebrew, scoop и прочие места
// вне PATH не проверяются: программу оттуда не запускает ни терминал, ни агент
export function bunPlaces(env: Env, home: string, os: Os): string[] {
  const exe = os === "windows" ? "bun.exe" : "bun";
  return [join(env.BUN_INSTALL || join(home, ".bun"), "bin", exe), join(home, ".bun", "bin", exe)];
}

// Основная версия opencode — по пакету, из которого он установлен (npm: opencode-ai — 1.x, @opencode/cli
// — 2.x; Homebrew — по каталогу Cellar); иначе — неизвестна. Сам opencode не запускается: проверка
// только читает (opencode 2.x при запуске поднимает фоновый сервис)
export function opencodeMajor(exe: string): number | null {
  const where = [slash(exe), slash(real(exe))];
  try { if (statSync(exe).size < 65536) where.push(readFileSync(exe, "utf8")); } catch { /* нет доступа — по пути */ }
  const text = where.join("\n").replaceAll("\\", "/");
  if (/node_modules\/opencode-ai\//.test(text)) return 1;
  if (/node_modules\/@opencode\/cli\//.test(text)) return 2;
  const brew = text.match(/Cellar\/opencode\/(\d+)\./);
  return brew ? Number(brew[1]) : null;
}

// Переменные, меняющие, где агент ищет настройки: стандартный каталог (куда пишет miksy) — и что
// значит другое значение. replace — агент читает только оттуда; иначе — дополнительный конфиг поверх
const AGENT_VARS: { agent: string; name: string; title: string; std: (home: string) => string; replace: boolean }[] = [
  { agent: "claude", name: "CLAUDE_CONFIG_DIR", title: "Claude Code", std: (h) => join(h, ".claude"), replace: true },
  { agent: "codex", name: "CODEX_HOME", title: "Codex", std: (h) => join(h, ".codex"), replace: true },
  { agent: "opencode", name: "XDG_CONFIG_HOME", title: "opencode", std: (h) => join(h, ".config"), replace: true },
  { agent: "opencode", name: "OPENCODE_CONFIG", title: "opencode", std: () => "", replace: false },
  { agent: "opencode", name: "OPENCODE_CONFIG_DIR", title: "opencode", std: () => "", replace: false },
  { agent: "gemini", name: "GEMINI_CLI_HOME", title: "Antigravity", std: (h) => h, replace: true },
];

const same = (a: string, b: string) => { try { return samePath(a, b); } catch { return fold(slash(a)) === fold(slash(b)); } };

export function environment(i: EnvInput): string[] {
  const notes: string[] = [];
  const tilde = (p: string) => (same(p, i.home) ? "~" : fold(slash(p)).startsWith(fold(slash(i.home)) + "/") ? `~${slash(p).slice(slash(i.home).length)}` : slash(p));

  for (const p of PROGRAMS) {
    const bun = p.cmds[0] === "bun";
    let list = installs(p.cmds, i.env, i.os, bun ? bunPlaces(i.env, i.home, i.os) : []);
    // Bun: используется тот, которым запущен miksy (не обязательно первый в PATH)
    if (bun) list = [slash(i.bun), ...list.filter((x) => real(x) !== real(i.bun))];
    const major = (x: string) => (p.cmds[0] === "opencode" ? opencodeMajor(x) : null);
    const ver = (x: string) => { const m = major(x); return m ? ` (${m}.x)` : ""; };
    if (list.length > 1) {
      const why = bun ? "этот Bun запоминают команда miksy и обёртки MCP-серверов" : "агенты и терминал могут запускать разные";
      notes.push(`${p.name}: установок несколько — используется ${tilde(list[0])}${ver(list[0])}${bun ? "" : " (первая в PATH)"}, ещё: ${list.slice(1).map((x) => tilde(x) + ver(x)).join(", ")}. Лучше оставить одну (${why}; обновляются они по отдельности) — лишние удалите сами`);
    }
    if (p.cmds[0] === "opencode" && list.length && major(list[0]) === 1)
      notes.push(`opencode ${tilde(list[0])} — версия 1.x, а miksy пишет настройки в формате opencode 2.x: обновите opencode`);
  }

  for (const v of AGENT_VARS) {
    const value = i.env[v.name];
    if (!value || !i.agents.includes(v.agent)) continue;
    if (v.replace) {
      if (same(value, v.std(i.home))) continue;
      const dir = v.name === "XDG_CONFIG_HOME" ? join(value, "opencode") : v.name === "GEMINI_CLI_HOME" ? join(value, ".gemini") : value;
      notes.push(`${v.name}=${slash(value)}: ${v.title} читает настройки из ${tilde(dir)}, а miksy пишет в стандартный ${tilde(v.name === "XDG_CONFIG_HOME" ? join(v.std(i.home), "opencode") : v.name === "GEMINI_CLI_HOME" ? join(i.home, ".gemini") : v.std(i.home))} — настройки miksy агент не увидит`);
    } else notes.push(`${v.name}=${slash(value)}: ${v.title} читает этот конфиг поверх ~/.config/opencode — его ключи перекрывают настройки miksy`);
  }

  // Конфигурация задана явно (MIKSY_CONFIG или ~/.miksy), а рядом с движком лежит другая
  const sibling = join(dirname(i.engine), "miksy-config");
  const pointer = join(i.home, ".miksy");
  const how = i.env.MIKSY_CONFIG ? "MIKSY_CONFIG" : existsSync(pointer) ? "~/.miksy" : null;
  if (how && existsSync(join(sibling, "map.yaml")) && !same(sibling, i.config))
    notes.push(`конфигурация: используется ${slash(canonical(i.config))} (${how}); рядом с движком есть другая — ${slash(sibling)}, она не используется`);
  return notes;
}
