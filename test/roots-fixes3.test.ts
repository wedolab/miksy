// Фаза 0.2.0, исправления после третьей проверки (out/phase-roots-fixes3.md): как miksy узнаёт свои файлы без
// учёта (только по своим уликам; чужое не становится своим), берёт узнанное обратно сам; opencode.json команды;
// подсказки после «забыть»; путь в другом регистре; test/guard.ts и «X:». Тесты рецензента 6u (п. 1–11) —
// здесь, ожидания — по решениям владельца
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { cliFixture, put } from "./helpers";
import { git, inProcess, ledger, read, rootsFixture, yamlRoots } from "./rootshelp";

const status = (dir: string) => Bun.spawnSync(["git", "-C", dir, "status", "--porcelain", "--untracked-files=all"]).stdout.toString();
const ignored = (dir: string, rel: string) => Bun.spawnSync(["git", "-C", dir, "check-ignore", "-q", rel]).exitCode === 0;
// Диск «отключён»: каталог корня пуст, в учёте есть его цели — корень недоступен
const unplug = (dir: string) => { renameSync(dir, `${dir}-disk`); mkdirSync(dir); };
const plugBack = (dir: string) => { rmSync(dir, { recursive: true }); renameSync(`${dir}-disk`, dir); };
const claudeState = (config: string, end: string) => Object.entries(ledger(config).targets).find(([k]) => k.startsWith("claude|") && k.endsWith(end))?.[1];

