# Claude Code — возможности и каналы

Claude Code — агент Anthropic. Режимы запуска, с которыми работает miksy: CLI (`claude`,
интерактивно и `claude -p`) и Zed через ACP (agent-sdk). Все режимы читают одни и те же файлы
(`~/.claude.json`, `CLAUDE*.md`, `.claude/`).

Проверено на Claude Code 2.1.302–2.1.311 (Windows 11) и 2.1.301 (macOS 26.6); Zed — agent-sdk
2.1.303 (Windows). Источник по механизмам агента — документация code.claude.com (через Context7,
2026-10-09) и живые проверки. В колонке «Проверено»: Win, mac — ОС; «док.» — только по
документации.

## Возможности и как их использует miksy

| Возможность | Механизм агента | Как использует miksy | Проверено |
|---|---|---|---|
| Глобальные правила | `~/.claude/CLAUDE.md` (импорты `@путь`) | блок `<!-- miksy:begin … -->` … `<!-- miksy:end -->`; текст вне блока сохраняется | Win 2.1.302–2.1.304, mac 2.1.301, вживую (`test/claude-live.ts`): виден текст до, внутри и после блока; правка памяти моделью (Edit) дописывает в конец, блок цел |
| Правила проекта | `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules/*.md` из cwd и **всех родительских каталогов**; уровни складываются, приоритета нет | блок в `CLAUDE.local.md` (личный, не коммитится); если `CLAUDE.local.md` командный — own-файл `.claude/rules/miksy.md`; если и `.claude/rules` командный — правила не пишутся (warning) | Win, mac, вживую (`test/claude-live.ts`); `.claude/CLAUDE.md` родителя наследуется — вживую |
| Каталог без git (сессия в нём) | правила каталога и родителей; local MCP — только по точному пути (в подкаталоге нет) | как для проекта | Win, mac, вживую |
| Цель с вложенными проектами (не группа) | `CLAUDE.local.md` такой цели прочитали бы и вложенные проекты | `CLAUDE.local.md` не пишется (warning), записанный раньше удаляется при sync; MCP и skills пишутся — они вниз не наследуются | док. + тесты |
| Наследование в каталогах-группах | `CLAUDE.local.md` всех родителей склеиваются (группа без git → вложенная группа → git-проект); `.claude/skills` родителей — в каталоге без git все, в git-проекте только свои; одноимённый skill — один, ближний; MCP local scope — только точный путь | `inherits: { rules: true, skills: !git }`: цель ниже группы получает в `CLAUDE.local.md` только свой отрезок слоёв (заголовок называет слои отрезка); группа пишет `CLAUDE.local.md` и при вложенных проектах; MCP и skills — полным набором в каждой цели | Win 2.1.310, mac 2.1.301, вживую (`test/live/groups.ts`, 13/13): каждый маркер правил ровно один раз, MCP и skills без дублей |
| Skills глобально | `~/.claude/skills/<name>/` | копия skill | Win, mac, вживую (`test/claude-live.ts`) |
| Skills проекта | только `.claude/skills` (`.agents`, `.codex`, `.opencode`, `.miksy` — не читаются) | `<проект>/.claude/skills/<name>/` + `.git/info/exclude`; если `.claude/skills` версионирует команда — конфликт (личные и импортированные одинаково) | Win, mac, вживую |
| Импорт командных skills | нативный каталог — `.claude/skills` | включён: skills команды из каталогов, которые Claude не читает, копируются в `.claude/skills`; файлы — из последнего коммита | вживую для Claude не проверялся |
| MCP глобально | `~/.claude.json` → `mcpServers` (user scope) | слияние по именам серверов | Win, mac, вживую |
| MCP проекта | `~/.claude.json` → `projects.<путь>.mcpServers` (local scope); приоритет local > `.mcp.json` > user; одобрения не требует | канонический ключ (realpath) и все уже существующие варианты того же каталога (см. ниже) | CLI вживую 2026-10-09 (`claude mcp get` → `Scope: Local config`, `Connected`); Zed вживую 2026-10-10; Win, mac (`test/claude-live.ts`) |
| stdio-сервер с секретом | `command`, `args`, `env` | `{"type":"stdio","command":"<обёртка .cmd/.sh>","args":[]}`; обёртка читает `local/secrets/<ИМЯ>`, `env`/`args` в конфиге нет | Win 2.1.310 (`.cmd`, окна нет), mac 2.1.301 (sh, `exec`, родитель сервера — claude), user и local scope; значения со спецсимволами cmd, `"`, кириллицей, составная `Bearer …`; Zed — `.cmd` с bun и npx, окон нет |
| HTTP с секретом в заголовках | `headersHelper` — строка для shell (`shell: true`; Windows — `cmd /d /s /c "…"`), печатает JSON заголовков | `{"type":"http","url":…,"headersHelper":"<helper>"}`; helper печатает JSON всех заголовков сервера | Win 2.1.310, mac 2.1.301: user scope — без условий; local scope и `.mcp.json` — только при доверии проекта; путь с `&`, `%`, `!`, `^`, `(`, кириллицей, пробелом — вживую |
| Секрет в URL | — | мост: stdio-обёртка `…-bridge`, пересылает запросы на HTTP | Win, mac, вживую (Authorization и `key`) |
| Доверие проекта | `projects[путь].hasTrustDialogAccepted` в `~/.claude.json`; применяет все проектные настройки без вопроса (хуки, `permissions`, `env`, helper-ы, серверы `.mcp.json`); каталог без git ищет доверие вверх по родителям | ядро ставит `true` после успешной доставки; при исполняемых настройках команды — только по решению (см. ниже) | Win 2.1.310 (18/18), mac 2.1.301 (16/16): после sync `headersHelper` подключается без ручной записи доверия; Win 2.1.310 (`test/live/g1.ts`): без доверия helper не выполняется, после `miksy trust --confirm` — `connected` |
| Одобрение серверов `.mcp.json` | `enabledMcpjsonServers` в `.claude/settings.local.json`; действует только при доверии | одобряет серверы командного `.mcp.json` по решению (см. ниже) | Win 2.1.311, вживую (`claude mcp list`) |

