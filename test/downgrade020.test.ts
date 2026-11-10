// Выпуск 0.2.1: учёт (local/state/manifest.json) и решения о доверии (local/trust.json), записанные 0.2.1, настоящий
// v0.2.0 читает без ошибок — откат на одну версию назад. Тег v0.2.0 репо движка разворачивается во временный каталог
// (временный индекс git; индекс и ветки репо не меняются). Тега нет (CI и стенды клонируют без тегов) — пропуск.
// Что теряется при откате: отметка «доверие ставил miksy» после clean (Manifest.trustedBefore) — 0.2.0 её не знает и
// при записи учёта отбрасывает: после отката sync один раз спросит о собственных ответах пользователя в окне Claude
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENGINE } from "../src/load";
import { cliFixture, put } from "./helpers";
import { inProcess, ledger, read } from "./rootshelp";

const TAG = "v0.2.0";
const hasTag = Bun.spawnSync(["git", "-C", ENGINE, "rev-parse", "--verify", "-q", `${TAG}^{commit}`], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;

function oldEngine(): string {
  const dir = mkdtempSync(join(tmpdir(), "v020-")).replaceAll("\\", "/");
  const env = { ...process.env, GIT_INDEX_FILE: `${dir}/index` };
  for (const args of [["read-tree", TAG], ["checkout-index", "-a", "-f", `--prefix=${dir}/engine/`]]) {
    const r = Bun.spawnSync(["git", "-C", ENGINE, ...args], { env, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args[0]}: ${r.stderr}`);
  }
  return `${dir}/engine`;
}
const gitc = (dir: string, ...args: string[]) => Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);

test.skipIf(!hasTag)("учёт и local/trust.json 0.2.1 (отметка доверия после clean, «нет» серверам .mcp.json, «забыть») — v0.2.0 читает без ошибок", () => {
  const engine = oldEngine();
  const f = cliFixture({ agents: ["claude", "codex"], projects: ["Org/p1", "Org/p2"] });
  const p1 = `${f.ws}/Org/p1`, p2 = `${f.ws}/Org/p2`;
  const old = (args: string[]) => {
    const r = Bun.spawnSync([process.execPath, `${engine}/src/cli.ts`, ...args], {
      cwd: f.dir, env: { ...process.env, MIKSY_CONFIG: f.config, HOME: f.home, USERPROFILE: f.home }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  // 0.2.1: p1 — доверие ставил miksy, затем clean (отметка trustedBefore); p2 — командный .mcp.json, «да», затем «нет»
  expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
  expect(f.run(["clean", p1]).code).toBe(0);
  put(`${p2}/.mcp.json`, JSON.stringify({ mcpServers: { team: { command: "team-server" } } }));
  gitc(p2, "add", ".mcp.json");
  gitc(p2, "commit", "-qm", "team");
  expect(inProcess(f, ["sync", p2], f.dir, ["y"]).questions.length).toBe(1);
  expect(f.run(["trust", p2, "--deny"]).code).toBe(0);
  expect(Object.keys((ledger(f.config) as { trustedBefore?: Record<string, string> }).trustedBefore ?? {}).length).toBe(1);
  expect(JSON.parse(read(`${f.config}/local/trust.json`)).decisions).toBeTruthy();
  // v0.2.0: doctor, sync --all и снова doctor — без ошибок учёта и решений
  const steps = [old(["doctor"]), old(["sync", "--all", "--yes"]), old(["doctor"])];
  for (const s of steps) {
    expect(s.err).toBe("");
    expect(s.out).not.toMatch(/учёт повреждён|не разбирается/);
  }
  expect(steps[1].code === 0 || steps[1].code === 3).toBe(true);
  // Вернулись на 0.2.1 — всё читается
  const back = f.run(["doctor"]);
  expect({ err: back.err, broken: /учёт повреждён|не разбирается/.test(back.out) }).toEqual({ err: "", broken: false });
}, 180000);
