import { describe, expect, test } from "bun:test";
import { merge, selectGlobal, selectProject, varRefs, varSource } from "../src/resolve";
import type { MiksyMap, Layer } from "../src/types";

const layer = (name: string, over: Partial<Layer> = {}): Layer => ({
  name, dir: `/layers/${name}`, exclude: [], instructions: [], skills: [], mcp: [], ...over,
});

const map: MiksyMap = {
  global: [{ use: "global" }, { use: "env-windows", os: "windows" }, { use: "env-macos", os: "macos" }],
  layers: [
    { match: "**", use: "workspace" },
    { match: "Org/**", use: "org" },
    { match: "Org/Team/**", use: "team" },
    { match: "Org/hr", use: "hr" },
  ],
};

describe("выбор слоёв", () => {
  test("глобальные — по ОС", () => {
    expect(selectGlobal(map, "windows")).toEqual(["global", "env-windows"]);
    expect(selectGlobal(map, "macos")).toEqual(["global", "env-macos"]);
  });

  test("проект — все совпавшие, в порядке map.yaml", () => {
    expect(selectProject(map, "Org/Team/infra", "windows")).toEqual(["workspace", "org", "team"]);
    expect(selectProject(map, "Org/hr", "windows")).toEqual(["workspace", "org", "hr"]);
    expect(selectProject(map, "Other/x", "windows")).toEqual(["workspace"]);
  });

  test("точный путь не цепляет соседей и вложенные проекты", () => {
    expect(selectProject(map, "Org/hr-old", "windows")).toEqual(["workspace", "org"]);
    expect(selectProject(map, "Org/hr/sub", "windows")).toEqual(["workspace", "org"]);
  });

  test("корень workspace получает только **", () => {
    expect(selectProject(map, "", "windows")).toEqual(["workspace"]);
  });
});

describe("склейка", () => {
  test("инструкции склеиваются по порядку слоёв", () => {
    const r = merge([
      layer("a", { instructions: [{ file: "00.md", path: "a/00.md" }] }),
      layer("b", { instructions: [{ file: "00.md", path: "b/00.md" }] }),
    ], "windows");
    expect(r.instructions.map((i) => i.item.path)).toEqual(["a/00.md", "b/00.md"]);
  });

  test("MCP с тем же именем: нижний слой перекрывает верхний", () => {
    const r = merge([
      layer("org", { mcp: [{ name: "gitlab", command: "old" }] }),
      layer("team", { mcp: [{ name: "gitlab", command: "new" }] }),
    ], "windows");
    expect(r.mcp).toEqual([{ item: { name: "gitlab", command: "new" }, layer: "team" }]);
    expect(r.notes).toContain("mcp gitlab: team перекрывает org");
  });

  test("exclude убирает пришедшее сверху, но не своё", () => {
    const r = merge([
      layer("org", { mcp: [{ name: "linear", url: "u" }], instructions: [{ file: "x.md", path: "org/x.md" }] }),
      layer("team", { exclude: ["mcp.linear", "instructions.x.md"], mcp: [{ name: "own", url: "u" }] }),
    ], "windows");
    expect(r.mcp.map((m) => m.item.name)).toEqual(["own"]);
    expect(r.instructions).toEqual([]);
  });

  test("непонятный exclude — ошибка", () => {
    expect(() => merge([layer("x", { exclude: ["foo.bar"] })], "windows")).toThrow();
  });

  test("MCP с ограничением по ОС пропускается на чужой ОС", () => {
    const l = layer("w", { mcp: [{ name: "gh", command: "gh.exe", os: ["windows"] }] });
    expect(merge([l], "windows").mcp).toHaveLength(1);
    expect(merge([l], "macos").mcp).toHaveLength(0);
  });
});

describe("переменные", () => {
  test("находятся во всех полях и классифицируются", () => {
    const s = { name: "x", command: "${PYTHON}", args: ["${WORKSPACE}/a.py"], env: { T: "${TOKEN}", U: "${NOPE}" } };
    expect(varRefs(s).sort()).toEqual(["NOPE", "PYTHON", "TOKEN", "WORKSPACE"]);
    expect(varRefs({ name: "h", url: "u", headers: { Authorization: "Bearer ${GH}" } })).toEqual(["GH"]);
    expect(varSource("WORKSPACE", {}, {})).toBe("builtin");
    expect(varSource("PYTHON", { PYTHON: "py" }, {})).toBe("machine");
    expect(varSource("TOKEN", {}, { TOKEN: "t" })).toBe("secret");
    expect(varSource("NOPE", {}, {})).toBe("missing");
  });
});
