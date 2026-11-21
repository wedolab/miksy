// Микроправка перед выпуском 0.2.0 (phase-roots-fixes8, п. 1): записанное miksy в сам основной корень
// workspace — совет без root remove (основной корень не убирается) и без «добавлен по ошибке». Из тестов
// рецензентов проверки 6z: zz-b6z-rooted (workspace сменили на бывший проект).
// Круг 10r: тест с настоящим 0.1.1 снят (обновление с 0.1.x не поддерживается)
import { describe, expect, test } from "bun:test";
import { cliFixture, put, expectCode, said } from "./helpers";
import { git, read } from "./rootshelp";

type F = ReturnType<typeof cliFixture>;

// Совет из sync --all и doctor выполняется дословно, после него doctor и sync --all спокойны. Это проблема
// doctor: единственная — «Проблем: 1», код 1 (проверка основного агента 6z+); после clean — «Всё синхронизировано»
function followAdvice(f: F, dir: string) {
  expectCode(f.run(["sync", "--global"]), 0);
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
  }, said(d)).toEqual({ sync: true, doctor: 1, count: true, section: true, oldSection: false, rootRemove: false, mistake: false });
  // Совет — дословно
  const c = f.run(advice.split(" ").slice(1).map((x) => x.replace(/^"(.*)"$/, "$1")));
  expect({ code: c.code, left: [`${dir}/CLAUDE.local.md`, `${dir}/.codex/config.toml`].some((p) => read(p).includes("miksy")) }, said(c)).toEqual({ code: 0, left: false });
  const d2 = f.run(["doctor"]);
  expect({ code: d2.code, rooted: d2.out.includes("основной корень workspace"), clean: d2.out.includes("Всё синхронизировано.") }, said(d2)).toEqual({ code: 0, rooted: false, clean: true });
  const s2 = f.run(["sync", "--all", "--yes"]);
  expect({ code: s2.code, warned: s2.out.includes(`${dir} — `) && s2.out.includes("корень workspace") }, said(s2)).toEqual({ code: 0, warned: false });
}

describe("п. 1 — записанное в основной корень workspace: совет clean, без root remove", () => {
  test("workspace сменили на бывший проект", () => {
    const f = cliFixture({ projects: ["W"] });
    const w = `${f.ws}/W`;
    git(w);
    expectCode(f.run(["sync", w]), 0);
    expect(read(`${w}/CLAUDE.local.md`)).toContain("# workspace");
    git(`${w}/inner`);
    put(`${f.config}/local/machine.yaml`, `workspace: ${w}\nagents: [claude]\n`);
    followAdvice(f, w);
  }, 120000);
});
