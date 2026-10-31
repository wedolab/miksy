# Codex — возможности и каналы

Codex — агент OpenAI. Режимы запуска, с которыми работает miksy: CLI (`codex`, а также
`codex app-server`) и Zed через ACP (codex-mcp-client). Все режимы читают `~/.codex/config.toml`,
`AGENTS.md` и проектный `.codex/config.toml`. IDE extension вживую не проверялся.

Проверено на codex-cli 0.160.0 (Windows 11) и 0.163.0 (macOS 26.6); Zed — codex-mcp-client
0.160.1 (Windows). В колонке «Проверено»: Win, mac — ОС; «док.» — только по документации.

Официальные источники OpenAI (2026-10-10):
[конфигурация и trust](https://learn.chatgpt.com/docs/config-file/config-basic),
[поиск AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md),
[skills](https://learn.chatgpt.com/docs/build-skills),
[MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
[справочник настроек](https://learn.chatgpt.com/docs/config-file/config-reference).

## Возможности и как их использует miksy

| Возможность | Механизм агента | Как использует miksy | Проверено |
|---|---|---|---|
| Глобальные правила | `$CODEX_HOME/AGENTS.md`; первый непустой из `AGENTS.override.md`, `AGENTS.md` (`~/.agents/AGENTS.md`, `~/AGENTS.md`, `instructions.md` — не читаются) | блок `<!-- miksy:begin … -->` в `~/.codex/AGENTS.md`; при непустом `AGENTS.override.md` не пишет (warning) | Win 0.160.0, mac 0.163.0, вживую (`test/codex-live.ts`): текст до, внутри и после блока в промпте, сами комментарии-маркеры тоже |
| Правила проекта | `AGENTS.md` от git-корня до cwd, по одному файлу на каталог (`AGENTS.override.md`, `AGENTS.md`, `project_doc_fallback_filenames`), лимит 32 KiB; `developer_instructions` в `.codex/config.toml` проекта — при доверии | `developer_instructions` в own-файле `.codex/config.toml`; командный `AGENTS.md` не трогает, `AGENTS.override.md` не создаёт | Win, mac, вживую (`test/codex-live.ts`): `developer_instructions` в контексте при trust точного пути, командный `AGENTS.md` загружается |
| Каталог без git (сессия в нём) | `AGENTS.md` только из cwd (без обхода вверх); `.codex/config.toml` каталога — только при trust точного пути | как для проекта | Win, mac, вживую |
| Наследование в каталогах-группах | нет: `developer_instructions`, MCP и `.agents/skills` — только из каталога сессии | полный набор в каждой цели (группе, вложенной группе, git-проекте); доверие групп ставит sync | Win 0.160.0, mac 0.163.0, вживую (`test/live/groups.ts`, 7/7): каждый маркер правил ровно один раз, MCP проекта на месте |
| Skills глобально | `~/.agents/skills/<name>/` | копия skill | док.; вживую не проверено |
| Skills проекта | `.agents/skills` и `.codex/skills` (`.claude/skills`, `.miksy/skills`, одиночные `.agents/<name>` — не читаются) | `.agents/skills/<name>/`; если её версионирует команда — `.codex/skills/<name>/`; обе командные — конфликт | Win, mac, вживую |
| Импорт командных skills | нативные каталоги — `.agents/skills`, `.codex/skills` | видимые нативно не копируются; из других каталогов — копия с patch нормализованного имени во frontmatter; файлы — из последнего коммита | Win 0.160.0, вживую (`test/codex-team-live.ts`): четыре командных skill видны ровно по одному разу; в ACP не проверялось |
| MCP глобально | `~/.codex/config.toml` → `[mcp_servers.<name>]` | управляемый TOML-блок (см. ниже) | Win, mac, вживую (`codex mcp list --json`, app-server) |
| MCP проекта | `[mcp_servers.<name>]` в `.codex/config.toml` проекта — только при доверии | own-файл `.codex/config.toml`; отслеживаемый git — не пишет (warning); чужой неотслеживаемый — конфликт | Win, mac, вживую; Zed — context7 из проектного конфига реально вызывался |
| stdio-сервер с секретом | `command`, `args`, `env` | `command = '<обёртка .cmd/.sh>'`, `args = []`, без `env` — глобально и в проекте; обёртка читает `local/secrets/<ИМЯ>` | Win 0.160.0 (окна нет), mac 0.163.0: спецсимволы, кириллица, составное значение; Zed — `.cmd` с bun и npx, окон нет |
| HTTP с секретом в заголовках | `http_headers_helper` — строка-команда (Windows — `%COMSPEC% /Q /D /C "…"` в консоли Codex; таймаут 10 с, вывод ≤ 64 КиБ, JSON-объект строк) | `url` + `http_headers_helper = '<helper>'` | Win, mac, вживую, глобально и в проекте; путь с `&`, `%`, `!`, `^`, `(`, кириллицей — вживую; Zed — в проектном конфиге |
| Секрет в URL | — | мост: stdio-обёртка `…-bridge`, пересылает запросы на HTTP | Win, mac, вживую |
| Доверие проекта | `[projects."<путь>"] trust_level = "trusted"` в `~/.codex/config.toml`; действует только точный путь (trust корня workspace или предка на вложенный проект не распространяется); `untrusted` — явный ответ пользователя | ядро ставит `trusted` там, где доставлен свой `.codex/config.toml`; при чужом или командном конфиге — только по решению (см. ниже) | Win 0.160.0, вживую (`test/codex-live.ts` → `test/live/r1.ts`, 21/21; `test/live/g1.ts`); mac 0.163.0 (19/19). Без trust или с `untrusted` проектные инструкции и MCP не загружаются |
| Доверие подкаталогов без git | нет наследования (0.163.0) | предупреждение `doctor` о подкаталогах групп — только для Claude | вживую |

## Куда пишет адаптер

| Что | Глобально | Проект |
|---|---|---|
| Правила | блок в `~/.codex/AGENTS.md` | `developer_instructions` в `.codex/config.toml` (own) |
| MCP | TOML-блок в `~/.codex/config.toml` | `[mcp_servers.<name>]` в том же `.codex/config.toml` (own) |
| Skills | `~/.agents/skills/<name>/` | `.agents/skills/<name>/`, при командной коллекции — `.codex/skills/<name>/` |
| Скрипты секретов | `local/run/codex/global/` | `local/run/codex/<цель>/` |

- Адаптер сам ничего не записывает: plan, бэкапы, учёт, sync/clean и `.git/info/exclude`
  (включая git worktree) делает ядро.
- Проектный `.codex/config.toml` начинается строкой «Сгенерировано miksy. Не править вручную —
  изменения вносить в конфигурацию miksy (слои).» Отслеживаемый git файл — warning, не
  пишется; сбой git при проверке — тоже warning, файл не пишется. Чужой неотслеживаемый — конфликт
  own, без `--force` сохраняется; командные файлы защищены и при `--force`.
- Пропущенный сервер (keep) остаётся в проектном файле по предыдущей версии из учёта; файл ради
  keep рендерится, только если он уже в учёте (первый sync не создаёт пустой файл).
- Своя ссылка `.codex → <физический каталог>`: exclude получает и физический путь.
- Личные skills, ранее записанные в `.agents/skills`, при переходе в `.codex/skills` удаляются
  только при совпадении хеша, с бэкапом.
- `patch` skill применяется по относительному пути, исходники не меняются; бинарный файл без
  patch пропускается с warning (проверено глобально и в проекте, включая вложенные ресурсы).
- MCP-файлы глобально и в проекте — 0600 на macOS/Linux; если отличаются только права — chmod
  без перезаписи.
- `agents.codex.raw` перекрывает нативные поля, `agents.codex: skip` исключает сервер с
  предупреждением. `node_repl` — служебный сервер приложения Codex, `doctor` его не показывает.
- Генерация рассчитана на стандартный `~/.codex`; произвольный `CODEX_HOME` не поддержан.

## Глобальный TOML-блок

В `~/.codex/config.toml` ядро ведёт блок `# >>> miksy (сгенерировано, не править)` …
`# <<< miksy` (новый — в конце файла; существующий обновляется на месте: Codex дописывает
`[projects.…]` после него). Внутри — только таблицы `mcp_servers.<name>` и их подтаблицы.
Модель, авторизация, trust, approvals и весь текст вне блока сохраняются побайтно.

- Неучтённое имя передаётся miksy через `adopt --global … --agent codex` с бэкапом; `--force`
  перехватывает только учтённые имена.
- Учёт хранит имена и хеши определений; форматирование, порядок ключей и удалённый пустой
  `args = []` правкой не считаются. Потеря маркеров после `codex mcp add` не теряет владение;
  изменённая таблица конфликтует отдельно от остальных. Вживую (Win 0.160.0): sync →
  `codex mcp add` → sync без конфликта, чужой сервер сохранился.
- Без учёта повторные/непарные маркеры и посторонние таблицы — конфликт. Текст после блока
  допустим, если не продолжает его последнюю таблицу. Маркеры внутри многострочной строки блоком
  не считаются.
- `clean` удаляет только учтённые таблицы. Служебный LF перед открывающим маркером принадлежит
  блоку.
- Файл проверяется `Bun.TOML.parse` до и после записи; изменение файла между plan и apply
  останавливает запись.
- `mcp_servers = {...}` вне блока требует ручной миграции: inline-таблицу нельзя расширить
  отдельными таблицами. Универсальный TOML merge не реализован.
- Bun 1.3.14 при чтении путает TOML escape `\t` и `\f`; генератор пишет `\u0009` и `\u000C`.

## Доверие и исполняемые настройки

- Доверие загружает проектный `.codex/config.toml` целиком (серверы, `notify`, остальные
  ключи). Конфиг не от miksy (командный или чужой неотслеживаемый; свой — записанный miksy и
  не правленый) — исполняемые настройки: доверие только при `trust: { codex: true }` в слое или
  после «да» пользователя (`miksy trust <проект>`, вопрос в конце ручного `sync`). `sync`
  показывает серверы, `notify` и список прочих ключей. Решение — в `local/trust.json` с
  отпечатком всего разобранного документа.
- Ключ проекта: на Windows — путь с обратными слэшами (существующее написание сохраняется,
  новое — в нижнем регистре), на macOS — канонический POSIX-путь.
- Доверие, поставленное miksy, снимается: `clean`; конфиг стал командным без решения
  пользователя; miksy больше ничего не доставляет Codex в проект; запрет. Чужое доверие и
  явное `untrusted` не меняются.
- `trust.codex: false` в `local/machine.yaml` окончателен — `trust: true` слоя его не перекрывает.
- Снятие доверия правит поле по разбору TOML: строка `trust_level` ищется вне строковых значений,
  итог сверяется, учёт снимается только после подтверждённой записи.
- Хуки и `.mcp.json` Claude на доверие Codex не влияют.
- Вживую (Win 0.160.0, `test/live/g1.ts`): командный `.codex/config.toml` без доверия не
  загружается; после `miksy trust --confirm` командный сервер `connected`; `clean` снимает
  доверие.

## Корень workspace — git-репо

Если корень workspace (например, `~/Projects`) — git-репо, группы лежат внутри него, и Codex собирает
`.codex/config.toml` доверенных каталогов и `.agents/skills` от этого корня до каталога сессии:
`developer_instructions` — ближний побеждает, MCP сливаются по имени, а **одноимённый skill
группы выше виден дважды** (вживую). `projects`, `sync --all` и `doctor` предупреждают;
лекарство — убрать `.git` из корня workspace.

## Секреты: детали

- Обёртка `.cmd` stdio-сервера начинает с `chcp 65001`: без него не-ASCII значение читается в
  кодовой странице консоли (вживую: без `chcp` — искажение, с ним — верно; macOS — верно).
- Helper заголовков работает в консоли Codex, поэтому `.cmd` без `chcp`, ASCII; при не-ASCII
  пути — `chcp 65001` на время чтения и возврат прежней страницы.
- `.cmd` → npx — вживую на Windows; на macOS не проверено (нет node).
- Нет файла секрета (stdio и helper) — сервер `failed`, остальные работают; текст скрипта не
  показывается («handshaking … connection closed»). Win, mac.
- После выхода серверы и мосты не остаются; значений секретов нет ни в одном записанном файле.
  Win, mac.

## Режимы запуска

- CLI спрашивает доверие при первом запуске; без него проектный конфиг не читается — miksy
  ставит доверие сам.
- Zed (ACP, 2026-10-10, проект без trust-записи): в режимах Full access и Read-only Codex
  цитирует `developer_instructions` проектного `.codex/config.toml` и вызывает MCP из его
  `[mcp_servers]`. Запроса доверия Zed не показывает — доверие для Zed не нужно.
- `codex app-server` в свежем `CODEX_HOME` сам запускает `git fetch` каталога плагинов
  (`.codex/.tmp/plugins-clone-*`) — это не процессы miksy.
- `@путь` в `AGENTS.md` Codex не раскрывает (в отличие от Claude).

## Ограничения чтения текущего состояния

`current` читает стандартные Markdown-файлы, `developer_instructions`, MCP и trust из TOML.
Проектный снимок — только каталог цели при trust точного пути; глобальный слой сравнивается
отдельно. CLI overrides, profiles, managed config, plugin MCP и trust вложенных cwd/worktree не
моделируются.

## Не поддерживается

- Адаптером: hooks, политики, subagents.
- Агентом: свой каталог skills — `[[skills.config]] path` новых skills не добавляет; плагины
  (`codex plugin marketplace add` принимает и Claude-формат) копируются в
  `$CODEX_HOME/plugins/cache`; `skills/extraRoots/set` — только API app-server на сессию.

## История проверок

- 2026-10-10 — CLI 0.160.0 и Zed на рабочих проектах: глобальный `AGENTS.md`, проектный конфиг,
  импорт командных skills (`test/codex-team-live.ts`).
- 2026-10-17…20 — песочница с временным `CODEX_HOME`/HOME, без модели: `codex debug
  prompt-input`, `codex mcp list`, `codex app-server` (`thread/start` + `mcpServerStatus/list`);
  `test/codex-live.ts`.
- 2026-10-24…25 — секреты без значений в конфигах и доверие: `bun test/live/r1.ts codex`;
  группы — `test/live/groups.ts`.
- 2026-10-27 — политика доверия и helper: `bun test/live/g1.ts trust|helper`.

Unit-тесты покрывают сериализацию, сохранение CRLF/комментариев/внешних ключей, sync/update/clean,
ручные правки, конфликты, конкурентное изменение файла, командные config/skills, git worktree,
skip/raw, trust и приоритет `AGENTS.override.md`.
