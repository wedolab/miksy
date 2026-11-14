// Выпуск 0.2.2, круг 8d, E2 (рецензия A №2 проверки 8c): откат с 0.2.2 на настоящие прежние версии на Windows, когда в
// local/ есть ссылки. Команды README «Особенности версий» дословно (блоки PowerShell раздела, путь конфигурации — путь
// песочницы): пути → 1) закрыть цели ссылок → 2) вынести копию «до miksy» → 3) проверка ссылок — пусто → команды отката
// прежней версии (setup --yes, sync --global, sync --all) — без «не закрыт», права dotfiles и целей те же → 5) возврат на
// 0.2.2, копия на место → sync, doctor без «Небезопасные права» → команда возврата копии из «Как удалить»: ссылки копии
// вернулись ссылками, содержимое dotfiles то же. Варианты: ссылка только в копии; local/backups → цель с наследованием и
// без; local/secrets → открытая и закрытая без наследования цель; сама local — ссылка. Всё — во временных каталогах
import { expect, test } from "bun:test";
import { readDocs } from "./docs";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { closeCommand, privateLocal } from "../src/secretfiles";
import { restoreCommand } from "../src/setup";
import { hasTag, oldEngine } from "./fixes021b-helpers";

const win = process.platform === "win32";
const sys = (exe: string) => join(process.env.SystemRoot ?? "C:\\Windows", "System32", exe);
const put = (p: string, s = "x\n") => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };
const nat = (p: string) => p.replaceAll("/", "\\");
const acl = (p: string) => Bun.spawnSync([sys("icacls.exe"), nat(p)], { stdout: "pipe" }).stdout.toString().split("\n").slice(0, 6).map((l) => l.trim().replace(/^\S+\s+/, "")).filter(Boolean).join("|");
const sid = () => new TextDecoder("latin1").decode(Bun.spawnSync([sys("whoami.exe"), "/user", "/fo", "csv", "/nh"], { stdout: "pipe" }).stdout).trim().match(/,"(S-[0-9-]+)"$/)![1];

