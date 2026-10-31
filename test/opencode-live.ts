// Ручная проверка установленного opencode на том, что генерирует адаптер (не входит в bun test).
// Изолированные HOME и XDG_* во временном каталоге вне git-репо; личный профиль не читается и не меняется.
//   bun test/opencode-live.ts [модель]   (по умолчанию бесплатная opencode/big-pickle, без входа)
// MCP — `opencode mcp list` (подключается к серверам, без модели); skills — `opencode debug skill`;
// правила — один запрос к модели с маркерами.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { opencode } from "../adapters/opencode";
import type { Machine, Resolved } from "../src/types";

const model = process.argv[2] ?? "opencode/big-pickle";
const root = realpathSync(mkdtempSync(join(tmpdir(), "opencode-live-")));
const home = join(root, "home");
const project = join(root, "project");
const stub = join(root, "stub.mjs");
const machine: Machine = { home, workspace: root, os: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux", vars: {} };
const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: home, USERPROFILE: home, PWD: project,
  XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(root, "xdg/data"), XDG_STATE_HOME: join(root, "xdg/state"), XDG_CACHE_HOME: join(root, "xdg/cache") };
const run = (args: string[], timeout = 240000) => {
  const r = Bun.spawnSync(args, { cwd: project, env, stdout: "pipe", stderr: "pipe", timeout, stdin: "ignore" });
  return { code: r.exitCode, out: (r.stdout.toString() + r.stderr.toString()).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "") };
};
const setPath = (obj: any, key: string[], data: unknown) => {
  let o = obj;
  for (const k of key.slice(0, -1)) o = o[k] ??= {};
  o[key.at(-1)!] = { ...(o[key.at(-1)!] ?? {}), ...(data as object) };
};
const STUB = `let b="";process.stdin.on("data",c=>{b+=c;let i;while((i=b.indexOf("\\n"))>=0){const l=b.slice(0,i);b=b.slice(i+1);let m;try{m=JSON.parse(l)}catch{continue}
if(m.id===undefined)continue;const r=m.method==="initialize"?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:"s",version:"1"}}
:m.method==="tools/list"?{tools:[{name:"live",description:"live",inputSchema:{type:"object",properties:{}}}]}:{};
process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:r})+"\\n")}});`;
try {
  for (const dir of [home, project, join(root, "gskill"), join(root, "pskill"), join(root, "xdg/data"), join(root, "xdg/state"), join(root, "xdg/cache")]) mkdirSync(dir, { recursive: true });
  Bun.spawnSync(["git", "init", "--quiet", project]);
  writeFileSync(stub, STUB);
  writeFileSync(join(root, "global.md"), "Global marker: MIKSY_OC_GLOBAL_2718\n");
  writeFileSync(join(root, "project.md"), "Project marker: MIKSY_OC_PROJECT_1414\n");
  writeFileSync(join(project, "AGENTS.md"), "Team marker: MIKSY_OC_TEAM_3141\n");
  writeFileSync(join(root, "gskill/SKILL.md"), "---\nname: miksy-gskill\ndescription: global smoke skill\n---\nTest.\n");
  writeFileSync(join(root, "pskill/SKILL.md"), "---\nname: miksy-pskill\ndescription: project smoke skill\n---\nTest.\n");
  const bun = process.execPath;
  const base: Resolved = { layers: ["smoke"], instructions: [], skills: [], mcp: [], notes: [] };
  const ctx = { ownedFiles: new Set<string>() } as any;
  const global = opencode.render({ ...base,
    instructions: [{ item: { file: "global.md", path: join(root, "global.md") }, layer: "smoke" }],
    skills: [{ item: { name: "miksy-gskill", dir: join(root, "gskill") }, layer: "smoke" }],
    mcp: [{ item: { name: "miksy_global", command: bun, args: [stub] }, layer: "smoke" }] }, { scope: "global" }, machine, ctx);
  const local = opencode.render({ ...base,
    instructions: [{ item: { file: "project.md", path: join(root, "project.md") }, layer: "smoke" }],
    skills: [{ item: { name: "miksy-pskill", dir: join(root, "pskill") }, layer: "smoke" }],
    mcp: [{ item: { name: "miksy_local", command: bun, args: [stub] }, layer: "smoke" }] },
    { scope: "project", dir: project, rel: "project" }, machine, ctx);
  const json: Record<string, any> = {};
  for (const f of [...global.files, ...local.files]) {
    const path = join(f.base === "home" ? home : project, f.path);
    mkdirSync(dirname(path), { recursive: true });
    if (f.mode === "own") writeFileSync(path, f.content);
    else if (f.mode === "merge") setPath(json[path] ??= existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}, f.key, f.data);
  }
  for (const [path, data] of Object.entries(json)) writeFileSync(path, JSON.stringify(data, null, 2));

  const version = run(["opencode", "--version"]).out.trim();
  // opencode 2.x: первый `mcp list` после старта фонового сервиса бывает пустым, серверы
  // подключаются лениво («pending») — повтор
  let mcp = "";
  for (let i = 0; i < 6 && (!mcp.includes("miksy_global") || /pending/.test(mcp)); i++) {
    if (i) Bun.sleepSync(3000);
    mcp = run(["opencode", "mcp", "list"]).out;
  }
  // `debug skill` в 2.x нет — список skills спрашиваем у модели
  let skills = run(["opencode", "debug", "skill"]).out;
  if (/Unknown subcommand/.test(skills))
    skills = run(["opencode", "run", "-m", model, "List the names of all skills available to you, one per line. Do not use tools."]).out;
  const connected = (n: string) => mcp.split("\n").some((l) => l.includes(n) && /connected/.test(l) && !/fail/.test(l));
  const checks: Record<string, boolean> = {
    "mcp global (~/.config/opencode/opencode.json)": connected("miksy_global"),
    "mcp project (opencode.json)": connected("miksy_local"),
    "skill global (~/.config/opencode/skills)": skills.includes("miksy-gskill"),
    "skill project (.opencode/skills)": skills.includes("miksy-pskill"),
  };
  const r = run(["opencode", "run", "-m", model, "Your instructions contain a Global marker, a Project marker and a Team marker. Reply with the three marker values, one per line. Do not use tools."]);
  for (const [k, m] of [["rules global (~/.config/opencode/AGENTS.md)", "MIKSY_OC_GLOBAL_2718"],
    ["rules project (.opencode/miksy.md via instructions)", "MIKSY_OC_PROJECT_1414"], ["team AGENTS.md", "MIKSY_OC_TEAM_3141"]]) checks[k] = r.out.includes(m);
  checks["team AGENTS.md preserved"] = readFileSync(join(project, "AGENTS.md"), "utf8") === "Team marker: MIKSY_OC_TEAM_3141\n";
  console.log(`opencode ${version} (${process.platform}), model ${model}`);
  for (const [k, ok] of Object.entries(checks)) console.log(`${ok ? "✅" : "❌"} ${k}`);
  if (Object.values(checks).some((ok) => !ok)) { console.log(mcp.slice(-800), skills.slice(-800), r.out.slice(-800)); process.exitCode = 1; }
} finally {
  // opencode 2.x держит фоновый сервис (свой у песочницы: XDG песочницы) — остановить, иначе он
  // переживёт проверку вместе с серверами MCP
  run(["opencode", "service", "stop"], 60000);
  if (!root.startsWith(realpathSync(tmpdir())) || !root.includes("opencode-live-")) throw new Error("Unsafe cleanup path");
  if (process.env.KEEP) console.log("kept", root); else rmSync(root, { recursive: true, force: true });
}

// Фаза 2а: обёртки секретов, helper/{file:}/мост — настоящим miksy sync в песочнице (test/live/r1.ts)
if (!process.env.NO_R1) await (await import("./live/r1")).main("opencode");
