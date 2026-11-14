// Выпуск 0.2.2, круг 8b, C1: права local/ и ссылки. Правило (план out/8b-plan.md, таблица путей; ответ основного агента
// out/8b-plan-answer.md): miksy проверяет и меняет права только у настоящих файлов и папок внутри local/, до которых можно
// дойти, не проходя через ссылку. За ссылкой — ничего: junction, ссылка на папку, на файл, битая. Ссылка сама по себе не
// делает local/ «не закрытым». Ссылки в копии «до miksy» — без предупреждений; в других местах local/ — предупреждение,
// если цель открыта или ссылка битая; запись через ссылку local/secrets, local/backups с открытой целью — отказ
// (linkedDir). Открытый настоящий файл — и рядом со ссылкой (сброс по одному файлу), и в соседней папке без ссылок
// (сброс /t) — закрывается. Все цели ссылок и открытые файлы — во временных каталогах.
// Ссылку, которую ОС не даёт создать без прав (Windows без режима разработчика), — пропуск с пометкой
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCommand } from "../src/commands";
import { setup } from "../src/setup";
import { checkLocalAccess, checkSecretFiles, linkedDir, privateLocal, writeSecretFiles } from "../src/secretfiles";
import { backup, newBackupRun } from "../src/backup";
import type { Ask } from "../src/ask";
import { CLI } from "./helpers";

const win = process.platform === "win32";
const sys = (exe: string) => join(process.env.SystemRoot ?? "C:\\Windows", "System32", exe);
const native = (p: string) => p.replaceAll("/", "\\");
const tmp = (prefix: string) => realpathSync.native(mkdtempSync(join(tmpdir(), prefix))).replaceAll("\\", "/");
const put = (p: string, s = "x\n") => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };
type Kind = "junction" | "dir" | "file" | "broken-dir" | "broken-file";

// Что ОС даёт создать в этом процессе (Windows без режима разработчика: только junction)
const can = (() => {
  const d = tmp("acl8b-can-");
  mkdirSync(`${d}/t`);
  put(`${d}/f`);
  const ok = (f: () => void) => { try { f(); return true; } catch { return false; } };
  return {
    dir: ok(() => symlinkSync(`${d}/t`, `${d}/ld`, "dir")),
    file: ok(() => symlinkSync(`${d}/f`, `${d}/lf`, "file")),
  };
})();
const possible = (k: Kind) => (k === "junction" ? win : k === "dir" || k === "broken-dir" ? can.dir : can.file);
// Ссылка вида k на цель target (битая — на несуществующий путь рядом)
function link(k: Kind, target: string, at: string) {
  mkdirSync(dirname(at), { recursive: true });
  if (k === "junction") symlinkSync(target, at, "junction");
  else if (k === "dir") symlinkSync(target, at, "dir");
  else if (k === "file") symlinkSync(target, at, "file");
  else symlinkSync(`${target}-нет`, at, k === "broken-dir" ? (win ? "junction" : "dir") : "file");
}

