// Защита прогона (test/guard.ts): запуск CLI с записью, который целится в настоящие HOME, конфигурацию
// или workspace, — останавливает прогон, какие бы переменные ни понимала запускаемая версия
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Real, unsafeSpawn } from "./guard";
import { put } from "./helpers";

// «Настоящее» окружение и песочница — оба во временном каталоге, но песочница — только safe
function world() {
  const root = mkdtempSync(join(tmpdir(), "guard-")).replaceAll("\\", "/");
  const realHome = `${root}/real/home`, realWs = `${root}/real/ws`, realCfg = `${root}/real/ws/home/Miksy/miksy-config`;
  const safe = `${root}/sandbox`;
  put(`${realCfg}/map.yaml`, "global: []\n");
  put(`${realCfg}/local/machine.yaml`, `workspace: ${realWs}\n`);
  put(`${realHome}/.keep`, "");
  const real: Real = { home: [realHome], configs: [realCfg], workspaces: [realWs] };
  const box = { home: `${safe}/home`, config: `${safe}/config`, ws: `${safe}/ws`, engine: `${safe}/engine` };
  put(`${box.config}/map.yaml`, "global: []\n");
  put(`${box.config}/local/machine.yaml`, `workspace: ${box.ws}\n`);
  put(`${box.engine}/src/cli.ts`, "");
  const env = { HOME: box.home, USERPROFILE: box.home, MIKSY_CONFIG: box.config };
  return { root, real, safe: [safe], box, env, realCfg, realWs, realHome };
}

describe("guard: запуск CLI в тесте", () => {
  test("песочница целиком — можно; команды без записи не проверяются", () => {
    const w = world();
    expect(unsafeSpawn(["bun", `${w.box.engine}/src/cli.ts`, "sync", "--all", "--yes"], { env: w.env }, w.real, w.safe)).toBeNull();
    expect(unsafeSpawn(["bun", `${w.box.engine}/src/cli.ts`, "doctor"], { env: { HOME: w.realHome } }, w.real, w.safe)).toBeNull();
    expect(unsafeSpawn(["git", "status"], {}, w.real, w.safe)).toBeNull();
  });

  test("песочная конфигурация, а в ней workspace — настоящий", () => {
    const w = world();
    // setup песочной конфигурации записал workspace по умолчанию от пути движка — настоящий
    const leak = `${w.safe[0]}/preload-config`;
    put(`${leak}/map.yaml`, "global: []\n");
    put(`${leak}/local/machine.yaml`, `workspace: ${w.realWs}\n`);
    const why = unsafeSpawn(["bun", `${w.box.engine}/src/cli.ts`, "sync", "--all", "--yes"], { env: { ...w.env, MIKSY_CONFIG: leak } }, w.real, w.safe);
    expect(why).toContain("workspace");
    expect(why).toContain("настоящий");
  });

  test("без переменных нашёлся бы соседний miksy-config — настоящий", () => {
    const w = world();
    const engine = `${w.realWs}/home/Miksy/miksy`;
    put(`${engine}/src/cli.ts`, "");
    const why = unsafeSpawn(["bun", `${engine}/src/cli.ts`, "sync", "--global"], { env: { HOME: w.box.home, USERPROFILE: w.box.home } }, w.real, w.safe);
    expect(why).toContain("miksy-config");
  });

  test("настоящий HOME, путь в аргументах, --out и каталог команды setup", () => {
    const w = world();
    const cli = `${w.box.engine}/src/cli.ts`;
    expect(unsafeSpawn(["bun", cli, "sync", "--global"], { env: { ...w.env, HOME: w.realHome, USERPROFILE: w.realHome } }, w.real, w.safe)).toContain("HOME");
    expect(unsafeSpawn(["bun", cli, "clean", `${w.realWs}/Org/p1`], { env: w.env }, w.real, w.safe)).toContain("путь в аргументах");
    expect(unsafeSpawn(["bun", cli, "sync", "--global", "--out", `${w.root}/real/out`], { env: w.env }, w.real, w.safe)).toContain("--out");
    expect(unsafeSpawn(["bun", cli, "setup", "--yes"], { env: { ...w.env, BUN_INSTALL: `${w.realHome}/.bun` } }, w.real, w.safe)).toContain("BUN_INSTALL");
    // без HOME процесс взял бы настоящий
    expect(unsafeSpawn(["bun", cli, "sync", "--global"], { env: { MIKSY_CONFIG: w.box.config } }, w.real, w.safe)).toContain("HOME");
  });

  test("update: только копия движка в песочнице (он меняет git-клон движка и запускает setup)", () => {
    const w = world();
    // Настоящий движок (рядом с настоящей конфигурацией в настоящем workspace) — даже update --check
    const engine = `${w.realWs}/home/Miksy/miksy`;
    put(`${engine}/src/cli.ts`, "");
    expect(unsafeSpawn(["bun", `${engine}/src/cli.ts`, "update", "--check"], { env: w.env }, w.real, w.safe)).toContain("движок");
    // Движок вне песочницы — тоже
    put(`${w.root}/elsewhere/src/cli.ts`, "");
    expect(unsafeSpawn(["bun", `${w.root}/elsewhere/src/cli.ts`, "update", "--yes"], { env: w.env }, w.real, w.safe)).toContain("вне песочницы");
    // Каталог команды miksy — как у setup
    expect(unsafeSpawn(["bun", `${w.box.engine}/src/cli.ts`, "update", "--yes"], { env: { ...w.env, BUN_INSTALL: `${w.realHome}/.bun` } }, w.real, w.safe)).toContain("BUN_INSTALL");
    expect(unsafeSpawn(["bun", `${w.box.engine}/src/cli.ts`, "update", "--yes"], { env: w.env }, w.real, w.safe)).toBeNull();
  });

  test("установленный guard останавливает прогон до запуска процесса", () => {
    const w = world();
    const marker = `${w.root}/ran`;
    // «CLI», который при запуске оставил бы метку
    put(`${w.realWs}/home/Miksy/miksy/src/cli.ts`, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x");`);
    const script = `${w.root}/run.ts`;
    put(script, `import { installGuard } from ${JSON.stringify(resolve(import.meta.dir, "guard.ts").replaceAll("\\", "/"))};
installGuard(${JSON.stringify(w.real)}, ${JSON.stringify(w.safe)});
Bun.spawnSync([process.execPath, ${JSON.stringify(`${w.realWs}/home/Miksy/miksy/src/cli.ts`)}, "sync", "--all"], { env: { HOME: ${JSON.stringify(w.box.home)}, USERPROFILE: ${JSON.stringify(w.box.home)} } });
`);
    const r = Bun.spawnSync([process.execPath, script], { stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(97);
    expect(r.stderr.toString()).toContain("ОСТАНОВЛЕНО");
    expect(existsSync(marker)).toBe(false);
  });
});
