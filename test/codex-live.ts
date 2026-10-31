// Ручная проверка установленного CLI без обращения к модели и без личного профиля:
// bun test/codex-live.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { codex } from "../adapters/codex";
import type { Machine, Resolved } from "../src/types";
import { replaceTomlBlock, splitToml, tomlValue } from "../src/toml";

const out = resolve(import.meta.dir, "../out");
mkdirSync(out, { recursive: true });
const root = mkdtempSync(join(out, "codex-live-"));
const home = join(root, "home");
const project = join(root, "project");
const machine: Machine = { home, workspace: root, os: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux", vars: {} };
const run = (args: string[]) => {
  const result = Bun.spawnSync(args, { cwd: project,
    env: { ...process.env, CODEX_HOME: join(home, ".codex"), HOME: home, USERPROFILE: home },
    stdout: "pipe", stderr: "pipe", timeout: 30000 });
  if (result.exitCode !== 0) throw new Error(`${args.slice(0, 3).join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString();
};
try {
  for (const dir of [home, project, join(root, "skill")]) mkdirSync(dir, { recursive: true });
  run(["git", "init", "--quiet", project]);
  writeFileSync(join(root, "global.md"), "Global marker: MIKSY_GLOBAL_2718\n");
  writeFileSync(join(root, "project.md"), "Project marker: MIKSY_DEVELOPER_1414\n");
  writeFileSync(join(project, "AGENTS.md"), "Team marker: MIKSY_TEAM_3141\n");
  writeFileSync(join(root, "skill/SKILL.md"), "---\nname: miksy-smoke\ndescription: MIKSY_SKILL_1618 smoke test\n---\nTest skill.\n");
  const cfg: Resolved = { layers: ["smoke"], instructions: [{ item: { file: "global.md", path: join(root, "global.md") }, layer: "smoke" }], skills: [], mcp: [], notes: [] };
  const global = codex.render(cfg, { scope: "global" }, machine);
  const local = codex.render({ ...cfg,
    instructions: [{ item: { file: "project.md", path: join(root, "project.md") }, layer: "smoke" }],
    mcp: [{ item: { name: "miksy_smoke", command: "miksy-smoke-not-executed", env: { MIKSY_SMOKE: "literal-value" } }, layer: "smoke" }],
    skills: [{ item: { name: "miksy-smoke", dir: join(root, "skill") }, layer: "smoke" }] }, { scope: "project", dir: project, rel: "project" }, machine);
  for (const f of [...global.files, ...local.files]) {
    if (f.mode !== "own") throw new Error("Smoke fixture expects owned files");
    const path = join(f.base === "home" ? home : project, f.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, f.content);
  }
  const prompt = run(["codex", "--no-daemon", "debug", "prompt-input", "smoke"]);
  JSON.parse(prompt);
  for (const marker of ["MIKSY_GLOBAL_2718", "MIKSY_TEAM_3141", "MIKSY_SKILL_1618"])
    if (!prompt.includes(marker)) throw new Error(`Codex did not load ${marker}`);
  if (readFileSync(join(project, "AGENTS.md"), "utf8") !== "Team marker: MIKSY_TEAM_3141\n") throw new Error("Team instructions changed");
  console.log(`${run(["codex", "--version"]).trim()}: generated global instructions and project skill loaded; team AGENTS.md preserved.`);
  const ancestor = process.platform === "win32" && project.toLowerCase().startsWith("d:\\ai\\") ? "d:\\ai" : out;
  for (const [label, trustPath, level] of [["none", "", ""], ["ancestor", ancestor, "trusted"],
    ["ancestor-normalized", resolve(ancestor).replaceAll("\\", "/"), "trusted"],
    ["ancestor-drive-case", process.platform === "win32" ? ancestor[0].toUpperCase() + ancestor.slice(1) : ancestor, "trusted"],
    ["exact", project, "trusted"], ["untrusted", project, "untrusted"]]) {
    const prefix = trustPath ? `[projects.${tomlValue(trustPath)}]\ntrust_level=${tomlValue(level)}\n` : "";
    writeFileSync(join(home, ".codex/config.toml"), replaceTomlBlock(splitToml(prefix), {
      miksy_global: { command: "global-smoke-not-executed", env: { LITERAL_VALUE: "тест" } },
      miksy_http: { url: "http://127.0.0.1:1/mcp", http_headers: { "X-Miksy-Test": "literal-value" } },
    }));
    const p = run(["codex", "--no-daemon", "debug", "prompt-input", "smoke"]);
    const mcp = JSON.parse(run(["codex", "mcp", "list", "--json"]));
    for (const name of ["miksy_global", "miksy_http"])
      if (!mcp.some((entry: any) => entry.name === name)) throw new Error(`Managed global MCP missing: ${name}`);
    const hasMcp = mcp.some((entry: any) => entry.name === "miksy_smoke");
    const hasInstructions = p.includes("MIKSY_DEVELOPER_1414");
    console.log(JSON.stringify({ trust: label, trustPath, developer_instructions: hasInstructions, mcp: hasMcp }));
    if (label === "exact" && (!hasInstructions || !hasMcp)) throw new Error("Trusted project config was not loaded");
    if (label === "untrusted" && (hasInstructions || hasMcp)) throw new Error("Untrusted project config was loaded");
    if (label.startsWith("ancestor") && (hasInstructions || hasMcp)) throw new Error("Codex trust inheritance changed; update currentProject and CAPABILITIES");
  }
} finally {
  if (dirname(root) !== out) throw new Error("Unsafe cleanup path");
  rmSync(root, { recursive: true, force: true });
}

// Фазы 2а/2б: sync → codex mcp add → sync без конфликта; автоматическое доверие и MCP проекта.
await (await import("./live/r1")).main("codex");
