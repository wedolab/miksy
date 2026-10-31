// Бэкапы запусков без значений секретов (Ф20, решение 2026-10-27 вариант а), подсказка про литерал в
// неучтённом ключе, предупреждение о секрете в args (Н25), страж assertNoSecret (Н26).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, newBackupRun, originalBackup, runDir } from "../src/backup";
import { cliFixture, put } from "./helpers";
import type { Adapter } from "../src/adapter";
import { renderFor } from "../src/registry";
import { secretRef } from "../src/vars";
import { merge } from "../src/resolve";
import { tomlValue } from "../src/toml";
import { envLine } from "../src/secrets";

const SECRET = 'sup3r"secret\\value\tX-12345';
const PLAIN = "plainsecretvalue99";

// Все файлы дерева: путь → содержимое
function tree(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(p, readFileSync(p));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

describe("бэкапы запусков", () => {
  test("значения из secrets.env — как есть, в JSON- и TOML-экранировании — заменяются на <secret:ИМЯ>; оригиналы — точные копии", () => {
    const config = mkdtempSync(join(tmpdir(), "scrub-cfg-")).replaceAll("\\", "/");
    put(`${config}/local/secrets.env`, `${envLine("QUOTED", SECRET)}\nPLAIN=${PLAIN}\n`);
    const dir = mkdtempSync(join(tmpdir(), "scrub-src-")).replaceAll("\\", "/");
    const json = `${dir}/a.json`;
    const toml = `${dir}/b.toml`;
    const bin = `${dir}/c.bin`;
    writeFileSync(json, JSON.stringify({ env: { A: SECRET, B: PLAIN }, raw: "x" }));
    writeFileSync(toml, `[mcp_servers.x.env]\nA = ${tomlValue(SECRET)}\nB = '${PLAIN}'\n`);
    const bytes = Buffer.from([0, 255, 1, 2, 3, 0xfe]);
    writeFileSync(bin, bytes);
    newBackupRun();
    for (const f of [json, toml, bin]) backup(f, config);
    const copies = tree(runDir()!);
    const text = [...copies.values()].map((b) => b.toString("utf8")).join("\n");
    for (const form of [SECRET, JSON.stringify(SECRET).slice(1, -1), tomlValue(SECRET).slice(1, -1), PLAIN]) expect(text).not.toContain(form);
    expect(text).toContain("<secret:QUOTED>");
    expect(text).toContain("<secret:PLAIN>");
    expect(JSON.parse([...copies].find(([p]) => p.endsWith("a.json"))![1].toString()).raw).toBe("x");
    expect([...copies].find(([p]) => p.endsWith("c.bin"))![1].equals(bytes)).toBe(true);
    // Оригинал — точная копия (clean вернул бы файл с меткой вместо значения)
    const orig = originalBackup(json, config);
    expect(readFileSync(orig.path, "utf8")).toBe(readFileSync(json, "utf8"));
  });

  test("литерал секрета в неучтённом ключе: бэкап без значения, подсказка в sync и doctor", () => {
    const f = cliFixture({ agents: ["claude"] });
    put(`${f.config}/local/secrets.env`, `MYTOK=${PLAIN}\n`);
    put(`${f.config}/layers/tree/mcp/tok.yaml`, "name: tok\ncommand: tok-server\nenv:\n  TOKEN: ${MYTOK}\n");
    // Сервер miksy до 2а без учёта: литерал в ~/.claude.json, учёта нет (новая машина)
    put(`${f.home}/.claude.json`, JSON.stringify({ projects: { [`${f.ws}/Org/p1`]: { hasTrustDialogAccepted: false, mcpServers: { tok: { type: "stdio", command: "tok-server", args: [], env: { TOKEN: PLAIN } } } } } }));
    const r = f.run(["sync", "--all", "--yes"]);
    expect(r.code).toBe(3);
    expect(r.out).toContain("значение секрета MYTOK");
    expect(r.out).toContain("--force");
    expect(r.out + r.err).not.toContain(PLAIN);
    // Тот же sync записал доверие в этот файл — бэкап есть, значения в нём нет
    const backups = tree(`${f.config}/local/backups`);
    expect([...backups.keys()].some((p) => p.endsWith(".claude.json"))).toBe(true);
    for (const [p, b] of backups) if (!p.includes("originals")) expect(b.toString("utf8")).not.toContain(PLAIN);
    const d = f.run(["doctor"]);
    expect(d.out).toContain("Значение секрета в ключе вне учёта");
    expect(d.out).not.toContain(PLAIN);
  }, 60000);
});

test("секрет в args stdio-сервера — предупреждение sync (виден в списке процессов)", () => {
  const f = cliFixture({ agents: ["claude"] });
  put(`${f.config}/local/secrets.env`, `MYTOK=${PLAIN}\n`);
  put(`${f.config}/layers/tree/mcp/arg.yaml`, "name: arg\ncommand: arg-server\nargs: [\"--token=${MYTOK}\"]\n");
  const r = f.run(["sync", "--all", "--yes"]);
  expect(r.out).toContain("mcp arg: секрет передаётся аргументом");
}, 60000);

describe("страж assertNoSecret в renderFor", () => {
  const machine = { workspace: "/ws", os: "linux" as const, home: process.env.HOME!.replaceAll("\\", "/"), vars: {} };
  const t = { cfg: { ...merge([], "linux"), mcp: [{ item: { name: "s", command: "x", env: { T: "${TOK}" } }, layer: "l" }] }, target: { scope: "global" as const }, title: "~" };
  const adapter = (files: (cfg: any) => any[]): Adapter => ({ id: "fake", nativeMcp: () => null, render: (cfg) => ({ files: files(cfg), warnings: [] }) });
  const secrets = { TOK: "tok_value_12345678" };

  test("метка ссылки в MCP-файле — отказ цели", () => {
    expect(() => renderFor(adapter((cfg) => [{ base: "home", path: "m.json", mode: "merge", format: "json", key: ["mcp"], data: { s: cfg.mcp[0].item } }]), t, machine, secrets))
      .toThrow(/осталась ссылка на секрет/);
  });
  test("значение секрета в MCP-файле или скрипте — отказ цели", () => {
    expect(() => renderFor(adapter(() => [{ base: "home", path: "m.json", mode: "own", content: `{"T":"${secrets.TOK}"}`, mcp: { format: "json", key: "mcp" } }]), t, machine, secrets))
      .toThrow(/значение секрета TOK/);
    expect(() => renderFor(adapter(() => [{ base: "local", path: "run/x.sh", mode: "own", content: `T=${secrets.TOK}` }]), t, machine, secrets))
      .toThrow(/значение секрета TOK/);
  });
  test("значение в обычном файле (skill) — не отказ, файл помечен sensitive", () => {
    const r = renderFor(adapter(() => [{ base: "home", path: ".claude/skills/x/SKILL.md", mode: "own", content: `token ${secrets.TOK}` }]), t, machine, secrets);
    expect(r.result.files[0].sensitive).toBe(true);
    expect(secretRef("TOK")).not.toContain(secrets.TOK);
  });
});
