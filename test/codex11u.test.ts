// Круг 11u: чужой сервер Codex в ~/.codex/config.toml с именем из слоя — miksy берёт его командой
// `miksy sync --global --agent codex --force`: бэкап без значения секрета, таблица заменена определением из слоя,
// текст вне блока цел побайтно; одинаковая таблица — под учёт молча; блок miksy без учёта — так же
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cliFixture, expectCode, put } from "./helpers";
import { replaceTomlBlock, splitToml } from "../src/toml";

const PLAIN = "plainsecretvalue99";
const SERVER = "name: tok\ncommand: tok-server\nenv:\n  TOKEN: ${MYTOK}\n";
const HEAD = '# мои настройки\r\nmodel = "x" # комментарий\r\n\r\n[projects."C:/w"]\r\ntrust_level = "trusted"\r\n\r\n';
const TABLE = `[mcp_servers.tok]\ncommand = "tok-server"\nargs = ["--old"]\n\n[mcp_servers.tok.env]\nTOKEN = "${PLAIN}"\n`;
const TAIL = '\n[features]\nshell_tool = true\n';
const FORCE = "miksy sync --global --agent codex --force";

function fixture(text: string) {
  const f = cliFixture({ agents: ["codex"] });
  put(`${f.config}/local/secrets.env`, `MYTOK=${PLAIN}\n`);
  put(`${f.config}/layers/global/mcp/tok.yaml`, SERVER);
  const file = `${f.home}/.codex/config.toml`;
  put(file, text);
  return { ...f, file };
}

// Все файлы под каталогом (бэкапы запусков и originals)
function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]);
}