## Куда пишет адаптер

| Что | Глобально (`~`) | Проект (локально, не коммитится) |
|---|---|---|
| Правила | блок в `~/.claude/CLAUDE.md` | блок в `CLAUDE.local.md`, иначе `.claude/rules/miksy.md` |
| MCP | `~/.claude.json` → `mcpServers` | `~/.claude.json` → `projects.<путь>.mcpServers` |
| Skills | `~/.claude/skills/<name>/` | `.claude/skills/<name>/` + `.git/info/exclude` |
| Скрипты секретов | `local/run/claude/global/` | `local/run/claude/<цель>/` |

- Шапка сгенерированного текста: «Сгенерировано miksy (слои: …). Не править вручную —
  изменения вносить в конфигурацию miksy (слои).»
- Скрипты секретов — `<сервер>-stdio-<хеш>`, `<сервер>-headers-<хеш>`, `<сервер>-bridge-<хеш>`
  (`.cmd` на Windows, `.sh` на macOS/Linux) в каталоге `local/` конфигурации miksy. Значений
  секретов в них нет — только имена и пути.
- `~/.claude.json` и скрипт skill с подставленным секретом закрываются от других пользователей
  (0600/0700 на macOS/Linux). Если отличаются только права — chmod без перезаписи и бэкапа.
- `agents.claude.raw` в описании сервера перекрывает нативные поля, `agents.claude: skip` —
  исключает сервер с предупреждением.

## Ключ проекта в `~/.claude.json`

Claude хранит путь проекта «как открыли»: на Windows встречаются `D:/work/x` и `D:\work\x`,
`d:/…`, другой регистр; на macOS — другой регистр; везде — путь через симлинк.

- Адаптер пишет MCP под канонический ключ (realpath каталога, создаётся) и под **все уже
  существующие** ключи того же каталога (сравнение после realpath, без учёта регистра на
  Windows/macOS; такие ключи необязательны). Доверие ставится так же.
- Ни одного ключа нет — warning «Claude ещё не открывал»: если откроете проект по другому пути,
  повторите sync.
