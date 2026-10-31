import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { orphanTreeDirs, treeLayers } from "../src/load";

function miksyRoot() {
  const root = mkdtempSync(join(tmpdir(), "miksy-tree-"));
  const tree = join(root, "layers", "tree");
  const put = (rel: string, content = "") => {
    mkdirSync(join(tree, rel, ".."), { recursive: true });
    writeFileSync(join(tree, rel), content);
  };
  put("layer.yaml", "import_skills: auto\n");
  put("instructions/00.md", "# ws\n");
  put("Org/mcp/a.yaml", "name: a\nurl: u\n");
  put("Org/Team/mcp/b.yaml", "name: b\nurl: u\n");
  put("Org/proj/instructions/x.md", "# proj\n");
  mkdirSync(join(tree, "Other", "Empty"), { recursive: true }); // каталоги без содержимого — не слои
  return root;
}

describe("слои-дерево", () => {
  test("по пути проекта — все каталоги с содержимым, сверху вниз", () => {
    const root = miksyRoot();
    expect(treeLayers("Org/Team/svc", root).map((l) => l.name)).toEqual(["workspace", "Org", "Org/Team"]);
    expect(treeLayers("Org/proj", root).map((l) => l.name)).toEqual(["workspace", "Org", "Org/proj"]);
    expect(treeLayers("Elsewhere/x", root).map((l) => l.name)).toEqual(["workspace"]);
    expect(treeLayers("Other/Empty/x", root).map((l) => l.name)).toEqual(["workspace"]);
  });

  test("имена без учёта регистра", () => {
    expect(treeLayers("org/team/svc", miksyRoot()).map((l) => l.name)).toEqual(["workspace", "Org", "Org/Team"]);
  });

  test("содержимое слоя не путается с организацией", () => {
    // проект с именем «mcp» внутри Org не должен подцепить Org/mcp как слой
    expect(treeLayers("Org/mcp/x", miksyRoot()).map((l) => l.name)).toEqual(["workspace", "Org"]);
  });

  test("слои без каталога: ветка целиком — один раз; похожее имя — подсказка", () => {
    const root = miksyRoot();
    const ws = mkdtempSync(join(tmpdir(), "ws-"));
    mkdirSync(join(ws, "org", "Team"), { recursive: true });
    mkdirSync(join(ws, "org", "proj_v2"), { recursive: true });
    expect(orphanTreeDirs(ws, root).sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: "Org/proj", suggestion: "Org/proj_v2" }, // похоже — вероятная опечатка/переименование
      { path: "Other" }, // ветки нет на этой машине; вложенный Other/Empty не перечисляется
    ]);
  });

  test("нет похожего — только справка", () => {
    const root = miksyRoot();
    const ws = mkdtempSync(join(tmpdir(), "ws-"));
    mkdirSync(join(ws, "Org", "Team"), { recursive: true });
    mkdirSync(join(ws, "Org", "billing"), { recursive: true });
    expect(orphanTreeDirs(ws, root)).toEqual([{ path: "Org/proj" }, { path: "Other" }]);
  });
});
