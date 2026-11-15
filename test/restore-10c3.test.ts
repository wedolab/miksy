// Круг 10c-3 (М5): рабочее состояние агентов (история, сессии, кэши, служебные номера, логи) из копии не возвращается,
// как и файлы входа; всё, что копирует мастер, — возвращается. Поддельный домашний каталог и конфигурация (cliFixture)
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { cliFixture } from "./helpers";
import { copyAgentSettings } from "../src/setup";
import { NOT_RESTORED_FOR_TEST, planRestore } from "../src/restore";
import { ADAPTERS } from "../src/registry";

const put = (p: string, s: string) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };
const read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const { NOT_RESTORED, EVER_COPIED, notRestored } = NOT_RESTORED_FOR_TEST;

// Состояние, которое агенты пишут сами (минимум из рецензии и найденное по агентам)
const STATE = [
  ".claude/projects/D--w-app/s1.jsonl", ".claude/projects/D--w-app/memory/MEMORY.md", ".claude/todos/t.json",
  ".claude/history.jsonl", ".claude/shell-snapshots/s.sh", ".claude/statsig/x", ".claude/file-history/a/b",
  ".claude/local/package.json", ".claude/stats-cache.json",
  ".codex/sessions/2026/11/01/r.jsonl", ".codex/archived_sessions/r.jsonl", ".codex/history.jsonl", ".codex/log/codex-tui.log",
  ".codex/state_5.sqlite", ".codex/state_5.sqlite-wal", ".codex/version.json", ".codex/models_cache.json",
  ".gemini/installation_id", ".gemini/user_id", ".gemini/tmp/h/chats/c.json", ".gemini/history/h/x",
  ".gemini/antigravity/brain/b.md", ".gemini/antigravity/conversations/c.pb",
  ".config/opencode/node_modules/p/index.js",
];

test("ни один путь мастера (прежний и нынешний) не попадает под «не возвращается»", () => {
  const master = [...new Set([...EVER_COPIED, ...Object.values(ADAPTERS).flatMap((a) => a.homeConfig ?? [])])];
  // и вложенное в папки мастера (skills, .gemini/config) — тоже возвращается
  const inside = [".claude/skills/a/SKILL.md", ".agents/skills/b/SKILL.md", ".config/opencode/skills/c/SKILL.md", ".gemini/config/mcp_config.json"];
  expect([...master, ...inside].filter((r) => notRestored(r, true))).toEqual([]);
  // и наоборот: ни одна папка мастера не лежит внутри исключённой
  expect(master.filter((r) => NOT_RESTORED.some((n) => r.toLowerCase().startsWith(n.toLowerCase() + "/")))).toEqual([]);
});

test("копия с рабочим состоянием: состояние не возвращается и не затирается, в «Вернётся»/«Затрёт» его нет; файлы мастера — возвращаются", () => {
  const f = cliFixture({ agents: ["claude", "codex", "opencode", "antigravity"] });
  const h = f.home;
  const settings = [".claude/CLAUDE.md", ".claude/settings.json", ".claude/skills/a/SKILL.md", ".codex/config.toml", ".codex/AGENTS.md",
    ".agents/skills/b/SKILL.md", ".config/opencode/opencode.json", ".config/opencode/skills/c/SKILL.md", ".gemini/GEMINI.md",
    ".gemini/config/mcp_config.json", ".gemini/antigravity-ide/mcp_config.json", ".gemini/antigravity-cli/mcp_config.json"];
  for (const r of [...settings, ...STATE]) put(`${h}/${r}`, `before ${r}\n`);
  // Копия «не мастером» — вся папка агентов целиком (как руками или tar)
  const copy = `${f.config}/local/backups/before-miksy-2026-11-10T09-00-00`;
  copyAgentSettings(h, [".claude", ".codex", ".agents", ".config/opencode", ".gemini"], copy);
  // После установки: настройки поменялись, состояние агентов — тоже (новые сессии, история)
  for (const r of settings) put(`${h}/${r}`, `after ${r}\n`);
  for (const r of STATE) put(`${h}/${r}`, `now ${r}\n`);

  const plan = planRestore(copy, h);
  const listed = [...plan.add, ...plan.overwrite, ...plan.same, ...plan.blocked].map((i) => i.rel);
  expect(listed.filter((r) => STATE.some((s) => s === r || s.startsWith(r.replace(/\/$/, "") + "/")))).toEqual([]);
  expect(plan.overwrite.map((i) => i.rel).sort()).toEqual([...settings].sort());
  expect(plan.notRestored).toEqual(expect.arrayContaining([".claude/projects/", ".claude/history.jsonl", ".codex/sessions/",
    ".codex/history.jsonl", ".codex/state_5.sqlite", ".gemini/installation_id", ".gemini/tmp/", ".config/opencode/node_modules/"]));

  const dry = f.run(["restore", "--dry-run"]);
  expect(dry.code).toBe(0);
  const vernet = dry.out.slice(0, dry.out.indexOf("Не возвращается"));
  for (const s of [".claude/projects", ".codex/sessions", ".codex/history.jsonl", ".gemini/installation_id", ".claude/todos", "state_5.sqlite"])
    expect(vernet).not.toContain(s);
  expect(dry.out).toContain("Не возвращается — файлы входа и рабочее состояние агентов (история, сессии; старое затёрло бы нынешнее): ");

  const r = f.run(["restore", "--yes"]);
  expect(r.code).toBe(0);
  for (const s of settings) expect(read(`${h}/${s}`)).toBe(`before ${s}\n`);
  for (const s of STATE) expect(read(`${h}/${s}`)).toBe(`now ${s}\n`);
});

test("состояние, которого на месте нет, тоже не появляется; лог и база вне папок агентов — «пропущено», не «состояние»", () => {
  const f = cliFixture();
  const copy = `${f.dir}/copy`;
  put(`${copy}/.codex/sessions/r.jsonl`, "old");
  put(`${copy}/.claude/todos/t.json`, "old");
  put(`${copy}/.gemini/installation_id`, "old");
  put(`${copy}/.claude/agents/a.md`, "agent\n");
  put(`${copy}/notes.log`, "x");
  const plan = planRestore(copy, f.home);
  expect(plan.notRestored).toEqual([".claude/todos/", ".codex/sessions/", ".gemini/installation_id"]);
  expect(plan.add.map((i) => i.rel)).toEqual([".claude/agents/a.md"]);
  expect(plan.skipped).toEqual(["notes.log"]);
  const r = f.run(["restore", copy, "--yes"]);
  expect(r.code).toBe(0);
  expect([existsSync(`${f.home}/.codex/sessions`), existsSync(`${f.home}/.claude/todos`), existsSync(`${f.home}/.gemini/installation_id`)]).toEqual([false, false, false]);
  expect(read(`${f.home}/.claude/agents/a.md`)).toBe("agent\n");
});
