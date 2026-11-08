// Фаза 2а (Р1, B′): значений секретов нет ни в одном конфиге агента — ни в проекте, ни дома.
// Сквозные проверки через CLI: sync, doctor, clean. Секреты искусственные.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { aclProblem } from "../src/secretfiles";
import { cliFixture, put } from "./helpers";

const win = process.platform === "win32";
const TOKENS = {
  STDIO_TOKEN: "stdio-artificial-0001",
  PART_TOKEN: "part-artificial-0002",
  ARG_TOKEN: "arg-artificial-0003",
  HTTP_TOKEN: "http-artificial-0004",
  URL_TOKEN: "url-artificial-0005",
};
const ALL = ["claude", "codex", "opencode", "antigravity"];

// Все слои с секретами во всех местах: env целиком и частью, аргумент, заголовок, URL
function layers(f: ReturnType<typeof cliFixture>, where = "tree") {
  put(`${f.config}/layers/${where}/mcp/stdio.yaml`, [
    "name: stdio-secret", "command: npx", 'args: [-y, "@example/server", "--token=${ARG_TOKEN}"]',
    "env:", "  WHOLE: ${STDIO_TOKEN}", '  AUTH: "Bearer ${PART_TOKEN}"', "  PLAIN: plain-value", ""].join("\n"));
  put(`${f.config}/layers/${where}/mcp/http.yaml`, [
    "name: http-secret", "url: https://mcp.example.com/mcp", "headers:", '  Authorization: "Bearer ${HTTP_TOKEN}"', ""].join("\n"));
  put(`${f.config}/layers/${where}/mcp/url.yaml`, ["name: url-secret", 'url: "https://mcp.example.com/mcp?key=${URL_TOKEN}"', ""].join("\n"));
  put(`${f.config}/layers/${where}/mcp/plain.yaml`, ["name: plain", "command: echo", "args: [hi]", ""].join("\n"));
}
const secretsEnv = (f: ReturnType<typeof cliFixture>, values: Record<string, string> = TOKENS, eol = "\n") =>
  put(`${f.config}/local/secrets.env`, Object.entries(values).map(([k, v]) => `${k}=${v}`).join(eol) + eol);

// Все файлы под каталогом (без .git)
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.name === ".git") return [];
    return e.isDirectory() ? walk(p) : [p];
  });
}
// Где лежат значения: всё, что записал sync (дом, проекты, local/ кроме secrets.env, secrets/, backups/)
function leaks(f: ReturnType<typeof cliFixture>, values: string[] = Object.values(TOKENS)) {
  const files = [...walk(f.home), ...walk(f.ws), ...walk(`${f.config}/local`).filter((p) =>
    !/[\\/]local[\\/](secrets\.env|secrets[\\/]|backups[\\/]|state[\\/]manifest\.json\.bak)/.test(p))];
  return files.filter((p) => {
    const text = readFileSync(p, "utf8");
    return values.some((v) => text.includes(v));
  }).map((p) => p.replaceAll("\\", "/"));
}

