import { expect, test } from "bun:test";
import { existsSync, readFileSync, symlinkSync, lstatSync } from "node:fs";
import { apply, plan, verifyMerges } from "../src/apply";
import { emptyState, loadManifest, sha } from "../src/manifest";
import { pathKey } from "../src/paths";
import { aclProblem } from "../src/secretfiles";
import { codex } from "../adapters/codex";
import { cliFixture, put } from "./helpers";
import { instructionBlock } from "../src/instructions";
import { KEEP_RUNS, newBackupRun, backup } from "../src/backup";
import { TOML_END } from "../src/toml";
import { codexProjectKey, trustPlan } from "../src/trust";
import { claude } from "../adapters/claude";

function blockFixture(text = "") {
  const f = cliFixture();
  const path = `${f.home}/.claude/CLAUDE.md`;
  if (text) put(path, text);
  const machine = { home: f.home, workspace: f.ws, os: process.platform === "win32" ? "windows" as const : "macos" as const, vars: {} };
  const result = (content: string) => ({ warnings: [], files: [{ base: "home" as const, path: ".claude/CLAUDE.md", mode: "own" as const, block: true, content }] });
  const make = (content: string, state = emptyState(), force = false) => plan(result(content), { scope: "global" }, machine, state, force);
  return { ...f, path, machine, result, make };
}

test("2б/1: общий файл инструкций сохраняет чужой текст при sync и clean", () => {
  const f = cliFixture();
  const path = `${f.home}/.claude/CLAUDE.md`;
  put(path, "Личная память\n");
  expect(f.run(["sync", "--global"]).code).toBe(0);
  expect(readFileSync(path, "utf8")).toContain("<!-- miksy:begin");
  put(path, readFileSync(path, "utf8") + "Дополнение агента\n");
  expect(f.run(["clean", "--global"]).code).toBe(0);
  expect(readFileSync(path, "utf8")).toBe("Личная память\nДополнение агента\n");
}, 30000);

test("2б/2: Codex переносит личный и импортированный skill из коллекции команды", () => {
  const f = cliFixture();
  const dir = `${f.ws}/Org/p1`;
  put(`${dir}/.agents/skills/team/SKILL.md`, "team");
  Bun.spawnSync(["git", "-C", dir, "add", ".agents/skills/team/SKILL.md"]);
  const cfg = { layers: [], instructions: [], mcp: [], notes: [], skills: [false, true].map((team, i) => ({ layer: "x", item: {
    name: `s${i}`, dir: "", team, files: [{ rel: "SKILL.md", content: "skill", executable: false }],
  } })) };
  const r = codex.render(cfg, { scope: "project", dir, rel: "Org/p1" }, { home: f.home, workspace: f.ws, os: "windows", vars: {} });
  expect(r.files.map((x) => x.path)).toEqual([".codex/skills/s0/SKILL.md", ".codex/skills/s1/SKILL.md"]);
});

test("2б/3: потеря маркеров TOML не теряет владение таблицами", () => {
  const f = cliFixture();
  const machine = { home: f.home, workspace: f.ws, os: "windows" as const, vars: {} };
  const r = { warnings: [], files: [{ base: "home" as const, path: ".codex/config.toml", mode: "merge" as const, format: "toml" as const, key: ["mcp_servers"], data: { a: { command: "echo", args: [] } } }] };
  const { state } = apply(plan(r, { scope: "global" }, machine, emptyState(), false), emptyState());
  const path = `${f.home}/.codex/config.toml`;
  put(path, '[mcp_servers.a]\ncommand = "echo"\n[mcp_servers.foreign]\ncommand="other"\n');
  const actions = plan(r, { scope: "global" }, machine, state, false);
  expect(actions.filter((a) => a.kind === "conflict")).toEqual([]);
  const next = apply(actions, state).state;
  expect(verifyMerges(next)).toEqual([]);
  apply(plan({ files: [], warnings: [] }, { scope: "global" }, machine, next, false), next);
  expect(Bun.TOML.parse(readFileSync(path, "utf8")).mcp_servers).toEqual({ foreign: { command: "other" } });
});

