// miksy setup — мастер установки машины: конфигурация, workspace и агенты, копия настроек агентов,
// программы MCP, команда miksy и PATH, добавки агентов (adopt), секреты, план, запись, проверка.
// Каждый шаг определяет, сделан ли он, по состоянию (конфигурация, machine.yaml, копия, учёт), —
// повторный запуск продолжает с несделанного. Вопросы — через Ask (src/ask.ts), команды miksy (sync,
// adopt) — через run в этом же процессе, действия с системой (установка программ, PATH, git) — через
// System: тесты подменяют все три. Без Ask (--yes, нет терминала) — только безопасная часть.
import { appendFileSync, chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { canonical, homeDir, samePath, slash } from "./paths";
import { basename, delimiter, dirname, join, posix, relative, win32 } from "node:path";
import { ensurePrivateLocal } from "./secretfiles";
import { currentOs, ENGINE, findConfig, hasConfig, LAYER_PARTS, loadMachine, loadMap, loadSecrets, parseYaml } from "./load";
import { backup } from "./backup";
import { writeAtomic } from "./manifest";
import type { Ask } from "./ask";
import type { TargetReport } from "./commands";
import { doctor } from "./doctor";
import { stableBun } from "./launch";
import { engineVersion } from "./version";
import { environment } from "./environ";
import { ADAPTERS, agentsFor, allTargets, globalTarget, listGroups } from "./registry";
import type { McpServer, Os, Tool } from "./types";

// Как найти агента: команда в PATH
const AGENT_COMMANDS: Record<string, string[]> = {
  claude: ["claude"],
  codex: ["codex"],
  opencode: ["opencode"],
  gemini: ["agy", "antigravity"],
};

// Каталоги настроек агента в домашнем каталоге: агент бывает только в редакторе (Zed), без команды в PATH
const AGENT_DIRS: Record<string, string[]> = {
  claude: [".claude"],
  codex: [".codex"],
  opencode: [".config/opencode"],
  gemini: [".gemini/antigravity-cli", ".gemini/antigravity-ide", ".gemini/antigravity"],
};

// Какие агенты есть на машине: команда в PATH или (отдельно) только каталог настроек
export function detectAgents(home: string, which: (cmd: string) => string | null = (c) => Bun.which(c)) {
  const inPath: string[] = [], dirOnly: { id: string; dir: string }[] = [];
  for (const [id, cmds] of Object.entries(AGENT_COMMANDS)) {
    if (cmds.some((c) => which(c))) { inPath.push(id); continue; }
    const dir = AGENT_DIRS[id].map((d) => join(home, d)).find((d) => existsSync(d));
    if (dir) dirOnly.push({ id, dir: slash(dir) });
  }
  return { inPath, dirOnly };
}

// Машинные переменные (пути к программам): как найти и как установить, если нет. Встроен только
// PYTHON; свои — tools в map.yaml конфигурации (перекрывают встроенное)
const BUILTIN_TOOLS: Record<string, Tool> = {
  PYTHON: { find: ["python3", "python"], install: { macos: "brew install python", linux: "sudo apt install python3", windows: "winget install Python.Python.3.12" } },
};
const machineTools = (config: string): Record<string, Tool> => ({ ...BUILTIN_TOOLS, ...loadMap(config).tools });

// Частые программы команд MCP-серверов (command в mcp/*.yaml): как поставить на каждой ОС —
// официальный установщик или менеджер пакетов; нет команды — страница загрузки
export const PROGRAMS: { name: string; commands: string[]; install: Record<Os, string> }[] = [
  { name: "Node.js", commands: ["node", "npx", "npm"],
    install: { macos: "brew install node", windows: "winget install OpenJS.NodeJS.LTS", linux: "https://nodejs.org/en/download" } },
  { name: "uv", commands: ["uv", "uvx"],
    install: { macos: "curl -LsSf https://astral.sh/uv/install.sh | sh", linux: "curl -LsSf https://astral.sh/uv/install.sh | sh",
      windows: "powershell -ExecutionPolicy ByPass -c \"irm https://astral.sh/uv/install.ps1 | iex\"" } },
  { name: "Docker", commands: ["docker"],
    install: { macos: "brew install --cask docker", windows: "winget install Docker.DockerDesktop", linux: "https://docs.docker.com/engine/install/" } },
  { name: "Python", commands: ["python", "python3"], install: BUILTIN_TOOLS.PYTHON.install as Record<Os, string> },
];

// Команда miksy (shim): запускает Bun, которым её создал setup, — по пути без версии (stableBun), чтобы
// sync из неё писал обёрткам моста тот же Bun; этого Bun нет — bun из PATH с предупреждением.
// .cmd — ASCII, а путь с не-ASCII — под chcp 65001 с возвратом прежней страницы и кода выхода
const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
export function shimText(os: Os, bun: string, cli: string): string {
  if (os !== "windows") return [
    "#!/bin/sh",
    "# Команда miksy — создана miksy setup, он же её обновляет",
    `b=${shq(bun)}`,
    `[ -x "$b" ] || { echo "miksy: нет Bun $b — запускаю bun из PATH (обновить команду: miksy setup)" >&2; b=bun; }`,
    `exec "$b" ${shq(cli)} "$@"`,
    "",
  ].join("\n");
  const b = bun.replaceAll("/", "\\").replaceAll("%", "%%");
  const c = cli.replaceAll("%", "%%");
  const utf8 = /[^\x00-\x7f]/.test(b + c);
  return [
    "@echo off",
    "setlocal",
    ...(utf8 ? ["set /a miksy_cp=0", `for /f "tokens=2 delims=:." %%c in ('chcp') do set /a "miksy_cp=%%c" >nul 2>&1`, "chcp 65001 >nul"] : []),
    "rem miksy command - created by miksy setup, which also updates it",
    `if not exist "${b}" goto path`,
    `"${b}" "${c}" %*`,
    // Код выхода — явно: exit /b без кода после setlocal возвращает 0
    utf8 ? "goto done" : "exit /b %errorlevel%",
    ":path",
    `echo miksy: Bun "${b}" not found - running bun from PATH (miksy setup updates this command) 1>&2`,
    `bun "${c}" %*`,
    ...(utf8 ? [":done", "set miksy_rc=%errorlevel%", "if %miksy_cp% GTR 0 chcp %miksy_cp% >nul", "exit /b %miksy_rc%"] : ["exit /b %errorlevel%"]),
    "",
  ].join("\r\n");
}

// Команда miksy, которую создал setup (прежний формат — bun из PATH — тоже): только её setup обновляет
const OLD_SHIM = /^(?:@bun "[^"\r\n]*\/src\/cli\.ts" %\*\r?\n?|#!\/bin\/sh\nexec bun "[^"\n]*\/src\/cli\.ts" "\$@"\n?)$/;
export function ourShim(text: string): boolean {
  if (OLD_SHIM.test(text)) return true;
  const sh = text.match(/^b='((?:[^']|'\\'')*)'$[\s\S]*^exec "\$b" '((?:[^']|'\\'')*)' "\$@"$/m);
  if (sh) {
    const un = (s: string) => s.replaceAll("'\\''", "'");
    return text === shimText("macos", un(sh[1]), un(sh[2]));
  }
  const cmd = text.match(/^if not exist "([^"\r\n]*)" goto path\r$/m);
  const cli = text.match(/^bun "([^"\r\n]*)" %\*\r$/m);
  if (!cmd || !cli) return false;
  return text === shimText("windows", cmd[1].replaceAll("%%", "%"), cli[1].replaceAll("%%", "%"));
}

