// Antigravity IDE / Antigravity 2.0 (GUI): проектный плагин, записанный настоящим miksy sync, —
// stdio-обёртка и мост для HTTP с секретом. Домашние файлы IDE не меняются: miksy пишет только
// глобальный слой песочницы (её HOME) и плагин проекта песочницы, который открывают в IDE.
//   bun test/live/gui-antigravity.ts prep    → песочница; HTTP-заглушку запустить отдельно (команда в выводе)
//   (в IDE: открыть папку проекта, попросить агента вызвать инструменты)
//   bun test/live/gui-antigravity.ts report  → сводка по логам заглушек
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkHttp, checkStdio, finish, results, SECRETS, setup, type Box } from "./r1";

const PORT = 4797;
const mode = process.argv[2];
const state = join(tmpdir(), "h2a", "gui-agy.json");

if (mode === "prep") {
  const box = setup("gemini", PORT, "gui-agy");
  box.http?.kill();
  const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 12);
  writeFileSync(state, JSON.stringify({ ...box, http: undefined }));
  const stub = resolve(import.meta.dir, "stub-http.ts");
  console.log(`\nпроект для IDE: ${box.project.replaceAll("/", "\\")}`);
  console.log(`HTTP-заглушка: bun "${stub}" --port ${PORT} --log "${box.logs}/http.jsonl" --expect-sha ${sha(`Bearer ${SECRETS.H2A_TOKEN}`)} --key-sha ${sha(SECRETS.H2A_TOKEN)}`);
  console.log("в IDE: «Call the MCP tool http_auth_ok of server miksy_p_http and the tool probe of server miksy_p_stdio, then list all MCP tools you have.»");
} else if (mode === "report") {
  if (!existsSync(state)) throw new Error("сначала prep");
  const box = JSON.parse(readFileSync(state, "utf8")) as Box;
  checkStdio(box, ["p_stdio"]);
  checkHttp(box, [["p_http (мост)", "/p"]]);
  const calls = readFileSync(`${box.logs}/http.jsonl`, "utf8").split("\n").filter((l) => l.includes('"path":"/p"') && l.includes("tools/call")).length;
  results.push({ item: "IDE: вызов инструмента через мост", ok: calls > 0, detail: { calls } });
  console.log(`${calls > 0 ? "✅" : "❌"} IDE: вызов инструмента через мост: ${calls}`);
  finish({ ...box, agent: "gemini-ide" }, `results-r1-gemini-ide-${process.platform}.json`);
} else throw new Error("prep | report");
