// Цели, внутри которых есть другие проекты: файлы, которые агент наследует вниз, туда не пишутся
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { claude } from "../adapters/claude";
import { sha } from "../src/manifest";
import type { Resolved } from "../src/types";
import { cliFixture, put } from "./helpers";

const real = (p: string) => realpathSync.native(p).replaceAll("\\", "/");

describe("вложенные проекты", () => {
  test("claude: в цель с вложенными проектами CLAUDE.local.md не пишется, MCP и skills — да", () => {
    const f = cliFixture();
    put(`${f.dir}/a.md`, "# A\n");
    put(`${f.dir}/skill/SKILL.md`, "---\nname: s\ndescription: d\n---\n");
    const cfg: Resolved = {
      layers: ["workspace"],
      instructions: [{ item: { file: "a.md", path: `${f.dir}/a.md` }, layer: "workspace" }],
      skills: [{ item: { name: "s", dir: `${f.dir}/skill` }, layer: "workspace" }],
      mcp: [{ item: { name: "ctx", url: "u" }, layer: "workspace" }],
      notes: [],
    };
    const machine = { workspace: f.ws, os: "linux" as const, home: f.home, vars: {} };
    const r = claude.render(cfg, { scope: "project", dir: `${f.ws}/Org`, rel: "Org", nested: true }, machine);
    expect(r.files.map((x) => x.path)).not.toContain("CLAUDE.local.md");
    expect(r.files.some((x) => x.path.startsWith(".claude/skills/s/"))).toBe(true);
    expect(r.files.some((x) => x.mode === "merge")).toBe(true);
    expect(r.warnings.join("\n")).toContain("CLAUDE.local.md");
  });

  test("sync --all: родительское репо без CLAUDE.local.md, вложенное — с ним; записанный раньше убирается", () => {
    const f = cliFixture({ projects: ["Org/parent", "Org/parent/child"] });
    const parent = real(`${f.ws}/Org/parent`);
    // Как после старой версии: CLAUDE.local.md в родительском репо, в учёте
    writeFileSync(`${parent}/CLAUDE.local.md`, "old\n");
    put(`${f.config}/local/state/manifest.json`, JSON.stringify({
      version: 1,
      targets: { [`claude|${parent}`]: { files: { [`${parent}/CLAUDE.local.md`]: sha("old\n") }, merges: {}, exclude: {} } },
    }));
    const r = f.run(["sync", "--all", "--yes"]);
    expect(r.code).toBe(0);
    expect(existsSync(`${parent}/CLAUDE.local.md`)).toBe(false);
    expect(existsSync(`${f.ws}/Org/parent/child/CLAUDE.local.md`)).toBe(true);
    expect(r.out).toContain("внутри есть другие проекты");
  }, 30000);

  test("sync <каталог без git с проектами внутри> — без CLAUDE.local.md", () => {
    const f = cliFixture({ projects: ["Org/p1"] });
    const r = f.run(["sync", `${f.ws}/Org`]);
    expect(r.code).toBe(0);
    expect(existsSync(`${f.ws}/Org/CLAUDE.local.md`)).toBe(false);
  }, 30000);

  test("каталог без git и без проектов — цель; секрета в его файлах нет (обёртка)", () => {
    const f = cliFixture({ agents: ["codex"], projects: [] });
    mkdirSync(`${f.ws}/Org/notes`, { recursive: true });
    put(`${f.config}/layers/tree/mcp/gl.yaml`, "name: gl\ncommand: npx\nenv:\n  TOKEN: ${GL_TOKEN}\n");
    put(`${f.config}/local/secrets.env`, "GL_TOKEN=glpat-very-secret\n");
    const r = f.run(["sync", `${f.ws}/Org/notes`]);
    expect(r.code).toBe(0);
    const toml = readFileSync(`${f.ws}/Org/notes/.codex/config.toml`, "utf8");
    expect(toml).not.toContain("glpat-very-secret");
    expect(toml.replace(/\\+/g, "/")).toContain("local/run/codex/");
    expect(r.out).not.toContain("не защищены git");
    expect(r.out).toContain("GL_TOKEN");
    expect(r.out).not.toContain("glpat-very-secret");
  }, 30000);
});

test("служебные каталоги miksy (out/, local/backups) не делают движок и конфигурацию «с вложенными проектами»", async () => {
  const { listProjects, containsProjects, ENGINE } = await import("../src/load");
  const { mkdtempSync, mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const ws = mkdtempSync(join(process.env.TMP!, "svc-")).replaceAll("\\", "/");
  const config = `${ws}/home/Miksy/miksy-config`;
  for (const d of [config, `${config}/local/backups/x/repo`]) Bun.spawnSync(["git", "init", "--quiet", d]);
  const saved = process.env.MIKSY_CONFIG;
  process.env.MIKSY_CONFIG = config;
  try {
    expect(containsProjects(config)).toBe(false);
    const list = listProjects(ws, [`${config}/local/backups/x`]);
    expect(list.find((p) => p.rel === "home/Miksy/miksy-config")?.nested).toBe(false);
    expect(containsProjects(ENGINE)).toBe(false);
  } finally {
    process.env.MIKSY_CONFIG = saved;
  }
});
