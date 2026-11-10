// Выпуск 0.2.1, круг 7c — рецензия A, п. 2 (из out/review021e/miksy/test/zzrev021e-print.test.ts)
// Рецensия A круга 7c: A1″ — отпечаток при sync без изменений, когда в учёте доверие есть, а everTrusted нет
// (учёт 0.1.x: поля everTrusted ещё не было)
import { expect, test } from "bun:test";
import { renameSync } from "node:fs";
import { cliFixture, put } from "./helpers";
import { git, ledger, yamlRoots } from "./rootshelp";
import { allow, trusted } from "./fixes021b-helpers";

const pending = (out: string) => out.includes("Нужно решение пользователя о доверии");

test("учёт без everTrusted (0.1.x) → sync новой версией без изменений → clean недоступной → диск вернулся, ответы те же → вопроса нет?", () => {
  const f = cliFixture({ projects: ["Org/p1"] });
  const drive = `${f.dir}/drive`, site = `${drive}/Acme/site`;
  git(site);
  put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive, tree: "Clients" }])}agents: [claude]\n`);
  expect(f.run(["sync", "--all", "--yes"]).err).toBe("");
  allow(site);
  expect(pending(f.run(["sync", site]).out)).toBe(false);
  const m = ledger(f.config) as any;
  for (const st of Object.values(m.targets) as any[]) { delete st.everTrusted; delete st.dialog; }
  put(`${f.config}/local/state/manifest.json`, JSON.stringify(m, null, 2) + "\n");
  const s1 = f.run(["sync", site]);
  const st = Object.entries(ledger(f.config).targets).find(([k]) => k.toLowerCase().startsWith("claude|") && k.toLowerCase().endsWith("/acme/site"))![1] as any;
  console.log("AFTER-SYNC " + s1.out.split("\n")[0] + " dialog=" + !!st.dialog + " everTrusted=" + !!st.everTrusted + " trust=" + Object.keys(st.trust ?? {}).length);
  renameSync(drive, `${drive}-off`);
  f.run(["clean", site]);
  renameSync(`${drive}-off`, drive);
  const s = f.run(["sync", site]);
  expect({ asked: pending(s.out), trusted: trusted(f.home, site) }).toEqual({ asked: false, trusted: true });
}, 120000);
