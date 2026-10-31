// Фаза 2г-2: потеря данных и корректность по рецензии фазы 2 (§4c: Ф7, Ф9–Ф12, Ф14–Ф18; Н17, Н18,
// Н20, Н22, Н23; GLM F6) и одобрение серверов командного .mcp.json. Сценарии — воспроизведения из
// отчётов рецензентов; секреты искусственные.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliFixture, put } from "./helpers";
import { createLauncher } from "../src/launch";
import * as launchMod from "../src/launch";
import * as secretMod from "../src/secretfiles";
import { secretRef, substitute } from "../src/vars";
import { loadManifest } from "../src/manifest";
import { fold } from "../src/paths";

const win = process.platform === "win32";
const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const real = (p: string) => realpathSync.native(p).replaceAll("\\", "/");
const git = (dir: string, ...args: string[]) => Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdout: "pipe", stderr: "pipe" });
const manifest = (f: ReturnType<typeof cliFixture>) => loadManifest(`${f.config}/local/state/manifest.json`);

describe("Ф7: оригиналы по циклам владения", () => {
  test("второй захват после clean — новая копия; «Оригинал сохранён» — только при записи", () => {
    const f = cliFixture({ agents: ["opencode"] });
    const path = `${f.home}/.config/opencode/AGENTS.md`;
    put(path, "A\n");
    expect(f.run(["sync", "--global", "--force"]).out).toContain("Оригинал сохранён");
    expect(f.run(["clean", "--global"]).code).toBe(0);
    expect(read(path)).toBe("A\n");
    // Тот же текст: копия уже есть — не «сохранён»
    const same = f.run(["sync", "--global", "--force"]);
    expect(same.code).toBe(0);
    expect(same.out).not.toContain("Оригинал сохранён");
    expect(f.run(["clean", "--global"]).code).toBe(0);
    expect(read(path)).toBe("A\n");
    // Пользователь изменил файл между циклами: clean возвращает B, а не A первого цикла
    put(path, "B\n");
    expect(f.run(["sync", "--global", "--force"]).out).toContain("Оригинал сохранён");
    expect(f.run(["clean", "--global"]).code).toBe(0);
    expect(read(path)).toBe("B\n");
  }, 60000);
});

