// Файлы проекта и git (фаза 1.6: С2, С3, С7, С8, С22)
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { apply, plan } from "../src/apply";
import { emptyState, loadManifest } from "../src/manifest";
import { ADAPTERS, renderFor } from "../src/registry";
import { cliFixture, put } from "./helpers";

const dirLink = process.platform === "win32" ? "junction" : "dir";
const none = { layers: [], instructions: [], skills: [], notes: [], mcp: [] };

function fixture() {
  const f = cliFixture();
  const dir = `${f.ws}/Org/p1`;
  const machine = { workspace: f.ws, home: f.home, os: "linux" as const, vars: {} };
  const target = { scope: "project" as const, dir, rel: "Org/p1" };
  const own = (...paths: string[]) => ({ warnings: [], files: paths.map((path) => ({ base: "project" as const, path, mode: "own" as const, content: "# personal\n" })) });
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  return { ...f, dir, machine, target, own, git };
}

test("С2: сервер с секретом не сливается в чужой неотслеживаемый opencode.json git-проекта", () => {
  const f = fixture();
  put(`${f.dir}/opencode.json`, '{"model": "x/y"}\n');
  const cfg = { ...none, mcp: [
    { layer: "x", item: { name: "s", command: "echo", env: { TOKEN: "${TOKEN}" } } },
    { layer: "x", item: { name: "plain", command: "echo" } },
  ] };
  const { result } = renderFor(ADAPTERS.opencode, { cfg, target: f.target, title: "t" }, f.machine, { TOKEN: "opaque-secret-123" });
  const actions = plan(result, f.target, f.machine, emptyState(), false, "opencode");
  const merge = actions.find((a) => a.kind === "merge");
  expect(merge?.kind === "merge" && Object.keys(merge.set)).toEqual(["plain"]);
  expect(actions.some((a) => a.kind === "conflict" && a.abs.endsWith(".s") && a.why.includes("секрет"))).toBe(true);
  apply(actions, emptyState());
  const text = readFileSync(`${f.dir}/opencode.json`, "utf8");
  expect(text).not.toContain("opaque-secret-123");
  expect(text).toContain("plain");
});

test("С3: файл вложенного git-репо внутри цели — конфликт даже force", () => {
  const f = fixture();
  const inner = `${f.dir}/.agents/skills/shared`;
  put(`${inner}/SKILL.md`, "team content\n");
  Bun.spawnSync(["git", "init", "--quiet", inner]);
  Bun.spawnSync(["git", "-C", inner, "add", "SKILL.md"]);
  const actions = plan(f.own(".agents/skills/shared/SKILL.md"), f.target, f.machine, emptyState(), true, "codex");
  expect(actions.some((a) => a.kind === "conflict" && a.why.includes("вложенного"))).toBe(true);
  expect(actions.some((a) => a.kind === "write")).toBe(false);
  apply(actions, emptyState());
  expect(readFileSync(`${inner}/SKILL.md`, "utf8")).toBe("team content\n");
});

test("С7: своя ссылка .codex → physical — exclude от физического пути", () => {
  const f = fixture();
  mkdirSync(`${f.dir}/physical`);
  symlinkSync(`${f.dir}/physical`, `${f.dir}/.codex`, dirLink);
  const actions = plan(f.own(".codex/config.toml"), f.target, f.machine, emptyState(), false, "codex");
  apply(actions, emptyState());
  expect(existsSync(`${f.dir}/physical/config.toml`)).toBe(true);
  expect(f.git("status", "--porcelain", "--untracked-files=all").stdout.toString()).not.toContain("physical/config.toml");
});

