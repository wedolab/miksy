// miksy mcp <агент> <место проекта> <сервер> [--bridge] — так агент запускает MCP-сервер проекта,
// когда MCP проекта лежит в папке проекта (src/adapter.ts projectMcp): в файле проекта нет путей машины, и одна
// папка на двух машинах даёт одинаковый файл. Обёртку этой машины (секреты, пути, переменные) пишет miksy sync в
// local/run/<агент>/<placeSlug(место)>/ — команда только находит её и запускает с теми же stdin, stdout и stderr.
// Слои и machine.yaml не читаются: быстро и так же, как записал sync. Ошибка — одна строка в stderr (её
// показывает лог агента) и ответ-ошибка агенту на initialize (её Codex показывает пользователю), код 1; неверный
// вызов — код 2. Сервер, который на этой машине не запускается, — причина (или пустой сервер), круг 11b
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { configRoot, hasConfig } from "./load";
import { helperCommand, placeSlug, reasonName, scriptName } from "./launch";

const KINDS = { "--bridge": "bridge" } as const;

export async function mcpRun(argv: string[]): Promise<number> {
  const say = (s: string) => process.stderr.write(`miksy: ${s}\n`);
  const flags = argv.filter((a) => a.startsWith("--"));
  const [agent, place, server, ...extra] = argv.filter((a) => !a.startsWith("--"));
  if (server === undefined || extra.length || flags.length > 1 || flags.some((f) => !(f in KINDS)) || !/^[a-z][a-z0-9-]*$/.test(agent)) {
    say("miksy mcp <агент> <место проекта> <сервер> [--bridge] — запуск MCP-сервера проекта агентом; файл проекта с такой командой пишет miksy sync");
    return 2;
  }
  let kind: "stdio" | "bridge" = flags.length ? KINDS[flags[0] as keyof typeof KINDS] : "stdio";
  let config: string;
  try { config = configRoot(); }
  catch (e) { return await refuse(`конфигурация miksy не найдена (${(e as Error).message}) — MCP-сервер ${server} не запущен`); }
  if (!hasConfig(config)) {
    return await refuse(`конфигурация miksy не найдена (${config}; MIKSY_CONFIG или ~/.miksy) — MCP-сервер ${server} не запущен`);
  }
  const win = process.platform === "win32";
  const dir = join(config, "local", "run", agent, placeSlug(place));
  // Сервер на этой машине не запускается (круг 11b): sync записал причину вместо обёртки. sync держит один из двух
  // файлов (лишний снимает с учёта и удаляет); остались оба (удаление не удалось) — верит более свежему
  const mtime = (p: string) => { try { return statSync(p).mtimeMs; } catch { return -1; } };
  const files = (k: "stdio" | "bridge") => [join(dir, reasonName(server, k)), join(dir, `${scriptName(server, k)}${win ? ".cmd" : ".sh"}`)];
  // Без --bridge и без stdio-файлов — мост: у имени со stdio- и HTTP-вариантами флага в файле проекта нет (круг 11b-3)
  if (!flags.length && files("stdio").every((p) => mtime(p) < 0) && files("bridge").some((p) => mtime(p) >= 0)) kind = "bridge";
  const [reason, script] = files(kind) as [string, string];
  if (mtime(reason) >= 0 && mtime(reason) >= mtime(script)) {
    let r: { why?: unknown; quiet?: unknown } = {};
    try { r = JSON.parse(readFileSync(reason, "utf8")); } catch { /* испорчен — общая причина */ }
    const why = typeof r.why === "string" ? r.why : "причина не прочитана — выполните miksy sync";
    return r.quiet === true ? await emptyServer(server) : await refuse(`MCP-сервер ${server} на этой машине не запускается: ${why}`);
  }
  if (!existsSync(script)) {
    return await refuse(`на этой машине не записан запуск MCP-сервера ${server} (${agent}, проект ${place}) — выполните miksy sync в папке проекта или miksy sync --all`);
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


// Запрос агента: объект с method и id (ответы агента — {id, result|error} без method — и уведомления ответа не ждут)
type Message = { id?: unknown; method?: unknown; params?: unknown };
const isRequest = (m: Message) => typeof m.method === "string" && m.id !== undefined;

// Сообщения JSON-RPC из stdin по строкам (MCP stdio), последнее — и без перевода строки перед концом ввода. Пакет
// (массив) MCP не использует (с 2025-06-18 его нет в протоколе) — ответ ошибкой -32600. Обработчик возвращает false —
// хватит. stdin — терминал (запуск вручную) — сообщений не ждём
async function readMessages(on: (m: Message) => boolean): Promise<void> {
  if (process.stdin.isTTY) return;
  let buf = "";
  const dec = new TextDecoder();
  const line = (text: string): boolean => {
    const t = text.trim();
    if (!t) return true;
    let m: unknown;
    try { m = JSON.parse(t); } catch { send({ id: null, error: { code: -32700, message: "miksy: сообщение не разобрано (ожидается JSON-RPC)" } }); return true; }
    if (Array.isArray(m)) { send({ id: null, error: { code: -32600, message: "miksy: пакеты JSON-RPC не поддерживаются" } }); return true; }
    return !(m && typeof m === "object") || on(m as Message);
  };
  for await (const chunk of Bun.stdin.stream()) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const one = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line(one)) return;
    }
  }
  line(buf + dec.decode());
}
const send = (msg: object) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");

// Сервер не запущен: причина — в stderr (лог агента) и ответом-ошибкой на первый запрос (initialize). Codex показывает
// пользователю только ошибку рукопожатия, не stderr (проверено вживую, круг 11b), opencode — то и другое. Код 1
async function refuse(why: string): Promise<number> {
  const text = `miksy: ${why}`;
  process.stderr.write(text + "\n");
  await readMessages((m) => {
    if (!isRequest(m)) return true;
    send({ id: m.id, error: { code: -32000, message: text } });
    return false;
  });
  return 1;
}

// Пустой сервер: сервер на этой машине не нужен (только для другой ОС) — агент подключает его без ошибки, инструментов
// нет. Работает, пока агент не закроет stdin; запуск вручную в терминале — строка в stderr и выход
async function emptyServer(server: string): Promise<number> {
  if (process.stdin.isTTY) {
    process.stderr.write(`miksy: MCP-сервер ${server} на этой машине не используется — агенту он отвечает пустым (без инструментов)\n`);
    return 0;
  }
  const empty: Record<string, object> = { "tools/list": { tools: [] }, "resources/list": { resources: [] }, "resources/templates/list": { resourceTemplates: [] }, "prompts/list": { prompts: [] }, ping: {} };
  await readMessages((m) => {
    if (!isRequest(m)) return true;
    const method = m.method as string;
    if (method === "initialize") {
      const asked = (m.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      send({ id: m.id, result: { protocolVersion: typeof asked === "string" ? asked : "2025-06-18", capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: "miksy", version: "0" } } });
    } else if (method in empty) send({ id: m.id, result: empty[method] });
    else send({ id: m.id, error: { code: -32601, message: `miksy: метод ${method} не поддерживается — сервер на этой машине не используется` } });
    return true;
  });
  return 0;
}
