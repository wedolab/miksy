// Круг 11v: clean убирает начисто — после sync → clean дом и проект такие же, как до sync (побайтно, без пустых папок
// и файлов-обёрток вроде {"mcp":{}}). Убирается только созданное miksy (учёт local/state/manifest.json: made): бывшее
// до miksy, чужое и ссылки (symlink, junction) остаются. Папка Antigravity IDE без IDE не заводится
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { cliFixture, expectCode, put } from "./helpers";

const AGENTS = ["claude", "codex", "opencode", "antigravity"];

// Снимок дерева: папки и хеши файлов (без .git, кроме info/, и без кеша Bun в доме песочницы)
function snap(dir: string, base = dir, out = new Map<string, string>()): Map<string, string> {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    const rel = p.slice(base.length + 1);
    // Кеш Bun в доме песочницы: Windows и Linux — ~/.bun, macOS — ~/Library/Caches/bun
    if ((rel.startsWith(".git/") && !rel.startsWith(".git/info")) || /^(\.bun|\.cache|Library)(\/|$)/.test(rel)) continue;
    if (e.isSymbolicLink()) out.set(rel, "link");
    else if (e.isDirectory()) { out.set(rel + "/", "dir"); snap(p, base, out); }
    else out.set(rel, createHash("sha1").update(readFileSync(p)).digest("hex"));
  }
  return out;
}
const list = (m: Map<string, string>) => [...m].map(([k, v]) => `${k} ${v}`).sort();

function fixture() {
  const f = cliFixture({ agents: AGENTS });
  put(`${f.config}/layers/global/mcp/tok.yaml`, "name: tok\ncommand: tok-server\n");
  put(`${f.config}/layers/tree/mcp/ws.yaml`, "name: wsrv\ncommand: ws-server\n");
  put(`${f.config}/layers/global/skills/gs/SKILL.md`, "---\nname: gs\ndescription: g\n---\nx\n");
  put(`${f.config}/layers/tree/skills/ps/SKILL.md`, "---\nname: ps\ndescription: p\n---\nx\n");
  const proj = `${f.ws}/Org/p1`;
  const sync = () => {
    for (const r of [f.run(["sync", "--global"]), f.run(["sync", proj])]) {
      expectCode(r, 0);
      expect(r.out).not.toContain("КОНФЛИКТ");
    }
  };
  const clean = (...extra: string[]) => {
    for (const r of [f.run(["clean", proj, ...extra]), f.run(["clean", "--global"])]) expectCode(r, 0);
  };
  const manifest = () => JSON.parse(readFileSync(`${f.config}/local/state/manifest.json`, "utf8"));
  return { ...f, proj, sync, clean, manifest };
}

