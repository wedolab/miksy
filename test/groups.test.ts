// Фаза 2в (Р4): каталоги-группы как цели — пометка target: true в layer.yaml слоя дерева
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { cliFixture, put } from "./helpers";

const real = (p: string) => realpathSync.native(p).replaceAll("\\", "/");
const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");

// Дерево из примера Р4: группы Acme и Acme/US (без git), проекты внутри и рядом
function groupFixture(opts: { agents?: string[]; groups?: string[] } = {}) {
  const f = cliFixture({ agents: opts.agents ?? ["claude", "codex", "opencode", "gemini"], projects: ["Acme/US/infra", "Acme/vpn", "Studio/site"] });
  const layer = (rel: string, rule: string) => put(`${f.config}/layers/tree/${rel}/instructions/10-${rule}.md`, `# rule ${rule}\n`);
  layer("Acme", "acme");
  layer("Acme/US", "us");
  layer("Acme/US/infra", "infra");
  layer("Acme/vpn", "vpn");
  layer("Studio", "studio");
  layer("Studio/site", "site");
  put(`${f.config}/layers/tree/mcp/ctx.yaml`, "name: ctx\ncommand: echo\nargs: [ctx]\n");
  put(`${f.config}/layers/tree/skills/s/SKILL.md`, "---\nname: s\ndescription: d\n---\n");
  for (const g of opts.groups ?? ["Acme", "Acme/US"]) put(`${f.config}/layers/tree/${g}/layer.yaml`, "target: true\n");
  const ws = real(f.ws);
  return { ...f, ws, rules: (dir: string) => [...read(`${ws}/${dir}/CLAUDE.local.md`).matchAll(/# rule (\w+)/g)].map((m) => m[1]) };
}

describe("2в/1: пометка группы", () => {
  test("projects показывает группы; sync --all пишет в них, помечая отдельно; sync/clean по пути группы; doctor", () => {
    const f = groupFixture({ agents: ["claude"] });
    const p = f.run(["projects"]);
    expect(p.code).toBe(0);
    expect(p.out).toMatch(/^Acme\s+\(группа/m);
    expect(p.out).toMatch(/^Acme\/US\s+\(группа/m);
    const all = f.run(["sync", "--all", "--yes"]);
    expect(all.code).toBe(0);
    expect(all.out).toContain("группы (2): Acme, Acme/US");
    expect(existsSync(`${f.ws}/Acme/CLAUDE.local.md`)).toBe(true);
    expect(existsSync(`${f.ws}/Acme/US/CLAUDE.local.md`)).toBe(true);
    expect(f.run(["sync", "--global"]).code).toBe(0);
    expect(f.run(["doctor"]).out).toContain("Всё синхронизировано");
    expect(f.run(["clean", `${f.ws}/Acme`]).code).toBe(0);
    expect(existsSync(`${f.ws}/Acme/CLAUDE.local.md`)).toBe(false);
    expect(f.run(["sync", `${f.ws}/Acme`]).code).toBe(0);
    expect(f.rules("Acme")).toEqual(["acme"]);
  }, 60000);

  test("неверная пометка: нет каталога, внутри проекта, корень дерева — предупреждение, не цель", () => {
    const f = groupFixture({ agents: ["claude"], groups: ["Nope", "Acme/vpn/sub"] });
    mkdirSync(`${f.ws}/Acme/vpn/sub`, { recursive: true });
    put(`${f.config}/layers/tree/layer.yaml`, "target: true\n");
    const p = f.run(["projects"]);
    expect(p.code).toBe(0);
    expect(p.out).toContain("цель Nope (target: true): каталога нет в workspace");
    expect(p.out).toContain("цель Acme/vpn/sub (target: true): внутри проекта Acme/vpn");
    expect(p.out).toContain("корень дерева");
    expect(p.out).not.toMatch(/\(группа/);
  }, 30000);

  test("пометка проверяется при загрузке: target — только true/false", () => {
    const f = groupFixture({ agents: ["claude"], groups: [] });
    put(`${f.config}/layers/tree/Acme/layer.yaml`, "target: yes-please\n");
    const r = f.run(["projects"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("target");
  }, 30000);
});

describe("2в/2: что получает группа", () => {
  test("слои до своего уровня: все агенты, MCP, skills, доверие; без exclude у группы без git", () => {
    const f = groupFixture();
    expect(f.run(["sync", `${f.ws}/Acme`]).code).toBe(0);
    const g = `${f.ws}/Acme`;
    expect(f.rules("Acme")).toEqual(["acme"]);
    expect(read(`${g}/CLAUDE.local.md`)).toContain("# workspace");
    for (const file of [".codex/config.toml", ".opencode/miksy.md", ".agents/plugins/miksy/rules/AGENTS.md"]) {
      const text = read(`${g}/${file}`);
      expect(text).toContain("# workspace");
      expect(text).toContain("# rule acme");
      expect(text).not.toContain("# rule us");
      expect(text).not.toContain("# rule vpn");
    }
    expect(existsSync(`${g}/.claude/skills/s/SKILL.md`)).toBe(true);
    expect(existsSync(`${g}/.agents/skills/s/SKILL.md`)).toBe(true);
    const claudeJson = JSON.parse(read(`${f.home}/.claude.json`));
    const key = Object.keys(claudeJson.projects).find((k) => k.toLowerCase() === g.toLowerCase())!;
    expect(claudeJson.projects[key].mcpServers.ctx).toBeDefined();
    expect(claudeJson.projects[key].hasTrustDialogAccepted).toBe(true);
    expect(read(`${f.home}/.codex/config.toml`)).toContain('trust_level = "trusted"');
    expect(JSON.parse(read(`${g}/opencode.json`)).mcp.ctx).toBeDefined();
    expect(existsSync(`${g}/.git`)).toBe(false);
  }, 60000);

  test("git-репо с вложенными проектами, помеченное группой, получает CLAUDE.local.md и exclude", () => {
    const f = cliFixture({ projects: ["Org/platform", "Org/platform/child"] });
    put(`${f.config}/layers/tree/Org/platform/layer.yaml`, "target: true\n");
    put(`${f.config}/layers/tree/Org/platform/instructions/10.md`, "# rule platform\n");
    put(`${f.config}/layers/tree/Org/platform/child/instructions/10.md`, "# rule child\n");
    const r = f.run(["sync", "--all", "--yes"]);
    expect(r.code).toBe(0);
    const ws = real(f.ws);
    expect(read(`${ws}/Org/platform/CLAUDE.local.md`)).toContain("# rule platform");
    expect(read(`${ws}/Org/platform/.git/info/exclude`)).toContain("CLAUDE.local.md");
    const child = read(`${ws}/Org/platform/child/CLAUDE.local.md`);
    expect(child).toContain("# rule child");
    expect(child).not.toContain("# rule platform");
    expect(child).not.toContain("# workspace");
  }, 60000);
});

describe("2в/3: правило разности", () => {
  test("Claude: отрезок между ближайшей группой выше и целью; остальные агенты — полный набор", () => {
    const f = groupFixture();
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(read(`${f.ws}/Acme/CLAUDE.local.md`)).toContain("# workspace");
    expect(f.rules("Acme")).toEqual(["acme"]);
    expect(f.rules("Acme/US")).toEqual(["us"]);
    expect(read(`${f.ws}/Acme/US/CLAUDE.local.md`)).not.toContain("# workspace");
    expect(f.rules("Acme/US/infra")).toEqual(["infra"]);
    expect(f.rules("Acme/vpn")).toEqual(["vpn"]);
    expect(read(`${f.ws}/Studio/site/CLAUDE.local.md`)).toContain("# workspace");
    expect(f.rules("Studio/site")).toEqual(["studio", "site"]);
    // MCP Claude не наследуется — полный набор в каждой цели
    const projects = JSON.parse(read(`${f.home}/.claude.json`)).projects;
    const infra = Object.keys(projects).find((k) => k.toLowerCase() === `${f.ws}/Acme/US/infra`.toLowerCase())!;
    expect(projects[infra].mcpServers.ctx).toBeDefined();
    // Codex, opencode, Antigravity — полный набор
    for (const file of [".codex/config.toml", ".opencode/miksy.md", ".agents/plugins/miksy/rules/AGENTS.md"]) {
      const text = read(`${f.ws}/Acme/US/infra/${file}`);
      for (const m of ["# workspace", "# rule acme", "# rule us", "# rule infra"]) expect(text).toContain(m);
    }
    expect(f.run(["sync", "--global"]).code).toBe(0);
    expect(f.run(["doctor"]).out).toContain("Всё синхронизировано");
  }, 90000);

  test("exclude правила из слоёв группы не действует для Claude — предупреждение", () => {
    const f = groupFixture({ agents: ["claude", "codex"] });
    put(`${f.config}/layers/tree/Acme/vpn/layer.yaml`, "exclude: [instructions.10-acme.md]\n");
    const r = f.run(["sync", "--all", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/exclude instructions\.10-acme\.md не действует для claude: приходит из файлов группы Acme/);
    expect(read(`${f.ws}/Acme/vpn/.codex/config.toml`)).not.toContain("# rule acme");
  }, 60000);

  test("explain показывает отрезок Claude", () => {
    const f = groupFixture({ agents: ["claude"] });
    const r = f.run(["explain", `${f.ws}/Acme/US/infra`]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Группа выше");
    expect(r.out).toMatch(/Acme\/US/);
  }, 30000);
});

describe("2в/4: группа выше не синхронизирована", () => {
  // 2г-2 (Ф11): цель не теряет правила группы — получает её отрезок, пока группа их не получила
  test("sync <проект> и doctor предупреждают, правила группы — в цели; после sync группы — отрезок короткий", () => {
    const f = groupFixture({ agents: ["claude"] });
    const r = f.run(["sync", `${f.ws}/Acme/vpn`]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("группа Acme выше не получила правила Claude");
    expect(r.out).toContain("правила её слоёв workspace, Acme записаны в эту цель");
    expect(f.rules("Acme/vpn")).toEqual(["acme", "vpn"]);
    expect(f.run(["doctor"]).out).toContain("группа Acme выше не получила правила");
    expect(f.run(["sync", `${f.ws}/Acme`]).code).toBe(0);
    const again = f.run(["sync", `${f.ws}/Acme/vpn`]);
    expect(again.out).not.toContain("не получила правила");
    expect(f.rules("Acme/vpn")).toEqual(["vpn"]);
  }, 60000);

  test("sync --all --dry-run не предупреждает о группах этого же запуска", () => {
    const f = groupFixture({ agents: ["claude"] });
    const r = f.run(["sync", "--all", "--dry-run", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("не получила правила");
  }, 60000);
});

describe("2в/5: снятие и добавление пометки", () => {
  test("sync --all после снятия пометки убирает файлы группы и пересчитывает отрезки ниже", () => {
    const f = groupFixture();
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(f.rules("Acme/US/infra")).toEqual(["infra"]);
    writeFileSync(`${f.config}/layers/tree/Acme/US/layer.yaml`, "target: false\n");
    const r = f.run(["sync", "--all", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("пометка target: true снята: Acme/US");
    for (const file of ["CLAUDE.local.md", "opencode.json", ".opencode/miksy.md", ".codex/config.toml", ".agents/plugins/miksy/plugin.json", ".claude/skills/s/SKILL.md"])
      expect(existsSync(`${f.ws}/Acme/US/${file}`)).toBe(false);
    expect(f.rules("Acme/US/infra")).toEqual(["us", "infra"]);
    expect(f.run(["sync", "--global"]).code).toBe(0);
    expect(f.run(["doctor"]).out).toContain("Всё синхронизировано");
    // Пометку вернули — отрезок снова короткий
    writeFileSync(`${f.config}/layers/tree/Acme/US/layer.yaml`, "target: true\n");
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(f.rules("Acme/US/infra")).toEqual(["infra"]);
    expect(f.rules("Acme/US")).toEqual(["us"]);
  }, 120000);

  test("doctor и sync <проект> сообщают о снятой пометке, пока файлы группы на месте", () => {
    const f = groupFixture({ agents: ["claude"] });
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    writeFileSync(`${f.config}/layers/tree/Acme/US/layer.yaml`, "description: x\n");
    expect(f.run(["doctor"]).out).toContain("Снята пометка target: true");
    expect(f.run(["sync", `${f.ws}/Acme/US/infra`]).out).toContain("пометка группы Acme/US снята");
  }, 60000);
});

describe("2в: границы", () => {
  test("exclude MCP и skill ниже группы: opencode предупреждает всегда, Claude — skills только в цели без git", () => {
    const f = groupFixture({ agents: ["claude", "opencode", "codex"] });
    put(`${f.config}/layers/tree/Acme/vpn/layer.yaml`, "exclude: [mcp.ctx, skill.s]\n");
    mkdirSync(`${f.ws}/Acme/notes`, { recursive: true });
    put(`${f.config}/layers/tree/Acme/notes/layer.yaml`, "exclude: [skill.s]\n");
    const r = f.run(["sync", "--all", "--yes"]);
    const n = f.run(["sync", `${f.ws}/Acme/notes`]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("exclude mcp.ctx не действует для opencode");
    expect(r.out).toContain("exclude skill.s не действует для opencode");
    expect(r.out).not.toContain("exclude mcp.ctx не действует для claude");
    expect(r.out).not.toContain("exclude skill.s не действует для claude"); // vpn — git-проект
    expect(r.out).not.toContain("не действует для codex");
    expect(n.out).toContain("exclude skill.s не действует для claude"); // notes — без git
  }, 90000);

  test("снятая пометка git-группы: репо снова обычный проект с вложенными — CLAUDE.local.md убирается", () => {
    const f = cliFixture({ projects: ["Org/platform", "Org/platform/child"] });
    put(`${f.config}/layers/tree/Org/platform/layer.yaml`, "target: true\n");
    put(`${f.config}/layers/tree/Org/platform/instructions/10.md`, "# rule platform\n");
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    const ws = real(f.ws);
    expect(existsSync(`${ws}/Org/platform/CLAUDE.local.md`)).toBe(true);
    writeFileSync(`${f.config}/layers/tree/Org/platform/layer.yaml`, "target: false\n");
    const r = f.run(["sync", "--all", "--yes"]);
    expect(r.code).toBe(0);
    expect(existsSync(`${ws}/Org/platform/CLAUDE.local.md`)).toBe(false);
    expect(read(`${ws}/Org/platform/child/CLAUDE.local.md`)).toContain("# rule platform");
    expect(JSON.stringify(JSON.parse(read(`${f.config}/local/state/manifest.json`)))).not.toContain('"group":true');
  }, 60000);
});

test("2в: корень workspace — git-репо: группы работают, projects и doctor предупреждают про Codex во вложенных", () => {
  const f = groupFixture({ agents: ["claude"] });
  Bun.spawnSync(["git", "init", "--quiet", f.ws]);
  const p = f.run(["projects"]);
  expect(p.out).toMatch(/^Acme\/US\s+\(группа/m);
  expect(p.out).toContain("— git-репо: Codex во вложенных группах без своего git (Acme/US)");
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  expect(f.rules("Acme/US")).toEqual(["us"]);
  expect(f.run(["doctor"]).out).toContain("Codex во вложенных группах");
}, 60000);
