// Фаза 3: личное из движка (префикс skills, подсказки, шапка файлов), скорость и понятность
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "../src/manifest";
import { cliFixture, CLI, put } from "./helpers";

const win = process.platform === "win32";
// Модуль появился в фазе 3: импорт внутри тестов, чтобы на прежнем коде падали только они
const whoLocks = async (p: string): Promise<{ pid: number; name: string }[]> => (await import("../src/locks")).whoLocks(p);

// Проект с добавленным агентом skill (не из слоёв): adopt предлагает поднять его в слой
const adoptFixture = (map = "") => {
  const f = cliFixture({ agents: ["claude"] });
  if (map) writeFileSync(`${f.config}/map.yaml`, `global:\n  - { use: global }\nlayers: []\n${map}`);
  const skill = (name: string) => put(`${f.ws}/Org/p1/.claude/skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: x\n---\n`);
  const adopt = (name: string) => f.run(["adopt", `${f.ws}/Org/p1`, name, "--to", "workspace", "--yes"]);
  return { ...f, skill, adopt };
};

describe("префикс своих skills — настройка конфигурации", () => {
  test("skill_prefix в map.yaml: совет с этим префиксом, имя с префиксом — без совета", () => {
    const f = adoptFixture("skill_prefix: acme-\n");
    f.skill("tool");
    f.skill("acme-tool");
    const a = f.adopt("tool");
    expect(a.code).toBe(0);
    expect(a.out).toContain("acme-…");
    expect(a.out).not.toContain("vm-");
    const b = f.adopt("acme-tool");
    expect(b.code).toBe(0);
    expect(b.out).not.toContain("совет");
  }, 30000);

  test("без настройки — префикс miksy-", () => {
    const f = adoptFixture();
    f.skill("tool");
    const a = f.adopt("tool");
    expect(a.code).toBe(0);
    expect(a.out).toContain("(miksy-…)");
    expect(a.out).not.toContain("vm-");
  }, 30000);

  test("skill_prefix — строка; иное — ошибка с именем файла", () => {
    const f = adoptFixture("skill_prefix: [a]\n");
    const r = f.run(["explain"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/map\.yaml: skill_prefix/);
  }, 30000);
});

test("шапка сгенерированных файлов: правки — в конфигурации miksy", () => {
  const f = cliFixture({ agents: ["claude", "codex", "opencode", "gemini"] });
  put(`${f.config}/layers/tree/mcp/ctx.yaml`, "name: ctx\ncommand: npx\n");
  expect(f.run(["sync", `${f.ws}/Org/p1`]).code).toBe(0);
  const files = ["CLAUDE.local.md", ".codex/config.toml", ".opencode/miksy.md"];
  for (const file of files) {
    const text = readFileSync(`${f.ws}/Org/p1/${file}`, "utf8");
    expect(text).toContain("в конфигурацию miksy");
    expect(text).not.toContain("репо miksy");
  }
}, 60000);

test("doctor: в глобальных каталогах skills — только каталоги со SKILL.md", () => {
  const f = cliFixture();
  put(`${f.home}/.claude/skills/synced/0b6e-uuid/SKILL.md`, "---\nname: s\ndescription: x\n---\n");
  put(`${f.home}/.claude/skills/bundle/README.md`, "контейнер, не skill\n");
  put(`${f.home}/.claude/skills/manual/SKILL.md`, "---\nname: manual\ndescription: x\n---\n");
  const r = f.run(["doctor"]);
  expect(r.out).toContain("~/.claude/skills/manual");
  expect(r.out).not.toContain("~/.claude/skills/bundle");
  expect(r.out).not.toContain("~/.claude/skills/synced");
}, 30000);

test("каталог _migration — обычный каталог workspace, а не служебный", () => {
  const f = cliFixture({ projects: ["Org/p1", "_migration/old"] });
  const r = f.run(["projects"]);
  expect(r.out).toContain("_migration/old");
}, 30000);

describe("setup: программы машины — из tools в map.yaml", () => {
  const setup = (f: ReturnType<typeof cliFixture>) => {
    const r = Bun.spawnSync([process.execPath, CLI, "setup", "--yes"], {
      cwd: f.dir,
      env: { ...process.env, MIKSY_CONFIG: f.config, HOME: f.home, USERPROFILE: f.home, BUN_INSTALL: `${f.dir}/bun`, PATH: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    return r.stdout.toString() + r.stderr.toString();
  };

  test("переменная из tools: ищется программа, подсказка установки — из map.yaml", () => {
    const f = cliFixture();
    writeFileSync(`${f.config}/map.yaml`, "global:\n  - { use: global }\nlayers: []\ntools:\n  FOO_SERVER:\n    find: [foo-server]\n    install: { windows: winget install foo, macos: brew install foo, linux: apt install foo }\n");
    put(`${f.config}/layers/tree/mcp/foo.yaml`, "name: foo\ncommand: ${FOO_SERVER}\n");
    const out = setup(f);
    expect(out).toMatch(/FOO_SERVER: не найден \(foo-server\) — установить: (winget|brew|apt) install foo/);
    expect(out).not.toMatch(/Не заполнены секреты[\s\S]*FOO_SERVER/);
  }, 30000);

  test("GITHUB_MCP_SERVER не встроен в движок: без tools — обычная переменная (секрет)", () => {
    const f = cliFixture();
    put(`${f.config}/layers/tree/mcp/gh.yaml`, "name: gh\ncommand: ${GITHUB_MCP_SERVER}\n");
    const out = setup(f);
    expect(out).not.toContain("github-mcp-server");
    expect(out).toMatch(/Не заполнены секреты[\s\S]*GITHUB_MCP_SERVER/);
  }, 30000);
});

test("каталоги hooks/ и policies/ в слое — предупреждение, что miksy их не читает", () => {
  const f = cliFixture();
  put(`${f.config}/layers/tree/Org/hooks/pre.sh`, "echo\n");
  put(`${f.config}/layers/global/policies/p.yaml`, "x: 1\n");
  const s = f.run(["sync", `${f.ws}/Org/p1`, "--dry-run"]);
  expect(s.out).toMatch(/layers\/tree\/Org\/hooks.*не читает/);
  expect(s.out).toMatch(/layers\/global\/policies.*не читает/);
  const d = f.run(["doctor"]);
  expect(d.out).toMatch(/layers\/tree\/Org\/hooks.*не читает/);
}, 30000);

test("sync без фиксированной паузы: проверка ключей сразу", () => {
  const f = cliFixture();
  put(`${f.config}/layers/global/mcp/ctx.yaml`, "name: ctx\ncommand: npx\n");
  const r = f.run(["sync", "--global"]);
  expect(r.code).toBe(0);
  expect(r.out).not.toContain("через 3 с");
  expect(r.out).toContain("все ключи на месте");
}, 30000);

test("кеш git команды: соседнее вложенное репо не путается с родителем, индекс — как без кеша", async () => {
  const { cacheGit, repoOf, trackedPaths } = await import("../src/git");
  const { canonical } = await import("../src/paths");
  const d = cliFixture().dir;
  const git = (dir: string, ...a: string[]) => Bun.spawnSync(["git", "-C", dir, ...a], { stdout: "ignore", stderr: "ignore" });
  mkdirSync(`${d}/top/a/deep`, { recursive: true });
  mkdirSync(`${d}/top/nested/x`, { recursive: true });
  git(d, "init", "-q", "top");
  git(`${d}/top`, "init", "-q", "nested");
  put(`${d}/top/.claude/skills/s/SKILL.md`, "x");
  put(`${d}/top/Docs/Readme.md`, "x");
  git(`${d}/top`, "add", ".claude", "Docs");
  const ask = () => [repoOf(`${d}/top/a/deep`), repoOf(`${d}/top/a`), repoOf(`${d}/top/nested/x`), repoOf(`${d}/top/nested`),
    trackedPaths(`${d}/top`, [".claude/skills", ".claude/skills/s/SKILL.md", "docs/readme.md", ".codex", "a"])];
  const plain = ask();
  cacheGit();
  try {
    expect(ask()).toEqual(plain);
    expect(ask()).toEqual(plain); // второй раз — из кеша
  } finally { cacheGit(false); }
  expect(plain[0]).toBe(canonical(`${d}/top`));
  expect(plain[2]).toBe(canonical(`${d}/top/nested`));
  expect(plain[4]).toEqual([".claude/skills", ".claude/skills/s/SKILL.md", "docs/readme.md"]);
}, 30000);

describe("файл занят: кто держит", () => {
  // Файл, открытый другим процессом без FILE_SHARE_DELETE (как в test/write.test.ts)
  const hold = async (path: string, ms: number) => {
    const ps = `$f=[System.IO.File]::Open($env:HOLD_PATH,'Open','ReadWrite','ReadWrite'); [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); Start-Sleep -Milliseconds ${ms}; $f.Close()`;
    const p = Bun.spawn(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps], { env: { ...process.env, HOLD_PATH: path }, stdout: "pipe" });
    const reader = p.stdout.getReader();
    let text = "";
    while (!text.includes("locked")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("не удалось заблокировать файл");
      text += new TextDecoder().decode(value);
    }
    return p;
  };

  test.skipIf(!win)("Windows: сообщение называет процесс и PID (Restart Manager)", async () => {
    const d = cliFixture().dir;
    writeFileSync(`${d}/c.json`, "old");
    const p = await hold(`${d}/c.json`, 8000);
    try {
      expect((await whoLocks(`${d}/c.json`)).map((x) => x.pid)).toContain(p.pid);
      let msg = "";
      try { writeAtomic(`${d}/c.json`, "new"); } catch (e) { msg = (e as Error).message; }
      expect(msg).toContain(`PID ${p.pid}`);
      expect(msg).toMatch(/держит .*PowerShell.*закройте/i);
    } finally {
      p.kill();
      await p.exited;
    }
  }, 30000);

  test.skipIf(win || !Bun.which("lsof"))("macOS/Linux: держатель — через lsof", async () => {
    const d = cliFixture().dir;
    const file = join(d, "held.txt");
    writeFileSync(file, "x");
    const p = Bun.spawn(["sh", "-c", `exec 3<"$1"; echo ready; sleep 10`, "sh", file], { stdout: "pipe" });
    await p.stdout.getReader().read();
    try {
      expect((await whoLocks(file)).map((x) => x.pid)).toContain(p.pid);
    } finally {
      p.kill();
      await p.exited;
    }
  }, 30000);

  test("свободный файл и несуществующий путь — пустой список, без исключений", async () => {
    const d = cliFixture().dir;
    mkdirSync(`${d}/x`, { recursive: true });
    writeFileSync(`${d}/x/free.txt`, "x");
    expect(await whoLocks(`${d}/x/free.txt`)).toEqual([]);
    expect(await whoLocks(`${d}/x/missing.txt`)).toEqual([]);
  });
});
