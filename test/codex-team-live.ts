// Read Codex's actual skill catalogue in an existing project, without a model turn.
// bun test/codex-team-live.ts <путь к проекту с командными skills>
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const project = process.argv[2] && resolve(process.argv[2]);
if (!project) throw new Error("Pass the project directory to verify");
const expected = ["check", "deploy-k8s", "doc-generate", "setup"];
const out = resolve(import.meta.dir, "../out");
mkdirSync(out, { recursive: true });
const home = mkdtempSync(join(out, "codex-team-live-"));
try {
  mkdirSync(join(home, ".codex"));
  const result = Bun.spawnSync(["codex", "--no-daemon", "debug", "prompt-input", "List available skill metadata only."], {
    cwd: project, env: { ...process.env, CODEX_HOME: join(home, ".codex"), HOME: home, USERPROFILE: home },
    stdout: "pipe", stderr: "pipe", timeout: 30000,
  });
  // Never print the full prompt or config: it may include private project instructions.
  if (result.exitCode !== 0) throw new Error("Codex prompt-input failed (exit " + result.exitCode + ")");
  const strings = (value: unknown): string[] => typeof value === "string" ? [value]
    : Array.isArray(value) ? value.flatMap(strings)
    : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
  const messages = strings(JSON.parse(result.stdout.toString()));
  const catalogues = messages.filter(s => s.includes("### Available skills"));
  if (!catalogues.length) throw new Error("Codex did not include its skills catalogue");
  const paths = catalogues.flatMap(catalogue => {
    const roots = Object.fromEntries([...catalogue.matchAll(/^- `(r\d+)` = `([^`]+)`$/gm)].map(m => [m[1], m[2]]));
    return [...catalogue.matchAll(/\(file: ([^\r\n)]+)\)/g)].map(m => {
      const path = m[1].replaceAll("\\", "/");
      const [root, ...rest] = path.split("/");
      return roots[root] ? join(roots[root], ...rest).replaceAll("\\", "/") : path;
    });
  });
  for (const name of expected) {
    const prefix = project.replaceAll("\\", "/").toLowerCase() + "/";
    const matches = paths.filter(p => p.toLowerCase().startsWith(prefix) && p.endsWith("/" + name + "/SKILL.md"));
    if (matches.length !== 1) throw new Error("Expected one catalogue entry for " + name + ", found " + matches.length);
    console.log(name + ": " + matches[0]);
  }
  const version = Bun.spawnSync(["codex", "--version"], { stdout: "pipe", stderr: "pipe" });
  console.log(version.stdout.toString().trim() + ": all four team skills are visible; no skill executed.");
} finally {
  if (dirname(home) !== out) throw new Error("Unsafe cleanup path");
  rmSync(home, { recursive: true, force: true });
}
