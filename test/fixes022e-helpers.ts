// Выпуск 0.2.2, круг 8e: помощники тестов fixes022e-* (взяты у рецензента проверки 8d, out/check022d). Всё — во временных
// каталогах песочницы (test/preload.ts); мастер в процессе — только с поддельной системой (sys)
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Ask } from "../src/ask";
import { runCommand } from "../src/commands";
import { newBackupRun } from "../src/backup";
import { setup } from "../src/setup";
import { aclProblem, closeCommand } from "../src/secretfiles";
import { CLI } from "./helpers";
import { cpSync } from "node:fs";
import { ENGINE } from "../src/load";

// Движок мастера — копия в песочнице (examples и заглушка cli.ts): workspace по умолчанию считается от неё, не от
// настоящего движка (круг 8e, F6)
export function sandboxEngine(dir: string): string {
  const engine = `${dir}/engine-copy/miksy`;
  if (!existsSync(`${engine}/src/cli.ts`)) {
    cpSync(join(ENGINE, "examples"), `${engine}/examples`, { recursive: true });
    put(`${engine}/src/cli.ts`, "// движок для теста\n");
  }
  return engine;
}

export const win = process.platform === "win32";
export const sys32 = (exe: string) => join(process.env.SystemRoot ?? "C:\\Windows", "System32", exe);
export const nat = (p: string) => p.replaceAll("/", "\\");
export const tmp = (p: string) => realpathSync.native(mkdtempSync(join(tmpdir(), p))).replaceAll("\\", "/");
export const put = (p: string, s = "x\n") => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };
export const read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
export const sid = () => new TextDecoder("latin1").decode(Bun.spawnSync([sys32("whoami.exe"), "/user", "/fo", "csv", "/nh"], { stdout: "pipe" }).stdout).trim().match(/,"(S-[0-9-]+)"$/)![1];

// PowerShell: одна строка или скрипт-файл (с BOM: PowerShell 5.1 читает файл без BOM в ANSI)
export const ps = (cmd: string, env: Record<string, string | undefined> = process.env) =>
  Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd.replace(/^\(PowerShell\) /, "")], { env, stdout: "pipe", stderr: "pipe" });