// Открыть путь другим: Windows — явная запись «Пользователи: чтение»; macOS, Linux — 0755/0644
function open(p: string) {
  if (win) Bun.spawnSync([sys("icacls.exe"), native(p), "/grant", "*S-1-5-32-545:(R)"], { stdout: "pipe", stderr: "pipe" });
  else chmodSync(p, statSync(p).isDirectory() ? 0o755 : 0o644);
}
// Снимок прав всех путей под dir (не заходя в ссылки): Windows — SDDL (icacls /save по каждому), иначе — mode
function rights(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const go = (p: string) => {
    const st = lstatSync(p);
    if (win) {
      const f = join(tmpdir(), `acl8b-r-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
      Bun.spawnSync([sys("icacls.exe"), native(p), "/save", f, "/q", "/L"], { stdout: "pipe", stderr: "pipe" });
      out[p] = existsSync(f) ? readFileSync(f, "utf16le").split(/\r?\n/)[1] ?? "" : "?";
      rmSync(f, { force: true });
    } else out[p] = (st.mode & 0o777).toString(8);
    if (st.isDirectory() && !st.isSymbolicLink()) for (const e of readdirSync(p)) go(`${p}/${e}`);
  };
  go(dir);
  return out;
}

// Цели ссылок вне local/: папка skills (файлы и подпапка) и файл CLAUDE.md — открыты другим (как dotfiles)
function dotfiles(root: string) {
  const dot = `${root}/dotfiles`;
  put(`${dot}/skills/s1/SKILL.md`, "---\nname: s1\ndescription: s\n---\n");
  put(`${dot}/CLAUDE.md`, "# my rules\n");
  for (const p of [`${dot}/skills`, `${dot}/skills/s1`, `${dot}/skills/s1/SKILL.md`, `${dot}/CLAUDE.md`]) open(p);
  return { dot, dir: `${dot}/skills`, file: `${dot}/CLAUDE.md` };
}
const targetOf = (k: Kind, d: ReturnType<typeof dotfiles>) => (k === "file" || k === "broken-file" ? d.file : d.dir);

// ---- Правило на функциях, которыми пользуются все команды (ensurePrivateLocal → privateLocal; doctor и --dry-run —
// checkLocalAccess). Где: в копии «до miksy» и в другом месте local/

const KINDS: Kind[] = ["junction", "dir", "file", "broken-dir", "broken-file"];
const PLACES = [
  // ссылка, открытый файл в той же папке (сброс по одному файлу), открытый файл в соседней папке без ссылок (сброс /t)
  { place: "копия «до miksy»", at: "backups/before-miksy-2026-11-11T00-00-00/.agents/skills", same: "backups/before-miksy-2026-11-11T00-00-00/.agents/open.txt", near: "backups/before-miksy-2026-11-11T00-00-00/.codex/config.toml", warns: false },
  { place: "корень копии", at: "backups/before-miksy-2026-11-11T00-00-00/.claude", same: "backups/before-miksy-2026-11-11T00-00-00/.claude.json", near: "backups/2026-11-10T00-00-00-000Z/C/x.md", warns: false },
  { place: "другое место local/", at: "mine/link", same: "mine/open.txt", near: "state/manifest.json", warns: true },
];

describe("C1: правило на путях таблицы (checkLocalAccess, privateLocal)", () => {
  for (const pl of PLACES)
    for (const k of KINDS)
      test.skipIf(!possible(k))(`${pl.place}, ${k}${possible(k) ? "" : " — пропуск: ОС не даёт создать такую ссылку без прав"}`, () => {
        const root = tmp("acl8b-");
        const d = dotfiles(root);
        const local = `${root}/local`;
        put(`${local}/machine.yaml`, "agents: [claude]\n");
        put(`${local}/${pl.same}`);
        put(`${local}/${pl.near}`);
        link(k, targetOf(k, d), `${local}/${pl.at}`);
        for (const p of [`${local}/${pl.same}`, `${local}/${pl.near}`]) open(p);
        const dotBefore = rights(d.dot);
        const before = checkLocalAccess(local);
        const shows = (r: string[], rel: string) => r.some((b) => b.replaceAll("\\", "/").includes(`${rel}:`));
        const r = privateLocal(local);
        const after = checkLocalAccess(local);
        const broken = k.startsWith("broken");
        expect({
          // doctor до правки показывал оба открытых файла и ничего за ссылкой
          shownBefore: [shows(before.bad, pl.same), shows(before.bad, pl.near)],
          behindLink: before.bad.filter((b) => /^[/:]/.test(b.replaceAll("\\", "/").split(pl.at)[1] ?? "")),
          fixed: r.fixed,
          openAfter: after.bad,
          // права за ссылкой не изменились
          dotSame: rights(d.dot),
          // предупреждение — только вне копии «до miksy»: открытая цель («закройте вручную») или битая ссылка
          warned: r.warnings.length > 0 && r.warnings.every((w) => (broken ? /битая ссылка внутри local\//.test(w) : /закройте вручную/.test(w))),
          // ссылка цела
          linkStays: lstatSync(`${local}/${pl.at}`).isSymbolicLink(),
        }).toEqual({ shownBefore: [true, true], behindLink: [], fixed: true, openAfter: [], dotSame: dotBefore, warned: pl.warns, linkStays: true });
      }, 60000);

  // Только ссылка, открытых файлов нет: local/ «закрыт», ничего не меняется
  for (const k of KINDS)
    test.skipIf(!possible(k))(`ссылка в копии без открытых файлов (${k}) — local/ закрыт, privateLocal ничего не меняет`, () => {
      const root = tmp("acl8b-only-");
      const d = dotfiles(root);
      const local = `${root}/local`;
      // Папки до ссылки — заранее и закрыты: на macOS, Linux mkdir даёт 0755 (открытая папка — не то, что проверяем)
      mkdirSync(`${local}/backups/before-miksy-x/.agents`, { recursive: true });
      privateLocal(local);
      link(k, targetOf(k, d), `${local}/backups/before-miksy-x/.agents/skills`);
      const dotBefore = rights(d.dot);
      expect({ check: checkLocalAccess(local), fix: privateLocal(local), dot: rights(d.dot) })
        .toEqual({ check: { bad: [], links: [], refuse: null }, fix: { fixed: false, warnings: [] }, dot: dotBefore });
    }, 60000);

  // local/ сам ссылка (перенесён на другой том): всё — от каталога назначения; ссылки внутри — по тем же правилам
  for (const k of ["junction", "dir"] as Kind[])
    test.skipIf(!possible(k))(`local/ сам ссылка (${k}), в копии — ссылка на папку dotfiles`, () => {
      const root = tmp("acl8b-self-");
      const d = dotfiles(root);
      const real = `${root}/vault/local`;
      put(`${real}/backups/before-miksy-x/.agents/open.txt`);
      put(`${real}/state/manifest.json`);
      link(possible("dir") ? "dir" : "junction", d.dir, `${real}/backups/before-miksy-x/.agents/skills`);
      for (const p of [`${real}/backups/before-miksy-x/.agents/open.txt`, `${real}/state/manifest.json`]) open(p);
      const local = `${root}/config/local`;
      link(k, real, local);
      const dotBefore = rights(d.dot);
      const r = privateLocal(local);
      expect({ fixed: r.fixed, warnings: r.warnings, after: checkLocalAccess(local).bad, dot: rights(d.dot) })
        .toEqual({ fixed: true, warnings: [], after: [], dot: dotBefore });
    }, 60000);

  // Строки 10 и 16: local/secrets и local/backups — ссылки на открытый каталог. Файлы за ними miksy не закрывает; защита —
  // предупреждение об открытой цели и отказ записи через такую ссылку (linkedDir)
  for (const which of ["secrets", "backups"])
    for (const k of ["junction", "dir"] as Kind[])
      test.skipIf(!possible(k))(`local/${which} — ${k} на открытый каталог: предупреждение, отказ записи, права за ссылкой те же`, () => {
        const root = tmp("acl8b-sec-");
        const vault = `${root}/vault`;
        put(`${vault}/OLD`, "v\n");
        put(`${vault}/2026-11-10T00-00-00-000Z/x.md`);
        for (const p of [vault, `${vault}/OLD`, `${vault}/2026-11-10T00-00-00-000Z`, `${vault}/2026-11-10T00-00-00-000Z/x.md`]) open(p);
        const config = `${root}/config`, local = `${config}/local`;
        put(`${local}/machine.yaml`, "agents: [claude]\n");
        link(k, vault, `${local}/${which}`);
        const before = rights(vault);
        // local/backups — с 8c (C10) отказ всей команды в начале (privateLocal бросает), а не предупреждение
        let r = { warnings: [] as string[] }, early = "";
        try { r = privateLocal(local); } catch (e) { early = (e as Error).message; }
        let refused = "";
        try {
          if (which === "secrets") linkedDir(`${local}/secrets`);
          else { put(`${root}/home/f.txt`); newBackupRun(); backup(`${root}/home/f.txt`, config); }
        } catch (e) { refused = (e as Error).message; }
        newBackupRun();
        expect({
          warned: which === "secrets" ? r.warnings.some((w) => w.includes(`local/${which}`) && /закройте вручную/.test(w)) : /Выход — закрыть цель или заменить эту ссылку обычной папкой .*local\/backups с содержимым цели.*Закрыть цель(?: \(PowerShell\))?: /.test(early),
          refused: which === "secrets" ? /закройте вручную/.test(refused) : /Закрыть цель(?: \(PowerShell\))?: /.test(refused),
          vault: rights(vault),
        }).toEqual({ warned: true, refused: true, vault: before });
      }, 60000);
});

// ---- Команды целиком (новые процессы, песочница): копия «до miksy» со ссылками из дома, затем все команды таблицы

function world() {
  const root = tmp("acl8b-cmd-");
  const home = `${root}/home`, config = `${root}/config`, ws = `${root}/ws`;
  put(`${config}/map.yaml`, "global:\n  - { use: global }\nlayers: []\n");
  put(`${config}/layers/global/instructions/00.md`, "# global\n");
  put(`${config}/layers/tree/instructions/00.md`, "# workspace\n");
  put(`${config}/local/machine.yaml`, `workspace: ${ws}\nagents: [claude, codex]\n`);
  mkdirSync(`${ws}/Org/p1`, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", `${ws}/Org/p1`]);
  put(`${home}/.codex/config.toml`, "model = \"o3\"\n");
  put(`${home}/.claude/settings.json`, "{}\n");
  const d = dotfiles(root);
  // dotfiles: ~/.agents/skills — ссылка на папку (junction на Windows), ~/.claude/rules/my.md — на файл (путь, куда miksy не пишет: иначе законный конфликт «путь ведёт через симлинк»), ~/.claude/old.md — битая
  link(win ? "junction" : "dir", d.dir, `${home}/.agents/skills`);
  if (can.file) link("file", d.file, `${home}/.claude/rules/my.md`);
  if (can.file) link("broken-file", d.file, `${home}/.claude/old.md`);
  const run = (args: string[]) => {
    const r = Bun.spawnSync([process.execPath, CLI, ...args], {
      cwd: root, env: { ...process.env, MIKSY_CONFIG: config, HOME: home, USERPROFILE: home, BUN_INSTALL: `${root}/bun` },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  };
  return { root, home, config, ws, d, run };
}
type W = ReturnType<typeof world>;

// Команда в этом процессе с окружением песочницы. Мастер: «Скопировать …?» — да, остальные вопросы — нет / Enter.
// Часть setup в update (update.ts, finishUpdate) — setup без терминала; сам update защита прогона не пускает
function inproc(w: W, what: "мастер" | "update") {
  const saved = { ...process.env }, cwd = process.cwd(), log = console.log, out: string[] = [];
  Object.assign(process.env, { MIKSY_CONFIG: w.config, HOME: w.home, USERPROFILE: w.home, BUN_INSTALL: `${w.root}/bun` });
  process.chdir(w.root);
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  const ask: Ask = { yes: (q) => /^Скопировать/.test(q), choose: (_q, _o, def) => def ?? null, line: () => null };
  try {
    if (what === "мастер") return { code: runCommand("setup", [], { ask }), out: out.join("\n") };
    try { setup({ ask: null, force: false, hints: false, log: (l = "") => out.push(l), engine: join(import.meta.dir, "..") }); }
    catch (e) { out.push(`Ошибка setup: ${(e as Error).message}`); }
    return { code: /Ошибка setup/.test(out.join("\n")) ? 1 : 0, out: out.join("\n") };
  }
  catch (e) { return { code: -1, out: out.join("\n") + (e as Error).message }; }
  finally {
    console.log = log;
    process.chdir(cwd);
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

const copyOf = (w: W) => {
  const b = `${w.config}/local/backups`;
  const c = readdirSync(b).find((x) => x.startsWith("before-miksy-"));
  return c ? `${b}/${c}` : "";
};

for (const how of ["setup --yes --backup", "мастер"])
  test(`C1, команды: ${how} → копия со ссылками; sync, clean, setup, update, doctor не падают и не трогают dotfiles`, () => {
    const w = world();
    const dotBefore = rights(w.d.dot);
    const s = how === "мастер" ? inproc(w, "мастер") : w.run(["setup", "--yes", "--backup"]);
    const copy = copyOf(w);
    // В копии — ссылка на папку dotfiles (ОС не дала — пропуск проверки «за ссылкой» с пометкой в выводе)
    const linked = !!copy && existsSync(`${copy}/.agents/skills`) && lstatSync(`${copy}/.agents/skills`).isSymbolicLink();
    if (!linked) console.log(`пометка: ссылка на папку в копию не скопирована (ОС без прав) — ${how}`);
    // Открытые настоящие файлы в копии: рядом со ссылкой и в папке без ссылок; и в local/
    const opened = [`${copy}/.agents/open.txt`, `${copy}/.codex/config.toml`, `${w.config}/local/machine.yaml`];
    put(opened[0]);
    for (const p of opened) open(p);
    const doctorBefore = w.run(["doctor"]).out;
    const runs = {
      dry: w.run(["sync", "--global", "--dry-run"]),
      global: w.run(["sync", "--global"]),
      all: w.run(["sync", "--all", "--yes"]),
      clean: w.run(["clean", `${w.ws}/Org/p1`]),
      cleanGlobal: w.run(["clean", "--global"]),
      setup: w.run(["setup", "--yes"]),
      update: inproc(w, "update"),
      doctor: w.run(["doctor"]),
    };
    if (process.env.ACL8B_SHOW) for (const [k, r] of Object.entries(runs)) console.log(`== ${k} ${r.code}
${r.out}`);
    const bad = (t: string) => /local\/ не закрыт|закройте вручную|битая ссылка|icacls не/.test(t);
    expect({
      setup: s.code, copy: !!copy,
      codes: Object.fromEntries(Object.entries(runs).filter(([k]) => k !== "doctor").map(([k, r]) => [k, r.code])),
      complaints: Object.entries(runs).filter(([, r]) => bad(r.out)).map(([k, r]) => `${k}: ${r.out.split("\n").filter(bad).join(" | ")}`),
      // doctor до sync показывал открытые файлы (в том числе в копии), после — нет
      doctorBefore: /Небезопасные права/.test(doctorBefore),
      doctorAfter: runs.doctor.out.match(/Небезопасные права[^\n]*/g) ?? [],
      openAfter: checkLocalAccess(`${w.config}/local`).bad,
      dot: rights(w.d.dot),
    }).toEqual({
      setup: 0, copy: true,
      codes: { dry: 0, global: 0, all: 0, clean: 0, cleanGlobal: 0, setup: 0, update: 0 },
      complaints: [], doctorBefore: true, doctorAfter: [], openAfter: [], dot: dotBefore,
    });
  }, 300000);

// Рецензия A круга 8b, п. 4: local/secrets — ссылка на закрытый каталог, файл секрета в нём открыт. miksy его не закрывает
// (за ссылкой — ничего), doctor говорит «закройте вручную», а не молчит и не обещает sync
for (const k of ["junction", "dir"] as Kind[])
  test.skipIf(!possible(k))(`local/secrets — ${k} на закрытый каталог, открытый файл секрета в нём: doctor — «закройте вручную», права те же`, () => {
    const root = tmp("acl8b-tok-");
    const vault = `${root}/vault`;
    put(`${vault}/TOKEN`, "v\n");
    privateLocal(vault);
    open(`${vault}/TOKEN`);
    const local = `${root}/config/local`;
    put(`${local}/machine.yaml`, "agents: [claude]\n");
    link(k, vault, `${local}/secrets`);
    const before = rights(vault);
    const r = privateLocal(local);
    const doc = checkSecretFiles(new Map([["TOKEN", ["claude p"]]]), { TOKEN: "v" }, [], `${local}/secrets`);
    expect({
      warnings: r.warnings,
      doctor: doc.problems.filter((p) => p.includes("TOKEN")).map((p) => /закройте вручную/.test(p)),
      vault: rights(vault),
    }).toEqual({ warnings: [], doctor: [true], vault: before });
  }, 60000);

// Повторная проверка круга 8b, п. 3, 4: строки doctor о local/secrets-ссылке — по цели ссылки и ровно о том, что делает
// sync. Цель открыта: строка о каталоге (с путём цели) и «закройте вручную», о файле — «туда не пишет», sync отказывает.
// Цель закрыта: на Windows запись любого секрета в каталог закрывает и открытый файл рядом (как сказано в строке)
for (const k of ["junction", "dir"] as Kind[])
  test.skipIf(!possible(k))(`local/secrets — ${k}: строки doctor совпадают с тем, что делает запись секретов`, () => {
    const root = tmp("acl8b-tok2-");
    const vault = `${root}/vault`;
    put(`${vault}/TOKEN`, "v\n");
    privateLocal(vault);
    open(`${vault}/TOKEN`);
    const local = `${root}/config/local`;
    put(`${local}/machine.yaml`, "agents: [claude]\n");
    link(k, vault, `${local}/secrets`);
    privateLocal(local);
    const need = new Map([["TOKEN", ["claude p"]], ["OTHER", ["claude p"]]]);
    // Цель закрыта, TOKEN открыт: запись OTHER
    const closed = checkSecretFiles(need, { TOKEN: "v", OTHER: "o" }, [], `${local}/secrets`).problems.find((p) => p.includes("TOKEN:"))!;
    const w = writeSecretFiles(["OTHER"], { TOKEN: "v", OTHER: "o" }, `${local}/secrets`);
    const tokenAfter = checkSecretFiles(need, { TOKEN: "v", OTHER: "o" }, [], `${local}/secrets`).problems.filter((p) => p.includes("TOKEN:"));
    // Цель открыта: отказ записи, строки о каталоге и файле
    open(vault);
    open(`${vault}/TOKEN`);
    const openDoc = checkSecretFiles(need, { TOKEN: "v2", OTHER: "o" }, [], `${local}/secrets`).problems;
    let refused = "";
    try { writeSecretFiles(["TOKEN"], { TOKEN: "v2" }, `${local}/secrets`); } catch (e) { refused = (e as Error).message; }
    expect({
      closedText: win ? /закрывает такие файлы, когда записывает в этот каталог файл секрета/.test(closed) : /закрывает его, когда записывает в него/.test(closed),
      wrote: w.created,
      tokenClosedByOtherWrite: win ? tokenAfter.length === 0 : tokenAfter.length === 1,
      dirLine: openDoc.some((p) => p.includes(`→ ${vault}`) && /пока так, miksy sync туда не пишет и цели, которым нужны эти секреты, может пропускать .*закройте вручную(?: \(PowerShell\))?: /.test(p)),
      fileLine: openDoc.some((p) => p.includes("TOKEN:") && /каталог за ссылкой local\/secrets открыт/.test(p)),
      updateLine: openDoc.some((p) => /TOKEN: файл секрета устарел .*когда каталог за ссылкой local\/secrets будет закрыт/.test(p)),
      refused: /закройте вручную/.test(refused),
    }).toEqual({ closedText: true, wrote: ["OTHER"], tokenClosedByOtherWrite: true, dirLine: true, fileLine: true, updateLine: true, refused: true });
  }, 60000);

// Повторная проверка 2 круга 8b, п. 4, 5: битая ссылка local/secrets — «исправьте или удалите её» (как linkedDir), не
// «закройте»; на Windows открытые файлы секретов за ссылкой закрываются только настоящей записью: файл-ссылка с другим
// значением (sync её не перезаписывает) их не закрывает
test.skipIf(!possible("junction"))("local/secrets — битая ссылка: doctor — «исправьте или удалите её», sync пропускает цели", () => {
  const root = tmp("acl8b-tok3-");
  const local = `${root}/config/local`;
  put(`${local}/machine.yaml`, "agents: [claude]\n");
  link("broken-dir", `${root}/vault`, `${local}/secrets`);
  const doc = checkSecretFiles(new Map([["TOKEN", ["claude p"]]]), { TOKEN: "v" }, [], `${local}/secrets`).problems;
  expect({
    dir: doc.some((p) => /битая ссылка внутри local\/ — исправьте или удалите её; пока так, miksy sync туда не пишет и цели, которым нужны эти секреты, может пропускать/.test(p) && !/закройте вручную/.test(p)),
    file: doc.some((p) => /TOKEN: нет файла секрета — miksy sync создаст, когда ссылка local\/secrets будет исправлена/.test(p)),
  }).toEqual({ dir: true, file: true });
}, 60000);

test.skipIf(!win || !can.file)("Windows: local/secrets — ссылка на закрытый каталог; файл-ссылка с другим значением не закрывает открытый файл рядом", () => {
  const root = tmp("acl8b-tok4-");
  const vault = `${root}/vault`;
  put(`${vault}/TOKEN`, "v\n");
  put(`${root}/elsewhere/LINKED`, "old\n");
  privateLocal(vault);
  open(`${vault}/TOKEN`);
  link("file", `${root}/elsewhere/LINKED`, `${vault}/LINKED`);
  const local = `${root}/config/local`;
  put(`${local}/machine.yaml`, "agents: [claude]\n");
  link("junction", vault, `${local}/secrets`);
  const w = writeSecretFiles(["LINKED"], { TOKEN: "v", LINKED: "new" }, `${local}/secrets`);
  const token = checkSecretFiles(new Map([["TOKEN", ["claude p"]]]), { TOKEN: "v" }, [], `${local}/secrets`).problems.filter((p) => p.includes("TOKEN:"));
  expect({ lines: w.lines.length, tokenStillOpen: token.length, text: /когда записывает в этот каталог файл секрета/.test(token[0] ?? "") })
    .toEqual({ lines: 0, tokenStillOpen: 1, text: true }); // строку о ссылке печатает план sync (выпуск 0.2.3: файл-ссылка отсеивается до записи)
}, 60000);

// Повторная проверка 3 круга 8b, п. 4: битый файл-ссылка в local/secrets — sync его не перезаписывает и не создаёт файл;
// doctor — «исправьте или удалите её», не «sync создаст»
test.skipIf(!can.file)("local/secrets: битый файл-ссылка — doctor «исправьте или удалите её», sync ничего не создаёт", () => {
  const root = tmp("acl8b-tok5-");
  const local = `${root}/config/local`;
  put(`${local}/machine.yaml`, "agents: [claude]\n");
  mkdirSync(`${local}/secrets`, { recursive: true });
  link("broken-file", `${root}/elsewhere/TOKEN`, `${local}/secrets/TOKEN`);
  const doc = checkSecretFiles(new Map([["TOKEN", ["claude p"]]]), { TOKEN: "v" }, [], `${local}/secrets`).problems;
  const w = writeSecretFiles(["TOKEN"], { TOKEN: "v" }, `${local}/secrets`);
  expect({ doc: doc.filter((p) => p.startsWith("TOKEN:")), created: w.created })
    .toEqual({ doc: ["TOKEN: файл секрета — битая ссылка: miksy её не перезаписывает — исправьте или удалите её (claude p)"], created: [] });
}, 60000);

// Повторная проверка 4 круга 8b, п. 2: план sync для файла секрета-ссылки (в том числе битой) — «это ссылка — не
// перезаписываю», как и сама запись; не «создать»
test.skipIf(!can.file)("sync --dry-run: файл секрета — битая ссылка — план «это битая ссылка — не перезаписываю», не «создать»", () => {
  const f = { dir: tmp("acl8b-plan-") };
  const config = `${f.dir}/config`, home = `${f.dir}/home`;
  put(`${config}/map.yaml`, "global:\n  - { use: global }\nlayers: []\n");
  put(`${config}/layers/global/mcp/srv.yaml`, "name: srv\ncommand: echo\nenv:\n  A_TOKEN: ${A_TOKEN}\n");
  put(`${config}/local/machine.yaml`, `workspace: ${f.dir}/ws\nagents: [opencode]\n`);
  put(`${config}/local/secrets.env`, "A_TOKEN=abcdef123\n");
  mkdirSync(`${f.dir}/ws`, { recursive: true });
  mkdirSync(`${config}/local/secrets`, { recursive: true });
  link("broken-file", `${f.dir}/elsewhere/A_TOKEN`, `${config}/local/secrets/A_TOKEN`);
  const r = Bun.spawnSync([process.execPath, CLI, "sync", "--global", "--dry-run"], { cwd: f.dir, env: { ...process.env, MIKSY_CONFIG: config, HOME: home, USERPROFILE: home }, stdout: "pipe", stderr: "pipe" });
  const out = r.stdout.toString();
  expect({ link: /файл секрета A_TOKEN: это битая ссылка — не перезаписываю \(исправьте или удалите её\)/.test(out), create: /файл секрета A_TOKEN: создать/.test(out) }).toEqual({ link: true, create: false });
}, 60000);

// Повторная проверка 5 круга 8b: настоящий sync — строка о файле-ссылке одна (её печатает план), без «значение другое»
// для битой ссылки
test.skipIf(!can.file)("sync: файл секрета — битая ссылка — одна строка «это битая ссылка — не перезаписываю», без «значение другое»", () => {
  const dir = tmp("acl8b-plan2-");
  const config = `${dir}/config`, home = `${dir}/home`;
  put(`${config}/map.yaml`, "global:\n  - { use: global }\nlayers: []\n");
  put(`${config}/layers/global/mcp/srv.yaml`, "name: srv\ncommand: echo\nenv:\n  A_TOKEN: ${A_TOKEN}\n");
  put(`${config}/local/machine.yaml`, `workspace: ${dir}/ws\nagents: [opencode]\n`);
  put(`${config}/local/secrets.env`, "A_TOKEN=abcdef123\n");
  mkdirSync(`${dir}/ws`, { recursive: true });
  mkdirSync(`${config}/local/secrets`, { recursive: true });
  link("broken-file", `${dir}/elsewhere/A_TOKEN`, `${config}/local/secrets/A_TOKEN`);
  const r = Bun.spawnSync([process.execPath, CLI, "sync", "--global"], { cwd: dir, env: { ...process.env, MIKSY_CONFIG: config, HOME: home, USERPROFILE: home }, stdout: "pipe", stderr: "pipe" });
  const lines = r.stdout.toString().split("\n").filter((l) => l.includes("A_TOKEN: это битая ссылка"));
  expect(lines.map((l) => l.trim())).toEqual([`файл секрета A_TOKEN: это битая ссылка — не перезаписываю (исправьте или удалите её) (${config}/local/secrets/A_TOKEN)`]);
}, 60000);

// Повторная проверка 8 круга 8b: doctor о файле секрета-ссылке, который не читается (ссылка на каталог), — те же слова, что
// план sync: «значение … другое или файл не читается — проверьте цель ссылки»
test.skipIf(!can.dir)("doctor: файл секрета — ссылка на каталог — «файл не читается — проверьте цель ссылки»", () => {
  const root = tmp("acl8b-tok6-");
  const local = `${root}/config/local`;
  mkdirSync(`${local}/secrets`, { recursive: true });
  mkdirSync(`${root}/elsewhere/dir`, { recursive: true });
  link("dir", `${root}/elsewhere/dir`, `${local}/secrets/TOKEN`);
  const doc = checkSecretFiles(new Map([["TOKEN", ["claude p"]]]), { TOKEN: "v" }, [], `${local}/secrets`).problems.filter((p) => p.startsWith("TOKEN:"));
  expect(doc).toEqual(["TOKEN: файл секрета — ссылка: miksy её не перезаписывает (значение в secrets.env другое или файл не читается — проверьте цель ссылки)"]);
}, 60000);
