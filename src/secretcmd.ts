// miksy secret <ИМЯ> (круг 11k): skill получает один секрет из local/secrets.env в трубу — без пути к local/ и без
// чтения всего файла. Выдаются только секреты, объявленные для места текущего каталога: skill_secrets в layer.yaml
// слоёв места (глобальные — везде; дерево — его проектам; привязки map.yaml). Значение — в stdout без перевода строки;
// в терминал — только с --show (человеку). Агент запускает команды без терминала: от вывода значения в чат проверка
// терминала его не защищает — защищают правила skill. Объявление — защита от ошибки, не граница доступа: место
// определяется рабочим каталогом, агент может его сменить (круг 11l, docs/layers.md)
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { UsageError } from "./args";
import { resolve } from "node:path";
import { loadSecrets, serviceDir } from "./load";
import { driveRoot, slash } from "./paths";
import { enclosingTarget, globalTarget, layersOf, projectTarget } from "./registry";
import { merge } from "./resolve";
import { locate, machineRoots } from "./roots";
import type { Machine, Resolved, Sourced } from "./types";

export type SecretPlace = { where: string; layers: string[]; names: Sourced<string>[] };

// Секреты для skills места каталога dir: глобальные слои, затем слои места (как explain без пути). Слой у имени —
// первый, где оно объявлено
export function placeSkillSecrets(dir: string, machine: Machine): SecretPlace {
  const abs = slash(realpathSync.native(resolve(driveRoot(dir))));
  if (serviceDir(abs)) throw new Error(`${abs} — служебный каталог miksy (копии, бэкапы, сборки): секреты здесь не выдаются`);
  const roots = machineRoots(machine);
  const place = locate(abs, roots);
  const global = globalTarget(machine).cfg;
  let cfg: Resolved | null = null;
  let where = `вне workspace (${abs}) — только глобальные слои`;
  if (place && !place.rel) {
    cfg = merge(layersOf(place.tree, machine), machine.os);
    where = `корень workspace ${place.abs}`;
  } else if (place) {
    // Цель — как у sync без пути (круг 11l): ближайшая вверх (git-репо, target: true, каталог агента); подпапка цели без
    // git получает слои цели, а не своего места в дереве. Не цель — слои места в дереве
    const p = enclosingTarget(abs, place.root, machine);
    try {
      if (!p) throw new Error("не цель");
      const t = projectTarget(p.abs, p.rel, machine, p.nested);
      cfg = t.cfg;
      where = t.title;
    } catch {
      cfg = merge(layersOf(place.tree, machine), machine.os);
      where = place.tree;
    }
  }
  const names = new Map<string, string>();
  for (const s of [...(global.skillSecrets ?? []), ...(cfg?.skillSecrets ?? [])]) if (!names.has(s.item)) names.set(s.item, s.layer);
  return { where, layers: [...global.layers, ...(cfg?.layers ?? [])], names: [...names].map(([item, layer]) => ({ item, layer })) };
}

// Значение секрета для трубы; ошибка — Error с текстом без значения
export function secretValue(name: string, dir: string, machine: Machine, tty: boolean, show: boolean): string {
  const place = placeSkillSecrets(dir, machine);
  if (!place.names.some((s) => s.item === name)) {
    throw new Error(`секрет ${name} не объявлен для ${place.where} (слои: ${place.layers.join(" → ")}). ` +
      `Объявить — skill_secrets: [${name}] в layers/tree/<организация>[/<проект>]/layer.yaml; в layers/global/layer.yaml — получат skills всех организаций`);
  }
  const secrets = loadSecrets();
  if (!(name in secrets)) throw new Error(`секрет ${name} объявлен, но не задан в local/secrets.env конфигурации — впишите строку ${name}=<значение>`);
  if (tty && !show) throw new Error(`значение в терминал не выводится — отдайте его команде: miksy secret ${name} -- <команда> (в bash — и трубой: miksy secret ${name} | <команда>); показать на экране — miksy secret ${name} --show`);
  return secrets[name];
}

