// Ручная проверка (не входит в bun test, круг 12a): открытые интерактивные сессии Claude и запись miksy в
// ~/.claude.json. Песочница во временном каталоге (свои HOME/USERPROFILE/APPDATA/XDG); вход не нужен и не
// используется: ненастоящий ключ и заглушка API на 127.0.0.1 (stub-api.ts), лишний трафик Claude выключен.
// Сессия — в терминале bun (Bun.Terminal), miksy — CLI этого дерева. Песочница удаляется (KEEP=1 — оставить).
//   bun test/live/open-session.ts [путь к claude]          ONLY=S1,S3 — только эти сценарии
// Печатает по шагам: глобальные серверы, по проектам — серверы/доверие/число ключей.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
const MIKSY = join(import.meta.dir, "../..");
const CLAUDE = process.argv[2] ?? "claude";
const ONLY = process.env.ONLY ?? "";
const CLI = join(MIKSY, "src/cli.ts");
const root = realpathSync.native(mkdtempSync(join(tmpdir(), "r12a-"))).replaceAll("\\", "/");
const config = `${root}/config`, home = `${root}/home`, ws = `${root}/ws`;
const put = (p: string, t: string) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, t); };
const release = `${root}/release`, apilog = `${root}/api.log`;
const port = 47000 + Math.floor(Math.random() * 1000);
put(`${config}/map.yaml`, "global:\n  - { use: global }\nlayers: []\n");
put(`${config}/layers/global/instructions/00.md`, "# global\n");
put(`${config}/layers/global/layer.yaml`, "exclude: [skill.miksy]\n");
put(`${config}/layers/tree/instructions/00.md`, "# workspace\n");
put(`${config}/local/machine.yaml`, `workspace: ${ws}\nagents: [claude]\n`);
put(`${config}/layers/global/mcp/g1.yaml`, "name: g1\ncommand: g1-server\n");
put(`${config}/layers/tree/mcp/t1.yaml`, "name: t1\ncommand: t1-server\n");
for (const p of ["Org/p1", "Org/p2", "Org/p3"]) { mkdirSync(`${ws}/${p}`, { recursive: true }); Bun.spawnSync(["git", "init", "-q", `${ws}/${p}`]); }
mkdirSync(home, { recursive: true });
const KEY = "sk-ant-api03-FAKE-12a-sandbox-not-a-key";
const sbxEnv: Record<string, string> = { ...(process.env as any), HOME: home, USERPROFILE: home, APPDATA: `${home}/AppData/Roaming`, LOCALAPPDATA: `${home}/AppData/Local`,
  XDG_CONFIG_HOME: `${home}/.config`, XDG_DATA_HOME: `${home}/.local/share`, XDG_CACHE_HOME: `${home}/.cache`, XDG_STATE_HOME: `${home}/.local/state` };
