// Общая заготовка тестов нескольких корней workspace (test/roots*.test.ts)
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import type { Ask } from "../src/ask";
import { runCommand } from "../src/commands";
import { cliFixture, put } from "./helpers";

export const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
export const git = (dir: string) => { mkdirSync(dir, { recursive: true }); Bun.spawnSync(["git", "init", "-q", dir]); };
export const yamlRoots = (items: (string | { path: string; tree?: string })[]) =>
  `workspace:\n${items.map((r) => (typeof r === "string" ? `  - "${r}"` : `  - { path: "${r.path}"${r.tree ? `, tree: "${r.tree}"` : ""} }`)).join("\n")}\n`;

// Основной корень ws (корень дерева) с проектом Org/p1 и группой Grp; drive — Clients, archive — Archive
// (общее с Clients для Acme — явно, слоем map.yaml), books — Books; ws/Grp/Inner — вложенный корень Code
// внутри группы Grp
export function rootsFixture(agents = ["claude"]) {
  const f = cliFixture({ agents, projects: ["Org/p1", "Grp/q"] });
  const drive = `${f.dir}/drive`, archive = `${f.dir}/archive`, books = `${f.dir}/books`, inner = `${f.ws}/Grp/Inner`;
  git(`${drive}/Acme/site`);
  git(`${archive}/Acme/app`);
  git(`${books}/novel`);
  git(`${inner}/p`);
  const roots = [f.ws, { path: drive, tree: "Clients" }, { path: archive, tree: "Archive" }, { path: books, tree: "Books" }, { path: inner, tree: "Code" }];
  put(`${f.config}/local/machine.yaml`, `${yamlRoots(roots)}agents: [${agents.join(", ")}]\n`);
  put(`${f.config}/map.yaml`, "global:\n  - { use: global }\nlayers:\n  - { match: \"{Clients,Archive}/Acme/**\", use: acme }\n");
  put(`${f.config}/layers/acme/instructions/50-shared.md`, "# rule shared\n");
  put(`${f.config}/layers/tree/Clients/instructions/10-clients.md`, "# rule clients\n");
  put(`${f.config}/layers/tree/Clients/Acme/instructions/20-acme.md`, "# rule acme\n");
  put(`${f.config}/layers/tree/Code/instructions/30-code.md`, "# rule code\n");
  put(`${f.config}/layers/tree/Grp/instructions/40-grp.md`, "# rule grp\n");
  put(`${f.config}/layers/tree/Grp/layer.yaml`, "target: true\n");
  put(`${f.config}/layers/tree/mcp/ws.yaml`, "name: ws\ncommand: echo\nargs: [\"${WORKSPACE}/x\"]\n");
  const rules = (dir: string) => [...read(`${dir}/CLAUDE.local.md`).matchAll(/^# (?:rule )?(\w+)$/gm)].map((m) => m[1]);
  return { ...f, drive, archive, books, inner, rules };
}

// Команда в этом процессе: answers — ответы на вопросы по порядку («в терминале»), null — без терминала.
// Нужна, когда защита прогона (test/guard.ts) CLI не запустит: корень на отсутствующем диске, ссылка в никуда
export function inProcess(f: { config: string; home: string; dir: string }, args: string[], cwd = f.dir, answers: (boolean | string)[] | null = null) {
  const saved = { ...process.env }, dir = process.cwd(), log = console.log, out: string[] = [];
  Object.assign(process.env, { MIKSY_CONFIG: f.config, HOME: f.home, USERPROFILE: f.home });
  process.chdir(cwd);
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  const questions: string[] = [];
  const next = (q: string) => { questions.push(q); if (!answers!.length) throw new Error(`лишний вопрос: ${q}`); return answers!.shift()!; };
  const io: Ask | null = answers ? { yes: (q) => next(q) as boolean, choose: () => null, line: (q) => (next(q) as string) || null } : null;
  try { return { code: runCommand(args[0], args.slice(1), { ask: io }), out: out.join("\n"), err: "", questions }; }
  catch (e) { return { code: -1, out: out.join("\n"), err: (e as Error).message, questions }; }
  finally {
    console.log = log;
    process.chdir(dir);
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

// Учёт miksy конфигурации (local/state/manifest.json)
export const ledger = (config: string) => JSON.parse(read(`${config}/local/state/manifest.json`) || "{\"targets\":{}}") as { targets: Record<string, any>; roots?: Record<string, string>; engine?: string };
