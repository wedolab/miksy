// Круг 11n: miksy secret ИМЯ [--line "…{}…"] [--env ПЕРЕМЕННАЯ] -- <команда> — miksy сам запускает команду и отдаёт ей
// значение в stdin (байт в байт) или в переменную окружения; работает одинаково из PowerShell 5.1, cmd и bash.
// Код возврата — команды; не найдена — 127; необъявленное — команда не запускается. Значения — искусственные
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { cliFixture, expectCode, put } from "./helpers";

const WIN = process.platform === "win32";
const VALUE = ["значение", " \"q\" 'x' ", "Zz9-11n"].join("");
const hex = (s: string) => Buffer.from(s, "utf8").toString("hex");

function fixture() {
  const f = cliFixture({ projects: ["Acme/app"] });
  put(`${f.config}/layers/tree/Acme/layer.yaml`, "skill_secrets: [ACME_PASS]\n");
  put(`${f.config}/local/secrets.env`, `ACME_PASS="${VALUE.replaceAll('"', '\\"')}"\nOTHER=x\n`);
  // Приёмник: печатает stdin (hex), переменную PGPASSWORD (hex) и аргументы; код выхода — из RECV_CODE
  const recv = `${f.dir}/recv.js`;
  put(recv, [
    "const fs = require('fs');",
    "let b = Buffer.alloc(0);",
    "try { b = fs.readFileSync(0); } catch {}",
    "if (process.env.RECV_MARK) fs.writeFileSync(process.env.RECV_MARK, 'ran');",
    "process.stdout.write(JSON.stringify({ stdin: b.toString('hex'), env: Buffer.from(process.env.PGPASSWORD ?? '').toString('hex'), argv: process.argv.slice(2) }));",
    "process.exit(Number(process.env.RECV_CODE ?? 0));",
  ].join("\n") + "\n");
  const cwd = `${f.ws}/Acme/app`;
  const run = (args: string[], env: Record<string, string> = {}) => {
    const r = Bun.spawnSync([process.execPath, `${import.meta.dir}/../src/cli.ts`, ...args], {
      cwd, env: { ...process.env, MIKSY_CONFIG: f.config, HOME: f.home, USERPROFILE: f.home, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  return { ...f, recv, cwd, run };
}

const parse = (out: string) => JSON.parse(out) as { stdin: string; env: string; argv: string[] };
const noValue = (r: { out: string; err: string }) => {
  expect(r.err).not.toContain(VALUE);
  expect(r.out).not.toContain(VALUE);
};

describe("miksy secret ИМЯ -- <команда>", () => {
  test("stdin — значение байт в байт, без перевода строки; --line — по шаблону с LF; --env — в переменную", () => {
    const f = fixture();
    const plain = f.run(["secret", "ACME_PASS", "--", process.execPath, f.recv]);
    expectCode(plain, 0);
    expect(parse(plain.out).stdin).toBe(hex(VALUE));
    expect(plain.err).toBe("");
    const line = f.run(["secret", "ACME_PASS", "--line", "dev:{}", "--", process.execPath, f.recv]);
    expect(parse(line.out).stdin).toBe(hex(`dev:${VALUE}\n`));
    const both = f.run(["secret", "ACME_PASS", "--line", "{}", "--", process.execPath, f.recv]);
    expect(parse(both.out).stdin).toBe(hex(`${VALUE}\n`));
    const env = f.run(["secret", "ACME_PASS", "--env", "PGPASSWORD", "--", process.execPath, f.recv]);
    expect(parse(env.out)).toMatchObject({ stdin: "", env: hex(VALUE) });
  });

  test("код возврата — команды; аргументы с пробелом и кавычками — как есть", () => {
    const f = fixture();
    const r = f.run(["secret", "ACME_PASS", "--", process.execPath, f.recv, "a b", "--flag", "x=y", "c'd"], { RECV_CODE: "7" });
    expect(r.code).toBe(7);
    expect(parse(r.out).argv).toEqual(["a b", "--flag", "x=y", "c'd"]);
  });

  test("необъявленный — команда не запускается; не найдена — 127; ошибки — без значения", () => {
    const f = fixture();
    const mark = `${f.dir}/ran.txt`;
    const other = f.run(["secret", "OTHER", "--", process.execPath, f.recv], { RECV_MARK: mark });
    expectCode(other, 1);
    expect(other.err).toContain("секрет OTHER не объявлен");
    expect(existsSync(mark)).toBe(false);
    const missing = f.run(["secret", "ACME_PASS", "--", "no-such-command-11n"]);
    expect(missing.code).toBe(127);
    expect(missing.err).toContain("команда no-such-command-11n не найдена (PATH) — секрет не передан");
    noValue(missing);
    noValue(other);
  });

  test("ошибки вызова: шаблон без {}, --line и --env вместе, флаги без команды, пустая команда", () => {
    const f = fixture();
    expectCode(f.run(["secret", "ACME_PASS", "--line", "dev:", "--", process.execPath, f.recv]), 2);
    expectCode(f.run(["secret", "ACME_PASS", "--line", "{}{}", "--", process.execPath, f.recv]), 2);
    expectCode(f.run(["secret", "ACME_PASS", "--line", "{}", "--env", "X", "--", process.execPath, f.recv]), 2);
    expectCode(f.run(["secret", "ACME_PASS", "--env", "1X", "--", process.execPath, f.recv]), 2);
    expectCode(f.run(["secret", "ACME_PASS", "--line", "{}"]), 2);
    expectCode(f.run(["secret", "ACME_PASS", "--"]), 2);
    // «--» — только у secret
    expectCode(f.run(["doctor", "--"]), 2);
  });

  test.skipIf(!WIN)("Windows: .cmd по имени из PATH — аргументы с пробелом, &, %, ! доходят; с \" — отказ до запуска", () => {
    const f = fixture();
    const bin = `${f.dir}/bin`;
    mkdirSync(bin, { recursive: true });
    put(`${bin}/recv11n.cmd`, `@"${process.execPath}" "${f.recv}" %*\r\n`);
    const path = `${bin.replaceAll("/", "\\")};${process.env.PATH ?? process.env.Path ?? ""}`;
    const r = f.run(["secret", "ACME_PASS", "--line", "dev:{}", "--", "recv11n", "a b", "x&y", "%PATH%", "wow!", "p|q", "t\\"], { PATH: path, Path: path });
    expectCode(r, 0);
    const got = parse(r.out);
    expect(got.stdin).toBe(hex(`dev:${VALUE}\n`));
    expect(got.argv).toEqual(["a b", "x&y", "%PATH%", "wow!", "p|q", "t\\"]);
    const mark = `${f.dir}/ran.txt`;
    const quote = f.run(["secret", "ACME_PASS", "--", "recv11n", 'a"b'], { PATH: path, Path: path, RECV_MARK: mark });
    expectCode(quote, 1);
    expect(quote.err).toContain("в .cmd/.bat на Windows так не передаётся");
    expect(existsSync(mark)).toBe(false);
    noValue(quote);
  });
});
