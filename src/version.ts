// Версия движка: номер — version в package.json (SemVer), коммит — в духе git describe. На релизе (тег
// vX.Y.Z на HEAD) — «0.1.0»; после него — «0.1.0-5-g878b373» (коммитов от релиза); тегов нет — версия и
// коммит; правки в отслеживаемых файлах — «-dirty»; движок не git-клон — только номер
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ENGINE } from "./load";
import { gitSpawn } from "./git";
import { samePath } from "./paths";
import { compareVersions, SEMVER } from "./changelog";
import { count } from "./plural";

export { compareVersions, SEMVER };

// Номер из package.json движка; не читается — «?» (версия — сведения, а не условие работы)
export function packageVersion(engine = ENGINE): string {
  try {
    const v = (JSON.parse(readFileSync(join(engine, "package.json"), "utf8")) as { version?: unknown }).version;
    return typeof v === "string" && SEMVER.test(v) ? v : "?";
  } catch { return "?"; }
}

// Номер X.Y.Z из строки версии («0.1.0-5-gabc» → «0.1.0»); нет — null
export const baseVersion = (v: string): string | null => /^v?(\d+\.\d+\.\d+)/.exec(v)?.[1] ?? null;

// rev-parse и describe при успехе всегда печатают — пустой ответ повторяется один раз (gitSpawn, круг 10d-6); status
// --porcelain пустым бывает законно
const git = (dir: string, args: string[]) => {
  try {
    const r = gitSpawn(["-C", dir, ...args], { needOut: args[0] === "rev-parse" || args[0] === "describe" });
    return { code: r.code, out: r.out.trim() };
  } catch { return { code: -1, out: "" }; }
};

// Движок — корень своего git-клона (а не каталог внутри чужого репо, например workspace)
export function engineRepo(engine = ENGINE): boolean {
  const top = git(engine, ["rev-parse", "--show-toplevel"]);
  try { return top.code === 0 && samePath(top.out, engine); } catch { return false; }
}

// Версия один раз на процесс (заголовки doctor, help); describeEngine — заново (update меняет HEAD)
const described = new Map<string, string>();
export function engineVersion(engine = ENGINE): string {
  if (!described.has(engine)) described.set(engine, describeEngine(engine));
  return described.get(engine)!;
}

export function describeEngine(engine = ENGINE): string {
  const version = packageVersion(engine);
  let text = version;
  if (engineRepo(engine)) {
    const d = git(engine, ["describe", "--tags", "--match", "v[0-9]*.[0-9]*.[0-9]*", "--dirty"]);
    if (d.code === 0 && d.out) text = d.out.replace(/^v/, "");
    else {
      const head = git(engine, ["rev-parse", "--short", "HEAD"]);
      const dirty = git(engine, ["status", "--porcelain", "--untracked-files=no"]);
      if (head.code === 0 && head.out) text = `${version} (коммит ${head.out}${dirty.code === 0 && dirty.out ? ", есть правки" : ""})`;
    }
  }
  return text;
}

// Пояснение к номеру для miksy --version (круг 11s): «0.7.0-2-gc5c1a79-dirty» — не выпуск, на 2 коммита новее 0.7.0,
// коммит c5c1a79; -dirty — в папке движка незакоммиченные правки. Выпуск (только номер) и другие формы — null
export function versionNote(v: string): string | null {
  const m = /^(\d+\.\d+\.\d+)(?:-(\d+)-g([0-9a-f]+))?(-dirty)?$/.exec(v);
  if (!m || (!m[2] && !m[4])) return null;
  return [
    ...(m[2] ? [`не выпуск: на ${count(Number(m[2]), "коммит", "коммита", "коммитов")} новее выпуска ${m[1]}, коммит ${m[3]}`] : []),
    ...(m[4] ? ["в папке движка есть незакоммиченные правки"] : []),
  ].join("; ");
}

// Минимальная версия Bun — как engines в package.json (тест сверяет). В Bun до 1.4.3 spawnSync изредка теряет вывод
// или выход git (oven-sh/bun#44581, круг 10f); miksy на старом Bun работает, doctor только предупреждает
export const MIN_BUN = "1.4.3";
export function oldBun(version: string = Bun.version): string | null {
  const base = baseVersion(version);
  if (!base || compareVersions(base, MIN_BUN) >= 0) return null;
  return `Bun ${version} устарел: в версиях до ${MIN_BUN} бывают редкие сбои запуска git. Обновите: bun upgrade`;
}

// Учёт записан более новой версией движка: на другой копии движка уже обновились или этот откатили. Только
// сообщение, запись не блокируется: откат (miksy downgrade, src/downgrade.ts) — setup и sync прежней версией, а учёт
// совместим вперёд — чужое не перезаписывается, лишнее поле прежняя версия отбрасывает. Отметку
// переписывают setup этой версии (markLedger, src/setup.ts — с 0.2.2) и любая запись учёта. Сравниваются номера
// X.Y.Z: сборка main «0.2.0-3-g…» — та же 0.2.0, не новее
export function newerLedger(recorded: string | undefined, engine = ENGINE): string | null {
  const mine = packageVersion(engine);
  const theirs = recorded && baseVersion(recorded);
  if (!theirs || mine === "?" || compareVersions(theirs, mine) <= 0) return null;
  return `учёт miksy (local/state/manifest.json) записан более новой версией движка — ${theirs}, а этот движок — ${mine}. Обновились на другой копии движка — обновите и эту: miksy update. Откатили движок сами (git), а не командой miksy downgrade, — выполните miksy setup --yes, затем miksy sync --global и miksy sync --all (docs/update.md, «Откатиться на прежнюю версию»): без них часть записанного будет конфликтами (ничего не потеряется); miksy setup уберёт и это сообщение (если команда miksy ведёт на этот движок; иначе оно пропадёт при первом sync с изменениями)`;
}
