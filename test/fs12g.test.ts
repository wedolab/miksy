// Круг 12g: особенности файловых систем.
// 1) «\» в имени папки на macOS и Linux — обычный символ: корень с таким именем доступен; раздел дерева (tree:) с «\» —
//    по-прежнему «/» на всех ОС (строка конфигурации, общая для машин).
// 2) Диск, где права файлов не меняются (сетевой диск без прав, FAT): поддельная ФС (src/modes.ts — modeSys) — chmod
//    молча не действует, режим открыт. Файлы проектов: точка запоминается в учёте (noModes), повторный sync — без
//    «права …», doctor — «Справочно»; права снова работают — точка уходит. local/ (секреты) на таком диске — отказ
//    записи с понятным текстом (проба — localPermsSys), --dry-run и doctor — то же; clean работает.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "../src/commands";
import { checkTree } from "../src/load";
import { modeSys, resetModeSys } from "../src/modes";
import { inside, slash, treeSlash } from "../src/paths";
import { localPermsSys } from "../src/secretfiles";
import { cliFixture, expectCode, gitInit, put } from "./helpers";

const win = process.platform === "win32";
const MCP = "name: x\ncommand: npx\nargs: [-y, pkg]\n";

describe("12g: «\\» в имени", () => {
  test("slash — только на Windows; раздел дерева — «/» на всех ОС", () => {
    expect(slash("a\\b")).toBe(win ? "a/b" : "a\\b");
    expect(treeSlash("Clients\\Sub")).toBe("Clients/Sub");
    expect(checkTree("Clients\\Sub")).toBe("Clients/Sub");
    expect(checkTree("\\Clients\\")).toBe("Clients");
  });

  test.skipIf(win)("корень, в имени папки которого «\\», доступен: sync пишет, doctor и explain его видят", () => {
    const f = cliFixture({ projects: [] });
    const ws = `${f.dir}/ws\\x`;
    mkdirSync(`${ws}/Org/p1`, { recursive: true });
    gitInit(`${ws}/Org/p1`);
    writeFileSync(`${f.config}/local/machine.yaml`, `workspace: ${JSON.stringify(ws)}\nagents: [claude]\n`);
    const r = f.run(["sync", "--all"]);
    expectCode(r, 0);
    expect(existsSync(`${ws}/Org/p1/CLAUDE.local.md`)).toBe(true);
    expect(existsSync(`${f.dir}/ws/x`)).toBe(false);
    const doc = f.run(["doctor"]);
    expect(doc.out).not.toContain("недоступен");
    expect(doc.out).toContain("проектов: 1");
    const ex = f.run(["explain", `${ws}/Org/p1`]);
    expectCode(ex, 0);
    expect(ex.out).toContain(`${ws}/Org/p1`);
    // Учёт — под настоящим путём, с «\»
    expect(readFileSync(`${f.config}/local/state/manifest.json`, "utf8")).toContain(JSON.stringify(`${ws}/Org/p1`).slice(1, -1));
    // Повторный sync — изменений нет
    expect(f.run(["sync", "--all"]).out).not.toMatch(/записать|обновить/);
  }, 60000);

  test("tree с «\\» у дополнительного корня — раздел через «/» (как раньше, на всех ОС)", () => {
    const f = cliFixture();
    const extra = `${f.dir}/extra`;
    mkdirSync(`${extra}/app`, { recursive: true });
    gitInit(`${extra}/app`);
    put(`${f.config}/layers/tree/Clients/Sub/instructions/10.md`, "# раздел Clients/Sub\n");
    writeFileSync(`${f.config}/local/machine.yaml`, `workspace:\n  - ${JSON.stringify(f.ws)}\n  - { path: ${JSON.stringify(extra)}, tree: "Clients\\\\Sub" }\nagents: [claude]\n`);
    const r = f.run(["sync", "--all"]);
    expectCode(r, 0);
    expect(readFileSync(`${extra}/app/CLAUDE.local.md`, "utf8")).toContain("# раздел Clients/Sub");
  }, 60000);
});