describe("B.1: чужое не становится своим (рецензия 6u, п. 1–3)", () => {
  test("adopt skill → sync → clean: skill пользователя, который был в проекте до miksy, после clean на месте", () => {
    const f = cliFixture({ projects: ["Org/p1"] });
    const p1 = `${f.ws}/Org/p1`;
    const skill = "---\nname: my\ndescription: d\n---\nмой skill\n";
    put(`${p1}/.claude/skills/my/SKILL.md`, skill);
    const a = f.run(["adopt", p1, "my", "--to", "Org", "--yes"]);
    expect(a.code).toBe(0);
    expect(read(`${f.config}/layers/tree/Org/skills/my/SKILL.md`)).toBe(skill);
    expect(f.run(["sync", p1]).code).toBe(0);
    const originals = Object.keys(claudeState(f.config, "/Org/p1")!.originals ?? {});
    expect(f.run(["clean", p1]).code).toBe(0);
    expect({ originals: originals.some((p) => p.endsWith("/.claude/skills/my/SKILL.md")), after: read(`${p1}/.claude/skills/my/SKILL.md`) })
      .toEqual({ originals: true, after: skill });
  }, 120000);

  test("С8: чужой конфликтный файл в каталоге skill miksy виден git (строка каталога уже была в блоке)", () => {
    const f = cliFixture({ projects: ["Org/p1"] });
    const p1 = `${f.ws}/Org/p1`;
    put(`${f.config}/layers/tree/Org/skills/sk/SKILL.md`, "---\nname: sk\ndescription: d\n---\nbody\n");
    expect(f.run(["sync", p1]).code).toBe(0);
    expect(read(`${p1}/.git/info/exclude`)).toContain("/.claude/skills/sk/");
    put(`${p1}/.claude/skills/sk/notes.md`, "мои заметки\n");
    put(`${f.config}/layers/tree/Org/skills/sk/notes.md`, "заметки слоя\n");
    const s = f.run(["sync", p1]);
    expect(s.out).toContain("КОНФЛИКТ");
    expect(ignored(p1, ".claude/skills/sk/notes.md")).toBe(false);
    expect(ignored(p1, ".claude/skills/sk/SKILL.md")).toBe(true);
  }, 120000);

  test("С8: чужой конфликтный файл в каталоге плагина miksy виден git (строка каталога уже была в блоке)", () => {
    const f = cliFixture({ agents: ["antigravity"], projects: ["Org/p1"] });
    const p1 = `${f.ws}/Org/p1`;
    // Плагин без правил (только skill): правила появятся позже — на месте уже лежит чужой файл
    rmSync(`${f.config}/layers/tree/instructions`, { recursive: true });
    put(`${f.config}/layers/tree/Org/skills/sk/SKILL.md`, "---\nname: sk\ndescription: d\n---\nbody\n");
    expect(f.run(["sync", p1]).code).toBe(0);
    expect(read(`${p1}/.git/info/exclude`)).toContain("/.agents/plugins/miksy/");
    expect(existsSync(`${p1}/.agents/plugins/miksy/rules/AGENTS.md`)).toBe(false);
    put(`${p1}/.agents/plugins/miksy/rules/AGENTS.md`, "чужие заметки\n");
    put(`${f.config}/layers/tree/instructions/00.md`, "# workspace\n");
    const s = f.run(["sync", p1]);
    expect(s.out).toContain("КОНФЛИКТ");
    expect(ignored(p1, ".agents/plugins/miksy/rules/AGENTS.md")).toBe(false);
    expect(ignored(p1, ".agents/plugins/miksy/plugin.json")).toBe(true);
  }, 120000);

  test("чужой файл в каталоге плагина miksy: sync --force сохраняет его оригиналом, clean возвращает", () => {
    const f = cliFixture({ agents: ["antigravity"], projects: ["Org/p1"] });
    const p1 = `${f.ws}/Org/p1`;
    put(`${p1}/.agents/plugins/miksy/rules/AGENTS.md`, "чужие заметки\n");
    expect(f.run(["sync", p1]).out).toContain("создан не miksy");
    expect(f.run(["sync", p1, "--force"]).code).toBe(0);
    expect(read(`${p1}/.agents/plugins/miksy/rules/AGENTS.md`)).toContain("Сгенерировано miksy");
    expect(f.run(["clean", p1]).code).toBe(0);
    expect(read(`${p1}/.agents/plugins/miksy/rules/AGENTS.md`)).toBe("чужие заметки\n");
  }, 120000);

  test("файл пользователя ровно такой, какой записал бы miksy (каталог плагина, не под строкой exclude), — берётся с оригиналом, clean его оставляет", () => {
    const f = cliFixture({ agents: ["antigravity"], projects: ["Org/p1"] });
    const p1 = `${f.ws}/Org/p1`;
    const mine = JSON.stringify({ name: "miksy" }, null, 2) + "\n";
    put(`${p1}/.agents/plugins/miksy/plugin.json`, mine);
    const s = f.run(["sync", p1]);
    expect(s.code).toBe(0);
    expect(s.out).toContain("(содержимое уже совпадает)");
    expect(s.out).not.toContain("которого не было в учёте");
    expect(f.run(["clean", p1]).code).toBe(0);
    expect(read(`${p1}/.agents/plugins/miksy/plugin.json`)).toBe(mine);
  }, 120000);

  test("«Сгенерировано miksy» в середине текста — не улика: файл пользователя берётся с оригиналом", () => {
    const f = cliFixture({ agents: ["opencode"], projects: ["Org/p1"] });
    const p1 = `${f.ws}/Org/p1`;
    const text = "# мои правила\n\nСгенерировано miksy — так пишет miksy в шапке своих файлов\n";
    put(`${p1}/.opencode/miksy.md`, text);
    expect(f.run(["sync", p1]).out).toContain("создан не miksy");
    expect(f.run(["sync", p1, "--force"]).code).toBe(0);
    expect(f.run(["clean", p1]).code).toBe(0);
    expect(read(`${p1}/.opencode/miksy.md`)).toBe(text);
  }, 120000);
});

describe("B.2: opencode.json команды (рецензия 6u, п. 6)", () => {
  test("opencode.json в git в форме файла miksy, без MCP: sync без конфликта, код 0, предупреждение «instructions не записаны»", () => {
    const f = cliFixture({ agents: ["opencode"], projects: ["Org/p1"] });
    const p1 = `${f.ws}/Org/p1`;
    put(`${p1}/opencode.json`, JSON.stringify({ $schema: "https://opencode.ai/config.json", instructions: [".opencode/miksy.md"] }, null, 2) + "\n");
    Bun.spawnSync(["git", "-C", p1, "add", "opencode.json"]);
    const s = f.run(["sync", p1]);
    expect({ code: s.code, conflict: s.out.includes("КОНФЛИКТ") }).toEqual({ code: 0, conflict: false });
    expect(s.out + s.err).toContain("instructions не записаны");
  }, 120000);
});

