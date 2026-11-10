// Выпуск 0.2.1, круг 7b: общее для тестов fixes021b-* (из тестов рецензента проверки 7a, zz-rev021a-helpers.ts)
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENGINE } from "../src/load";
import { put } from "./helpers";
import { read } from "./rootshelp";

export const hasTag = (tag = "v0.2.0") => Bun.spawnSync(["git", "-C", ENGINE, "rev-parse", "--verify", "-q", `${tag}^{commit}`], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;

// Движок тега — файлы во временном каталоге (временный индекс git; индекс и ветки репо не меняются)
export function oldEngine(tag = "v0.2.0"): string {
  const dir = mkdtempSync(join(tmpdir(), "r021-")).replaceAll("\\", "/");
  const env = { ...process.env, GIT_INDEX_FILE: `${dir}/index` };
  for (const args of [["read-tree", tag], ["checkout-index", "-a", "-f", `--prefix=${dir}/engine/`]]) {
    const r = Bun.spawnSync(["git", "-C", ENGINE, ...args], { env, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args[0]}: ${r.stderr}`);
  }
  return `${dir}/engine`;
}
export const oldRunner = (engine: string, f: { dir: string; config: string; home: string }) => (args: string[]) => {
  const r = Bun.spawnSync([process.execPath, `${engine}/src/cli.ts`, ...args], {
    cwd: f.dir, env: { ...process.env, MIKSY_CONFIG: f.config, HOME: f.home, USERPROFILE: f.home }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
export const gitc = (dir: string, ...args: string[]) => Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
export const commit = (dir: string, files: Record<string, string>) => {
  for (const [p, c] of Object.entries(files)) put(`${dir}/${p}`, c);
  gitc(dir, "add", ...Object.keys(files));
  gitc(dir, "commit", "-qm", "team");
};

// Пользователь в окне Claude: доверился проекту сам; «да, больше не спрашивать»; одобрил серверы .mcp.json
export const claudeJson = (home: string) => JSON.parse(read(`${home}/.claude.json`) || "{}");
export function userTrusts(home: string, dir: string) {
  const j = claudeJson(home);
  j.projects ??= {};
  const key = Object.keys(j.projects).find((k) => k.toLowerCase() === dir.toLowerCase()) ?? dir;
  j.projects[key] = { ...(j.projects[key] ?? {}), hasTrustDialogAccepted: true };
  put(`${home}/.claude.json`, JSON.stringify(j, null, 2));
}
export const trusted = (home: string, dir: string) => Object.entries(claudeJson(home).projects ?? {})
  .some(([k, v]) => k.toLowerCase() === dir.toLowerCase() && (v as { hasTrustDialogAccepted?: boolean }).hasTrustDialogAccepted === true);
export const local = (d: string) => `${d}/.claude/settings.local.json`;
export const patchLocal = (d: string, add: Record<string, unknown>) => put(local(d), JSON.stringify({ ...JSON.parse(read(local(d)) || "{}"), ...add }, null, 2));
export const allow = (d: string) => patchLocal(d, { permissions: { allow: ["Bash(ls:*)"] } });

// Все текстовые файлы (кроме бэкапов и .git, кроме info/exclude) — для «повтор ничего не меняет»
export function snapshot(roots: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name === ".git") { if (existsSync(`${p}/info/exclude`)) out[`${p}/info/exclude`] = readFileSync(`${p}/info/exclude`, "utf8"); continue; }
        if (e.name === "backups" || e.name === ".bun" || e.name === "node_modules") continue;
        walk(p);
      } else if (e.isFile() && statSync(p).size < 2_000_000) {
        const b = readFileSync(p);
        if (!b.subarray(0, 8000).includes(0)) out[p] = b.toString("utf8");
      }
    }
  };
  for (const r of roots) walk(r);
  return out;
}
export const diff = (a: Record<string, string>, b: Record<string, string>) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();
