// Версия движка: номер — version в package.json (SemVer), коммит — в духе git describe. На релизе (тег
// vX.Y.Z на HEAD) — «0.1.0»; после него — «0.1.0-5-g878b373» (коммитов от релиза); тегов нет — версия и
// коммит; правки в отслеживаемых файлах — «-dirty»; движок не git-клон — только номер
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ENGINE } from "./load";
import { gitEnv } from "./git";
import { samePath } from "./paths";
import { compareVersions, SEMVER } from "./changelog";

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

const git = (dir: string, args: string[]) => {
  try {
    const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe", env: gitEnv() });
    return { code: r.exitCode, out: r.stdout.toString().trim() };
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

// Учёт записан более новой версией движка: на другой копии движка уже обновились или этот откатили. Только
// сообщение, запись не блокируется: рецепт отката (README, «Откатиться на прежнюю версию») заканчивается
// sync прежней версией, а учёт совместим вперёд — чужое не перезаписывается, лишнее поле прежняя версия
// отбрасывает. Сравниваются номера X.Y.Z: сборка main «0.2.0-3-g…» — та же 0.2.0, не новее
export function newerLedger(recorded: string | undefined, engine = ENGINE): string | null {
  const mine = packageVersion(engine);
  const theirs = recorded && baseVersion(recorded);
  if (!theirs || mine === "?" || compareVersions(theirs, mine) <= 0) return null;
  return `учёт miksy (local/state/manifest.json) записан более новой версией движка — ${theirs}, а этот движок — ${mine}. Обновились на другой копии движка — обновите и эту: miksy update. Откатились нарочно — сделайте шаги из README, «Откатиться на прежнюю версию»: без них часть записанного будет конфликтами (ничего не потеряется); шаги сделаны — ничего делать не нужно, сообщение пропадёт, когда эта версия сама запишет учёт (первый sync с изменениями)`;
}
