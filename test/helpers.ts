// Общее для тестов CLI: конфигурация, домашний каталог и workspace во временном каталоге
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const CLI = resolve(import.meta.dir, "..", "src", "cli.ts");

export function put(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

// Конфигурация: глобальный слой и слой workspace с инструкциями; projects — проекты workspace (git-репо)
export function cliFixture(opts: { agents?: string[]; projects?: string[] } = {}) {
  // Полный путь: TEMP бывает коротким именем 8.3 (RUNNER~1 на раннерах GitHub), а miksy печатает полный
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "cli-"))).replaceAll("\\", "/");
  const config = `${dir}/config`;
  const home = `${dir}/home`;
  const ws = `${dir}/ws`;
  mkdirSync(home, { recursive: true });
  put(`${config}/map.yaml`, "global:\n  - { use: global }\nlayers: []\n");
  put(`${config}/layers/global/instructions/00.md`, "# global\n");
  put(`${config}/layers/tree/instructions/00.md`, "# workspace\n");
  put(`${config}/local/machine.yaml`, `workspace: ${ws}\nagents: [${(opts.agents ?? ["claude"]).join(", ")}]\n`);
  for (const p of opts.projects ?? ["Org/p1"]) {
    mkdirSync(`${ws}/${p}`, { recursive: true });
    gitInit(`${ws}/${p}`);
  }
  const run = (args: string[], o: { cwd?: string; stdin?: string } = {}) => {
    const r = Bun.spawnSync([process.execPath, CLI, ...args], {
      cwd: o.cwd ?? dir,
      env: { ...process.env, MIKSY_CONFIG: config, HOME: home, USERPROFILE: home },
      stdin: o.stdin === undefined ? "ignore" : Buffer.from(o.stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    const res = { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
    ciDump(args, o.cwd ?? dir, res.code, res.out, res.err);
    return res;
  };
  return { dir, config, home, ws, run };
}

// Текстовые файлы каталога для проверок «что записано»: без .git (кроме info/exclude) и без бинарных
// (NUL в начале файла — индексы, кеши); skip — пути, которые не обходить
export function textFiles(dir: string, skip: (p: string) => boolean = () => false, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (skip(p)) continue;
    if (e.isDirectory()) {
      if (e.name === ".git") { if (existsSync(`${p}/info/exclude`)) out.push(`${p}/info/exclude`); }
      else textFiles(p, skip, out);
    } else if (e.isFile() && !readFileSync(p).subarray(0, 8000).includes(0)) out.push(p);
  }
  return out;
}

// Конфиги агентов в домашнем каталоге — то, что пишет miksy глобально (остальное в песочном HOME —
// кеши Bun, git и т. п. — не его)
export const AGENT_HOME = [".claude", ".claude.json", ".codex", ".gemini", ".agents", ".config/opencode", ".miksy"];
export const agentHomeFiles = (home: string) => AGENT_HOME.flatMap((d) => {
  const p = `${home}/${d}`;
  return !existsSync(p) ? [] : statSync(p).isDirectory() ? textFiles(p) : [p];
});

// На CI (GitHub задаёт CI=true) — вывод команды miksy с кодом ≠ 0 в лог теста: редкие «3 вместо 0» и «1 вместо 0» на
// macOS GitHub не воспроизводятся на стенде (круги 10d-4, 10d-5). Локально — тишина. Тесты, где ненулевой код ожидаем,
// тоже печатают — это шум; вывод одной команды — не больше 6000 символов. Пишем прямо в дескриптор 2, без
// process.stderr: в Bun 1.3.14 под --parallel на Linux первое обращение к нему падает «EEXIST … epoll_ctl»
// (круг 10d-7, 46 падений на CI 0.3.1). Диагностика не роняет тест ни при каком сбое записи
export function ciDump(args: string[], cwd: string, code: number | null, out: string, err: string) {
  if (!process.env.CI || code === 0) return;
  const cut = (s: string) => (s.length > 6000 ? `${s.slice(0, 6000)}\n… (ещё ${s.length - 6000} символов)` : s);
  const text = `\n[miksy code ${code}] miksy ${args.join(" ")} (cwd ${cwd})\n--- stdout\n${cut(out)}\n--- stderr\n${cut(err)}\n--- end\n`;
  try {
    const buf = Buffer.from(text);
    for (let at = 0, idle = 0; at < buf.length && idle < 100;) {
      const n = writeSync(2, buf, at);
      at += n;
      idle = n > 0 ? 0 : idle + 1;
    }
  } catch {
    try { console.error(text); } catch { /* диагностика — не повод ронять тест */ }
  }
}

// git init для заготовки теста: сбой — сразу ошибка с причиной, а не проект без .git и загадочный код 3 позже
// (круг 10d-4: редкие «3 вместо 0» на macOS GitHub)
export function gitInit(dir: string) {
  const r = Bun.spawnSync(["git", "init", "--quiet", dir], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git init ${dir}: код ${r.exitCode}, ${r.stderr.toString().trim()}`);
}
