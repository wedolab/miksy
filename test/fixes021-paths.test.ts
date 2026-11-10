// Выпуск 0.2.1, часть A (out/phase-021.md), пути: A4 — «~» в путях команд (PowerShell 5.1 передаёт его как есть);
// A5 — привязки map.yaml без учёта регистра, пример README задевает и саму папку; A10 — /media/<пользователь> (Ubuntu) —
// «нет диска». Тесты рецензентов: out/reviewer-tests/check6x-miksy2/test/zz-review-rootcmd.test.ts (тест 2),
// zz-review-case.test.ts
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ENGINE, mountParent } from "../src/load";
import { selectProject } from "../src/resolve";
import type { MiksyMap } from "../src/types";
import { cliFixture, put } from "./helpers";
import { git, inProcess, read, yamlRoots } from "./rootshelp";

describe("A4 — «~» в путях команд", () => {
  test("root add ~/… и root remove ~/… (zz-review-rootcmd, тест 2)", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    mkdirSync(`${f.home}/Cloud/Acme`, { recursive: true });
    const a = inProcess(f, ["root", "add", "~/Cloud", "--tree", "Cloud"], f.dir);
    expect({ code: a.code, err: a.err }).toEqual({ code: 0, err: "" });
    expect(read(`${f.config}/local/machine.yaml`)).toContain(`${f.home}/Cloud`);
    put(`${f.config}/local/machine.yaml`, `workspace:\n  - "${f.ws}"\n  - { path: "~/Cloud", tree: Cloud }\nagents: [claude]\n`);
    const r = inProcess(f, ["root", "remove", "~/Cloud"], f.dir);
    expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
    expect(read(`${f.config}/local/machine.yaml`)).not.toContain("Cloud");
    // «~\…» — так же
    const b = inProcess(f, ["root", "add", "~\\Cloud", "--tree", "Cloud", "--dry-run"], f.dir);
    expect({ code: b.code, err: b.err }).toEqual({ code: 0, err: "" });
  }, 120000);

  test("sync, explain, clean, target, trust — путь с «~»", () => {
    const f = cliFixture({ agents: ["claude"], projects: [] });
    const work = `${f.home}/work`, p2 = `${work}/Org/p2`;
    git(p2);
    mkdirSync(`${work}/Notes`, { recursive: true });
    put(`${f.config}/local/machine.yaml`, `workspace: ${work}\nagents: [claude]\n`);
    const s = f.run(["sync", "~/work/Org/p2"]);
    expect({ code: s.code, err: s.err }).toEqual({ code: 0, err: "" });
    expect(existsSync(`${p2}/CLAUDE.local.md`)).toBe(true);
    const e = f.run(["explain", "~/work/Org/p2"]);
    expect({ code: e.code, project: e.out.includes(p2) }).toEqual({ code: 0, project: true });
    expect(f.run(["trust", "~/work/Org/p2", "--confirm"]).code).toBe(0);
    const c = f.run(["clean", "~\\work\\Org\\p2"]);
    expect({ code: c.code, err: c.err, left: existsSync(`${p2}/CLAUDE.local.md`) }).toEqual({ code: 0, err: "", left: false });
    const t = f.run(["target", "~/work/Notes"]);
    expect({ code: t.code, err: t.err }).toEqual({ code: 0, err: "" });
    expect(read(`${f.config}/layers/tree/Notes/layer.yaml`)).toContain("target: true");
    const rm = f.run(["target", "~/work/Notes", "--remove"]);
    expect({ code: rm.code, err: rm.err }).toEqual({ code: 0, err: "" });
  }, 120000);
});

describe("A5 — регистр ветки и привязки map.yaml", () => {
  test("tree: clients (на другой машине — Clients): слои дерева и привязка map.yaml применяются (zz-review-case)", () => {
    const f = cliFixture({ agents: ["claude"], projects: ["Org/p1"] });
    const drive = `${f.dir}/drive`;
    git(`${drive}/Acme/site`);
    put(`${f.config}/map.yaml`, "global:\n  - { use: global }\nlayers:\n  - { match: \"{Clients,Archive}/Acme/**\", use: acme }\n");
    put(`${f.config}/layers/acme/instructions/50-shared.md`, "# rule shared\n");
    put(`${f.config}/layers/tree/Clients/instructions/10.md`, "# rule clients\n");
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([f.ws, { path: drive, tree: "clients" }])}agents: [claude]\n`);
    const e = f.run(["explain", `${drive}/Acme/site`]);
    expect({ tree: e.out.includes("10.md"), map: e.out.includes("50-shared.md") }).toEqual({ tree: true, map: true });
  }, 60000);

  test("привязка без учёта регистра — одинаково на всех ОС", () => {
    const map = { global: [], layers: [{ match: "*/Infra-*", use: "infra" }] } as unknown as MiksyMap;
    expect(selectProject(map, "org/infra-x", "linux")).toEqual(["infra"]);
    expect(selectProject(map, "Org/INFRA-x", "windows")).toEqual(["infra"]);
  });

  test("пример README (общий слой для Acme в двух корнях) задевает и саму папку Acme, и всё внутри — по одному разу", () => {
    const readme = readFileSync(join(ENGINE, "README.md"), "utf8");
    const block = /# map\.yaml — слой layers\/acme\/[^\n]*\n([\s\S]*?)```/.exec(readme);
    expect(block).not.toBeNull();
    const matches = [...block![1].matchAll(/match: "([^"]+)", use: acme/g)].map((m) => m[1]);
    expect(matches.length).toBeGreaterThan(0);
    const map = { global: [], layers: matches.map((match) => ({ match, use: "acme" })) } as unknown as MiksyMap;
    for (const rel of ["Clients/Acme", "Archive/Acme", "Clients/Acme/site", "Archive/Acme/app/x", "clients/acme/site"])
      expect([rel, selectProject(map, rel, "windows")]).toEqual([rel, ["acme"]]);
    for (const rel of ["Clients/Acme2", "Clients/AcmeX/site", "Other/Acme"])
      expect([rel, selectProject(map, rel, "linux")]).toEqual([rel, []]);
  });
});

describe("A10 — точки монтирования: /media/<пользователь> (Ubuntu) — диск не подключён", () => {
  test("mountParent", () => {
    for (const d of ["/", "/Volumes", "/mnt", "/media", "/media/vladimir", "/run/media", "/run/media/vladimir"]) expect([d, mountParent(d)]).toEqual([d, true]);
    for (const d of ["/home/vladimir", "/media/vladimir/Disk", "/mnt/x/y", "/run/media/vladimir/Disk", "/srv"]) expect([d, mountParent(d)]).toEqual([d, false]);
  });
});