describe("чужая таблица Codex с именем из слоя (круг 11u)", () => {
  test("без --force — конфликт с именами отличающихся полей и командой; --force — захват с бэкапом, текст вне блока цел", () => {
    const f = fixture(HEAD + TABLE + TAIL);
    const s = f.run(["sync", "--global", "--yes"]);
    expectCode(s, 3);
    expect(s.out).toContain(`mcp_servers.tok: TOML: сервер tok здесь записал не miksy, и он отличается от слоя (поля: args, command, env). Заменить определением из слоя: ${FORCE} (бэкап файла будет)`);
    expect(s.out + s.err).not.toContain(PLAIN);
    expect(readFileSync(f.file, "utf8")).toBe(HEAD + TABLE + TAIL);

    // doctor: что сделать — та же команда; файл не повторяется в «Значения секретов в конфигах агентов» («sync заменит»)
    const d = f.run(["doctor"]).out;
    expect(d).toContain(`config.toml mcp_servers.tok: записан не miksy, а в нём открытым текстом значение секрета MYTOK`);
    expect(d).toContain(`Что сделать: ${FORCE} (файл уйдёт в бэкап, значение секрета в бэкап не попадёт)`);
    expect(d).toContain("поля: args, command, env");
    expect(d).not.toContain("Значения секретов в конфигах агентов");
    expect(d).not.toContain(PLAIN);

    // План с --force виден заранее (--dry-run) и ничего не меняет
    const dry = f.run(["sync", "--global", "--agent", "codex", "--force", "--dry-run"]);
    expect(dry.out).toContain("блок TOML");
    expect(readFileSync(f.file, "utf8")).toBe(HEAD + TABLE + TAIL);

    const w = f.run(FORCE.split(" ").slice(1));
    expectCode(w, 0);
    const text = readFileSync(f.file, "utf8");
    expect(text).not.toContain(PLAIN);
    // Текст вне блока — побайтно прежний без чужой таблицы
    // (пустая строка после чужой таблицы — часть её раздела до следующего заголовка, уходит вместе с ней)
    expect(splitToml(text).outside).toBe(HEAD + TAIL.slice(1));
    const tok = (Bun.TOML.parse(text) as any).mcp_servers.tok;
    expect(tok.command).toContain("tok-stdio-");
    expect(tok.env).toBeUndefined();
    // Бэкап есть, значения секрета нет ни в одном файле бэкапов (запуски и originals)
    const backups = files(`${f.config}/local/backups`);
    expect(backups.some((p) => p.replaceAll("\\", "/").endsWith(".codex/config.toml"))).toBe(true);
    for (const p of backups) expect(readFileSync(p, "utf8")).not.toContain(PLAIN);
    expect(backups.map((p) => readFileSync(p, "utf8")).some((t) => t.includes("<secret:MYTOK>"))).toBe(true);

    // Повторный sync стабилен, doctor чист
    const again = f.run(["sync", "--global"]);
    expectCode(again, 0);
    expect(again.out).toContain("изменений нет");
    expect(readFileSync(f.file, "utf8")).toBe(text);
    const d2 = f.run(["doctor"]).out;
    expect(d2).not.toContain("записанной не miksy");
    expect(d2).not.toContain("Значения секретов в конфигах агентов");
  }, 90000);

  test("одинаковая таблица — под учёт молча, без --force", () => {
    const f = fixture(HEAD);
    expectCode(f.run(["sync", "--global"]), 0);
    const written = readFileSync(f.file, "utf8");
    // Учёт забыт (новая машина): таблица та же, но блок — уже не miksy по учёту; маркеры тоже убраны
    const plain = splitToml(written);
    writeFileSync(f.file, plain.before + plain.block.replace(/^\n/, "").replace(/^# [<>]{3} miksy.*\r?\n/gm, "") + plain.after);
    const ledger = `${f.config}/local/state/manifest.json`;
    const m = JSON.parse(readFileSync(ledger, "utf8"));
    for (const t of Object.values(m.targets) as any[]) delete t.toml;
    writeFileSync(ledger, JSON.stringify(m));
    const s = f.run(["sync", "--global"]);
    expectCode(s, 0);
    expect(s.out).not.toContain("КОНФЛИКТ");
    expect(readFileSync(f.file, "utf8")).toBe(written);
    expect(f.run(["sync", "--global"]).out).toContain("изменений нет");
  }, 90000);

  test("блок miksy без учёта: отличается — конфликт с командой; --force берёт, чужие таблицы блока остаются; повтор стабилен", () => {
    const f = fixture(HEAD);
    const block = replaceTomlBlock(splitToml(HEAD), { tok: { command: "old-wrapper", env: { TOKEN: PLAIN } }, mine: { command: "my-server" } });
    writeFileSync(f.file, block);
    const s = f.run(["sync", "--global"]);
    expectCode(s, 3);
    expect(s.out).toContain(`TOML: в файле блок miksy, а учёта его на этой машине нет (новая машина или учёт забыт), и он отличается от слоя. Взять его: ${FORCE} (бэкап файла будет; таблицы блока, которых нет в слое, останутся в файле как есть)`);
    expect(s.out).not.toContain("adopt");
    expect(readFileSync(f.file, "utf8")).toBe(block);
    const d = f.run(["doctor"]).out;
    expect(d).toContain(`Что сделать: ${FORCE}`);
    expect(d).not.toContain("Значения секретов в конфигах агентов");

    expectCode(f.run(FORCE.split(" ").slice(1)), 0);
    const text = readFileSync(f.file, "utf8");
    expect(text).not.toContain(PLAIN);
    expect(text.startsWith(HEAD)).toBe(true);
    const doc = Bun.TOML.parse(text) as any;
    expect(doc.mcp_servers.mine).toEqual({ command: "my-server" });
    expect(doc.mcp_servers.tok.command).toContain("tok-stdio-");
    expect(Object.keys(splitToml(text).servers)).toEqual(["tok"]);
    for (const p of files(`${f.config}/local/backups`)) expect(readFileSync(p, "utf8")).not.toContain(PLAIN);
    // Повтор: без конфликтов и правок; таблица mine — добавка агента (adopt), а не конфликт
    const again = f.run(["sync", "--global"]);
    expectCode(again, 0);
    expect(again.out).toContain("изменений нет");
    expect(readFileSync(f.file, "utf8")).toBe(text);
  }, 90000);
});