test("С7: второй владелец одного канонического файла — конфликт; clean другой цели его не удаляет", () => {
  const f = cliFixture({ agents: ["claude", "codex"] });
  const dir = `${f.ws}/Org/p1`;
  put(`${f.config}/layers/tree/skills/my-mine/SKILL.md`, "---\nname: my-mine\ndescription: x\n---\nmine\n");
  mkdirSync(`${dir}/.agents/skills`, { recursive: true });
  mkdirSync(`${dir}/.claude`);
  symlinkSync(`${dir}/.agents/skills`, `${dir}/.claude/skills`, dirLink);
  const r = f.run(["sync", dir]);
  expect(r.code).toBe(3);
  expect(r.out).toContain("уже принадлежит цели");
  const owners = Object.entries(loadManifest(`${f.config}/local/state/manifest.json`).targets)
    .filter(([, st]) => Object.keys(st.files).some((p) => p.endsWith("/.agents/skills/my-mine/SKILL.md")));
  expect(owners.map(([id]) => id.split("|")[0])).toEqual(["claude"]);
  f.run(["clean", dir, "--agent", "codex"]);
  expect(existsSync(`${dir}/.agents/skills/my-mine/SKILL.md`)).toBe(true);
  expect(Bun.spawnSync(["git", "-C", dir, "status", "--porcelain", "--untracked-files=all"]).stdout.toString()).not.toContain(".agents/skills/my-mine");
}, 60000);

test("С7: файл, которым по старому учёту владеют две цели, clean одной снимает с учёта без удаления", () => {
  const f = fixture();
  const result = f.own(".agents/skills/my-mine/SKILL.md");
  const state = apply(plan(result, f.target, f.machine, emptyState(), false, "claude"), emptyState()).state;
  const key = Object.keys(state.files)[0];
  const owners = new Map([[key, "claude|x"]]);
  const actions = plan({ files: [], warnings: [] }, f.target, f.machine, state, false, "codex", owners);
  expect(actions.map((a) => a.kind)).toContain("release");
  expect(actions.some((a) => a.kind === "delete")).toBe(false);
  const after = apply(actions, state).state;
  expect(existsSync(key)).toBe(true);
  expect(after.files).toEqual({});
});

test("С8: exclude каталогом не скрывает чужой конфликтный файл", () => {
  const f = fixture();
  put(`${f.dir}/rule.md`, "layer rule\n");
  put(`${f.dir}/.agents/plugins/miksy/rules/AGENTS.md`, "чужие заметки\n");
  const cfg = { ...none, instructions: [{ layer: "x", item: { file: "rule.md", path: `${f.dir}/rule.md` } }] };
  const { result } = renderFor(ADAPTERS.gemini, { cfg, target: f.target, title: "t" }, f.machine, {});
  const actions = plan(result, f.target, f.machine, emptyState(), false, "gemini");
  expect(actions.some((a) => a.kind === "conflict" && a.abs.endsWith("rules/AGENTS.md"))).toBe(true);
  apply(actions, emptyState());
  expect(f.git("check-ignore", "-q", ".agents/plugins/miksy/plugin.json").exitCode).toBe(0);
  expect(f.git("check-ignore", "-q", ".agents/plugins/miksy/rules/AGENTS.md").exitCode).toBe(1);
});

test("С22: личный skill не кладётся в каталог skills, который версионирует команда", () => {
  const f = fixture();
  put(`${f.dir}/.agents/skills/team/SKILL.md`, "team\n");
  f.git("add", ".agents/skills/team/SKILL.md");
  const actions = plan(f.own(".agents/skills/mine/SKILL.md"), f.target, f.machine, emptyState(), true, "codex");
  expect(actions.some((a) => a.kind === "conflict" && a.why.includes("команд"))).toBe(true);
  expect(actions.some((a) => a.kind === "write" || a.kind === "exclude")).toBe(false);
});

test("С22: то же через свою ссылку .claude/skills → командный .agents/skills", () => {
  const f = fixture();
  put(`${f.dir}/.agents/skills/team/SKILL.md`, "team\n");
  f.git("add", ".agents/skills/team/SKILL.md");
  mkdirSync(`${f.dir}/.claude`);
  symlinkSync(`${f.dir}/.agents/skills`, `${f.dir}/.claude/skills`, dirLink);
  const actions = plan(f.own(".claude/skills/mine/SKILL.md"), f.target, f.machine, emptyState(), true, "claude");
  expect(actions.some((a) => a.kind === "write")).toBe(false);
  expect(actions.some((a) => a.kind === "conflict")).toBe(true);
});