test("2б/4: захват чужого own-файла сохраняет неротируемый оригинал, clean восстанавливает", () => {
  const f = cliFixture({ agents: ["opencode"] });
  const path = `${f.home}/.config/opencode/AGENTS.md`;
  put(path, "Оригинал\n");
  expect(f.run(["sync", "--global", "--force"]).code).toBe(0);
  const st = loadManifest(`${f.config}/local/state/manifest.json`).targets["opencode|global"];
  const original = (st as any).originals?.[pathKey(path)];
  expect(original?.path).toContain("/backups/originals/");
  expect(readFileSync(original.path, "utf8")).toBe("Оригинал\n");
  expect(f.run(["clean", "--global"]).code).toBe(0);
  expect(readFileSync(path, "utf8")).toBe("Оригинал\n");
}, 30000);

test("2б/5: sync добавляет доверие Codex и Claude, clean снимает своё", () => {
  const f = cliFixture({ agents: ["codex", "claude"] });
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  const codexFile = `${f.home}/.codex/config.toml`;
  expect(existsSync(codexFile)).toBe(true);
  expect(Object.values((Bun.TOML.parse(readFileSync(codexFile, "utf8")) as any).projects).some((x: any) => x.trust_level === "trusted")).toBe(true);
  expect(Object.values(JSON.parse(readFileSync(`${f.home}/.claude.json`, "utf8")).projects).some((x: any) => x.hasTrustDialogAccepted === true)).toBe(true);
  expect(f.run(["clean", "--all"]).code).toBe(0);
  expect(JSON.stringify(Bun.TOML.parse(readFileSync(codexFile, "utf8")))).not.toContain("trusted");
  expect(readFileSync(`${f.home}/.claude.json`, "utf8")).not.toContain("hasTrustDialogAccepted");
}, 30000);

test("2б/6: sync закрывает весь local, включая старые бэкапы", () => {
  const f = cliFixture();
  const backup = `${f.config}/local/backups/old/file`;
  put(backup, "искусственные данные");
  expect(f.run(["sync", "--global"]).code).toBe(0);
  expect(aclProblem(`${f.config}/local`)).toBeNull();
  expect(aclProblem(backup)).toBeNull();
}, 30000);

test("2б/7: проверка после записи не сообщает о пропавшем до запуска ключе", () => {
  const f = cliFixture();
  const path = `${f.home}/.claude.json`;
  put(path, '{"mcpServers":{"fresh":{}}}');
  const st = emptyState();
  st.merges[path] = { '["mcpServers"]': ["old", "fresh"] };
  const written = [{ kind: "merge", abs: path, key: ["mcpServers"], set: { fresh: {} }, remove: [], adopt: [], own: ["old", "fresh"] }];
  expect((verifyMerges as any)(st, written)).toEqual([]);
});

test("2б/1: миграция own → блок, конфликт внутри, force только блока, гонка и clean", () => {
  const f = blockFixture("old\n");
  const prev = emptyState(); prev.files[pathKey(f.path)] = sha("old\n");
  const st = apply(f.make("old\n", prev), prev).state;
  expect(st.files).toEqual({});
  expect(st.blocks?.[pathKey(f.path)]).toBe(sha(instructionBlock("old\n")));
  put(f.path, "before\n" + readFileSync(f.path, "utf8").replace("old", "edited") + "after\n");
  expect(f.make("new\n", st).some((a) => a.kind === "conflict")).toBe(true);
  const next = apply(f.make("new\n", st, true), st).state;
  expect(readFileSync(f.path, "utf8")).toBe("before\n" + instructionBlock("new\n") + "after\n");
  const pending = f.make("newer\n", next);
  put(f.path, readFileSync(f.path, "utf8") + "concurrent\n");
  expect(() => apply(pending, next)).toThrow("после планирования");
  apply(plan({ files: [], warnings: [] }, { scope: "global" }, f.machine, next, false), next);
  expect(readFileSync(f.path, "utf8")).toBe("before\nafter\nconcurrent\n");
});

