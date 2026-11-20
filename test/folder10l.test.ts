// Круг 10l: отпечаток папки (номер на диске и время создания). Доверие Claude ставил miksy, а на месте папки теперь
// другая (удалили и положили чужую копию — с clean и без, после «забыть», пути 7 и 11) — ответы в её окне Claude не
// ваши: вопрос «Нужно решение пользователя о доверии», доверие не держится молча. Та же папка (в том числе
// переименованная, за ссылкой) — как раньше. doctor называет доверие к папкам, которыми miksy больше не управляет
import { expect, test } from "bun:test";
import { mkdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { cliFixture, expectCode, put, said } from "./helpers";
import { git, inProcess, ledger, read, yamlRoots } from "./rootshelp";
import { allow, commit, hasTag, local, oldEngine, oldRunner, patchLocal, trusted } from "./fixes021b-helpers";
import { folderId } from "../src/trust";

const pending = (out: string) => out.includes("Нужно решение пользователя о доверии");
// Папку удалили и положили на то же место другую — с ответами в окне Claude того, кто в ней работал
function replaceWithCopy(dir: string) {
  rmSync(dir, { recursive: true, force: true });
  git(dir);
  put(local(dir), JSON.stringify({ permissions: { allow: ["Bash(rm -rf:*)", "Bash(curl:*)"] } }, null, 2));
}
// Исход sync для папки: вопрос и доверие
const outcome = (f: ReturnType<typeof cliFixture>, dir: string) => {
  const s = f.run(["sync", dir]);
  return { code: s.code, pending: pending(s.out), trusted: trusted(f.home, dir), said: said(s) };
};
const brief = (o: ReturnType<typeof outcome>) => ({ pending: o.pending, trusted: o.trusted });
// Учёт Claude проекта (по концу пути, в нижнем регистре)
const claudeState = (f: ReturnType<typeof cliFixture>, tail: string) =>
  Object.entries(ledger(f.config).targets).find(([k]) => k.startsWith("claude|") && k.toLowerCase().endsWith(tail))![1] as { folder?: string; everTrusted?: true };
// Номер папки этой ФС известен (иначе — как раньше, проверять нечего)
const known = () => { const f = cliFixture(); return folderId(f.ws) !== undefined; };

test.skipIf(!known())("подмена без clean: вопрос, доверие снято; «да» — дальше без вопроса; свои новые ответы — без вопроса", () => {
  const f = cliFixture();
  const p = `${f.ws}/Org/p1`;
  expectCode(f.run(["sync", "--all", "--yes"]), 0);
  allow(p);
  expectCode(f.run(["sync", p]), 0);
  expect(ledger(f.config).targets[Object.keys(ledger(f.config).targets).find((k) => k.startsWith("claude|") && k.toLowerCase().endsWith("/org/p1"))!].folder).toBe(folderId(p));
  // Та же папка, вы добавили ответ в окне Claude — вопроса нет (как раньше)
  patchLocal(p, { permissions: { allow: ["Bash(ls:*)", "Bash(git:*)"] } });
  const same = outcome(f, p);
  expect(brief(same), same.said).toEqual({ pending: false, trusted: true });
  replaceWithCopy(p);
  const swapped = outcome(f, p);
  expect(brief(swapped), swapped.said).toEqual({ pending: true, trusted: false });
  // Повтор без решения — тот же вопрос (отпечаток новой папки не принят молча)
  expect(brief(outcome(f, p))).toEqual({ pending: true, trusted: false });
  // Решение пользователя («да» в чате — агент: --confirm) — доверие, дальше без вопроса
  expectCode(f.run(["trust", p, "--confirm"]), 0);
  const after = outcome(f, p);
  expect(brief(after), after.said).toEqual({ pending: false, trusted: true });
  expect(brief(outcome(f, p))).toEqual({ pending: false, trusted: true });
  // Папка после «да» — своя: в учёте её отпечаток и «доверие ставил miksy» (дальше clean ставит отметку, как обычно)
  const st = claudeState(f, "/org/p1");
  expect({ folder: st.folder, ever: st.everTrusted }).toEqual({ folder: folderId(p), ever: true });
  expectCode(f.run(["clean", p]), 0);
  expect((ledger(f.config) as { trustedFolder?: Record<string, string> }).trustedFolder ?? {}).toEqual({ [Object.keys((ledger(f.config) as { trustedBefore?: object }).trustedBefore ?? {})[0]]: folderId(p) });
}, 120000);

test.skipIf(!known())("решение «да» прежней версии (без отпечатка папки) к подменённой папке не применяется", () => {
  const f = cliFixture();
  const p = `${f.ws}/Org/p1`;
  const MCP = { ".mcp.json": JSON.stringify({ mcpServers: { team: { command: "team-server" } } }) };
  commit(p, MCP);
  expectCode(f.run(["sync", "--all", "--yes"]), 0);
  expectCode(f.run(["trust", p, "--confirm"]), 0);
  expect(brief(outcome(f, p))).toEqual({ pending: false, trusted: true });
  // Как записала 0.3.4: решения без отпечатка
  const path = `${f.config}/local/trust.json`;
  const doc = JSON.parse(read(path));
  for (const d of Object.values(doc.decisions) as Record<string, { folder?: string }>[]) for (const x of Object.values(d)) if (x && typeof x === "object") delete x.folder;
  put(path, JSON.stringify(doc, null, 2));
  const old = claudeState(f, "/org/p1").folder;
  replaceWithCopy(p);
  commit(p, MCP);
  const o = outcome(f, p);
  expect(brief(o), o.said).toEqual({ pending: true, trusted: false });
  // Подмена не принята молча: в учёте прежний отпечаток, повтор — тот же вопрос
  expect(claudeState(f, "/org/p1").folder).toBe(old);
  expect(brief(outcome(f, p))).toEqual({ pending: true, trusted: false });
}, 120000);

test.skipIf(!known())("прежнее «да» доверию (серверы .mcp.json команды) не делает ответы подменённой папки вашими", () => {
  const f = cliFixture();
  const p = `${f.ws}/Org/p1`;
  const MCP = { ".mcp.json": JSON.stringify({ mcpServers: { team: { command: "team-server" } } }) };
  commit(p, MCP);
  expectCode(f.run(["sync", "--all", "--yes"]), 0);
  expectCode(f.run(["trust", p, "--confirm"]), 0);
  expect(brief(outcome(f, p))).toEqual({ pending: false, trusted: true });
  // Чужая копия того же репо: те же серверы команды, свои ответы в окне Claude
  replaceWithCopy(p);
  commit(p, MCP);
  const o = outcome(f, p);
  expect(brief(o), o.said).toEqual({ pending: true, trusted: false });
  expect(o.said).toContain("Bash(rm -rf:*)");
}, 120000);

test.skipIf(!known())("подмена после clean: отметка «доверие ставил miksy» не действует; та же папка — без вопроса", () => {
  for (const swap of [false, true]) {
    const f = cliFixture();
    const p = `${f.ws}/Org/p1`;
    expectCode(f.run(["sync", "--all", "--yes"]), 0);
    allow(p);
    expectCode(f.run(["sync", p]), 0);
    expectCode(f.run(["clean", p]), 0);
    expect(Object.keys((ledger(f.config) as { trustedFolder?: object }).trustedFolder ?? {}).length).toBe(1);
    if (swap) replaceWithCopy(p);
    const o = outcome(f, p);
    expect({ swap, ...brief(o) }, o.said).toEqual({ swap, pending: swap, trusted: !swap });
  }
}, 120000);

test.skipIf(!known())("«забыть» → диск вернулся: та же папка — без вопроса; на её месте другая — вопрос", () => {
  for (const swap of [false, true]) {
    const f = cliFixture();
    const drive = `${f.dir}/drive`, site = `${drive}/Acme/site`;
    git(site);
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive, tree: "Clients" }])}agents: [claude]\n`);
    expectCode(f.run(["sync", "--all", "--yes"]), 0);
    allow(site);
    expectCode(f.run(["sync", site]), 0);
    renameSync(drive, `${drive}-off`);
    expectCode(f.run(["clean", site, "--forget"]), 0);
    const mark = Object.values((ledger(f.config) as { forgotten?: Record<string, { trusted?: true; folder?: string }> }).forgotten ?? {}).find((m) => m.trusted);
    expect(mark?.folder).toMatch(/^\d+:\d+$/);
    renameSync(`${drive}-off`, drive);
    if (swap) replaceWithCopy(site);
    const o = outcome(f, site);
    expect({ swap, ...brief(o) }, o.said).toEqual({ swap, pending: swap, trusted: !swap });
  }
}, 120000);

test.skipIf(!known())("пути 7 и 11: диск вернулся с той же папкой — без вопроса (с чужой копией — fixes021c-paths711)", () => {
  for (const path of ["7", "11"]) {
    const f = cliFixture();
    const drive = `${f.dir}/drive`, site = `${drive}/Acme/site`;
    git(site);
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive, tree: "Clients" }])}agents: [claude]\n`);
    expectCode(f.run(["sync", "--all", "--yes"]), 0);
    allow(site);
    expectCode(f.run(["sync", site]), 0);
    renameSync(drive, `${drive}-off`);
    if (path === "7") f.run(["clean", "--all"]);
    else expect(inProcess(f, ["root", "remove", drive], f.dir, [false]).err).toBe("");
    renameSync(`${drive}-off`, drive);
    if (path === "11") expectCode(f.run(["root", "add", drive, "--tree", "Clients"]), 0);
    const o = outcome(f, site);
    expect({ path, ...brief(o) }, o.said).toEqual({ path, pending: false, trusted: true });
  }
}, 120000);

