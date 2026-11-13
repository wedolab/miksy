// Выпуск 0.2.2, A2: правило R2 на всех путях (план out/8a-plan.md, таблица A2; ответ основного агента — строки «а», «б»).
// R2: если sync снимает своё одобрение серверов .mcp.json, в том же запуске есть вопрос о них (терминал) или подсказка
// (--dry-run, doctor, и в терминале — когда вопрос бессмыслен: проект не доверенный, запрет trust: false); где одобрение
// не снимается — новых вопросов нет; отказ не переспрашивается
import { expect, test } from "bun:test";
import { cliFixture, put } from "./helpers";
import { inProcess, read } from "./rootshelp";
import { commit, hasTag, oldEngine, oldRunner, userTrusts } from "./fixes021b-helpers";

const MCP = (cmd: string) => ({ ".mcp.json": JSON.stringify({ mcpServers: { team: { command: cmd } } }) });
const HOOK = (cmd: string) => ({ ".claude/settings.json": JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: cmd }] }] } }) });
type F = ReturnType<typeof cliFixture>;
const untrust = (f: F, app: string) => {
  const j = JSON.parse(read(`${f.home}/.claude.json`));
  for (const k of Object.keys(j.projects ?? {})) if (k.toLowerCase() === app.toLowerCase()) j.projects[k].hasTrustDialogAccepted = false;
  put(`${f.home}/.claude.json`, JSON.stringify(j, null, 2));
};
// «Нет» доверию Claude, вы доверились проекту сами, «да» серверам на отдельный вопрос (alone)
const denyAlone = (f: F, app: string) => { f.run(["trust", app, "--deny"]); userTrusts(f.home, app); inProcess(f, ["trust", app], f.dir, ["y"]); f.run(["sync", app]); };

const HINT = /Нужно решение пользователя о доверии|не доверенный в Claude: одобрение серверов|доверие запрещено в слое/;
const CASES: { n: string; prep: (f: F, app: string) => void; change?: (f: F, app: string) => void; removes: boolean; old?: true }[] = [
  { n: "1 «да» Claude, сменился .mcp.json", prep: (f, app) => f.run(["trust", app, "--confirm"]), change: (f, app) => commit(app, MCP("v2")), removes: true },
  { n: "2 «да» Claude, команда добавила хук", prep: (f, app) => f.run(["trust", app, "--confirm"]), change: (f, app) => commit(app, HOOK("x.sh")), removes: true },
  { n: "3 «нет» + alone, сменился .mcp.json", prep: denyAlone, change: (f, app) => commit(app, MCP("v2")), removes: true },
  { n: "4 «нет» + alone, ничего не менялось", prep: denyAlone, removes: false },
  { n: "5 «нет» + alone, команда добавила хук", prep: denyAlone, change: (f, app) => commit(app, HOOK("x.sh")), removes: false },
  { n: "6 решения о Claude нет + alone, сменился .mcp.json", prep: (f, app) => { userTrusts(f.home, app); inProcess(f, ["trust", app], f.dir, ["y"]); f.run(["sync", app]); }, change: (f, app) => commit(app, MCP("v2")), removes: true },
  { n: "7 «нет», сами не доверялись, сменился .mcp.json", prep: (f, app) => f.run(["trust", app, "--deny"]), change: (f, app) => commit(app, MCP("v2")), removes: false },
  { n: "8 «нет» + alone, вы сами сняли доверие в окне Claude, сменился .mcp.json", prep: (f, app) => { denyAlone(f, app); untrust(f, app); }, change: (f, app) => commit(app, MCP("v2")), removes: true },
  { n: "8′ «нет» + alone, вы сами сняли доверие в окне Claude, ничего не менялось", prep: (f, app) => { denyAlone(f, app); untrust(f, app); }, removes: true },
  { n: "10 «нет» серверам, сменился .mcp.json", prep: (f, app) => { userTrusts(f.home, app); inProcess(f, ["trust", app], f.dir, ["n"]); }, change: (f, app) => commit(app, MCP("v2")), removes: false },
  { n: "11 trust: true в слое, сменился .mcp.json", prep: (f) => put(`${f.config}/layers/tree/Org/app/layer.yaml`, "trust: { claude: true }\n"), change: (f, app) => commit(app, MCP("v2")), removes: false },
  { n: "а «нет» + alone, хук команды есть и не менялся, сменился .mcp.json", prep: (f, app) => { commit(app, HOOK("x.sh")); denyAlone(f, app); }, change: (f, app) => commit(app, MCP("v2")), removes: true },
  { n: "б trust: false в слое при своём одобрении серверов", prep: (f, app) => { f.run(["trust", app, "--confirm"]); put(`${f.config}/layers/tree/Org/app/layer.yaml`, "trust: { claude: false }\n"); }, removes: true },
];

function row(f: F, app: string, n: string) {
  const dry = f.run(["sync", app, "--dry-run"]);
  const doc = f.run(["doctor"]);
  const t = inProcess(f, ["sync", app], f.dir, ["n", "n", "n"]);
  const removed = /- team \(снять своё\)/.test(dry.out);
  const hint = { dry: HINT.test(dry.out), doctor: HINT.test(doc.out), terminal: t.questions.length > 0 || HINT.test(t.out) };
  // Подсказка A2 «проект не доверенный в Claude» — только где вопроса нет (строки 8, 8′); при вопросе её нет (рецензия A 0.2.2, п. 1)
  const a2 = [dry.out, doc.out, t.out].some((o) => /не доверенный в Claude: одобрение серверов/.test(o));
  return { n, removed, ...hint, asked: t.questions.length, a2, err: t.err };
}

test("R2: снятие своего одобрения серверов — вопрос или подсказка в том же запуске; без снятия — новых вопросов нет", () => {
  const got: unknown[] = [], want: unknown[] = [];
  for (const c of CASES) {
    const f = cliFixture({ projects: ["Org/app"] });
    const app = `${f.ws}/Org/app`;
    commit(app, MCP("v1"));
    f.run(["sync", "--all", "--yes"]);
    c.prep(f, app);
    c.change?.(f, app);
    const r = row(f, app, c.n);
    got.push(r);
    want.push(c.removes
      ? { n: c.n, removed: true, dry: true, doctor: true, terminal: true, asked: r.asked, a2: c.n.startsWith("8"), err: "" }
      : { n: c.n, removed: false, dry: r.dry, doctor: r.doctor, terminal: false, asked: 0, a2: false, err: "" });
  }
  expect(got).toEqual(want);
}, 900000);

test.skipIf(!hasTag())("R2, 9: пара 0.2.0 «нет» + «да» серверам — снятие и вопрос в том же sync", () => {
  const f = cliFixture({ projects: ["Org/app"] });
  const old = oldRunner(oldEngine(), f);
  const app = `${f.ws}/Org/app`;
  commit(app, MCP("v1"));
  old(["sync", "--all", "--yes"]);
  old(["trust", app, "--confirm"]);
  old(["trust", app, "--deny"]);
  userTrusts(f.home, app);
  old(["sync", app]);
  const r = row(f, app, "9");
  expect(r).toEqual({ n: "9", removed: true, dry: true, doctor: true, terminal: true, asked: r.asked, a2: false, err: "" });
  expect(r.asked).toBeGreaterThan(0);
}, 300000);
