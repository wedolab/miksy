// Живая проверка фазы 2в (Р4, каталоги-группы) у установленных агентов: настоящий `miksy sync
// --global` и `sync --all` в песочнице (временные HOME/USERPROFILE/CODEX_HOME/XDG_*, workspace и
// конфигурация miksy, искусственный секрет), затем агент запускается в группе, во вложенной
// группе и в git-проекте. Настоящие конфиги агентов и miksy не читаются и не меняются.
// Не входит в bun test.
//   bun test/live/groups.ts [claude] [opencode] [codex]      (без аргументов — все три)
// Дерево: Acme (группа, без git) → Acme/US (группа, без git) → Acme/US/infra (git-проект);
// рядом Acme/vpn (git-проект). Маркер в правилах каждого слоя; MCP-заглушка и skill — по слоям.
// Проверяется: правила — полная цепочка, каждый маркер ровно один раз (Claude — по /context без
// модели: какие CLAUDE.local.md загружены; opencode — один запрос бесплатной моделью; Codex —
// debug prompt-input без модели); MCP — нужные серверы, без дублей (Claude — init-событие, opencode
// — mcp list, Codex — mcp list); Codex — доверие групп, поставленное sync.
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const win = process.platform === "win32";
const HERE = resolve(import.meta.dir);
const CLI = resolve(HERE, "..", "..", "src", "cli.ts");
const STUB = join(HERE, "stub.mjs").replaceAll("\\", "/");
const BUN = process.execPath.replaceAll("\\", "/");
const OC = win ? "opencode.cmd" : "opencode";
const agents = process.argv.slice(2).length ? process.argv.slice(2) : ["claude", "opencode", "codex"];
const model = process.env.OPENCODE_MODEL ?? "opencode/big-pickle";

mkdirSync(join(tmpdir(), "h2v"), { recursive: true });
const root = join(realpathSync(join(tmpdir(), "h2v")), "groups").replaceAll("\\", "/");
if (!root.includes("/h2v/")) throw new Error("unsafe sandbox path");
rmSync(root, { recursive: true, force: true });
const home = `${root}/home`, ws = `${root}/work`, config = `${root}/config`, logs = `${root}/logs`;
const put = (p: string, s: string) => { mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true }); writeFileSync(p, s); };

