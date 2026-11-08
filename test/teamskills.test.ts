import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { safeName, scanTeamSkills, withTeamSkills } from "../src/teamskills";
import type { Resolved } from "../src/types";

const cfg = (over: Partial<Resolved> = {}): Resolved => ({ layers: ["l"], instructions: [], skills: [], mcp: [], notes: [], ...over });

const skill = (name: string, desc = "Does things") => `---\nname: ${name}\ndescription: ${desc}\n---\nBody\n`;

function repo(files: Record<string, string>, untracked: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "team-skills-"));
  Bun.spawnSync(["git", "init", "--quiet", dir]);
  for (const [p, c] of Object.entries({ ...files, ...untracked })) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  Bun.spawnSync(["git", "-C", dir, "add", "--", ...Object.keys(files)]);
  // Импорт берёт только закоммиченное
  Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "--allow-empty", "-m", "team"]);
  return dir;
}

describe("командные skills", () => {
  test("стандартные пути и кто их видит", () => {
    const r = scanTeamSkills(repo({
      ".agents/skills/a/SKILL.md": skill("a"),
      ".claude/skills/b/SKILL.md": skill("b"),
    }));
    const by = Object.fromEntries(r.skills.map((s) => [s.name, s.seenBy]));
    expect(by).toEqual({ a: ["codex", "opencode"], b: ["claude", "opencode"] });
    expect(r.skills.every((s) => s.copies.every((c) => !c.issues.length))).toBe(true);
  });

  test("нестандартные пути и двойная вложенность — ошибка, никто не видит", () => {
    const r = scanTeamSkills(repo({
      ".agents/check/SKILL.md": skill("check"),
      ".codex/skills/skills/deep/SKILL.md": skill("deep"),
    }));
    for (const s of r.skills) {
      expect(s.seenBy).toEqual([]);
      expect(s.source.issues.join()).toContain("нестандартный путь");
    }
    expect(r.skills.find((s) => s.name === "deep")!.source.location).toBe("двойная вложенность");
  });

  test("копии склеиваются по имени; разное содержимое — несколько вариантов; источник — по приоритету", () => {
    const r = scanTeamSkills(repo({
      ".claude/skills/x/SKILL.md": skill("x", "v1"),
      ".agents/skills/x/SKILL.md": skill("x", "v2"),
      ".gemini/skills/x/SKILL.md": skill("x", "v1"),
    }));
    expect(r.skills).toHaveLength(1);
    expect(r.skills[0].copies).toHaveLength(3);
    expect(r.skills[0].variants).toBe(2);
    expect(r.skills[0].source.path).toBe(".agents/skills/x");
    expect(r.skills[0].seenBy).toEqual(["claude", "codex", "opencode", "antigravity"]);
  });

  test("проверка frontmatter", () => {
    const r = scanTeamSkills(repo({
      ".claude/skills/nofm/SKILL.md": "just text\n",
      ".claude/skills/nodesc/SKILL.md": "---\nname: nodesc\n---\n",
      ".claude/skills/other/SKILL.md": skill("renamed"),
    }));
    const issues = (n: string) => r.skills.find((s) => s.name === n)!.source;
    expect(issues("nofm").issues.join()).toContain("нет frontmatter");
    expect(issues("nodesc").issues.join()).toContain("нет description");
    expect(issues("renamed").warnings.join()).toContain("не совпадает с каталогом");
    expect(issues("renamed").issues).toEqual([]);
  });

  test("импорт: только то, что агент не видит; правка name; exclude и skills слоя важнее", () => {
    const dir = repo({
      ".agents/check/SKILL.md": skill("check"), // нестандартный путь — никто не видит
      ".agents/renamed/SKILL.md": "---\nname: Other_Name\ndescription: d\n---\n",
      ".agents/nodesc/SKILL.md": "---\nname: nodesc\n---\n",
      ".agents/skip-me/SKILL.md": skill("skip-me"),
      ".agents/mine/SKILL.md": skill("mine"),
      ".claude/skills/seen/SKILL.md": skill("seen"), // claude и так видит
    });
    const base = cfg({
      importSkills: { item: "all", layer: "l" },
      skillExcludes: ["skip-me"],
      skills: [{ item: { name: "mine", dir: "/layer/mine" }, layer: "proj" }],
    });
    const { cfg: out, warnings } = withTeamSkills(base, dir, "claude");
    const names = out.skills.map((s) => s.item.name).sort();
    expect(names).toEqual(["check", "mine", "other-name"]);
    expect(out.skills.find((s) => s.item.name === "mine")!.layer).toBe("proj");
    const renamed = out.skills.find((s) => s.item.name === "other-name")!.item;
    expect(renamed.patch!["SKILL.md"]).toContain("name: other-name");
    expect(warnings.join()).toContain("nodesc");
  });

  test("импорт: список имён и выключение", () => {
    const dir = repo({ ".agents/a/SKILL.md": skill("a"), ".agents/b/SKILL.md": skill("b") });
    const pick = withTeamSkills(cfg({ importSkills: { item: ["b", "zzz"], layer: "l" } }), dir, "claude");
    expect(pick.cfg.skills.map((s) => s.item.name)).toEqual(["b"]);
    expect(pick.warnings.join()).toContain("zzz");
    expect(withTeamSkills(cfg({ importSkills: { item: false, layer: "l" } }), dir, "claude").cfg.skills).toEqual([]);
    expect(withTeamSkills(cfg(), dir, "claude").cfg.skills).toEqual([]);
  });

  test("импорт auto: больше лимита — ничего, all — без лимита", () => {
    const files = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`.agents/s${i}/SKILL.md`, skill(`s${i}`)]));
    const dir = repo(files);
    const auto = withTeamSkills(cfg({ importSkills: { item: "auto", layer: "l" } }), dir, "claude");
    expect(auto.cfg.skills).toEqual([]);
    expect(auto.warnings.join()).toContain("больше 30");
    expect(withTeamSkills(cfg({ importSkills: { item: "all", layer: "l" } }), dir, "claude").cfg.skills).toHaveLength(31);
  }, 30000);

  test("safeName", () => {
    expect(safeName("Source_Command Setup")).toBe("source-command-setup");
  });

  test("только отслеживаемые git файлы; команды отдельно; не git — пусто", () => {
    const dir = repo({ ".claude/commands/do.md": "# do\n" }, { ".claude/skills/local/SKILL.md": skill("local") });
    const r = scanTeamSkills(dir);
    expect(r.skills).toEqual([]);
    expect(r.commands.map((c) => c.path)).toEqual([".claude/commands/do.md"]);
    expect(scanTeamSkills(mkdtempSync(join(tmpdir(), "nogit-"))).git).toBe(false);
  });
});
