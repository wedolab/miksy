// Выпуск 0.2.2, круг 8d, A №7 = B №7: README «Как удалить», команда «macOS, Linux: копии, полный путь» дословно (bash и
// zsh, если есть): копии нет — не печатает ничего, код 0; копия есть — её полный путь без кавычек; и когда local/backups —
// ссылка на папку на другом томе (рецензия B круга 8d, №2)
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const README = readFileSync(join(import.meta.dir, "..", "README.md"), "utf8");
const line = README.split("\n").find((l) => l.includes("# macOS, Linux: копии, полный путь"))!.replace(/\s+#.*$/, "").trim();

for (const shell of ["bash", "zsh"])
  for (const linked of [false, true])
    test.skipIf(process.platform === "win32" || !Bun.which(shell))(`README: копии «до miksy» — ${shell}${linked ? ", local/backups — ссылка" : ""}`, () => {
      const home = realpathSync(mkdtempSync(join(tmpdir(), "rf-")));
      const backups = linked ? `${home}/vault` : `${home}/Projects/miksy-config/local/backups`;
      mkdirSync(`${backups}/2026-01-01T00-00-00-000Z`, { recursive: true });
      if (linked) { mkdirSync(`${home}/Projects/miksy-config/local`, { recursive: true }); symlinkSync(backups, `${home}/Projects/miksy-config/local/backups`); }
      const run = () => { const r = Bun.spawnSync([shell, "-c", line], { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" }); return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }; };
      const none = run();
      mkdirSync(`${backups}/before-miksy-2026-01-01T00-00-00`, { recursive: true });
      const one = run();
      expect({ none, one }).toEqual({ none: { code: 0, out: "" }, one: { code: 0, out: `${home}/Projects/miksy-config/local/backups/before-miksy-2026-01-01T00-00-00\n` } });
    });
