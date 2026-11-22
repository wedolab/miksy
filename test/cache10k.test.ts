// Круг 10k: кеш путей (canonical) только у команд без записи и меньше запусков git — ответы те же, что без кеша, и не
// устаревают
import { expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { cliFixture, expectCode, put } from "./helpers";
import { cachePaths, canonical, restorePaths } from "../src/paths";
import { cacheGit, repoOf } from "../src/git";
import { miksyExcludeLines } from "../src/apply";
import { scan0 as scanTeamSkills } from "./teamskills-readers"; // читатели — явно (круг 10x-2)
import { runCommand } from "../src/commands";

const win = process.platform === "win32";
const gitIn = (dir: string, stdin: string | undefined, ...a: string[]) => {
  const r = Bun.spawnSync(["git", "-C", dir, ...a], { stdin: stdin === undefined ? "ignore" : Buffer.from(stdin), stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
const git = (dir: string, ...a: string[]) => gitIn(dir, undefined, ...a);
// Ссылка на каталог: Windows — junction (прав не нужно), иначе symlink
const linkDir = (target: string, path: string) => symlinkSync(target, path, win ? "junction" : "dir");

// Считает вызовы realpathSync.native и запуски git (Bun.spawnSync) на время fn
function counting<T>(fn: () => T): { value: T; realpath: number; git: string[] } {
  const native = realpathSync.native;
  const spawn = Bun.spawnSync;
  let realpath = 0;
  const gits: string[] = [];
  (realpathSync as { native: typeof native }).native = ((p: string) => { realpath++; return native(p); }) as typeof native;
  (Bun as { spawnSync: typeof spawn }).spawnSync = ((...a: Parameters<typeof spawn>) => {
    const argv = (Array.isArray(a[0]) ? a[0] : (a[0] as { cmd: string[] }).cmd).map(String);
    if (/(^|[\\/])git(\.exe)?$/i.test(argv[0])) gits.push(argv.slice(1).join(" "));
    return spawn(...a);
  }) as typeof spawn;
  try { return { value: fn(), realpath, git: gits }; }
  finally {
    (realpathSync as { native: typeof native }).native = native;
    (Bun as { spawnSync: typeof spawn }).spawnSync = spawn;
  }
}

test("кеш путей: повтор — без realpath; без кеша новая ссылка видна сразу; после команды кеш выключен", () => {
  const d = cliFixture().dir;
  mkdirSync(`${d}/real/sub`, { recursive: true });
  const was = cachePaths(true);
  try {
    const first = counting(() => canonical(`${d}/real/sub`));
    const again = counting(() => canonical(`${d}/real/sub`));
    expect({ first: first.realpath, again: again.realpath, same: again.value === first.value }).toEqual({ first: 1, again: 0, same: true });
    // Ошибка (битая ссылка) — тоже из кеша, с тем же текстом
    linkDir(`${d}/gone`, `${d}/broken`);
    let e1 = "", e2 = "";
    try { canonical(`${d}/broken/x`); } catch (e) { e1 = (e as Error).message; }
    try { canonical(`${d}/broken/x`); } catch (e) { e2 = (e as Error).message; }
    expect(e1 && e1 === e2).toBe(true);
  } finally { restorePaths(was); }
  // Без кеша (пишущая команда): папка стала ссылкой — ответ новый
  const before = canonical(`${d}/via/sub`);
  linkDir(`${d}/real`, `${d}/via`);
  expect({ before, after: canonical(`${d}/via/sub`) }).toEqual({ before: `${realpathSync.native(d).replaceAll("\\", "/")}/via/sub`, after: canonical(`${d}/real/sub`) });
}, 30000);

test("sync --dry-run кеширует пути только на время команды; sync без --dry-run — без кеша; после doctor кеша нет", () => {
  const f = cliFixture();
  const saved = { ...process.env };
  Object.assign(process.env, { MIKSY_CONFIG: f.config, HOME: f.home, USERPROFILE: f.home });
  const orig = console.log;
  console.log = () => {};
  try {
    // Есть ли кеш сейчас: повторный canonical без realpath
    const cached = () => counting(() => { canonical(f.ws); canonical(f.ws); }).realpath < 2;
    const inside = (cmd: string, args: string[]) => {
      const seen: boolean[] = [];
      runCommand(cmd, args, { ask: null, observe: () => { seen.push(cached()); } });
      return [...new Set(seen)];
    };
    expect(inside("sync", ["--all", "--dry-run"])).toEqual([true]);
    expect(cached()).toBe(false);
    expect(inside("sync", ["--all"])).toEqual([false]);
    runCommand("doctor", [], { ask: null });
    expect(cached()).toBe(false);
  } finally {
    console.log = orig;
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}, 60000);

test("git: каталог за ссылкой внутри репо — без нового rev-parse, ответ как без кеша", () => {
  const d = cliFixture().dir;
  mkdirSync(`${d}/repo/.agents/skills/s`, { recursive: true });
  git(d, "init", "-q", "repo");
  mkdirSync(`${d}/repo/.codex/skills`, { recursive: true });
  linkDir(`${d}/repo/.agents/skills/s`, `${d}/repo/.codex/skills/s`);
  const plain = repoOf(`${d}/repo/.codex/skills/s`);
  cacheGit();
  try {
    expect(repoOf(`${d}/repo`)).toBe(plain);
    const c = counting(() => repoOf(`${d}/repo/.codex/skills/s`));
    expect({ top: c.value, git: c.git }).toEqual({ top: plain, git: [] });
  } finally { cacheGit(false); }
  expect(plain).toBe(canonical(`${d}/repo`));
}, 30000);

test("git: разбор командных skills — из общего индекса, результат как без кеша; exclude worktree — один запрос", () => {
  const d = cliFixture().dir;
  mkdirSync(`${d}/repo`, { recursive: true });
  git(d, "init", "-q", "repo");
  put(`${d}/repo/.claude/skills/s/SKILL.md`, "---\nname: s\ndescription: d\n---\nx\n");
  put(`${d}/repo/.agents/skills/t/SKILL.md`, "---\nname: t\ndescription: d\n---\nx\n");
  put(`${d}/repo/.claudeX/skills/u/SKILL.md`, "x\n"); // похожее имя — не из ROOTS
  put(`${d}/repo/src/a.ts`, "x\n");
  git(`${d}/repo`, "add", ".");
  // Ссылка в индексе (режим 120000) на skill t, без файла на диске: настройка core.symlinks не важна
  const sha = gitIn(`${d}/repo`, "../../.agents/skills/t", "hash-object", "-w", "--stdin");
  git(`${d}/repo`, "update-index", "--add", "--cacheinfo", `120000,${sha},.codex/skills/link`);
  git(`${d}/repo`, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "x");
  const plain = JSON.stringify(scanTeamSkills(`${d}/repo`));
  cacheGit();
  try {
    const c = counting(() => JSON.stringify(scanTeamSkills(`${d}/repo`)));
    expect(c.value).toBe(plain);
    expect(c.git.filter((g) => / ls-files /.test(g))).toEqual([`-C ${d}/repo ls-files -s -z`]);
  } finally { cacheGit(false); }
  // Worktree: .git — файл, путь exclude спрашивается у git один раз за команду
  git(`${d}/repo`, "worktree", "add", "-q", `${d}/wt`);
  const plainLines = miksyExcludeLines(`${d}/wt`);
  cacheGit();
  try {
    const c = counting(() => [miksyExcludeLines(`${d}/wt`), miksyExcludeLines(`${d}/wt`)]);
    expect(c.value).toEqual([plainLines, plainLines]);
    expect(c.git.filter((g) => g.includes("--git-path")).length).toBe(1);
  } finally { cacheGit(false); }
}, 60000);

test("пишущая команда видит созданное ею: sync создаёт каталог skills, doctor после — всё записано", () => {
  const f = cliFixture();
  put(`${f.config}/layers/global/skills/hello/SKILL.md`, "---\nname: hello\ndescription: d\n---\nx\n");
  expectCode(f.run(["sync", "--global"]), 0);
  expectCode(f.run(["sync", "--all"]), 0);
  const d = f.run(["doctor"]);
  expectCode(d, 0);
  expect(d.out).toContain("Всё синхронизировано.");
}, 60000);