describe("Ф10, Ф17: файлы секретов", () => {
  test("Ф10: keep не удаляет файл секрета, который читает сохранённая обёртка", () => {
    const f = cliFixture();
    put(`${f.config}/local/secrets.env`, "OLD_TOK=old_value_12345678\n");
    put(`${f.config}/layers/global/mcp/srv.yaml`, "name: srv\ncommand: echo\nenv:\n  TOKEN: ${OLD_TOK}\n");
    expect(f.run(["sync", "--global"]).code).toBe(0);
    expect(existsSync(`${f.config}/local/secrets/OLD_TOK`)).toBe(true);
    // Ссылку переименовали, значения NEW_TOK нет: сервер сохраняется как был (keep) — и его файл секрета
    put(`${f.config}/layers/global/mcp/srv.yaml`, "name: srv\ncommand: echo\nenv:\n  TOKEN: ${NEW_TOK}\n");
    const r = f.run(["sync", "--global"]);
    expect(r.out).toContain("пропущен сервер srv");
    expect(r.out).not.toContain("OLD_TOK: удалён");
    expect(existsSync(`${f.config}/local/secrets/OLD_TOK`)).toBe(true);
    expect(f.run(["doctor"]).out).not.toContain("лишний файл секрета");
  }, 60000);

  test("Ф17: файл, который miksy не создавал, не удаляется; свой ненужный — удаляется", () => {
    const f = cliFixture();
    put(`${f.config}/local/secrets/FUTURE_TOKEN`, "future\n");
    put(`${f.config}/local/secrets.env`, "MINE=mine_value_12345678\n");
    put(`${f.config}/layers/global/mcp/srv.yaml`, "name: srv\ncommand: echo\nenv:\n  TOKEN: ${MINE}\n");
    const r = f.run(["sync", "--global"]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("FUTURE_TOKEN");
    expect(read(`${f.config}/local/secrets/FUTURE_TOKEN`)).toBe("future\n");
    expect(existsSync(`${f.config}/local/secrets/MINE`)).toBe(true);
    rmSync(`${f.config}/layers/global/mcp/srv.yaml`);
    const gone = f.run(["sync", "--global"]);
    expect(gone.out).toContain("файл секрета MINE: удалён");
    expect(existsSync(`${f.config}/local/secrets/MINE`)).toBe(false);
    expect(existsSync(`${f.config}/local/secrets/FUTURE_TOKEN`)).toBe(true);
    expect(f.run(["doctor"]).out).not.toMatch(/FUTURE_TOKEN: лишний файл секрета.*sync удалит/);
  }, 60000);

  test("Ф17/Ф15: битый симлинк в local/secrets не роняет sync", () => {
    const f = cliFixture();
    put(`${f.config}/local/secrets.env`, "MINE=mine_value_12345678\n");
    put(`${f.config}/layers/global/mcp/srv.yaml`, "name: srv\ncommand: echo\nenv:\n  TOKEN: ${MINE}\n");
    mkdirSync(`${f.config}/local/secrets`, { recursive: true });
    symlinkSync(`${f.dir}/nowhere`, `${f.config}/local/secrets/BROKEN`, "file");
    const r = f.run(["sync", "--global"]);
    expect(r.code).toBe(0);
    expect(r.out + r.err).toContain("BROKEN");
  }, 60000);
});

describe("Ф15: симлинк внутри local/", () => {
  test("secrets.env — ссылка на файл вне local/: sync работает, права цели проверяются", () => {
    const f = cliFixture();
    put(`${f.dir}/vault/secrets.env`, "MINE=mine_value_12345678\n");
    mkdirSync(`${f.config}/local`, { recursive: true });
    symlinkSync(`${f.dir}/vault/secrets.env`, `${f.config}/local/secrets.env`, "file");
    put(`${f.config}/layers/global/mcp/srv.yaml`, "name: srv\ncommand: echo\nenv:\n  TOKEN: ${MINE}\n");
    const r = f.run(["sync", "--global"]);
    expect(r.code).toBe(0);
    expect(existsSync(`${f.config}/local/secrets/MINE`)).toBe(true);
    const d = f.run(["doctor"]);
    expect(d.out).not.toMatch(/ссылка внутри local\/.*sync\/setup исправит права/);
  }, 60000);
});

describe("Ф14, Ф18: блоки инструкций", () => {
  const md = (f: ReturnType<typeof cliFixture>) => `${f.home}/.claude/CLAUDE.md`;

  test("строка-маркер в тексте правил не ломает файл: повторный sync и clean работают", () => {
    const f = cliFixture();
    put(`${f.config}/layers/global/instructions/10-miksy.md`, "# про miksy\n```\n<!-- miksy:begin инструкции -->\n<!-- miksy:end -->\n```\n");
    expect(f.run(["sync", "--global"]).code).toBe(0);
    const again = f.run(["sync", "--global"]);
    expect(again.code).toBe(0);
    expect(again.out).not.toContain("КОНФЛИКТ");
    expect(f.run(["clean", "--global"]).code).toBe(0);
    expect(existsSync(md(f))).toBe(false);
  }, 60000);

  test("удалённый файл пишется заново; CRLF после пересохранения — не конфликт", () => {
    const f = cliFixture();
    expect(f.run(["sync", "--global"]).code).toBe(0);
    rmSync(md(f));
    const r = f.run(["sync", "--global"]);
    expect(r.code).toBe(0);
    expect(read(md(f))).toContain("<!-- miksy:begin");
    writeFileSync(md(f), "моё\r\n" + read(md(f)).replaceAll("\n", "\r\n"));
    const crlf = f.run(["sync", "--global"]);
    expect(crlf.code).toBe(0);
    expect(crlf.out).not.toContain("КОНФЛИКТ");
    expect(f.run(["clean", "--global"]).code).toBe(0);
    expect(read(md(f))).toBe("моё\r\n");
  }, 60000);

  test("CRLF в файле, где чужой текст без LF: sync не переписывает блок, clean не добавляет \\r (live 2г-2)", () => {
    const f = cliFixture();
    put(md(f), "моё без LF");
    expect(f.run(["sync", "--global"]).code).toBe(0);
    writeFileSync(md(f), (read(md(f)) + "MEMORY\n").replaceAll("\n", "\r\n"));
    const before = read(md(f));
    const r = f.run(["sync", "--global"]);
    expect(r.out).not.toContain("блок инструкций");
    expect(read(md(f))).toBe(before);
    expect(f.run(["clean", "--global"]).code).toBe(0);
    expect(read(md(f))).toBe("моё без LF\r\nMEMORY\r\n");
  }, 60000);

  test("clean сохраняет файл, где вне блока только пробелы", () => {
    const f = cliFixture();
    put(md(f), " \t\n\n");
    expect(f.run(["sync", "--global"]).code).toBe(0);
    expect(f.run(["clean", "--global"]).code).toBe(0);
    expect(existsSync(md(f))).toBe(true);
    expect(read(md(f))).toBe(" \t\n\n");
  }, 60000);

  test("снятие блока не склеивает чужой текст без LF и дописанное агентом после блока", () => {
    const f = cliFixture();
    put(md(f), "foreign without LF");
    expect(f.run(["sync", "--global"]).code).toBe(0);
    writeFileSync(md(f), read(md(f)) + "MEMORY from agent\n");
    expect(f.run(["clean", "--global"]).code).toBe(0);
    expect(read(md(f))).toBe("foreign without LF\nMEMORY from agent\n");
  }, 60000);
});

describe("Ф9: имена сгенерированных скриптов", () => {
  const launcher = () => createLauncher({ os: "linux", local: mkdtempSync(join(tmpdir(), "l-")).replaceAll("\\", "/"), agent: "claude", target: { scope: "global" }, bun: "bun", engine: "/engine" });
  const ref = secretRef("TOK");
  test("stdio «foo-headers» и helper «foo», stdio «foo-bridge» и мост «foo» — разные файлы", () => {
    const l = launcher();
    l.stdio({ name: "foo-headers", command: "x", env: { T: ref } });
    l.helper({ name: "foo", url: "https://x.example", headers: { A: ref } });
    l.stdio({ name: "foo-bridge", command: "x", env: { T: ref } });
    l.bridge({ name: "foo", url: `https://x.example/?k=${ref}` });
    const paths = l.files().map((f) => f.path);
    expect(paths).toHaveLength(4);
    expect(new Set(paths.map(fold)).size).toBe(4);
  });
  test("GitHub и github — разные файлы и без учёта регистра", () => {
    const l = launcher();
    const a = l.stdio({ name: "GitHub", command: "upper", env: { T: ref } });
    const b = l.stdio({ name: "github", command: "lower", env: { T: ref } });
    expect(a.toLowerCase()).not.toBe(b.toLowerCase());
    expect(l.files()).toHaveLength(2);
  });
});

// Группы: дерево Org (группа без git) → проект Org/p1
function orgFixture(opts: { agents?: string[] } = {}) {
  const f = cliFixture({ agents: opts.agents ?? ["claude"], projects: ["Org/p1"] });
  put(`${f.config}/layers/tree/Org/layer.yaml`, "target: true\n");
  put(`${f.config}/layers/tree/Org/instructions/10-org.md`, "# rule ORG_RULE\n");
  put(`${f.config}/layers/tree/Org/skills/s/SKILL.md`, "---\nname: s\ndescription: d\n---\n");
  return { ...f, ws: real(f.ws) };
}

describe("Ф11: группы", () => {
  test("группа не получила правила (маркеры повреждены) — проект ниже получает её отрезок и предупреждение", () => {
    const f = orgFixture();
    put(`${f.ws}/Org/CLAUDE.local.md`, "чужое\n<!-- miksy:end -->\n");
    const r = f.run(["sync", "--all", "--yes"]);
    expect(existsSync(`${f.ws}/Org/.claude/skills/s/SKILL.md`)).toBe(true);
    expect(read(`${f.ws}/Org/p1/CLAUDE.local.md`)).toContain("ORG_RULE");
    expect(r.out).toMatch(/группа Org/);
    const one = f.run(["sync", `${f.ws}/Org/p1`]);
    expect(one.out).toMatch(/группа Org/);
    expect(read(`${f.ws}/Org/p1/CLAUDE.local.md`)).toContain("ORG_RULE");
  }, 60000);

  test("git-группа, где команда версионирует CLAUDE.local.md и .claude/rules, — проект ниже получает полную цепочку", () => {
    const f = cliFixture({ projects: ["Org/platform", "Org/platform/child"] });
    put(`${f.config}/layers/tree/Org/platform/layer.yaml`, "target: true\n");
    put(`${f.config}/layers/tree/Org/platform/instructions/10.md`, "# rule platform\n");
    put(`${f.config}/layers/tree/Org/platform/child/instructions/10.md`, "# rule child\n");
    const ws = real(f.ws);
    put(`${ws}/Org/platform/CLAUDE.local.md`, "team\n");
    put(`${ws}/Org/platform/.claude/rules/team.md`, "team\n");
    git(`${ws}/Org/platform`, "add", "CLAUDE.local.md", ".claude/rules/team.md");
    const r = f.run(["sync", "--all", "--yes"]);
    const child = read(`${ws}/Org/platform/child/CLAUDE.local.md`);
    expect(child).toContain("# workspace");
    expect(child).toContain("# rule platform");
    expect(child).toContain("# rule child");
    expect(r.out).toMatch(/группа Org\/platform/);
  }, 60000);

  test("неудачный clean бывшей группы не снимает её отметку в учёте", () => {
    const f = orgFixture();
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    const block = `${f.ws}/Org/CLAUDE.local.md`;
    writeFileSync(block, read(block).replace("ORG_RULE", "ORG_RULE edited"));
    rmSync(`${f.config}/layers/tree/Org/layer.yaml`);
    const first = f.run(["sync", "--all", "--yes"]);
    expect(first.code).toBe(3);
    const id = Object.keys(manifest(f).targets).find((k) => k.startsWith("claude|") && k.toLowerCase().endsWith("/org"));
    expect(id && manifest(f).targets[id].group).toBe(true);
    const second = f.run(["sync", "--all", "--yes"]);
    expect(second.code).toBe(3);
    expect(second.out).toContain("пометка target: true снята: Org");
  }, 90000);

  test("Н22: exclude правила группы выше ближайшей — предупреждение и глубже", () => {
    const f = cliFixture({ projects: ["Acme/US/infra"] });
    put(`${f.config}/layers/tree/Acme/layer.yaml`, "target: true\n");
    put(`${f.config}/layers/tree/Acme/instructions/10-acme.md`, "# rule acme\n");
    put(`${f.config}/layers/tree/Acme/US/layer.yaml`, "target: true\nexclude: [instructions.10-acme.md]\n");
    put(`${f.config}/layers/tree/Acme/US/instructions/10-us.md`, "# rule us\n");
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    const r = f.run(["sync", `${f.ws}/Acme/US/infra`]);
    expect(r.out).toMatch(/exclude instructions\.10-acme\.md не действует для claude: приходит из файлов группы Acme\b/);
  }, 60000);

  test("Н20: группа-симлинк — сообщение о симлинке", () => {
    const f = cliFixture({ projects: [] });
    mkdirSync(`${f.dir}/outside/Linked`, { recursive: true });
    mkdirSync(f.ws, { recursive: true });
    symlinkSync(`${f.dir}/outside/Linked`, `${f.ws}/Linked`, win ? "junction" : "dir");
    put(`${f.config}/layers/tree/Linked/layer.yaml`, "target: true\n");
    const p = f.run(["projects"]);
    expect(p.out).toMatch(/цель Linked \(target: true\): .*симлинк/);
    expect(p.out).not.toContain("каталога нет в workspace");
  }, 30000);
});

describe("Ф12, Ф16, F6: ограничения значений — по способу доставки", () => {
  const machine = (os: "windows" | "macos") => ({ home: "/h", workspace: "/w", os, vars: {} });
  const cfg = (item: any) => ({ layers: [], instructions: [], skills: [], notes: [], mcp: [{ layer: "l", item }] });
  const http = { name: "h", url: "https://mcp.example/mcp", headers: { Authorization: "Bearer ${TOK}" } };
  const skipped = (item: any, os: "windows" | "macos", agent: string, http: string, value: string) =>
    substitute(cfg(item) as any, machine(os), { TOK: value }, { agent, http } as any).skipped.map((s) => s.why ?? s.vars.join(","));
  const long = "x".repeat(1500);

  test("Ф12: мост и {file:} — длинный заголовок на Windows доставляется, helper — нет", () => {
    expect(skipped(http, "windows", "gemini", "bridge", long)).toEqual([]);
    expect(skipped(http, "windows", "opencode", "file", long)).toEqual([]);
    expect(skipped(http, "windows", "claude", "helper", long)).toHaveLength(1);
    expect(skipped({ name: "u", url: "https://mcp.example/mcp?k=${TOK}" }, "windows", "claude", "helper", long)).toEqual([]);
  });

  test("Ф12: \" и \\ в заголовке — только для helper", () => {
    expect(skipped(http, "macos", "opencode", "file", "abc\\def")).toEqual([]);
    expect(skipped(http, "macos", "gemini", "bridge", 'ab"cd')).toEqual([]);
    expect(skipped(http, "macos", "claude", "helper", 'ab"cd')).toHaveLength(1);
    expect(skipped(http, "macos", "gemini", "bridge", "a\nb")).toHaveLength(1);
  });

  test("Ф12: stdio .cmd на Windows — по-прежнему 1023 байта; sh — без ограничения", () => {
    const stdio = { name: "s", command: "x", env: { T: "${TOK}" } };
    expect(skipped(stdio, "windows", "claude", "helper", long)).toHaveLength(1);
    expect(skipped(stdio, "macos", "claude", "helper", long)).toEqual([]);
  });

  test("Ф16: секрет в env HTTP-сервера — пропуск с сообщением; env без секретов — предупреждение", () => {
    const f = cliFixture();
    put(`${f.config}/local/secrets.env`, "HTTP_TOKEN=http_value_12345678\n");
    put(`${f.config}/layers/global/mcp/httpenv.yaml`, "name: httpenv\nurl: https://mcp.example.com/mcp\nenv:\n  API_TOKEN: ${HTTP_TOKEN}\n");
    put(`${f.config}/layers/global/mcp/httpplain.yaml`, "name: httpplain\nurl: https://mcp.example.com/plain\nenv:\n  MODE: fast\n");
    const r = f.run(["sync", "--global"]);
    expect(r.out).toMatch(/пропущен сервер httpenv.*env/);
    expect(r.out).toMatch(/httpplain.*env.*игнорир/);
    expect(read(`${f.home}/.claude.json`)).not.toContain("httpenv");
    expect(existsSync(`${f.config}/local/secrets/HTTP_TOKEN`)).toBe(false);
  }, 60000);

  test("F6: пустое значение секрета, используемое сервером, — предупреждение", () => {
    const f = cliFixture();
    put(`${f.config}/local/secrets.env`, "EMPTY_TOK=\n");
    put(`${f.config}/layers/global/mcp/srv.yaml`, "name: srv\ncommand: echo\nenv:\n  TOKEN: ${EMPTY_TOK}\n");
    const r = f.run(["sync", "--global"]);
    expect(r.out).toMatch(/EMPTY_TOK.*пуст/);
  }, 60000);
});

describe("Мелкое: Н23, Н18, Н17", () => {
  test("Н23: права local/ уже верные — второй проход только проверяет", () => {
    const dir = mkdtempSync(join(tmpdir(), "acl-")).replaceAll("\\", "/");
    put(`${dir}/local/backups/x/file`, "data");
    const privateLocal = (secretMod as any).privateLocal;
    expect(typeof privateLocal).toBe("function");
    privateLocal(`${dir}/local`);
    expect(privateLocal(`${dir}/local`).fixed).toBe(false);
  }, 60000);

  test("Н18: путь Bun в обёртках — без каталога с версией, если есть стабильная ссылка", () => {
    const stableBun = (launchMod as any).stableBun;
    expect(typeof stableBun).toBe("function");
    const d = mkdtempSync(join(tmpdir(), "bun-")).replaceAll("\\", "/");
    const versioned = `${d}/Cellar/bun/1.4.3/bin/bun`;
    put(versioned, "bun");
    mkdirSync(`${d}/bin`);
    symlinkSync(versioned, `${d}/bin/bun`, "file");
    expect(stableBun(realpathSync(versioned).replaceAll("\\", "/"), [`${d}/missing`, `${d}/bin/bun`])).toBe(`${d}/bin/bun`);
    expect(stableBun(versioned, [`${d}/missing`])).toBe(versioned);
  });

  test("Н18: doctor — исполняемый файл из обёртки не найден", () => {
    const f = cliFixture();
    const tool = `${f.dir}/tools/my-tool${win ? ".exe" : ""}`;
    put(tool, "tool");
    put(`${f.config}/local/secrets.env`, "MINE=mine_value_12345678\n");
    put(`${f.config}/layers/global/mcp/srv.yaml`, `name: srv\ncommand: ${JSON.stringify(tool)}\nenv:\n  TOKEN: \${MINE}\n`);
    expect(f.run(["sync", "--global"]).code).toBe(0);
    rmSync(tool);
    const d = f.run(["doctor"]);
    expect(d.out).toContain("my-tool");
    expect(d.out).toMatch(/не найден/);
  }, 60000);

  test("Н17: sync --agent opencode после полного sync не кладёт дубль skill; doctor --agent opencode чист", () => {
    const f = cliFixture({ agents: ["claude", "opencode"] }), dir = `${f.ws}/Org/p1`;
    put(`${f.config}/layers/tree/skills/personal/SKILL.md`, "---\nname: personal\ndescription: skill\n---\nbody\n");
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(existsSync(`${dir}/.claude/skills/personal/SKILL.md`)).toBe(true);
    expect(f.run(["sync", dir, "--agent", "opencode"]).code).toBe(0);
    expect(existsSync(`${dir}/.opencode/skills/personal/SKILL.md`)).toBe(false);
    expect(f.run(["doctor", "--agent", "opencode"]).out).not.toContain("Устарело");
  }, 60000);
});

// Одобрение серверов командного .mcp.json (решение 2026-10-27): Claude 2.1.311 читает его из
// <проект>/.claude/settings.local.json → enabledMcpjsonServers (поле ~/.claude.json переносит туда сам)
describe("одобрение серверов .mcp.json", () => {
  const local = (dir: string) => (existsSync(`${dir}/.claude/settings.local.json`) ? JSON.parse(read(`${dir}/.claude/settings.local.json`)) : {});
  function teamMcp(dir: string, servers: Record<string, unknown> = { team: { command: "team-server", args: ["--x"] } }) {
    put(`${dir}/.mcp.json`, JSON.stringify({ mcpServers: servers }));
    git(dir, "add", ".mcp.json");
    git(dir, "commit", "-q", "-m", "team mcp");
  }

  test("trust: true в слое — miksy одобряет командные серверы; clean снимает своё", () => {
    const f = cliFixture(), dir = `${f.ws}/Org/p1`;
    teamMcp(dir);
    put(`${f.config}/layers/tree/Org/layer.yaml`, "trust: { claude: true }\n");
    const r = f.run(["sync", "--all", "--yes"]);
    expect(r.code).toBe(0);
    expect(local(dir).enabledMcpjsonServers).toEqual(["team"]);
    expect(r.out).toContain("одобр");
    expect(f.run(["clean", "--all"]).code).toBe(0);
    expect(local(dir).enabledMcpjsonServers ?? []).toEqual([]);
  }, 60000);

  test("без слоя: --yes не одобряет, список для агента; miksy trust --confirm — доверие и одобрение", () => {
    const f = cliFixture(), dir = `${f.ws}/Org/p1`;
    teamMcp(dir);
    const r = f.run(["sync", "--all", "--yes"]);
    expect(local(dir).enabledMcpjsonServers).toBeUndefined();
    expect(r.out).toContain("team-server");
    expect(r.out).toContain("не подтверждай");
    expect(f.run(["trust", dir, "--confirm"]).code).toBe(0);
    expect(local(dir).enabledMcpjsonServers).toEqual(["team"]);
    expect(f.run(["sync", "--all", "--yes"]).out).not.toContain("Нужно решение");
  }, 90000);

  test("решения пользователя не трогаются: отклонённый не одобряется, одобренный им — не наш", () => {
    const f = cliFixture(), dir = `${f.ws}/Org/p1`;
    teamMcp(dir, { team: { command: "team-server" }, rejected: { command: "bad" }, mine: { command: "mine" } });
    put(`${dir}/.claude/settings.local.json`, JSON.stringify({ enabledMcpjsonServers: ["mine"], disabledMcpjsonServers: ["rejected"], permissions: { allow: [] } }));
    put(`${f.config}/layers/tree/Org/layer.yaml`, "trust: { claude: true }\n");
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(local(dir).enabledMcpjsonServers).toEqual(["mine", "team"]);
    expect(local(dir).disabledMcpjsonServers).toEqual(["rejected"]);
    expect(f.run(["clean", "--all"]).code).toBe(0);
    expect(local(dir).enabledMcpjsonServers).toEqual(["mine"]);
    expect(local(dir).permissions).toEqual({ allow: [] });
  }, 60000);

  test("основание пропало: сервер убран из .mcp.json, слой запретил доверие — своё одобрение снимается", () => {
    const f = cliFixture(), dir = `${f.ws}/Org/p1`;
    teamMcp(dir, { team: { command: "team-server" }, other: { command: "other" } });
    put(`${f.config}/layers/tree/Org/layer.yaml`, "trust: { claude: true }\n");
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect([...local(dir).enabledMcpjsonServers].sort()).toEqual(["other", "team"]);
    teamMcp(dir, { team: { command: "team-server" } });
    f.run(["sync", "--all", "--yes"]);
    expect(local(dir).enabledMcpjsonServers).toEqual(["team"]);
    put(`${f.config}/layers/tree/Org/layer.yaml`, "trust: { claude: false }\n");
    f.run(["sync", "--all", "--yes"]);
    expect(local(dir).enabledMcpjsonServers ?? []).toEqual([]);
  }, 90000);

  test("доверие поставил пользователь, серверы не одобрены — нужно решение о серверах .mcp.json", () => {
    const f = cliFixture(), dir = real(`${f.ws}/Org/p1`);
    teamMcp(dir);
    put(`${f.home}/.claude.json`, JSON.stringify({ projects: { [dir]: { hasTrustDialogAccepted: true } } }));
    const r = f.run(["sync", "--all", "--yes"]);
    expect(r.out).toContain("Нужно решение");
    expect(r.out).toContain(".mcp.json");
    expect(local(dir).enabledMcpjsonServers).toBeUndefined();
    expect(f.run(["trust", dir, "--confirm"]).code).toBe(0);
    expect(local(dir).enabledMcpjsonServers).toEqual(["team"]);
  }, 90000);
});
