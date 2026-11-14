// Выпуск версии miksy (для владельца): bun run release [--dry-run] [--yes] [--push]. Порядок — RELEASING.md.
// Работает в git-репо текущего каталога (bun run — корень движка). По записи «Не выпущено» в CHANGELOG.md
// сам определяет номер (SemVer, DESIGN §12), показывает номер и текст, после «да»: version в package.json,
// «Не выпущено» → «X.Y.Z — дата» (новой пустой нет), коммит «Release X.Y.Z», тег vX.Y.Z, ветка
// stable — на него. Пуш и GitHub Release — отдельным «да» или --push. --dry-run — только показать
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareVersions, type Entry, entryText, isEmpty, nextVersion, parseChangelog, releaseText, SEMVER, UNRELEASED } from "../src/changelog";

const STABLE = "stable", MAIN = "main", REMOTE = "origin";
const args = process.argv.slice(2);
const KNOWN = ["--dry-run", "--yes", "--push"];
for (const a of args) if (!KNOWN.includes(a)) fail(`неизвестный аргумент «${a}»; допустимы: ${KNOWN.join(", ")}`, 2);
const dryRun = args.includes("--dry-run"), yes = args.includes("--yes"), push = args.includes("--push");
const tty = !!process.stdin.isTTY;

function fail(msg: string, code = 1): never {
  console.error(`Ошибка: ${msg}`);
  process.exit(code);
}

