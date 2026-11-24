// Круг 11t: doctor «Значение секрета в настройке, записанной не miksy» — что сделать, и это работает: Claude --global
// и Codex-проект — sync --force; глобальный Codex (TOML) — удалить таблицу вручную, затем sync --global (adopt такое
// имя не берёт: оно уже есть в слое)
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { cliFixture, expectCode, put } from "./helpers";

const PLAIN = "plainsecretvalue99";
const SERVER = "name: tok\ncommand: tok-server\nenv:\n  TOKEN: ${MYTOK}\n";
const TABLE = `[mcp_servers.tok]\ncommand = "tok-server"\n\n[mcp_servers.tok.env]\nTOKEN = "${PLAIN}"\n`;
const HEAD = "Значение секрета в настройке, записанной не miksy (1) — sync её не трогает (конфликт), и значение лежит в конфиге агента открытым текстом. Что сделать — в конце каждой строки";
const WHY = "записан не miksy, а в нём открытым текстом значение секрета MYTOK — похоже, его записала старая версия miksy на машине без учёта (новая машина или конфигурация без local/state/manifest.json). Ничего не потеряется: значение уже лежит в local/secrets.env, а miksy запишет сервер, который берёт его оттуда при запуске. Что сделать: ";

function fixture(layer: string, file: (f: ReturnType<typeof cliFixture>) => string, text: string) {
  const f = cliFixture({ agents: ["claude", "codex"] });
  put(`${f.config}/local/secrets.env`, `MYTOK=${PLAIN}\n`);
  put(`${f.config}/layers/${layer}/mcp/tok.yaml`, SERVER);
  put(file(f), text);
  return f;
}

// Команда из конца строки doctor — та, что выполняется
const advice = (out: string) => out.split("\n").find((l) => l.includes("Что сделать: "))!.split("Что сделать: ")[1];

describe("значение секрета в настройке, записанной не miksy (круг 11t)", () => {
  test("Claude --global: заголовок понятный, команда в строке убирает значение из файла", () => {
    const f = fixture("global", (f) => `${f.home}/.claude.json`, JSON.stringify({ mcpServers: { tok: { type: "stdio", command: "tok-server", args: [], env: { TOKEN: PLAIN } } } }));
    expectCode(f.run(["sync", "--global", "--yes"]), 3);
    const d = f.run(["doctor"]).out;
    expect(d).toContain(HEAD);
    expect(d).toContain(`.claude.json ["mcpServers"].tok: ${WHY}miksy sync --global --agent claude --force (файл уйдёт в бэкап, значение секрета в бэкап не попадёт)`);
    expect(d).not.toContain("вне учёта");
    expect(d).not.toContain(PLAIN);
    const cmd = advice(d).split(" (")[0].split(" ").slice(1);
    expectCode(f.run(cmd), 0);
    expect(readFileSync(`${f.home}/.claude.json`, "utf8")).not.toContain(PLAIN);
    expect(f.run(["doctor"]).out).not.toContain("записанной не miksy");
  }, 60000);

  test("Codex-проект: команда sync <проект> --force убирает значение из .codex/config.toml", () => {
    const f = fixture("tree", (f) => `${f.ws}/Org/p1/.codex/config.toml`, TABLE);
    expectCode(f.run(["sync", "--all", "--yes"]), 3);
    const d = f.run(["doctor"]).out;
    expect(d).toContain(HEAD);
    expect(d).toContain(`.codex/config.toml: ${WHY}miksy sync "${f.ws}/Org/p1" --agent codex --force`);
    expectCode(f.run(["sync", `${f.ws}/Org/p1`, "--agent", "codex", "--force"]), 0);
    expect(readFileSync(`${f.ws}/Org/p1/.codex/config.toml`, "utf8")).not.toContain(PLAIN);
    expect(f.run(["doctor"]).out).not.toContain("записанной не miksy");
  }, 60000);

  test("глобальный Codex: не adopt (он такое имя не берёт), а удалить таблицу и sync --global — это работает", () => {
    const toml = (f: ReturnType<typeof cliFixture>) => `${f.home}/.codex/config.toml`;
    const f = fixture("global", toml, `model = "x"\n\n${TABLE}`);
    const s = f.run(["sync", "--global", "--yes"]);
    expectCode(s, 3);
    // Конфликт sync: не adopt, а что удалить и что запустить
    expect(s.out).toContain(`config.toml mcp_servers.tok: TOML: сервер tok здесь записал не miksy — miksy его не трогает (и с --force). Чтобы miksy записал свой из слоя, удалите из файла таблицу [mcp_servers.tok] вместе с подтаблицами [mcp_servers.tok.…], затем miksy sync --global`);
    expect(s.out).not.toContain("adopt");
    const d = f.run(["doctor"]).out;
    expect(d).toContain(HEAD);
    expect(d).toContain(`config.toml mcp_servers.tok: ${WHY}удалите из ${toml(f)} таблицу [mcp_servers.tok] вместе с подтаблицами [mcp_servers.tok.…], затем выполните miksy sync --global — miksy запишет свой сервер`);
    // adopt такое имя действительно не берёт — поэтому совет не про него
    expect(f.run(["adopt", "--global", "tok", "--to", "global", "--agent", "codex"]).err).toContain("нет среди добавок");
    // Совет выполним: таблицы убраны вручную — sync --global записывает сервер miksy, значение уходит
    writeFileSync(toml(f), 'model = "x"\n');
    expectCode(f.run(["sync", "--global"]), 0);
    const after = readFileSync(toml(f), "utf8");
    expect(after).not.toContain(PLAIN);
    expect(after).toContain("# >>> miksy");
    expect(after).toContain("tok-stdio-");
    expect(after).toContain('model = "x"');
    expect(f.run(["doctor"]).out).not.toContain("записанной не miksy");
  }, 60000);
});