describe("п.1, 3, 4, 5, 7, 9: значения секретов не попадают ни в один записанный файл", () => {
  test("глобально и в проекте, все четыре агента; конфиги ссылаются на обёртки/helper/{file:}/мост", () => {
    const f = cliFixture({ agents: ALL });
    layers(f, "global");
    layers(f, "tree");
    secretsEnv(f);
    const g = f.run(["sync", "--global"]);
    expect(g.code).toBe(0);
    const p = f.run(["sync", `${f.ws}/Org/p1`]);
    expect(p.code).toBe(0);
    expect(g.out + p.out).not.toMatch(/artificial/);
    expect(leaks(f)).toEqual([]);
    // Claude: stdio — обёртка без args/env, HTTP — headersHelper, секрет в URL — мост
    const claude = JSON.parse(readFileSync(`${f.home}/.claude.json`, "utf8"));
    expect(claude.mcpServers["stdio-secret"]).toMatchObject({ type: "stdio", args: [] });
    expect(claude.mcpServers["stdio-secret"].env).toBeUndefined();
    expect(claude.mcpServers["http-secret"].headersHelper).toBeDefined();
    expect(claude.mcpServers["http-secret"].headers).toBeUndefined();
    expect(claude.mcpServers["url-secret"].type).toBe("stdio");
    expect(claude.mcpServers.plain).toEqual({ type: "stdio", command: "echo", args: ["hi"] });
    // Codex: http_headers_helper
    expect(readFileSync(`${f.home}/.codex/config.toml`, "utf8")).toContain("http_headers_helper");
    // opencode: форма mcp.<имя>, stdio — command: [обёртка], HTTP — {file:} файла секрета
    const oc = JSON.parse(readFileSync(`${f.ws}/Org/p1/opencode.json`, "utf8"));
    expect(oc.mcp["stdio-secret"].command).toHaveLength(1);
    expect(oc.mcp["http-secret"].headers.Authorization).toMatch(/^Bearer \{file:.*local\/secrets\/HTTP_TOKEN\}$/);
    expect(oc.mcp.servers).toBeUndefined();
    // Antigravity: HTTP с секретом — мост (stdio), в плагине проекта и в обоих глобальных конфигах
    const plugin = JSON.parse(readFileSync(`${f.ws}/Org/p1/.agents/plugins/miksy/mcp_config.json`, "utf8"));
    expect(plugin.mcpServers["http-secret"].command).toMatch(/http-secret-bridge-[0-9a-f]{8}\.(cmd|sh)$/);
    expect(plugin.mcpServers["http-secret"].url).toBeUndefined();
    for (const c of [".gemini/config/mcp_config.json", ".gemini/antigravity-ide/mcp_config.json"])
      expect(JSON.parse(readFileSync(`${f.home}/${c}`, "utf8")).mcpServers["http-secret"].command).toMatch(/-bridge-[0-9a-f]{8}\.(cmd|sh)$/);
    // Обёртки — вне проектов, в local/run/<агент>/<цель>/
    expect(walk(`${f.ws}/Org/p1`).some((x) => /\.(cmd|sh)$/.test(x))).toBe(false);
    const run = walk(`${f.config}/local/run`).map((x) => x.replaceAll("\\", "/"));
    for (const a of ALL) expect(run.some((x) => x.includes(`/run/${a}/global/`))).toBe(true);
    if (win) expect(run.every((x) => x.endsWith(".cmd"))).toBe(true);
  }, 120000);

  test("миграция: сервер со значением, записанный до 2а, заменяется обёрткой; бэкап прежнего файла остаётся", () => {
    const f = cliFixture({ agents: ["claude"] });
    put(`${f.config}/layers/global/mcp/s.yaml`, "name: s\ncommand: echo\nenv:\n  T: ${STDIO_TOKEN}\n");
    secretsEnv(f, { STDIO_TOKEN: TOKENS.STDIO_TOKEN });
    // Как записала бы фаза 1.6: значение в ~/.claude.json, ключ в учёте
    put(`${f.home}/.claude.json`, JSON.stringify({ mcpServers: { s: { type: "stdio", command: "echo", args: [], env: { T: TOKENS.STDIO_TOKEN } } } }, null, 2));
    const key = `${f.home}/.claude.json`.replace(/^([a-z]):/, (d) => d.toUpperCase());
    put(`${f.config}/local/state/manifest.json`, JSON.stringify({ version: 1, targets: { "claude|global": { files: {}, merges: { [key]: { '["mcpServers"]': ["s"] } }, exclude: {} } } }));
    const doctor = f.run(["doctor"]);
    expect(doctor.out).toContain("Значения секретов в конфигах агентов");
    expect(doctor.out).not.toContain(TOKENS.STDIO_TOKEN);
    const r = f.run(["sync", "--global"]);
    expect(r.code).toBe(0);
    expect(readFileSync(`${f.home}/.claude.json`, "utf8")).not.toContain(TOKENS.STDIO_TOKEN);
    expect(leaks(f)).toEqual([]);
    expect(f.run(["doctor"]).out).not.toContain("Значения секретов в конфигах агентов");
    // Бэкап этого запуска хранит прежний файл, но значение в нём заменено меткой (решение 2026-10-27, вариант а)
    const backups = walk(`${f.config}/local/backups`);
    expect(backups.filter((p) => readFileSync(p, "utf8").includes(TOKENS.STDIO_TOKEN))).toEqual([]);
    expect(backups.filter((p) => readFileSync(p, "utf8").includes("<secret:STDIO_TOKEN>")).length).toBe(1);
  }, 60000);
});

