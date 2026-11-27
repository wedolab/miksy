// Круг 11z: ~/.gemini/antigravity-ide/mcp_config.json никто не читает (agy 1.5.9 вживую, IDE 2.7.0 и Antigravity 2.0 —
// по бандлу) — miksy его не пишет; записанное туда прежней версией снимается по учёту слияний: файл, созданный miksy
// (made), удаляется, иначе свои серверы уходят, чужие остаются. Повторный sync — без изменений
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cliFixture, expectCode, put, said } from "./helpers";

function fixture() {
  const f = cliFixture({ agents: ["antigravity"] });
  put(`${f.config}/layers/global/mcp/tok.yaml`, "name: tok\ncommand: tok-server\n");
  mkdirSync(`${f.home}/.gemini/antigravity-ide`, { recursive: true });
  return f;
}
const CLI = ".gemini/config/mcp_config.json", IDE = ".gemini/antigravity-ide/mcp_config.json";
const ledgerPath = (config: string) => `${config}/local/state/manifest.json`;

// Учёт и файл, как их оставила прежняя версия: слияние в файл IDE (серверы miksy — как в файле CLI); made — файл
// создал miksy
function oldState(f: ReturnType<typeof fixture>, ideText: string, made: boolean) {
  writeFileSync(`${f.home}/${IDE}`, ideText);
  const m = JSON.parse(readFileSync(ledgerPath(f.config), "utf8"));
  const st = Object.values(m.targets).find((s: any) => Object.keys(s.merges ?? {}).some((k) => k.endsWith(CLI))) as any;
  const cli = Object.keys(st.merges).find((k) => k.endsWith(CLI))!;
  st.merges[cli.replace(CLI, IDE)] = st.merges[cli];
  if (made) {
    const key = Object.keys(m.made?.files ?? {}).find((k) => k.endsWith(CLI))!;
    m.made.files[key.replace(CLI, IDE)] = m.made.files[key];
  }
  writeFileSync(ledgerPath(f.config), JSON.stringify(m));
}

describe("Antigravity: файл IDE больше не пишется (круг 11z)", () => {
  test("файл создал miksy: sync снимает свои серверы и удаляет файл; папка IDE остаётся; повторный sync — без изменений", () => {
    const f = fixture();
    expectCode(f.run(["sync", "--global"]), 0);
    expect(existsSync(`${f.home}/${IDE}`)).toBe(false);
    oldState(f, readFileSync(`${f.home}/${CLI}`, "utf8"), true);
    const s = f.run(["sync", "--global"]);
    expect({ code: s.code, ide: existsSync(`${f.home}/${IDE}`), dir: existsSync(`${f.home}/.gemini/antigravity-ide`), cli: readFileSync(`${f.home}/${CLI}`, "utf8").includes("tok-server") }, said(s))
      .toEqual({ code: 0, ide: false, dir: true, cli: true });
    const again = f.run(["sync", "--global"]);
    expect({ code: again.code, none: again.out.includes("изменений нет") }, said(again)).toEqual({ code: 0, none: true });
  }, 90000);

  test("файл был до miksy, в нём и чужой сервер: уходит только свой, чужой остаётся", () => {
    const f = fixture();
    expectCode(f.run(["sync", "--global"]), 0);
    const cli = JSON.parse(readFileSync(`${f.home}/${CLI}`, "utf8"));
    oldState(f, JSON.stringify({ mcpServers: { mine: { command: "mine" }, ...cli.mcpServers } }, null, 2), false);
    expectCode(f.run(["sync", "--global"]), 0);
    expect(JSON.parse(readFileSync(`${f.home}/${IDE}`, "utf8"))).toEqual({ mcpServers: { mine: { command: "mine" } } });
    expectCode(f.run(["clean", "--global"]), 0);
    expect(JSON.parse(readFileSync(`${f.home}/${IDE}`, "utf8"))).toEqual({ mcpServers: { mine: { command: "mine" } } });
  }, 90000);

  test("mcp_config.json с комментариями: предупреждение — что убрать, серверы не записаны, файл не тронут", () => {
    const f = fixture();
    const text = '{\n  // мой\n  "mcpServers": {},\n}\n';
    put(`${f.home}/${CLI}`, text);
    const r = f.run(["sync", "--global"]);
    expect({ warn: r.out.includes("(комментарии, запятая в конце, BOM) — Antigravity не читает такой файл целиком: уберите их; серверы miksy не записаны"), same: readFileSync(`${f.home}/${CLI}`, "utf8") === text, ide: existsSync(`${f.home}/${IDE}`) }, said(r))
      .toEqual({ warn: true, same: true, ide: false });
  }, 60000);
});
