import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { apply, plan, verifyMerges } from "../src/apply";
import { emptyState, loadManifest, ManifestError } from "../src/manifest";
import { canonical } from "../src/paths";
import { cliFixture, put } from "./helpers";

test("R6: doctor показывает конфликт первого sync без учёта", () => {
  const f = cliFixture({ projects: [] });
  put(`${f.home}/.claude/CLAUDE.md`, "<!-- miksy:begin инструкции -->\nручной блок\n<!-- miksy:end -->\n");
  put(`${f.ws}/.keep`, "");
  const r = f.run(["doctor"]);
  expect(r.out).toContain("создан не miksy");
  expect(r.out).not.toContain("Всё синхронизировано");
  expect(r.code).not.toBe(0);
});

test("R10: optional без родителя снимается с учёта без записи JSON", () => {
  const f = cliFixture();
  const path = canonical(`${f.home}/.claude.json`);
  const text = '{"projects": {}}\n';
  put(path, text);
  const prev = emptyState();
  prev.merges[path] = { '["projects","old-alias","mcpServers"]': ["s"] };
  const machine = { home: f.home, workspace: f.ws, os: "linux" as const, vars: {} };
  for (const force of [false, true]) {
    const actions = plan({ files: [], warnings: [] }, { scope: "global" }, machine, prev, force);
    const next = apply(actions, prev).state;
    expect(next.merges).toEqual({});
    expect(verifyMerges(next)).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(text);
  }
});

test("Н7: битый manifest — понятная ошибка; doctor продолжает диагностику", () => {
  const f = cliFixture();
  const path = `${f.config}/local/state/manifest.json`;
  put(path, '{"token":"must-not-leak", broken');
  const sync = f.run(["sync", "--global", "--dry-run"]);
  expect(sync.err).toContain("manifest.json");
  expect(sync.err).toContain("повреждён");
  expect(sync.err).not.toContain("must-not-leak");
  const doctor = f.run(["doctor"]);
  expect(doctor.out).toContain("повреждён");
  expect(doctor.out).toContain("Не синхронизировано");
  expect(doctor.code).not.toBe(0);
  expect(readFileSync(path, "utf8")).toContain("must-not-leak");
});

test("Н7: повреждённая структура учёта тоже диагностируется без падения doctor", () => {
  const f = cliFixture();
  const path = `${f.config}/local/state/manifest.json`;
  for (const bad of [
    { files: { [`${f.home}/file`]: null } },
    { merges: { [`${f.home}/file`]: { '["mcp"]': null } } },
    { exclude: { [`${f.home}/file`]: null } },
    { toml: { [`${f.home}/file`]: null } },
  ]) {
    put(path, JSON.stringify({ version: 1, targets: { "claude|global": { ...emptyState(), ...bad } } }));
    expect(() => loadManifest(path)).toThrow(ManifestError);
  }
  const doctor = f.run(["doctor"]);
  expect(doctor.out).toContain("повреждён");
  expect(doctor.out).toContain("Не синхронизировано");
  expect(doctor.err).not.toContain("TypeError");
});
