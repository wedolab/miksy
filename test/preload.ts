// Песочница для bun test: конфигурация miksy, домашний каталог и tmp — во временном каталоге,
// который удаляется после всех тестов. Ни один тест не должен видеть настоящие ~ и miksy-config.
import { homeDir, canonical, inside } from "../src/paths";
import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { ENGINE, configRoot } from "../src/load";
import { installGuard, realEnvironment } from "./guard";

// Настоящее окружение — до подмены: guard не даёт запуску CLI в тесте писать туда (test/guard.ts)
const real = realEnvironment({ ...process.env }, ENGINE, userInfo().homedir);
const systemTmp = tmpdir();

const sandbox = mkdtempSync(join(tmpdir(), "miksy-test-"));
const home = join(sandbox, "home");
const tmp = join(sandbox, "tmp");
const config = join(sandbox, "config");
for (const d of [home, tmp, config]) mkdirSync(d, { recursive: true });

Object.assign(process.env, {
  MIKSY_TEST_SANDBOX: sandbox,
  MIKSY_CONFIG: config,
  HOME: home,
  USERPROFILE: home,
  TMPDIR: tmp,
  TEMP: tmp,
  TMP: tmp,
});
// Внешние пути, которые ведут мимо HOME: команда miksy (setup пишет в $BUN_INSTALL/bin),
// каталоги XDG, конфиги агентов. Подпроцессы тестов наследуют окружение — убираем здесь
for (const k of Object.keys(process.env))
  if (/^(BUN_INSTALL|CODEX_HOME|CLAUDE_CONFIG_DIR|OPENCODE_CONFIG(_DIR)?|GEMINI_CLI_HOME|XDG_[A-Z_]+)$/.test(k)) delete process.env[k];
if (!inside(homeDir(), canonical(sandbox))) throw new Error("Тесты остановлены: домашний каталог вне песочницы");
if (!inside(configRoot(), canonical(sandbox))) throw new Error("Тесты остановлены: конфигурация вне песочницы");
installGuard(real, [sandbox, systemTmp]);

afterAll(() => rmSync(sandbox, { recursive: true, force: true }));
