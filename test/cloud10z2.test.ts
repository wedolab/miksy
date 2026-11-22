// Круг 10z-2: исправления по рецензии 10z. Своё — только блок exclude с номером этой машины; угадывания по совпадению
// строк с учётом нет (при одинаковых слоях двух машин строки совпадают у обеих). Блок без метки — прежний: свой, пока
// своего блока с меткой нет; первый sync тихо пишет свой блок. Смена номера — подсказка doctor и sync --machine-was.
// Сбой получения номера компьютера — в проектах с git ничего не пишется и не убирается, одна строка, код не 0
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { cliFixture, expectCode, put, textFiles } from "./helpers";
import { git, inProcess, read, yamlRoots } from "./rootshelp";
import { type HardwareSource, machineId as machineIdOf, setHardwareSource } from "../src/machineid";
import { blocksOf, removeBlock, setBlock } from "../src/excludeblocks";

type F = ReturnType<typeof cliFixture>;
const gitx = (dir: string, ...args: string[]) => Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", `core.excludesFile=${tmpdir()}/no-global-ignore`, ...args],
  { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
const status = (dir: string) => gitx(dir, "status", "--porcelain", "--untracked-files=all").stdout.toString().trim();
const exclude = (dir: string) => read(`${dir}/.git/info/exclude`);
const snap = (dir: string) => Object.fromEntries(textFiles(dir).filter((p) => !p.includes("/.git/")).map((p) => [p.slice(dir.length), readFileSync(p, "utf8")]));
const skill = (name: string) => `---\nname: ${name}\ndescription: ${name}\n---\nbody ${name}\n`;
const machineId = (f: F) => machineIdOf(f.config);
const changes = (out: string) => out.split("\n").filter((l) => /^\s{2}(записать|обновить|удалить|взять под учёт|снять с учёта|восстановить|блок|КОНФЛИКТ|\.git\/info|доверие|слить|одобрение)/.test(l));
const headers = (dir: string) => exclude(dir).split(/\r?\n/).filter((l) => l.startsWith("# >>> miksy:"));
// Блоки 0.5.0: метки убраны, одинаковые блоки слиты в один (у обеих машин на 0.5.0 блок без метки один)
const toPlain = (dir: string) => {
  const lines = [...new Set(exclude(dir).split(/\r?\n/).filter((l) => l.startsWith("/")))].sort();
  writeFileSync(`${dir}/.git/info/exclude`, `# git ls-files --others --exclude-from=.git/info/exclude\n# >>> miksy:claude (сгенерировано, не править)\n${lines.join("\n")}\n# <<< miksy:claude\n`);
};

function twoMachines() {
  const A = cliFixture({ agents: ["claude"], projects: ["Org/a1"] });
  const B = cliFixture({ agents: ["claude"], projects: ["Org/b1"] });
  const cloud = `${A.dir}/cloud`;
  git(`${cloud}/Acme/app`);
  for (const m of [A, B]) {
    put(`${m.config}/local/machine.yaml`, `${yamlRoots([m.ws, { path: cloud, tree: "Cloud" }])}agents: [claude]\n`);
    put(`${m.config}/layers/tree/Cloud/skills/sk/SKILL.md`, skill("sk"));
  }
  return { A, B, cloud, app: `${cloud}/Acme/app` };
}

describe("10z-2: своё — только блок со своим номером", () => {
  test("обе машины обновились, блок без метки, слои одинаковые: sync A тихо пишет свой блок — clean B не удаляет файлы A", () => {
    const { A, B, app } = twoMachines();
    expectCode(A.run(["sync", app]), 0);
    expectCode(B.run(["sync", app]), 0);
    toPlain(app);
    expect(headers(app)).toEqual(["# >>> miksy:claude (сгенерировано, не править)"]);
    const s = A.run(["sync", app]);
    expect(changes(s.out)).toEqual([]);
    expect(headers(app)).toEqual([`# >>> miksy:claude (машина ${machineId(A)}; сгенерировано, не править)`]);
    const before = snap(app);
    const c = B.run(["clean", app]);
    expectCode(c, 0);
    expect(c.out).toContain("файл нужен и другой машине в общей папке — не удаляю");
    expect(snap(app)).toEqual(before);
    expect(status(app)).toBe("");
    // clean A — теперь убирает всё (блоков других машин нет)
    expectCode(A.run(["clean", app]), 0);
    expect(existsSync(`${app}/.claude/skills/sk/SKILL.md`)).toBe(false);
    expect(status(app)).toBe("");
  }, 180000);

  test("пока своего блока с меткой нет (sync новой версией не было), clean — как в 0.5.0: блок без метки свой", () => {
    const { A, app } = twoMachines();
    expectCode(A.run(["sync", app]), 0);
    toPlain(app);
    expectCode(A.run(["clean", app]), 0);
    expect(existsSync(`${app}/.claude/skills/sk/SKILL.md`)).toBe(false);
    expect(headers(app)).toEqual([]);
    expect(status(app)).toBe("");
  }, 180000);

  test("у машины нет соли (номера ещё нет) и своего блока, блок другой машины с теми же строками — не забирается, clean не удаляет общие файлы", () => {
    const { A, B, app } = twoMachines();
    expectCode(A.run(["sync", app]), 0);
    expectCode(B.run(["sync", app]), 0);
    const ia = machineId(A);
    rmSync(`${B.config}/local/state/machine-salt`);
    rmSync(`${app}/.git/info/exclude`);
    expectCode(A.run(["sync", app]), 0); // остался только блок A
    expect(headers(app)).toEqual([`# >>> miksy:claude (машина ${ia}; сгенерировано, не править)`]);
    const before = snap(app);
    expectCode(B.run(["clean", app]), 0);
    expect(snap(app)).toEqual(before);
    expect(headers(app)).toEqual([`# >>> miksy:claude (машина ${ia}; сгенерировано, не править)`]);
    expect(status(app)).toBe("");
  }, 180000);

  test("одна машина, в блоке без метки строка пользователя: sync — тихо, строка остаётся; clean убирает всё своё без «нужен другой машине»", () => {
    const { A, app } = twoMachines();
    expectCode(A.run(["sync", app]), 0);
    toPlain(app);
    put(`${app}/notes.txt`, "мои заметки\n");
    writeFileSync(`${app}/.git/info/exclude`, exclude(app).replace("# <<< miksy:claude", "/notes.txt\n# <<< miksy:claude"));
    const s = A.run(["sync", app]);
    expect(changes(s.out)).toEqual([]);
    expect(exclude(app)).toContain("# >>> miksy:claude (сгенерировано, не править)\n/notes.txt\n# <<< miksy:claude");
    const c = A.run(["clean", app]);
    expectCode(c, 0);
    expect(c.out).not.toContain("другой машине");
    expect(existsSync(`${app}/.claude/skills/sk/SKILL.md`)).toBe(false);
    expect(existsSync(`${app}/notes.txt`)).toBe(true);
    expect(status(app)).toBe("");
  }, 180000);

  test("машина на 0.5.0 со своими строками (другие skills): их строки, не покрытые блоками с меткой, остаются — git чист", () => {
    const { A, app } = twoMachines();
    expectCode(A.run(["sync", app]), 0);
    // Блок без метки машины на 0.5.0 со своим skill
    put(`${app}/.claude/skills/old/SKILL.md`, skill("old"));
    writeFileSync(`${app}/.git/info/exclude`, exclude(app) + "# >>> miksy:claude (сгенерировано, не править)\n/.claude/skills/old/\n/CLAUDE.local.md\n# <<< miksy:claude\n");
    expectCode(A.run(["sync", app]), 0);
    expect(exclude(app)).toContain("# >>> miksy:claude (сгенерировано, не править)\n/.claude/skills/old/\n# <<< miksy:claude");
    expect(status(app)).toBe("");
  }, 180000);
});

describe("10z-2: номер машины сменился — doctor и sync --machine-was", () => {
  test("тот же учёт, новый номер: doctor подсказывает один раз; команда — один блок с новым номером, clean снимает всё; блок другой машины с теми же строками не трогается", () => {
    const { A, B, app } = twoMachines();
    expectCode(A.run(["sync", app]), 0);
    expectCode(B.run(["sync", app]), 0);
    const [old, ib] = [machineId(A), machineId(B)];
    expect(JSON.parse(read(`${A.config}/local/state/manifest.json`)).machine).toBe(old);
    // Переустановка: номер новый (соль другая), учёт тот же
    writeFileSync(`${A.config}/local/state/machine-salt`, "ffeeddccbbaa99887766554433221100\n");
    const now = machineId(A);
    expect(now).not.toBe(old);
    const d = A.run(["doctor"]);
    expect(d.out.match(/miksy sync --all --machine-was/g)?.length).toBe(1);
    expect(d.out.match(/miksy sync --all --machine-other/g)?.length).toBe(1);
    expect(d.out).toContain(`Номер этой машины сменился (1) — в этих проектах блоки .git/info/exclude записаны этим учётом под номером ${old}`);
    expect(d.out).toContain(`Переустановили систему или пропал local/state/machine-salt — вернуть их своими: miksy sync --all --machine-was ${old}`);
    expect(d.out).toContain(`local/ перенесён с другого компьютера (это блоки той машины) — miksy sync --all --machine-other ${old}`);
    // Обычный sync старый блок не забирает
    expectCode(A.run(["sync", app]), 0);
    expect(exclude(app)).toContain(`машина ${old}`);
    // Команда из подсказки
    expectCode(A.run(["sync", "--all", "--yes", "--machine-was", old!]), 0);
    const hs = headers(app);
    expect(hs).toContain(`# >>> miksy:claude (машина ${now}; сгенерировано, не править)`);
    expect(hs).toContain(`# >>> miksy:claude (машина ${ib}; сгенерировано, не править)`);
    expect(hs.length).toBe(2);
    expect(status(app)).toBe("");
    expect(JSON.parse(read(`${A.config}/local/state/manifest.json`)).machine).toBe(now);
    expect(A.run(["doctor"]).out).not.toContain("Номер этой машины сменился");
    // Одна машина: clean B, затем clean A — снимают всё
    expectCode(B.run(["clean", app]), 0);
    expectCode(A.run(["clean", app]), 0);
    expect(existsSync(`${app}/.claude/skills/sk/SKILL.md`)).toBe(false);
    expect(headers(app)).toEqual([]);
    expect(status(app)).toBe("");
  }, 180000);

  test("--machine-was и --machine-other: номер другой машины (виден в exclude) — отказ, её блок на месте; неверный номер — ошибка использования", () => {
    const { A, B, app } = twoMachines();
    expectCode(A.run(["sync", app]), 0);
    expectCode(B.run(["sync", app]), 0);
    const [ia, ib] = [machineId(A), machineId(B)];
    const before = exclude(app);
    for (const k of ["--machine-was", "--machine-other"]) {
      const r = A.run(["sync", "--all", "--yes", k, ib!]);
      expect(r.code).toBe(1);
      expect(r.out).toContain(`${k} ${ib}: под этим номером учёт этой машины блоки не записывал (его номер — ${ia}) — это номер другой машины, её блоки не трогаю`);
      expect(exclude(app)).toBe(before);
    }
    expect(A.run(["sync", "--all", "--machine-was", "zzz"]).code).not.toBe(0);
    expect(A.run(["sync", "--all", "--machine-was", ia!, "--machine-other", ia!]).code).not.toBe(0);
  }, 180000);

  test("local/ перенесён с другого компьютера: --machine-other — учёт перестаёт считать номер своим, блоки не трогаются, подсказка уходит", () => {
    const { A, app } = twoMachines();
    expectCode(A.run(["sync", app]), 0);
    const old = machineId(A);
    // «Другой компьютер»: тот же local/, номер другой
    writeFileSync(`${A.config}/local/state/machine-salt`, "ffeeddccbbaa99887766554433221100\n");
    expect(A.run(["doctor"]).out).toContain("Номер этой машины сменился");
    const r = A.run(["sync", "--all", "--yes", "--machine-other", old!]);
    expectCode(r, 0);
    expect(r.out).toContain(`Номер ${old} учёт больше не считает своим`);
    expect(JSON.parse(read(`${A.config}/local/state/manifest.json`)).machine).toBe(machineId(A));
    expect(exclude(app)).toContain(`(машина ${old}; `);
    expect(A.run(["doctor"]).out).not.toContain("Номер этой машины сменился");
    // Файлы под блоком той машины clean не убирает
    expect(A.run(["clean", app]).out).toContain("файл нужен и другой машине в общей папке — не удаляю");
    expect(existsSync(`${app}/.claude/skills/sk/SKILL.md`)).toBe(true);
  }, 180000);
});

describe("10z-4: ошибочный --machine-other отменяется", () => {
  test("соль сменилась, выбрана не та команда: --machine-other → повтор «уже сделано» → --machine-was — один блок, clean снимает всё", () => {
    const { A, app } = twoMachines();
    expectCode(A.run(["sync", app]), 0);
    const old = machineId(A)!;
    writeFileSync(`${A.config}/local/state/machine-salt`, "ffeeddccbbaa99887766554433221100\n");
    const now = machineId(A);
    const o = A.run(["sync", "--all", "--yes", "--machine-other", old]);
    expectCode(o, 0);
    expect(o.out).toContain(`Если это была переустановка этой машины — miksy sync --all --machine-was ${old}`);
    expect(JSON.parse(read(`${A.config}/local/state/manifest.json`)).machineOther).toEqual([old]);
    const again = A.run(["sync", "--all", "--yes", "--machine-other", old]);
    expectCode(again, 0);
    expect(again.out).toContain(`Номер ${old} учёт уже не считает своим`);
    // Отмена
    expectCode(A.run(["sync", "--all", "--yes", "--machine-was", old]), 0);
    expect(headers(app)).toEqual([`# >>> miksy:claude (машина ${now}; сгенерировано, не править)`]);
    const ledger = JSON.parse(read(`${A.config}/local/state/manifest.json`));
    expect(ledger.machine).toBe(now);
    expect(ledger.machineOther).toBeUndefined();
    expect(status(app)).toBe("");
    expectCode(A.run(["clean", app]), 0);
    expect(existsSync(`${app}/.claude/skills/sk/SKILL.md`)).toBe(false);
    expect(headers(app)).toEqual([]);
    expect(status(app)).toBe("");
  }, 180000);
});

describe("10z-4: нынешний номер этой машины в --machine-was и --machine-other", () => {
  test("«это номер этой машины — менять нечего», код 0, ни учёт, ни exclude не меняются", () => {
    const { A, app } = twoMachines();
    expectCode(A.run(["sync", app]), 0);
    const id = machineId(A)!;
    const ledger = read(`${A.config}/local/state/manifest.json`), ex = exclude(app);
    for (const k of ["--machine-was", "--machine-other"]) {
      const r = A.run(["sync", "--all", "--yes", k, id]);
      expectCode(r, 0);
      expect(r.out).toContain(`${k} ${id}: это номер этой машины — менять нечего`);
      expect(read(`${A.config}/local/state/manifest.json`)).toBe(ledger);
      expect(exclude(app)).toBe(ex);
    }
    expect(JSON.parse(ledger).machineOther).toBeUndefined();
  }, 180000);
});

describe("10z-2: сбой получения номера компьютера", () => {
  const failing: HardwareSource = { platform: "win32", run: () => null, read: () => null };

  test("10z-3: root remove с согласием при сбое — корень не убирается (machine.yaml, файлы и учёт на месте), код 3, одна строка «повторите»", () => {
    const { A, cloud, app } = twoMachines();
    expectCode(A.run(["sync", "--all", "--yes"]), 0);
    const yaml = read(`${A.config}/local/machine.yaml`), files = snap(app), ledger = read(`${A.config}/local/state/manifest.json`);
    try {
      setHardwareSource(failing);
      const r = inProcess(A, ["root", "remove", cloud], A.dir, [true]);
      expect(r.code).toBe(3);
      expect(r.out).toContain(`Корень ${cloud} не убран`);
      expect(r.out.match(/повторите команду/g)?.length).toBe(1);
      expect(r.questions).toEqual([]);
    } finally { setHardwareSource(null); }
    expect(read(`${A.config}/local/machine.yaml`)).toBe(yaml);
    expect(snap(app)).toEqual(files);
    expect(read(`${A.config}/local/state/manifest.json`)).toBe(ledger);
    // Повтор без сбоя — как обычно
    expectCode(inProcess(A, ["root", "remove", cloud], A.dir, [true]), 0);
    expect(existsSync(`${app}/.claude/skills/sk/SKILL.md`)).toBe(false);
  }, 180000);

  test("10z-3: поиск переездов при сбое — переезд своего проекта не решается и не теряется: строка «повторите», после — переносится", () => {
    const { A, cloud, app } = twoMachines();
    expectCode(A.run(["sync", "--all", "--yes"]), 0);
    const moved = `${cloud}/Acme/app2`;
    require("node:fs").renameSync(app, moved);
    try {
      setHardwareSource(failing);
      const r = inProcess(A, ["sync", "--all", "--yes"], A.dir);
      expect(r.code).toBe(3);
      expect(r.out).not.toContain("перенесён");
      expect(r.out).toContain("номер машины не получен");
      expect(read(`${A.config}/local/state/manifest.json`)).toContain("/Acme/app\"");
    } finally { setHardwareSource(null); }
    expect(A.run(["sync", "--all", "--yes"]).out).toContain("Учёт miksy перенесён вслед за каталогами");
  }, 180000);

  test("sync, clean и doctor при сбое: в проект с git ничего не пишется и не убирается, одна строка, код не 0; повтор после сбоя — как обычно", () => {
    const { A, app } = twoMachines();
    try {
      setHardwareSource(failing);
      const s = inProcess(A, ["sync", app], A.dir);
      expect(s.code).toBe(3);
      expect(s.out.match(/номер машины не получен/g)?.length).toBe(1);
      expect(s.out).toContain("в проекты с git ничего не записано и ничего не убрано — повторите команду");
      expect(existsSync(`${app}/CLAUDE.local.md`)).toBe(false);
      expect(exclude(app)).not.toContain("miksy:");
      expect(existsSync(`${A.config}/local/state/machine-salt`)).toBe(false);
      setHardwareSource(null);
      expectCode(A.run(["sync", app]), 0);
      const before = snap(app), ex = exclude(app);
      setHardwareSource(failing);
      const c = inProcess(A, ["clean", app], A.dir);
      expect(c.code).toBe(3);
      expect(snap(app)).toEqual(before);
      expect(exclude(app)).toBe(ex);
      const d = inProcess(A, ["doctor"], A.dir);
      expect(d.code).not.toBe(0);
      expect(d.out).toContain("номер машины не получен");
      expect(d.out).not.toContain("Устарело");
    } finally { setHardwareSource(null); }
    expectCode(A.run(["clean", app]), 0);
    expect(status(app)).toBe("");
  }, 180000);

  test("испорченная соль: не перезаписывается молча — строка с причиной, код не 0; удалили — новый номер", () => {
    const { A, app } = twoMachines();
    expectCode(A.run(["sync", app]), 0);
    writeFileSync(`${A.config}/local/state/machine-salt`, "испорчено\n");
    const s = A.run(["sync", app]);
    expect(s.code).toBe(3);
    expect(s.out).toContain("machine-salt испорчен");
    expect(read(`${A.config}/local/state/machine-salt`)).toBe("испорчено\n");
    rmSync(`${A.config}/local/state/machine-salt`);
    expectCode(A.run(["sync", app]), 0);
    expect(machineId(A)).toMatch(/^[0-9a-f]{12}$/);
  }, 180000);
});

describe("10z-2: разбор .git/info/exclude", () => {
  test("CRLF: блок находится, дубля нет", () => {
    const { A, app } = twoMachines();
    expectCode(A.run(["sync", app]), 0);
    writeFileSync(`${app}/.git/info/exclude`, exclude(app).replace(/\r?\n/g, "\r\n"));
    expectCode(A.run(["sync", app]), 0);
    expect(headers(app).length).toBe(1);
    expect(changes(A.run(["sync", app]).out)).toEqual([]);
    expect(status(app)).toBe("");
  }, 180000);

  test("блок без строки конца не «проглатывает» следующие; удаление блока в начале файла — без пустой первой строки", () => {
    const text = "# >>> miksy:claude (машина aaaaaaaaaaaa; сгенерировано, не править)\n/x\n# >>> miksy:claude (машина bbbbbbbbbbbb; сгенерировано, не править)\n/y\n# <<< miksy:claude (машина bbbbbbbbbbbb)\n";
    expect(blocksOf(text, "claude")).toEqual([{ owner: "claude", machine: "bbbbbbbbbbbb", lines: ["/y"] }]);
    const two = setBlock(setBlock("", "claude", "aaaaaaaaaaaa", ["/a"]), "claude", "bbbbbbbbbbbb", ["/b"]);
    const left = removeBlock(two.replace(/^\n/, ""), "claude", "aaaaaaaaaaaa");
    expect(left.startsWith("# >>> miksy:claude (машина bbbbbbbbbbbb;")).toBe(true);
  });
});

describe("10z-2: одобрения .mcp.json — в учёт только одобренное этой машиной", () => {
  test("ручное одобрение пользователя не становится «своим»: clean A снимает только своё", () => {
    const { A, app } = twoMachines();
    put(`${app}/.mcp.json`, JSON.stringify({ mcpServers: { team: { command: "runner", args: ["serve"] }, extra: { command: "runner", args: ["x"] } } }));
    gitx(app, "add", "-f", ".mcp.json"); gitx(app, "commit", "-q", "-m", "team");
    put(`${app}/.claude/settings.local.json`, JSON.stringify({ enabledMcpjsonServers: ["extra"] }));
    expectCode(A.run(["sync", app]), 0);
    A.run(["trust", app, "--confirm"]);
    const enabled = () => JSON.parse(read(`${app}/.claude/settings.local.json`) || "{}").enabledMcpjsonServers ?? [];
    expect(enabled().sort()).toEqual(["extra", "team"]);
    expectCode(A.run(["clean", app]), 0);
    expect(enabled()).toEqual(["extra"]);
  }, 180000);
});
