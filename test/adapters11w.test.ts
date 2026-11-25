// Круг 11w: особенности агентов — в адаптерах. Агент — это папка adapters/<агент>/ и строка в src/agents.ts: в копии
// движка новый (поддельный) агент работает, а без Codex — работают остальные, и src/ кроме этой строки не меняется.
// И угол, который круг поменял: две записи учёта одного файла TOML с испорченным блоком — «хеш неизвестен» и конфликт
// этого файла, а не ошибка всего учёта (manifest.ts: хеш блока по маркерам, таблицы знает адаптер)
import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cliFixture, expectCode, put } from "./helpers";
import { loadManifest, UNKNOWN_HASH } from "../src/manifest";
import { plan } from "../src/apply";
import { TOML_BEGIN, TOML_END } from "../src/toml";

const ROOT = join(import.meta.dir, "..");

// Копия движка: src/, adapters/, builtin/, package.json; edit — правка копии
function engineCopy(edit: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "engine-")).replaceAll("\\", "/");
  for (const p of ["src", "adapters", "builtin", "package.json"]) cpSync(join(ROOT, p), join(dir, p), { recursive: true });
  edit(dir);
  return dir;
}
const listLine = (id: string) => `  ${id}: require("../adapters/${id}").${id},\n`;

const FAKE = `import { readFileSync } from "node:fs";
import type { Adapter, RenderedFile } from "../../src/adapter";
export const fakeagent: Adapter = {
  id: "fakeagent",
  title: "Fakeagent",
  detect: { commands: ["fakeagent"], dirs: [".fakeagent"] },
  program: { name: "Fakeagent", commands: ["fakeagent"] },
  nativeMcp: (s) => (s.command ? { command: s.command, args: s.args ?? [] } : null),
  render(cfg, target) {
    const files: RenderedFile[] = [];
    const body = cfg.instructions.map((i) => readFileSync(i.item.path, "utf8").trim()).join("\\n\\n");
    const global = target.scope === "global";
    if (body) files.push({ base: global ? "home" : "project", path: global ? ".fakeagent/RULES.md" : "FAKE.md", mode: "own", content: body + "\\n" });
    const servers = Object.fromEntries(cfg.mcp.filter(({ item }) => item.command).map(({ item }) => [item.name, { command: item.command, args: item.args ?? [] }]));
    if (global && Object.keys(servers).length) files.push({ base: "home", path: ".fakeagent/config.json", mode: "merge", format: "json", key: ["servers"], data: servers });
    return { files, warnings: [] };
  },
};
`;

