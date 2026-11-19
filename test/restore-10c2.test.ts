// Круг 10c-2: правки miksy restore по рецензии основного агента (out/check10c/review.md, С1–С4, М1, М3, М4, М6–М8).
// Часть сценариев — из тестов рецензента (out/check10c/miksy/test/zz-check10c.test.ts), с ожиданием исправленного
import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cliFixture } from "./helpers";
import { applyClaude, applyRestore, claudePlan, planRestore, quotePath, readOnlyHint, reason } from "../src/restore";

const win = process.platform === "win32";
const put = (p: string, s: string) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };
const read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const isLink = (p: string) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
const canLink = (() => { try { const d = `${process.env.TEMP ?? process.env.TMPDIR ?? "/tmp"}/r10c2-l-${Date.now()}`; mkdirSync(d, { recursive: true }); writeFileSync(`${d}/a`, "x"); symlinkSync(`${d}/a`, `${d}/b`, "file"); return true; } catch { return false; } })();
const links = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) out.push(p); else if (e.isDirectory()) links(p, out);
  }
  return out;
};
const copyDir = (f: { config: string }) => `${f.config}/local/backups/before-miksy-2026-11-10T09-00-00`;

test("С1: подсказка «только для чтения» — путь в одинарных кавычках: $ ` ' ’ пробел кириллица остаются буквально", () => {
  const p = "C:/Users/a$b`c/кат 'x’/.codex/config.toml";
  expect(readOnlyHint(p, true)).toBe("файл «только для чтения»: снимите пометку — attrib -r 'C:\\Users\\a$b`c\\кат ''x’’\\.codex\\config.toml'");
  expect(readOnlyHint("/home/a$b`c/кат 'x/.codex/config.toml", false)).toBe("файл «только для чтения»: снимите пометку — chmod u+w '/home/a$b`c/кат '\\''x/.codex/config.toml'");
  expect(quotePath("/x/'y", false)).toBe("'/x/'\\''y'");
});

test.skipIf(!win)("С1: Windows — команда из подсказки снимает пометку с файла по пути с $ и обратной кавычкой", () => {
  const f = cliFixture();
  const t = `${f.dir}/a$b\`c 'д’/config.toml`;
  put(t, "x");
  Bun.spawnSync(["cmd", "/c", "attrib", "+r", t.replaceAll("/", "\\")]);
  const hint = reason(Object.assign(new Error("x"), { code: "EPERM" }), { rel: "config.toml", src: "" }, t);
  const cmd = hint.slice(hint.indexOf("attrib -r"));
  const r = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd], { stdout: "pipe", stderr: "pipe" });
  expect(r.exitCode).toBe(0);
  writeFileSync(t, "y"); // пометка снята — запись проходит
  expect(read(t)).toBe("y");
}, 30000);

test("С2: затираемое за ссылкой пользователя — обычным файлом; ссылок в before-restore нет; doctor о before-restore молчит", () => {
  if (!canLink) return;
  const f = cliFixture({ agents: ["claude"] });
  put(`${copyDir(f)}/.claude/settings.json`, "old\n");
  put(`${f.dir}/dotfiles/settings.json`, "new\n");
  mkdirSync(`${f.home}/.claude`, { recursive: true });
  symlinkSync(`${f.dir}/dotfiles/settings.json`, `${f.home}/.claude/settings.json`, "file");
  expect(f.run(["restore", "--yes"]).code).toBe(0);
  expect(read(`${f.dir}/dotfiles/settings.json`)).toBe("old\n");
  expect(isLink(`${f.home}/.claude/settings.json`)).toBe(true);
  const br = readdirSync(`${f.config}/local/backups`).find((d) => d.startsWith("before-restore-"))!;
  expect(links(`${f.config}/local/backups/${br}`)).toEqual([]);
  expect(read(`${f.config}/local/backups/${br}/.claude/settings.json`)).toBe("new\n");
  const d = f.run(["doctor"]);
  expect(d.out + d.err).not.toMatch(/before-restore|Небезопасные права|битая ссылка/);
});