// Все ${VAR} из MCP всех слоёв: имя → слои, где встречается
export function referencedVars(root: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const walk = (dir: string, layer: string) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, ["mcp", "instructions", "skills"].includes(e.name) ? layer : layer ? `${layer}/${e.name}` : e.name);
      else if (/\.ya?ml$/.test(e.name) && dir.endsWith("mcp")) {
        const s = parseYaml(readFileSync(p, "utf8")) as McpServer;
        for (const m of JSON.stringify([s.command, s.args, s.env, s.url, s.headers]).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g))
          if (m[1] !== "HOME" && m[1] !== "WORKSPACE") out.set(m[1], (out.get(m[1]) ?? new Set()).add(layer.replace(/^tree\/?/, "") || "workspace"));
      }
    }
  };
  walk(join(root, "layers"), "");
  return out;
}

// Ответ на вопрос о workspace. prompt Bun возвращает null и на пустой Enter, и на конец ввода:
// null — значение по умолчанию; три null подряд (ввод закрыт) — workspace не выбран, без зацикливания
export function chooseWorkspace(suggested: string | null, read: () => string | null, confirm: (ws: string, why: string) => boolean, home: string, cwd: string): string | null {
  for (let empty = 0; empty < 3; ) {
    const raw = read();
    empty = raw === null ? empty + 1 : 0;
    const answer = raw?.trim() || suggested;
    if (!answer) continue;
    const ws = expandPath(answer, home, cwd);
    const why = unsafeWorkspace(ws, home);
    if (!why || confirm(ws, why)) return ws;
  }
  return null;
}

// Путь из ответа пользователя: ~ — домашний каталог, относительный — от текущего каталога
export function expandPath(input: string, home: string, cwd: string): string {
  const p = input.trim().replace(/^~(?=$|[\\/])/, home);
  return slash(paths(p, cwd).resolve(cwd, p)).replace(/(?<=.)\/+$/, "");
}

// Правила путей по виду пути (C:\…, \\server — Windows), а не по ОС, где идёт проверка
const isWin = (p: string) => /^[A-Za-z]:|^\\\\/.test(p);
const paths = (p: string, base = p) => (isWin(p) || (!p.startsWith("/") && isWin(base)) ? win32 : posix);

// Workspace, который нельзя брать без явного подтверждения: sync --all пройдёт по всему дереву
export function unsafeWorkspace(path: string, home: string): string | null {
  const norm = (p: string) => {
    const s = slash(paths(p).resolve(p)).replace(/(?<=.)\/+$/, "");
    return isWin(p) ? s.toLowerCase() : s;
  };
  const up = (p: string) => norm(paths(p).dirname(p));
  if (existsSync(path)) path = canonical(path);
  if (existsSync(home)) home = canonical(home);
  const p = norm(path);
  if (p === up(path)) return "корень файловой системы";
  if (p === norm(home)) return "домашний каталог";
  if (p === up(home)) return "каталог всех пользователей";
  return null;
}

// Workspace по умолчанию: на два уровня выше движка (<workspace>/<группа>/miksy). Если движок лежит
// в папке-группе вместе с конфигурацией (…/Miksy/{miksy,miksy-config}) — ещё на уровень выше.
// Если так выходит опасный каталог (движок в ~/Projects/miksy: выше — домашний каталог) — каталог, где лежит движок;
// если и он опасен (~/miksy) — варианта по умолчанию нет.
export function defaultWorkspace(engine: string, home: string): string | null {
  const base = dirname(canonical(engine));
  const children = readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith("."));
  // Группа — каталог, где кроме движка и конфигурации ничего нет; рядом с ними проекты —
  // плоская раскладка (~/work/ai/{miksy,miksy-config,proj}): workspace — сам каталог
  const withConfig = existsSync(join(base, "miksy-config"));
  const grouped = withConfig && children.every((e) => e.name.toLowerCase().startsWith("miksy"));
  const candidates = grouped ? [dirname(dirname(base)), dirname(base), base]
    : withConfig || children.length === 1 ? [base] : [dirname(base), base];
  return candidates.map(canonical).find((c) => !unsafeWorkspace(c, home)) ?? null;
}

// Раскладка не как на первой машине: в дереве конфигурации есть слой каталога, где лежали движок и
// конфигурация (по имени: слой Miksy — как группа …/Miksy/{miksy,miksy-config}, или родитель слоя с
// именем движка либо конфигурации), а здесь они не в нём. Одно сообщение, ничего не меняется
export function layoutWarning(workspace: string, engine: string, config: string): string | null {
  const base = join(config, "layers", "tree");
  if (!existsSync(base)) return null;
  // Имя движка или конфигурации — точно (слой «miksy» — сам движок, «Miksy» — каталог над ним)
  const names = [basename(engine), basename(config)];
  const found: { rel: string; layer: string; target: boolean }[] = []; // rel — где лежали движок и конфигурация
  const isTarget = (dir: string) => {
    try { return (parseYaml(readFileSync(join(dir, "layer.yaml"), "utf8")) as { target?: unknown } | null)?.target === true; } catch { return false; }
  };
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || LAYER_PARTS.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (names.includes(e.name) || /^miksy$/i.test(e.name))
        found.push({ rel: names.includes(e.name) ? rel : r, layer: r, target: isTarget(join(dir, e.name)) });
      walk(join(dir, e.name), r);
    }
  };
  walk(base, "");
  const same = (a: string, b: string) => { try { return samePath(a, b); } catch { return false; } };
  for (const l of found) {
    const place = slash(join(workspace, l.rel));
    if (same(dirname(engine), place) || same(dirname(config), place)) continue;
    const lines = [`Раскладка: в конфигурации есть слой ${l.layer}${l.target ? " (target: true)" : ""}, а движок лежит в ${slash(engine)} — на первой машине он был в ${place}/${basename(engine)}`
      + ` (конфигурация — в ${place}/${basename(config)}). Слои дерева привязаны к путям относительно workspace: переложите движок`
      + ` и конфигурацию так же, как на первой машине, иначе слои и тексты правил не совпадут (README, «Вторая машина»). miksy ничего не менял.`];
    if (same(engine, place) || same(config, place))
      lines.push(`  ${place} здесь — сам каталог ${same(engine, place) ? "движка" : "конфигурации"}: файловая система не различает регистр. Переименовывайте через временное имя (mv miksy miksy.tmp, затем mkdir Miksy и mv miksy.tmp Miksy/miksy).`);
    return lines.join("\n");
  }
  return null;
}

function copyDir(from: string, to: string) {
  mkdirSync(to, { recursive: true });
  for (const e of readdirSync(from, { withFileTypes: true })) {
    if (e.isDirectory()) copyDir(join(from, e.name), join(to, e.name));
    else if (!existsSync(join(to, e.name))) copyFileSync(join(from, e.name), join(to, e.name));
  }
}

// Копия настроек агентов до первой записи miksy: пути относительно HOME, как есть (со значениями
// секретов — это ваша страховка; защищает её доступ к local/). Симлинки копируются ссылками; где ОС
// не даёт создать ссылку (Windows без прав) — пропускаются и перечисляются
export function copyAgentSettings(home: string, rels: string[], dest: string): { files: number; links: string[] } {
  let files = 0;
  const links: string[] = [];
  const copy = (src: string, dst: string, rel: string) => {
    const st = lstatSync(src);
    mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
    if (st.isSymbolicLink()) {
      try { symlinkSync(readlinkSync(src), dst); } catch { links.push(rel); }
    } else if (st.isDirectory()) {
      mkdirSync(dst, { recursive: true, mode: 0o700 });
      for (const e of readdirSync(src)) copy(join(src, e), join(dst, e), `${rel}/${e}`);
    } else if (st.isFile()) {
      copyFileSync(src, dst);
      if (process.platform !== "win32") chmodSync(dst, 0o600);
      files++;
    }
  };
  for (const rel of rels) {
    const src = join(home, rel);
    try { lstatSync(src); } catch { continue; }
    copy(src, join(dest, rel), rel);
  }
  return { files, links };
}

