// Ручная проверка установленного Claude Code на том, что генерирует адаптер (не входит в bun test).
// Изолированный HOME во временном каталоге вне git-репо; личный профиль не читается и не меняется.
//   bun test/claude-live.ts
// Без входа проверяются MCP (статус и инструменты) и skills по init-событию stream-json —
// оно печатается до обращения к модели. Правила требуют модели: если задан CLAUDE_CODE_OAUTH_TOKEN
// (например, из `claude setup-token`), делается один запрос самой дешёвой моделью (haiku).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { claude } from "../adapters/claude";
import type { Machine, Resolved } from "../src/types";

const root = realpathSync(mkdtempSync(join(tmpdir(), "claude-live-")));
const home = join(root, "home");
const project = join(root, "project");
const stub = join(root, "stub.mjs");
const machine: Machine = { home, workspace: root, os: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux", vars: {} };
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: home, USERPROFILE: home };
delete env.CLAUDE_CONFIG_DIR;
delete env.ANTHROPIC_API_KEY;
const run = (args: string[], timeout = 180000) => {
  const r = Bun.spawnSync(args, { cwd: project, env, stdout: "pipe", stderr: "pipe", timeout, stdin: "ignore" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
const setPath = (obj: any, key: string[], data: unknown) => {
  let o = obj;
  for (const k of key.slice(0, -1)) o = o[k] ??= {};
  o[key.at(-1)!] = { ...(o[key.at(-1)!] ?? {}), ...(data as object) };
};
// Минимальный stdio MCP: initialize + tools/list
const STUB = `let b="";process.stdin.on("data",c=>{b+=c;let i;while((i=b.indexOf("\\n"))>=0){const l=b.slice(0,i);b=b.slice(i+1);let m;try{m=JSON.parse(l)}catch{continue}
if(m.id===undefined)continue;const r=m.method==="initialize"?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:"s",version:"1"}}
:m.method==="tools/list"?{tools:[{name:process.argv[2],description:"live",inputSchema:{type:"object",properties:{}}}]}:{};
process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:r})+"\\n")}});`;
try {
  for (const dir of [home, project, join(root, "gskill"), join(root, "pskill")]) mkdirSync(dir, { recursive: true });
  Bun.spawnSync(["git", "init", "--quiet", project]);
  writeFileSync(stub, STUB);
  writeFileSync(join(root, "global.md"), "Global marker: MIKSY_CLAUDE_GLOBAL_2718\n");
  writeFileSync(join(root, "project.md"), "Project marker: MIKSY_CLAUDE_LOCAL_1414\n");
  writeFileSync(join(project, "CLAUDE.md"), "Team marker: MIKSY_CLAUDE_TEAM_3141\n");
  writeFileSync(join(root, "gskill/SKILL.md"), "---\nname: miksy-gskill\ndescription: global smoke skill\n---\nTest.\n");
  writeFileSync(join(root, "pskill/SKILL.md"), "---\nname: miksy-pskill\ndescription: project smoke skill\n---\nTest.\n");
  const bun = process.execPath;
  const base: Resolved = { layers: ["smoke"], instructions: [], skills: [], mcp: [], notes: [] };
  const global = claude.render({ ...base,
    instructions: [{ item: { file: "global.md", path: join(root, "global.md") }, layer: "smoke" }],
    skills: [{ item: { name: "miksy-gskill", dir: join(root, "gskill") }, layer: "smoke" }],
    mcp: [{ item: { name: "miksy_global", command: bun, args: [stub, "global_tool"] }, layer: "smoke" }] }, { scope: "global" }, machine);
  const local = claude.render({ ...base,
    instructions: [{ item: { file: "project.md", path: join(root, "project.md") }, layer: "smoke" }],
    skills: [{ item: { name: "miksy-pskill", dir: join(root, "pskill") }, layer: "smoke" }],
    mcp: [{ item: { name: "miksy_local", command: bun, args: [stub, "local_tool"] }, layer: "smoke" }] },
    { scope: "project", dir: project, rel: "project" }, machine);
  const json: Record<string, any> = {};
  for (const f of [...global.files, ...local.files]) {
    const path = join(f.base === "home" ? home : project, f.path);
    mkdirSync(dirname(path), { recursive: true });
    if (f.mode === "own") writeFileSync(path, f.content);
    else if (f.mode === "merge") setPath(json[path] ??= existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}, f.key, f.data);
  }
  for (const [path, data] of Object.entries(json)) writeFileSync(path, JSON.stringify(data, null, 2));

  const version = run(["claude", "--version"]).out.trim();
  const r = run(["claude", "-p", "Quote every line that contains the word 'marker' from your instructions, verbatim. Nothing else.",
    "--model", "haiku", "--output-format", "stream-json", "--verbose", "--max-turns", "1"]);
  const events = r.out.split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  const init = events.find((e) => e.type === "system" && e.subtype === "init");
  if (!init) throw new Error(`no init event: ${r.err.slice(0, 500)}`);
  const status = Object.fromEntries((init.mcp_servers ?? []).map((s: any) => [s.name, s.status]));
  const checks: Record<string, boolean> = {
    "mcp global (user scope)": status.miksy_global === "connected" && init.tools.includes("mcp__miksy_global__global_tool"),
    "mcp project (local scope)": status.miksy_local === "connected" && init.tools.includes("mcp__miksy_local__local_tool"),
    "skill global": init.skills.includes("miksy-gskill"),
    "skill project": init.skills.includes("miksy-pskill"),
  };
  const result = events.find((e) => e.type === "result");
  const text = String(result?.result ?? "");
  if (token) for (const [k, m] of [["rules global (~/.claude/CLAUDE.md)", "MIKSY_CLAUDE_GLOBAL_2718"],
    ["rules project (CLAUDE.local.md)", "MIKSY_CLAUDE_LOCAL_1414"], ["team CLAUDE.md", "MIKSY_CLAUDE_TEAM_3141"]]) checks[k] = text.includes(m);
  if (readFileSync(join(project, "CLAUDE.md"), "utf8") !== "Team marker: MIKSY_CLAUDE_TEAM_3141\n") checks["team CLAUDE.md preserved"] = false;
  console.log(`${version} (${process.platform})`);
  for (const [k, ok] of Object.entries(checks)) console.log(`${ok ? "✅" : "❌"} ${k}`);
  if (!token) console.log("❓ rules: CLAUDE_CODE_OAUTH_TOKEN не задан — правила без модели не проверить");
  else console.log(`   model: ${init.model}, cost $${result?.total_cost_usd ?? "?"}`);
  console.log(JSON.stringify({ mcp: status }));
  if (Object.values(checks).some((ok) => !ok)) process.exitCode = 1;
} finally {
  if (!root.startsWith(realpathSync(tmpdir())) || !root.includes("claude-live-")) throw new Error("Unsafe cleanup path");
  rmSync(root, { recursive: true, force: true });
}

// Фаза 2а: обёртки секретов, helper/{file:}/мост — настоящим miksy sync в песочнице (test/live/r1.ts)
await (await import("./live/r1")).main("claude");
