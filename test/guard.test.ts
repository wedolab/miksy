// Защита прогона (test/guard.ts): запуск CLI с записью, который целится в настоящие HOME, конфигурацию
// или workspace, — останавливает прогон, какие бы переменные ни понимала запускаемая версия
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Real, unsafeSpawn } from "./guard";
import { put } from "./helpers";
import { missingDrive } from "./nodrive";

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

  test("несколько корней workspace (список): настоящий среди них — остановка; realEnvironment видит все корни", async () => {
    const w = world();
    const leak = `${w.safe[0]}/roots-config`;
    put(`${leak}/map.yaml`, "global: []\n");
    put(`${leak}/local/machine.yaml`, `workspace:\n  - "${w.box.ws}"\n  - { path: "${w.realWs}", tree: Clients }\n`);
    const why = unsafeSpawn(["bun", `${w.box.engine}/src/cli.ts`, "sync", "--all", "--yes"], { env: { ...w.env, MIKSY_CONFIG: leak } }, w.real, w.safe);
    expect(why).toContain("workspace");
    expect(why).toContain("настоящий");
    const { realEnvironment } = await import("./guard");
    put(`${w.realCfg}/local/machine.yaml`, `workspace:\n  - ${w.realWs}\n  - { path: "${w.root}/real/drive", tree: X }\n`);
    expect(realEnvironment({ MIKSY_CONFIG: w.realCfg, HOME: w.realHome }, `${w.box.engine}`, w.realHome).workspaces).toEqual([w.realWs, `${w.root}/real/drive`]);
  });

  test("sync и target без пути пишут в текущий каталог — он проверяется", () => {
    const w = world();
    const cli = `${w.box.engine}/src/cli.ts`;
    expect(unsafeSpawn(["bun", cli, "sync"], { env: w.env, cwd: `${w.realWs}/Org/p1` }, w.real, w.safe)).toContain("текущий каталог");
    expect(unsafeSpawn(["bun", cli, "sync", "--dry-run", "--agent", "claude"], { env: w.env, cwd: `${w.realWs}/Org/p1` }, w.real, w.safe)).toContain("текущий каталог");
    expect(unsafeSpawn(["bun", cli, "target"], { env: w.env, cwd: `${w.realWs}/Org` }, w.real, w.safe)).toContain("текущий каталог");
    // С путём или --all/--global текущий каталог не цель
    expect(unsafeSpawn(["bun", cli, "sync", "--all", "--yes"], { env: w.env, cwd: `${w.realWs}/Org/p1` }, w.real, w.safe)).toBeNull();
    expect(unsafeSpawn(["bun", cli, "sync", `${w.box.ws}/p`], { env: w.env, cwd: `${w.realWs}/Org/p1` }, w.real, w.safe)).toBeNull();
    expect(unsafeSpawn(["bun", cli, "sync"], { env: w.env, cwd: `${w.box.ws}/p` }, w.real, w.safe)).toBeNull();
  });

  test("root: путь корня и (root add без пути) текущий каталог проверяются; корень на отсутствующем диске — отказ, а не сбой проверки", () => {
    const w = world();
    const cli = `${w.box.engine}/src/cli.ts`;
    expect(unsafeSpawn(["bun", cli, "root", "add", "--tree", "X"], { env: w.env, cwd: `${w.realWs}/Org` }, w.real, w.safe)).toContain("текущий каталог");
    expect(unsafeSpawn(["bun", cli, "root", "add", `${w.realWs}/Org`, "--tree", "X"], { env: w.env }, w.real, w.safe)).toContain("путь в аргументах");
    expect(unsafeSpawn(["bun", cli, "root", "remove", `${w.realWs}/Org`], { env: w.env }, w.real, w.safe)).toContain("путь в аргументах");
    expect(unsafeSpawn(["bun", cli, "root", "add", `${w.box.ws}/p`, "--tree", "X"], { env: w.env }, w.real, w.safe)).toBeNull();
    // Корень на диске, которого нет: проверка не падает (путь не раскрывается), запуск — не в песочнице
    const away = missingDrive();
    const leak = `${w.safe[0]}/away-config`;
    put(`${leak}/map.yaml`, "global: []\n");
    put(`${leak}/local/machine.yaml`, `workspace:\n  - "${w.box.ws}"\n  - { path: "${away}", tree: X }\n`);
    expect(unsafeSpawn(["bun", cli, "sync", "--all", "--yes"], { env: { ...w.env, MIKSY_CONFIG: leak } }, w.real, w.safe)).toContain(`${away} — вне песочницы`);
    expect(unsafeSpawn(["bun", cli, "sync", "--all", "--yes"], { env: w.env }, { ...w.real, workspaces: [...w.real.workspaces, away] }, w.safe)).toBeNull();
    // Ссылка в никуда внутри песочницы (куда поведёт запись, неизвестно) — остановка, а не пропуск и не сбой
    const target = `${w.root}/gone`, link = `${w.safe[0]}/broken`;
    put(`${target}/.keep`, "");
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    rmSync(target, { recursive: true });
    put(`${leak}/local/machine.yaml`, `workspace: "${link}"\n`);
    expect(unsafeSpawn(["bun", cli, "sync", "--all", "--yes"], { env: { ...w.env, MIKSY_CONFIG: leak } }, w.real, w.safe)).toContain(`${link} — путь не раскрывается`);
    expect(unsafeSpawn(["bun", cli, "sync", link], { env: w.env }, w.real, w.safe)).toContain("путь не раскрывается");
  });

  test("путь цели без косой (sync p1 — каталог от каталога запуска) проверяется, как и с косой (R8)", () => {
    const w = world();
    const cli = `${w.box.engine}/src/cli.ts`;
    put(`${w.realWs}/Org/p1/.keep`, "");
    expect(unsafeSpawn(["bun", cli, "sync", "p1"], { env: w.env, cwd: `${w.realWs}/Org` }, w.real, w.safe)).toContain("путь в аргументах");
    expect(unsafeSpawn(["bun", cli, "clean", "p1", "--agent", "claude"], { env: w.env, cwd: `${w.realWs}/Org` }, w.real, w.safe)).toContain("путь в аргументах");
    expect(unsafeSpawn(["bun", cli, "adopt", "p1", "srv", "--to", "Org"], { env: w.env, cwd: `${w.realWs}/Org` }, w.real, w.safe)).toContain("путь в аргументах");
    // Имя добавки у adopt --global и значения флагов — не пути
    expect(unsafeSpawn(["bun", cli, "adopt", "--global", "srv", "--to", "Org"], { env: w.env, cwd: `${w.realWs}/Org` }, w.real, w.safe)).toBeNull();
    expect(unsafeSpawn(["bun", cli, "sync", "p", "--agent", "claude"], { env: w.env, cwd: w.box.ws }, w.real, w.safe)).toBeNull();
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
