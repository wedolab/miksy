import type { Launcher } from "./launch";
import type { OwnFiles, PendingTrust, TrustRenew } from "./trust";
import type { HttpDelivery, SkippedMcp } from "./vars";
import type { Machine, Resolved } from "./types";

// nested — внутри цели есть другие проекты: файлы, которые агент наследует вниз по дереву
// (у Claude — CLAUDE.local.md), адаптер туда не пишет. git — цель является git-репо.
// group — цель-группа (target: true в layer.yaml): наследуемые файлы пишутся и при nested —
// цели ниже получают от неё свой отрезок слоёв (Resolved.below)
export type Target =
  | { scope: "global" }
  | { scope: "project"; dir: string; rel: string; nested?: boolean; git?: boolean; group?: boolean };

// Что агент сам читает из родительских каталогов каталога сессии (проверено вживую): rules —
// склеиваемые правила (цель ниже группы получает только свой отрезок), skills и mcp — сливаемое
// по имени (ближний перекрывает; исключённое в цели придёт из файлов группы — предупреждение)
export type Inherits = { rules?: boolean; skills?: boolean; mcp?: boolean };

// base: куда относится path — домашний каталог, каталог проекта или local/ конфигурации miksy
// (сгенерированные обёртки и helper-ы секретов, src/launch.ts; не в проекте и не в доме).
// Проектный конфиг может требовать записи в домашний каталог (локальные каналы агента).
// merge: data — объект, которым владеем поимённо; optional — не создавать, если родителя по key нет.
// executable — файлу нужен +x (скрипт skill); права существующего файла ядро сохраняет.
// sensitive (ставит ядро) — в файле MCP или подставленный секрет: 0600 (исполняемому — 0700).
// secretKeys (ставит ядро для merge) — имена внутри data, которым нужны секреты (обёртка/helper).
// team — файл импортированного командного skill (копия командного содержимого, не личный файл).
export type RenderedFile = { sensitive?: boolean } & (
  | { base: "home" | "project" | "local"; path: string; mode: "own"; content: string; block?: boolean; executable?: boolean; team?: boolean; mcp?: { format: "json" | "toml"; key: string } }
  | { base: "home" | "project"; path: string; mode: "merge"; format: "json" | "toml"; key: string[]; data: unknown; optional?: boolean; secretKeys?: string[] });

// keep — MCP, пропущенные ядром (не хватает переменных, секрет нельзя доставить): уже записанные
// определения не удаляются. noKeep (ставит адаптер) — пропущенные, которые оставлять нельзя
// (opencode: {file:} на несуществующий файл сделал бы невалидным весь конфиг).
// secrets (ставит ядро) — имена секретов, файлы которых нужны записанным конфигам цели
export interface RenderResult {
  clean?: boolean; // явная очистка (доверие снимается только при clean)
  files: RenderedFile[];
  warnings: string[];
  keep?: string[];
  noKeep?: string[];
  secrets?: string[];
  // Секреты по серверам (ставит ядро): доставленные сейчас и оставленные keep-ом — по записанной версии
  servers?: Record<string, string[]>;
  // Предупреждения, которые doctor показывает справочно (действие пользователя в агенте, не miksy)
  advice?: string[];
  // Доверие проекта из слоёв (trust в layer.yaml) — заполняет ядро после рендера адаптера
  trust?: Resolved["trust"];
  // Доверие ждёт решения пользователя (исполняемые настройки агента) — заполняет plan (src/trust.ts)
  trustPending?: PendingTrust;
  // «Да» прежнего расчёта отпечатка — перенести на новый (sync сохраняет; src/trust.ts: renewDecision)
  trustRenew?: TrustRenew;
  // Свои файлы и одобрения цели, как их считал план доверия (с файлами miksy, узнанными после «забыть»): по ним
  // смотрит miksy trust <проект>
  trustOwn?: OwnFiles;
}

// Что агент видит сейчас из ручных конфигов — для сравнения при миграции
export interface CurrentState {
  instructionFiles: string[];
  instructionTexts?: { source: string; text: string }[]; // инструкции из полей конфига
  mcp: Record<string, { source: string; def: Record<string, unknown> }>;
}

// Что miksy уже записал для этой цели и агента (по учёту): адаптер решает «наш ли файл»
// по учёту, а не по содержимому. ownedFiles — абсолютные пути через «/»
// launch — доставка секретов (обёртки, helper-ы, мост): без неё сервер с секретом — ошибка
// skipped — пропущенные ядром серверы (со ссылками на секреты): для решения о keep
export interface RenderContext {
  deliveredSkills?: string[]; // уже доставленные этим sync в .claude/skills или .agents/skills проекта
  ownedFiles: string[];
  keep?: string[]; // пропущенные MCP: рендер own-конфига нужен даже без остальных серверов
  launch?: Launcher;
  skipped?: SkippedMcp[];
}

export interface Adapter {
  id: string;
  render(cfg: Resolved, target: Target, machine: Machine, ctx?: RenderContext): RenderResult;
  // Определение MCP в формате агента; секреты — через launch (без него сервер с секретом — DeliveryError)
  nativeMcp(s: Resolved["mcp"][number]["item"], launch?: Launcher): Record<string, unknown> | null;
  current?(target: Target, machine: Machine): CurrentState;
  // Каталоги проекта, где агент сам находит skills (<dir>/<имя>/SKILL.md); только проверенные вживую
  skillDirs?: string[];
  // MCP, которые агент заводит сам для своей работы (не пользовательские) — doctor их не показывает
  internalMcp?: string[];
  // Каталоги, где агент уже работал (кандидаты в проекты помимо git-репо)
  knownDirs?(machine: Machine): string[];
  // Наследование из родительских каталогов для проектной цели (нет — агент читает только свою цель)
  inherits?(target: Extract<Target, { scope: "project" }>): Inherits;
  // Файлы правил проекта (относительно цели), которые агент наследует вниз: по ним ядро решает,
  // получила ли группа правила (Inherits.rules)
  rulesFiles?: string[];
  // Как агент получает секрет заголовка HTTP-сервера: от способа зависят ограничения значения
  httpSecrets?: HttpDelivery;
  // Глобальные файлы и каталоги настроек агента (относительно ~): то, что miksy меняет глобально, и
  // настройки рядом — setup копирует их до первой записи (local/backups/before-miksy-<метка>/)
  homeConfig?: string[];
}