const git = (...a: string[]) => {
  const r = Bun.spawnSync(["git", ...a], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
};
const must = (...a: string[]) => {
  const r = git(...a);
  if (r.code !== 0) fail(`git ${a.join(" ")}: ${r.err.split("\n").pop() || `код ${r.code}`}`);
  return r.out;
};
const ask = (q: string) => /^(y|yes|д|да)$/i.test((prompt(`${q} [y/N]`) ?? "").trim());

// Репо движка: корень git, package.json miksy, CHANGELOG.md
const root = git("rev-parse", "--show-toplevel");
if (root.code !== 0) fail("запустите в каталоге движка miksy (git-репо): bun run release");
const dir = root.out;
const pkgPath = join(dir, "package.json"), logPath = join(dir, "CHANGELOG.md");
if (!existsSync(pkgPath) || !existsSync(logPath)) fail(`${dir}: нет package.json или CHANGELOG.md — это не движок miksy`);
const pkgText = readFileSync(pkgPath, "utf8");
const pkg = JSON.parse(pkgText) as { name?: string; version?: string };
if (pkg.name !== "miksy") fail(`${dir}: package.json не miksy`);
const current = pkg.version ?? "";
if (!SEMVER.test(current)) fail(`version в package.json — «${current}», ожидается X.Y.Z`);

const branch = git("symbolic-ref", "--short", "-q", "HEAD").out;
if (branch !== MAIN && branch !== STABLE) fail(`выпуск — с ветки ${MAIN} (или ${STABLE} для срочного исправления), а сейчас ${branch || "не ветка (detached HEAD)"}`);
const dirty = git("status", "--porcelain", "--untracked-files=no").out;
if (dirty && !dryRun) fail(`есть незакоммиченные изменения — закоммитьте или уберите их до выпуска:\n${dirty}`);

const logText = readFileSync(logPath, "utf8");
let parsed;
try { parsed = parseChangelog(logText); } catch (e) { fail((e as Error).message); }
// «Не выпущено» нет — то же, что пустая: выпускать нечего (кроме первого выпуска)
const unreleased: Entry = parsed.entries.find((e) => e.version === null) ?? { version: null, sections: {}, loose: [] };
const tagExists = (v: string) => git("rev-parse", "--verify", "-q", `refs/tags/v${v}`).code === 0;
const now = new Date();
const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

// Первый выпуск: версия из package.json ещё без тега, её запись в CHANGELOG уже есть, «Не выпущено» нет или пуста —
// выпускается она (дата — сегодняшняя)
const own = parsed.entries.find((e) => e.version === current);
const first = !tagExists(current) && !!own && isEmpty(unreleased);
const version = first ? current : nextVersion(current, unreleased);
if (!version) fail(`выпускать нечего: в CHANGELOG.md нет записи «${UNRELEASED}» или она пуста`);
if (!first && compareVersions(version, current) <= 0) fail(`новая версия ${version} не новее ${current}`);
if (!first && tagExists(version)) fail(`тег v${version} уже есть`);
if (!first && parsed.entries.some((e) => e.version === version)) fail(`в CHANGELOG.md уже есть запись ${version}`);

// stable двигается только вперёд: у пользователей update — fast-forward
const stableSha = git("rev-parse", "--verify", "-q", `refs/heads/${STABLE}`).out;
if (stableSha && branch === MAIN && git("merge-base", "--is-ancestor", stableSha, "HEAD").code !== 0)
  fail(`ветка ${STABLE} не входит в историю ${MAIN} (было срочное исправление?) — сначала слейте её: git merge ${STABLE}`);

const entry = first ? { ...own!, date: today } : { ...unreleased, version, date: today };
console.log(`Выпуск miksy ${version}${first ? " (первый: версия из package.json, запись в CHANGELOG уже есть)" : ` (сейчас ${current})`}; ветка ${branch}\n`);
console.log(entryText(entry));
console.log(`\nБудет: ${first ? "" : `version ${version} в package.json, `}запись CHANGELOG «${version} — ${today}», коммит «Release ${version}», тег v${version}, ветка ${STABLE} → v${version}.`);
if (dryRun) {
  console.log(`\n--dry-run: ничего не изменено.${dirty ? " (Есть незакоммиченные изменения — без --dry-run выпуск откажет.)" : ""}`);
  process.exit(0);
}
if (!yes && !(tty && ask("\nВыпустить?"))) {
  console.log(tty ? "Отменено, ничего не изменено." : "Без терминала — только с --yes. Ничего не изменено.");
  process.exit(1);
}

// Запись: package.json (строка version, остальное как было), CHANGELOG, коммит, тег, stable
if (!first) writeFileSync(pkgPath, pkgText.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`));
const nextLog = first
  ? logText.replace(new RegExp(`^## ${current.replaceAll(".", "\\.")}(?: — \\d{4}-\\d{2}-\\d{2})?[ \\t]*$`, "m"), `## ${current} — ${today}`)
  : releaseText(logText, version, today);
writeFileSync(logPath, nextLog);
must("add", "--", "package.json", "CHANGELOG.md");
if (git("diff", "--cached", "--quiet").code !== 0) must("commit", "-q", "-m", `Release ${version}`);
// Аннотация тега — текст записи CHANGELOG (как есть: «### …» не комментарии): из неё GitHub Release
// (gh release create --notes-from-tag)
const notes = entryText(entry, { title: false });
must("tag", "-a", "--cleanup=verbatim", `v${version}`, "-m", notes);
if (branch === MAIN) must("branch", "-f", STABLE, `v${version}^{commit}`);
console.log(`\n✓ ${version}: коммит ${must("rev-parse", "--short", "HEAD")}, тег v${version}, ветка ${STABLE} → v${version}`);

// Пуш и GitHub Release — отдельное решение
const refs = branch === MAIN ? [MAIN, STABLE, `v${version}`] : [STABLE, `v${version}`];
const pushCmd = `git push --atomic ${REMOTE} ${refs.join(" ")}`;
const ghCmd = `gh release create v${version} --title "miksy ${version}" --notes-from-tag`;
const after = branch === STABLE ? `\nСрочное исправление выпущено с ${STABLE}: перенесите его в ${MAIN} — git checkout ${MAIN}; git merge ${STABLE} (конфликт в CHANGELOG.md: строка остаётся только в записи ${version}).` : "";
if (!push && !(tty && ask(`\nОтправить в ${REMOTE} (${refs.join(", ")}) и создать GitHub Release?`))) {
  console.log(`\nНе отправлено. Когда будете готовы:\n  ${pushCmd}\n  ${ghCmd}${after}`);
  process.exit(0);
}
must("push", "--atomic", REMOTE, ...refs);
console.log(`✓ отправлено: ${refs.join(", ")}`);
if (!Bun.which("gh")) {
  console.log(`gh не найден — создайте GitHub Release вручную: ${ghCmd}${after}`);
  process.exit(0);
}
const gh = Bun.spawnSync(["gh", "release", "create", `v${version}`, "--title", `miksy ${version}`, "--notes-from-tag"], { stdout: "inherit", stderr: "inherit" });
if (gh.exitCode !== 0) console.log(`GitHub Release не создан (код ${gh.exitCode}) — повторите: ${ghCmd}`);
else console.log(`✓ GitHub Release v${version}`);
if (after) console.log(after.trimStart());
