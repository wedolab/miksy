// Фаза 2д: исправления по рецензии фазы 2г (§4d: Г1–Г3, Г5–Г11). Сценарии — воспроизведения из отчётов
// рецензентов (out/mac/reports4); мост (Г4, Г5) — test/bridge2e.test.ts. Значения искусственные.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliFixture, put } from "./helpers";
import { executableSettings, mcpJsonServers } from "../src/trust";
import { backup, newBackupRun, runDir } from "../src/backup";
import { loadManifest } from "../src/manifest";
import { aclProblem } from "../src/secretfiles";
import { tomlValue } from "../src/toml";
import { foreignForBuiltinAdmin, openToOthers } from "./openacl";

const win = process.platform === "win32";
const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const real = (p: string) => realpathSync.native(p).replaceAll("\\", "/");
// Глобальный ignore пользователя (Claude дописывает туда settings.local.json) в проверку exclude не входит
const git = (dir: string, ...args: string[]) => Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", `core.excludesFile=${tmpdir()}/no-global-ignore`, ...args], { stdout: "pipe", stderr: "pipe" });
const manifest = (f: ReturnType<typeof cliFixture>) => loadManifest(`${f.config}/local/state/manifest.json`);
const claudeProjects = (home: string) => (existsSync(`${home}/.claude.json`) ? JSON.parse(read(`${home}/.claude.json`)).projects ?? {} : {});
const claudeTrusted = (home: string) => Object.values(claudeProjects(home)).some((x: any) => x.hasTrustDialogAccepted === true);
const codexTrusted = (home: string) => {
  const p = `${home}/.codex/config.toml`;
  return existsSync(p) && Object.values((Bun.TOML.parse(read(p)) as any).projects ?? {}).some((x: any) => x.trust_level === "trusted");
};
const localSettings = (dir: string) => (existsSync(`${dir}/.claude/settings.local.json`) ? JSON.parse(read(`${dir}/.claude/settings.local.json`)) : {});
function commit(dir: string, files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) put(`${dir}/${rel}`, text);
  git(dir, "add", "-f", ...Object.keys(files));
  git(dir, "commit", "-q", "-m", "team");
}