test("2б/1: изменённый legacy own не мигрирует; чужой текст без LF восстанавливается точно", () => {
  const f = blockFixture("foreign without LF");
  const prev = emptyState(); prev.files[pathKey(f.path)] = sha("old");
  expect(f.make("rules", prev).some((a) => a.kind === "conflict")).toBe(true);
  const st = apply(f.make("rules"), emptyState()).state;
  expect(f.make("rules", st)).toEqual([]);
  apply(plan({ files: [], warnings: [] }, { scope: "global" }, f.machine, st, false), st);
  expect(readFileSync(f.path, "utf8")).toBe("foreign without LF");
});

test("2б/1: Claude выбирает rules/miksy.md, обе командные области — предупреждение", () => {
  const f = cliFixture(), dir = `${f.ws}/Org/p1`;
  put(`${dir}/CLAUDE.local.md`, "team");
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args]);
  git("add", "CLAUDE.local.md");
  const cfg = { layers: [], instructions: [{ layer: "x", item: { file: "00.md", path: `${f.config}/layers/tree/instructions/00.md` } }], skills: [], mcp: [], notes: [] };
  const render = () => claude.render(cfg, { scope: "project", dir, rel: "p" }, { home: f.home, workspace: f.ws, os: "linux", vars: {} });
  expect(render().files[0].path).toBe(".claude/rules/miksy.md");
  put(`${dir}/.claude/rules/team.md`, "team"); git("add", ".claude/rules/team.md");
  expect(render().files).toEqual([]);
  expect(render().warnings.join(" ")).toContain("версионирует команда");
});

test("2б/2: миграция старой копии из .agents, обе коллекции командные — конфликт", () => {
  const f = cliFixture({ agents: ["codex"] }), dir = `${f.ws}/Org/p1`;
  const old = `${dir}/.agents/skills/personal/SKILL.md`;
  put(old, "personal"); put(`${dir}/.agents/skills/team/SKILL.md`, "team");
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args]);
  git("add", ".agents/skills/team/SKILL.md");
  const prev = emptyState(); prev.files[pathKey(old)] = sha("personal");
  const cfg = { layers: [], instructions: [], mcp: [], notes: [], skills: [{ layer: "x", item: { name: "personal", dir: "", team: true, files: [{ rel: "SKILL.md", content: "personal", executable: false }] } }] };
  const target = { scope: "project" as const, dir, rel: "p" }, machine = { home: f.home, workspace: f.ws, os: "linux" as const, vars: {} };
  const actions = plan(codex.render(cfg, target, machine), target, machine, prev, false);
  expect(actions.some((a) => a.kind === "delete" && a.abs === pathKey(old))).toBe(true);
  const st = apply(actions, prev).state;
  expect(existsSync(old)).toBe(false);
  expect(readFileSync(`${dir}/.codex/skills/personal/SKILL.md`, "utf8")).toBe("personal");
  put(`${dir}/.codex/skills/team/SKILL.md`, "team"); git("add", ".codex/skills/team/SKILL.md");
  expect(plan(codex.render(cfg, target, machine), target, machine, st, true).some((a) => a.kind === "conflict")).toBe(true);
});

test("2б/2: opencode убирает дубль только после доставки другим адаптером этого запуска", () => {
  const f = cliFixture({ agents: ["opencode", "claude"] }), dir = `${f.ws}/Org/p1`;
  put(`${f.config}/layers/tree/skills/personal/SKILL.md`, "---\nname: personal\ndescription: skill\n---\nbody\n");
  expect(f.run(["sync", dir, "--agent", "opencode"]).code).toBe(0);
  expect(existsSync(`${dir}/.opencode/skills/personal/SKILL.md`)).toBe(true);
  const dry = f.run(["sync", dir, "--dry-run"]);
  expect(dry.out).toContain("удалить");
  expect(existsSync(`${dir}/.opencode/skills/personal/SKILL.md`)).toBe(true);
  expect(f.run(["sync", dir]).code).toBe(0);
  expect(existsSync(`${dir}/.opencode/skills/personal/SKILL.md`)).toBe(false);
  expect(existsSync(`${dir}/.claude/skills/personal/SKILL.md`)).toBe(true);
}, 30000);