// Блоки PowerShell раздела README «Windows: откат … когда в local/ есть ссылки», по порядку: пути, шаг 1, 2, 3, 5
const README = readDocs();
const section = README.slice(README.indexOf("### Windows: откат на 0.2.1, когда в local/ есть ссылки"), README.indexOf("На macOS и Linux прежние версии в ссылки не заходят"));
const blocks = [...section.matchAll(/```\n([\s\S]*?)```/g)].map((m) => m[1].split("\n").map((l) => l.trim()).filter(Boolean).join("\n"));
// Скрипт с BOM (PowerShell 5.1 читает файл без BOM в кодировке ANSI); вывод шагов — между метками
function ps(dir: string, config: string, parts: number[], tail = ""): { code: number; out: string[][] } {
  const body = parts.map((i, k) => `"=== ${k}"\n${blocks[i]}`).join("\n").replaceAll("<конфигурация>", nat(config).replace(/['‘’‚‛]/g, "$&$&") + tail);
  const file = `${dir}/step-${Math.random().toString(36).slice(2)}.ps1`;
  writeFileSync(file, "\uFEFF" + body, "utf8");
  const r = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", nat(file)], { stdout: "pipe", stderr: "pipe" });
  const out = r.stdout.toString().split(/^=== \d+\r?$/m).slice(1).map((s) => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  return { code: r.exitCode + (r.stderr.toString().trim() ? 100 : 0), out };
}

// «…, путь с \ в конце» — путь конфигурации в первой строке со «\» в конце (рецензия B круга 8d, №4); «…, цель с \ в
// конце» — цель ссылки записана со «\» в конце (`mklink /J … X\`; повторная проверка 2 круга 8d, N1)
type Variant = "копия" | "backups с наследованием" | "backups без наследования" | "secrets открыта" | "secrets без наследования" | "local целиком" | "backups без наследования, путь с \\ в конце" | "backups с наследованием, цель с \\ на конце";
const cases: [string, Variant][] = [
  ...(["копия", "backups с наследованием", "backups без наследования", "secrets открыта", "secrets без наследования", "local целиком", "backups без наследования, путь с \\ в конце", "backups с наследованием, цель с \\ на конце"] as Variant[]).map((v) => ["v0.2.1", v] as [string, Variant]),
  ["v0.2.0", "backups без наследования"], ["v0.2.0", "secrets открыта"], ["v0.1.1", "backups без наследования"], ["v0.1.1", "secrets открыта"],
];

for (const [tag, variant] of cases)
  test.skipIf(!win || !hasTag(tag))(`E2: откат 0.2.2 → ${tag}, ${variant}: шаги README дословно, затем возврат`, () => {
    expect(blocks.length).toBe(5);
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "e2rb-"))).replaceAll("\\", "/");
    const home = `${root}/home`, config = `${root}/my cfg's/config`, ws = `${root}/ws`, dot = `${root}/dotfiles`, vault = `${root}/vault`;
    put(`${config}/map.yaml`, "global:\n  - { use: global }\nlayers: []\n");
    put(`${config}/layers/global/instructions/00.md`, "# global\n");
    put(`${config}/layers/global/mcp/srv.yaml`, "name: srv\ncommand: echo\nenv:\n  A_TOKEN: ${A_TOKEN}\n");
    mkdirSync(`${ws}/Org/p1`, { recursive: true });
    Bun.spawnSync(["git", "init", "-q", `${ws}/Org/p1`]);
    put(`${home}/.codex/config.toml`, "model = \"o3\"\n");
    put(`${dot}/agents-skills/s1/SKILL.md`, "---\nname: s1\ndescription: s\n---\n");
    mkdirSync(`${home}/.agents`, { recursive: true });
    symlinkSync(`${dot}/agents-skills`, `${home}/.agents/skills`, "junction");
    // Свои права dotfiles (явная запись «Пользователи — чтение»): прежняя версия сбросила бы их
    Bun.spawnSync([sys("icacls.exe"), nat(`${dot}/agents-skills/s1/SKILL.md`), "/grant", "*S-1-5-32-545:(R)"]);
    mkdirSync(vault, { recursive: true });
    const noinherit = () => Bun.spawnSync([sys("icacls.exe"), nat(vault), "/inheritance:r", "/grant:r", `*${sid()}:F`], { stdout: "pipe" });
    if (variant === "local целиком") {
      // local — ссылка на папку на «другом томе», закрытую miksy
      privateLocal(vault);
      mkdirSync(dirname(config), { recursive: true });
      mkdirSync(config, { recursive: true });
      symlinkSync(vault, `${config}/local`, "junction");
    } else if (variant.startsWith("backups")) {
      if (variant.includes("без наследования")) noinherit(); else Bun.spawnSync(["powershell", "-NoProfile", "-Command", closeCommand(vault, true)]);
      mkdirSync(`${config}/local`, { recursive: true });
      if (variant.includes("цель с")) Bun.spawnSync(["cmd", "/d", "/c", "mklink", "/J", nat(`${config}/local/backups`), `${nat(vault)}\\`], { stdout: "pipe" });
      else symlinkSync(vault, `${config}/local/backups`, "junction");
    } else if (variant.startsWith("secrets")) {
      if (variant.includes("без наследования")) noinherit();
      mkdirSync(`${config}/local`, { recursive: true });
      symlinkSync(vault, `${config}/local/secrets`, "junction");
    }
    put(`${config}/local/machine.yaml`, `workspace: ${ws}\nagents: [claude, codex, opencode]\n`);
    put(`${config}/local/secrets.env`, "A_TOKEN=abcdef123\n");
    const env = { ...process.env, MIKSY_CONFIG: config, HOME: home, USERPROFILE: home, BUN_INSTALL: `${root}/bun` };
    const runWith = (eng: string) => (args: string[]) => {
      const r = Bun.spawnSync([process.execPath, `${eng}/src/cli.ts`, ...args], { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      return { code: r.exitCode, out: (r.stdout.toString() + r.stderr.toString()).trim() };
    };
    const now = runWith(join(import.meta.dir, "..").replaceAll("\\", "/"));
    const old = runWith(oldEngine(tag));
    expect(now(["setup", "--yes", "--backup"]).code).toBe(0);
    now(["sync", "--global"]); now(["sync", "--all", "--yes"]);
    const backups = variant.startsWith("backups") || variant === "local целиком" ? (variant === "local целиком" ? `${vault}/backups` : vault) : `${config}/local/backups`;
    const copy = readdirSync(backups).find((d) => d.startsWith("before-miksy-"))!;
    expect(lstatSync(`${backups}/${copy}/.agents/skills`).isSymbolicLink()).toBe(true);
    const dotBefore = acl(`${dot}/agents-skills/s1/SKILL.md`), dotText = readFileSync(`${dot}/agents-skills/s1/SKILL.md`, "utf8");
    // На 0.1.x — сначала её шаги («Редко: откат на 0.1.x», п. 3, 4): записанное для Antigravity убрать, в agents — gemini
    if (tag.startsWith("v0.1.")) {
      for (const a of [["clean", "--all", "--agent", "antigravity"], ["clean", "--global", "--agent", "antigravity"]]) now(a);
      // П. 3: в agents — gemini вместо antigravity (его дописал setup 0.2.2)
      const mp = variant === "local целиком" ? `${vault}/machine.yaml` : `${config}/local/machine.yaml`;
      writeFileSync(mp, readFileSync(mp, "utf8").replace(/\bantigravity\b/g, "gemini"));
    }
    // Шаги README 1–3 (с блоком путей)
    const tail = variant.endsWith("в конце") ? "\\" : "";
    const before = ps(root, config, [0, 1, 2, 3], tail);
    const vaultAfterStep1 = acl(vault);
    // Команды отката прежней версии
    const back = [old(["setup", "--yes"]), old(["sync", "--global"]), old(["sync", "--all", "--yes"])]
    const dotAfter = acl(`${dot}/agents-skills/s1/SKILL.md`), vaultAfter = acl(vault);
    // Шаг 5: снова 0.2.2 — пути, копия на место
    const ret = ps(root, config, [0, 4], tail);
    const again = [now(["setup", "--yes"]), now(["sync", "--global"])];
    const doc = now(["doctor"]);
    const copyBack = existsSync(`${backups}/${copy}`) && lstatSync(`${backups}/${copy}/.agents/skills`).isSymbolicLink();
    // Полный круг: команда возврата копии из «Как удалить» (её печатает мастер) — ссылки вернулись ссылками
    renameSync(`${home}/.agents/skills`, `${home}/.agents/skills-miksy`);
    const restore = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", restoreCommand(`${backups}/${copy}`, "windows")], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    expect({
      before: { code: before.code, closed: before.out[1].length, moved: before.out[2].length, links: before.out[3] },
      back: back.map((r) => r.code), notClosed: back.filter((r) => /не закрыт|icacls/.test(r.out)).map((r) => r.out.slice(0, 300)),
      dot: dotAfter === dotBefore, vault: vaultAfter === vaultAfterStep1,
      ret: { code: ret.code, moved: ret.out[1].length }, again: again.map((r) => (r.code === 3 ? 0 : r.code)),
      unsafe: /Небезопасные права/.test(doc.out), copyBack,
      restore: restore.exitCode, restoredLink: lstatSync(`${home}/.agents/skills`).isSymbolicLink(),
      dotText: readFileSync(`${dot}/agents-skills/s1/SKILL.md`, "utf8") === dotText, dotFinal: acl(`${dot}/agents-skills/s1/SKILL.md`) === dotBefore,
    }).toEqual({
      before: { code: 0, closed: variant === "копия" ? 0 : 1, moved: 1, links: [] },
      back: [0, 0, 0], notClosed: [], dot: true, vault: true,
      ret: { code: 0, moved: 1 }, again: [0, 0], unsafe: false, copyBack: true,
      restore: 0, restoredLink: true, dotText: true, dotFinal: true,
    });
  }, 600000);

// Рецензия B круга 8d, №3: битая ссылка local/secrets или local/backups — шаг 1 говорит «битая ссылка, цели нет», не
// «закрыта», а miksy doctor (проверка шага) — о битой ссылке
for (const which of ["secrets", "backups"])
  test.skipIf(!win)(`E2: шаг 1 — битая ссылка local/${which}: «битая ссылка, цели нет», doctor о ней`, () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "e2br-"))).replaceAll("\\", "/");
    const config = `${root}/config`, gone = `${root}/gone`, home = `${root}/home`;
    put(`${config}/map.yaml`, "global:\n  - { use: global }\nlayers: []\n");
    put(`${config}/layers/global/instructions/00.md`, "# global\n");
    put(`${config}/local/machine.yaml`, `workspace: ${root}/ws\nagents: [claude]\n`);
    mkdirSync(`${root}/ws`, { recursive: true });
    mkdirSync(gone, { recursive: true });
    symlinkSync(gone, `${config}/local/${which}`, "junction");
    Bun.spawnSync(["cmd", "/c", "rmdir", nat(gone)]);
    const step = ps(root, config, [0, 1]);
    const env = { ...process.env, MIKSY_CONFIG: config, HOME: home, USERPROFILE: home };
    const doc = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "doctor"], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    expect({ code: step.code, out: step.out[1], doctor: /битая ссылка/.test(doc.stdout.toString()) })
      .toEqual({ code: 0, out: [`битая ссылка, цели нет: ${nat(gone)}`], doctor: true });
  }, 120000);
