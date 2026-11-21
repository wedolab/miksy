// miksy mcp <агент> <место проекта> <сервер> [--bridge] — так агент запускает MCP-сервер проекта,
// когда MCP проекта лежит в папке проекта (src/adapter.ts projectMcp): в файле проекта нет путей машины, и одна
// папка на двух машинах даёт одинаковый файл. Обёртку этой машины (секреты, пути, переменные) пишет miksy sync в
// local/run/<агент>/<placeSlug(место)>/ — команда только находит её и запускает с теми же stdin, stdout и stderr.
// Слои и machine.yaml не читаются: быстро и так же, как записал sync. Ошибка — одна строка в stderr (её
// показывает лог агента) и код 1; неверный вызов — код 2
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { configRoot, hasConfig } from "./load";
import { helperCommand, placeSlug, scriptName } from "./launch";

const KINDS = { "--bridge": "bridge" } as const;

export async function mcpRun(argv: string[]): Promise<number> {
  const say = (s: string) => process.stderr.write(`miksy: ${s}\n`);
  const flags = argv.filter((a) => a.startsWith("--"));
  const [agent, place, server, ...extra] = argv.filter((a) => !a.startsWith("--"));
  if (server === undefined || extra.length || flags.length > 1 || flags.some((f) => !(f in KINDS)) || !/^[a-z][a-z0-9-]*$/.test(agent)) {
    say("miksy mcp <агент> <место проекта> <сервер> [--bridge] — запуск MCP-сервера проекта агентом; файл проекта с такой командой пишет miksy sync");
    return 2;
  }
  const kind = flags.length ? KINDS[flags[0] as keyof typeof KINDS] : "stdio";
  let config: string;
  try { config = configRoot(); }
  catch (e) { say(`конфигурация miksy не найдена (${(e as Error).message}) — MCP-сервер ${server} не запущен`); return 1; }
  if (!hasConfig(config)) {
    say(`конфигурация miksy не найдена (${config}; MIKSY_CONFIG или ~/.miksy) — MCP-сервер ${server} не запущен`);
    return 1;
  }
  const win = process.platform === "win32";
  const script = join(config, "local", "run", agent, placeSlug(place), `${scriptName(server, kind)}${win ? ".cmd" : ".sh"}`);
  if (!existsSync(script)) {
    say(`на этой машине не записан запуск MCP-сервера ${server} (${agent}, проект ${place}) — выполните miksy sync в папке проекта или miksy sync --all`);
    return 1;
  }
  if (win) {
    // .cmd — через cmd /d /s /c "<путь>" дословно: путь в кавычках (& ^ ( ) — литералы), % и ! — вне кавычек с ^
    // (helperCommand, как строка helper-а Codex); Bun не перестраивает кавычки (windowsVerbatimArguments)
    const child = spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${helperCommand(script, "windows")}"`], { stdio: "inherit", windowsVerbatimArguments: true, windowsHide: true });
    return await new Promise<number>((done) => child.on("exit", (code) => done(code ?? 1)).on("error", (e) => { say(`MCP-сервер ${server} не запущен: ${e.message}`); done(1); }));
  }
  const child = Bun.spawn([script], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  // Агент останавливает сервер сигналом этому процессу — передаём его серверу (Windows: сервер закрывается сам,
  // когда агент закрывает его stdin)
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => child.kill(sig));
  return await child.exited;
}