describe("clean убирает начисто (круг 11v)", () => {
  test("все агенты: sync → clean возвращает дом и проект как были; повторный sync стабилен, и снова clean — чисто", () => {
    const f = fixture();
    const home0 = list(snap(f.home)), proj0 = list(snap(f.proj));
    f.sync();
    const synced = list(snap(f.home));
    expect(synced).not.toEqual(home0);
    // Папку IDE без IDE sync не заводит
    expect(existsSync(`${f.home}/.gemini/antigravity-ide`)).toBe(false);
    const c = f.run(["clean", f.proj]);
    expectCode(c, 0);
    expect(c.out).toContain("(пустая, её создал miksy)");
    const g = f.run(["clean", "--global"]);
    expectCode(g, 0);
    expect(g.out).toContain("(файл создал miksy, и в нём осталось только пустое)");
    expect(list(snap(f.home))).toEqual(home0);
    expect(list(snap(f.proj))).toEqual(proj0);
    expect(f.manifest().made).toBeUndefined();

    // Повторный sync: всё заново, учёт «создал miksy» снова записан, без конфликтов; ещё раз — изменений нет
    f.sync();
    expect(list(snap(f.home))).toEqual(synced);
    expect(f.manifest().made?.dirs?.length).toBeGreaterThan(0);
    for (const r of [f.run(["sync", "--global"]), f.run(["sync", f.proj])]) expect(r.out).toContain("изменений нет");
    f.clean();
    expect(list(snap(f.home))).toEqual(home0);
    expect(list(snap(f.proj))).toEqual(proj0);
  }, 240000);

  test("clean --forget — так же начисто", () => {
    const f = fixture();
    const home0 = list(snap(f.home)), proj0 = list(snap(f.proj));
    f.sync();
    f.clean("--forget");
    expect(list(snap(f.home))).toEqual(home0);
    expect(list(snap(f.proj))).toEqual(proj0);
  }, 180000);

  test("бывшее до miksy остаётся: пустая папка и файл {\"mcpServers\":{}}; чужой файл в папке miksy — папка остаётся", () => {
    const f = fixture();
    mkdirSync(`${f.proj}/.claude`);
    put(`${f.home}/.gemini/config/mcp_config.json`, '{"mcpServers":{}}');
    const home0 = list(snap(f.home)), proj0 = list(snap(f.proj));
    f.sync();
    // Чужой файл в папке, которую создал miksy (или файл другой машины в общей папке): папка непуста — остаётся
    put(`${f.home}/.claude/skills/mine.txt`, "моё");
    put(`${f.proj}/.codex/note.txt`, "файл другой машины");
    f.clean();
    // Круг 11y: правка на месте — файл побайтно как до miksy (было: переформатирован JSON.stringify)
    expect(readFileSync(`${f.home}/.gemini/config/mcp_config.json`, "utf8")).toBe('{"mcpServers":{}}');
    expect(existsSync(`${f.proj}/.claude`)).toBe(true);
    expect(readFileSync(`${f.home}/.claude/skills/mine.txt`, "utf8")).toBe("моё");
    expect(readFileSync(`${f.proj}/.codex/note.txt`, "utf8")).toBe("файл другой машины");
    expect(existsSync(`${f.home}/.claude/CLAUDE.md`)).toBe(false);

    // Чужие файлы убрали — следующий sync и clean уберут и папки: запись «создал miksy» осталась
    rmSync(`${f.home}/.claude/skills/mine.txt`);
    rmSync(`${f.proj}/.codex/note.txt`);
    f.sync();
    f.clean();
    expect(existsSync(`${f.home}/.claude`)).toBe(false);
    expect(existsSync(`${f.proj}/.codex`)).toBe(false);
    // Бывшее до miksy — как было (файл переписан слиянием — тот же смысл, папка — на месте)
    expect(existsSync(`${f.proj}/.claude`)).toBe(true);
    expect(list(snap(f.proj))).toEqual(proj0);
    expect(list(snap(f.home)).filter((l) => !l.startsWith(".gemini/config/mcp_config.json"))).toEqual(home0.filter((l) => !l.startsWith(".gemini/config/mcp_config.json")));
  }, 240000);

  test("ключ, которого miksy не писал, даже пустой — файл остаётся", () => {
    const f = fixture();
    f.sync();
    // Агент сам завёл пустой объект в файле, который создал miksy
    const file = `${f.home}/.config/opencode/opencode.json`;
    const doc = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...doc, agent: {} }, null, 2));
    f.clean();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ mcp: {}, agent: {} });
  }, 180000);

  test("общая папка двух агентов: clean одного оставляет её, clean второго убирает", () => {
    const f = fixture();
    f.sync();
    expect(existsSync(`${f.proj}/.agents/skills/ps`)).toBe(true);
    expect(existsSync(`${f.proj}/.agents/plugins/miksy`)).toBe(true);
    expectCode(f.run(["clean", f.proj, "--agent", "codex"]), 0);
    expect(existsSync(`${f.proj}/.agents/skills`)).toBe(false);
    expect(existsSync(`${f.proj}/.agents/plugins/miksy/plugin.json`)).toBe(true);
    expectCode(f.run(["clean", f.proj, "--agent", "antigravity"]), 0);
    expect(existsSync(`${f.proj}/.agents`)).toBe(false);
  }, 180000);

  test("ссылка (junction на Windows) на месте папки miksy: ни её, ни то, куда она ведёт, не удаляем", () => {
    const f = fixture();
    f.sync();
    // ~/.claude — теперь ссылка на настоящую папку рядом
    renameSync(`${f.home}/.claude`, `${f.home}/claude-real`);
    symlinkSync(`${f.home}/claude-real`, `${f.home}/.claude`, "junction");
    expect(lstatSync(`${f.home}/.claude`).isSymbolicLink()).toBe(true);
    f.clean();
    expect(lstatSync(`${f.home}/.claude`).isSymbolicLink()).toBe(true);
    expect(existsSync(`${f.home}/claude-real`)).toBe(true);
    // Запись учёта о ней снята: ссылка — не то, что создал miksy
    expect((f.manifest().made?.dirs ?? []).some((d: string) => d.endsWith("/.claude"))).toBe(false);
  }, 180000);

  test("учёт прежней версии (без made): лишнего не удаляет, называет пустое одной строкой", () => {
    const f = fixture();
    f.sync();
    const m = f.manifest();
    delete m.made;
    for (const st of Object.values<any>(m.targets)) delete st.made;
    writeFileSync(`${f.config}/local/state/manifest.json`, JSON.stringify(m, null, 2));
    const c = f.run(["clean", f.proj]);
    expectCode(c, 0);
    expect(c.out).not.toContain("удалить папку");
    expect(c.out).toContain(`пустые после уборки: `);
    expect(c.out).toContain(`${f.proj}/.claude`);
    expect(c.out).toContain("их, возможно, создал miksy прежней версии, но его учёт этого не знает, поэтому clean их не удаляет; не нужны — удалите вручную");
    expect(existsSync(`${f.proj}/.claude`)).toBe(true);
    const g = f.run(["clean", "--global"]);
    expectCode(g, 0);
    expect(g.out).toContain(`${f.home}/.claude.json`);
    expect(existsSync(`${f.home}/.claude.json`)).toBe(true);
    expect(existsSync(`${f.home}/.codex/config.toml`)).toBe(true);
  }, 180000);

  // Круг 11z: файл IDE никто не читает — не пишется и при папке IDE (было: пишется, clean снимает); записанное раньше
  // снимается по учёту — test/antigravity11z.test.ts
  test("Antigravity IDE: есть папка IDE — её mcp_config.json не пишется, clean оставляет папку IDE как была", () => {
    const f = fixture();
    mkdirSync(`${f.home}/.gemini/antigravity-ide`, { recursive: true });
    f.sync();
    expect(existsSync(`${f.home}/.gemini/antigravity-ide/mcp_config.json`)).toBe(false);
    f.clean();
    expect(readdirSync(`${f.home}/.gemini`)).toEqual(["antigravity-ide"]);
  }, 180000);
});
