// Команда miksy (shim, ~/.bun/bin/miksy; на Windows — miksy.cmd и спутник miksy для Git Bash) — её пишет miksy setup; через неё агенты запускают MCP-серверы проектов
// (miksy mcp, src/mcprun.ts). Здесь же — где она лежит и в каком она виде (sync и doctor предупреждают о старом виде)
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { configRoot } from "./load";
import { dirname, join, win32 } from "node:path";
import { slash } from "./paths";
import type { Os } from "./types";

// Команда miksy (shim): запускает Bun, которым её создал setup, — по пути без версии (stableBun), чтобы
// sync из неё писал обёрткам моста тот же Bun; этого Bun нет — bun из PATH с предупреждением.
// .cmd — ASCII, а путь с не-ASCII — под chcp 65001 с возвратом прежней страницы и кода выхода.
// Bun — с --no-env-file и пустым конфигом движка (круг 10u-2): команду запускают в любой папке (агент — miksy mcp в
// папке проекта), и .env и bunfig.toml (preload) этой папки не должны попасть в процесс miksy и в серверы с
// секретами. legacy — формат до 10u-2 (без этих флагов): setup узнаёт его как свой и переписывает
const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
export const shimConfig = (cli: string) => `${cli.slice(0, cli.lastIndexOf("/") + 1)}bridge.bunfig.toml`;
// Те же флаги для процесса Bun с движком engine (update --finish, шаги downgrade — в каталоге пользователя);
// у движка без пустого конфига (старые выпуски) — только --no-env-file
export const engineBunArgs = (engine: string) => {
  const cfg = shimConfig(slash(join(engine, "src", "cli.ts")));
  return ["--no-env-file", ...(existsSync(cfg) ? [`--config=${cfg}`] : [])];
};
export function shimText(os: Os, bun: string, cli: string, legacy = false): string {
  const cfg = shimConfig(cli);
  if (os !== "windows") return [
    "#!/bin/sh",
    "# Команда miksy — создана miksy setup, он же её обновляет",
    `b=${shq(bun)}`,
    `[ -x "$b" ] || { echo "miksy: нет Bun $b — запускаю bun из PATH (обновить команду: miksy setup)" >&2; b=bun; }`,
    `exec "$b" ${legacy ? "" : `--no-env-file ${shq(`--config=${cfg}`)} `}${shq(cli)} "$@"`,
    "",
  ].join("\n");
  const b = bun.replaceAll("/", "\\").replaceAll("%", "%%");
  const c = cli.replaceAll("%", "%%");
  const flags = legacy ? "" : `--no-env-file "--config=${cfg.replaceAll("%", "%%")}" `;
  const utf8 = /[^\x00-\x7f]/.test(b + c);
  return [
    "@echo off",
    "setlocal",
    ...(utf8 ? ["set /a miksy_cp=0", `for /f "tokens=2 delims=:." %%c in ('chcp') do set /a "miksy_cp=%%c" >nul 2>&1`, "chcp 65001 >nul"] : []),
    "rem miksy command - created by miksy setup, which also updates it",
    `if not exist "${b}" goto path`,
    `"${b}" ${flags}"${c}" %*`,
    // Код выхода — явно: exit /b без кода после setlocal возвращает 0
    utf8 ? "goto done" : "exit /b %errorlevel%",
    ":path",
    `echo miksy: Bun "${b}" not found - running bun from PATH (miksy setup updates this command) 1>&2`,
    `bun ${flags}"${c}" %*`,
    ...(utf8 ? [":done", "set miksy_rc=%errorlevel%", "if %miksy_cp% GTR 0 chcp %miksy_cp% >nul", "exit /b %miksy_rc%"] : ["exit /b %errorlevel%"]),
    "",
  ].join("\r\n");
}

// Windows: спутник miksy.cmd — sh-скрипт «miksy» без расширения в той же папке (как у npm: name, name.cmd). Git Bash,
// MSYS2 и Cygwin не используют PATHEXT и miksy.cmd по имени «miksy» не находят; cmd и PowerShell берут .cmd (PATHEXT),
// файл без расширения им не мешает (круг 11m). Текст — тот же POSIX-вид (пути C:/…: bun.exe их понимает), LF
export const shimCompanion = (cmd: string) => cmd.replace(/\.cmd$/i, "");
export function shimFiles(os: Os, bun: string, cli: string): { name: string; text: string }[] {
  return os === "windows"
    ? [{ name: "miksy.cmd", text: shimText("windows", bun, cli) }, { name: "miksy", text: shimText("macos", bun, cli) }]
    : [{ name: "miksy", text: shimText(os, bun, cli) }];
}

