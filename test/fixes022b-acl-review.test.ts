// Выпуск 0.2.2, круг 8b, C1 — тест рецензента A проверки 8a (out/check022/miksy/test/zz-check022a-acl-link.test.ts) без варианта v0.2.1. Проверка 0.2.2 (рецензент A, по пути сценария 1): копия «до miksy» с ссылкой на папку (dotfiles: ~/.agents/skills —
// junction) — после неё команды miksy в новом процессе падают «local/ не закрыт»: проверка прав local/ (icacls /save /t)
// идёт сквозь ссылку в копии в папку dotfiles пользователя; исправление (icacls /reset /t) — тоже
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI } from "./helpers";
import { hasTag, oldEngine } from "./fixes021b-helpers";

const win = process.platform === "win32";
const put = (p: string, s: string) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, s); };
const w = (p: string) => p.replaceAll("/", "\\");

function world(dotInHome: boolean) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "c22acl-"))).replaceAll("\\", "/");
  const home = `${root}/home`, config = `${root}/config`, ws = `${root}/ws`, dot = dotInHome ? `${home}/dotfiles` : `${root}/dotfiles`;
  put(`${config}/map.yaml`, "global:\n  - { use: global }\nlayers: []\n");
  put(`${config}/layers/global/instructions/00.md`, "# global\n");
  put(`${config}/layers/tree/instructions/00.md`, "# workspace\n");
  put(`${config}/local/machine.yaml`, `workspace: ${ws}\nagents: [claude, codex]\n`);
  mkdirSync(`${ws}/Org/p1`, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", `${ws}/Org/p1`]);
  put(`${home}/.codex/config.toml`, "model = \"o3\"\n");
  // dotfiles: ~/.agents/skills — junction на папку skills в dotfiles
  put(`${dot}/agents-skills/s1/SKILL.md`, "---\nname: s1\ndescription: s\n---\n");
  mkdirSync(`${home}/.agents`, { recursive: true });
  symlinkSync(`${dot}/agents-skills`, `${home}/.agents/skills`, "junction");
  return { root, home, config, ws, dot };
}
const run = (engine: string, o: ReturnType<typeof world>, args: string[]) => {
  const r = Bun.spawnSync([process.execPath, `${engine}/src/cli.ts`, ...args], {
    cwd: o.root, env: { ...process.env, MIKSY_CONFIG: o.config, HOME: o.home, USERPROFILE: o.home, BUN_INSTALL: `${o.root}/bun` }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString().trim() };
};
// Явная запись ACL на файле dotfiles (вне local/): «закрытие» local/ не должно её трогать
const acl = (p: string) => Bun.spawnSync(["icacls", w(p)], { stdout: "pipe" }).stdout.toString();

// Ссылка на файл (~/.claude/CLAUDE.md → dotfiles): сейчас каждая команда предупреждает «закройте вручную» о файле dotfiles (тест падает)
test.skipIf(!win)("0.2.2 (снимок): ~/.claude/CLAUDE.md — ссылка на файл dotfiles → команды не велят закрывать права файла dotfiles", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "c22aclf-"))).replaceAll("\\", "/");
  const o = { root, home: `${root}/home`, config: `${root}/config`, ws: `${root}/ws`, dot: `${root}/home/dotfiles` };
  put(`${o.config}/map.yaml`, "global:\n  - { use: global }\nlayers: []\n");
  put(`${o.config}/layers/global/instructions/00.md`, "# global\n");
  put(`${o.config}/local/machine.yaml`, `workspace: ${o.ws}\nagents: [claude]\n`);
  mkdirSync(o.ws, { recursive: true });
  put(`${o.dot}/CLAUDE.md`, "# my rules\n");
  mkdirSync(`${o.home}/.claude`, { recursive: true });
  symlinkSync(`${o.dot}/CLAUDE.md`, `${o.home}/.claude/CLAUDE.md`, "file");
  const eng = join(import.meta.dir, "..").replaceAll("\\", "/");
  const s = run(eng, o, ["setup", "--yes", "--backup"]);
  const outs = [run(eng, o, ["sync", "--global"]), run(eng, o, ["doctor"]), run(eng, o, ["sync", "--global"])].map((r) => r.out + r.err);
  expect({ setup: s.code, warned: outs.map((t) => /закройте вручную/.test(t)) }).toEqual({ setup: 0, warned: [false, false, false] });
}, 120000);

for (const [label, engine] of [["0.2.2 (снимок)", join(import.meta.dir, "..")]] as const) // вариант v0.2.1 убран: там ошибка есть, он падает (проверено, out/8b-progress.md)
  for (const inHome of [false, true])
    test.skipIf(!win || (engine === "v0.2.1" && !hasTag("v0.2.1")))(`${label}: setup --yes --backup, ~/.agents/skills — junction (dotfiles ${inHome ? "в доме" : "вне дома"}) → sync, clean, doctor`, () => {
      const eng = engine === "v0.2.1" ? oldEngine("v0.2.1") : engine.replaceAll("\\", "/");
      const o = world(inHome);
      Bun.spawnSync(["icacls", w(`${o.dot}/agents-skills/s1/SKILL.md`), "/grant", "*S-1-5-32-545:(R)"]);
      const aclBefore = acl(`${o.dot}/agents-skills/s1/SKILL.md`);
      const s = run(eng, o, ["setup", "--yes", "--backup"]);
      const g = run(eng, o, ["sync", "--global"]);
      const a = run(eng, o, ["sync", "--all", "--yes"]);
      const d = run(eng, o, ["doctor"]);
      const c = run(eng, o, ["clean", "--global"]);
      const s2 = run(eng, o, ["setup", "--yes"]);
      const aclAfter = acl(`${o.dot}/agents-skills/s1/SKILL.md`);
      expect({
        setup: s.code, copy: /копия: .*before-miksy/.test(s.out),
        sync: [g.code, g.err], all: [a.code, a.err], clean: [c.code, c.err], setupAgain: [s2.code, s2.err],
        doctor: (d.out.match(/local\/[^\n]*не закрыт[^\n]*|Небезопасные права[^\n]*/g) ?? []).join(" | "),
        dotAcl: aclAfter === aclBefore,
      }).toEqual({ setup: 0, copy: true, sync: [0, ""], all: [0, ""], clean: [0, ""], setupAgain: [0, ""], doctor: "", dotAcl: true });
    }, 300000);
