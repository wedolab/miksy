#!/usr/bin/env bun
import { onApplyNote } from "./apply";
import { UsageError } from "./args";
import { Cancelled, runCommand, USAGE } from "./commands";
import { cacheGit } from "./git";
import { engineVersion } from "./version";

let [cmd, ...rest] = process.argv.slice(2);
if (cmd === undefined || ["help", "--help", "-h"].includes(cmd)) {
  console.log(USAGE.replace(/^miksy/, `miksy ${engineVersion()}`));
  process.exit(0);
}
if (cmd === "--version") cmd = "version";
// Одна команда — один снимок git (miksy индекс не меняет); сообщения apply — в вывод
cacheGit();
onApplyNote(console.log);
try {
  process.exitCode = runCommand(cmd, rest);
} catch (e) {
  if (e instanceof UsageError) {
    console.error(`Ошибка: ${e.message}\n\nСправка: miksy help`);
    process.exit(2);
  }
  if (e instanceof Cancelled) {
    console.log(e.message);
    process.exit(1);
  }
  console.error("Ошибка: " + (e as Error).message);
  process.exit(1);
}
