// Обход проектов и ошибки одной цели (фаза 1.6: С4, С11, С12, С15)
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { canonical } from "../src/paths";
import { cliFixture, put } from "./helpers";

const win = process.platform === "win32";
const dirLink = win ? "junction" : "dir";

test.skipIf(win)("С4: нечитаемый каталог пропускается с предупреждением, команды не падают", () => {
  const f = cliFixture({ projects: ["Org/p1", "Org/p2"] });
  const locked = [`${f.ws}/Org/p1/docker/pgdata`, `${f.ws}/locked`];
  for (const d of locked) { mkdirSync(d, { recursive: true }); chmodSync(d, 0); }
  try {
    for (const args of [["projects"], ["sync", `${f.ws}/Org/p1`, "--dry-run"], ["sync", "--all", "--dry-run"], ["doctor"]]) {
      const r = f.run(args);
      expect(r.err).not.toContain("Ошибка");
    }
    const r = f.run(["projects"]);
    expect(r.out).toContain("Org/p2");
    expect(r.out).toContain("нет доступа");
  } finally { for (const d of locked) chmodSync(d, 0o700); }
}, 60000);

test.skipIf(win)("С4: canonical различает нет доступа и цикл ссылок", () => {
  const f = cliFixture();
  mkdirSync(`${f.dir}/closed/inner`, { recursive: true });
  chmodSync(`${f.dir}/closed`, 0);
  try { expect(() => canonical(`${f.dir}/closed/inner/x`)).toThrow(/нет доступа|не раскрывается/); }
  finally { chmodSync(`${f.dir}/closed`, 0o700); }
  symlinkSync(`${f.dir}/b`, `${f.dir}/a`);
  symlinkSync(`${f.dir}/a`, `${f.dir}/b`);
  expect(() => canonical(`${f.dir}/a/x`)).toThrow(/цикл/);
});

test("С11: config/local — ссылка: репо в бэкапах не становятся проектами", () => {
  const f = cliFixture();
  const storage = `${f.ws}/storage`;
  renameSync(`${f.config}/local`, storage);
  symlinkSync(storage, `${f.config}/local`, dirLink);
  Bun.spawnSync(["git", "init", "--quiet", `${storage}/backups/old/repo`]);
  const r = f.run(["projects"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("Org/p1");
  expect(r.out).not.toContain("backups");
});

test("С15: битая ссылка .opencode одной цели — её конфликт, а не падение sync --all", () => {
  const f = cliFixture({ agents: ["opencode"], projects: ["Org/p1", "Org/p2"] });
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  const p1 = `${f.ws}/Org/p1`;
  rmSync(`${p1}/.opencode`, { recursive: true, force: true });
  symlinkSync(`${p1}/missing`, `${p1}/.opencode`, dirLink);
  put(`${f.config}/layers/tree/instructions/01.md`, "# новое правило\n");
  const r = f.run(["sync", "--all", "--dry-run"]);
  expect(r.err).not.toContain("Ошибка");
  expect(r.code).toBe(3);
  expect(r.out).toContain("Org/p2");
}, 60000);

test("С15: проект, содержащий дом, пропускается в --all и doctor с предупреждением", () => {
  const f = cliFixture();
  Bun.spawnSync(["git", "init", "--quiet", f.home]);
  put(`${f.config}/local/machine.yaml`, `workspace: ${JSON.stringify(f.dir)}\nagents: [claude]\n`);
  for (const args of [["projects"], ["sync", "--all", "--dry-run"], ["doctor"]]) {
    const r = f.run(args);
    expect(r.err).not.toContain("Ошибка");
    expect(r.out).toContain("содержит домашний каталог");
  }
  expect(f.run(["projects"]).out).toContain("ws/Org/p1");
}, 60000);

test("С12: цель, где всё — конфликты, после sync не «новая» и не «первый sync»", () => {
  const f = cliFixture({ agents: ["opencode"] });
  const p = `${f.ws}/Org/p1`;
  put(`${f.config}/layers/tree/mcp/s.yaml`, "name: s\ncommand: echo\n");
  put(`${p}/opencode.json`, '{"model": "x/y"}\n');
  Bun.spawnSync(["git", "-C", p, "add", "opencode.json"]);
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(3);
  const doctor = f.run(["doctor"]);
  expect(doctor.out).not.toContain("Конфликты первого sync");
  expect(doctor.out).not.toMatch(/opencode\.json: права/);
  expect(doctor.out).toContain("Известные конфликты");
  expect(f.run(["sync", "--all", "--dry-run"]).out).not.toContain("новые");
}, 60000);
