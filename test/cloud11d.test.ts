// Круг 11d: файл проекта в общей папке переписала другая машина с другой конфигурацией — конфликт говорит об этом,
// называет причину, где её видно (серверы MCP, агент, старая версия miksy), и что сделать
import { describe, expect, test } from "bun:test";
import { cliFixture, put } from "./helpers";
import { git, yamlRoots } from "./rootshelp";

const AGENTS = ["codex", "opencode", "antigravity"];
const conflicts = (out: string) => out.split("\n").filter((l) => l.includes("КОНФЛИКТ")).join("\n");

function twoMachines() {
  const A = cliFixture({ agents: AGENTS, projects: ["Org/a1"] });
  const B = cliFixture({ agents: AGENTS, projects: ["Org/b1"] });
  const cloud = `${A.dir}/cloud`;
  git(`${cloud}/Acme/app`);
  for (const f of [A, B]) {
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: cloud, tree: "Cloud" }])}agents: [${AGENTS.join(", ")}]\n`);
    put(`${f.config}/layers/tree/Cloud/mcp/plain.yaml`, "name: plain\ncommand: echo\n");
  }
  return { A, B, app: `${cloud}/Acme/app` };
}

describe("11d: файл переписала другая машина", () => {
  test("слои различаются: конфликт называет серверы, которые есть только у одной машины, и что сделать", () => {
    const { A, B, app } = twoMachines();
    put(`${B.config}/layers/tree/Cloud/mcp/extra.yaml`, "name: extra\ncommand: echo\n");
    put(`${B.config}/layers/tree/Cloud/instructions/b.md`, "# только у B\n");
    expect(A.run(["sync", app]).code).toBe(0);
    const b = B.run(["sync", app]);
    expect(b.code).toBe(3);
    const c = conflicts(b.out);
    expect(c).toContain("файл переписала другая машина (общая папка): конфигурации различаются");
    expect(c).toContain("разные MCP-серверы (только здесь: extra)");
    expect(c).toContain("miksy sync на обеих");
    expect(c).not.toContain("которого нет в учёте");
    // Правила тоже разные, а серверов в файле нет — причины не видно: мягче (может быть и ручная правка), тот же совет
    expect(c).toMatch(/AGENTS\.md: файл изменён после последнего sync — вероятно, вручную или другой машиной \(общая папка\): правку вручную перенесите в слои, а конфигурации машин приведите к одной: одна версия miksy/);
    expect(c).toMatch(/config\.toml: файл переписала другая машина \(общая папка\): конфигурации различаются — разные MCP-серверы \(только здесь: extra\): слои конфигурации разные или устарели\. Приведите их к одной: одна версия miksy/);
    // B переписал (--force); теперь у A файл в учёте, но на диске другой — то же сообщение, а не «изменён вручную»
    expect(B.run(["sync", app, "--force"]).code).toBe(0);
    const a = A.run(["sync", app]);
    expect(a.code).toBe(3);
    expect(conflicts(a.out)).toContain("разные MCP-серверы (только там: extra)");
    expect(conflicts(a.out)).not.toContain("изменён вручную после последнего sync (");
  }, 120000);
});
