#!/usr/bin/env bun
// Вход команды miksy. miksy mcp — запуск MCP-сервера агентом (src/mcprun.ts): быстрый путь без загрузки
// остальных команд, он стоит в начале каждого такого сервера
if (process.argv[2] === "mcp") {
  const { mcpRun } = await import("./mcprun");
  process.exit(await mcpRun(process.argv.slice(3)));
}
await import("./main");
