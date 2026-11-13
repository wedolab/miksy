// Выпуск 0.2.2, круг 8b, C1 — тест рецензента A проверки 8a (zz-check022a-acl-show.test.ts) без изменений. Проверка 0.2.2 (рецензент A): показать ACL файла dotfiles до и после sync (копия «до miksy» со ссылкой на папку)
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI } from "./helpers";

const win = process.platform === "win32";
const put = (p: string, s: string) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, s); };
const w = (p: string) => p.replaceAll("/", "\\");

test.skipIf(!win)("ACL файла dotfiles вне local/ до и после sync", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "c22acls-"))).replaceAll("\\", "/");
  const home = `${root}/home`, config = `${root}/config`, dot = `${root}/dotfiles`;
  put(`${config}/map.yaml`, "global:\n  - { use: global }\nlayers: []\n");
  put(`${config}/layers/global/instructions/00.md`, "# global\n");
  put(`${config}/local/machine.yaml`, `workspace: ${root}/ws\nagents: [codex]\n`);
  mkdirSync(`${root}/ws`, { recursive: true });
  put(`${dot}/skills/s1/SKILL.md`, "---\nname: s1\ndescription: s\n---\n");
  mkdirSync(`${home}/.agents`, { recursive: true });
  symlinkSync(`${dot}/skills`, `${home}/.agents/skills`, "junction");
  Bun.spawnSync(["icacls", w(`${dot}/skills/s1/SKILL.md`), "/grant", "*S-1-5-32-545:(R)"]);
  const acl = () => Bun.spawnSync(["icacls", w(`${dot}/skills/s1/SKILL.md`)], { stdout: "pipe" }).stdout.toString().replace(/\r/g, "").split("\n").slice(0, 6).map((l) => l.trim()).filter(Boolean);
  const run = (args: string[]) => Bun.spawnSync([process.execPath, CLI, ...args], { cwd: root, env: { ...process.env, MIKSY_CONFIG: config, HOME: home, USERPROFILE: home, BUN_INSTALL: `${root}/bun` }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const before = acl();
  run(["setup", "--yes", "--backup"]);
  const s = run(["sync", "--global"]);
  const after = acl();
  writeFileSync(`${process.env.MIKSY_TEST_SANDBOX}/../c22-acl-show.txt`, `до:\n${before.join("\n")}\n\nпосле:\n${after.join("\n")}\n\nsync: ${s.exitCode}\n${s.stderr.toString()}`);
  expect(after).toEqual(before);
}, 120000);
