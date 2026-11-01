// Общее для тестов CLI: конфигурация, домашний каталог и workspace во временном каталоге
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
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
    Bun.spawnSync(["git", "init", "--quiet", `${ws}/${p}`]);
  }
  const run = (args: string[], o: { cwd?: string; stdin?: string } = {}) => {
    const r = Bun.spawnSync([process.execPath, CLI, ...args], {
      cwd: o.cwd ?? dir,
      env: { ...process.env, MIKSY_CONFIG: config, HOME: home, USERPROFILE: home },
      stdin: o.stdin === undefined ? "ignore" : Buffer.from(o.stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
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
