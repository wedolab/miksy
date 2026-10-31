import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Adapter, RenderContext, RenderedFile } from "../../src/adapter";
import { deliver, type Launcher, nativeServers } from "../../src/launch";
import { skillFiles } from "../../src/skillfiles";
import type { McpServer } from "../../src/types";
import { serverSecrets } from "../../src/vars";
import { configsOf, currentGlobal, currentProject, strictJson } from "./current";

export const HEADER = (layers: string[]) =>
  `<!-- Сгенерировано miksy (слои: ${layers.join(" → ")}). Не править вручную — изменения вносить в конфигурацию miksy (слои). -->`;

// Секреты: stdio — обёртка (command: [путь]); HTTP — {file:путь} файла секрета в заголовке
// (файл обязан существовать: иначе opencode не стартует вовсе); секрет в URL — мост
export function nativeMcp(s: McpServer, launch?: Launcher): Record<string, unknown> | null {
  const special = s.agents?.opencode;
  if (special === "skip") return null;
  const d = deliver(s, launch, "file");
  const base: Record<string, unknown> =
    d.kind === "stdio" ? { type: "local", command: [d.command] }
    : d.kind === "file" ? { type: "remote", url: d.url, headers: d.headers }
    : s.url ? { type: "remote", url: s.url, ...(s.headers && { headers: s.headers }) }
    : { type: "local", command: [s.command, ...(s.args ?? [])], ...(s.env && { environment: s.env }) };
  return special ? { ...base, ...special.raw } : base;
}

// Кандидаты конфига opencode: корневые (чужие — merge поимённо) и .opencode/ (только командные)
const ROOT_CONFIGS = ["opencode.json", "opencode.jsonc"];

// Наш ли проектный opencode.json — по учёту miksy, а не по содержимому: метка в файле
// не отличает свой файл без instructions от чужого и чужой с меткой от своего
// pathKey, а не samePath: битая ссылка на пути (.opencode → удалённый каталог) не роняет рендер,
// а даёт логический ключ; запись по такому пути отвергнет ядро (конфликт цели)
import { fold, pathKey } from "../../src/paths";
const isOwned = (abs: string, ctx?: RenderContext) =>
  !!ctx?.ownedFiles.some((f) => fold(pathKey(f)) === fold(pathKey(abs)));