// Как вернуть копию настроек на место (пути в копии — от HOME)
export const restoreCommand = (dir: string, os: Os) => os === "windows"
  ? `robocopy "${dir.replaceAll("/", "\\")}" $env:USERPROFILE /E`
  : `cp -R "${dir}/." ~/`;

// Действия с системой, которые мастер делает только после «да»: тесты подменяют их
export interface System {
  which(cmd: string): string | null;
  // Команда установки — в оболочке ОС (PowerShell / sh), вывод и вопросы — в терминал; код выхода
  exec(command: string): number;
  git(args: string[], cwd?: string): number;
  // Windows: пользовательский PATH в реестре (как записан, с %ПЕРЕМЕННЫМИ%); не setx — он обрезает
  // значение до 1024 символов
  userPath: { get(): string; set(value: string): void };
  // PATH текущего процесса после установки программы: чтобы найти её без нового окна
  refreshPath(): void;
}

const ps = (script: string, env: Record<string, string> = {}) =>
  Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });

// PATH процесса: на Windows ключ окружения бывает «Path» (и process.env — обычный объект)
const pathVar = () => Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
const getPath = () => process.env[pathVar()] ?? "";
const prependPath = (dir: string) => { process.env[pathVar()] = `${dir}${delimiter}${getPath()}`; };

// Разделённый PATH без пустых и повторов (сравнение — без учёта регистра на Windows)
const pathKey = (p: string) => slash(p).replace(/\/+$/, "").toLowerCase();
const expandEnv = (p: string) => p.replace(/%([^%]+)%/g, (m, k: string) => process.env[k] ?? m);
const inPathList = (list: string, dir: string) =>
  list.split(process.platform === "win32" ? ";" : ":").filter(Boolean).some((e) => (process.platform === "win32" ? pathKey(expandEnv(e)) === pathKey(dir) : slash(e).replace(/\/+$/, "") === slash(dir).replace(/\/+$/, "")));