// bash на Windows, которому нужен спутник: Git for Windows (bash в PATH, рядом с git в PATH, обычные места установки),
// MSYS2, Cygwin. System32\bash.exe — запуск WSL (там свой Linux и свой miksy), MinGit и git GitHub Desktop — без bash.
// Путь или null
export function windowsBash(env: Record<string, string | undefined> = process.env, exists: (p: string) => boolean = existsSync): string | null {
  const path = env[Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH"] ?? "";
  const dirs = path.split(";").filter(Boolean);
  const wsl = (d: string) => /[\\/](system32|sysnative)[\\/]?$/i.test(d) || /[\\/]microsoft[\\/]windowsapps[\\/]?$/i.test(d);
  // Пути Windows — и в тестах на macOS/Linux
  const wj = win32.join;
  const pf = [env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramW6432, env.LOCALAPPDATA && wj(env.LOCALAPPDATA, "Programs")].filter((x): x is string => !!x);
  const candidates = [
    ...dirs.filter((d) => !wsl(d)).map((d) => wj(d, "bash.exe")),
    // git.exe в PATH (Git\cmd) — bash рядом: Git\bin\bash.exe
    ...dirs.filter((d) => exists(wj(d, "git.exe"))).map((d) => wj(d, "..", "bin", "bash.exe")),
    ...pf.map((p) => wj(p, "Git", "bin", "bash.exe")),
    "C:\\msys64\\usr\\bin\\bash.exe", "C:\\cygwin64\\bin\\bash.exe", "C:\\cygwin\\bin\\bash.exe",
  ];
  return candidates.find((c) => exists(c)) ?? null;
}

// Команда miksy, которую создал setup (прежний формат — bun из PATH — тоже): только её setup обновляет
const OLD_SHIM = /^(?:@bun "[^"\r\n]*\/src\/cli\.ts" %\*\r?\n?|#!\/bin\/sh\nexec bun "[^"\n]*\/src\/cli\.ts" "\$@"\n?)$/;
export function ourShim(text: string): boolean {
  if (OLD_SHIM.test(text)) return true;
  // Нынешний формат и формат до 10u-2 (legacy, без --no-env-file и --config)
  const sh = text.match(/^b='((?:[^']|'\\'')*)'$[\s\S]*^exec "\$b" (?:--no-env-file '(?:[^']|'\\'')*' )?'((?:[^']|'\\'')*)' "\$@"$/m);
  if (sh) {
    const un = (s: string) => s.replaceAll("'\\''", "'");
    return [false, true].some((legacy) => text === shimText("macos", un(sh[1]), un(sh[2]), legacy));
  }
  const cmd = text.match(/^if not exist "([^"\r\n]*)" goto path\r$/m);
  const cli = text.match(/^bun (?:--no-env-file "[^"\r\n]*" )?"([^"\r\n]*)" %\*\r$/m);
  if (!cmd || !cli) return false;
  return [false, true].some((legacy) => text === shimText("windows", cmd[1].replaceAll("%%", "%"), cli[1].replaceAll("%%", "%"), legacy));
}


// Где команда miksy этой машины — устойчиво, не по окружению запуска (терминал и агент видят разный BUN_INSTALL, и
// блок с её каталогом переписывался бы туда-обратно, круг 10v-2): путь, который записал setup, создавая или обновляя
// её (local/state/miksy-command), если файл на месте; иначе — ~/.bun/bin, затем $BUN_INSTALL/bin — первый, где она есть
const record = () => { try { return join(configRoot(), "local", "state", "miksy-command"); } catch { return null; } };
export function rememberShim(path: string) {
  const r = record();
  if (!r) return;
  mkdirSync(dirname(r), { recursive: true, mode: 0o700 });
  // local/ — только владельцу (как учёт): 0600
  writeFileSync(r, slash(path) + "\n", { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(r, 0o600);
}
export function shimPath(home: string, os: Os, env: Record<string, string | undefined> = process.env): string {
  const r = record();
  try { const saved = r ? readFileSync(r, "utf8").trim() : ""; if (saved && existsSync(saved)) return slash(saved); } catch { /* записи нет */ }
  const name = os === "windows" ? "miksy.cmd" : "miksy";
  const places = [join(home, ".bun", "bin", name), ...(env.BUN_INSTALL ? [join(env.BUN_INSTALL, "bin", name)] : [])].map(slash);
  return places.find((x) => existsSync(x)) ?? places[places.length - 1];
}

// Вид команды: нынешний; старый (до 10u-2 — без --no-env-file: читает .env и bunfig.toml папки запуска; или
// прежний формат «bun из PATH»); чужая (не от miksy); нет файла
export function shimState(path: string): "current" | "legacy" | "foreign" | "missing" {
  let text: string;
  try { if (!statSync(path).isFile()) return "foreign"; text = readFileSync(path, "utf8"); }
  catch { return existsSync(path) ? "foreign" : "missing"; }
  if (!ourShim(text)) return "foreign";
  return text.includes("--no-env-file") ? "current" : "legacy";
}

// Строки rc-файла оболочки, которые уже добавляют каталог в PATH: export PATH="…:$PATH", PATH=…,
// fish_add_path …; $HOME, ${HOME}, ~ и переменные, заданные в этом же файле выше (установщик Bun пишет
// export BUN_INSTALL="$HOME/.bun" и export PATH="$BUN_INSTALL/bin:$PATH"), раскрываются
export function rcAddsDir(text: string, dir: string, home: string): boolean {
  const vars: Record<string, string> = { HOME: home };
  const expand = (s: string) => s.trim().replace(/^~(?=\/|$)/, home).replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, k: string) => vars[k] ?? m);
  const norm = (p: string) => slash(p).replace(/\/+$/, "");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const path = line.match(/^(?:export\s+)?PATH=(["']?)(.*)\1\s*(?:#.*)?$/) ?? line.match(/^fish_add_path\s+(?:-\w+\s+)*()(\S+)/);
    if (path) { if (path[2].split(":").map(expand).some((p) => norm(p) === norm(dir))) return true; continue; }
    const def = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(["']?)(.*)\2\s*(?:#.*)?$/);
    if (def) vars[def[1]] = expand(def[3]);
  }
  return false;
}

// Что сказать о команде miksy (sync и doctor). Старый вид — всегда: он читает .env и bunfig.toml папки, где его
// запускают. Когда ею запускаются MCP-серверы проектов (used): команды нет — проблема; её каталога нет в PATH программ,
// запущенных не из терминала (Windows — PATH пользователя и системы в реестре; macOS, Linux — rc-файлы оболочки,
// их читают оболочка входа и приложения, берущие её окружение), — справочно, с тем, что сделать
// agents — названия агентов, MCP проектов которых запускает команда miksy (адаптеры с projectMcp: "portable")
export function shimNotes(home: string, os: Os, used: boolean, o: { registryPath?: () => string | null; agents?: string[]; bash?: () => string | null } = {}): { problems: string[]; info: string[] } {
  const who = o.agents?.length ? o.agents.join(", ") : "агенты";
  const path = shimPath(home, os);
  const state = shimState(path);
  const problems: string[] = [], info: string[] = [];
  if (state === "legacy") problems.push(`команда miksy (${path}) старого вида: она читает .env и bunfig.toml папки, в которой её запускают (агенты — в папке проекта), — выполните miksy setup --yes`);
  // Windows: спутник для Git Bash (круг 11m) — только при своей miksy.cmd. Нет его или он старый — проблема, если на
  // машине есть bash (иначе он никому не нужен — молчим); чужой файл — справка
  if (os === "windows" && (state === "current" || state === "legacy")) {
    const sh = shimCompanion(path);
    const s = shimState(sh);
    if (s === "foreign") info.push(`${sh} — не команда miksy: в Git Bash (MSYS2, Cygwin) по имени miksy найдётся он, а не ${path}; уберите его и выполните miksy setup --yes`);
    else if (s !== "current" && (o.bash ?? windowsBash)())
      problems.push(`в Git Bash команды miksy ${s === "missing" ? "нет" : "старого вида"} (${sh}): агенты, которые выполняют команды через Git Bash, miksy не найдут (находится только miksy.cmd) — выполните miksy update или miksy setup --yes`);
  }
  if (!used) return { problems, info };
  if (state === "missing") problems.push(`команды miksy нет (${path}), а ею ${who} запускают MCP-серверы проектов (miksy mcp) — выполните miksy setup (создаст её)`);
  else if (state === "foreign") info.push(`${path} — не команда miksy: MCP-серверы проектов (${who}) запускаются командой miksy (miksy mcp) — уберите этот файл и выполните miksy setup --yes`);
  else {
    const dir = dirname(path);
    const norm = (p: string) => slash(p).replace(/\/+$/, "").toLowerCase();
    if (os === "windows") {
      const list = (o.registryPath ?? registryPath)();
      if (list !== null && !list.split(";").some((e) => e && norm(e.replace(/%([^%]+)%/g, (m, k: string) => process.env[k] ?? m)) === norm(dir)))
        info.push(`каталога команды miksy ${dir} нет в PATH пользователя — агенты не найдут её для MCP-серверов проектов: выполните miksy setup (предложит добавить)`);
    } else {
      const rcs = [".zshrc", ".zprofile", ".bash_profile", ".bashrc", ".profile", ".config/fish/config.fish"].map((f) => { try { return readFileSync(join(home, f), "utf8"); } catch { return ""; } });
      if (!rcs.some((t) => t.includes(dir) || rcAddsDir(t, dir, home)))
        info.push(`каталог команды miksy ${dir} не прописан в PATH оболочки (~/.zshrc, config.fish и т. п.) — агенты, запущенные не из терминала, не найдут её для MCP-серверов проектов: выполните miksy setup (предложит дописать)`);
    }
  }
  return { problems, info };
}

// PATH пользователя и системы из реестра Windows (раскрытый); не прочитан — null (проверка пропускается)
function registryPath(): string | null {
  const r = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", "[Environment]::GetEnvironmentVariable('Path','User') + ';' + [Environment]::GetEnvironmentVariable('Path','Machine')"], { stdout: "pipe", stderr: "pipe" });
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
}