for (const k of Object.keys(sbxEnv)) if (k.startsWith("CLAUDE") || k.startsWith("ANTHROPIC_")) delete sbxEnv[k];
const claudeEnv = { ...sbxEnv, ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1" };
const cj = `${home}/.claude.json`;
put(cj, JSON.stringify({ hasCompletedOnboarding: true, theme: "dark", customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [] } }, null, 2));
const miksy = (...args: string[]) => {
  const r = Bun.spawnSync([process.execPath, CLI, ...args], { cwd: root, env: { ...sbxEnv, MIKSY_CONFIG: config }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const o = (r.stdout.toString() + r.stderr.toString()).trim().split("\n").filter((l) => !l.includes("Бэкапы")).slice(-2).join(" | ");
  console.log(`  miksy ${args.join(" ")} → ${r.exitCode}: ${o.slice(0, 220)}`);
};
const state = (label: string) => {
  const j = JSON.parse(readFileSync(cj, "utf8"));
  const projects = Object.fromEntries(Object.entries(j.projects ?? {}).map(([k, v]: any) => [k.replace(/^.*[\\/]ws[\\/]/, "~"), `${Object.keys(v.mcpServers ?? {}).join("+") || "-"}/${v.hasTrustDialogAccepted ? "T" : "-"}/${Object.keys(v).length}`]));
  console.log(`  [${label}] global: ${Object.keys(j.mcpServers ?? {}).join("+") || "-"}; numStartups=${j.numStartups ?? "-"}; projects(mcp/trust/keys): ${JSON.stringify(projects)}`);
};
const api = Bun.spawn([process.execPath, `${import.meta.dir}/stub-api.ts`, String(port), release, apilog], { stdout: "pipe", stderr: "inherit" });
await Bun.sleep(800);
type S = { p: any; screen: () => string; send: (s: string) => void; name: string };
const plain = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, " ").replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\s+/g, " ");
const waitFor = async (s: S, rx: RegExp, ms = 30000) => {
  for (let t = 0; t < ms; t += 250) { if (rx.test(s.screen())) return true; await Bun.sleep(250); }
  console.log(`  !! ${s.name}: не дождался ${rx}: …${s.screen().slice(-400)}`); return false;
};
const open = async (proj: string): Promise<S> => {
  let buf = "";
  const p = Bun.spawn([CLAUDE], { cwd: `${ws}/${proj}`, env: claudeEnv, terminal: { cols: 140, rows: 45, data(_t: any, d: any) { buf += typeof d === "string" ? d : new TextDecoder().decode(d); } } } as any);
  const s: S = { p, name: proj, screen: () => plain(buf), send: (x) => p.terminal.write(x) };
  await Bun.sleep(4000);
  if (/trust/i.test(s.screen()) && /Yes,/i.test(s.screen())) { console.log(`  ${proj}: вопрос о доверии → да`); s.send("\x1b[B"); await Bun.sleep(400); s.send("\r"); await Bun.sleep(2000); }
  await waitFor(s, /for shortcuts|shift\+tab|for agents/i, 20000);
  return s;
};
const posts = () => existsSync(apilog) ? readFileSync(apilog, "utf8").split("\n").filter((l) => l.includes("POST /v1/messages")).length : 0;
const ask = async (s: S) => { const n = posts(); s.send("hi"); await Bun.sleep(400); s.send("\r"); for (let i = 0; i < 60 && posts() <= n; i++) await Bun.sleep(250); if (posts() <= n) console.log(`  !! ${s.name}: запрос не ушёл: …${s.screen().slice(-300)}`); };
const answer = async () => { writeFileSync(release, ""); await Bun.sleep(3000); unlinkSync(release); };
const exit = async (s: S) => {
  s.send("\x03"); await Bun.sleep(600); s.send("\x03");
  const c = await Promise.race([s.p.exited, Bun.sleep(15000).then(() => "timeout")]);
  if (c === "timeout") { s.p.kill(); console.log(`  !! ${s.name}: не вышел, убит`); }
  await Bun.sleep(500);
};
const run = (k: string) => !ONLY || ONLY.split(",").includes(k);
try {
  console.log(`claude ${Bun.spawnSync([CLAUDE, "--version"], { env: claudeEnv }).stdout.toString().trim()}`);
  if (run("S0")) { console.log("S0: первый интерактивный запуск без miksy (p1, доверие руками), вопрос, выход");
    const s = await open("Org/p1"); state("сессия открыта"); await ask(s); await answer(); state("после ответа"); await exit(s); state("после выхода"); }

  if (run("S1")) { console.log("S1: sync при открытой сессии в p1: добавление глобально и проекту, доверие p2/p3");
    const s = await open("Org/p1");
    miksy("sync", "--global"); miksy("sync", "--all", "--yes"); state("после sync");
    await Bun.sleep(2500); await ask(s); await answer(); state("после вопроса-ответа"); await exit(s); state("после выхода"); }

  if (run("S2")) { console.log("S2: при открытой сессии в p1 — mcp off t1, g1 убран из слоя");
    const s = await open("Org/p1"); await ask(s); await answer();
    miksy("mcp", "off", "t1"); rmSync(`${config}/layers/global/mcp/g1.yaml`); miksy("sync", "--global"); miksy("sync", "--all", "--yes"); state("после sync");
    await Bun.sleep(2500); await ask(s); await answer(); state("после вопроса-ответа"); await exit(s); state("после выхода"); }

  if (run("S3")) { console.log("S3: две сессии (p1, p2) — добавление t2 и g2");
    put(`${config}/layers/tree/mcp/t2.yaml`, "name: t2\ncommand: t2-server\n"); put(`${config}/layers/global/mcp/g2.yaml`, "name: g2\ncommand: g2-server\n");
    const a = await open("Org/p1"), b = await open("Org/p2");
    miksy("sync", "--global"); miksy("sync", "--all", "--yes"); state("после sync");
    await Bun.sleep(2500); await ask(a); await ask(b); await answer(); state("после ответов"); await exit(a); await exit(b); state("после выхода обеих"); }

  if (run("S4")) { console.log("S4: clean при открытой сессии в p2 (с вопросом до и после)");
    const s = await open("Org/p2"); await ask(s); await answer();
    miksy("clean", "--global"); miksy("clean", "--all"); state("после clean");
    await Bun.sleep(2500); await ask(s); await answer(); state("после вопроса-ответа"); await exit(s); state("после выхода"); }

  if (run("S5")) { console.log("S5: sync сразу перед выходом (без паузы на слежение)");
    put(`${config}/layers/global/mcp/g3.yaml`, "name: g3\ncommand: g3-server\n");
    const s = await open("Org/p3"); await ask(s); await answer();
    miksy("sync", "--global"); await exit(s); state("после выхода"); }
} finally {
  api.kill(); await Bun.sleep(300);
  if (!process.env.KEEP) rmSync(root, { recursive: true, force: true }); else console.log("оставлено: " + root);
}