describe("A.3, B.1, B.5: «забыть» → диск вернулся — miksy узнаёт свои файлы и берёт их обратно сам", () => {
  // Проект archive/Acme/app записан, учёт забыт (clean --forget при отключённом диске), диск вернулся
  const forgotten = (agents = ["claude"], before?: (app: string, f: ReturnType<typeof rootsFixture>) => void) => {
    const f = rootsFixture(agents);
    const app = `${f.archive}/Acme/app`;
    before?.(app, f);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(status(app)).toBe("");
    unplug(f.archive);
    expect(f.run(["clean", app, "--forget"]).code).toBe(0);
    plugBack(f.archive);
    return { ...f, app };
  };

  test("README «Диск нашёлся»: CLAUDE.local.md с тем же блоком — обычный sync берёт его без конфликта; clean — блока нет, текст пользователя вне блока на месте, git status пуст", () => {
    const f = forgotten(["claude"], (app) => {
      // Файл и в .gitignore проекта: текст пользователя после clean остаётся, git его не показывает
      put(`${app}/.gitignore`, "CLAUDE.local.md\n");
      Bun.spawnSync(["git", "-C", app, "add", ".gitignore"]);
      Bun.spawnSync(["git", "-C", app, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "ignore"]);
    });
    put(`${f.app}/CLAUDE.local.md`, `${read(`${f.app}/CLAUDE.local.md`)}\nмои заметки\n`);
    const s = f.run(["sync", f.app]);
    expect(s.code).toBe(0);
    expect(s.out).not.toContain("КОНФЛИКТ");
    expect(s.out).toContain("взять под учёт — блок miksy, которого не было в учёте");
    expect(f.run(["sync", f.app]).out).toContain("изменений нет");
    expect(f.run(["clean", f.app]).code).toBe(0);
    expect(read(`${f.app}/CLAUDE.local.md`)).toBe("\nмои заметки\n");
    expect(status(f.app)).toBe("");
  }, 120000);

  test("блок miksy изменился (слои поменялись, пока диск был отключён) — конфликт, файл не открыт git; --force перезаписывает блок, clean убирает", () => {
    const f = forgotten();
    put(`${f.config}/layers/tree/Archive/instructions/60-new.md`, "# rule new\n");
    const s = f.run(["sync", f.app]);
    expect(s.code).toBe(3);
    expect(s.out).toContain("блок miksy, которого нет в учёте, отличается");
    expect(status(f.app)).toBe("");
    expect(f.run(["sync", f.app, "--force"]).code).toBe(0);
    expect(f.rules(f.app)).toContain("new");
    expect(f.run(["clean", f.app]).code).toBe(0);
    expect({ left: existsSync(`${f.app}/CLAUDE.local.md`), git: status(f.app) }).toEqual({ left: false, git: "" });
  }, 120000);

  test("файл с шапкой miksy изменился — конфликт «файл miksy … отличается», строка exclude остаётся; --force — без оригинала, clean удаляет", () => {
    const f = forgotten(["opencode"]);
    put(`${f.config}/layers/tree/Archive/instructions/60-new.md`, "# rule new\n");
    const s = f.run(["sync", f.app]);
    expect(s.out).toContain("файл miksy, которого нет в учёте, отличается");
    expect(status(f.app)).toBe("");
    expect(f.run(["sync", f.app, "--force"]).code).toBe(0);
    expect(Object.keys(Object.entries(ledger(f.config).targets).find(([k]) => k.startsWith("opencode|") && k.endsWith("/Acme/app"))![1].originals ?? {})).toEqual([]);
    expect(f.run(["clean", f.app]).code).toBe(0);
    expect({ left: existsSync(`${f.app}/.opencode/miksy.md`), git: status(f.app) }).toEqual({ left: false, git: "" });
  }, 120000);

  // Ожидание изменено решением владельца 6w (A.3): clean цели без учёта убирает файлы (блоки) miksy по уликам — блок
  // или шапка и точная строка в exclude; остальные строки блока exclude не трогает
  test("clean сразу после возвращения диска (учёта нет) — убирает блок miksy по уликам вместе с его строкой exclude, git status пуст", () => {
    const f = forgotten();
    expect(read(`${f.app}/.git/info/exclude`)).toContain("/CLAUDE.local.md");
    const c = f.run(["clean", f.app]);
    expect(c.code).toBe(0);
    expect({ file: existsSync(`${f.app}/CLAUDE.local.md`), line: read(`${f.app}/.git/info/exclude`).includes("/CLAUDE.local.md"), git: status(f.app) })
      .toEqual({ file: false, line: false, git: "" });
  }, 120000);
});

