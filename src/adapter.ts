import type { Launcher } from "./launch";
import type { OwnFiles, PendingTrust, TrustRenew } from "./trust";
import type { HttpDelivery, SkippedMcp } from "./vars";
import type { Machine, Resolved } from "./types";
import type { Manifest } from "./manifest";

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
// skillSecret — копия файла-секрета skill слоя («<skill>/<файл>»; skillFiles): секрет хранится не только в local/ (круг 11i-2).
export type RenderedFile = { sensitive?: boolean } & (
  | { base: "home" | "project" | "local"; path: string; mode: "own"; content: string; block?: boolean; executable?: boolean; team?: boolean; skillSecret?: string; mcp?: { format: "json" | "toml"; key: string } }
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
  // Серверы цели запускает команда miksy (miksy mcp) — ставит ядро; doctor тогда проверяет команду
  portable?: boolean;
  // Предупреждения, которые doctor считает проблемой: сами не уйдут (Claude: инструкции не записаны — их версионирует команда)
  persistent?: string[];
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
  // MCP проектной цели агент читает из файла в папке проекта (а не из домашнего конфига): "portable" — в файл
  // идёт команда «miksy mcp …» без путей этой машины, обёртку своей машины она находит сама (src/mcprun.ts),
  // и одна папка проекта на двух машинах даёт одинаковый файл
  projectMcp?: "portable";
  // Глобальные файлы и каталоги настроек агента (относительно ~): то, что miksy меняет глобально, и
  // настройки рядом — setup копирует их до первой записи (local/backups/before-miksy-<метка>/)
  homeConfig?: string[];

  // ---- Особенности агента для общего кода (круг 10x): данные — полями, поведение — методами ----
  // Название в сообщениях («Claude», «Codex»)
  title: string;
  // Прежние имена — рабочие синонимы во входных данных и учёте (src/agentid.ts); aliasNote — пояснение к подсказке
  // переименовать (doctor)
  aliases?: string[];
  aliasNote?: string;
  // Как найти агента на машине: команда в PATH или (агент только в редакторе) каталог настроек в доме
  detect: { commands: string[]; dirs: string[] };
  // Программа для сводки окружения (несколько установок — doctor, мастер): название и команды
  program: { name: string; commands: string[] };
  // Сводка окружения про установку программы (exe — первая в PATH): что не так (например, старая версия)
  programNote?(exe: string, shown: string): string | null;
  // Основная версия программы для сводки установок («(2.x)») — если её можно узнать, не запуская программу
  programMajor?(exe: string): number | null;
  // Переменные окружения, меняющие, где агент ищет настройки. replace — читает только оттуда (std — стандартный
  // каталог, куда пишет miksy; dir/stdDir — каталог настроек по значению, если не само значение); иначе —
  // дополнительный конфиг поверх over(home)
  envVars?: { name: string; title: string; std(home: string): string; replace: boolean; dir?(value: string): string; stdDir?(home: string): string; over?(home: string): string }[];
  // Глобальный каталог skills агента (относительно ~): doctor ищет в нём чужие регистрации
  homeSkillsDir?: string;
  // Импорт командных skills проекта проверен для агента
  teamImport?: boolean;
  // Разбор командных skills в репо проекта (src/teamskills.ts): корневые каталоги агента (git ls-files), приоритет
  // места как источника импорта (меньше — раньше), нестандартные места агента с понятным названием, каталоги команд
  // (слэш-команды, не skills) — частью регулярного выражения
  teamScan?: { roots: string[]; priority?: Record<string, number>; nonstandard?: { id: string; rx: RegExp }[]; commands?: string };
  // Каталоги-коллекции в проекте, куда агент пишет skills или плагины (<каталог>/<имя>/…): exclude — каталогом,
  // командная коллекция — по ним
  collections?: string[];
  // Skills проекта — в основном каталоге, а при командной коллекции в нём — в запасном (Codex: .agents/skills →
  // .codex/skills): файлы основного при переходе --force не удаляет
  skillsFallback?: { from: string; to: string };
  // Пишется после остальных агентов: пропускает skills, уже доставленные ими в общие каталоги
  deliverLast?: boolean;
  // Таблица MCP-серверов в общем TOML-конфиге агента (merge format: toml, key: [mcpTable]; Codex: mcp_servers). Нужна и
  // без рендера: clean и проверка записанного (verifyMerges) знают таблицу по агенту
  mcpTable?: string;
  // Каталоги skills проекта (относительно цели), которые агент читает сам, кто бы их ни писал: skill, доставленный туда
  // другим агентом, этот агент не копирует к себе (opencode — каталоги skills Claude и Codex)
  sharedSkills?: string[];
  // Свой файл проекта узнаётся по содержимому без учёта (учёт забыт — clean --forget, диск вернулся)
  ownFile?(path: string, text: string): boolean;
  // Копия «до miksy» (miksy restore): что мастер когда-либо копировал (относительно ~) и что не возвращается
  // никогда — вход и рабочее состояние агента
  restore?: { everCopied: string[]; notRestored: string[] };
  // Перенести ручной сервер из домашнего конфига агента под учёт miksy при adopt --global (Codex: таблица TOML)
  adoptGlobal?(manifest: Manifest, machine: Machine, name: string, def: unknown, dryRun?: boolean): void;
  // Доверие проектам (src/trust.ts): у агента есть «доверенные проекты», и доверие загружает исполняемые настройки проекта
  trust?: TrustSpec;
  // Домашний файл агента, который miksy restore не возвращает целиком (в нём вход, список проектов), а дописывает в него
  // недостающее из копии «до миksy» (Claude: MCP-серверы в ~/.claude.json): план, запись и тексты вывода
  restoreHome?: RestoreHome;
}

