// Окружение машины: то, из-за чего агент не получит или получит не те настройки, хотя слои и sync в
// порядке, — несколько установок одной программы, переменные, меняющие каталог настроек агента,
// конфигурация не та, что рядом с движком. Только сообщения (doctor — «Справочно», мастер setup —
// шаг программ): ничего не удаляется и не меняется
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonical, fold, samePath, slash } from "./paths";
import type { Os } from "./types";
import { agentId } from "./agentid";
import { ADAPTERS } from "./agents";
import type { Adapter } from "./adapter";

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

// Программы, у которых вторая установка путает: Bun (команда miksy и мосты), агенты (адаптер: program), команды
// MCP-серверов. npx не проверяется отдельно: npm обновляет себя в свой каталог (%APPDATA%\npm),
// а Node.js — один (node)
const programs = (): { name: string; cmds: string[]; agent?: Adapter }[] => [
  { name: "Bun", cmds: ["bun"] },
  ...Object.values(ADAPTERS).map((a) => ({ name: a.program.name, cmds: a.program.commands, agent: a })),
  { name: "Node.js", cmds: ["node"] },
  { name: "uv", cmds: ["uv"] },
  { name: "Python", cmds: ["python3", "python"] },
];

const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
// Один файл — одна установка: ссылки (Homebrew) раскрываются; scoop — shim и каталог версии
export const real = (p: string) => {
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

const same = (a: string, b: string) => { try { return samePath(a, b); } catch { return fold(slash(a)) === fold(slash(b)); } };

export function environment(i: EnvInput): string[] {
  const notes: string[] = [];
  const tilde = (p: string) => (same(p, i.home) ? "~" : fold(slash(p)).startsWith(fold(slash(i.home)) + "/") ? `~${slash(p).slice(slash(i.home).length)}` : slash(p));

  for (const p of programs()) {
    const bun = p.cmds[0] === "bun";
    let list = installs(p.cmds, i.env, i.os, bun ? bunPlaces(i.env, i.home, i.os) : []);
    // Bun: используется тот, которым запущен miksy (не обязательно первый в PATH)
    if (bun) list = [slash(i.bun), ...list.filter((x) => real(x) !== real(i.bun))];
    const major = (x: string) => p.agent?.programMajor?.(x) ?? null;
    const ver = (x: string) => { const m = major(x); return m ? ` (${m}.x)` : ""; };
    if (list.length > 1) {
      const why = bun ? "этот Bun запоминают команда miksy и обёртки MCP-серверов" : "агенты и терминал могут запускать разные";
      notes.push(`${p.name}: установок несколько — используется ${tilde(list[0])}${ver(list[0])}${bun ? "" : " (первая в PATH)"}, ещё: ${list.slice(1).map((x) => tilde(x) + ver(x)).join(", ")}. Лучше оставить одну (${why}; обновляются они по отдельности) — лишние удалите сами`);
    }
    const note = list.length ? p.agent?.programNote?.(list[0], tilde(list[0])) : null;
    if (note) notes.push(note);
  }

  // Переменные, меняющие, где агент ищет настройки (адаптер: envVars): replace — агент читает только оттуда; иначе —
  // дополнительный конфиг поверх стандартного
  for (const v of Object.values(ADAPTERS).filter((a) => i.agents.map(agentId).includes(a.id)).flatMap((a) => a.envVars ?? [])) {
    const value = i.env[v.name];
    if (!value) continue;
    if (v.replace) {
      if (same(value, v.std(i.home))) continue;
      notes.push(`${v.name}=${slash(value)}: ${v.title} читает настройки из ${tilde(v.dir?.(value) ?? value)}, а miksy пишет в стандартный ${tilde(v.stdDir?.(i.home) ?? v.std(i.home))} — настройки miksy агент не увидит`);
    } else notes.push(`${v.name}=${slash(value)}: ${v.title} читает этот конфиг поверх ${tilde(v.over!(i.home))} — его ключи перекрывают настройки miksy`);
  }

  // Конфигурация задана явно (MIKSY_CONFIG или ~/.miksy), а рядом с движком лежит другая
  const sibling = join(dirname(i.engine), "miksy-config");
  const pointer = join(i.home, ".miksy");
  const how = i.env.MIKSY_CONFIG ? "MIKSY_CONFIG" : existsSync(pointer) ? "~/.miksy" : null;
  if (how && existsSync(join(sibling, "map.yaml")) && !same(sibling, i.config))
    notes.push(`конфигурация: используется ${slash(canonical(i.config))} (${how}); рядом с движком есть другая — ${slash(sibling)}, она не используется`);
  return notes;
}
