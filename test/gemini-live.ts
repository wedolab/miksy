// Живая проверка Antigravity CLI без обращения к модели за пределами smoke-проверок
// и с безопасным изолированным тестовым окружением (настоящие файлы ~/.gemini не меняются):
// bun test/gemini-live.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gemini } from "../adapters/gemini";
import type { Machine, Resolved } from "../src/types";

const out = tmpdir();
const root = mkdtempSync(join(out, "gemini-live-"));
const home = join(root, "home");
const project = join(root, "project");
const machine: Machine = {
  home,
  workspace: root,
  os: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
  vars: {},
};

// Все вызовы agy — с временным домашним каталогом: агент пишет своё состояние (история, projects.json)
// в ~, и настоящий ~/.gemini не должен ни меняться, ни влиять на проверку. Если agy в изолированном
// HOME требует входа — проверка честно падает на шаге 6 (вход — через keychain/переменные окружения)
const isolated = { HOME: home, USERPROFILE: home };
const run = (args: string[], cwd = project, timeout = 90000, env: Record<string, string> = isolated) => {
  const result = Bun.spawnSync(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    timeout,
    env: { ...process.env, ...env },
  });
  if (result.exitCode !== 0) {
    throw new Error(`${args.slice(0, 3).join(" ")} failed (${result.exitCode}): ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
};

try {
  for (const dir of [
    home,
    project,
    join(home, ".gemini", "config"),
    join(home, ".gemini", "antigravity-ide"),
    join(root, "skill"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  // 1. Инициализация git-репозитория
  run(["git", "init", "--quiet", project]);

  // 2. Создание файлов слоёв miksy
  writeFileSync(join(root, "global-rule.md"), "Global marker: MIKSY_GEMINI_GLOBAL_1001\n");
  writeFileSync(
    join(root, "project-rule.md"),
    "When asked for secret token, reply with GEMINI_MIKSY_PROJECT_2002.\n",
  );
  writeFileSync(join(project, "AGENTS.md"), "Team mascot is SILVER_FALCON_3003.\n");
  writeFileSync(
    join(root, "skill/SKILL.md"),
    "---\nname: miksy-smoke\ndescription: Use when asked for the secret smoke skill code.\n---\nThe secret smoke skill code is DRAGON_FIRE_4004.\n",
  );

  const cfgGlobal: Resolved = {
    layers: ["global-layer"],
    instructions: [{ item: { file: "global-rule.md", path: join(root, "global-rule.md") }, layer: "global-layer" }],
    skills: [],
    mcp: [
      { item: { name: "test_stdio", command: "echo", args: ["live_stdio"] }, layer: "global-layer" },
      { item: { name: "test_http", url: "https://example.com/mcp" }, layer: "global-layer" },
    ],
    notes: [],
  };

  const cfgProject: Resolved = {
    layers: ["project-layer"],
    instructions: [{ item: { file: "project-rule.md", path: join(root, "project-rule.md") }, layer: "project-layer" }],
    skills: [{ item: { name: "miksy-smoke", dir: join(root, "skill") }, layer: "project-layer" }],
    mcp: [
      { item: { name: "local_stdio", command: "echo", args: ["live_project_stdio"] }, layer: "project-layer" },
      { item: { name: "local_http", url: "https://example.com/mcp" }, layer: "project-layer" },
    ],
    notes: [],
  };

  const globalResult = gemini.render(cfgGlobal, { scope: "global" }, machine);
  const projectResult = gemini.render(cfgProject, { scope: "project", dir: project, rel: "project" }, machine);

  // 4. Запись сгенерированных файлов
  for (const f of [...globalResult.files, ...projectResult.files]) {
    const targetDir = f.base === "home" ? home : project;
    const absPath = join(targetDir, f.path);
    mkdirSync(dirname(absPath), { recursive: true });
    if (f.mode === "own") {
      writeFileSync(absPath, f.content);
    } else if (f.mode === "merge") {
      writeFileSync(absPath, JSON.stringify({ [f.key[0]]: f.data }, null, 2));
    }
  }

  // 5. Проверка версии CLI
  const version = run(["agy", "--version"]).trim();
  console.log(`[PASS] agy CLI доступен, версия: ${version}`);

  // 6. Проверка одновременной загрузки правил из плагина и командного AGENTS.md
  const promptRules = run([
    "agy",
    "-p",
    "What is the secret token and what is the team mascot according to project instructions?",
  ]);
  if (!promptRules.includes("GEMINI_MIKSY_PROJECT_2002")) {
    throw new Error(`agy не применил правило из плагина: ${promptRules}`);
  }
  if (!promptRules.includes("SILVER_FALCON_3003")) {
    throw new Error(`agy не загрузил командный AGENTS.md: ${promptRules}`);
  }
  console.log("[PASS] Правила плагина .agents/plugins/miksy/rules/AGENTS.md и командный AGENTS.md загружены одновременно.");

  // Проверка, что командный AGENTS.md остался нетронутым
  if (readFileSync(join(project, "AGENTS.md"), "utf8") !== "Team mascot is SILVER_FALCON_3003.\n") {
    throw new Error("Командный AGENTS.md был изменён!");
  }
  console.log("[PASS] Командный AGENTS.md сохранён без изменений.");

  // 7. Проверка загрузки проектного skill из плагина
  const promptSkill = run(["agy", "-p", "what is the secret smoke skill code?"]);
  if (!promptSkill.includes("DRAGON_FIRE_4004")) {
    throw new Error(`agy не активировал skill из плагина: ${promptSkill}`);
  }
  console.log("[PASS] Проектный skill из .agents/plugins/miksy/skills/ успешно загружен и выполнен.");

  // 8. Проверка структуры и конфигурации плагина miksy
  const pluginManifest = JSON.parse(readFileSync(join(project, ".agents", "plugins", "miksy", "plugin.json"), "utf8"));
  if (pluginManifest.name !== "miksy") {
    throw new Error(`Некорректный манифест плагина: ${JSON.stringify(pluginManifest)}`);
  }
  const pluginMcp = JSON.parse(readFileSync(join(project, ".agents", "plugins", "miksy", "mcp_config.json"), "utf8"));
  if (!pluginMcp.mcpServers?.local_stdio || !pluginMcp.mcpServers?.local_http) {
    throw new Error(`Некорректный mcp_config.json плагина: ${JSON.stringify(pluginMcp)}`);
  }
  console.log("[PASS] Плагин .agents/plugins/miksy/ (plugin.json, rules, skills, mcp_config.json) сформирован корректно.");

  // 9. Проверка глобального MCP через agy mcp list — с временным домашним каталогом
  // (agy берёт ~ из HOME/USERPROFILE; настоящий ~/.gemini не трогаем)
  const testMcp = {
    mcpServers: {
      live_stdio_server: { command: "echo", args: ["hello"] },
      live_http_server: { url: "https://example.com/mcp" },
    },
  };
  writeFileSync(join(home, ".gemini", "config", "mcp_config.json"), JSON.stringify(testMcp, null, 2));
  const mcpList = run(["agy", "mcp", "list"]);
  if (!mcpList.includes("live_stdio_server") || !mcpList.includes("live_http_server")) {
    throw new Error(`agy mcp list не увидел серверы:\n${mcpList}`);
  }
  console.log("[PASS] agy mcp list распознаёт глобальные stdio и http серверы.");

  console.log("\nВсе живые проверки Gemini / Antigravity успешно пройдены!");
} finally {
  if (dirname(root) !== out) throw new Error("Небезопасный путь для очистки");
  rmSync(root, { recursive: true, force: true });
}

// Фаза 2а: обёртки секретов, helper/{file:}/мост — настоящим miksy sync в песочнице (test/live/r1.ts)
await (await import("./live/r1")).main("gemini");