// Запись, которую restore дописывает в домашний файл агента: project — запись проекта (её перенос ждёт clean --all, если
// в учёте есть проекты агента), liveKey — ключ проекта в нынешнем файле, newProject — проекта в нём нет
export type HomeItem = { project?: string; name: string; liveKey?: string; newProject?: boolean };
// add — недостающие (допишутся), same — уже на месте, clash — на месте другое с тем же именем (не трогается); problem —
// перенос не идёт, исправимо (код 1); warning — не идёт, исправлять нечего; data — что дописывать (адаптеру)
export type HomeMerge = { add: HomeItem[]; same: HomeItem[]; clash: HomeItem[]; problem?: string; warning?: string; data?: unknown };
export interface RestoreHome {
  file: string; // относительно ~ (и копии)
  plan(copyFile: string, liveFile: string): HomeMerge;
  apply(m: HomeMerge, liveFile: string, save: (path: string) => void): { added: HomeItem[]; error?: string };
  describe(m: HomeMerge, later: HomeItem[]): string[]; // раздел плана в выводе
  doneNote(m: HomeMerge): string; // дополнение к «Всё из копии уже на месте»
  added(items: HomeItem[]): string; // строка итога: что дописано
  failed(error: string): string; // строка итога: что не перенесено
}

// Учтённый файл исполняемых настроек: строки показа и данные отпечатка (null — исполняемого нет)
export type Inspected = { lines: string[]; data: unknown } | null;

// Доверие проектам агента. Ядро (src/trust.ts) решает, ставить ли доверие, спрашивает пользователя, помнит решения
// (local/trust.json) и отпечатки; адаптер говорит, где и как агент его хранит и что доверие выполнит без вопроса
export interface TrustSpec {
  // Файл доверия (относительно ~), формат, таблица записей проектов (ключ доверия — [table, <проект>, field]), поле
  // записи проекта и значение «доверяю»
  file: string;
  format: "json" | "toml";
  table: string;
  field: string;
  value: true | "trusted";
  // Значение поля, которое значит «вопрос ещё не задавался» (Claude: false — по умолчанию новой записи проекта): его
  // miksy меняет и при clean возвращает (previous). Другие значения пользователя — его решение, не меняются
  unasked?: false;
  // Ключи записи проекта в файле доверия: первый — канонический, остальные — те же каталоги в другом написании
  keys(dir: string, machine: Machine, existing: string[]): string[];
  // Файлы проекта, которые доверие загружает без вопроса (относительно цели). shared — без git считается командным
  // (целиком); personal — личный файл агента: в нём ответы пользователя в окне агента (dialog) и одобрения miksy
  // (approvals); read — строки показа и данные отпечатка (skip — убрать из документа своё)
  settings: { rel: string; read(file: string, rel: string, skip?: (doc: any) => any): Inspected; shared?: boolean; personal?: boolean }[];
  // Основание поставить доверие — только этот свой файл проекта (Codex: .codex/config.toml); без поля — любой файл
  // проекта или свои ключи проекта в домашнем конфиге агента (merge под projects)
  projectFile?: string;
  // Ответы пользователя в окне агента (Claude: «да, больше не спрашивать», одобрения серверов) в личном файле проекта:
  // strip — убрать их из документа; print — отпечаток ответов (own — свои одобрения miksy, не входят); title —
  // заголовок в вопросе. Агент с ними помнит, что доверие ставил miksy (отметки в учёте), и наследует доверие группы
  // на подкаталоги без git (groupSkip — каталог агента, который обход пропускает)
  dialog?: { file: string; strip(doc: any): any; print(dir: string, own: string[]): string; title: string; groupSkip: string };
  // Одобрение серверов командного файла (Claude: .mcp.json) в личном файле проекта: servers — серверы команды
  // (имена, строки показа, отпечаток); title — название решения; ask — вопрос; also — дополнение к вопросу о доверии;
  // advice — тексты справки (без доступа к файлу одобрений; проект не доверенный)
  approvals?: {
    file: string;
    source: string;
    // Ключи личного файла: одобренные серверы, отклонённые, «одобрить все» (Claude: enabledMcpjsonServers и т. п.)
    keys: { enabled: string; disabled: string; all: string };
    servers(dir: string, git: boolean): { names: string[]; lines: string[]; fingerprint: string } | null;
    title: string;
    ask: string;
    also: string;
    adviceRefused(where: string, why: string): string;
    adviceUntrusted(where: string, names: string[]): string;
  };
  // Справка, когда проект останется без доверия (Claude: headersHelper не выполнится — сервер получит 401)
  untrustedAdvice?(result: RenderResult): string | null;
}