test.skipIf(!known())("переименование папки проекта — та же папка: без вопроса", () => {
  const f = cliFixture();
  const p = `${f.ws}/Org/p1`, q = `${f.ws}/Org/p9`;
  expectCode(f.run(["sync", "--all", "--yes"]), 0);
  allow(p);
  expectCode(f.run(["sync", p]), 0);
  renameSync(p, q);
  const o = outcome(f, q);
  expect(brief(o), o.said).toEqual({ pending: false, trusted: true });
}, 120000);

test.skipIf(!known())("корень за ссылкой (junction/symlink): та же папка — без вопроса; ссылку перевели на чужую копию — вопрос", () => {
  const f = cliFixture();
  const real = `${f.dir}/real`, other = `${f.dir}/other`, link = `${f.dir}/link`;
  git(`${real}/Acme/site`);
  symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: link, tree: "Clients" }])}agents: [claude]\n`);
  const site = `${link}/Acme/site`;
  expectCode(f.run(["sync", "--all", "--yes"]), 0);
  allow(site);
  expectCode(f.run(["sync", site]), 0);
  // Ключ доверия Claude — по настоящему пути папки
  const via = (o: ReturnType<typeof outcome>, dir: string) => ({ pending: o.pending, trusted: trusted(f.home, dir) });
  const o1 = outcome(f, site);
  expect(via(o1, `${real}/Acme/site`), o1.said).toEqual({ pending: false, trusted: true });
  replaceWithCopy(`${other}/Acme/site`);
  rmSync(link, { recursive: false, force: true });
  symlinkSync(other, link, process.platform === "win32" ? "junction" : "dir");
  const o = outcome(f, site);
  expect({ ...via(o, `${other}/Acme/site`), before: trusted(f.home, `${real}/Acme/site`) }, o.said).toEqual({ pending: true, trusted: false, before: true });
}, 120000);

test("учёт прежней версии (без отпечатка): как раньше; первый sync записывает отпечаток", () => {
  const f = cliFixture();
  const p = `${f.ws}/Org/p1`;
  expectCode(f.run(["sync", "--all", "--yes"]), 0);
  allow(p);
  expectCode(f.run(["sync", p]), 0);
  const path = `${f.config}/local/state/manifest.json`;
  const strip = () => {
    const m = JSON.parse(read(path));
    for (const st of Object.values(m.targets) as { folder?: string }[]) delete st.folder;
    put(path, JSON.stringify(m, null, 2));
  };
  strip();
  // Нет отпечатка — подмены не видно: как в 0.3.4
  replaceWithCopy(p);
  expect(brief(outcome(f, p))).toEqual({ pending: false, trusted: true });
  // Первый sync новой версии записал отпечаток (ФС его отдаёт)
  const st = Object.entries(ledger(f.config).targets).find(([k]) => k.startsWith("claude|") && k.toLowerCase().endsWith("/org/p1"))![1] as { folder?: string };
  expect(st.folder).toBe(folderId(p));
}, 120000);

test.skipIf(!known())("doctor: доверие к папке вне workspace и недоступного корня — названо с командой; после clean — нет", () => {
  const f = cliFixture();
  const drive = `${f.dir}/drive`, site = `${drive}/Acme/site`;
  git(site);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive, tree: "Clients" }])}agents: [claude]\n`);
  expectCode(f.run(["sync", "--all", "--yes"]), 0);
  const note = /В том числе доверие Claude к папке [^\n]*Acme\/site: агент без вопроса выполняет её настройки \(хуки, серверы MCP проекта\), а miksy ею больше не управляет — снять: miksy clean "<путь>" \(работает и без диска\)/;
  // Недоступный корень
  renameSync(drive, `${drive}-off`);
  const away = f.run(["doctor"]);
  expect(away.out, said(away)).toMatch(new RegExp(`Учёт целей недоступного корня[^\\n]*${note.source}`));
  renameSync(`${drive}-off`, drive);
  // Корень убран без согласия убрать записанное (путь 9) — цель вне workspace
  expect(inProcess(f, ["root", "remove", drive], f.dir, [false]).err).toBe("");
  const out = f.run(["doctor"]);
  expect(out.out, said(out)).toMatch(new RegExp(`Цели учёта вне workspace[^\\n]*${note.source}:\\n  `));
  expectCode(f.run(["clean", site]), 0);
  const clean = f.run(["doctor"]);
  expect(clean.out, said(clean)).not.toMatch(note);
  expect(trusted(f.home, site)).toBe(false);
}, 120000);