test("С2: ссылка из копии на месте ссылки пользователя — куда вела прежняя, сказано в плане и в итоге; сохранить ссылкой не обещано", () => {
  if (!canLink) return;
  const f = cliFixture({ agents: ["claude"] });
  put(`${f.dir}/a.md`, "A\n"); put(`${f.dir}/b.md`, "B\n");
  mkdirSync(`${copyDir(f)}/.claude`, { recursive: true });
  symlinkSync(`${f.dir}/a.md`, `${copyDir(f)}/.claude/CLAUDE.md`, "file");
  mkdirSync(`${f.home}/.claude`, { recursive: true });
  symlinkSync(`${f.dir}/b.md`, `${f.home}/.claude/CLAUDE.md`, "file");
  const r = f.run(["restore", "--yes"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("(ссылка не сохраняется — только куда вела, в итоге)");
  expect(r.out).toContain(`заменённые ссылки (в бэкап не сохраняются) вели на: ~/.claude/CLAUDE.md → ${f.dir}/b.md`);
  expect(read(`${f.dir}/b.md`)).toBe("B\n");
});

// С3: Windows — прежнее убрано, а переименование новой ссылки не прошло (антивирус держит её)
function c3(f: ReturnType<typeof cliFixture>, old: "link" | "file") {
  const copy = `${f.dir}/copy`;
  put(`${f.dir}/skills-new/x/SKILL.md`, "new");
  put(`${f.dir}/skills-old/y/SKILL.md`, "old");
  mkdirSync(`${copy}/.claude`, { recursive: true });
  symlinkSync(`${f.dir}/skills-new`, `${copy}/.claude/skills`, "junction");
  mkdirSync(`${f.home}/.claude`, { recursive: true });
  if (old === "link") symlinkSync(`${f.dir}/skills-old`, `${f.home}/.claude/skills`, "junction");
  else put(`${f.home}/.claude/skills`, "файл на месте ссылки");
  const plan = planRestore(copy, f.home);
  expect(plan.overwrite.map((i) => i.rel)).toEqual([".claude/skills"]);
  return plan;
}
const busy = { rename: () => { throw Object.assign(new Error("занято"), { code: "EBUSY" }); } };

test.skipIf(!win)("С3: переименование не прошло — прежняя ссылка поставлена обратно, остатка .miksy-new нет", () => {
  const f = cliFixture();
  const r = applyRestore(c3(f, "link"), f.home, () => undefined, busy);
  expect(r.failed.length).toBe(1);
  expect(r.failed[0].why).toContain("новую ссылку не удалось поставить на место (EBUSY) — прежняя ссылка возвращена");
  expect(readlinkSync(`${f.home}/.claude/skills`).replace(/^\\\\\?\\/, "").replaceAll("\\", "/").replace(/\/$/, "").toLowerCase()).toBe(`${f.dir}/skills-old`.toLowerCase());
  expect(existsSync(`${f.home}/.claude/skills.miksy-new`) || isLink(`${f.home}/.claude/skills.miksy-new`)).toBe(false);
  expect(read(`${f.dir}/skills-old/y/SKILL.md`)).toBe("old");
});

test.skipIf(!win)("С3: переименование не прошло — прежний файл возвращён из бэкапа", () => {
  const f = cliFixture();
  const plan = c3(f, "file");
  const saved = `${f.dir}/saved-skills`;
  const r = applyRestore(plan, f.home, (p) => { writeFileSync(saved, readFileSync(p)); return saved; }, busy);
  expect(r.failed[0].why).toContain("прежний файл возвращён");
  expect(read(`${f.home}/.claude/skills`)).toBe("файл на месте ссылки");
});

test.skipIf(!win)("С3: вернуть прежнее нельзя — строка про остаток .miksy-new и что сделать", () => {
  const f = cliFixture();
  const plan = c3(f, "file");
  const r = applyRestore(plan, f.home, () => undefined, busy); // бэкапа нет (подмена) — вернуть нечем
  expect(r.failed[0].why).toMatch(/^на месте пусто: новая ссылка не встала \(EBUSY\) и осталась рядом как ~\/\.claude\/skills\.miksy-new — переименуйте её в skills \(PowerShell: Rename-Item -LiteralPath '.*skills\.miksy-new' 'skills'\) или повторите miksy restore/);
  expect(isLink(`${f.home}/.claude/skills.miksy-new`)).toBe(true);
});

test("С4: битый .claude.json в копии — предупреждение, остальное вернулось, код 0, без «Исправьте»", () => {
  const f = cliFixture({ agents: ["claude"] });
  put(`${copyDir(f)}/.claude.json`, "{ broken \"sk-secret-part");
  put(`${copyDir(f)}/.codex/config.toml`, "cfg\n");
  put(`${f.home}/.claude.json`, "{}");
  for (const args of [["restore", "--dry-run"], ["restore", "--yes"], ["restore", "--yes"]]) {
    const r = f.run(args);
    expect({ code: r.code, fix: r.out.includes("Исправьте"), leak: r.out.includes("sk-secret") }).toEqual({ code: 0, fix: false, leak: false });
    expect(r.out).toContain("Предупреждение: серверы Claude из копии не прочитать — файл копии .claude.json повреждён");
  }
  expect(read(`${f.home}/.codex/config.toml`)).toBe("cfg\n");
});

test("М1: сервер Claude с именем constructor или toString переносится", () => {
  const f = cliFixture({ agents: ["claude"] });
  put(`${copyDir(f)}/.claude.json`, JSON.stringify({ mcpServers: { constructor: { command: "c" }, toString: { command: "t" } }, projects: { constructor: { mcpServers: { p: { command: "p" } } } } }));
  put(`${f.home}/.claude.json`, JSON.stringify({ mcpServers: {} }, null, 2));
  const r = f.run(["restore", "--yes"]);
  expect(r.code).toBe(0);
  const live = JSON.parse(read(`${f.home}/.claude.json`)!);
  expect(live.mcpServers).toEqual({ constructor: { command: "c" }, toString: { command: "t" } });
  expect(live.projects.constructor).toEqual({ mcpServers: { p: { command: "p" } } });
});

test("М3: ~/.claude.json испорчен между планом и записью — в выводе нет его содержимого", () => {
  const f = cliFixture();
  const copy = `${f.dir}/copy.json`, live = `${f.home}/.claude.json`;
  writeFileSync(copy, JSON.stringify({ mcpServers: { a: { command: "a" } } }));
  writeFileSync(live, "{}");
  const plan = claudePlan(copy, live);
  writeFileSync(live, '{ "oauth": sk-ant-secret-token');
  const res = applyClaude(plan, live, () => {});
  expect(res.error).toBe("~/.claude.json не прочитать (повреждён или изменился во время работы): закройте Claude и повторите miksy restore");
});

test("М4: файлы входа — без учёта регистра (.Credentials.json, Auth.json не возвращаются)", () => {
  const f = cliFixture();
  const copy = `${f.dir}/copy`;
  put(`${copy}/.claude/.Credentials.json`, "old");
  put(`${copy}/.codex/Auth.json`, "old");
  const plan = planRestore(copy, f.home);
  expect(plan.notRestored).toEqual([".claude/.Credentials.json", ".codex/Auth.json"]);
  expect(plan.add).toEqual([]);
});

test.skipIf(!win)("М6: Windows — символическая ссылка на папку с относительной целью уже на месте — «уже на месте»", () => {
  const f = cliFixture();
  const copy = `${f.dir}/copy`;
  put(`${f.home}/dot/skills/a/SKILL.md`, "s");
  mkdirSync(`${f.home}/.agents`, { recursive: true });
  const mk = Bun.spawnSync(["cmd", "/c", "mklink", "/D", `${f.home}/.agents/skills`.replaceAll("/", "\\"), "..\\dot\\skills"], { stdout: "pipe", stderr: "pipe" });
  if (mk.exitCode !== 0) return; // без режима разработчика символическую ссылку на папку не создать
  mkdirSync(`${copy}/.agents`, { recursive: true });
  Bun.spawnSync(["cmd", "/c", "mklink", "/D", `${copy}/.agents/skills`.replaceAll("/", "\\"), "..\\dot\\skills"], { stdout: "pipe" });
  const plan = planRestore(copy, f.home);
  expect({ same: plan.same.map((i) => i.rel), over: plan.overwrite.length }).toEqual({ same: [".agents/skills"], over: 0 });
});

test.skipIf(!win)("М7: Windows не дала создать ссылку на папку — совет про режим разработчика", () => {
  const why = reason(Object.assign(new Error("x"), { code: "EPERM" }), { rel: ".claude/skills", src: "", link: { to: "D:/x", dir: true } }, "C:/nope/.claude/skills");
  expect(why).toStartWith("Windows не дала создать ссылку на папку: включите режим разработчика");
});

test("М8: копия не before-miksy — «отличается от копии», а не «после установки»; пути «не возвращён» — с ~/", () => {
  const f = cliFixture();
  const copy = `${f.dir}/other`;
  put(`${copy}/.codex/config.toml`, "a\n");
  put(`${f.home}/.codex/config.toml`, "b\n");
  const r = f.run(["restore", copy, "--dry-run"]);
  expect(r.out).toContain("Затрёт — отличается от копии; нынешние файлы сохранятся в бэкап (1):");
  expect(r.out).not.toContain("после установки");
});

test("М8: коды выхода — без терминала без --yes 2, отказ на вопрос 1 (так и в справке)", () => {
  const doc = readFileSync(`${import.meta.dir}/../docs/uninstall.md`, "utf8");
  expect(doc).toContain("ответ «нет» на вопрос — код 1");
  expect(doc).toContain("без терминала и без `--yes` — код 2");
});

test("повторная проверка 10c-2: сервер Claude с именем __proto__ дописан своим ключом", () => {
  const f = cliFixture({ agents: ["claude"] });
  put(`${copyDir(f)}/.claude.json`, '{"mcpServers":{"__proto__":{"command":"p"}}}');
  put(`${f.home}/.claude.json`, JSON.stringify({ mcpServers: {} }, null, 2));
  const r = f.run(["restore", "--yes"]);
  expect(r.code).toBe(0);
  expect(read(`${f.home}/.claude.json`)).toContain('"__proto__": {');
  expect(Object.keys(JSON.parse(read(`${f.home}/.claude.json`)!).mcpServers)).toEqual(["__proto__"]);
});

test("повторная проверка 10c-2: .claude.json в копии — папка (не прочитать): исправимо, код 1, не «повреждён»", () => {
  const f = cliFixture({ agents: ["claude"] });
  mkdirSync(`${copyDir(f)}/.claude.json`, { recursive: true });
  put(`${f.home}/.claude.json`, "{}");
  const r = f.run(["restore", "--yes"]);
  expect(r.code).toBe(1);
  expect(r.out).toContain("файл копии .claude.json не прочитать (нет доступа или это не файл)");
  expect(r.out).not.toContain("повреждён");
});
