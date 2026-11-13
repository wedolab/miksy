// Выпуск 0.2.2, круг 8e, F2 (проверка 8d, находка 2; рецензия 8e, №1): подсказка clean забытого проекта вне workspace,
// когда основной сменил setup --force. Дословно (корень с новой веткой; слои его проектов — копией под неё: без ветки —
// layers/tree/<папка>, с веткой — всё содержимое layers/tree/<прежняя>; привязки map.yaml — дописаны; «нет» на вопросы
// root add и root remove; строки sync и clean; затем копия убрана) — в проекте не остаётся ничего от miksy (skills,
// серверы), слои одноимённой папки нового основного не тронуты. Мастер — в процессе, поддельная система, движок — копия
import { expect, test } from "bun:test";
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { cliFixture, put } from "./helpers";
import { git, read, yamlRoots } from "./rootshelp";
import { inCmd, inSetup } from "./fixes022e-helpers";

type F = ReturnType<typeof cliFixture>;
const layers = (f: F, p: string) => f.run(["explain", p]).out.match(/^Слои\s+(.*)$/m)?.[1] ?? "";
const files = (d: string, base = d): string[] => existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => e.name === ".git" ? [] : e.isDirectory() ? files(`${d}/${e.name}`, base) : [`${d}/${e.name}`.slice(base.length + 1)]) : [];
const skill = (n: string) => `---\nname: ${n}\ndescription: s\n---\nx\n`;

for (const o of [{ name: "без ветки" }, { name: "с веткой W", mainTree: "W" }, { name: "без ветки, skill через привязку map.yaml", viaMap: true }] as { name: string; mainTree?: string; viaMap?: boolean }[])
  test(`F2: подсказка clean забытого проекта вне workspace — дословно убирает всё (прежний основной ${o.name})`, () => {
    const f = cliFixture({ agents: ["claude", "codex"], projects: [] });
    const ws = `${f.dir}/ws`, work = `${f.dir}/work`;
    git(`${ws}/Org/p1`); git(`${work}/Org/p2`);
    put(`${f.config}/local/machine.yaml`, `${yamlRoots([o.mainTree ? { path: ws, tree: o.mainTree } : ws])}agents: [claude, codex]\n`);
    const t = o.mainTree ? `${o.mainTree}/` : "";
    put(`${f.config}/layers/tree/${t}Org/instructions/10.md`, "# org rule\n");
    put(`${f.config}/layers/tree/${t}Org/skills/orgskill/SKILL.md`, skill("orgskill"));
    put(`${f.config}/layers/tree/${t}Org/mcp/orgsrv.yaml`, "name: orgsrv\ncommand: echo\nargs: [\"x\"]\n");
    if (o.mainTree) put(`${f.config}/layers/tree/${o.mainTree}/skills/wskill/SKILL.md`, skill("wskill"));
    if (o.viaMap) {
      put(`${f.config}/map.yaml`, "global:\n  - { use: global }\nlayers:\n  - { match: \"Org/**\", use: orgx }\n");
      put(`${f.config}/layers/orgx/skills/mapskill/SKILL.md`, skill("mapskill"));
    }
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    renameSync(ws, `${ws}.off`);
    inSetup(f, [[/Корень workspace/, [work]], [/Есть ещё папки/, [null]], [/Записать настройки агентам/, [false]]]);
    expect(f.run(["sync", "--all", "--yes"]).code).toBe(0);
    const p2Before = layers(f, `${work}/Org/p2`);
    expect(f.run(["clean", `${ws}/Org/p1`, "--forget"]).code).toBe(0);
    renameSync(`${ws}.off`, ws);
    const c = f.run(["clean", `${ws}/Org/p1`]);
    expect(c.out).toContain("Слои его проектов под неё скопируйте, а не переносите: ветки у него не было — layers/tree/<папка> → layers/tree/<ветка>/<папка>; была");
    // Дословно: копия слоёв под новую ветку Old, привязки — дописать; root add («нет»), строки sync; root remove («нет»)
    const B = "Old";
    if (o.mainTree) cpSync(`${f.config}/layers/tree/${o.mainTree}`, `${f.config}/layers/tree/${B}`, { recursive: true });
    else cpSync(`${f.config}/layers/tree/Org`, `${f.config}/layers/tree/${B}/Org`, { recursive: true });
    const map0 = read(`${f.config}/map.yaml`);
    if (o.viaMap) writeFileSync(`${f.config}/map.yaml`, `${map0.trimEnd()}\n  - { match: "${B}/Org/**", use: orgx }\n`);
    expect(inCmd(f, ["root", "add", ws, "--tree", B], [false]).code).toBe(0);
    for (const l of c.out.split("\n").filter((x) => /^\s+miksy sync /.test(x))) for (const part of l.trim().split("; "))
      f.run([...part.matchAll(/"([^"]+)"|(\S+)/g)].map((m) => m[1] ?? m[2]).slice(1));
    expect(inCmd(f, ["root", "remove", ws], [false]).code).toBe(0);
    rmSync(`${f.config}/layers/tree/${B}`, { recursive: true, force: true });
    if (o.viaMap) writeFileSync(`${f.config}/map.yaml`, map0);
    const left = files(`${ws}/Org/p1`).filter((p) => !/^\.git/.test(p));
    const cj = JSON.parse(readFileSync(`${f.home}/.claude.json`, "utf8") || "{}");
    const proj = Object.entries(cj.projects ?? {}).find(([k]) => k.toLowerCase().endsWith("/ws/org/p1"))?.[1] as { mcpServers?: Record<string, unknown> } | undefined;
    f.run(["sync", "--all"]);
    expect({ left, servers: Object.keys(proj?.mcpServers ?? {}), p2: layers(f, `${work}/Org/p2`) === p2Before })
      .toEqual({ left: [], servers: [], p2: true });
  }, 300000);