export function psFile(dir: string, body: string, env: Record<string, string | undefined> = process.env) {
  const file = `${dir}/s-${Math.random().toString(36).slice(2)}.ps1`;
  writeFileSync(file, "\uFEFF" + body, "utf8");
  const r = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", nat(file)], { env, stdout: "pipe", stderr: "pipe" });
  rmSync(file, { force: true });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

// SDDL объекта (icacls /save): права как есть, для сравнения «до/после»
export function sddl(p: string): string {
  const t = `${tmpdir()}/sddl-${Math.random().toString(36).slice(2)}.txt`;
  try {
    const r = Bun.spawnSync([sys32("icacls.exe"), nat(p), "/save", nat(t), "/L"], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) return `ошибка icacls ${r.exitCode}`;
    return readFileSync(t, "utf16le").split(/\r?\n/)[1] ?? "";
  } finally { rmSync(t, { force: true }); }
}

export type Close = "miksy" | "только вам" | "открыта";
export function closeTarget(p: string, how: Close) {
  if (!win) return Bun.spawnSync(["chmod", how === "открыта" ? "755" : "700", p]);
  if (how === "miksy") return ps(closeCommand(p, true));
  if (how === "только вам") return Bun.spawnSync([sys32("icacls.exe"), nat(p), "/inheritance:r", "/grant:r", `*${sid()}:F`], { stdout: "pipe" });
  return Bun.spawnSync([sys32("icacls.exe"), nat(p), "/grant", "*S-1-5-32-545:(OI)(CI)R"], { stdout: "pipe" });
}

// Все пути под каталогом, не заходя в ссылки; links — ссылки (путь → цель)
export function walk(d: string): { paths: string[]; links: Record<string, string> } {
  const out = { paths: [] as string[], links: {} as Record<string, string> };
  const go = (dir: string) => {
    let es;
    try { es = readdirSync(dir, { withFileTypes: true }); } catch { out.paths.push(`${dir} (не прочесть)`); return; }
    for (const e of es) {
      const p = `${dir}/${e.name}`;
      if (e.isSymbolicLink()) { let t = "?"; try { t = readlinkSync(p); } catch { /* */ } out.links[p] = t; }
      else if (e.isDirectory()) { out.paths.push(p); go(p); }
      else out.paths.push(p);
    }
  };
  if (existsSync(d)) go(d);
  return out;
}
// Что за ссылкой не так: открыто другим или не читается вами
export function badPaths(d: string): string[] {
  return walk(d).paths.flatMap((p) => {
    if (p.endsWith("(не прочесть)")) return [p];
    let why: string | null = null;
    try { why = aclProblem(p); } catch (e) { why = `права не прочитать: ${(e as Error).message}`; }
    let readOk = true;
    try { if (lstatSync(p).isDirectory()) readdirSync(p); else readFileSync(p); } catch { readOk = false; }
    return why || !readOk ? [`${p}: ${why ?? ""}${readOk ? "" : " (не читается вами)"}`] : [];
  });
}

export function cli(env: Record<string, string>, cwd: string, engine = join(import.meta.dir, "..")) {
  return (args: string[], stdin?: string) => {
    const r = Bun.spawnSync([process.execPath, `${engine.replaceAll("\\", "/")}/src/cli.ts`, ...args], {
      cwd, env: { ...process.env, ...env }, stdin: stdin === undefined ? "ignore" : Buffer.from(stdin), stdout: "pipe", stderr: "pipe",
    });
    return { code: r.exitCode, out: (r.stdout.toString() + r.stderr.toString()).trim() };
  };
}
export const CLI_PATH = CLI;

// Мастер (setup) в этом процессе — только с поддельной системой: rules — ответы по вопросам (регэксп → очередь)
export function inSetup(env: { config: string; home: string; dir: string }, rules: [RegExp, (boolean | string | null)[]][], force = true) {
  const saved = { ...process.env }, cwd = process.cwd(), logs: string[] = [], asked: string[] = [];
  Object.assign(process.env, { MIKSY_CONFIG: env.config, HOME: env.home, USERPROFILE: env.home });
  process.chdir(env.dir);
  newBackupRun();
  const pick = (q: string) => { asked.push(q); const r = rules.find(([re, a]) => re.test(q) && a.length); return r ? { hit: true, v: r[1].shift()! } : { hit: false, v: null }; };
  const ask: Ask = {
    yes: (q, def = false) => { const a = pick(q); return a.hit ? (a.v as boolean) : def; },
    line: (q) => { const a = pick(q); return a.hit ? (a.v as string | null) : null; },
    choose: (q, _o, def) => { const a = pick(q); return a.hit ? (a.v as string | null) : def ?? null; },
  };
  const fake = { which: () => null, exec: () => 0, git: () => 0, userPath: { get: () => "", set: () => {} }, refreshPath: () => {} };
  const orig = console.log;
  console.log = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); };
  try {
    const run = (cmd: string, args: string[], io: { ask?: Ask | null }) => runCommand(cmd, args, { ask: io.ask ?? ask });
    return { code: setup({ ask, force, run, sys: fake, engine: sandboxEngine(env.dir), log: (s = "") => logs.push(s) }), out: logs.join("\n"), asked };
  } catch (e) { return { code: -1, out: logs.join("\n") + "\n" + (e as Error).message, asked }; }
  finally {
    console.log = orig; process.chdir(cwd); newBackupRun();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

// Команда в этом процессе с ответами «в терминале» (как test/rootshelp.ts: inProcess)
export function inCmd(env: { config: string; home: string; dir: string }, args: string[], answers: (boolean | string)[] | null = null) {
  const saved = { ...process.env }, cwd = process.cwd(), log = console.log, out: string[] = [], questions: string[] = [];
  Object.assign(process.env, { MIKSY_CONFIG: env.config, HOME: env.home, USERPROFILE: env.home });
  process.chdir(env.dir);
  newBackupRun();
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  const next = (q: string) => { questions.push(q); if (!answers!.length) throw new Error(`лишний вопрос: ${q}`); return answers!.shift()!; };
  const io: Ask | null = answers ? { yes: (q) => next(q) as boolean, choose: () => null, line: (q) => (next(q) as string) || null } : null;
  try { return { code: runCommand(args[0], args.slice(1), { ask: io }), out: out.join("\n"), questions }; }
  catch (e) { return { code: -1, out: out.join("\n") + "\n" + (e as Error).message, questions }; }
  finally {
    console.log = log; process.chdir(cwd); newBackupRun();
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}
