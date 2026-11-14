// Выпуск 0.2.2, круг 8e, F6 (проверка 8d, находка 6): защита тестов.
// - Запись в этом же процессе мимо песочницы и системного tmp (мастер, команды через runCommand, помощники тестов)
//   останавливается до записи: ошибка и отметка (preload роняет прогон в конце). Путь — безобидный: временная папка в
//   out/ движка (каталог для временного, вне git); системный tmp замок разрешает, поэтому проба — не в нём. Уборка —
//   если замок сломан и папка появилась.
// - Мастер под песочницей не предлагает workspace вне неё: от настоящего движка — ничего; песочная копия раскладки — её
//   корень.
// - Второй замок на настоящий PATH: запуск PowerShell или setx, который пишет HKCU\Environment, останавливается
//   (проверяется сама проверка, без запуска).
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENGINE } from "../src/load";
import { defaultWorkspace } from "../src/setup";
import { fsViolations } from "./fsguard";
import { userEnvironmentWrite } from "./guard";

test("F6: запись файла вне песочницы в этом процессе — ошибка до записи, файла нет", () => {
  // out/ движка: не песочница и не tmp. Каталога нет и с замком не появится — отказ раньше записи
  const probe = join(ENGINE, "out", `guard-probe-${process.pid}`);
  const outside = join(probe, "x.txt");
  const before = fsViolations.length;
  const errs: string[] = [];
  try {
    for (const write of [() => mkdirSync(probe, { recursive: true }), () => writeFileSync(outside, "x")])
      try { write(); } catch (e) { errs.push((e as Error).message); }
  } finally {
    // Замок сломан — убрать пробу (rmSync тогда не остановлен)
    if (existsSync(probe)) try { rmSync(probe, { recursive: true, force: true }); } catch { /* замок цел — пробы нет */ }
  }
  const seen = fsViolations.splice(before); // отметки этого теста — ожидаемые: прогон из-за них не падает
  expect({
    errs: errs.map((e) => /^ОСТАНОВЛЕНО \(test\/fsguard\.ts\): (writeFileSync|mkdirSync): .* — запись мимо песочницы$/.test(e)),
    seen: seen.length, exists: existsSync(probe),
  }).toEqual({ errs: [true, true], seen: 2, exists: false });
});

test("F6: запись в песочницу и во временную папку — как обычно", () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "f6-")));
  writeFileSync(join(dir, "ok.txt"), "x");
  expect(existsSync(join(dir, "ok.txt"))).toBe(true);
});

test("F6: workspace мастера по умолчанию под песочницей — не вне её", () => {
  const box = realpathSync.native(process.env.MIKSY_TEST_SANDBOX!).replaceAll("\\", "/").toLowerCase();
  const real = defaultWorkspace(ENGINE, process.env.HOME!);
  // Песочная копия раскладки владельца <ws>/home/Miksy/{miksy,miksy-config}: её корень — внутри песочницы
  const ws = realpathSync.native(mkdtempSync(join(tmpdir(), "f6ws-"))).replaceAll("\\", "/");
  for (const d of ["home/Miksy/miksy", "home/Miksy/miksy-config", "Org/p1"]) mkdirSync(`${ws}/${d}`, { recursive: true });
  const copy = defaultWorkspace(`${ws}/home/Miksy/miksy`, process.env.HOME!);
  expect({ real: real === null || real.toLowerCase().startsWith(box), copy: copy?.toLowerCase() }).toEqual({ real: true, copy: ws.toLowerCase() });
});

test("F6: второй замок — PowerShell или setx, которые пишут HKCU\\Environment, останавливаются; чтение — нет", () => {
  const ps = (s: string) => ["powershell", "-NoProfile", "-NonInteractive", "-Command", s];
  expect({
    set: !!userEnvironmentWrite(ps("[Microsoft.Win32.Registry]::SetValue('HKEY_CURRENT_USER\\Environment', 'Path', $env:X, 'ExpandString')")),
    notify: !!userEnvironmentWrite(ps("[Environment]::SetEnvironmentVariable('MIKSY_SETUP_NOTIFY', $null, 'User')")),
    setx: !!userEnvironmentWrite(["C:\\Windows\\System32\\setx.exe", "PATH", "x"]),
    read: !!userEnvironmentWrite(ps("(Get-Item HKCU:\\Environment).GetValue('Path', '', 'DoNotExpandEnvironmentNames')")),
    machine: !!userEnvironmentWrite(ps("[Environment]::GetEnvironmentVariable('Path', 'Machine')")),
  }).toEqual({ set: true, notify: true, setx: true, read: false, machine: false });
});