describe("Г1: отпечаток решения — полная структура", () => {
  test("env сервера .mcp.json изменён после «да» — решение спрашивается заново, одобрение и доверие сняты", () => {
    const f = cliFixture(), dir = `${f.ws}/Org/p1`;
    commit(dir, { ".mcp.json": JSON.stringify({ mcpServers: { team: { command: "runner", args: ["serve"], env: { PAYLOAD: "safe" } } } }) });
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    const ok = f.run(["trust", dir, "--confirm"]);
    expect(ok.code).toBe(0);
    // Показ: значения env и аргументы — видны до ответа
    expect(ok.out).toContain("PAYLOAD");
    expect(ok.out).toContain("safe");
    expect(localSettings(dir).enabledMcpjsonServers).toEqual(["team"]);
    expect(claudeTrusted(f.home)).toBe(true);
    commit(dir, { ".mcp.json": JSON.stringify({ mcpServers: { team: { command: "runner", args: ["serve"], env: { PAYLOAD: "execute-other-code" } } } }) });
    const r = f.run(["sync", "--all", "--yes"]);
    expect(r.out).toContain("Нужно решение пользователя");
    expect(r.out).toContain("execute-other-code");
    expect(claudeTrusted(f.home)).toBe(false);
    expect(localSettings(dir).enabledMcpjsonServers ?? []).toEqual([]);
  }, 90000);

  test("хвост длинного аргумента, границы аргументов, sandbox_mode Codex — меняют отпечаток", () => {
    const d = mkdtempSync(join(tmpdir(), "exec-")).replaceAll("\\", "/");
    git(d, "init", "-q");
    const fp = (files: Record<string, string>, agent: "claude" | "codex") => { commit(d, files); return executableSettings(d, true, agent)!.fingerprint; };
    const x = "x".repeat(210);
    const hook = (cmd: string) => JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: cmd }] }] } });
    expect(fp({ ".claude/settings.json": hook(`echo ${x}; echo first`) }, "claude")).not.toBe(fp({ ".claude/settings.json": hook(`echo ${x}; echo second`) }, "claude"));
    const srv = (args: string[]) => JSON.stringify({ mcpServers: { t: { command: "sh", args } } });
    expect(fp({ ".mcp.json": srv(["-c", "a b"]) }, "claude")).not.toBe(fp({ ".mcp.json": srv(["-c", "a", "b"]) }, "claude"));
    expect(fp({ ".codex/config.toml": 'sandbox_mode = "read-only"\n' }, "codex")).not.toBe(fp({ ".codex/config.toml": 'sandbox_mode = "danger-full-access"\n' }, "codex"));
    // Показ: хвост длинной команды и значение sandbox_mode видны
    commit(d, { ".claude/settings.json": hook(`echo ${x}; echo second`) });
    expect(executableSettings(d, true, "claude")!.lines.join("\n")).toContain("echo second");
    expect(executableSettings(d, true, "codex")!.lines.join("\n")).toContain("danger-full-access");
  }, 60000);

  test("согласие прежнего формата (отпечаток показанного текста) не считается полным — вопрос снова", () => {
    const f = cliFixture(), dir = real(`${f.ws}/Org/p1`);
    commit(dir, { ".mcp.json": JSON.stringify({ mcpServers: { team: { command: "team-server" } } }) });
    // Так считала 2г: sha256 строк показа
    const old = createHash("sha256").update(".mcp.json: MCP team: team-server").digest("hex");
    const decision = { answer: "yes", fingerprint: old, date: "2026-10-27" };
    put(`${f.config}/local/trust.json`, JSON.stringify({ version: 1, decisions: { [dir]: { rel: "Org/p1", claude: decision, mcpjson: decision } } }));
    const r = f.run(["sync", "--all", "--yes"]);
    expect(r.out).toContain("Нужно решение пользователя");
    expect(claudeTrusted(f.home)).toBe(false);
  }, 60000);
});

describe("Г2: каталог-симлинк", () => {
  // Отслеживаемая ссылка .claude → agent-settings (запись 120000 в индексе, на диске — ссылка/junction)
  function linkedSettings(dir: string, files: Record<string, string>) {
    for (const [rel, text] of Object.entries(files)) put(`${dir}/agent-settings/${rel}`, text);
    symlinkSync(win ? `${dir}/agent-settings` : "agent-settings", `${dir}/.claude`, win ? "junction" : "dir");
    const blob = Bun.spawnSync(["git", "-C", dir, "hash-object", "-w", "--stdin"], { stdin: Buffer.from("agent-settings"), stdout: "pipe" }).stdout.toString().trim();
    git(dir, "update-index", "--add", "--cacheinfo", `120000,${blob},.claude`);
    git(dir, "add", "-f", ...Object.keys(files).map((r) => `agent-settings/${r}`));
    git(dir, "commit", "-q", "-m", "team via link");
  }

  test("хуки за отслеживаемой ссылкой .claude — исполняемые настройки: доверия без решения нет", () => {
    const f = cliFixture(), dir = `${f.ws}/Org/p1`;
    linkedSettings(dir, { "settings.json": JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "hidden-hook" }] }] } }) });
    expect(executableSettings(dir, true, "claude")?.lines.join("\n")).toContain("hidden-hook");
    const r = f.run(["sync", "--all", "--yes"]);
    expect(claudeTrusted(f.home)).toBe(false);
    expect(r.out).toContain("Нужно решение пользователя");
  }, 60000);

  test("одобрение не пишется в отслеживаемый файл за ссылкой", () => {
    const f = cliFixture(), dir = `${f.ws}/Org/p1`;
    const before = JSON.stringify({ permissions: { allow: [] } });
    linkedSettings(dir, { "settings.local.json": before });
    commit(dir, { ".mcp.json": JSON.stringify({ mcpServers: { team: { command: "team-server" } } }) });
    put(`${f.config}/layers/tree/Org/layer.yaml`, "trust: { claude: true }\n");
    f.run(["sync", "--all", "--yes"]);
    expect(read(`${dir}/agent-settings/settings.local.json`)).toBe(before);
    expect(mcpJsonServers(dir, true)?.names).toEqual(["team"]);
  }, 60000);
});

