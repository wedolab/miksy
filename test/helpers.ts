// Общее для тестов CLI: конфигурация, домашний каталог и workspace во временном каталоге
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect } from "bun:test";
import { placeSlug, scriptName } from "../src/launch";
import { shimPath, shimText } from "../src/shim";

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
    Object.defineProperty(res, "cmd", { value: `miksy ${args.join(" ")} (cwd ${o.cwd ?? dir})`, enumerable: false });
    return res;
  };
  return { dir, config, home, ws, run };
}

// Команда miksy в доме песочницы, как её создаёт setup: ею агенты запускают MCP-серверы проектов (miksy mcp), и
// doctor считает проблемой, если её нет (круг 10v)
export function withShim(f: { home: string }): string {
  const os = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";
  const path = shimPath(f.home, os, {});
  put(path, shimText(os, process.execPath.replaceAll("\\", "/"), CLI.replaceAll("\\", "/")));
  if (os !== "windows") chmodSync(path, 0o755);
  return path;
}

// Переносимый запуск в файле проекта (круг 10u): «miksy mcp <агент> <место> <сервер> [--bridge]» в TOML или JSON →
// обёртка этой машины, как её находит src/mcprun.ts. Нет такого запуска — null
export function portableRuns(text: string): { agent: string; place: string; server: string; kind: "stdio" | "bridge" }[] {
  return [...text.replace(/\s+/g, " ").matchAll(/"mcp", "([^"]+)", "([^"]+)", "([^"]+)"(, "--bridge")?/g)]
    .map((m) => ({ agent: m[1], place: m[2], server: m[3], kind: m[4] ? "bridge" as const : "stdio" as const }));
}
export function mcpWrapper(config: string, r: { agent: string; place: string; server: string; kind?: "stdio" | "bridge" | "headers" }, os = process.platform === "win32" ? "windows" : "macos"): string {
  return `${config}/local/run/${r.agent}/${placeSlug(r.place)}/${scriptName(r.server, r.kind ?? "stdio")}${os === "windows" ? ".cmd" : ".sh"}`;
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

// Говорящие проверки кода выхода (круг 10h): при несовпадении в сообщении — команда (если известна), ожидаемый и
// полученный код, stdout и stderr (обрезка до 6000 символов). Результат — любой объект запуска: { code, out, err } тестов
// CLI, Bun.spawnSync ({ exitCode, stdout, stderr }; вывод inherit — «нет»). Команду знают результаты cliFixture.run
// (скрытое поле cmd — toEqual его не видит)
type Ran = { code?: number | null; exitCode?: number | null; out?: unknown; err?: unknown; stdout?: unknown; stderr?: unknown; cmd?: unknown };
const cut = (s: string) => (s.length > 6000 ? `${s.slice(0, 6000)}\n… (ещё ${s.length - 6000} символов)` : s);
const text = (v: unknown) => v === undefined || v === null ? "(нет)" : typeof v === "string" ? v : v instanceof Uint8Array ? Buffer.from(v).toString() : String(v);
const codeOf = (r: Ran) => (r.code !== undefined ? r.code : r.exitCode);
function said1(r: Ran): string {
  if (!r || typeof r !== "object") return `\n(результат: ${String(r)})`;
  const cmd = typeof r.cmd === "string" ? `\nкоманда: ${r.cmd}` : "";
  return `${cmd}\nкод ${codeOf(r)}\n--- stdout\n${cut(text(r.out ?? r.stdout))}\n--- stderr\n${cut(text(r.err ?? r.stderr))}\n--- конец`;
}
// Текст для второго аргумента expect: что сказали команды (массивы раскрываются)
export const said = (...rs: unknown[]): string => rs.flat().map((r) => said1(r as Ran)).join("\n");
export function expectCode(r: Ran, want: number | null) {
  const got = codeOf(r);
  if (got === want) return expect(got).toBe(want);
  expect(got, `код выхода ${got} вместо ${want}${said1(r)}`).toBe(want);
}
export function expectCodeIn(r: Ran, allowed: (number | null)[]) {
  const got = codeOf(r);
  if (allowed.includes(got ?? null)) return expect(allowed).toContain(got);
  expect(allowed, `код выхода ${got} — ожидался один из ${allowed.join(", ")}${said1(r)}`).toContain(got);
}
export function expectNotCode(r: Ran, not: number | null) {
  const got = codeOf(r);
  if (got !== not) return expect(got).not.toBe(not);
  expect(got, `код выхода ${got} — ожидался любой другой${said1(r)}`).not.toBe(not);
}

// git init для заготовки теста: сбой — сразу ошибка с причиной, а не проект без .git и загадочный код 3 позже
// (круг 10d-4: редкие «3 вместо 0» на macOS GitHub)
export function gitInit(dir: string) {
  const r = Bun.spawnSync(["git", "init", "--quiet", dir], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git init ${dir}: код ${r.exitCode}, ${r.stderr.toString().trim()}`);
}

// Вернуть окружение процесса к снимку { ...process.env } на месте. Не process.env = saved: замена делает его
// обычным объектом, и на Windows пропадает нечувствительность к регистру — process.env.Path больше не PATH
// (тест мастера после этого дописывал в PATH отдельный ключ Path и терял git; круг 11e)
export function restoreEnv(saved: Record<string, string | undefined>) {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
}
