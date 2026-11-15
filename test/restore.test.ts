// Круг 10c: miksy restore — возврат копии «до miksy» (вместо длинной команды оболочки 0.2.2–0.2.3; её сценарии —
// test/fixes022-restore*.test.ts — перенесены сюда и в restore-win.test.ts). Всё — в поддельном домашнем каталоге и
// конфигурации (cliFixture); копию делает тот же copyAgentSettings, что и мастер
import { expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { cliFixture } from "./helpers";
import { copyAgentSettings } from "../src/setup";
import { AGENT_DIRS } from "../src/restore";

const win = process.platform === "win32";
const put = (p: string, s: string) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };
const read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const isLink = (p: string) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
const target = (p: string) => readlinkSync(p).replaceAll("\\", "/").replace(/^\/\/\?\//, "").replace(/\/$/, "");
const STAMP = "2026-11-10T09-00-00";
const ALL = [".claude.json", ".claude/CLAUDE.md", ".claude/settings.json", ".claude/skills", ".codex/config.toml", ".codex/AGENTS.md",
  ".codex/AGENTS.override.md", ".agents/skills", ".config/opencode/opencode.json", ".config/opencode/opencode.jsonc",
  ".config/opencode/AGENTS.md", ".config/opencode/skills", ".gemini/GEMINI.md", ".gemini/config",
  ".gemini/antigravity-ide/mcp_config.json", ".gemini/antigravity-cli/mcp_config.json"];

// .claude.json, как его пишет Claude: JSON с отступом 2
const claudeJson = (o: unknown) => JSON.stringify(o, null, 2);

// Домашний каталог с настройками всех агентов (всё, что копирует мастер 0.2.3), копия — copyAgentSettings
function fixture(o: { copyName?: string } = {}) {
  const f = cliFixture({ agents: ["claude", "codex", "opencode", "antigravity"] });
  const h = f.home;
  put(`${h}/.claude.json`, claudeJson({ oauthAccount: { emailAddress: "x" }, mcpServers: { gh: { command: "gh-mcp", env: { TOKEN: "SECRET-VALUE-1" } } },
    projects: { "D:/w/app": { allowedTools: [], mcpServers: { pg: { command: "pg" } } }, "D:/w/gone": { mcpServers: { old: { command: "old" } } } } }));
  for (const r of [".claude/CLAUDE.md", ".claude/settings.json", ".codex/config.toml", ".codex/AGENTS.md", ".codex/AGENTS.override.md",
    ".config/opencode/opencode.json", ".config/opencode/opencode.jsonc", ".config/opencode/AGENTS.md", ".gemini/GEMINI.md",
    ".gemini/antigravity-ide/mcp_config.json", ".gemini/antigravity-cli/mcp_config.json"]) put(`${h}/${r}`, `before ${r}\n`);
  for (const r of [".claude/skills/a/SKILL.md", ".agents/skills/b/SKILL.md", ".config/opencode/skills/c/SKILL.md", ".gemini/config/mcp_config.json", ".gemini/config/skills/d/SKILL.md"])
    put(`${h}/${r}`, `before ${r}\n`);
  const copy = `${f.config}/local/backups/${o.copyName ?? `before-miksy-${STAMP}`}`;
  const r = copyAgentSettings(h, ALL, copy);
  expect(r.links).toEqual([]);
  return { ...f, copy };
}
// Что лежит под каталогами агентов (кроме .claude.json): путь → содержимое
function snapshot(home: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(`${d}/${e.name}`, r); else out[r] = readFileSync(`${d}/${e.name}`, "utf8"); } };
  for (const a of AGENT_DIRS) if (existsSync(`${home}/${a}`)) walk(`${home}/${a}`, a);
  return out;
}
// После установки: miksy поменял и убрал файлы (как будто clean оставил своё и ваши правки)
function changeHome(home: string) {
  put(`${home}/.codex/config.toml`, "after\n");
  rmSync(`${home}/.claude/skills`, { recursive: true });
  rmSync(`${home}/.gemini/GEMINI.md`);
  put(`${home}/.claude.json`, claudeJson({ oauthAccount: { emailAddress: "x" }, numStartups: 5, mcpServers: { mine: { command: "m" } }, projects: { "D:/w/app": { allowedTools: ["Bash"] } } }));
}