// Рецензия 8e, №3, №4: обходы замка — асинхронные функции, Bun.write(Bun.file()), open с флагами, ссылка из песочницы
// наружу (на каталог и висячая на файл) — остановлены; удалить саму ссылку песочницы, ведущую наружу, — можно. Проба —
// каталог в out/ движка (замок его не пускает); создание и уборка — подпроцессом
test("F6: обходы замка — асинхронные функции, Bun.write, open, ссылки наружу — остановлены; удаление ссылки — нет", async () => {
  const fsm = require("node:fs") as typeof import("node:fs");
  const fsp = require("node:fs/promises") as typeof import("node:fs/promises");
  const win = process.platform === "win32";
  const probe = join(ENGINE, "out", `guard-probe2-${process.pid}`);
  const nat = (p: string) => p.replaceAll("/", "\\");
  const sh = (cmd: string) => Bun.spawnSync(win ? ["cmd", "/c", cmd] : ["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
  const box = realpathSync.native(mkdtempSync(join(tmpdir(), "f6l-")));
  sh(win ? `mkdir "${nat(probe)}"` : `mkdir -p '${probe}'`);
  const before = fsViolations.length;
  const res: Record<string, string> = {};
  const tryIt = async (name: string, f: () => unknown) => {
    let err = "";
    try { await f(); } catch (e) { err = (e as Error).message; }
    res[name] = err.startsWith("ОСТАНОВЛЕНО") ? "остановлено" : `пропущено: ${err.slice(0, 60)}`;
  };
  let unlink = "";
  try {
    await tryIt("promises.writeFile", () => fsp.writeFile(join(probe, "a"), "x"));
    await tryIt("fs.writeFile", () => new Promise<void>((ok, no) => fsm.writeFile(join(probe, "b"), "x", (e) => (e ? no(e) : ok()))));
    await tryIt("createWriteStream", () => fsm.createWriteStream(join(probe, "c")));
    await tryIt("promises.copyFile", () => fsp.copyFile(join(ENGINE, "package.json"), join(probe, "d")));
    await tryIt("Bun.write(Bun.file)", () => Bun.write(Bun.file(join(probe, "e")), "x"));
    await tryIt("Bun.file().write", () => Bun.file(join(probe, "e2")).write("x"));
    await tryIt("Bun.file().writer", () => { const w = Bun.file(join(probe, "e3")).writer(); w.write("x"); return w.end(); });
    await tryIt("openSync O_CREAT", () => fsm.closeSync(fsm.openSync(join(probe, "f"), fsm.constants.O_CREAT | fsm.constants.O_WRONLY)));
    fsm.symlinkSync(probe, join(box, "j"), win ? "junction" : "dir");
    await tryIt("через ссылку на каталог", () => fsm.writeFileSync(join(box, "j", "g"), "x"));
    fsm.symlinkSync(join(probe, "h"), join(box, "dangling"), "file");
    await tryIt("через висячую ссылку", () => fsm.writeFileSync(join(box, "dangling"), "x"));
    try { if (win) fsm.rmdirSync(join(box, "j")); else fsm.unlinkSync(join(box, "j")); unlink = "убрана"; } catch (e) { unlink = (e as Error).message.slice(0, 80); }
  } finally {
    sh(win ? `rmdir /s /q "${nat(probe)}"` : `rm -rf '${probe}'`);
  }
  fsViolations.splice(before);
  expect({ res, unlink, probe: existsSync(probe) }).toEqual({
    res: Object.fromEntries(["promises.writeFile", "fs.writeFile", "createWriteStream", "promises.copyFile", "Bun.write(Bun.file)", "Bun.file().write", "Bun.file().writer", "openSync O_CREAT", "через ссылку на каталог", "через висячую ссылку"].map((k) => [k, "остановлено"])),
    unlink: "убрана", probe: false,
  });
}, 60000);

// Рецензия 8e, №5: второй замок узнаёт формы записи HKCU\Environment (без запуска)
test("F6: второй замок — reg add, cmd /c setx, [EnvironmentVariableTarget]::User, *-ItemProperty, Registry::, OpenSubKey", () => {
  const ps = (s: string) => ["powershell.exe", "-NoProfile", "-Command", s];
  const cases = [
    ["reg.exe", "add", "HKCU\\Environment", "/v", "Path", "/d", "x", "/f"],
    ["cmd", "/c", "setx PATH x"],
    ps("[Environment]::SetEnvironmentVariable('Path', 'x', [EnvironmentVariableTarget]::User)"),
    ps("New-ItemProperty -Path HKCU:\\Environment -Name Path -Value x -Force"),
    ps("Set-ItemProperty -Path 'Registry::HKEY_CURRENT_USER\\Environment' -Name Path -Value x"),
    ps("[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true).SetValue('Path', 'x')"),
  ];
  expect(cases.map((c) => !!userEnvironmentWrite(c))).toEqual(cases.map(() => true));
  expect(!!userEnvironmentWrite(["reg.exe", "query", "HKCU\\Environment", "/v", "Path"])).toBe(false);
});