describe("Г3: неотслеживаемые исполняемые настройки в git-цели", () => {
  test("gitignored .claude/settings.json с хуком — доверия без решения нет", () => {
    const f = cliFixture(), dir = `${f.ws}/Org/p1`;
    commit(dir, { ".gitignore": ".claude/settings.json\n" });
    put(`${dir}/.claude/settings.json`, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "hidden-evil-hook" }] }] } }));
    const r = f.run(["sync", "--all", "--yes"]);
    expect(claudeTrusted(f.home)).toBe(false);
    expect(r.out).toContain("hidden-evil-hook");
  }, 60000);

  test("неотслеживаемый settings.local.json с хуком в новом проекте — нужно решение", () => {
    const f = cliFixture(), dir = `${f.ws}/Org/p1`;
    put(`${dir}/.claude/settings.local.json`, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "local-hook" }] }] } }));
    const r = f.run(["sync", "--all", "--yes"]);
    expect(claudeTrusted(f.home)).toBe(false);
    expect(r.out).toContain("local-hook");
  }, 60000);

  test("свои файлы не считаются: одобрения miksy, ответы пользователя в диалогах Claude доверенного проекта, свой конфиг Codex", () => {
    const f = cliFixture({ agents: ["claude", "codex"] }), dir = `${f.ws}/Org/p1`;
    put(`${f.config}/layers/tree/mcp/ctx.yaml`, "name: ctx\ncommand: echo\n");
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(claudeTrusted(f.home)).toBe(true);
    expect(codexTrusted(f.home)).toBe(true);
    // Claude записал ответы «всегда разрешать» и одобрение сервера в доверенном проекте
    put(`${dir}/.claude/settings.local.json`, JSON.stringify({ permissions: { allow: ["Bash(npm test)"] }, enabledMcpjsonServers: [] }));
    const r = f.run(["sync", "--all", "--yes"]);
    expect(r.out).not.toContain("Нужно решение");
    expect(claudeTrusted(f.home)).toBe(true);
    expect(codexTrusted(f.home)).toBe(true);
  }, 90000);

  test("чужой неотслеживаемый .codex/config.toml (не записан miksy) — исполняемые настройки Codex", () => {
    const f = cliFixture({ agents: ["codex"] }), dir = `${f.ws}/Org/p1`;
    put(`${dir}/.codex/config.toml`, 'notify = ["evil-notify"]\n');
    const r = f.run(["sync", "--all", "--yes"]);
    expect(codexTrusted(f.home)).toBe(false);
    expect(r.out).toContain("evil-notify");
  }, 60000);
});