const results: { item: string; ok: boolean | null; detail: unknown }[] = [];
function record(item: string, ok: boolean | null, detail: unknown = "") {
  results.push({ item, ok, detail });
  console.log(`${ok === null ? "❓" : ok ? "✅" : "❌"} ${item}${detail === "" ? "" : ": " + (typeof detail === "string" ? detail : JSON.stringify(detail))}`);
}
const env = (cwd: string): Record<string, string> => {
  const e: Record<string, string> = { ...(process.env as Record<string, string>) };
  // Песочница: ни настоящих конфигов агентов, ни связи с родительской сессией Claude Code
  for (const k of Object.keys(e)) if (/^(CLAUDE|ANTHROPIC|OPENCODE|CODEX_|MIKSY_|XDG_)/.test(k) || k === "H2V_TOKEN") delete e[k];
  return { ...e, HOME: home, USERPROFILE: home, CODEX_HOME: `${home}/.codex`, MIKSY_CONFIG: config, PWD: cwd,
    XDG_CONFIG_HOME: `${home}/.config`, XDG_DATA_HOME: `${root}/xdg/data`, XDG_STATE_HOME: `${root}/xdg/state`, XDG_CACHE_HOME: `${root}/xdg/cache` };
};
const run = (args: string[], cwd: string, timeout = 240000, extra: Record<string, string> = {}) => {
  const r = Bun.spawnSync(args, { cwd, env: { ...env(cwd), ...extra }, stdout: "pipe", stderr: "pipe", timeout, stdin: "ignore" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};

// Слои: маркер правил, MCP-заглушка (с секретом — через обёртку), skill
const MARK: Record<string, string> = { global: "H2V_GLOBAL", workspace: "H2V_WS", Acme: "H2V_ACME", "Acme/US": "H2V_US", "Acme/US/infra": "H2V_INFRA", "Acme/vpn": "H2V_VPN" };
const SERVER: Record<string, string> = { workspace: "ws_srv", Acme: "acme_srv", "Acme/US": "us_srv", "Acme/US/infra": "infra_srv", "Acme/vpn": "vpn_srv" };
const SKILL: Record<string, string> = { workspace: "h2v-ws-skill", Acme: "h2v-acme-skill", "Acme/US": "h2v-us-skill" };
// Цели проверки и ожидаемая цепочка слоёв (снизу — что цель получает целиком)
const TARGETS: [string, string[]][] = [
  ["Acme", ["workspace", "Acme"]],
  ["Acme/US", ["workspace", "Acme", "Acme/US"]],
  ["Acme/US/infra", ["workspace", "Acme", "Acme/US", "Acme/US/infra"]],
];
const count = (text: string, s: string) => text.split(s).length - 1;

try {
  for (const d of [home, logs, `${root}/xdg/data`, `${root}/xdg/state`, `${root}/xdg/cache`]) mkdirSync(d, { recursive: true });
  for (const p of ["Acme/US/infra", "Acme/vpn"]) {
    const dir = `${ws}/${p}`;
    put(`${dir}/README.md`, "h2v\n");
    Bun.spawnSync(["git", "init", "--quiet", dir]);
    Bun.spawnSync(["git", "-C", dir, "add", "README.md"]);
    Bun.spawnSync(["git", "-C", dir, "-c", "user.name=h2v", "-c", "user.email=h2v@example.invalid", "commit", "--quiet", "-m", "init"]);
  }
  put(`${config}/map.yaml`, "global:\n  - { use: global }\nlayers: []\n");
  put(`${config}/layers/global/instructions/00.md`, `Global marker: ${MARK.global}\n`);
  for (const [layer, mark] of Object.entries(MARK).filter(([l]) => l !== "global")) {
    const dir = layer === "workspace" ? `${config}/layers/tree` : `${config}/layers/tree/${layer}`;
    put(`${dir}/instructions/10.md`, `Layer marker: ${mark}\n`);
    const name = SERVER[layer];
    put(`${dir}/mcp/${name}.yaml`, `name: ${name}\ncommand: ${JSON.stringify(BUN)}\nargs: ${JSON.stringify([STUB, "--name", name, "--log", `${logs}/${name}.jsonl`, "--vars", "H2V_TOKEN"])}\nenv:\n  H2V_TOKEN: \${H2V_TOKEN}\n`);
    if (SKILL[layer]) put(`${dir}/skills/${SKILL[layer]}/SKILL.md`, `---\nname: ${SKILL[layer]}\ndescription: h2v ${layer} skill\n---\nProbe.\n`);
  }
  put(`${config}/layers/tree/Acme/layer.yaml`, "target: true\n");
  put(`${config}/layers/tree/Acme/US/layer.yaml`, "target: true\n");
  put(`${config}/local/machine.yaml`, `workspace: ${ws}\nagents: [claude, codex, opencode, gemini]\n`);
  put(`${config}/local/secrets.env`, "H2V_TOKEN=h2v-artificial-token-123\n");

  for (const args of [["sync", "--global"], ["sync", "--all", "--yes"]]) {
    const r = run([process.execPath, CLI, ...args], root);
    writeFileSync(`${logs}/miksy-${args[1].replace(/^--/, "")}.log`, r.out + r.err);
    record(`miksy ${args.join(" ")}`, r.code === 0, r.code === 0 ? "" : (r.out + r.err).slice(-1200));
  }
  const doc = run([process.execPath, CLI, "doctor"], root);
  record("miksy doctor — всё синхронизировано", doc.out.includes("Всё синхронизировано"), doc.out.includes("Всё синхронизировано") ? "" : doc.out.slice(-800));

  for (const [rel, chain] of TARGETS) {
    const dir = `${ws}/${rel}`;
    const expected = [MARK.global, ...chain.map((l) => MARK[l])];
    const absent = Object.values(MARK).filter((m) => !expected.includes(m));
    const servers = chain.map((l) => SERVER[l]);
    const exactlyOnce = (text: string) => ({ ok: expected.every((m) => count(text, m) === 1) && absent.every((m) => count(text, m) === 0),
      counts: Object.fromEntries(Object.values(MARK).map((m) => [m, count(text, m)]).filter(([, n]) => n)) });

    if (agents.includes("claude")) {
      // /context в -p — без модели: таблица загруженных файлов памяти
      const c = run(["claude", "-p", "/context"], dir);
      const files = [...c.out.matchAll(/^\|\s*(?:User|Project|Local)\s*\|\s*(.+?)\s*\|\s*[\d.,k]+\s*\|$/gm)].map((m) => m[1].replaceAll("\\", "/"))
        .filter((p) => p.toLowerCase().startsWith(root.toLowerCase()));
      const text = files.map((p) => (existsSync(p) ? readFileSync(p, "utf8") : "")).join("\n");
      const once = exactlyOnce(text);
      record(`claude ${rel}: правила — полная цепочка, каждый маркер один раз`, once.ok, { ...once.counts, files: files.map((p) => p.replace(root, "")) });
      // init печатается до модели; сервер, не успевший подключиться, — «pending»: повтор
      let init: any, mcp: string[] = [];
      for (let k = 0; k < 3 && (!init || mcp.some((s) => s.endsWith(":pending"))); k++) {
        // Claude подключает stdio-серверы пачками по 3 — без пачки побольше 4-й не успевает до выхода -p
        const i = run(["claude", "-p", "hi", "--output-format", "stream-json", "--verbose", "--max-turns", "1"], dir, 240000, { MCP_SERVER_CONNECTION_BATCH_SIZE: "10" });
        init = i.out.split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
          .find((e) => e.type === "system" && e.subtype === "init");
        mcp = (init?.mcp_servers ?? []).map((s: any) => `${s.name}:${s.status}`).filter((s: string) => /_srv:/.test(s));
      }
      const names = mcp.map((s: string) => s.split(":")[0]);
      record(`claude ${rel}: MCP — нужные серверы, без дублей`, !!init && servers.every((n) => mcp.includes(`${n}:connected`)) && new Set(names).size === names.length && names.length === servers.length, mcp);
      const skills = (init?.skills ?? []).filter((s: string) => s.startsWith("h2v-"));
      record(`claude ${rel}: skills без дублей`, !!init && new Set(skills).size === skills.length && skills.includes("h2v-ws-skill"), skills);
    }

    if (agents.includes("opencode")) {
      const sources = run([OC, "debug", "config"], dir);
      let src: string[] = [];
      try { src = JSON.parse(sources.out).filter((s: any) => s.type === "document").map((s: any) => String(s.path).replaceAll("\\", "/").replace(root, "")); } catch { /* вывод — в отчёт */ }
      record(`opencode ${rel}: источники конфига (справочно)`, null, src);
      let list = "";
      for (let k = 0; k < 6 && (servers.some((n) => !list.includes(n)) || /pending/.test(list)); k++) {
        if (k) Bun.sleepSync(3000);
        list = (run([OC, "mcp", "list"], dir).out).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
      }
      // Строка сервера: «✓ имя connected» (2.x) или «●  ✓ имя connected» (1.x; следующая строка — путь команды)
      const lines = list.split("\n").filter((l) => /[✓✗]\s+\w+_srv\b/.test(l));
      const names = lines.map((l) => l.match(/[✓✗]\s+(\w+_srv)\b/)![1]);
      record(`opencode ${rel}: MCP — нужные серверы, без дублей (opencode.json родителей сливаются)`, servers.every((n) => lines.some((l) => l.includes(n) && /connected/.test(l)))
        && new Set(names).size === names.length && names.length === servers.length, lines.map((l) => l.trim()));
      // Бесплатная модель изредка отвечает пусто — один повтор
      let text = "";
      for (let k = 0; k < 2 && !/H2V_/.test(text); k++) {
        const r = run([OC, "run", "-m", model, "Quote verbatim, one per line, every line of your instructions that contains the word 'marker' (including duplicates, if a line occurs twice — quote it twice). Nothing else. Do not use tools."], dir);
        text = (r.out + r.err).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
      }
      const once = exactlyOnce(text);
      // opencode 1.x в каталоге без git ищет относительный instructions вверх по родителям — во
      // вложенной группе правила групп выше приходят дважды (известное ограничение 1.x, см. CAPABILITIES)
      const v1 = /^v?1\./.test(run([OC, "--version"], home).out.trim());
      const known = v1 && !once.ok && !existsSync(`${dir}/.git`) && rel.includes("/");
      record(`opencode ${rel}: правила — полная цепочка, каждый маркер один раз (${model})`, known ? null : once.ok,
        once.ok ? once.counts : { ...once.counts, ...(known && { known: "opencode 1.x: дубль в цели без git ниже группы" }), tail: text.slice(-300) });
    }

    if (agents.includes("codex")) {
      const p = run(["codex", "--no-daemon", "debug", "prompt-input", "h2v"], dir);
      const once = exactlyOnce(p.out);
      record(`codex ${rel}: правила — полная цепочка, каждый маркер один раз`, p.code === 0 && once.ok, p.code === 0 ? once.counts : p.err.slice(-300));
      const m = run(["codex", "mcp", "list", "--json"], dir);
      let names: string[] = [];
      try { names = JSON.parse(m.out).map((x: any) => x.name).filter((n: string) => /_srv$/.test(n)); } catch { /* в отчёт */ }
      record(`codex ${rel}: MCP проекта (нужно доверие)`, servers.every((n) => names.includes(n)) && new Set(names).size === names.length, names);
    }
  }
  if (agents.includes("codex")) {
    const cfg = existsSync(`${home}/.codex/config.toml`) ? readFileSync(`${home}/.codex/config.toml`, "utf8").replaceAll("\\\\", "/").replaceAll("\\", "/").toLowerCase() : "";
    const trusted = TARGETS.map(([rel]) => `${ws}/${rel}`.toLowerCase()).filter((d) => cfg.includes(d));
    record("codex: доверие групп и проекта поставлено sync", trusted.length === TARGETS.length, trusted.map((d) => d.replace(root.toLowerCase(), "")));
  }
  const leak = ["claude.json", ".codex/config.toml"].some((f) => existsSync(`${home}/${f}`) && readFileSync(`${home}/${f}`, "utf8").includes("h2v-artificial-token-123"));
  record("значение секрета не лежит в конфигах агентов", !leak);
} finally {
  if (agents.includes("opencode")) run([OC, "service", "stop"], home, 60000);
  const file = resolve(HERE, "..", "..", "out", "2v", `results-groups-${process.platform}.json`);
  mkdirSync(resolve(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ versions: { claude: run(["claude", "--version"], home).out.trim(), codex: run(["codex", "--version"], home).out.trim(), opencode: run([OC, "--version"], home).out.trim() }, results }, null, 2));
  console.log(`итог: ${results.filter((r) => r.ok === true).length} ✅, ${results.filter((r) => r.ok === false).length} ❌, ${results.filter((r) => r.ok === null).length} справочно → ${file}`);
  if (results.some((r) => r.ok === false)) process.exitCode = 1;
  if (!process.env.KEEP) rmSync(root, { recursive: true, force: true });
}