export const realSystem: System = {
  which: (cmd) => Bun.which(cmd, { PATH: getPath() }),
  exec(command) {
    const argv = process.platform === "win32" ? ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command] : ["sh", "-c", command];
    return Bun.spawnSync(argv, { env: process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exitCode;
  },
  git: (args, cwd) => Bun.spawnSync(["git", ...args], { cwd, env: process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exitCode,
  userPath: {
    get: () => ps("(Get-Item HKCU:\\Environment).GetValue('Path', '', 'DoNotExpandEnvironmentNames')").stdout.toString().trim(),
    set(value) {
      // Тип значения сохраняется (REG_EXPAND_SZ — %USERPROFILE% в путях); SetEnvironmentVariable — оповестить
      // открытые программы (Проводник, новые окна терминала) об изменении окружения
      const r = ps("[Microsoft.Win32.Registry]::SetValue('HKEY_CURRENT_USER\\Environment', 'Path', $env:MIKSY_NEW_PATH, 'ExpandString'); [Environment]::SetEnvironmentVariable('MIKSY_SETUP_NOTIFY', $null, 'User')", { MIKSY_NEW_PATH: value });
      if (r.exitCode !== 0) throw new Error(`пользовательский PATH не записан: ${r.stderr.toString().trim()}`);
    },
  },
  refreshPath() {
    const add = (dirs: string[]) => {
      for (const d of dirs) if (d && existsSync(d) && !inPathList(getPath(), d)) prependPath(d);
    };
    if (process.platform === "win32") {
      const r = ps("[Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')");
      add(r.stdout.toString().trim().split(";").reverse());
    } else {
      const h = homeDir();
      add([join(h, ".bun", "bin"), "/usr/local/bin", "/opt/homebrew/bin", join(h, ".cargo", "bin"), join(h, ".local", "bin")]);
    }
  },
};

export type Run = (cmd: string, args: string[], io: { ask?: Ask | null; observe?: (r: TargetReport) => void }) => number;

export type SetupOptions = {
  ask: Ask | null; // null — без диалога: только конфигурация, local/, machine.yaml, команда miksy
  force: boolean;  // workspace и agents из machine.yaml — значения по умолчанию, файл перезаписывается
  backup?: boolean; // без диалога — тоже копия настроек агентов «до miksy» (setup --yes --backup: для агента-установщика)
  run?: Run;       // команды miksy в этом процессе (src/commands.ts runCommand); нет — шаги 6, 8–10 пропущены
  engine?: string; // каталог движка (тесты — копия)
  bun?: string;    // Bun для команды miksy (по умолчанию — этот, по пути без версии)
  sys?: Partial<System>;
  log?: (s?: string) => void;
  hints?: boolean; // false — без «Дальше: …» в конце (miksy update после обновления движка печатает свои шаги)
};

// Решения мастера, которые не нужно спрашивать снова: добавки агентов, оставленные у агента
type SetupState = { keep?: string[] };
const stateFile = (config: string) => join(config, "local", "state", "setup.json");
function loadState(config: string): SetupState {
  try { return JSON.parse(readFileSync(stateFile(config), "utf8")) as SetupState; } catch { return {}; }
}
function saveState(config: string, s: SetupState) {
  mkdirSync(dirname(stateFile(config)), { recursive: true });
  writeAtomic(stateFile(config), JSON.stringify(s, null, 2) + "\n");
}

// Записывал ли miksy уже что-нибудь на этой машине (учёт не пуст)
function synced(config: string): boolean {
  try {
    const m = JSON.parse(readFileSync(join(config, "local", "state", "manifest.json"), "utf8")) as { targets?: object };
    return !!m.targets && Object.keys(m.targets).length > 0;
  } catch { return false; }
}

// Подсказка, когда клон не удался: репо пока приватный
const CLONE_HINT = [
  "  Если репо приватный — нужен доступ: войдите в GitHub (gh auth login, затем gh auth setup-git)",
  "  или добавьте SSH-ключ в GitHub и укажите адрес вида git@github.com:<владелец>/<репо>.git.",
];

export function setup(o: SetupOptions): number {
  const os = currentOs();
  const log = o.log ?? ((s = "") => console.log(s));
  const ask = o.ask;
  const engine = o.engine ?? ENGINE;
  const sys: System = { ...realSystem, ...o.sys };
  // Изменение системы: в диалоге — вопрос (Enter — auto: «да» для безопасной части, «нет» для
  // остального); без диалога — auto
  const agree = (q: string, auto: boolean) => (ask ? ask.yes(q, auto) : auto);
  // PATH оболочки пользователя — до того, как install.sh и мастер дополнят PATH этого процесса
  const shellPath = process.env.MIKSY_ORIGINAL_PATH ?? getPath();
  const step = (n: number, title: string, why: string) => { if (ask) log(`\n── ${n}. ${title}\n   ${why}`); };
  log(`miksy setup — ${os}, движок: ${slash(engine)} (${engineVersion(engine)})`);
  log(ask ? "Мастер установки: на каждом шаге — что и зачем; любой шаг можно пропустить, повторный запуск продолжит с несделанного. Перед каждым изменением системы — вопрос: [Y/n] — Enter значит «да», [y/N] — «нет»."
    : `Без вопросов (--yes или нет терминала): конфигурация, local/, machine.yaml${o.backup ? ", копия настроек агентов" : ""} и команда miksy. Остальное — miksy setup в терминале.`);

  // 1. Конфигурация: своя у каждого пользователя. Есть — берём; нет — из git или из примера
  step(1, "Конфигурация", "ваш личный каталог: слои с правилами, MCP и skills, настройки машины (local/).");
  const home = homeDir();
  const explicit = process.env.MIKSY_CONFIG;
  const pointer = join(home, ".miksy");
  const sibling = slash(join(dirname(engine), "miksy-config"));
  let config = canonical(findConfig(engine).replace(/^~(?=$|[\\/])/, home));
  if (hasConfig(config)) {
    if (ask) log(`✓ есть: ${config}`);
  } else {
    const def = explicit || existsSync(pointer) ? config : sibling;
    const created = ask ? configDialog(ask, def) : fromExample(expandPath(def, home, process.cwd()));
    if (!created) {
      log("Без конфигурации остальные шаги не выполнить. Запустите miksy setup снова, когда будете готовы.");
      return 1;
    }
    config = canonical(created);
    if (!explicit && (!samePath(config, sibling) || existsSync(pointer))) {
      const old = existsSync(pointer) ? readFileSync(pointer, "utf8").trim() : null;
      const unchanged = old !== null && samePath(expandPath(old, home, process.cwd()), config);
      if (old !== null && !unchanged) {
        if (!agree("~/.miksy уже указывает на другую конфигурацию. Заменить с бэкапом?", false))
          throw new Error("~/.miksy не изменён; задайте MIKSY_CONFIG для новой конфигурации");
        backup(pointer, config);
      }
      if (!unchanged) {
        writeAtomic(pointer, config + "\n");
        log(`✓ путь к конфигурации записан в ~/.miksy`);
      }
    }
  }
  log(`Конфигурация: ${slash(config)}`);
  // Остальные шаги и команды этого процесса (sync, doctor, adopt) — с этой конфигурацией
  process.env.MIKSY_CONFIG = config;

  // Каталог local/ и шаблон секретов
  const local = join(config, "local");
  mkdirSync(local, { recursive: true, mode: 0o700 });
  ensurePrivateLocal(local);
  const secretsPath = join(local, "secrets.env");
  if (!existsSync(secretsPath)) {
    writeFileSync(secretsPath, readFileSync(join(engine, "examples", "local", "secrets.env")), { mode: 0o600 });
    log("✓ local/secrets.env создан из шаблона (значения пустые)");
  }
  if (process.platform !== "win32") chmodSync(secretsPath, 0o600);

  // 2. Workspace и агенты. С --force текущие workspace и agents — значения по умолчанию:
  // меняются только явным ответом, а не эвристикой и не списком найденных в PATH
  step(2, "Workspace и агенты", "каталог с вашими проектами и агенты этой машины — настройки получат только они.");
  const machinePath = join(local, "machine.yaml");
  const hadMachine = existsSync(machinePath);
  let previous: { workspace?: string; vars?: Record<string, string>; agents?: string[]; trust?: { codex?: boolean; claude?: boolean } } = {};
  if (o.force && hadMachine) {
    try { previous = (parseYaml(readFileSync(machinePath, "utf8")) ?? {}) as typeof previous; }
    catch { throw new Error(`${machinePath}: YAML не разбирается — ручные vars не будут потеряны, исправьте файл`); }
  }
  const kept = typeof previous.workspace === "string" && previous.workspace.trim() ? expandPath(previous.workspace, home, process.cwd()) : null;
  const suggested = kept ?? defaultWorkspace(engine, home);
  let workspace: string | null = suggested;
  if (ask && (!hadMachine || o.force)) {
    workspace = chooseWorkspace(suggested, () => ask.line(`Корень workspace (каталог с проектами)${suggested ? ` [${suggested}]` : ""}:`),
      (ws, why) => ask.yes(`${ws} — ${why}: sync --all обойдёт все каталоги внутри. Точно взять его?`), home, process.cwd());
  } else if (!workspace) {
    log(`Workspace по умолчанию не определить: движок лежит прямо в ${slash(dirname(engine))}.`);
  }

  const keptAgents = Array.isArray(previous.agents) && previous.agents.every((a) => typeof a === "string") ? previous.agents : null;
  // Без --force machine.yaml не перезаписывается, но новых агентов в нём можно дописать
  let listed: string[] | null = null;
  let current: { workspace?: unknown; vars?: unknown } | null = null;
  if (!o.force && hadMachine) {
    try {
      const doc = parseYaml(readFileSync(machinePath, "utf8")) as { agents?: unknown; workspace?: unknown; vars?: unknown } | null;
      current = doc;
      if (Array.isArray(doc?.agents) && doc.agents.every((a) => typeof a === "string")) listed = doc.agents;
    } catch { /* разбор и ошибка — ниже, как раньше */ }
  }
  const known = keptAgents ?? listed ?? [];
  const detected = detectAgents(home, (c) => sys.which(c));
  const viaDir = detected.dirOnly.filter((d) => !known.includes(d.id)).filter((d) => {
    if (ask) return ask.yes(`${d.id}: команды нет в PATH, но есть ${d.dir} — настраивать этого агента (например, он у вас в редакторе)?`);
    log(`• ${d.id}: команды нет в PATH, но есть ${d.dir} — пользуетесь им (например, через редактор)? Добавьте ${d.id} в agents в local/machine.yaml`);
    return false;
  }).map((d) => d.id);
  const found = Object.keys(AGENT_COMMANDS).filter((id) => detected.inPath.includes(id) || viaDir.includes(id));
  const agents = keptAgents ?? found;
  const newAgents = keptAgents ? found.filter((a) => !keptAgents.includes(a)) : [];
  const vars: Record<string, string> = { ...previous?.vars };
  const machineVars = current && current.vars && typeof current.vars === "object" ? Object.keys(current.vars) : [];
  const missingTools: { name: string; tool: Tool; layers: string[] }[] = [];
  const needed = referencedVars(config);
  const tools = machineTools(config);
  for (const [name, how] of Object.entries(tools)) {
    if (!needed.has(name)) continue;
    if (name in vars || machineVars.includes(name)) continue;
    const hit = how.find.map((c) => sys.which(c)).find(Boolean);
    if (hit) vars[name] = slash(hit);
    else missingTools.push({ name, tool: how, layers: [...needed.get(name)!] });
  }

  // machine.yaml уже есть и не перезаписывается — показываем его workspace, а не предложенный по умолчанию
  const inFile = hadMachine && !o.force && typeof current?.workspace === "string" && current.workspace.trim() ? current.workspace.trim() : null;
  if (inFile) log(`Workspace: ${inFile}  (из local/machine.yaml)`);
  else log(workspace ? `Workspace: ${workspace}${existsSync(workspace) ? "" : "  (каталога ещё нет — будет создан)"}` : "Workspace: не выбран — local/machine.yaml не будет записан");
  log(`Агенты: ${agents.length ? agents.join(", ") : "не найдено ни одного (claude, codex, opencode, agy)"}${keptAgents ? " (из текущего local/machine.yaml)" : ""}`);
  const absent = Object.keys(AGENT_COMMANDS).filter((a) => !agents.includes(a) && !known.includes(a) && !found.includes(a));
  if (ask && absent.length) log(`  не найдены: ${absent.join(", ")} — miksy их не ставит; как поставить — README, раздел «Установка агентов». Поставите — запустите setup снова`);
  if (newAgents.length) log(`  найдены ещё: ${newAgents.join(", ")} — не добавлены; нужны — допишите в agents в local/machine.yaml`);
  if (kept && workspace !== kept) log(`  workspace меняется: было ${kept}`);
  for (const k of Object.keys(vars)) log(`${k}: задано`);
  const layout = workspace && layoutWarning(workspace, canonical(engine), config);
  if (layout) log(`\n• ${layout}`);

  // local/machine.yaml
  const yaml = [
    "# Настройки этой машины. Создано miksy setup — можно править вручную.",
    `workspace: ${JSON.stringify(workspace)}`,
    "vars:",
    ...Object.entries(vars).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`),
    "# Агенты, установленные на этой машине: для них работают sync/clean/doctor без --agent",
    `agents: [${agents.join(", ")}]`,
    ...(previous.trust ? [`trust: ${JSON.stringify(previous.trust)}`] : []),
    "",
  ].join("\n");
  if (!workspace) {
    log("\n• local/machine.yaml не записан: workspace не выбран (запустите setup в терминале или пропишите workspace вручную)");
  } else if (hadMachine && !o.force) {
    // Новые агенты и найденные программы дописываются, остальное в файле не меняется
    const added = listed ? found.filter((a) => !listed!.includes(a)) : [];
    const text = readFileSync(machinePath, "utf8");
    const line = /^agents:[ \t]*\[[^\]\r\n]*\][ \t]*$/m;
    const newVars = Object.entries(vars).filter(([k]) => !machineVars.includes(k));
    if (added.length && !line.test(text))
      log(`\n• найдены новые агенты: ${added.join(", ")} — в local/machine.yaml agents записан не одной строкой; допишите их сами`);
    else if (added.length && agree(`Добавить в local/machine.yaml новых агентов: ${added.join(", ")}?`, true)) {
      backup(machinePath, config);
      writeAtomic(machinePath, text.replace(line, `agents: [${[...listed!, ...added].join(", ")}]`));
      log(`✓ в local/machine.yaml добавлены агенты: ${added.join(", ")} — дальше: miksy sync --global и miksy sync --all`);
    } else if (ask) log(`✓ local/machine.yaml уже есть — не трогаю (переспросить workspace и агентов: setup --force)`);
    else log(`\n• local/machine.yaml уже есть — не трогаю (перезаписать: setup --force). Найдено сейчас:\n${yaml.replace(/^/gm, "    ")}`);
    for (const [k, v] of newVars) addVar(machinePath, config, k, v, log);
  } else if (agree(`Записать local/machine.yaml (workspace, агенты${Object.keys(vars).length ? ", пути к программам" : ""})?`, true)) {
    mkdirSync(workspace, { recursive: true });
    backup(machinePath, config);
    writeAtomic(machinePath, yaml);
    log("✓ local/machine.yaml записан");
  }
  const machine = (() => { try { return existsSync(machinePath) ? loadMachine(config) : null; } catch (e) { log(`• ${(e as Error).message}`); return null; } })();
  const machineAgents = machine ? agentsFor(machine) : [];

  // 3. Копия настроек агентов до первой записи miksy (без диалога — только с --backup)
  if (ask || o.backup) backupStep();

  // 4. Программы для MCP: tools из map.yaml и команды серверов слоёв этой машины. checked — команды,
  // уже проверенные (после adopt — только новые), offered — уже предложенные установки
  const checked = new Set<string>();
  const offered = new Set<string>();
  programsStep();

  // 5. Команда miksy и PATH. Обновляем только свою команду (движок переехал), чужую — не трогаем
  step(5, "Команда miksy", "чтобы писать miksy … вместо bun src/cli.ts … в любом каталоге.");
  const bunBin = join(process.env.BUN_INSTALL || join(home, ".bun"), "bin");
  const shim = join(bunBin, os === "windows" ? "miksy.cmd" : "miksy");
  const cli = slash(join(engine, "src", "cli.ts"));
  const bun = slash(o.bun ?? stableBun(process.execPath));
  const shimBody = shimText(os, bun, cli);
  const shimNow = existsSync(shim) && statSync(shim).isFile() ? readFileSync(shim, "utf8") : null;
  const ours = shimNow !== null && ourShim(shimNow);
  if (shimNow !== null && shimNow !== shimBody && ours) {
    mkdirSync(bunBin, { recursive: true });
    writeFileSync(shim, shimBody, { mode: 0o755 });
    log(`✓ команда miksy обновлена: движок ${cli}, Bun ${bun}`);
  } else if (shimNow !== null && !ours) {
    log(`• ${slash(shim)} уже есть и не от miksy — не трогаю. Запуск: bun ${cli}`);
  } else if (shimNow === null && agree(`Создать команду «miksy» (${slash(shim)})?`, true)) {
    mkdirSync(bunBin, { recursive: true });
    writeFileSync(shim, shimBody, { mode: 0o755 });
    log(`✓ команда miksy создана (Bun: ${bun})`);
  } else if (shimNow !== null && ask) log(`✓ команда miksy есть: ${slash(shim)}`);
  const installed = existsSync(shim) && statSync(shim).isFile() && ourShim(readFileSync(shim, "utf8"));
  if (installed && ask) pathStep(bunBin);
  const other = sys.which("miksy");
  const sameShim = (p: string) => { try { return samePath(p, shim); } catch { return false; } };
  if (other && !sameShim(other))
    log(`• команда miksy в PATH — ${slash(other)}, а не ${slash(shim)}`);
  // Подсказки — командой, которая действительно найдётся: Homebrew-bun не кладёт ~/.bun/bin в PATH
  if (installed && !other && !ask) log(`• каталог ${slash(bunBin)} не в PATH — команда miksy не найдётся. Добавьте его в PATH (например, в ~/.zshrc: export PATH="${slash(bunBin)}:$PATH") или запускайте bun "${cli}"`);
  const cmd = installed && sys.which("miksy") && sameShim(sys.which("miksy")!) ? "miksy" : `bun "${cli}"`;

  // Заметка конфигурации о подготовке машины (local.example/README.md) — то, что miksy не настраивает сам
  const machineNote = () => {
    const note = join(config, "local.example", "README.md");
    if (existsSync(note)) log(`\nВ вашей конфигурации есть заметка о подготовке машины — то, что miksy не настраивает сам (например, профили облачных CLI): ${slash(note)}. Прочитайте её.`);
  };

  if (!ask || !machine || !o.run) {
    if (!ask) secretsReport();
    machineNote();
    if (o.hints === false) return 0;
    log(`\nДальше:
  ${cmd} setup                      мастер: копия настроек, добавки агентов, секреты, план и запись
  ${cmd} doctor                     что нужно синхронизировать
  ${cmd} sync --global --dry-run    план записи глобальных настроек
  ${cmd} sync --global              записать
  ${cmd} sync --all                 настроить все проекты workspace`);
    return 0;
  }
  const run = o.run;

  // 6. Ручные настройки агентов: добавки в обход слоёв → в конфигурацию (adopt); программы
  // перенесённых серверов — сразу, а не при следующем setup
  adoptStep();
  // 7. Секреты
  secretsStep();
  machineNote();
  // 8. План и 9. Запись
  const wrote = planAndWrite();
  // 10. Проверка
  step(10, "Проверка", "что разошлось со слоями после записи (miksy doctor).");
  const d = doctor(agentsFor(loadMachine(config)), loadMachine(config), false);
  for (const l of d.text.split("\n")) if (l && !l.startsWith(" ")) log(`  ${l}`);
  if (d.problems) log(`  подробно: ${cmd} doctor`);
  log(`\n${wrote ? "Готово." : "Настройки агентам не записаны — позже: " + cmd + " sync --global и " + cmd + " sync --all."}`);
  if (wrote) log(`Перезапустите открытые сессии агентов — настройки читаются при старте. Проверка: откройте проект и
спросите агента: «Процитируй первую строку раздела „## MCP“ в твоих инструкциях и вызови context7
для „bun“». Ответ «MCP-серверы подключает miksy по слоям…» и найденная библиотека — всё работает.`);
  return 0;

  // ——— шаги ———

  // Конфигурации нет: своя из git (клон рядом с движком) или новая из примера
  function configDialog(a: Ask, def: string): string | null {
    const choice = a.choose("Конфигурации ещё нет. Откуда её взять?", [
      { key: "1", label: `есть своя в git — введу адрес (скачаю в ${def})` },
      { key: "2", label: "создать новую из примера" },
      { key: "0", label: "пропустить" },
    ]);
    if (choice === "1") {
      const dest = expandPath(def, home, process.cwd());
      if (existsSync(dest) && readdirSync(dest).length) {
        log(`${dest} уже есть и не пуст — уберите его или задайте другой путь (MIKSY_CONFIG).`);
        return null;
      }
      for (;;) {
        const url = a.line("Адрес git-репо конфигурации (Enter — отмена):");
        if (!url) return null;
        mkdirSync(dirname(dest), { recursive: true });
        if (sys.git(["clone", url, dest]) === 0) {
          if (hasConfig(dest)) { log(`✓ конфигурация скачана: ${dest}`); return dest; }
          log(`В ${dest} нет map.yaml — это не конфигурация miksy. Проверьте адрес (каталог оставлен как есть).`);
          return null;
        }
        log(["Не удалось скачать конфигурацию.", ...CLONE_HINT].join("\n"));
      }
    }
    if (choice !== "2") return null;
    const where = expandPath(a.line(`Где хранить конфигурацию [${def}]:`) ?? def, home, process.cwd());
    const dir = fromExample(where);
    if (a.yes("Сделать конфигурацию git-репо и записать первый коммит (local/ в git не попадёт — он в .gitignore)?")) {
      const ok = sys.git(["init", "-q"], dir) === 0 && sys.git(["add", "-A"], dir) === 0
        && sys.git(["commit", "-q", "-m", "Initial miksy config"], dir) === 0;
      log(ok ? `✓ git-репо с первым коммитом: ${dir}
  Удалённый репо мастер не создаёт. Заведите приватный (GitHub, GitLab) и подключите:
    git -C "${dir}" remote add origin <адрес>
    git -C "${dir}" push -u origin HEAD`
        : `• git не выполнился до конца — проверьте git config user.name / user.email и повторите в ${dir}: git add -A; git commit -m "Initial miksy config"`);
    }
    return dir;
  }

  function fromExample(where: string): string {
    if (!hasConfig(where)) {
      copyDir(join(engine, "examples", "config"), where);
      log(`✓ конфигурация создана из примера: ${where}`);
      log("  Это ваш личный каталог: опишите в нём свои слои (README движка). Чтобы переносить");
      log("  его между машинами — заведите для него приватный git-репо (local/ в git не попадает).");
    }
    return where;
  }

  function backupStep() {
    step(3, "Копия текущих настроек агентов", "страховка до первой записи miksy: вернёте всё как было даже без miksy.");
    const root = join(local, "backups");
    const done = existsSync(root) ? readdirSync(root).filter((d) => d.startsWith("before-miksy-")).sort() : [];
    if (done.length) return log(`✓ уже есть: ${slash(join(root, done[done.length - 1]))}\n  вернуть: ${restoreCommand(slash(join(root, done[done.length - 1])), os)}`);
    if (synced(config)) return log("• miksy уже записывал настройки на этой машине — копия «до miksy» не получится; бэкапы его запусков — local/backups/.");
    const ids = machine?.agents ?? agents;
    const rels = [...new Set(ids.flatMap((id) => ADAPTERS[id]?.homeConfig ?? []))].filter((r) => { try { lstatSync(join(home, r)); return true; } catch { return false; } });
    if (!rels.length) return log("✓ у агентов ещё нет глобальных настроек — копировать нечего");
    log(`  Что есть: ${rels.map((r) => "~/" + r).join(", ")}`);
    const dest = join(root, `before-miksy-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
    if (!agree(`Скопировать это в ${slash(dest)}?`, true)) return log("  пропущено — без копии откатить можно только по бэкапам запусков miksy");
    const r = copyAgentSettings(home, rels, dest);
    ensurePrivateLocal(local);
    log(`✓ копия: ${slash(dest)} (файлов: ${r.files})`);
    if (r.links.length) log(`  ссылки не скопированы (ОС не дала создать): ${r.links.join(", ")}`);
    log(`  вернуть (после miksy clean): ${restoreCommand(slash(dest), os)}`);
  }

  // after — после adopt: только команды серверов, которых шаг 4 ещё не видел (перенесённые в слои);
  // установку, уже предложенную выше, не спрашивает снова
  function programsStep(after = false) {
    if (!after) step(4, "Программы для MCP-серверов", "команды, которыми запускаются серверы из слоёв; без них сервер у агента не стартует.");
    // Окружение (как в doctor): несколько установок программ, переменные каталогов настроек агентов,
    // конфигурация не та, что рядом с движком — только сообщения
    if (!after) for (const l of environment({ env: { ...process.env, MIKSY_CONFIG: explicit }, home, os, bun: o.bun ?? stableBun(process.execPath),
      agents: machine?.agents ?? agents, engine, config })) log(`• ${l}`);
    type Need = { what: string; servers: string[]; check: () => string | null; install?: string; tool?: string };
    const list: Need[] = after ? [] : missingTools.map((t) => ({
      what: `${t.name}: не найден (${t.tool.find.join(" / ")}) — установить: ${t.tool.install?.[os] ?? "вручную"}; нужен слоям ${t.layers.join(", ")}`, servers: [], tool: t.name,
      check: () => t.tool.find.map((c) => sys.which(c)).find(Boolean) ?? null, install: t.tool.install?.[os],
    }));
    // Без диалога — тоже: отчёт (что поставить), без установки
    if (machine) {
      const servers = new Map<string, Set<string>>();
      try {
        const targets = [globalTarget(machine), ...allTargets(machine, listGroups(machine))];
        for (const t of targets) for (const { item } of t.cfg.mcp)
          if (item.command && !item.command.includes("${")) servers.set(item.command, (servers.get(item.command) ?? new Set()).add(item.name));
      } catch (e) { log(`• серверы слоёв не прочитаны: ${(e as Error).message}`); }
      for (const [command, names] of servers) {
        if (checked.has(command)) continue;
        checked.add(command);
        const abs = /^([A-Za-z]:[\\/]|\/)/.test(command);
        const look = () => (abs ? (existsSync(command) ? command : null) : sys.which(command));
        if (look()) continue;
        const base = basename(command).replace(/\.(exe|cmd|bat)$/i, "");
        const p = PROGRAMS.find((x) => x.commands.includes(base));
        list.push({ what: p ? `${p.name} (${command})` : command, servers: [...names], check: look, install: p?.install[os] });
      }
    }
    if (!list.length) return !after && ask && log("✓ всё нужное есть");
    if (!ask) log("\nНе хватает программ:");
    if (after) log("\nПрограммы для перенесённых серверов:");
    for (const n of list) {
      log(n.tool ? `  ${n.what}` : `• ${n.what}: нужна серверам ${n.servers.join(", ")} — нет в PATH`);
      if (!ask) {
        if (!n.tool) log(n.install ? `  ${/^https?:\/\//.test(n.install) ? "скачать" : "установить"}: ${n.install}` : "  как поставить — неизвестно");
        continue;
      }
      if (!n.install) { log(`  как поставить — неизвестно: установите сами и запустите setup снова`); continue; }
      if (/^https?:\/\//.test(n.install)) { log(`  скачать: ${n.install}`); continue; }
      if (offered.has(n.install)) { log(`  установка предложена выше: ${n.install}`); continue; }
      offered.add(n.install);
      if (!n.tool) log(`  установить: ${n.install}`);
      if (!ask || !ask.yes(`Выполнить «${n.install}»?`)) continue;
      const code = sys.exec(n.install);
      sys.refreshPath();
      const hit = n.check();
      if (hit) {
        log(`✓ найдено: ${slash(hit)}`);
        if (n.tool && existsSync(machinePath)) addVar(machinePath, config, n.tool, slash(hit), log);
      } else log(`  ${code ? `установка завершилась с кодом ${code}; ` : ""}в PATH этого процесса не нашлась — откройте новое окно терминала и запустите setup снова`);
    }
  }

  function pathStep(dir: string) {
    if (os === "windows") {
      const user = sys.userPath.get();
      if (inPathList(user, dir)) return log(`✓ ${slash(dir)} в пользовательском PATH`);
      if (!ask!.yes(`Каталога ${slash(dir)} нет в PATH — добавить его в пользовательский PATH?`, true)) return log(`  без этого запускайте: bun "${cli}"`);
      sys.userPath.set(user ? `${user.replace(/;+$/, "")};${dir.replaceAll("/", "\\")}` : dir.replaceAll("/", "\\"));
      log(`✓ добавлено в пользовательский PATH — в новых окнах терминала команда miksy найдётся`);
    } else {
      // PATH оболочки, не этого процесса: процессу мастер мог сам добавить ~/.bun/bin (после установки программ)
      if (inPathList(shellPath, dir)) return log(`✓ ${slash(dir)} в PATH`);
      const shell = basename(process.env.SHELL ?? "");
      const rc = shell === "zsh" ? ".zshrc" : shell === "bash" ? (os === "macos" ? ".bash_profile" : ".bashrc") : null;
      const shown = dir.startsWith(home + "/") ? `$HOME/${relative(home, dir)}` : dir;
      const line = `export PATH="${shown}:$PATH"`;
      if (!rc) return log(`• каталога ${dir} нет в PATH. Добавьте в настройки своей оболочки строку:\n    ${line}`);
      const file = join(home, rc);
      const text = existsSync(file) ? readFileSync(file, "utf8") : "";
      if (text.includes(dir) || text.includes(shown)) log(`✓ ${dir} уже прописан в ~/${rc} — откройте новое окно терминала`);
      else if (ask!.yes(`Каталога ${dir} нет в PATH — дописать в ~/${rc} строку ${line}?`, true)) {
        appendFileSync(file, `${text && !text.endsWith("\n") ? "\n" : ""}# miksy\n${line}\n`);
        log(`✓ дописано в ~/${rc} — в новых окнах терминала команда miksy найдётся (в этом: source ~/${rc})`);
      } else return log(`  без этого запускайте: bun "${cli}"`);
    }
    if (!inPathList(getPath(), dir)) prependPath(dir);
  }

  function adoptStep() {
    step(6, "Ручные настройки агентов", "MCP и skills, добавленные агентам в обход слоёв: перенесите нужные в конфигурацию — их получат все агенты.");
    const d = doctor(machineAgents, machine!, false);
    const state = loadState(config);
    const keep = new Set(state.keep ?? []);
    // Одна добавка у нескольких агентов — один вопрос
    const items = new Map<string, { kind: "mcp" | "skill"; name: string; dir?: string; rel?: string; agents: string[]; sources: string[] }>();
    for (const a of d.added) {
      const k = `${a.kind}|${a.dir ?? "global"}|${a.name}`;
      const it = items.get(k) ?? { kind: a.kind, name: a.name, dir: a.dir, rel: a.rel, agents: [], sources: [] };
      it.agents.push(a.agent);
      it.sources.push(a.source);
      items.set(k, it);
    }
    const todo = [...items].filter(([k]) => !keep.has(k));
    if (!todo.length) log(`✓ добавок агентов нет${keep.size ? ` (оставлены у агентов: ${keep.size})` : ""}`);
    else log(`Найдено: ${todo.length}${keep.size ? ` (ещё ${keep.size} вы раньше оставили у агентов)` : ""}`);
    let skipAll = false;
    let adopted = false;
    for (const [k, it] of todo) {
      if (skipAll) break;
      const where = it.dir ? `в проекте ${it.rel || it.dir}` : "глобально";
      log(`\n• ${it.kind === "mcp" ? "MCP-сервер" : "skill"} ${it.name} — ${it.agents.join(", ")}, ${where} (${[...new Set(it.sources)].join("; ")})`);
      const levels = ["global", "workspace", ...(it.rel ? it.rel.split("/").map((_, i, a) => a.slice(0, i + 1).join("/")) : [])];
      const options = [
        ...levels.map((l, i) => ({ key: String(i + 1), label: l === "global" ? "глобально (все агенты везде)" : l === "workspace" ? "workspace (все проекты)" : l })),
        { key: "0", label: "оставить у агента — больше не спрашивать" },
        { key: "s", label: "пропустить все оставшиеся (спрошу при следующем setup)" },
      ];
      const c = ask!.choose("Перенести в конфигурацию?", options);
      if (c === "s") { skipAll = true; continue; }
      if (c === "0") { keep.add(k); saveState(config, { ...state, keep: [...keep] }); continue; }
      if (!c) { log("  пропущено"); continue; }
      const level = levels[Number(c) - 1];
      const args = [...(it.dir ? [it.dir, it.name] : ["--global", it.name]), "--to", level];
      try {
        run("adopt", args, { ask });
        adopted = true;
      } catch (e) {
        const msg = (e as Error).message;
        if (/разные определения/.test(msg)) {
          log(`  ${msg}`);
          const agent = ask!.choose("Чьё определение взять?", it.agents.map((x) => ({ key: x, label: x })));
          if (agent) try { run("adopt", [...args, "--agent", agent], { ask }); adopted = true; } catch (e2) { log(`  ${(e2 as Error).message}`); }
        } else log(`  ${msg}`);
      }
    }
    if (adopted) programsStep(true);
    if (d.blocked.length) {
      log(`\nКонфликты первого sync (${d.blocked.length}) — ваши файлы на местах, куда miksy хочет писать; он их не тронет:`);
      for (const b of d.blocked.slice(0, 15)) log(`  ${b.agent}  ${b.file}: ${b.why}`);
      if (d.blocked.length > 15) log(`  … ещё ${d.blocked.length - 15}`);
      log(`  Что делать: перенесите нужное из этих файлов в слои (правила — в instructions/, MCP — шагом выше).
  Потом miksy может заменить их своими (sync --force) — мастер спросит после записи; оригиналы
  сохранятся в local/backups/originals/, и miksy clean вернёт их на место.`);
    }
  }

  // Секреты, на которые ссылаются слои, без значения в local/secrets.env (пути к программам — не секреты)
  function missingSecrets(): [string, Set<string>][] {
    const secrets = loadSecrets(config);
    const machineVarNames = new Set([...Object.keys(tools), ...Object.keys(machine?.vars ?? {})]);
    return [...referencedVars(config)].filter(([n]) => !machineVarNames.has(n) && !(n in secrets));
  }

  function secretsReport() {
    const missing = missingSecrets();
    if (!missing.length) return;
    log(`\nНе заполнены секреты в local/secrets.env (проекты этих слоёв sync пропустит):`);
    for (const [n, layers] of missing) log(`  ${n}  — слои: ${[...layers].join(", ")}`);
    log("  Перенесите значения с другой машины безопасно (флешка, менеджер паролей) — не через git и не через чат.");
  }

  function secretsStep() {
    step(7, "Секреты", "значения токенов из ссылок ${ИМЯ} в слоях — только в local/secrets.env этой машины.");
    let missing = missingSecrets();
    if (!missing.length) return log("✓ все секреты, на которые ссылаются слои, заданы");
    const show = () => { for (const [n, layers] of missing) log(`  ${n}  — нужен слоям: ${[...layers].join(", ")}`); };
    log(`Не заданы (${missing.length}):`);
    show();
    log(`  Файл: ${slash(secretsPath)} — строки ИМЯ=значение. Значения переносите безопасно (менеджер паролей),
  не через git и не через чат; мастер их не спрашивает и не показывает.`);
    for (let idle = 0; missing.length && idle < 3; ) {
      const a = ask!.line("Заполните файл сейчас (можно частично) и нажмите Enter, или s — позже:");
      if (a && /^(s|ы)$/i.test(a)) break;
      const now = missingSecrets();
      idle = now.length === missing.length ? idle + 1 : 0;
      missing = now;
      if (missing.length) { log(`Ещё не заданы (${missing.length}):`); show(); }
      else log("✓ все секреты заданы");
    }
    if (missing.length) log("  Серверы без секрета sync пропустит. Заполните позже — затем miksy sync --global и miksy sync --all.");
  }

  // План (sync --dry-run) и запись: true — настройки записаны
  function planAndWrite(): boolean {
    step(8, "План", "что miksy запишет агентам — ничего пока не меняется (sync --dry-run).");
    const { lines, text } = planSummary(run);
    for (const l of lines) log(l);
    if (ask!.line("v — показать полный план, Enter — дальше:")?.toLowerCase() === "v") log(text.trimEnd());

    step(9, "Запись", "sync --global (домашний каталог агентов) и sync --all (все проекты workspace).");
    if (!ask!.yes("Записать настройки агентам сейчас?")) {
      log("  Не записано. Позже: miksy sync --global и miksy sync --all (план — с --dry-run).");
      return false;
    }
    const written: TargetReport[] = [];
    for (const args of [["--global"], ["--all"]]) {
      log(`\n$ miksy sync ${args.join(" ")}`);
      try { run("sync", args, { ask, observe: (r) => written.push(r) }); }
      catch (e) { log(`${(e as Error).message}`); }
    }
    // Чужие файлы на местах miksy: заменить — только по явному решению, оригинал сохраняется
    const forceable = written.filter((r) => r.actions.some((a) => a.kind === "conflict" && /создан не miksy/.test(a.why)));
    if (forceable.length) {
      log(`\nОстались конфликты «создан не miksy» (целей: ${forceable.length}):`);
      for (const r of forceable) for (const a of r.actions) if (a.kind === "conflict" && /создан не miksy/.test(a.why)) log(`  ${r.agent}  ${a.abs}`);
      log("  Если всё нужное из этих файлов уже в слоях, miksy заменит их своими. Оригиналы сохранятся в\n  local/backups/originals/ — miksy clean вернёт их на место.");
      if (ask!.yes("Заменить эти файлы (sync --force для этих целей)?"))
        for (const r of forceable) {
          const args = [r.scope === "global" ? "--global" : r.dir!, "--agent", r.agent, "--force"];
          log(`\n$ miksy sync ${args.join(" ")}`);
          try { run("sync", args, { ask }); } catch (e) { log((e as Error).message); }
        }
      else log("  Оставлено. Позже: miksy sync <цель> --agent <агент> --force");
    }
    return true;
  }
}

// Сводка плана sync --global --dry-run и sync --all --dry-run (мастер, шаг 8; miksy update после
// обновления движка): строки сводки и полный вывод обеих команд
export function planSummary(run: Run): { lines: string[]; text: string; changes: number } {
  const reports: TargetReport[] = [];
  const lines: string[] = [];
  let text = "";
  const quiet = (fn: () => void) => {
    const orig = console.log;
    console.log = (...a: unknown[]) => { text += a.map(String).join(" ") + "\n"; };
    try { fn(); } catch (e) { text += `Ошибка: ${(e as Error).message}\n`; } finally { console.log = orig; }
  };
  quiet(() => run("sync", ["--global", "--dry-run"], { ask: null, observe: (r) => reports.push(r) }));
  quiet(() => run("sync", ["--all", "--dry-run"], { ask: null, observe: (r) => reports.push(r) }));
  const count = (rs: TargetReport[]) => {
    const acts = rs.flatMap((r) => r.actions);
    return { create: acts.filter((a) => a.kind === "write" && a.why === "новый").length,
      update: acts.filter((a) => !["conflict", "delete"].includes(a.kind) && !(a.kind === "write" && a.why === "новый")).length,
      remove: acts.filter((a) => a.kind === "delete").length,
      targets: new Set(rs.filter((r) => r.actions.some((a) => a.kind !== "conflict")).map((r) => r.title)).size };
  };
  const line = (label: string, rs: TargetReport[]) => {
    const c = count(rs);
    lines.push(`  ${label}: ${c.create + c.update + c.remove ? `создать ${c.create}, обновить ${c.update}${c.remove ? `, удалить ${c.remove}` : ""} (целей: ${c.targets})` : "изменений нет"}`);
  };
  line("глобально", reports.filter((r) => r.scope === "global"));
  line("проекты и группы", reports.filter((r) => r.scope === "project"));
  const conflicts = reports.flatMap((r) => [...r.actions.filter((a) => a.kind === "conflict").map((a) => `${r.agent}  ${(a as { abs: string }).abs}: ${(a as { why: string }).why}`), ...(r.error ? [`${r.agent}  ${r.title}: ${r.error}`] : [])]);
  if (conflicts.length) {
    lines.push(`  конфликтов: ${conflicts.length} — эти места miksy не тронет:`);
    for (const c of conflicts.slice(0, 10)) lines.push(`    ${c}`);
    if (conflicts.length > 10) lines.push(`    … ещё ${conflicts.length - 10}`);
  } else lines.push("  конфликтов нет");
  const skipped = [...new Set(reports.flatMap((r) => r.warnings.filter((w) => w.startsWith("пропущен сервер")).map((w) => w.replace(/^пропущен сервер /, ""))))];
  if (skipped.length) lines.push(`  пропущены серверы (${skipped.length}):\n${skipped.map((s) => "    " + s).join("\n")}`);
  const trust = text.match(/Нужно решение пользователя о доверии \((\d+)\)/);
  if (trust) lines.push(`  доверие: ${trust[1]} проектов ждут вашего решения — sync спросит при записи`);
  // Ошибка команды целиком (нет machine.yaml, учёт повреждён) — в сводку, а не только в полный план
  for (const e of text.match(/^Ошибка: .*$/gm) ?? []) lines.push(`  ${e}`);
  const all = count(reports);
  // Изменения, решения о доверии и ошибки плана: «записывать нечего» — только если ничего из этого нет
  return { lines, text, changes: all.create + all.update + all.remove + (trust ? 1 : 0) + (/^Ошибка: /m.test(text) ? 1 : 0) };
}

// Новая переменная машины (путь к программе) — строкой в vars: в local/machine.yaml (с бэкапом)
function addVar(machinePath: string, config: string, name: string, value: string, log: (s?: string) => void) {
  const text = readFileSync(machinePath, "utf8");
  const entry = `  ${JSON.stringify(name)}: ${JSON.stringify(value)}`;
  const next = /^vars:[ \t]*$/m.test(text) ? text.replace(/^vars:[ \t]*$/m, `vars:\n${entry}`)
    : /^vars:[ \t]*\{\}[ \t]*$/m.test(text) ? text.replace(/^vars:[ \t]*\{\}[ \t]*$/m, `vars:\n${entry}`) : null;
  if (!next) return log(`• допишите в vars файла local/machine.yaml: ${name}: ${value}`);
  backup(machinePath, config);
  writeAtomic(machinePath, next);
  log(`✓ ${name} записан в local/machine.yaml`);
}