describe("Г5: бэкапы — маскировка без порчи данных", () => {
  function scrub(files: Record<string, string | Buffer>, secrets: string) {
    const config = mkdtempSync(join(tmpdir(), "scrub2e-cfg-")).replaceAll("\\", "/");
    put(`${config}/local/secrets.env`, secrets);
    const dir = mkdtempSync(join(tmpdir(), "scrub2e-src-")).replaceAll("\\", "/");
    newBackupRun();
    const out: Record<string, Buffer> = {};
    for (const [name, data] of Object.entries(files)) {
      writeFileSync(`${dir}/${name}`, data);
      backup(`${dir}/${name}`, config);
    }
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    for (const p of walk(runDir()!)) out[p.replaceAll("\\", "/").split("/").pop()!] = readFileSync(p);
    return out;
  }

  test("JSON: маскируются только строки — true и числа не трогаются, результат разбирается; короткое значение — целой строкой", () => {
    const c = scrub({ "a.json": '{"pin":"abc","tok":"long_token_12345","enabled":true,"n":1234,"note":"cabc"}' }, "BOOL=true\nPIN=abc\nTOK=long_token_12345\nNUM=1234\n");
    const doc = JSON.parse(c["a.json"].toString());
    expect(doc).toEqual({ pin: "<secret:PIN>", tok: "<secret:TOK>", enabled: true, n: 1234, note: "cabc" });
  });

  test("TOML: строки и комментарии маскируются, результат разбирается", () => {
    const text = `# token long_token_12345\n[mcp_servers.x.env]\nA = ${tomlValue("long_token_12345")}\nB = 'abc'\nC = true\nD = """\nlong_token_12345\n"""\n`;
    const c = scrub({ "b.toml": text }, "TOK=long_token_12345\nPIN=abc\nBOOL=true\n");
    const out = c["b.toml"].toString();
    expect(out).not.toContain("long_token_12345");
    const doc = Bun.TOML.parse(out) as any;
    // Многострочная строка — то же значение (в разборе miksy), что было, с меткой вместо значения
    const D = (Bun.TOML.parse(text) as any).mcp_servers.x.env.D.replace("long_token_12345", "<secret:TOK>");
    expect(doc.mcp_servers.x.env).toEqual({ A: "<secret:TOK>", B: "<secret:PIN>", C: true, D });
  });

  test("прочие файлы: замена диапазонов байтов, остальные байты — как были", () => {
    const tok = Buffer.from("long_token_12345");
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), tok, Buffer.from([0x80])]);
    const c = scrub({ "c.bin": bytes }, "TOK=long_token_12345\n");
    expect(c["c.bin"].equals(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("<secret:TOK>"), Buffer.from([0x80])]))).toBe(true);
  });
});

describe("Г7, Г8: учёт файлов секретов", () => {
  test("Г7: конфликт после смены ссылки — зависимость записанной версии остаётся; keep не удаляет нужный файл", () => {
    const f = cliFixture({ agents: ["opencode"] }), dir = `${f.ws}/Org/p1`;
    put(`${f.config}/local/secrets.env`, "OLD=old_value_12345678\nNEW=new_value_12345678\n");
    const layer = (ref: string) => put(`${f.config}/layers/tree/Org/mcp/s.yaml`, `name: s\nurl: https://example.invalid/mcp\nheaders:\n  Authorization: \${${ref}}\n`);
    layer("OLD");
    expect(f.run(["sync", dir]).code).toBe(0);
    const cfg = `${dir}/opencode.json`;
    const saved = read(cfg);
    expect(saved).toContain("/OLD}");
    put(cfg, saved.replace("{", '{\n  "user": true,'));
    layer("NEW");
    expect(f.run(["sync", dir]).code).toBe(3);
    expect(read(cfg)).toContain("/OLD}");
    const st = Object.values(manifest(f).targets).find((t) => t.servers)!;
    expect(st.servers!.s).toContain("OLD");
    // Конфликт разрешён возвратом к записанной версии; NEW из secrets.env убран — сервер остаётся (keep)
    put(cfg, saved);
    put(`${f.config}/local/secrets.env`, "OLD=old_value_12345678\n");
    const r = f.run(["sync", dir]);
    expect(r.code).toBe(0);
    expect(read(cfg)).toContain("/OLD}");
    expect(existsSync(`${f.config}/local/secrets/OLD`)).toBe(true);
  }, 90000);

  test("Г8: файл секрета, созданный пользователем заранее, не становится собственностью miksy", () => {
    const f = cliFixture();
    put(`${f.config}/local/secrets/TOK`, "user_value_12345\n");
    put(`${f.config}/local/secrets.env`, "TOK=user_value_12345\n");
    put(`${f.config}/layers/global/mcp/srv.yaml`, "name: srv\ncommand: echo\nenv:\n  TOKEN: ${TOK}\n");
    expect(f.run(["sync", "--global"]).code).toBe(0);
    expect(manifest(f).secretFiles ?? []).not.toContain("TOK");
    rmSync(`${f.config}/layers/global/mcp/srv.yaml`);
    expect(f.run(["sync", "--global"]).code).toBe(0);
    expect(read(`${f.config}/local/secrets/TOK`)).toBe("user_value_12345\n");
  }, 60000);
});

