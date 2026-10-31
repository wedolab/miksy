import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { ENGINE } from "../src/load";
import { canonical } from "../src/paths";
import { defaultWorkspace, unsafeWorkspace } from "../src/setup";
import { cliFixture, put } from "./helpers";

test("setup: Unix-пути разного регистра не считаются одним домом", () => {
  expect(unsafeWorkspace("/miksy-no-such-volume/HOME", "/miksy-no-such-volume/home")).toBeNull();
});

test("R7: плоская раскладка с единственным miksy не поднимается выше workspace", () => {
  const f = cliFixture();
  const engine = `${f.home}/ai/miksy`;
  mkdirSync(engine, { recursive: true });
  expect(defaultWorkspace(engine, f.home)).toBe(canonical(`${f.home}/ai`));
  const elsewhere = `${f.dir}/X/tmp/miksy`;
  mkdirSync(elsewhere, { recursive: true });
  expect(defaultWorkspace(elsewhere, f.home)).toBe(canonical(`${f.dir}/X/tmp`));
  // С14: движок и конфигурация рядом с проектами — плоская раскладка, а не группа
  for (const d of ["miksy", "miksy-config", "proj"]) mkdirSync(`${f.home}/work/ai/${d}`, { recursive: true });
  expect(defaultWorkspace(`${f.home}/work/ai/miksy`, f.home)).toBe(canonical(`${f.home}/work/ai`));
});

function setupCopy() {
  const f = cliFixture();
  const engine = `${f.home}/ai # personal/miksy`;
  mkdirSync(engine, { recursive: true });
  for (const dir of ["src", "adapters", "examples"]) cpSync(`${ENGINE}/${dir}`, `${engine}/${dir}`, { recursive: true });
  const config = `${f.dir}/new # config`;
  const run = (explicit = true) => {
    const env = { ...process.env, HOME: f.home, USERPROFILE: f.home, MIKSY_CONFIG: config };
    delete env.BUN_INSTALL;
    if (!explicit) { delete env.MIKSY_CONFIG; }
    const r = Bun.spawnSync([process.execPath, `${engine}/src/cli.ts`, "setup", "--yes", "--force"], { cwd: f.dir, env, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  };
  return { ...f, engine, config, run };
}

test("R9: MIKSY_CONFIG без map, YAML с #, vars и бэкап, Homebrew-bun, чужой указатель", () => {
  const f = setupCopy();
  put(`${f.home}/.miksy`, "foreign-pointer\n");
  const ws = `${f.dir}/my ws #2`;
  put(`${f.config}/local/machine.yaml`, `workspace: ${JSON.stringify(ws)}\nvars:\n  CUSTOM: "keep # value"\nagents: [claude]\n`);
  const old = readFileSync(`${f.config}/local/machine.yaml`, "utf8");
  const r = f.run();
  expect(r.code).toBe(0);
  expect(existsSync(`${f.config}/map.yaml`)).toBe(true);
  const machine = Bun.YAML.parse(readFileSync(`${f.config}/local/machine.yaml`, "utf8")) as any;
  // С14: --force сохраняет workspace и agents (меняются только явным ответом)
  expect(machine.workspace).toBe(ws);
  expect(machine.agents).toEqual(["claude"]);
  expect(machine.vars.CUSTOM).toBe("keep # value");
  expect(readFileSync(`${f.home}/.miksy`, "utf8")).toBe("foreign-pointer\n");
  const backups = readdirSync(`${f.config}/local/backups`, { recursive: true }).filter((p) => String(p).endsWith("machine.yaml"));
  expect(backups.length).toBeGreaterThan(0);
  expect(backups.some((p) => readFileSync(`${f.config}/local/backups/${p}`, "utf8") === old)).toBe(true);
  const shim = `${f.home}/.bun/bin/${process.platform === "win32" ? "miksy.cmd" : "miksy"}`;
  expect(existsSync(shim)).toBe(true);
});

test("R9: setup --yes использует существующий указатель, даже без map.yaml", () => {
  const f = setupCopy();
  const pointer = `${f.home}/.miksy`;
  put(pointer, `${f.dir}/old-config\n`);
  const r = f.run(false);
  expect(r.code).toBe(0);
  expect(existsSync(`${f.dir}/old-config/map.yaml`)).toBe(true);
  expect(existsSync(`${f.engine}/../miksy-config/map.yaml`)).toBe(false);
  expect(readFileSync(pointer, "utf8")).toBe(`${f.dir}/old-config\n`);
});

test("П5: проект равный дому или содержащий дом отклоняется", () => {
  const f = cliFixture();
  put(`${f.config}/local/machine.yaml`, `workspace: ${JSON.stringify(f.dir)}\nagents: [codex]\n`);
  for (const dir of [f.home, f.dir]) {
    const r = f.run(["sync", dir, "--dry-run"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("домашний каталог");
    expect(r.out).not.toContain("записать");
  }
});