describe("B.3: подсказки после «забыть» ведут к цели (рецензия 6u, п. 4)", () => {
  test("root remove --forget недоступного корня → диск вернулся → root add, sync --all, clean — по подсказке; файлов miksy не остаётся", () => {
    const f = rootsFixture();
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    const app = `${f.archive}/Acme/app`;
    unplug(f.archive);
    const r = f.run(["root", "remove", f.archive, "--forget"]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("miksy sync --force в этих проектах");
    expect(r.out).toContain(`Если диск найдётся: сначала верните папку корнем — miksy root add "${f.archive}" --tree Archive; затем miksy sync --all`);
    plugBack(f.archive);
    expect(read(`${app}/CLAUDE.local.md`)).toContain("miksy:begin");
    // Как велит подсказка: вернуть корень, sync --all, затем убрать
    expect(f.run(["root", "add", f.archive, "--tree", "Archive"]).code).toBe(0);
    const s = f.run(["sync", "--all", "--yes"]);
    expect({ code: s.code, err: s.err, conflict: s.out.includes("КОНФЛИКТ") }).toEqual({ code: 0, err: "", conflict: false });
    expect(s.out).toContain("которого не было в учёте");
    expect(f.run(["clean", app]).code).toBe(0);
    expect({ left: existsSync(`${app}/CLAUDE.local.md`), git: status(app) }).toEqual({ left: false, git: "" });
  }, 120000);

  test("clean --forget цели вне всех корней без каталога: подсказка — сначала вернуть папку корнем; по ней файлов miksy не остаётся", () => {
    const f = rootsFixture();
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    const app = `${f.archive}/Acme/app`;
    // Корень убран без «забыть» (без терминала — учёт остаётся), затем диск отключён
    expect(f.run(["root", "remove", f.archive]).code).toBe(0);
    renameSync(f.archive, `${f.archive}-disk`);
    const c = f.run(["clean", app, "--forget"]);
    expect(c.code).toBe(0);
    expect(c.out).toContain(`Если диск найдётся: сначала верните прежний корень workspace, в котором лежал проект, с его прежней веткой (miksy root add "<прежний корень>" --tree <прежняя ветка>), затем miksy sync "${app}"`);
    renameSync(`${f.archive}-disk`, f.archive);
    expect(f.run(["root", "add", f.archive, "--tree", "Archive"]).code).toBe(0);
    const s = f.run(["sync", app]);
    expect({ code: s.code, conflict: s.out.includes("КОНФЛИКТ") }).toEqual({ code: 0, conflict: false });
    expect(f.run(["clean", app]).code).toBe(0);
    expect({ left: existsSync(`${app}/CLAUDE.local.md`), git: status(app) }).toEqual({ left: false, git: "" });
  }, 120000);

  test("clean --forget проекта недоступного корня (корень в workspace): подсказка — sync этого проекта, затем clean", () => {
    const f = rootsFixture();
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    const app = `${f.archive}/Acme/app`;
    unplug(f.archive);
    const c = f.run(["clean", app, "--forget"]);
    expect(c.out).toContain(`забыто. Если диск найдётся: miksy sync "${app}" — файлы miksy, совпадающие с нынешними, он возьмёт обратно сам, изменённые — с miksy sync "${app}" --force (бэкап будет); если они не нужны — после этого miksy clean "${app}".`);
    plugBack(f.archive);
    expect(f.run(["sync", app]).code).toBe(0);
    expect(f.run(["clean", app]).code).toBe(0);
    expect({ left: existsSync(`${app}/CLAUDE.local.md`), git: status(app) }).toEqual({ left: false, git: "" });
  }, 120000);
});

describe("B.6: вложенный недоступный корень, root remove --forget (рецензия 6u, п. 8)", () => {
  test("после «забыть» не советует «убрать записанное сейчас — miksy clean … до root remove»", () => {
    const f = cliFixture({ projects: ["Org/p1"] });
    const mnt = `${f.ws}/mnt`;
    git(`${mnt}/solo`);
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: mnt, tree: "Data" }])}agents: [claude]\n`);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    renameSync(mnt, `${f.dir}/disk`);
    mkdirSync(mnt);
    const r = f.run(["root", "remove", mnt, "--forget"]);
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("до root remove");
  }, 120000);
});

describe("B.9: цель вне всех корней без каталога — doctor нейтрально (рецензия 6u, п. 11)", () => {
  test("«каталога нет — диск не подключён или папку удалили», без «на недоступном диске»; clean <прежний путь> спрашивает, забыть ли", () => {
    const f = rootsFixture();
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    const app = `${f.archive}/Acme/app`;
    expect(f.run(["root", "remove", f.archive]).code).toBe(0);
    rmSync(f.archive, { recursive: true });
    const d = f.run(["doctor"]).out;
    expect(d).not.toContain("на недоступном диске");
    expect(d).toContain(`${app} — каталога нет: диск не подключён или папку удалили. Убрать записанное туда: диск вернётся — miksy clean "<путь>"; папки больше нет — miksy clean "<путь>" (спросит, забыть ли; без терминала — --forget)`);
    const c = inProcess(f, ["clean", app], f.dir, [true]);
    expect(c.questions.length).toBe(1);
    expect(Object.keys(ledger(f.config).targets).some((k) => k.includes("/archive/"))).toBe(false);
  }, 120000);
});

describe.skipIf(process.platform !== "win32")("B.4: clean недоступного каталога — путь в другом регистре (Windows; рецензия 6u, п. 5)", () => {
  test("clean <путь в другом регистре> убирает достижимое и говорит про недоступный диск, как с точным путём", () => {
    const f = rootsFixture();
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    const app = `${f.archive}/Acme/app`;
    const projects = () => JSON.parse(read(`${f.home}/.claude.json`)).projects ?? {};
    expect(projects()[app].mcpServers.ws).toBeDefined();
    unplug(f.archive);
    const r = f.run(["clean", `${f.archive}/acme/APP`]);
    expect(r.code).toBe(0);
    expect({ key: projects()[app]?.mcpServers?.ws, stranded: r.out.includes("На недоступном диске осталось") }).toEqual({ key: undefined, stranded: true });
  }, 120000);
});

describe.skipIf(process.platform !== "win32")("без пути в корне диска (cwd = X:/)", () => {
  test("sync, sync --out, explain: подсказка без root add; explain — только глобальные", () => {
    const f = cliFixture({ projects: ["Org/p1"] });
    const drive = `${f.dir.slice(0, 2)}/`;
    // Корень workspace лежит на том же диске — подсказка «перейдите в каталог проекта» (не root add)
    const s = inProcess(f, ["sync", "--dry-run"], drive);
    expect(s.err).toContain("в нём лежит корень workspace");
    expect(s.err).not.toContain("root add");
    const o = inProcess(f, ["sync", "--out", `${f.dir}/box`, "--dry-run"], drive);
    expect(o.err).toContain("в нём лежит корень workspace");
    expect(o.err).not.toContain("root add");
    expect(inProcess(f, ["explain"], drive).out).toContain("вне workspace — только глобальные настройки");
  }, 60000);
});

describe.skipIf(process.platform !== "win32")("B.7: test/guard.ts — «X:» как его понимает miksy (корень диска; рецензия 6u, п. 9)", () => {
  test("clean X: и root add X: проверяются как X:/ (корень диска вне песочницы), а не как текущий каталог", async () => {
    const { unsafeSpawn } = await import("./guard");
    const f = cliFixture({ projects: ["Org/p1"] });
    const drive = f.dir.slice(0, 2);
    const env = { HOME: f.home, USERPROFILE: f.home, MIKSY_CONFIG: f.config };
    const real = { home: [], configs: [], workspaces: [] };
    const cli = `${f.dir}/engine/src/cli.ts`;
    put(cli, "");
    expect(unsafeSpawn(["bun", cli, "clean", `${drive}/`], { env, cwd: f.ws }, real, [f.dir])).toContain("вне песочницы");
    expect(unsafeSpawn(["bun", cli, "clean", drive], { env, cwd: f.ws }, real, [f.dir])).toContain("вне песочницы");
    expect(unsafeSpawn(["bun", cli, "root", "add", drive, "--tree", "D"], { env, cwd: f.ws }, real, [f.dir])).toContain("вне песочницы");
    expect(unsafeSpawn(["bun", cli, "sync", drive], { env, cwd: f.ws }, real, [f.dir])).toContain("вне песочницы");
    // Обычный путь в песочнице — по-прежнему можно
    expect(unsafeSpawn(["bun", cli, "clean", `${f.ws}/Org/p1`], { env, cwd: f.ws }, real, [f.dir])).toBeNull();
  });
});

describe("root remove: остался один корень — workspace строкой (rewriteRoots)", () => {
  test("BOM, CRLF, комментарии, flow-список, блочные элементы-словари, другие ключи", async () => {
    const { rewriteRoots, rootItems } = await import("../src/rootfile");
    const { parseYaml } = await import("../src/load");
    const cases = [
      "\uFEFF# машина\r\nworkspace:\r\n  - 'D:/ws'   # main\r\n  - path: E:/x\r\n    tree: Clients\r\nvars:\r\n  A: \"1\"\r\nagents: [claude]\r\ntrust: { codex: true }\r\n",
      "workspace: [\"D:/ws\", { path: \"E:/x\", tree: Clients }]  # два корня\nvars: {}\nagents: [claude, gemini]\n",
      "workspace:\n- path: D:/ws\n- { path: E:/x, tree: C }\n# агенты\nagents: [claude]\n",
      "workspace:\n  - ~/Projects\n  - { path: E:/x, tree: C }\n",
    ];
    for (const src of cases) {
      const doc = parseYaml(src) as { workspace: unknown };
      const items = rootItems(doc.workspace);
      const out = rewriteRoots(src, items.slice(0, 1), [0]);
      const after = parseYaml(out) as Record<string, unknown>;
      const before = parseYaml(src) as Record<string, unknown>;
      expect(typeof after.workspace).toBe("string");
      expect({ ...after, workspace: 0 }).toEqual({ ...before, workspace: 0 });
      expect(out.startsWith("\uFEFF")).toBe(src.startsWith("\uFEFF"));
      expect(out.includes("\r\n")).toBe(src.includes("\r\n"));
    }
  });
});

describe("рецензия 6v", () => {
  const forgotten = (agents: string[], before?: (app: string, f: ReturnType<typeof rootsFixture>) => void) => {
    const f = rootsFixture(agents);
    const app = `${f.archive}/Acme/app`;
    before?.(app, f);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    expect(status(app)).toBe("");
    unplug(f.archive);
    expect(f.run(["clean", app, "--forget"]).code).toBe(0);
    plugBack(f.archive);
    return { ...f, app };
  };

  test("п. 1: заметки пользователя в каталоге skill miksy, перенесённые в слой, — оригинал, clean их возвращает (строка каталога — не улика, пока учёт цели есть)", () => {
    const f = cliFixture({ projects: ["Org/p1"] });
    const p1 = `${f.ws}/Org/p1`;
    put(`${f.config}/layers/tree/Org/skills/sk/SKILL.md`, "---\nname: sk\ndescription: d\n---\nbody\n");
    expect(f.run(["sync", p1]).code).toBe(0);
    expect(read(`${p1}/.git/info/exclude`)).toContain("/.claude/skills/sk/");
    const mine = "мои заметки к skill\n";
    put(`${p1}/.claude/skills/sk/notes.md`, mine);
    put(`${f.config}/layers/tree/Org/skills/sk/notes.md`, mine);
    const s = f.run(["sync", p1]);
    const originals = Object.keys(claudeState(f.config, "/Org/p1")?.originals ?? {});
    const c = f.run(["clean", p1]);
    expect({ known: s.out.includes("файл miksy, которого не было в учёте"), original: originals.some((p) => p.endsWith("/.claude/skills/sk/notes.md")),
      afterClean: read(`${p1}/.claude/skills/sk/notes.md`), cleanCode: c.code }).toEqual({ known: false, original: true, afterClean: mine, cleanCode: 0 });
  }, 120000);

  test("п. 1: skill пользователя в каталоге плагина miksy (строка /.agents/plugins/miksy/ уже в блоке), совпавший с выводом, — clean его возвращает", () => {
    const f = cliFixture({ agents: ["antigravity"], projects: ["Org/p1"] });
    const p1 = `${f.ws}/Org/p1`;
    expect(f.run(["sync", p1]).code).toBe(0);
    expect(read(`${p1}/.git/info/exclude`)).toContain("/.agents/plugins/miksy/");
    const skill = "---\nname: my\ndescription: d\n---\nмой skill\n";
    put(`${p1}/.agents/plugins/miksy/skills/my/SKILL.md`, skill);
    put(`${f.config}/layers/tree/Org/skills/my/SKILL.md`, skill);
    const s = f.run(["sync", p1]);
    const c = f.run(["clean", p1]);
    expect({ known: s.out.includes("файл miksy, которого не было в учёте"), afterClean: read(`${p1}/.agents/plugins/miksy/skills/my/SKILL.md`), cleanCode: c.code })
      .toEqual({ known: false, afterClean: skill, cleanCode: 0 });
  }, 120000);

  test("п. 2: opencode.json miksy после «забыть», сервер убран из слоёв — конфликт «файл miksy … отличается»; --force и clean убирают оба файла", () => {
    const f = forgotten(["opencode"], (_app, f) => {
      put(`${f.config}/layers/tree/Archive/mcp/old.yaml`, "name: old\ncommand: echo\nargs: [old]\n");
      put(`${f.config}/layers/tree/Archive/instructions/10-archive.md`, "# rule archive\n");
    });
    expect(read(`${f.app}/opencode.json`)).toContain("\"old\"");
    rmSync(`${f.config}/layers/tree/Archive/mcp/old.yaml`);
    const s = f.run(["sync", f.app]);
    expect(s.out).not.toContain("не от miksy");
    expect(s.out).toContain("файл miksy, которого нет в учёте, отличается");
    expect(status(f.app)).toBe("");
    expect(f.run(["sync", f.app, "--force"]).code).toBe(0);
    expect(read(`${f.app}/opencode.json`)).not.toContain("\"old\"");
    expect(f.run(["clean", f.app]).code).toBe(0);
    expect({ json: existsSync(`${f.app}/opencode.json`), md: existsSync(`${f.app}/.opencode/miksy.md`), git: status(f.app) }).toEqual({ json: false, md: false, git: "" });
  }, 120000);

  test("п. 2: opencode.json пользователя в форме файла miksy с чужим сервером, без строки miksy в exclude — по-прежнему чужой", () => {
    const f = cliFixture({ agents: ["opencode"], projects: ["Org/p1"] });
    const p1 = `${f.ws}/Org/p1`;
    const text = JSON.stringify({ $schema: "https://opencode.ai/config.json", instructions: [".opencode/miksy.md"], mcp: { mine: { type: "local", command: ["x"] } } }, null, 2) + "\n";
    put(`${p1}/opencode.json`, text);
    const s = f.run(["sync", p1]);
    expect(s.out + s.err).toContain("не от miksy");
    expect(f.run(["clean", p1]).code).toBe(0);
    expect(read(`${p1}/opencode.json`)).toBe(text);
  }, 120000);

  // Ожидание изменено решением владельца 6w (A.3): такой блок sync убирает (блок miksy и точная строка в exclude)
  test("п. 3: CLAUDE.local.md с блоком miksy, который miksy сейчас не пишет (появился вложенный репо), — sync убирает блок, git его не видит", () => {
    const f = forgotten(["claude"]);
    git(`${f.app}/sub`);
    f.run(["sync", f.app]);
    expect(read(`${f.app}/CLAUDE.local.md`)).not.toContain("miksy:begin");
    expect(status(f.app)).not.toContain("CLAUDE.local.md");
  }, 120000);

  test("п. 4: ветка из нескольких слов — подсказка root remove --forget выполнима как есть; путь — как записан в machine.yaml", () => {
    const f = cliFixture({ projects: ["Org/p1"] });
    const drive = `${f.dir}/My Drive`;
    git(`${drive}/Acme/site`);
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive, tree: "My Drive" }])}agents: [claude]\n`);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    unplug(drive);
    const r = inProcess(f, ["root", "remove", drive, "--forget"]);
    const hint = r.out.match(/miksy root add "[^"]+" --tree ("[^"]+"|\S+);/)?.[0] ?? "";
    expect(hint).toBe(`miksy root add "${drive}" --tree "My Drive";`);
    plugBack(drive);
    const args = hint.replace(/;$/, "").replace(/^miksy /, "").match(/"[^"]+"|\S+/g)!.map((a) => a.replace(/^"|"$/g, ""));
    const again = f.run(args);
    expect({ code: again.code, err: again.err }).toEqual({ code: 0, err: "" });
  }, 120000);

  test("п. 6: doctor после «забыть» (до sync) не советует adopt для skill, который записал miksy", () => {
    const f = forgotten(["claude"], (_app, f) => put(`${f.config}/layers/tree/Archive/skills/sk/SKILL.md`, "---\nname: sk\ndescription: d\n---\nbody\n"));
    expect(f.run(["doctor"]).out).not.toContain(`skill sk  (${f.app}/.claude/skills/sk)`);
  }, 120000);
});
