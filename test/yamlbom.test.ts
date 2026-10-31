// YAML конфигурации с BOM (PowerShell 5.1: Set-Content -Encoding utf8, Блокнот) читается как без него
import { expect, test } from "bun:test";
import { cliFixture, put } from "./helpers";

test("mcp/*.yaml и layer.yaml с BOM: первый ключ не теряется", () => {
  const f = cliFixture({ projects: ["Org/p1"] });
  put(`${f.config}/layers/tree/mcp/bom.yaml`, "﻿name: bom\ncommand: bom-server\n");
  put(`${f.config}/layers/tree/Org/layer.yaml`, "﻿target: true\n");
  const r = f.run(["explain", `${f.ws}/Org/p1`]);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  expect(r.out).toContain("bom");
  expect(f.run(["projects"]).out).toMatch(/помечено целями \(target: true\): 1/);
}, 60000);