describe("Г9: правила группы — по разбору и хешу блока", () => {
  test("блок группы заменён чужим текстом — ребёнок получает правила группы и предупреждение", () => {
    const f = cliFixture({ projects: ["Org/p1"] });
    put(`${f.config}/layers/tree/Org/layer.yaml`, "target: true\n");
    put(`${f.config}/layers/tree/Org/instructions/10-org.md`, "# ORG_RULE\n");
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    const ws = real(f.ws);
    expect(read(`${ws}/Org/CLAUDE.local.md`)).toContain("ORG_RULE");
    expect(read(`${ws}/Org/p1/CLAUDE.local.md`)).not.toContain("ORG_RULE");
    put(`${ws}/Org/CLAUDE.local.md`, "foreign only\n");
    const r = f.run(["sync", `${ws}/Org/p1`]);
    expect(r.out).toContain("группа Org выше не получила правила");
    expect(read(`${ws}/Org/p1/CLAUDE.local.md`)).toContain("ORG_RULE");
  }, 90000);
});

describe("Г10: exclude вместе с одобрением", () => {
  test("miksy trust --confirm: файл одобрений скрыт от git сразу", () => {
    const f = cliFixture(), dir = `${f.ws}/Org/p1`;
    commit(dir, { ".mcp.json": JSON.stringify({ mcpServers: { team: { command: "team-server" } } }) });
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(f.run(["trust", dir, "--confirm"]).code).toBe(0);
    expect(localSettings(dir).enabledMcpjsonServers).toEqual(["team"]);
    expect(git(dir, "check-ignore", "-q", ".claude/settings.local.json").exitCode).toBe(0);
    expect(git(dir, "status", "--porcelain", "--untracked-files=all").stdout.toString()).not.toContain("settings.local.json");
    // Отказ после согласия: своё одобрение снято, строка ушла из блока, учёт согласован
    expect(f.run(["trust", dir, "--deny"]).code).toBe(0);
    expect(localSettings(dir).enabledMcpjsonServers ?? []).toEqual([]);
    expect(read(`${dir}/.git/info/exclude`)).not.toContain("settings.local.json");
    const st = Object.values(manifest(f).targets).find((t) => Object.keys(t.exclude).length);
    expect(JSON.stringify(st?.exclude ?? {})).not.toContain("settings.local.json");
  }, 90000);
});

describe("Г11: ссылка-каталог local/secrets", () => {
  test("права цели ссылки не меняются; открытая цель — понятный отказ, значения не пишутся", () => {
    const f = cliFixture();
    const vault = `${f.dir}/vault`;
    mkdirSync(vault, { recursive: true, mode: 0o755 });
    // Открытая — явной чужой записью (Windows): наследования под …-500 мало (круг 9c)
    openToOthers(vault);
    if (win) expect(foreignForBuiltinAdmin(vault).length).toBeGreaterThan(0);
    const before = win ? aclProblem(vault) : statSync(vault).mode & 0o777;
    mkdirSync(`${f.config}/local`, { recursive: true });
    symlinkSync(vault, `${f.config}/local/secrets`, win ? "junction" : "dir");
    put(`${f.config}/local/secrets.env`, "MINE=mine_value_12345678\n");
    put(`${f.config}/layers/global/mcp/srv.yaml`, "name: srv\ncommand: echo\nenv:\n  TOKEN: ${MINE}\n");
    const r = f.run(["sync", "--global"]);
    expect(win ? aclProblem(vault) : statSync(vault).mode & 0o777).toBe(before);
    expect(r.out).toContain("local/secrets");
    expect(r.out).toContain("закройте вручную");
    expect(existsSync(`${vault}/MINE`)).toBe(false);
  }, 60000);
});