test("2б/3: конфликт одной таблицы не блокирует обновление другой, force сохраняет чужие таблицы", () => {
  const f = blockFixture(), path = `${f.home}/.codex/config.toml`;
  const r = (command: string) => ({ warnings: [], files: [{ base: "home" as const, path: ".codex/config.toml", mode: "merge" as const, format: "toml" as const, key: ["mcp_servers"], data: { a: { command }, b: { command } } }] });
  const prev = apply(plan(r("old"), { scope: "global" }, f.machine, emptyState(), false), emptyState()).state;
  put(path, readFileSync(path, "utf8").replace('"command" = "old"', '"command" = "manual"') + '[mcp_servers.user]\ncommand="user"\n');
  const acts = plan(r("new"), { scope: "global" }, f.machine, prev, false);
  expect(acts.filter((a) => a.kind === "conflict")).toHaveLength(1);
  const next = apply(acts, prev).state;
  expect((Bun.TOML.parse(readFileSync(path, "utf8")) as any).mcp_servers).toEqual({ a: { command: "manual" }, b: { command: "new" }, user: { command: "user" } });
  apply(plan(r("forced"), { scope: "global" }, f.machine, next, true), next);
  expect((Bun.TOML.parse(readFileSync(path, "utf8")) as any).mcp_servers.user.command).toBe("user");
});

test("2б/3: один потерянный маркер и многострочные строки с похожими заголовками", () => {
  const f = blockFixture(), path = `${f.home}/.codex/config.toml`;
  const r = { warnings: [], files: [{ base: "home" as const, path: ".codex/config.toml", mode: "merge" as const, format: "toml" as const, key: ["mcp_servers"], data: { a: { command: "bin" } } }] };
  const st = apply(plan(r, { scope: "global" }, f.machine, emptyState(), false), emptyState()).state;
  const prefix = 'description = """\n[mcp_servers.a]\nnot a table\n"""\n';
  put(path, prefix + readFileSync(path, "utf8").replace(TOML_END, ""));
  const acts = plan(r, { scope: "global" }, f.machine, st, false);
  expect(acts.filter((a) => a.kind === "conflict")).toEqual([]);
  apply(acts, st);
  expect(readFileSync(path, "utf8")).toStartWith(prefix);
});

test("2б/3: adopt Codex передаёт исходную таблицу под учёт, sync проходит без force", () => {
  const f = cliFixture({ agents: ["codex"] });
  put(`${f.home}/.codex/config.toml`, '[mcp_servers.source]\ncommand="echo"\n');
  expect(f.run(["adopt", "--global", "source", "--to", "global", "--agent", "codex", "--yes"]).code).toBe(0);
  expect(f.run(["sync", "--global"]).code).toBe(0);
  expect(f.run(["clean", "--global"]).code).toBe(0);
  expect(readFileSync(`${f.home}/.codex/config.toml`, "utf8")).not.toContain("source");
}, 30000);

test("2б/4: одинаковый чужой файл сохраняет оригинал; ротация его не удаляет", () => {
  const f = blockFixture("same");
  const r = { warnings: [], files: [{ base: "home" as const, path: ".claude/CLAUDE.md", mode: "own" as const, content: "same" }] };
  const st = apply(plan(r, { scope: "global" }, f.machine, emptyState(), false), emptyState()).state;
  const original = st.originals![pathKey(f.path)];
  for (let i = 0; i < KEEP_RUNS + 2; i++) { newBackupRun(); backup(f.path); Bun.sleepSync(2); }
  expect(readFileSync(original.path, "utf8")).toBe("same");
  put(f.path, "changed after capture");
  const acts = plan({ warnings: [], files: [] }, { scope: "global" }, f.machine, st, true);
  expect(acts.find((a) => a.kind === "conflict")).toEqual(expect.objectContaining({ why: expect.stringContaining(original.path) }));
  expect(readFileSync(f.path, "utf8")).toBe("changed after capture");
});