- CLI и Zed пишут один и тот же ключ — local scope MCP общий (вживую 2026-10-10). Ключи с `\`
  встречались раньше, но не от текущих Zed/CLI.
- Битый `~/.claude.json`: sync — конфликт этого файла (остальные цели синхронизируются),
  `doctor` и сравнение считают файл пустым.

## Доверие и исполняемые настройки

- Новую запись проекта Claude создаёт с `hasTrustDialogAccepted: false` (вопрос ещё не
  задавался; в Zed не задаётся), отказ не сохраняет («нет» — просто выход). Поэтому `false`
  заменяется на `true`, прежнее значение хранится в учёте, `clean` его возвращает. Чужое `true`
  не меняется; `clean` снимает только своё поле.
- Исполняемые настройки, которые ищет ядро (`executableSettings`, `src/trust.ts`):
  `.claude/settings.json` и `.claude/settings.local.json` — `hooks`, `permissions`, `env`,
  `apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`, `otelHeadersHelper`, `statusLine`,
  `fileSuggestion`, `enableAllProjectMcpServers`, `enabledMcpjsonServers`; `.mcp.json` с
  серверами.
  - git-проект: закоммиченные (в том числе за ссылкой каталога `.claude`) и неотслеживаемые,
    кроме своих по учёту: одобрений miksy и — в проекте, которому доверие поставил miksy, —
    ответов из диалогов Claude в `settings.local.json` (`permissions.allow/ask/deny/
    additionalDirectories`, `enabled/disabledMcpjsonServers`, `enableAllProjectMcpServers`);
  - каталог без git — `settings.json` и `.mcp.json` на диске.
- Есть такие настройки — доверие только при `trust: { claude: true }` в слое или после «да»
  пользователя (`miksy trust <проект>`, вопрос в конце ручного `sync`). Решение — в
  `local/trust.json` с отпечатком полного содержимого: команда изменила настройки — вопрос
  задаётся заново, поставленное доверие снимается до нового решения.
- `trust.claude: false` в `local/machine.yaml` окончателен; `false` в `layer.yaml` слоя дерева
  тоже запрещает. Запрет снимает доверие, поставленное miksy.
- Доверие группы Claude распространяет на её подкаталоги без своего git (проверено на
  2.1.310). `doctor` ищет в них исполняемые настройки и предупреждает. Для `headersHelper`
  Claude проверяет точный путь — там наследования нет.
- Предупреждение «headersHelper не выполнится» ядро выдаёт, только если доверия после sync не
  будет.

## Одобрение серверов командного `.mcp.json`

Поведение Claude 2.1.311 (Windows, временный HOME, статус — `claude mcp list` в проекте):

| Где одобрение | Доверие | Статус сервера |
|---|---|---|
| нигде | есть | Pending approval |
| `~/.claude.json` → `projects[путь].enabledMcpjsonServers` | есть | Connected; при первом запуске Claude переносит поле в `.claude/settings.local.json` и удаляет из `~/.claude.json` |
| `.claude/settings.local.json` → `enabledMcpjsonServers` | есть | Connected |
| то же | нет | Pending approval |
| то же, каталог без git | есть | Connected |

- По коду 2.1.311: `disabledMcpjsonServers` проверяется первым; одобрение из
  `settings.local.json` не читается, если файл отслеживается git; `enableAllProjectMcpServers`
  одобряет всё.
- miksy (действие `approve`) пишет одобрение в `.claude/settings.local.json` при
  `trust: { claude: true }` в слое или «да» пользователя (доверию Claude проекта с этими
  серверами или отдельному вопросу «серверы .mcp.json (Claude)», если доверие поставлено не
  miksy). Учёт — `TargetState.approvals`, снимается только своё; отклонённые и одобренные
  пользователем не трогаются; файл скрыт `.git/info/exclude`, пока в нём одобрения miksy.
  Отслеживаемый `settings.local.json` — не пишется, совет одобрить через `/mcp`.

## Группы: ограничения

- `exclude` правила (и skill в цели без git) из слоя выше группы не действует: файл группы Claude
  читает сам — `sync` предупреждает.
- Группа выше не получила правила (не синхронизирована, конфликт, файлы правил версионирует
  команда) — её отрезок пишется в цель ниже с предупреждением.

## Секреты: детали

- Обёртка `.cmd` начинает с `chcp 65001`: без него не-ASCII значение через `set /p` читается в
  кодовой странице консоли (вживую: без `chcp` — искажение, с ним — верно; macOS — верно).
- `.cmd` → `npx`-сервер — вживую на Windows; на macOS не проверено (на стенде нет node).
- Нет файла секрета — сервер `failed`, сессия идёт; текст скрипта в UI не виден («Connection
  closed»). Win, mac.
- После выхода claude серверы и мосты не остаются (сирот cmd → bun нет). Win, mac.
- Значений секретов нет ни в одном записанном файле (дом, проект, `local/`). Win, mac.
- Секрет в `command` не поддерживается; значение HTTP-заголовка — только ASCII.

## Режимы запуска

- CLI: `CLAUDE.local.md` загружается в контекст; запись в `~/.claude.json` при открытой сессии
  Claude в том же проекте не потерялась (вживую 2026-10-09).
- Zed (ACP): `CLAUDE.local.md` загружается (2026-10-10); stdio-обёртки работают без окон
  (консоль сервера скрыта). `headersHelper` в `.mcp.json` недоверенного проекта не работает —
  нет доверия; Zed вопрос о доверии не показывает, поэтому доверие ставит miksy.
- `claude -p` выполняет хуки проекта (SessionStart) **без доверия** и запускает серверы
  `.mcp.json` **без одобрения**: защита miksy действует для интерактивных сессий, Zed и
  `headersHelper`.

## Наблюдения

- `.mcp.json` **выше** корня проекта Claude подхватывает (документация описывает только корень),
  но без одобрения в этом проекте серверы висят в Pending approval.
- Одноимённый сервер в local scope перекрывает `.mcp.json`; Claude предупреждает «defined in
  multiple scopes».
- Открытые сессии Claude Code могут перезаписать `~/.claude.json` своей копией (удалённая запись
  возвращалась). Как безопасно сливать — не проверено.
- stdio-серверы подключаются пачками по 3 (`MCP_SERVER_CONNECTION_BATCH_SIZE`): в `claude -p`
  4-й сервер в init-событии бывает `pending`.
- Первый запуск npx-сервера может не уложиться в 30 с (скачивание пакета); при повторе
  подключается.
- Перед `initialize` Claude 2.1.310 шлёт `server/discover` (на -32601 продолжает); debug-лог —
  `~/.claude/debug/*.txt` (`--debug`).
- В песочнице внутри домашнего каталога Claude загружает настоящий `~/.claude/CLAUDE.md` как
  память «Project» родительского каталога (поиск идёт до корня диска).
- Удалённый GitHub MCP (`api.githubcopilot.com`) с PAT отвечал 403 — используется локальный
  `github-mcp-server`.

## Не поддерживается

- Адаптером: hooks, права (permissions), subagents, commands, output styles.
- Агентом: свой каталог skills — только плагин (`--plugin-dir` или marketplace +
  `claude plugin install`: копия в `~/.claude/plugins/cache`, имена `miksy:<skill>`;
  `enabledPlugins` без install не грузится).
- Не проверено: добавление в память через `#` (в `-p` это обычный запрос, TUI не проверялся).

## История проверок

- 2026-10-09…10 — CLI и Zed на рабочем проекте: local scope MCP, `CLAUDE.local.md`, ключи проекта.
- 2026-10-17…20 — песочница с временным HOME и заглушками MCP (`test/live/stub.mjs`,
  `stub-http.ts`): правила, MCP, skills, обёртки, Zed; `test/claude-live.ts`.
- 2026-10-24…25 — секреты без значений в конфигах и доверие: `bun test/live/r1.ts claude`
  (также в конце `test/claude-live.ts`); группы — `test/live/groups.ts`.
- 2026-10-27 — политика доверия и `headersHelper`: `bun test/live/g1.ts trust|helper`;
  одобрение `.mcp.json` — `claude mcp list` (сценарий miksy — `test/live/g2.ts approve`).

MCP и skills проверяются по init-событию `claude -p --output-format stream-json` (печатается до
обращения к модели, вход не нужен); правила — `claude -p /context` или один запрос haiku с
токеном в `CLAUDE_CODE_OAUTH_TOKEN`.