test("копия мастера 0.2.3 возвращается целиком; --dry-run ничего не пишет; .claude.json — только недостающие серверы", () => {
  const f = fixture();
  const before = snapshot(f.home);
  changeHome(f.home);
  const liveBefore = read(`${f.home}/.claude.json`);
  const dry = f.run(["restore", "--dry-run"]);
  expect(dry.code).toBe(0);
  expect(dry.out).toContain("Вернётся (нет на месте, 2):");
  expect(dry.out).toContain("  ~/.claude/skills/a/SKILL.md");
  expect(dry.out).toContain("  ~/.gemini/GEMINI.md");
  expect(dry.out).toContain("Затрёт — изменилось после установки; нынешние файлы сохранятся в бэкап (1):\n  ~/.codex/config.toml");
  expect(dry.out).toContain("Допишу MCP-серверы Claude из копии (3): gh, pg (проект D:/w/app), old (проект D:/w/gone) — проекта нет в списке Claude, запись проекта появится");
  expect(dry.out).toContain("--dry-run: ничего не записано.");
  expect(dry.out).not.toContain("SECRET-VALUE-1");
  expect(read(`${f.home}/.codex/config.toml`)).toBe("after\n");
  expect(read(`${f.home}/.claude.json`)).toBe(liveBefore);

  const r = f.run(["restore", "--yes"]);
  expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
  expect(r.out).toContain("✓ вернулось: 3 файла");
  expect(r.out).toContain("✓ MCP-серверы Claude дописаны в ~/.claude.json: gh, pg (проект D:/w/app), old (проект D:/w/gone)");
  expect(r.out).not.toContain("SECRET-VALUE-1");
  expect(snapshot(f.home)).toEqual(before);
  // Затёртое — точной копией в before-restore-<метка>/, пути от ~ (и ~/.claude.json до дописки)
  const saved = readdirSync(`${f.config}/local/backups`).filter((d) => d.startsWith("before-restore-"));
  expect(saved.length).toBe(1);
  expect(r.out).toContain(`прежние версии затёртых файлов — в ${f.config}/local/backups/${saved[0]}/`);
  expect(read(`${f.config}/local/backups/${saved[0]}/.codex/config.toml`)).toBe("after\n");
  expect(read(`${f.config}/local/backups/${saved[0]}/.claude.json`)).toBe(liveBefore);
  // .claude.json: вне mcpServers — как было, байт в байт (тот же формат Claude); серверы — дописаны, свои целы
  const live = JSON.parse(read(`${f.home}/.claude.json`)!);
  expect(live.mcpServers).toEqual({ mine: { command: "m" }, gh: { command: "gh-mcp", env: { TOKEN: "SECRET-VALUE-1" } } });
  expect(live.projects["D:/w/app"]).toEqual({ allowedTools: ["Bash"], mcpServers: { pg: { command: "pg" } } });
  expect(live.projects["D:/w/gone"]).toEqual({ mcpServers: { old: { command: "old" } } });
  const strip = (o: any) => { const c = structuredClone(o); delete c.mcpServers; for (const p of Object.values(c.projects ?? {}) as any[]) delete p.mcpServers; delete c.projects["D:/w/gone"]; return claudeJson(c); };
  expect(strip(live)).toBe(strip(JSON.parse(liveBefore!)));
  expect(claudeJson(live)).toBe(read(`${f.home}/.claude.json`)!);

  // Повторный запуск: всё на месте, ничего не дублируется
  const again = f.run(["restore", "--yes"]);
  expect(again.code).toBe(0);
  expect(again.out).toContain("Всё из копии уже на месте. Ничего не записано.");
  expect(again.out).toContain("Уже на месте: gh, pg (проект D:/w/app), old (проект D:/w/gone)");
  expect(JSON.parse(read(`${f.home}/.claude.json`)!)).toEqual(live);
}, 30000);