test("2б/5: чужое доверие и отказ неизменны; выключатель и командный конфиг блокируют добавление", () => {
  for (const kind of ["trusted", "untrusted", "disabled", "tracked"]) {
    const f = cliFixture({ agents: ["codex"] }), dir = `${f.ws}/Org/p1`;
    const key = process.platform === "win32" ? dir.replaceAll("/", "\\").toLowerCase() : dir;
    const file = `${f.home}/.codex/config.toml`;
    if (["trusted", "untrusted"].includes(kind)) put(file, `[projects.${JSON.stringify(key)}]\ntrust_level = "${kind}"\n`);
    if (kind === "disabled") put(`${f.config}/local/machine.yaml`, `workspace: ${f.ws}\nagents: [codex]\ntrust: {codex: false}\n`);
    if (kind === "tracked") {
      put(`${dir}/.codex/config.toml`, '# team\n');
      Bun.spawnSync(["git", "-C", dir, "add", ".codex/config.toml"]);
    }
    expect(f.run(["sync", dir]).code).toBe(0);
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    expect(text.includes("trusted")).toBe(["trusted", "untrusted"].includes(kind));
    if (kind !== "trusted") expect(f.run(["doctor"]).out).toContain("Проекты без доверия");
    expect(f.run(["clean", dir]).code).toBe(0);
    expect(existsSync(file) ? readFileSync(file, "utf8") : "").toBe(text);
  }
}, 30000);

test("2б/5: trust сохраняет поля проекта без LF, удаляет только своё поле", () => {
  const f = blockFixture(), dir = `${f.ws}/Org/p1`;
  const file = `${f.home}/.codex/config.toml`;
  const key = codexProjectKey(dir, f.machine, []);
  put(file, `[projects.${JSON.stringify(key)}]\nother = "keep"`);
  const target = { scope: "project" as const, dir, rel: "p" };
  const result = { warnings: [], files: [{ base: "project" as const, path: ".codex/config.toml", mode: "own" as const, content: "# own\n" }] };
  const acts = plan(result, target, f.machine, emptyState(), false, "codex");
  const next = apply(acts, emptyState()).state;
  expect((Bun.TOML.parse(readFileSync(file, "utf8")) as any).projects[key]).toEqual({ other: "keep", trust_level: "trusted" });
  const cleaned = apply(plan({ warnings: [], files: [], clean: true }, target, f.machine, next, false, "codex"), next).state;
  expect((Bun.TOML.parse(readFileSync(file, "utf8")) as any).projects[key]).toEqual({ other: "keep" });
  expect(cleaned.trust).toBeUndefined();
});

test("2б/5: удаление последнего Claude MCP не даёт права добавить доверие", () => {
  const f = blockFixture(), dir = `${f.ws}/Org/p1`, file = pathKey(`${f.home}/.claude.json`);
  put(file, JSON.stringify({ projects: { [dir]: { mcpServers: { old: {} } } } }));
  const prev = emptyState(); prev.merges[file] = { [JSON.stringify(["projects", dir, "mcpServers"])]: ["old"] };
  const p = trustPlan({ warnings: [], files: [] }, { scope: "project", dir, rel: "p" }, f.machine, prev, [], "claude");
  expect(p.actions).toEqual([]);
});

test("2б/1: clean блока через симлинк сохраняет ссылку и пустую цель", () => {
  const f = blockFixture("old\n"), linked = `${f.home}/.claude/linked.md`;
  symlinkSync(f.path, linked, "file");
  const result = { warnings: [], files: [{ base: "home" as const, path: ".claude/linked.md", mode: "own" as const, block: true, content: "rules\n" }] };
  const prev = emptyState(); prev.files[pathKey(f.path)] = sha("old\n");
  const next = apply(plan(result, { scope: "global" }, f.machine, prev, false), prev).state;
  apply(plan({ warnings: [], files: [] }, { scope: "global" }, f.machine, next, false), next);
  expect(lstatSync(linked).isSymbolicLink()).toBe(true);
  expect(readFileSync(linked, "utf8")).toBe("");
});

test("2б/4: force-миграция правленого legacy-файла оставляет оригинал для clean", () => {
  const f = blockFixture("чужая дописанная память\n");
  const prev = emptyState(); prev.files[pathKey(f.path)] = sha("old miksy\n");
  const st = apply(f.make("rules\n", prev, true), prev).state;
  expect(st.originals?.[pathKey(f.path)].restoreBlock).toBe(true);
  apply(plan({ warnings: [], files: [] }, { scope: "global" }, f.machine, st, false), st);
  expect(readFileSync(f.path, "utf8")).toBe("чужая дописанная память\n");
});