// ---- miksy secret ИМЯ [--line "…{}…"] [--env ПЕРЕМЕННАЯ] -- <команда> (круг 11n) ----
// miksy сам запускает команду и отдаёт ей значение: в stdin (байт в байт; --line — строка по шаблону, {} — значение, в
// конце LF) или в переменную окружения (--env; stdin команды — stdin miksy). Значение не проходит через оболочку
// (PowerShell 5.1 перекодировал бы его и дописал CRLF) и не попадает в командную строку. stdout и stderr команды —
// напрямую; код возврата — её; не найдена — 127, сигнал — 128+n. Ограничения выдачи — как у miksy secret ИМЯ

export class CommandNotFound extends Error {}

// Команда: путь (с / или \) — как есть; иначе поиск по PATH, на Windows — с PATHEXT (.exe, .cmd, .bat…)
function findCommand(cmd: string, env: Record<string, string | undefined>): string | null {
  if (/[\\/]/.test(cmd)) return existsSync(cmd) ? cmd : null;
  const path = env[Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH"] ?? "";
  return Bun.which(cmd, { PATH: path });
}

// Аргумент строки cmd /d /s /c "…" для .cmd/.bat: в кавычках (& | < > ^ ( ) — литералы), % и ! — вне кавычек с ^
// (%ИМЯ% раскрывается и в кавычках); " и перевод строки не передаются; обратные слэши в конце удваиваются
function cmdQuote(s: string): string {
  if (/["\r\n\u0000]/.test(s)) throw new Error(`аргумент ${JSON.stringify(s)} содержит " или перевод строки — в .cmd/.bat на Windows так не передаётся`);
  return `"${s.replace(/(\\+)$/, "$1$1").replace(/[%!]/g, (c) => `"^${c}"`)}"`;
}

export function runWithSecret(name: string, dir: string, machine: Machine, command: string[], o: { line?: string; env?: string }): number {
  if (!command.length) throw new UsageError(`после «--» нужна команда: miksy secret ${name} -- <команда> [аргументы…]`);
  if (o.env !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(o.env)) throw new UsageError(`--env — имя переменной окружения (буквы, цифры и «_»): --env PGPASSWORD`);
  if (o.env !== undefined && o.line !== undefined) throw new UsageError(`--line — для stdin, --env — для переменной окружения: укажите одно`);
  if (o.line !== undefined && o.line.split("{}").length !== 2) throw new UsageError(`в шаблоне --line ровно одно {} — место значения: --line "dev:{}"`);
  // Проверки выдачи — до запуска: необъявленное, не заданное — команда не запускается
  const value = secretValue(name, dir, machine, false, true);
  const env: Record<string, string | undefined> = { ...process.env, ...(o.env !== undefined && { [o.env]: value }) };
  const found = findCommand(command[0], env);
  if (!found) throw new CommandNotFound(`команда ${command[0]} не найдена${/[\\/]/.test(command[0]) ? "" : " (PATH)"} — секрет не передан`);
  const input = o.env !== undefined ? undefined : Buffer.from(o.line !== undefined ? o.line.replace("{}", () => value) + "\n" : value, "utf8");
  const stdio: ("pipe" | "inherit")[] = [input ? "pipe" : "inherit", "inherit", "inherit"];
  let r: ReturnType<typeof spawnSync>;
  if (process.platform === "win32" && /\.ps1$/i.test(found))
    throw new Error(`${found} — сценарий PowerShell: запустите его так: miksy secret ${name} -- powershell -NoProfile -File ${found}`);
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(found)) {
    // .cmd/.bat — через cmd дословно (Bun не перестраивает кавычки): cmd /d /s /c ""путь" "арг" …"
    const line = [found.replaceAll("/", "\\"), ...command.slice(1)].map(cmdQuote).join(" ");
    r = spawnSync(env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${line}"`], { input, stdio, env, windowsVerbatimArguments: true, windowsHide: true });
  } else {
    r = spawnSync(found, command.slice(1), { input, stdio, env, windowsHide: true });
  }
  if (r.error) throw new Error(`команда ${command[0]} не запущена: ${(r.error as Error).message}`);
  if (r.signal) return 128 + (osConstants.signals[r.signal as keyof typeof osConstants.signals] ?? 0);
  return r.status ?? 1;
}
