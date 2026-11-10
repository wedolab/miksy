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
// Так же — переменные git, которые указывают на чужой репо, индекс или каталог (IDE, хуки git) или задают
// настройки git окружением машины (GIT_CONFIG_COUNT/KEY_n/VALUE_n, GIT_CONFIG_PARAMETERS — как «-c»)
for (const k of Object.keys(process.env))
  if (/^(BUN_INSTALL|CODEX_HOME|CLAUDE_CONFIG_DIR|OPENCODE_CONFIG(_DIR)?|GEMINI_CLI_HOME|XDG_[A-Z_]+|GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|CEILING_DIRECTORIES|CONFIG|CONFIG_GLOBAL|CONFIG_SYSTEM|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|CONFIG_PARAMETERS|TEMPLATE_DIR))$/i.test(k)) delete process.env[k];
// git в тестах (и движок под тестом) не читает настройки машины: системный конфиг выключен, глобальный — пустой
// файл песочницы (а не ~/.gitconfig пользователя: глобальный gitignore прятал бы файлы, которые тест проверяет)
Object.assign(process.env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, ".gitconfig") });
if (!inside(homeDir(), canonical(sandbox))) throw new Error("Тесты остановлены: домашний каталог вне песочницы");
if (!inside(configRoot(), canonical(sandbox))) throw new Error("Тесты остановлены: конфигурация вне песочницы");
installGuard(real, [sandbox, systemTmp]);

// Песочница всех тестов: на медленном диске (раннеры GitHub Windows) удаление дольше стандартных 5 с
afterAll(() => rmSync(sandbox, { recursive: true, force: true }), 120000);
