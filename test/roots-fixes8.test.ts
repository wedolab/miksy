// Микроправка перед выпуском 0.2.0 (phase-roots-fixes8, п. 1): записанное miksy в сам основной корень
// workspace — совет без root remove (основной корень не убирается) и без «добавлен по ошибке». Из тестов
// рецензентов проверки 6z: zz-ra-wsroot (настоящий 0.1.1) и zz-b6z-rooted (workspace сменили на бывший проект)
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENGINE } from "../src/load";
import { cliFixture, put } from "./helpers";
import { git, read } from "./rootshelp";

const TAG = "v0.1.1";
const hasTag = Bun.spawnSync(["git", "-C", ENGINE, "rev-parse", "--verify", "-q", `${TAG}^{commit}`], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;

function oldEngine(): string {
  const dir = mkdtempSync(join(tmpdir(), "v011-")).replaceAll("\\", "/");
  const env = { ...process.env, GIT_INDEX_FILE: `${dir}/index` };
  for (const args of [["read-tree", TAG], ["checkout-index", "-a", "-f", `--prefix=${dir}/engine/`]]) {
    const r = Bun.spawnSync(["git", "-C", ENGINE, ...args], { env, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args[0]}: ${r.stderr}`);
  }
  return `${dir}/engine`;
}

type F = ReturnType<typeof cliFixture>;

// Совет из sync --all и doctor выполняется дословно, после него doctor и sync --all спокойны. Это проблема
// doctor: единственная — «Проблем: 1», код 1 (проверка основного агента 6z+); после clean — «Всё синхронизировано»
function followAdvice(f: F, dir: string) {
  expect(f.run(["sync", "--global"]).code).toBe(0);
  const s = f.run(["sync", "--all", "--yes"]);
  const d = f.run(["doctor"]);
  const problems = d.out.split("Справочно")[0];
  const warning = s.out.split("\n").find((l) => l.includes(`${dir} — `) && l.includes("корень workspace")) ?? "";
  const advice = `miksy clean "${dir}"`;
  expect({
    sync: warning.includes(advice),
    doctor: d.code,
    count: problems.includes("Проблем: 1."),
    section: problems.includes("Записанное в основной корень workspace") && problems.includes(dir) && problems.includes(advice),
    oldSection: problems.includes("Проект стал корнем"),
    rootRemove: (s.out + d.out).includes("root remove"),
    mistake: (s.out + d.out).includes("по ошибке"),
  }).toEqual({ sync: true, doctor: 1, count: true, section: true, oldSection: false, rootRemove: false, mistake: false });
  // Совет — дословно
  const c = f.run(advice.split(" ").slice(1).map((x) => x.replace(/^"(.*)"$/, "$1")));
  expect({ code: c.code, left: [`${dir}/CLAUDE.local.md`, `${dir}/.codex/config.toml`].some((p) => read(p).includes("miksy")) }).toEqual({ code: 0, left: false });
  const d2 = f.run(["doctor"]);
  expect({ code: d2.code, rooted: d2.out.includes("основной корень workspace"), clean: d2.out.includes("Всё синхронизировано.") }).toEqual({ code: 0, rooted: false, clean: true });
  const s2 = f.run(["sync", "--all", "--yes"]);
  expect({ code: s2.code, warned: s2.out.includes(`${dir} — `) && s2.out.includes("корень workspace") }).toEqual({ code: 0, warned: false });
}

describe("п. 1 — записанное в основной корень workspace: совет clean, без root remove", () => {
  test.skipIf(!hasTag)("0.1.1: miksy sync <корень workspace>, затем новая версия", () => {
    const engine = oldEngine();
    const f = cliFixture({ agents: ["claude", "codex"], projects: ["Org/p1"] });
    const old = (args: string[]) => {
      const r = Bun.spawnSync([process.execPath, `${engine}/src/cli.ts`, ...args], {
        cwd: f.dir, env: { ...process.env, MIKSY_CONFIG: f.config, HOME: f.home, USERPROFILE: f.home }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
    };
    put(`${f.config}/layers/tree/mcp/t.yaml`, "name: t\ncommand: echo\nargs: [x]\n");
    expect(old(["sync", f.ws]).code).toBe(0);
    expect(read(`${f.ws}/.codex/config.toml`)).toContain("miksy");
    expect(old(["sync", "--all", "--yes"]).err).toBe("");
    followAdvice(f, f.ws);
  }, 200000);

  test("workspace сменили на бывший проект", () => {
    const f = cliFixture({ projects: ["W"] });
    const w = `${f.ws}/W`;
    git(w);
    expect(f.run(["sync", w]).code).toBe(0);
    expect(read(`${w}/CLAUDE.local.md`)).toContain("# workspace");
    git(`${w}/inner`);
    put(`${f.config}/local/machine.yaml`, `workspace: ${w}\nagents: [claude]\n`);
    followAdvice(f, w);
  }, 120000);
});
