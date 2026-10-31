import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gemini, nativeMcp } from "../adapters/gemini";
import { currentGlobal, currentProject, readJsonc, strictJson } from "../adapters/gemini/current";
import type { Machine, Resolved } from "../src/types";
import { plan } from "../src/apply";
import { emptyState } from "../src/manifest";

const temp = mkdtempSync(join(tmpdir(), "gemini-test-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

function fixture() {
  const dir = mkdtempSync(join(temp, "case-"));
  const home = join(dir, "home");
  const project = join(dir, "project");
  for (const d of [
    join(home, ".gemini", "config"),
    join(home, ".gemini", "antigravity-ide"),
    join(project, ".agents", "skills"),
    join(dir, "skill", "sub"),
  ]) {
    mkdirSync(d, { recursive: true });
  }

  writeFileSync(join(dir, "rule.md"), "# Rule A\n");
  writeFileSync(join(dir, "skill", "SKILL.md"), "---\nname: s\ndescription: Test skill\n---\nBody\n");
  writeFileSync(join(dir, "skill", "sub", "res.txt"), "resource content\n");

  const machine: Machine = { home, workspace: dir, os: process.platform === "win32" ? "windows" : "linux", vars: {} };
  const cfg: Resolved = {
    layers: ["workspace"],
    instructions: [{ item: { file: "rule.md", path: join(dir, "rule.md") }, layer: "workspace" }],
    skills: [{ item: { name: "s", dir: join(dir, "skill") }, layer: "workspace" }],
    mcp: [{ item: { name: "ctx", command: "npx", args: ["ctx7"], env: { TOKEN: "v" } }, layer: "workspace" }],
    notes: [],
  };
  return { dir, home, project, machine, cfg };
}

describe("gemini adapter", () => {
  describe("nativeMcp", () => {
    test("stdio с command, args и env", () => {
      expect(nativeMcp({ name: "s", command: "bin", args: ["-y", "p"], env: { TOKEN: "v" } })).toEqual({
        command: "bin",
        args: ["-y", "p"],
        env: { TOKEN: "v" },
      });
    });

    test("http с url и headers", () => {
      expect(nativeMcp({ name: "s", url: "https://example.com/mcp", headers: { Authorization: "Bearer t" } })).toEqual({
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer t" },
      });
    });

    test("skip и raw", () => {
      expect(nativeMcp({ name: "s", command: "bin", agents: { gemini: "skip" } })).toBeNull();
      expect(nativeMcp({ name: "s", command: "bin", agents: { gemini: { raw: { disabled: true } } } })).toEqual({
        command: "bin",
        args: [],
        disabled: true,
      });
    });
  });

  describe("render: global", () => {
    test("инструкции в ~/.gemini/GEMINI.md, skills в ~/.gemini/config/skills/, mcp в CLI и IDE", () => {
      const { cfg, machine } = fixture();
      const r = gemini.render(cfg, { scope: "global" }, machine);

      expect(r.warnings).toEqual([]);

      // 1. Инструкции
      const md = r.files.find((f) => f.path === ".gemini/GEMINI.md");
      expect(md).toBeDefined();
      expect(md?.mode).toBe("own");
      expect(md?.base).toBe("home");
      expect(md?.content).toContain("Сгенерировано miksy");
      expect(md?.content).toContain("# Rule A");

      // 2. Skills
      expect(r.files).toContainEqual({
        base: "home",
        path: ".gemini/config/skills/s/SKILL.md",
        mode: "own",
        content: "---\nname: s\ndescription: Test skill\n---\nBody\n",
      });
      expect(r.files).toContainEqual({
        base: "home",
        path: ".gemini/config/skills/s/sub/res.txt",
        mode: "own",
        content: "resource content\n",
      });

      // 3. MCP: оба файла mcp_config.json (CLI и IDE)
      const cliMcp = r.files.find((f) => f.path === ".gemini/config/mcp_config.json");
      expect(cliMcp).toMatchObject({
        base: "home",
        path: ".gemini/config/mcp_config.json",
        mode: "merge",
        format: "json",
        key: ["mcpServers"],
        data: { ctx: { command: "npx", args: ["ctx7"], env: { TOKEN: "v" } } },
      });

      const ideMcp = r.files.find((f) => f.path === ".gemini/antigravity-ide/mcp_config.json");
      expect(ideMcp).toMatchObject({
        base: "home",
        path: ".gemini/antigravity-ide/mcp_config.json",
        mode: "merge",
        format: "json",
        key: ["mcpServers"],
        data: { ctx: { command: "npx", args: ["ctx7"], env: { TOKEN: "v" } } },
      });
    });

    test("нестрогий JSON (комментарии) в существующем mcp_config.json вызывает warning", () => {
      const { cfg, machine, home } = fixture();
      writeFileSync(join(home, ".gemini", "config", "mcp_config.json"), '{\n  // комментарий\n  "mcpServers": {}\n}\n');
      const r = gemini.render(cfg, { scope: "global" }, machine);
      expect(r.warnings.some((w) => w.includes("не парсится как строгий JSON"))).toBe(true);
      expect(r.files.some((f) => f.path === ".gemini/config/mcp_config.json")).toBe(false);
      // IDE файл при этом чистый и записывается
      expect(r.files.some((f) => f.path === ".gemini/antigravity-ide/mcp_config.json")).toBe(true);
    });
  });

  describe("render: project", () => {
    test("собственный плагин в .agents/plugins/miksy/: plugin.json, rules/AGENTS.md, skills/ и mcp_config.json", () => {
      const { cfg, machine, project } = fixture();
      const r = gemini.render(cfg, { scope: "project", dir: project, rel: "project" }, machine);

      expect(r.warnings).toEqual([]);

      // 1. Манифест плагина
      const manifest = r.files.find((f) => f.path === ".agents/plugins/miksy/plugin.json");
      expect(manifest).toBeDefined();
      expect(manifest?.mode).toBe("own");
      expect(JSON.parse(manifest!.content)).toEqual({ name: "miksy" });

      // 2. Инструкции
      const md = r.files.find((f) => f.path === ".agents/plugins/miksy/rules/AGENTS.md");
      expect(md).toMatchObject({
        base: "project",
        path: ".agents/plugins/miksy/rules/AGENTS.md",
        mode: "own",
      });
      expect(md?.content).toContain("# Rule A");

      // 3. Skills
      expect(r.files).toContainEqual({
        base: "project",
        path: ".agents/plugins/miksy/skills/s/SKILL.md",
        mode: "own",
        content: "---\nname: s\ndescription: Test skill\n---\nBody\n",
      });
      expect(r.files).toContainEqual({
        base: "project",
        path: ".agents/plugins/miksy/skills/s/sub/res.txt",
        mode: "own",
        content: "resource content\n",
      });

      // 4. Project MCP в mcp_config.json плагина
      const mcpFile = r.files.find((f) => f.path === ".agents/plugins/miksy/mcp_config.json");
      expect(mcpFile).toBeDefined();
      expect(mcpFile?.mode).toBe("own");
      expect(JSON.parse(mcpFile!.content)).toEqual({
        mcpServers: {
          ctx: { command: "npx", args: ["ctx7"], env: { TOKEN: "v" } },
        },
      });
    });

    test("plan исключает /.agents/plugins/miksy/ через .git/info/exclude и защищает отслеживаемые файлы", () => {
      const { cfg, machine, project } = fixture();
      expect(Bun.spawnSync(["git", "init", "--quiet", project]).exitCode).toBe(0);

      const r = gemini.render(cfg, { scope: "project", dir: project, rel: "project" }, machine);
      const actionsUntracked = plan(r, { scope: "project", dir: project, rel: "project" }, machine, emptyState(), false, "gemini");
      const excludeAction = actionsUntracked.find((a) => a.kind === "exclude");
      expect(excludeAction).toBeDefined();
      expect(excludeAction && excludeAction.kind === "exclude" ? excludeAction.lines : []).toEqual([
        "/.agents/plugins/miksy/",
      ]);

      // Если файл плагина попал в git — plan выдаёт конфликт
      mkdirSync(join(project, ".agents", "plugins", "miksy", "rules"), { recursive: true });
      writeFileSync(join(project, ".agents", "plugins", "miksy", "rules", "AGENTS.md"), "# Team\n");
      expect(Bun.spawnSync(["git", "-C", project, "add", "--", ".agents/plugins/miksy/rules/AGENTS.md"]).exitCode).toBe(0);

      const actionsTracked = plan(r, { scope: "project", dir: project, rel: "project" }, machine, emptyState(), false, "gemini");
      expect(actionsTracked.some((a) => a.kind === "conflict" && a.abs.includes("AGENTS.md"))).toBe(true);
    });

    test("бинарный файл без patch пропускается с warning", () => {
      const { dir, machine, project } = fixture();
      writeFileSync(join(dir, "skill", "bin.dat"), Buffer.from([0, 1, 2, 255]));
      const cfg: Resolved = {
        layers: ["l"],
        instructions: [],
        mcp: [],
        skills: [{ item: { name: "s", dir: join(dir, "skill") }, layer: "l" }],
        notes: [],
      };
      const r = gemini.render(cfg, { scope: "project", dir: project, rel: "project" }, machine);
      expect(r.files.some((f) => f.path.endsWith("bin.dat"))).toBe(false);
      expect(r.warnings.some((w) => w.includes("бинарный файл bin.dat пропущен"))).toBe(true);
    });

    test("patch подменяет файл skill", () => {
      const { dir, machine, project } = fixture();
      const cfg: Resolved = {
        layers: ["l"],
        instructions: [],
        mcp: [],
        skills: [
          {
            item: {
              name: "s",
              dir: join(dir, "skill"),
              patch: { "SKILL.md": "---\nname: patched\n---\nPatched body\n" },
            },
            layer: "l",
          },
        ],
        notes: [],
      };
      const r = gemini.render(cfg, { scope: "project", dir: project, rel: "project" }, machine);
      const skillFile = r.files.find((f) => f.path === ".agents/plugins/miksy/skills/s/SKILL.md");
      expect(skillFile?.content).toContain("Patched body");
    });
  });

  describe("metadata and current state", () => {
    test("skillDirs указывает на проверенный .agents/skills", () => {
      expect(gemini.skillDirs).toEqual([".agents/skills"]);
    });

    test("knownDirs читает ~/.gemini/projects.json", () => {
      const { home, machine } = fixture();
      writeFileSync(
        join(home, ".gemini", "projects.json"),
        JSON.stringify({
          projects: {
            "D:\\work\\project1": "project1",
            "D:/work/project2": "project2",
          },
        }),
      );
      expect(gemini.knownDirs!(machine)).toEqual(["D:/work/project1", "D:/work/project2"]);
    });

    test("currentGlobal читает GEMINI.md и mcp_config.json из CLI и IDE", () => {
      const { home } = fixture();
      writeFileSync(join(home, ".gemini", "GEMINI.md"), "# Global Rules\n");
      writeFileSync(
        join(home, ".gemini", "config", "mcp_config.json"),
        JSON.stringify({
          mcpServers: {
            cli_server: { command: "node", args: ["srv.js"] },
            disabled_server: { command: "node", disabled: true },
          },
        }),
      );
      writeFileSync(
        join(home, ".gemini", "antigravity-ide", "mcp_config.json"),
        JSON.stringify({
          mcpServers: {
            ide_server: { url: "https://mcp.org" },
          },
        }),
      );

      const state = currentGlobal(home);
      expect(state.instructionFiles).toContain(join(home, ".gemini", "GEMINI.md").replaceAll("\\", "/"));
      expect(Object.keys(state.mcp)).toContain("cli_server");
      expect(Object.keys(state.mcp)).toContain("ide_server");
      expect(Object.keys(state.mcp)).not.toContain("disabled_server");
    });

    test("currentProject читает rules/AGENTS.md и mcp_config.json плагина miksy", () => {
      const { project, home } = fixture();
      const pRules = join(project, ".agents", "plugins", "miksy", "rules");
      mkdirSync(pRules, { recursive: true });
      writeFileSync(join(project, "GEMINI.md"), "# Gemini Root\n");
      writeFileSync(join(pRules, "AGENTS.md"), "# Miksy Rules\n");
      writeFileSync(
        join(project, ".agents", "plugins", "miksy", "mcp_config.json"),
        JSON.stringify({
          mcpServers: {
            plugin_server: { command: "echo", args: ["hello"] },
          },
        }),
      );
      const state = currentProject(project, home);
      expect(state.instructionFiles).toContain(join(project, "GEMINI.md").replaceAll("\\", "/"));
      expect(state.instructionFiles).toContain(join(pRules, "AGENTS.md").replaceAll("\\", "/"));
      expect(state.mcp.plugin_server).toBeDefined();
      expect(state.mcp.plugin_server.def).toEqual({ command: "echo", args: ["hello"] });
    });
  });
});