function run(engine: string, f: ReturnType<typeof cliFixture>, args: string[]) {
  const r = Bun.spawnSync([process.execPath, `${engine}/src/cli.ts`, ...args], {
    cwd: f.dir, env: { ...process.env, MIKSY_CONFIG: f.config, HOME: f.home, USERPROFILE: f.home }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const res = { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  Object.defineProperty(res, "cmd", { value: `miksy ${args.join(" ")} (копия движка)`, enumerable: false });
  return res;
}
const tree = (dir: string): string[] => existsSync(dir)
  ? readdirSync(dir, { withFileTypes: true }).filter((e) => !/^(\.bun|\.cache|Library|\.git)$/.test(e.name))
    .flatMap((e) => (e.isDirectory() ? [e.name + "/", ...tree(join(dir, e.name)).map((x) => `${e.name}/${x}`)] : [e.name])).sort()
  : [];

describe("агент — это папка (круг 11w)", () => {
  test("новый агент: папка адаптера и строка в списке — sync, doctor, clean работают без правок src/", () => {
    const engine = engineCopy((dir) => {
      put(`${dir}/adapters/fakeagent/index.ts`, FAKE);
      const list = readFileSync(`${dir}/src/agents.ts`, "utf8");
      writeFileSync(`${dir}/src/agents.ts`, list.replace(listLine("antigravity"), listLine("antigravity") + listLine("fakeagent")));
    });
    try {
      const f = cliFixture({ agents: ["fakeagent"] });
      put(`${f.config}/layers/global/mcp/tok.yaml`, "name: tok\ncommand: tok-server\n");
      const p = `${f.ws}/Org/p1`;
      const home0 = tree(f.home), proj0 = tree(p);
      expectCode(run(engine, f, ["sync", "--global"]), 0);
      expectCode(run(engine, f, ["sync", p]), 0);
      expect(readFileSync(`${f.home}/.fakeagent/RULES.md`, "utf8")).toContain("# global");
      expect(JSON.parse(readFileSync(`${f.home}/.fakeagent/config.json`, "utf8")).servers.tok.command).toBe("tok-server");
      expect(readFileSync(`${p}/FAKE.md`, "utf8")).toContain("# workspace");
      const d = run(engine, f, ["doctor"]);
      expect(d.out + d.err).not.toContain("ОШИБКА");
      expectCode(run(engine, f, ["clean", p]), 0);
      expectCode(run(engine, f, ["clean", "--global"]), 0);
      expect(tree(f.home)).toEqual(home0);
      expect(tree(p)).toEqual(proj0);
    } finally { rmSync(engine, { recursive: true, force: true }); }
  }, 120000);

  test("агент убран: без папки adapters/codex и его строки остальные работают, модули src/ загружаются", () => {
    const engine = engineCopy((dir) => {
      rmSync(`${dir}/adapters/codex`, { recursive: true });
      writeFileSync(`${dir}/src/agents.ts`, readFileSync(`${dir}/src/agents.ts`, "utf8").replace(listLine("codex"), ""));
    });
    try {
      // Каждый модуль src/ импортируется
      const mods = readdirSync(`${engine}/src`).filter((n) => n.endsWith(".ts") && !["cli.ts", "main.ts", "bridge.ts"].includes(n)) // запускаемые: выполняют команду при загрузке;
      const code = mods.map((m) => `await import(${JSON.stringify(`${engine}/src/${m}`)});`).join("") + `console.log(Object.keys((await import(${JSON.stringify(`${engine}/src/agents.ts`)})).ADAPTERS).join(","))`;
      const imp = Bun.spawnSync([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
      expect({ code: imp.exitCode, err: imp.stderr.toString().trim().split("\n")[0] ?? "", out: imp.stdout.toString().trim() }).toEqual({ code: 0, err: "", out: "claude,opencode,antigravity" });

      const f = cliFixture({ agents: ["claude", "opencode", "antigravity"] });
      put(`${f.config}/layers/global/mcp/tok.yaml`, "name: tok\ncommand: tok-server\n");
      const p = `${f.ws}/Org/p1`;
      const home0 = tree(f.home), proj0 = tree(p);
      expectCode(run(engine, f, ["sync", "--global"]), 0);
      expectCode(run(engine, f, ["sync", p]), 0);
      expect(existsSync(`${f.home}/.claude/CLAUDE.md`)).toBe(true);
      const d = run(engine, f, ["doctor"]);
      expect(d.out + d.err).not.toContain("ОШИБКА");
      expectCode(run(engine, f, ["clean", p]), 0);
      expectCode(run(engine, f, ["clean", "--global"]), 0);
      expect(tree(f.home)).toEqual(home0);
      expect(tree(p)).toEqual(proj0);
    } finally { rmSync(engine, { recursive: true, force: true }); }
  }, 120000);
});

describe("две записи учёта одного файла TOML, блок испорчен (круг 11w)", () => {
  test("«хеш неизвестен» и конфликт этого файла, а не ошибка учёта", () => {
    const f = cliFixture({ agents: ["codex"] });
    const file = `${f.home}/.codex/config.toml`;
    // Внутри маркеров — не таблица MCP: блок испорчен вручную
    put(file, `model = "x"\n\n${TOML_BEGIN}\n[other]\nkey = 1\n${TOML_END}\n`);
    // Две записи одного файла в разном написании пути (учёт прежних версий): при загрузке сливаются в одну
    const toml = { [file]: { hash: "a", names: ["tok"] }, [file.replace("/.codex/", "/.codex/./")]: { hash: "b", names: ["tok"] } };
    const path = `${f.config}/local/state/manifest.json`;
    put(path, JSON.stringify({ version: 1, targets: { "codex|global": { files: {}, merges: {}, exclude: {}, toml } } }));
    const m = loadManifest(path);
    const st = Object.values(m.targets).find((s) => s.toml)!;
    expect(Object.values(st.toml!)).toEqual([{ hash: UNKNOWN_HASH, names: ["tok"] }]);
    const machine = { home: f.home, workspace: f.ws, os: "windows" as const, vars: {} };
    const actions = plan({ files: [], warnings: [] }, { scope: "global" }, machine, st, false, "codex");
    expect(actions).toEqual([expect.objectContaining({ kind: "conflict", abs: file })]);
  });
});