test("сервер Claude с тем же именем, но другой — не тронут и назван", () => {
  const f = fixture();
  put(`${f.home}/.claude.json`, claudeJson({ mcpServers: { gh: { command: "другой" } }, projects: { "D:/w/app": { mcpServers: { pg: { command: "pg" } } } } }));
  const r = f.run(["restore", "--yes"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("Не трогаю — на месте сервер с тем же именем, но другой (1): gh");
  expect(r.out).toContain("Уже на месте: pg (проект D:/w/app)");
  const live = JSON.parse(read(`${f.home}/.claude.json`)!);
  expect(live.mcpServers).toEqual({ gh: { command: "другой" } });
  expect(Object.keys(live.projects)).toEqual(["D:/w/app", "D:/w/gone"]);
});

test("нынешнего ~/.claude.json нет — серверы не переносятся, сказано почему; остальное вернулось, код 1", () => {
  const f = fixture();
  rmSync(`${f.home}/.claude.json`);
  put(`${f.home}/.codex/config.toml`, "after\n");
  const r = f.run(["restore", "--yes"]);
  expect(r.code).toBe(1);
  expect(r.out).toContain("MCP-серверы Claude не перенесу: ~/.claude.json нет: запустите Claude один раз");
  expect(read(`${f.home}/.codex/config.toml`)).toBe("before .codex/config.toml\n");
  expect(existsSync(`${f.home}/.claude.json`)).toBe(false);
  // Повтор: работы нет, но не всё на месте — «всё на месте» не говорит, код 1 (и у --dry-run тот же)
  for (const args of [["restore", "--yes"], ["restore", "--dry-run"]]) {
    const again = f.run(args);
    expect({ code: again.code, all: again.out.includes("уже на месте.") }).toEqual({ code: 1, all: false });
  }
});

test("возврат из прежней before-restore сразу после первого запуска: бэкап — в новую папку, копия цела", () => {
  const f = fixture();
  put(`${f.home}/.codex/config.toml`, "mine\n");
  expect(f.run(["restore", "--yes"]).code).toBe(0);
  const first = readdirSync(`${f.config}/local/backups`).find((d) => d.startsWith("before-restore-"))!;
  const r = f.run(["restore", `${f.config}/local/backups/${first}`, "--yes"]);
  expect(r.code).toBe(0);
  expect(read(`${f.home}/.codex/config.toml`)).toBe("mine\n");
  expect(read(`${f.config}/local/backups/${first}/.codex/config.toml`)).toBe("mine\n");
  const all = readdirSync(`${f.config}/local/backups`).filter((d) => d.startsWith("before-restore-"));
  expect(all.length).toBe(2);
});

test("--dry-run: код как у запуска — папка на месте файла даёт 1", () => {
  const f = fixture();
  rmSync(`${f.home}/.codex/AGENTS.md`);
  mkdirSync(`${f.home}/.codex/AGENTS.md`);
  put(`${f.home}/.codex/config.toml`, "after\n");
  expect(f.run(["restore", "--dry-run"]).code).toBe(1);
  expect(read(`${f.home}/.codex/config.toml`)).toBe("after\n");
});

test("бэкап затёртого — точный: значения секретов из secrets.env не заменены заглушками", () => {
  const f = fixture();
  put(`${f.config}/local/secrets.env`, "GH=ghp_restore_secret_1234567890\n");
  put(`${f.home}/.codex/config.toml`, "token = \"ghp_restore_secret_1234567890\"\n");
  expect(f.run(["restore", "--yes"]).code).toBe(0);
  const saved = readdirSync(`${f.config}/local/backups`).find((d) => d.startsWith("before-restore-"))!;
  expect(read(`${f.config}/local/backups/${saved}/.codex/config.toml`)).toBe("token = \"ghp_restore_secret_1234567890\"\n");
});

test("цели проектов Claude в учёте — серверы проектов не переносятся до clean --all; после него — переносятся", () => {
  const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
  const proj = `${f.ws}/Org/p1`;
  put(`${f.config}/layers/tree/Org/p1/mcp/pg.yaml`, "name: pg\ncommand: pg-miksy\n");
  put(`${f.home}/.claude.json`, claudeJson({ projects: { [proj]: { allowedTools: [], mcpServers: { pg: { command: "pg-before" } } } } }));
  copyAgentSettings(f.home, [".claude.json"], `${f.config}/local/backups/before-miksy-${STAMP}`);
  // Как после adopt: сервер проекта перенесён в слой и записан miksy
  put(`${f.home}/.claude.json`, claudeJson({ projects: { [proj]: { allowedTools: [] } } }));
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  expect(JSON.parse(read(`${f.home}/.claude.json`)!).projects[proj].mcpServers.pg.command).toBe("pg-miksy");
  const early = f.run(["restore", "--yes"]);
  expect(early.code).toBe(1);
  expect(early.out).toContain(`Серверы проектов Claude перенесу после miksy clean --all (в ~/.claude.json ещё серверы проектов, записанные miksy): pg (проект ${proj})`);
  expect(early.out).not.toContain("Не трогаю");
  expect(early.out).not.toContain("уже на месте.");
  expect(f.run(["clean", "--all"]).code).toBe(0);
  const r = f.run(["restore", "--yes"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(read(`${f.home}/.claude.json`)!).projects[proj].mcpServers).toEqual({ pg: { command: "pg-before" } });
}, 30000);

test.skipIf(!win)("Windows: ключ проекта в .claude.json — без учёта регистра и вида косых, второй записи нет", () => {
  const f = cliFixture();
  put(`${f.home}/.claude.json`, claudeJson({ projects: { "C:/Users/X/app": { mcpServers: { pg: { command: "pg" } } } } }));
  copyAgentSettings(f.home, [".claude.json"], `${f.config}/local/backups/before-miksy-${STAMP}`);
  put(`${f.home}/.claude.json`, claudeJson({ projects: { "c:\\users\\x\\app": { allowedTools: [] } } }));
  expect(f.run(["restore", "--yes"]).code).toBe(0);
  expect(JSON.parse(read(`${f.home}/.claude.json`)!).projects).toEqual({ "c:\\users\\x\\app": { allowedTools: [], mcpServers: { pg: { command: "pg" } } } });
});

test("папку внутри копии не прочитать — названа, остальное вернулось, код 1", () => {
  const f = fixture();
  put(`${f.home}/.codex/config.toml`, "after\n");
  // Копия вне local/ (путём): запрет чтения внутри local/backups остановил бы любую команду miksy проверкой прав local/
  const copy = `${f.dir}/copy`;
  cpSync(f.copy, copy, { recursive: true });
  const locked = `${copy}/.gemini`;
  const lock = () => win ? Bun.spawnSync(["icacls", locked.replaceAll("/", "\\"), "/deny", `${process.env.USERNAME}:(OI)(CI)(RD)`], { stdout: "pipe" }) : chmodSync(locked, 0);
  const unlock = () => win ? Bun.spawnSync(["icacls", locked.replaceAll("/", "\\"), "/remove:d", `${process.env.USERNAME}`], { stdout: "pipe" }) : chmodSync(locked, 0o700);
  lock();
  let r;
  try { r = f.run(["restore", copy, "--yes"]); } finally { unlock(); }
  expect(r.err).toBe("");
  if (!win && process.getuid?.() === 0) return; // root читает всё
  expect(r.code).toBe(1);
  expect(r.out).toContain("не возвращён: ~/.gemini/ — в копии не прочитать");
  expect(read(`${f.home}/.codex/config.toml`)).toBe("before .codex/config.toml\n");
});

test("без терминала и без --yes — код 2, ничего не записано", () => {
  const f = fixture();
  changeHome(f.home);
  const r = f.run(["restore"]);
  expect(r.code).toBe(2);
  expect(r.err).toContain("miksy restore --yes");
  expect(read(`${f.home}/.codex/config.toml`)).toBe("after\n");
});

test("ответ «нет» на вопрос — ничего не записано, код 1", () => {
  const f = fixture();
  changeHome(f.home);
  const { runCommand } = require("../src/commands");
  const env = { MIKSY_CONFIG: process.env.MIKSY_CONFIG, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  Object.assign(process.env, { MIKSY_CONFIG: f.config, HOME: f.home, USERPROFILE: f.home });
  const asked: string[] = [];
  try {
    expect(() => runCommand("restore", [], { ask: { yes: (q: string) => { asked.push(q); return false; }, choose: () => null, line: () => null } })).toThrow("Отменено");
  } finally { Object.assign(process.env, env); }
  expect(asked).toEqual(["Вернуть?"]);
  expect(read(`${f.home}/.codex/config.toml`)).toBe("after\n");
});

test("учёт: домашние цели — отказ с командами clean; после них restore проходит; цели проектов — только напоминание", () => {
  const f = cliFixture({ agents: ["claude", "codex", "opencode", "antigravity"] });
  put(`${f.home}/.codex/config.toml`, "model = \"before\"\n");
  copyAgentSettings(f.home, [".codex/config.toml"], `${f.config}/local/backups/before-miksy-${STAMP}`);
  // codex убран из agents после sync: его цель — отдельной командой с --agent
  expect(f.run(["sync", "--global"]).code).toBe(0);
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  writeFileSync(`${f.config}/local/machine.yaml`, readFileSync(`${f.config}/local/machine.yaml`, "utf8").replace("claude, codex, ", "claude, "));
  const block = f.run(["restore", "--yes"]);
  expect(block.code).toBe(1);
  expect(block.out).toContain("miksy ещё записан в домашние настройки агентов (antigravity, claude, codex, opencode)");
  const cmds = block.out.split("\n").filter((l) => l.startsWith("  miksy clean")).map((l) => l.trim());
  expect(cmds).toEqual(["miksy clean --global", "miksy clean --global --agent codex"]);
  expect(block.out).toContain("Ничего не записано.");
  for (const c of cmds) expect(f.run(c.split(" ").slice(1)).code).toBe(0);
  const r = f.run(["restore", "--yes"]);
  expect(r.out).toContain("В проектах ещё записано то, что добавил miksy. Если удаляете его совсем — сначала miksy clean --all.");
  expect(r.code).toBe(0);
  expect(read(`${f.home}/.codex/config.toml`)).toBe("model = \"before\"\n");
}, 30000);

test("копии нет; неверная метка; неверный путь — сообщение, код 1", () => {
  const f = cliFixture();
  const none = f.run(["restore"]);
  expect(none.code).toBe(1);
  expect(none.out).toContain("Копии «до miksy» нет");
  expect(none.out).toContain("архивом из «Установки вручную»");
  mkdirSync(`${f.config}/local/backups/before-miksy-${STAMP}`, { recursive: true });
  const stamp = f.run(["restore", "2020-01-01T00-00-00"]);
  expect(stamp.code).toBe(1);
  expect(stamp.out).toContain(`Копии с меткой 2020-01-01T00-00-00 нет`);
  expect(stamp.out).toContain(`Копии на этой машине: ${STAMP}`);
  const path = f.run(["restore", `${f.dir}/нет такой`]);
  expect(path.code).toBe(1);
  expect(path.out).toContain("такой папки нет");
});

test("несколько копий: без аргумента — самая ранняя, остальные названы; по метке, имени и пути — указанная", () => {
  const f = fixture();
  const later = "2026-11-12T18-30-00";
  put(`${f.config}/local/backups/before-miksy-${later}/.codex/config.toml`, "later\n");
  const dry = f.run(["restore", "--dry-run"]);
  expect(dry.out).toContain(`Копия «до miksy»: ${f.copy}`);
  expect(dry.out).toContain(`(копий 2; взята самая ранняя; другая — miksy restore ${later})`);
  for (const arg of [later, `before-miksy-${later}`, `${f.config}/local/backups/before-miksy-${later}`]) {
    put(`${f.home}/.codex/config.toml`, "now\n");
    const r = f.run(["restore", arg, "--yes"]);
    expect(r.code).toBe(0);
    expect(read(`${f.home}/.codex/config.toml`)).toBe("later\n");
  }
}, 30000);

test("посторонние пути в копии — пропущены и названы; соседние файлы каталогов агентов — возвращаются", () => {
  const f = cliFixture();
  const copy = `${f.config}/local/backups/before-miksy-${STAMP}`;
  put(`${copy}/.ssh/id_rsa`, "x");
  put(`${copy}/notes.txt`, "x");
  put(`${copy}/.config/other/x.json`, "x");
  put(`${copy}/.claude/agents/a.md`, "agent\n"); // мастер такого не копирует, но это настройки Claude
  put(`${copy}/.config/opencode/themes/t.json`, "{}\n");
  put(`${copy}/.claude/.credentials.json`, "old login");
  put(`${copy}/.codex/auth.json`, "old login");
  put(`${copy}/.claude/.claude.json`, "{}");
  put(`${copy}/.claude/backups/.claude.json.backup.1`, "{}");
  put(`${f.home}/.codex/auth.json`, "current login");
  const r = f.run(["restore", "--yes"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("Не возвращается — файлы входа и рабочее состояние агентов (история, сессии; старое затёрло бы нынешнее): .claude/.claude.json, .claude/.credentials.json, .claude/backups/, .codex/auth.json");
  expect([read(`${f.home}/.codex/auth.json`), existsSync(`${f.home}/.claude/.credentials.json`)]).toEqual(["current login", false]);
  expect(r.out).toContain("Пропущено — не настройки агентов (3): .config/other/, .ssh/, notes.txt");
  expect(existsSync(`${f.home}/.ssh`) || existsSync(`${f.home}/notes.txt`) || existsSync(`${f.home}/.config/other`)).toBe(false);
  expect(read(`${f.home}/.claude/agents/a.md`)).toBe("agent\n");
  expect(read(`${f.home}/.config/opencode/themes/t.json`)).toBe("{}\n");
});

test("на месте файла — папка: не возвращён, папка цела, остальное вернулось; после исправления — повтор, код 0", () => {
  const f = fixture();
  rmSync(`${f.home}/.codex/AGENTS.md`);
  put(`${f.home}/.codex/AGENTS.md/inside.txt`, "keep\n");
  put(`${f.home}/.codex/config.toml`, "after\n");
  const r = f.run(["restore", "--yes"]);
  expect(r.code).toBe(1);
  expect(r.out).toContain("не возвращён: ~/.codex/AGENTS.md — на этом месте папка");
  expect(r.out).toContain("повторять безопасно");
  expect(read(`${f.home}/.codex/AGENTS.md/inside.txt`)).toBe("keep\n");
  expect(read(`${f.home}/.codex/config.toml`)).toBe("before .codex/config.toml\n");
  rmSync(`${f.home}/.codex/AGENTS.md`, { recursive: true });
  const again = f.run(["restore", "--yes"]);
  expect(again.code).toBe(0);
  expect(again.out).toContain("✓ вернулось: 1 файл");
  expect(read(`${f.home}/.codex/AGENTS.md`)).toBe("before .codex/AGENTS.md\n");
});

test.skipIf(win)("macOS, Linux: «только для чтения» — назван с командой chmod, код 1", () => {
  const f = fixture();
  put(`${f.home}/.codex/config.toml`, "after\n");
  chmodSync(`${f.home}/.codex/config.toml`, 0o444);
  const r = f.run(["restore", "--yes"]);
  chmodSync(`${f.home}/.codex/config.toml`, 0o644);
  expect(r.code).toBe(1);
  expect(r.out).toContain(`не возвращён: ~/.codex/config.toml — файл «только для чтения»: снимите пометку — chmod u+w '${f.home}/.codex/config.toml'`);
});

test.skipIf(win)("macOS, Linux: ссылки — сквозь dotfiles пользователя; из копии — с той же целью (относительная, битая)", () => {
  const f = cliFixture();
  const dot = `${f.dir}/dot`;
  put(`${dot}/claude/settings.json`, "{}");
  put(`${dot}/skills/s/SKILL.md`, "s");
  symlinkSync(`${dot}/claude`, `${f.home}/.claude`);
  symlinkSync(`${dot}/skills`, `${f.home}/.claude/skills`);
  symlinkSync("../rel-target", `${f.home}/.claude/rel`);
  symlinkSync(`${dot}/gone`, `${f.home}/.claude/gone`);
  const copy = `${f.config}/local/backups/before-miksy-${STAMP}`;
  copyAgentSettings(f.home, [".claude/settings.json", ".claude/skills", ".claude/rel", ".claude/gone"], copy);
  put(`${dot}/claude/settings.json`, "changed");
  rmSync(`${f.home}/.claude/skills`);
  rmSync(`${f.home}/.claude/rel`);
  rmSync(`${f.home}/.claude/gone`);
  symlinkSync(`${dot}/elsewhere`, `${f.home}/.claude/gone`);
  const r = f.run(["restore", "--yes"]);
  expect({ code: r.code, out: r.out.includes("✓ вернулось") }).toEqual({ code: 0, out: true });
  expect(isLink(`${f.home}/.claude`)).toBe(true);
  expect(read(`${dot}/claude/settings.json`)).toBe("{}");
  expect(target(`${f.home}/.claude/skills`)).toBe(`${dot}/skills`);
  expect(target(`${f.home}/.claude/rel`)).toBe("../rel-target");
  expect(target(`${f.home}/.claude/gone`)).toBe(`${dot}/gone`);
  // Повтор — ссылки уже на месте
  const again = f.run(["restore", "--yes"]);
  expect(again.out).toContain("Всё из копии уже на месте.");
});

test("пути с ' ’ $ ` пробелом, кириллицей и [ ] в копии и домашнем каталоге; путь копии с косой в конце", () => {
  const f = cliFixture();
  const odd = `кат 'a’$b\`[c]`;
  const copy = `${f.dir}/${odd}/before-miksy-${STAMP}`;
  put(`${copy}/.codex/config.toml`, "cfg\n");
  put(`${copy}/.claude/skills/${odd}/SKILL.md`, "s\n");
  for (const arg of [copy, `${copy}/`]) {
    rmSync(`${f.home}/.codex`, { recursive: true, force: true });
    rmSync(`${f.home}/.claude`, { recursive: true, force: true });
    const r = f.run(["restore", arg, "--yes"]);
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
    expect(read(`${f.home}/.codex/config.toml`)).toBe("cfg\n");
    expect(read(`${f.home}/.claude/skills/${odd}/SKILL.md`)).toBe("s\n");
  }
});

test("мастер в шаге 3 печатает miksy restore, длинной команды нет; справка — тоже", () => {
  const setupSrc = readFileSync(`${import.meta.dir}/../src/setup.ts`, "utf8");
  expect(setupSrc).toContain("вернуть (после miksy clean --all и --global): miksy restore");
  expect(setupSrc).not.toContain("restoreCommand");
  const doc = readFileSync(`${import.meta.dir}/../docs/uninstall.md`, "utf8");
  expect(doc).toContain("miksy restore");
  expect(doc).not.toContain("Get-ChildItem -LiteralPath $d -Force");
  expect(doc).not.toContain("find . ! -type d ! -path ./.claude.json");
});
