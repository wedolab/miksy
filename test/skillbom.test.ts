// SKILL.md с BOM (PowerShell 5.1, Блокнот) доставляется без него: Codex иначе не находит шапку и skill не грузит.
// В остальных файлах skill BOM сохраняется (.ps1 для PowerShell 5.1 без него читается в ANSI)
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillFiles } from "../src/skillfiles";
import { put } from "./helpers";

test("skillFiles: BOM снимается только в SKILL.md, в том числе в patch", () => {
  const dir = mkdtempSync(join(tmpdir(), "skillbom-"));
  put(`${dir}/SKILL.md`, "﻿---\nname: s\ndescription: d\n---\n");
  put(`${dir}/scripts/run.ps1`, "﻿Write-Host 'привет'\n");
  const files = skillFiles({ name: "s", dir }, []);
  expect(files.find((f) => f.rel === "SKILL.md")!.content.startsWith("---\n")).toBe(true);
  expect(files.find((f) => f.rel === "scripts/run.ps1")!.content.startsWith("﻿")).toBe(true);
  const patched = skillFiles({ name: "s", dir, patch: { "SKILL.md": "﻿---\nname: s\n---\n" } }, []);
  expect(patched.find((f) => f.rel === "SKILL.md")!.content.startsWith("---\n")).toBe(true);
});