describe("п.2: файлы секретов local/secrets/<ИМЯ>", () => {
  test("одно значение + LF без CR (secrets.env с CRLF), доступ только владельцу", () => {
    const f = cliFixture({ agents: ["claude"] });
    put(`${f.config}/layers/global/mcp/s.yaml`, "name: s\ncommand: echo\nenv:\n  T: ${STDIO_TOKEN}\n");
    secretsEnv(f, { STDIO_TOKEN: TOKENS.STDIO_TOKEN, UNUSED: "unused-value-0009" }, "\r\n");
    const r = f.run(["sync", "--global"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("файл секрета STDIO_TOKEN");
    const file = `${f.config}/local/secrets/STDIO_TOKEN`;
    expect(readFileSync(file, "utf8")).toBe(TOKENS.STDIO_TOKEN + "\n");
    // Неиспользуемый секрет — без файла
    expect(existsSync(`${f.config}/local/secrets/UNUSED`)).toBe(false);
    expect(aclProblem(`${f.config}/local/secrets`)).toBeNull();
    expect(aclProblem(file)).toBeNull();
    if (!win) {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(`${f.config}/local/secrets`).mode & 0o777).toBe(0o700);
    }
    expect(f.run(["doctor"]).out).not.toContain("Файлы секретов (");
  }, 60000);

  test("многострочное значение — сервер пропущен с сообщением, файла нет", () => {
    const f = cliFixture({ agents: ["claude"] });
    put(`${f.config}/layers/global/mcp/s.yaml`, "name: s\ncommand: echo\nenv:\n  T: ${MULTI}\n");
    put(`${f.config}/local/secrets.env`, 'MULTI="line-one\\nline-two"\n');
    const r = f.run(["sync", "--global"]);
    expect(r.out).toContain("многострочное значение секрета MULTI");
    expect(existsSync(`${f.config}/local/secrets/MULTI`)).toBe(false);
    expect(existsSync(`${f.home}/.claude.json`) ? readFileSync(`${f.home}/.claude.json`, "utf8") : "").not.toContain("line-one");
    expect(f.run(["doctor"]).out).toContain("Секрет нельзя доставить");
  }, 60000);

  test("секрет больше не нужен — файл удаляется; doctor видит пропавший файл и лишний", () => {
    const f = cliFixture({ agents: ["claude"] });
    put(`${f.config}/layers/global/mcp/s.yaml`, "name: s\ncommand: echo\nenv:\n  T: ${STDIO_TOKEN}\n");
    secretsEnv(f, { STDIO_TOKEN: TOKENS.STDIO_TOKEN });
    expect(f.run(["sync", "--global"]).code).toBe(0);
    const file = `${f.config}/local/secrets/STDIO_TOKEN`;
    expect(existsSync(file)).toBe(true);
    rmSync(file);
    const d1 = f.run(["doctor"]);
    expect(d1.code).not.toBe(0);
    expect(d1.out).toContain("STDIO_TOKEN: нет файла секрета");
    // 2г-2 (Ф17): файл, который miksy не создавал, — справочно, sync его не удаляет
    writeFileSync(`${f.config}/local/secrets/STRAY`, "x\n");
    expect(f.run(["doctor"]).out).toContain("STRAY: файл в local/secrets не от miksy");
    expect(f.run(["sync", "--global"]).code).toBe(0);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(`${f.config}/local/secrets/STRAY`)).toBe(true);
    rmSync(`${f.config}/layers/global/mcp/s.yaml`);
    const r = f.run(["sync", "--global"]);
    expect(r.out).toContain("файл секрета STDIO_TOKEN: удалён");
    expect(existsSync(file)).toBe(false);
  }, 60000);

  test("--dry-run ничего не пишет: ни файлов секретов, ни обёрток", () => {
    const f = cliFixture({ agents: ALL });
    layers(f, "global");
    secretsEnv(f);
    const r = f.run(["sync", "--global", "--dry-run"]);
    expect(r.out).toContain("файл секрета STDIO_TOKEN: создать");
    expect(existsSync(`${f.config}/local/secrets`)).toBe(false);
    expect(existsSync(`${f.config}/local/run`)).toBe(false);
  }, 60000);
});

describe("п.4: Claude headersHelper при выключенном автодоверии — предупреждение", () => {
  test("недоверенный проект — предупреждение в sync и doctor; доверенный — без", () => {
    const f = cliFixture({ agents: ["claude"] });
    put(`${f.config}/local/machine.yaml`, `workspace: ${f.ws}\nagents: [claude]\ntrust: { claude: false }\n`);
    put(`${f.config}/layers/tree/mcp/http.yaml`, 'name: h\nurl: https://x.example/mcp\nheaders:\n  Authorization: "Bearer ${HTTP_TOKEN}"\n');
    secretsEnv(f, { HTTP_TOKEN: TOKENS.HTTP_TOKEN });
    const r = f.run(["sync", `${f.ws}/Org/p1`]);
    expect(r.out).toContain("проект не доверенный");
    expect(f.run(["doctor"]).out).toContain("проект не доверенный");
    const cfg = JSON.parse(readFileSync(`${f.home}/.claude.json`, "utf8"));
    const key = Object.keys(cfg.projects)[0];
    expect(cfg.projects[key].hasTrustDialogAccepted).toBeUndefined();
    cfg.projects[key].hasTrustDialogAccepted = true;
    writeFileSync(`${f.home}/.claude.json`, JSON.stringify(cfg, null, 2));
    expect(f.run(["sync", `${f.ws}/Org/p1`]).out).not.toContain("проект не доверенный");
  }, 60000);
});

