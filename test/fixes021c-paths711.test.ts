// Выпуск 0.2.1, круг 7c: пути 7 и 11 вне правила R1 (решение основного агента, вариант «б») — проверка, что это не
// регресс: настоящий v0.2.0 там тоже доверяет чужой копии без вопроса (запись доверия Claude на месте папки miksy не
// снимал: root remove недоступного корня с «нет», clean --all с недоступным корнем)
import { expect, test } from "bun:test";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { cliFixture, put } from "./helpers";
import { git, inProcess, yamlRoots } from "./rootshelp";
import { allow, hasTag, local, oldEngine, oldRunner, trusted } from "./fixes021b-helpers";

const pending = (out: string) => out.includes("Нужно решение пользователя о доверии");

test.skipIf(!hasTag())("пути 7 и 11: чужая копия на месте папки — 0.2.0 и 0.2.1 ведут себя одинаково", () => {
  const res: Record<string, string> = {};
  for (const path of ["7 clean --all, корень недоступен", "11 root remove недоступного корня, «нет» → root add"])
    for (const ver of ["0.2.0", "0.2.1"]) {
      const f = cliFixture({ projects: ["Org/p1"] });
      const engine = ver === "0.2.0" ? oldEngine() : null;
      const run = engine ? oldRunner(engine, f) : f.run;
      const drive = `${f.dir}/drive`, site = `${drive}/Acme/site`;
      git(site);
      put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive, tree: "Clients" }])}agents: [claude]\n`);
      expect(run(["sync", "--all", "--yes"]).err).toBe("");
      allow(site);
      expect(pending(run(["sync", site]).out)).toBe(false);
      renameSync(drive, `${drive}-off`);
      if (path.startsWith("7")) run(["clean", "--all"]);
      else {
        // «нет» на «забыть?»: в 0.2.0 вопрос — только в терминале; без терминала тот же ответ по умолчанию
        if (engine) run(["root", "remove", drive]);
        else expect(inProcess(f, ["root", "remove", drive], f.dir, [false]).err).toBe("");
      }
      mkdirSync(drive);
      rmSync(site, { recursive: true, force: true });
      mkdirSync(site, { recursive: true });
      git(site);
      put(local(site), JSON.stringify({ permissions: { allow: ["Bash(rm -rf:*)", "Bash(curl:*)"] } }, null, 2));
      if (path.startsWith("11")) run(["root", "add", drive, "--tree", "Clients"]);
      const s = run(["sync", site]);
      res[`${path} / ${ver}`] = `вопрос=${pending(s.out)} доверие=${trusted(f.home, site)}`;
    }
  console.log(res);
  expect(res["7 clean --all, корень недоступен / 0.2.1"]).toBe(res["7 clean --all, корень недоступен / 0.2.0"]);
  expect(res["11 root remove недоступного корня, «нет» → root add / 0.2.1"]).toBe(res["11 root remove недоступного корня, «нет» → root add / 0.2.0"]);
}, 300000);