// Команда в этом процессе (поддельная ФС — подмена modeSys и localPermsSys)
function inproc(f: { config: string; home: string; dir: string }, cmd: string, args: string[]) {
  const saved = { ...process.env }, cwd = process.cwd(), log = console.log, out: string[] = [];
  Object.assign(process.env, { MIKSY_CONFIG: f.config, HOME: f.home, USERPROFILE: f.home });
  process.chdir(f.dir);
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  try { return { code: runCommand(cmd, args, { ask: null }), out: out.join("\n") }; }
  catch (e) { return { code: 1, out: `${out.join("\n")}\nОшибка: ${(e as Error).message}` }; }
  finally {
    console.log = log;
    process.chdir(cwd);
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}
const realProbe = localPermsSys.probe;
afterEach(() => { resetModeSys(); localPermsSys.probe = realProbe; });

// Поддельный диск без прав: под nas режим всегда 0755 (папка — 0755), chmod ничего не делает, своё устройство
function noPermsDisk(nas: string) {
  const under = (p: string) => inside(p, nas);
  modeSys.chmod = (p, m) => { if (!under(p)) chmodSync(p, m); };
  modeSys.mode = (p) => (under(p) ? (statSync(p).mode & ~0o777) | 0o755 : statSync(p).mode);
  modeSys.dev = (p) => (under(p) ? 987654 : statSync(p).dev);
}

describe.skipIf(win)("12g: файлы проектов на диске без прав", () => {
  test("точка запоминается: один раз предупреждение, повторный sync и --dry-run без «права …», doctor — «Справочно»; права вернулись — точка уходит", () => {
    const f = cliFixture({ agents: ["claude", "codex", "opencode"], projects: [] });
    const nas = `${f.dir}/nas`;
    const ws = `${nas}/ws`;
    mkdirSync(`${ws}/Org/p1`, { recursive: true });
    gitInit(`${ws}/Org/p1`);
    writeFileSync(`${f.config}/local/machine.yaml`, `workspace: ${JSON.stringify(ws)}\nagents: [claude, codex, opencode]\n`);
    put(`${f.config}/layers/tree/mcp/x.yaml`, MCP);
    noPermsDisk(nas);
    const first = inproc(f, "sync", ["--all"]);
    const second = inproc(f, "sync", ["--all"]);
    const all = first.out + second.out;
    expect(all).toContain(`предупреждение: права файлов на ${nas} не меняются (сетевой диск или ФС без прав`);
    const ledger = () => JSON.parse(readFileSync(`${f.config}/local/state/manifest.json`, "utf8")) as { noModes?: string[] };
    expect(ledger().noModes).toEqual([nas]);
    const third = inproc(f, "sync", ["--all"]);
    expectCode(third, 0);
    expect(third.out).not.toMatch(/права 0\d{3}/);
    expect(third.out).not.toContain("не меняются");
    expect(inproc(f, "sync", ["--all", "--dry-run"]).out).not.toMatch(/права 0\d{3}/);
    const doc = inproc(f, "doctor", []);
    expect(doc.out).not.toContain("Небезопасные права");
    expect(doc.out).toContain(`Права файлов не меняются (1) — сетевой диск или ФС без прав`);
    expect(doc.out).toContain(`\n  ${nas}`);
    // Права снова работают (диск перемонтировали): следующая запись секретного файла проверяет — точка уходит
    resetModeSys();
    put(`${f.config}/layers/tree/mcp/y.yaml`, MCP.replace("name: x", "name: y"));
    expectCode(inproc(f, "sync", ["--all"]), 0);
    expect(ledger().noModes).toBeUndefined();
  }, 120000);

  test("chmod чужого файла — EPERM на обычном диске: проба закрылась — точки нет, план и doctor как раньше, без падения", () => {
    const f = cliFixture({ agents: ["claude", "codex"] });
    put(`${f.config}/layers/tree/mcp/x.yaml`, MCP);
    expectCode(inproc(f, "sync", ["--all"]), 0);
    const toml = `${f.ws}/Org/p1/.codex/config.toml`;
    chmodSync(toml, 0o644);
    // Файл стал чужим (как после sudo): chmod именно его — EPERM; пробный файл рядом закрывается
    modeSys.chmod = (p, m) => {
      if (p === toml) throw Object.assign(new Error(`EPERM: operation not permitted, chmod '${p}'`), { code: "EPERM" });
      chmodSync(p, m);
    };
    const r = inproc(f, "sync", ["--all"]);
    expectCode(r, 0);
    expect(r.out).not.toContain("не меняются");
    expect((JSON.parse(readFileSync(`${f.config}/local/state/manifest.json`, "utf8")) as { noModes?: string[] }).noModes).toBeUndefined();
    expect(inproc(f, "sync", ["--all", "--dry-run"]).out).toMatch(/права 0600 +.*config\.toml/);
    const doc = inproc(f, "doctor", []);
    expect(doc.out).toContain("Небезопасные права");
    expect(doc.out).toContain(`${toml}: права 0600`);
    expect(doc.out).not.toContain("Права файлов не меняются");
    // Пробных файлов не осталось
    expect(readdirSync(`${f.ws}/Org/p1/.codex`).filter((n) => n.startsWith(".miksy-perms-probe"))).toEqual([]);
  }, 60000);

  test("обычный диск — как раньше: открытый секретный файл sync закрывает, точки нет", () => {
    const f = cliFixture({ agents: ["claude", "codex"] });
    put(`${f.config}/layers/tree/mcp/x.yaml`, MCP);
    expectCode(inproc(f, "sync", ["--all"]), 0);
    const toml = `${f.ws}/Org/p1/.codex/config.toml`;
    chmodSync(toml, 0o644);
    const plan = inproc(f, "sync", ["--all", "--dry-run"]);
    expect(plan.out).toMatch(/права 0600 +.*config\.toml/);
    expectCode(inproc(f, "sync", ["--all"]), 0);
    expect(statSync(toml).mode & 0o077).toBe(0);
    expect((JSON.parse(readFileSync(`${f.config}/local/state/manifest.json`, "utf8")) as { noModes?: string[] }).noModes).toBeUndefined();
  }, 60000);
});

describe("12g: local/ на диске без прав — отказ записи", () => {
  // Открыть local/ (во временной песочнице) и подменить пробу: «права на этом диске не меняются»
  const openLocal = (config: string) => {
    const local = join(config, "local");
    if (win) expect(Bun.spawnSync([join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), local.replaceAll("/", "\\"), "/grant", "*S-1-1-0:(R)"], { stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
    else chmodSync(local, 0o755);
    localPermsSys.probe = () => false;
  };

  test("sync и --dry-run отказывают до записи понятным текстом, doctor — проблема, clean работает", () => {
    const f = cliFixture();
    openLocal(f.config);
    const text = "local/ (секреты и учёт этой машины) лежит на диске, где права файлов не работают";
    const dry = inproc(f, "sync", ["--all", "--dry-run"]);
    expectCode(dry, 1);
    expect(dry.out).toContain(text);
    expect(dry.out).toContain("Перенесите конфигурацию miksy на локальный диск");
    const sync = inproc(f, "sync", ["--all"]);
    expectCode(sync, 1);
    expect(sync.out).toContain(text);
    expect(existsSync(`${f.ws}/Org/p1/CLAUDE.local.md`)).toBe(false);
    expect(existsSync(`${f.config}/local/state/manifest.json`)).toBe(false);
    // local/ не тронут: как был открыт, так и остался (закрыть его на таком диске нельзя — и не пытаемся)
    if (!win) expect(statSync(`${f.config}/local`).mode & 0o777).toBe(0o755);
    const doc = inproc(f, "doctor", []);
    expectCode(doc, 1);
    expect(doc.out).toContain(`${text}`);
    expect(doc.out).toContain("пока так, sync и setup откажут");
    const clean = inproc(f, "clean", [`${f.ws}/Org/p1`]);
    expectCode(clean, 0);
  }, 60000);

  test("local/ открыт на обычном диске — sync закрывает, как раньше (проба настоящая)", () => {
    const f = cliFixture();
    const local = join(f.config, "local");
    if (!win) chmodSync(local, 0o755);
    else expect(Bun.spawnSync([join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), local.replaceAll("/", "\\"), "/grant", "*S-1-1-0:(R)"], { stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
    const r = inproc(f, "sync", ["--all"]);
    expectCode(r, 0);
    expect(r.out).toContain("Доступ к local/ (секреты и учёт этой машины): закрыт — теперь только для вас.");
  }, 60000);
});
