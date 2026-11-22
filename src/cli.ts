#!/usr/bin/env bun
// Вход команды miksy. miksy mcp — запуск MCP-сервера агентом (src/mcprun.ts): быстрый путь без загрузки
// остальных команд, он стоит в начале каждого такого сервера
// miksy mcp off|on [<имя>] — выключить сервер на этой машине (обычная команда, src/commands.ts; лишний аргумент —
// её ошибка). У запуска агентом первый аргумент — агент (агентов off и on нет), сервер off или on — третий
const mcpArgs = process.argv.slice(3).filter((a) => !a.startsWith("--"));
if (process.argv[2] === "mcp" && !["off", "on"].includes(mcpArgs[0])) {
  const { mcpRun } = await import("./mcprun");
  const code = await mcpRun(process.argv.slice(3));
  // Ответ агенту (ошибка JSON-RPC, пустой сервер) — до выхода: stdout в трубу пишется асинхронно
  await new Promise<void>((done) => process.stdout.write("", () => done()));
  process.exit(code);
}
await import("./main");
