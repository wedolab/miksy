// Круг 10m: запуски git разбора командных skills — через gitSpawn: потерянный ответ (код 128, пустой stderr; Bun < 1.4.3)
// — один повтор, результат как без сбоя. Три запроса: ls-files -s (файлы агентных каталогов без кеша команды), ls-tree
// (дерево коммита), ls-files --eol (выгрузка с CRLF)
import { expect, test } from "bun:test";
import { cliFixture, put } from "./helpers";
import { setGitSpawnForTest } from "../src/git";
import { committedSkill, scanTeamSkills } from "../src/teamskills";
import { commit } from "./fixes021b-helpers";

const lost = { exitCode: 128, stdout: Buffer.from(""), stderr: Buffer.from("") };
const real = (argv: string[], opts: { env: Record<string, string | undefined>; stdin?: Buffer }) =>
  Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", env: opts.env, ...(opts.stdin && { stdin: opts.stdin }) });
// Подкоманда запуска git: первые аргументы после флагов (-C <каталог>, --literal-pathspecs)
const kind = (argv: string[]) => {
  const a = argv.slice(1);
  let i = 0;
  while (i < a.length && a[i].startsWith("-")) i += a[i] === "-C" ? 2 : 1;
  return a[i] === "ls-files" ? `ls-files ${a.includes("--eol") ? "--eol" : "-s"}` : a[i];
};

test("ls-files -s, ls-tree и ls-files --eol: первый ответ потерян — повтор, результат тот же", () => {
  const f = cliFixture();
  const p = `${f.ws}/Org/p1`;
  put(`${p}/.gitattributes`, "*.md text eol=crlf\n");
  commit(p, {
    ".claude/skills/hello/SKILL.md": "---\nname: hello\ndescription: d\n---\nстрока\n",
    ".claude/skills/hello/ref.md": "x\n",
  });
  const ask = () => {
    const warnings: string[] = [];
    return JSON.stringify({ scan: scanTeamSkills(p), files: committedSkill(p, ".claude/skills/hello", (w) => warnings.push(w)), warnings });
  };
  const plain = ask();
  expect(plain).toContain("hello");
  const calls = new Map<string, number>();
  const failed = new Set<string>();
  setGitSpawnForTest((argv, opts) => {
    const k = kind(argv);
    calls.set(k, (calls.get(k) ?? 0) + 1);
    if (["ls-files -s", "ls-tree", "ls-files --eol"].includes(k) && !failed.has(k)) {
      failed.add(k);
      return lost;
    }
    return real(argv, opts);
  });
  let again: string;
  try { again = ask(); } finally { setGitSpawnForTest(null); }
  expect(again).toBe(plain);
  // Каждый из трёх — потерян один раз и повторён
  expect(Object.fromEntries(["ls-files -s", "ls-tree", "ls-files --eol"].map((k) => [k, calls.get(k)]))).toEqual({ "ls-files -s": 2, "ls-tree": 2, "ls-files --eol": 2 });
}, 60000);
