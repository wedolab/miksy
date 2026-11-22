#!/usr/bin/env bun
// Вход команды miksy. miksy mcp — запуск MCP-сервера агентом (src/mcprun.ts): быстрый путь без загрузки
// остальных команд, он стоит в начале каждого такого сервера
if (process.argv[2] === "mcp") {
  const { mcpRun } = await import("./mcprun");
  const code = await mcpRun(process.argv.slice(3));
  // Ответ агенту (ошибка JSON-RPC, пустой сервер) — до выхода: stdout в трубу пишется асинхронно
  await new Promise<void>((done) => process.stdout.write("", () => done()));
  process.exit(code);
}
await import("./main");