describe("п.8: отсутствующий секрет — keep обёртки", () => {
  test("секрет убран из secrets.env: записанный сервер и его обёртка остаются, sync и doctor сообщают", () => {
    const f = cliFixture({ agents: ["claude", "codex"] });
    put(`${f.config}/layers/global/mcp/s.yaml`, "name: s\ncommand: echo\nenv:\n  T: ${STDIO_TOKEN}\n");
    secretsEnv(f, { STDIO_TOKEN: TOKENS.STDIO_TOKEN });
    expect(f.run(["sync", "--global"]).code).toBe(0);
    const scripts = walk(`${f.config}/local/run`);
    expect(scripts.length).toBe(2);
    put(`${f.config}/local/secrets.env`, "");
    const r = f.run(["sync", "--global"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("пропущен сервер s");
    expect(JSON.parse(readFileSync(`${f.home}/.claude.json`, "utf8")).mcpServers.s.command).toMatch(/s-stdio-[0-9a-f]{8}\.(cmd|sh)$/);
    expect(readFileSync(`${f.home}/.codex/config.toml`, "utf8")).toContain("[\"mcp_servers\".\"s\"]");
    for (const s of scripts) expect(existsSync(s)).toBe(true);
    // Файл секрета от прошлого sync остаётся, пока записанный сервер его читает
    expect(existsSync(`${f.config}/local/secrets/STDIO_TOKEN`)).toBe(true);
    const d = f.run(["doctor"]);
    expect(d.out).toContain("STDIO_TOKEN");
    expect(d.out).toContain("не задан в local/secrets.env");
  }, 60000);

  test("opencode: пропущенный HTTP-сервер с {file:} без файла секрета убирается (иначе opencode не стартует)", () => {
    const f = cliFixture({ agents: ["opencode"] });
    put(`${f.config}/layers/tree/mcp/http.yaml`, 'name: h\nurl: https://x.example/mcp\nheaders:\n  Authorization: "Bearer ${HTTP_TOKEN}"\n');
    secretsEnv(f, { HTTP_TOKEN: TOKENS.HTTP_TOKEN });
    expect(f.run(["sync", `${f.ws}/Org/p1`]).code).toBe(0);
    expect(JSON.parse(readFileSync(`${f.ws}/Org/p1/opencode.json`, "utf8")).mcp.h).toBeDefined();
    // Секрет пропал и файла нет — сервер с {file:} оставлять нельзя
    put(`${f.config}/local/secrets.env`, "");
    rmSync(`${f.config}/local/secrets/HTTP_TOKEN`);
    const r = f.run(["sync", `${f.ws}/Org/p1`]);
    expect(r.out).toContain("убран из конфига opencode");
    expect(JSON.parse(readFileSync(`${f.ws}/Org/p1/opencode.json`, "utf8")).mcp?.h).toBeUndefined();
  }, 60000);
});

describe("п.10: clean убирает обёртки и файлы секретов своих целей", () => {
  test("clean --global и clean проекта: local/run и local/secrets пустеют", () => {
    const f = cliFixture({ agents: ALL });
    layers(f, "global");
    layers(f, "tree");
    secretsEnv(f);
    expect(f.run(["sync", "--global"]).code).toBe(0);
    expect(f.run(["sync", `${f.ws}/Org/p1`]).code).toBe(0);
    expect(walk(`${f.config}/local/secrets`).length).toBe(5);
    expect(f.run(["clean", "--global"]).code).toBe(0);
    // Проект ещё использует те же секреты
    expect(walk(`${f.config}/local/secrets`).length).toBe(5);
    expect(walk(`${f.config}/local/run`).some((p) => p.replaceAll("\\", "/").includes("/global/"))).toBe(false);
    expect(f.run(["clean", `${f.ws}/Org/p1`]).code).toBe(0);
    expect(walk(`${f.config}/local/run`)).toEqual([]);
    expect(walk(`${f.config}/local/secrets`)).toEqual([]);
  }, 120000);
});
