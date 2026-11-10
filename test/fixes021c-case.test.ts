// Выпуск 0.2.1, круг 7c (проверка 7b, B №5): target: true — только из каталога слоёв, который применяется. Из out/check021b/miksy2/test/zz-revb-case.test.ts
import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { cliFixture, put } from "./helpers";
import { git, read, yamlRoots } from "./rootshelp";

function caseTree(config: string): boolean {
  const tree = `${config}/layers/tree`;
  if (process.platform === "linux") return true;
  if (process.platform !== "win32") return false;
  renameSync(tree, `${tree}-old`);
  mkdirSync(tree, { recursive: true });
  const r = Bun.spawnSync(["fsutil.exe", "file", "setCaseSensitiveInfo", tree.replaceAll("/", "\\"), "enable"], { stdout: "pipe", stderr: "pipe" });
  for (const e of readdirSync(`${tree}-old`)) renameSync(`${tree}-old/${e}`, `${tree}/${e}`);
  rmSync(`${tree}-old`, { recursive: true });
  return r.exitCode === 0;
}
const canCase = process.platform === "linux" || process.platform === "win32";

test.skipIf(!canCase)("B №5: двойники регистра — пометка target: true из неприменяемого каталога не действует, из применяемого — действует", () => {
  const f = cliFixture({ projects: ["Org/p1"] });
  const drive = `${f.dir}/drive`;
  git(`${drive}/Acme/site`);
  mkdirSync(`${drive}/Acme/notes`, { recursive: true });
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive, tree: "Clients" }])}agents: [claude]\n`);
  if (!caseTree(f.config)) return;
  put(`${f.config}/layers/tree/Clients/instructions/10.md`, "# rule upper\n");
  put(`${f.config}/layers/tree/clients/instructions/20.md`, "# rule lower\n");
  const twins = readdirSync(`${f.config}/layers/tree`).filter((n) => n.toLowerCase() === "clients");
  if (twins.length < 2) return;
  const [used, other] = twins;
  put(`${f.config}/layers/tree/${other}/Acme/notes/layer.yaml`, "target: true\n");
  const notes = (out: string) => /Acme\/notes/.test(out);
  expect(notes(f.run(["projects"]).out)).toBe(false);
  rmSync(`${f.config}/layers/tree/${other}/Acme`, { recursive: true });
  put(`${f.config}/layers/tree/${used}/Acme/notes/layer.yaml`, "target: true\n");
  expect(notes(f.run(["projects"]).out)).toBe(true);
  const r = f.run(["target", `${drive}/Acme/notes`, "--remove"]);
  expect(r.code).toBe(0);
  expect(read(`${f.config}/layers/tree/${used}/Acme/notes/layer.yaml`)).not.toContain("target: true");
}, 180000);