const TAG = "v0.3.4";
test.skipIf(!hasTag(TAG))("откат на 0.3.4: учёт и решения с отпечатками папок читаются, рецепт отката без ошибок", () => {
  const f = cliFixture({ projects: ["Org/p1", "Org/p2"] });
  const old = oldRunner(oldEngine(TAG), f);
  const p1 = `${f.ws}/Org/p1`, p2 = `${f.ws}/Org/p2`;
  expectCode(f.run(["sync", "--all", "--yes"]), 0);
  allow(p1);
  commit(p2, { ".mcp.json": JSON.stringify({ mcpServers: { team: { command: "team-server" } } }) });
  expectCode(f.run(["trust", p2, "--confirm"]), 0);
  expectCode(f.run(["sync", "--all", "--yes"]), 0);
  expectCode(f.run(["clean", p1]), 0);
  const steps = [old(["doctor"]), old(["setup", "--yes"]), old(["sync", "--global"]), old(["sync", "--all", "--yes"]), old(["doctor"])];
  for (const s of steps) {
    expect(s.err, said(s)).toBe("");
    expect(s.out).not.toMatch(/учёт повреждён|не разбирается|КОНФЛИКТ/);
  }
  // 0.3.4 отпечатки отбросила (поля ей незнакомы); эта версия снова читает всё
  expect(read(`${f.config}/local/state/manifest.json`)).not.toContain('"folder"');
  const back = f.run(["doctor"]);
  expect({ err: back.err, broken: /учёт повреждён|не разбирается/.test(back.out) }).toEqual({ err: "", broken: false });
}, 300000);