export const opencode: Adapter = {
  id: "opencode",
  // Проверено вживую (2026-10-10): проектные skills читает из .agents, .claude (Claude-совместимость),
  // .opencode/skills и .opencode/skill; .codex/.gemini — нет. Дедупликация с .claude/skills — открытый вопрос.
  skillDirs: [".agents/skills", ".claude/skills", ".opencode/skills", ".opencode/skill"],
  homeConfig: [".config/opencode/opencode.json", ".config/opencode/opencode.jsonc", ".config/opencode/AGENTS.md", ".config/opencode/skills"],
  nativeMcp,
  // Проверено вживую (2.0.32, фаза 2в): opencode.json и каталоги skills всех родительских каталогов
  // сливаются и в git-проекте (одноимённое — ближний); относительный instructions (.opencode/miksy.md)
  // читается только из каталога сессии — правила наследованием не приходят, нужна полная цепочка
  inherits: () => ({ skills: true, mcp: true }),
  httpSecrets: "file",

  // opencode не хранит реестр проектов — каталоги берём из лога запусков
  knownDirs(machine) {
    const log = join(machine.home, ".local", "share", "opencode", "log", "opencode.log");
    if (!existsSync(log)) return [];
    const dirs = new Set<string>();
    for (const m of readFileSync(log, "utf8").matchAll(/message="creating instance" directory="([^"]*)"/g))
      dirs.add(m[1].replaceAll("\\\\", "\\").replaceAll("\\", "/"));
    return [...dirs];
  },

  current: (target, machine) =>
    target.scope === "global" ? currentGlobal(machine.home) : currentProject(target.dir, machine.home),

  render(cfg, target, machine, ctx) {
    const files: RenderedFile[] = [];
    const warnings: string[] = [];
    const isGlobal = target.scope === "global";
    const anchor = isGlobal ? machine.home : target.dir;
    const body = () => cfg.instructions.map((i) => readFileSync(i.item.path, "utf8").trim()).join("\n\n");

    // Инструкции, глобально: ~/.config/opencode/AGENTS.md (персональный, не коммитится)
    if (cfg.instructions.length && isGlobal) {
      files.push({ base: "home", path: ".config/opencode/AGENTS.md", mode: "own", content: `${HEADER(cfg.layers)}\n\n${body()}\n` });
      for (const { path, cfg: c } of configsOf(join(machine.home, ".config", "opencode")))
        if ((c.instructions ?? []).length)
          warnings.push(`инструкции opencode: ${path} подключает файлы через instructions — они загрузятся ПОВЕРХ нового AGENTS.md; после проверки убрать (миграция без удаления)`);
    }

    // Skills: ~/.config/opencode/skills/<name>/ или <проект>/.opencode/skills/<name>/
    // (дедупликация с .claude/skills, который opencode подхватывает сам, — открытый вопрос)
    for (const { item } of cfg.skills) {
      if (!isGlobal && ctx?.deliveredSkills?.includes(item.name)) continue;
      for (const f of skillFiles(item, warnings)) {
        files.push({
          base: isGlobal ? "home" : "project",
          path: `${isGlobal ? ".config/opencode/skills/" : ".opencode/skills/"}${item.name}/${f.rel}`,
          mode: "own",
          content: f.content,
          ...(f.executable && { executable: true }),
          ...(item.team && { team: true }),
        });
      }
      if (isGlobal && existsSync(join(machine.home, ".claude", "skills", item.name, "SKILL.md")))
        warnings.push(`skill ${item.name}: уже есть в ~/.claude/skills (пишет адаптер claude, opencode подхватывает сам) — будет дубликат с предупреждением «duplicate skill name» в логе`);
    }

    // MCP: объект для merge/own-конфига
    const servers = nativeServers(cfg.mcp, "opencode", nativeMcp, ctx?.launch, warnings);
    const hasMcp = Object.keys(servers).length > 0;
    // Пропущенный сервер с {file:} оставлять нельзя, если файла секрета нет: отсутствующий файл
    // делает невалидным весь конфиг opencode (не один сервер)
    const noKeep: string[] = [];
    for (const k of ctx?.skipped ?? []) {
      const s = k.item;
      if (!s.url || s.agents?.opencode === "skip" || !ctx?.launch) continue;
      const names = [...new Set([...serverSecrets({ name: s.name, headers: s.headers }), ...k.vars])];
      if (!names.length || serverSecrets({ name: s.name, url: s.url }).length) continue;
      const lost = names.filter((n) => !existsSync(ctx.launch!.secretPath(n)));
      if (!lost.length) continue;
      noKeep.push(s.name);
      warnings.push(`mcp ${s.name}: нет файла секрета ${lost.join(", ")} — сервер убран из конфига opencode (с {file:} на отсутствующий файл opencode не запустился бы целиком)`);
    }
    const done = (r: { files: RenderedFile[]; warnings: string[] }) => ({ ...r, ...(noKeep.length && { noKeep }) });

    if (isGlobal) {
      if (!hasMcp) return done({ files, warnings });
      const candidates = [".config/opencode/opencode.json", ".config/opencode/opencode.jsonc"];
      const existing = candidates.filter((p) => existsSync(join(anchor, p)));
      if (existing.length > 1)
        warnings.push(`mcp opencode: несколько конфигов (${existing.join(", ")}) — miksy сливает в ${existing[0]}, остальные тоже загрузятся`);
      const path = existing[0] ?? candidates[0];
      if (existing.length && !strictJson(join(anchor, path)))
        warnings.push(`mcp opencode: ${path} не парсится как строгий JSON (JSONC-комментарии? — DESIGN §11); серверы не записаны`);
      else {
        files.push({ base: "home", path, mode: "merge", format: "json", key: ["mcp"], data: servers });
        files.push(...(ctx?.launch?.files() ?? []));
      }
      return done({ files, warnings });
    }

    // Проект. Инструкции — через .opencode/miksy.md, подключённый в instructions
    // собственного корневого opencode.json (own, с меткой). Корень свободен — создаём свой,
    // даже если есть командный .opencode/opencode.json (конфиги сливаются).
    // Занят чужим корневым конфигом — только mcp поимённо, инструкции — warning.
    const rootJson = join(anchor, "opencode.json");
    const rootJsonc = join(anchor, "opencode.jsonc");
    const managed = existsSync(rootJson) && isOwned(rootJson, ctx);
    const rootFree = !existsSync(rootJson) && !existsSync(rootJsonc);
    const ours = managed || rootFree;
    // Конфиги-соседи, которые тоже загрузятся (в ours-ветке rootJson — наш, в чужой — оба корневых учтены)
    const side = (skipRoot: boolean) => [
      ...(!skipRoot && existsSync(rootJsonc) ? ["opencode.jsonc"] : []),
      ...(existsSync(join(anchor, ".opencode", "opencode.json")) ? [".opencode/opencode.json"] : []),
    ];
    const sideConfigs = side(!ours);

    if (cfg.instructions.length && !ours)
      warnings.push("инструкции opencode: корневой opencode.json проекта не от miksy — instructions не записаны (записывается только mcp)");

    if (cfg.instructions.length && ours)
      files.push({ base: "project", path: ".opencode/miksy.md", mode: "own", content: `${HEADER(cfg.layers)}\n\n${body()}\n` });

    if (ours) {
      // Свой корневой opencode.json целиком: $schema + instructions (метка) + mcp.
      // Конфиги .opencode/ грузятся позже и перекроют наши ключи при совпадении имён.
      if (sideConfigs.length)
        warnings.push(`mcp opencode: ${sideConfigs.join(", ")} тоже загрузится; при совпадении имён серверов перекроет наш opencode.json`);
      const own: Record<string, unknown> = { $schema: "https://opencode.ai/config.json" };
      if (cfg.instructions.length) own.instructions = [".opencode/miksy.md"];
      if (hasMcp) own.mcp = servers;
      files.push({ base: "project", path: "opencode.json", mode: "own", mcp: { format: "json", key: "mcp" }, content: JSON.stringify(own, null, 2) + "\n" });
      if (hasMcp) files.push(...(ctx?.launch?.files() ?? []));
    } else if (hasMcp) {
      // Чужой корневой конфиг: только mcp, поимённо внутри ключа mcp
      const existing = ROOT_CONFIGS.filter((p) => existsSync(join(anchor, p)));
      if (existing.length > 1)
        warnings.push(`mcp opencode: несколько конфигов (${[...existing, ...sideConfigs].join(", ")}) — miksy сливает в ${existing[0]}, остальные тоже загрузятся`);
      else if (sideConfigs.length)
        warnings.push(`mcp opencode: ${sideConfigs.join(", ")} тоже загрузится`);
      const path = existing[0]!;
      if (!strictJson(join(anchor, path)))
        warnings.push(`mcp opencode: ${path} не парсится как строгий JSON (JSONC-комментарии? — DESIGN §11); серверы не записаны`);
      else {
        files.push({ base: "project", path, mode: "merge", format: "json", key: ["mcp"], data: servers });
        files.push(...(ctx?.launch?.files() ?? []));
        warnings.push(`mcp opencode: ${path} — файл командной формы; miksy владеет только именами серверов внутри mcp (отслеживаемый git — конфликт) и не скрывает чужой файл через .git/info/exclude`);
      }
    }

    return done({ files, warnings });
  },
};
