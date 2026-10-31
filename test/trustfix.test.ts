import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { cliFixture, put } from "./helpers";

const claudeProjects = (home: string) => JSON.parse(readFileSync(`${home}/.claude.json`, "utf8")).projects ?? {};
const codexProjects = (home: string) => (Bun.TOML.parse(readFileSync(`${home}/.codex/config.toml`, "utf8")) as any).projects ?? {};

// Claude пишет hasTrustDialogAccepted: false в запись проекта по умолчанию (вопрос о доверии
// ещё не задавался — например, в Zed он не задаётся). Это не отказ: отказ Claude не сохраняет.
test("доверие Claude: false по умолчанию → sync ставит true, clean возвращает false", () => {
  const f = cliFixture({ agents: ["claude"] });
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  const key = Object.keys(claudeProjects(f.home)).find((k) => claudeProjects(f.home)[k].hasTrustDialogAccepted === true)!;
  expect(key).toBeTruthy();
  expect(f.run(["clean", "--all"]).code).toBe(0);
  const cfg = JSON.parse(readFileSync(`${f.home}/.claude.json`, "utf8"));
  cfg.projects[key] = { ...cfg.projects[key], hasTrustDialogAccepted: false, lastSessionId: "s1" };
  writeFileSync(`${f.home}/.claude.json`, JSON.stringify(cfg, null, 2));

  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  expect(claudeProjects(f.home)[key].hasTrustDialogAccepted).toBe(true);
  expect(f.run(["clean", "--all"]).code).toBe(0);
  expect(claudeProjects(f.home)[key].hasTrustDialogAccepted).toBe(false);
  expect(claudeProjects(f.home)[key].lastSessionId).toBe("s1");
}, 60000);

// Запрет доверия для проекта или организации — явно в слое дерева; поставленное раньше снимается
test("доверие: trust в layer.yaml запрещает и снимает своё доверие Codex и Claude", () => {
  const f = cliFixture({ agents: ["codex", "claude"] });
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  expect(Object.values(codexProjects(f.home)).some((x: any) => x.trust_level === "trusted")).toBe(true);
  expect(Object.values(claudeProjects(f.home)).some((x: any) => x.hasTrustDialogAccepted === true)).toBe(true);

  put(`${f.config}/layers/tree/Org/layer.yaml`, "trust: { codex: false, claude: false }\n");
  put(`${f.config}/layers/tree/Org/instructions/00.md`, "# org\n");
  const r = f.run(["sync", "--all", "--yes"]);
  expect(r.code).toBe(0);
  expect(Object.values(codexProjects(f.home)).some((x: any) => x.trust_level === "trusted")).toBe(false);
  expect(Object.values(claudeProjects(f.home)).some((x: any) => x.hasTrustDialogAccepted === true)).toBe(false);
  const doctor = f.run(["doctor"]);
  expect(doctor.out + doctor.err).toContain("запрещено в слое");
}, 60000);

test("доверие: trust в layer.yaml проверяется при загрузке", () => {
  const f = cliFixture({ agents: ["claude"] });
  put(`${f.config}/layers/tree/Org/layer.yaml`, "trust: { claude: maybe }\n");
  put(`${f.config}/layers/tree/Org/instructions/00.md`, "# org\n");
  const r = f.run(["sync", "--all", "--yes", "--dry-run"]);
  expect(r.code).not.toBe(0);
  expect(r.out + r.err).toContain("trust");
}, 30000);
