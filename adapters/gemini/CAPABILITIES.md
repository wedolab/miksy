# Gemini (Antigravity) — возможности и каналы

Antigravity — агент Google в двух режимах: CLI `agy` и графический клиент (Antigravity IDE —
форк VS Code, и Antigravity 2.0). Оба читают общие правила и skills из `~/.gemini/`, а
настройки MCP и состояние хранят раздельно. Адаптер `gemini` пишет в оба режима.

Проверено на версиях:

- `agy` 1.3.3, 1.4.2, 1.4.3–1.4.7 — Windows 11; `agy` 1.4.0, 1.4.2, 1.4.7 — macOS 26.6;
- Antigravity IDE и Antigravity 2.0 — Windows.

Источники: документация `https://antigravity.google/docs` (customizations, rules, skills,
MCP, plugins), встроенные руководства CLI
`~/.gemini/antigravity-cli/builtin/skills/agy-customizations/`, разбор бинарника `agy.exe` и
бандла `jetskiAgent/main.js` IDE, живые проверки (см. «История проверок»).

## Возможности и как их использует miksy

«Вживую» — запуск агента в изолированном HOME (модельные пункты — `agy -p`); «документация»
и «разбор» — без запуска.

| Возможность | Механизм агента (файл/ключ) | Как использует miksy | Проверено |
|---|---|---|---|
| Глобальные правила | `~/.gemini/GEMINI.md` — always-on, общий для CLI и IDE (`globalMemoriesPathSegments` в IDE) | Управляемый блок `<!-- miksy:begin … -->`; текст до и после блока (в том числе память агента) сохраняется | Вживую: agy 1.4.2 Windows — маркеры до/внутри/после блока, «запомни» дописывает в конец файла, блок цел |
| Правила проекта | `AGENTS.md`, `GEMINI.md` в корне; `rules/` плагина | Own-файл `.agents/plugins/miksy/rules/AGENTS.md`; командный `AGENTS.md` не трогается, агент читает оба | Вживую: agy 1.3.3 и 1.4.2 Windows; агент соблюдает правила обоих файлов |
| Плагин проекта | `.agents/plugins/<имя>/` с `plugin.json`; обнаруживается автоматически, включён по умолчанию | Свой плагин `.agents/plugins/miksy/` (`plugin.json` = `{"name":"miksy"}`), создаётся, если есть правила, skills или MCP | Вживую: agy (Windows), IDE и 2.0 (Windows); macOS — в изолированном HOME без входа плагин не загружается |
| Skills глобально | `~/.gemini/config/skills/<имя>/SKILL.md` (единственный рабочий путь) | Own-файлы там же | Вживую: agy 1.4.2 Windows |
| Skills проекта | `.agents/skills/<имя>/` (командные), `skills/` плагина | Own-файлы `.agents/plugins/miksy/skills/<имя>/`; агент активирует skill по запросу | Вживую: agy 1.3.3 Windows |
| Импорт командных skills | Агент видит только `.agents/skills` | Skills команды из других каталогов (`.claude/skills` и т. п.) копируются в `skills/` плагина (`import_skills`) | По коду; читатель `.agents/skills` — вживую |
| MCP глобально, CLI | `~/.gemini/config/mcp_config.json` → `mcpServers` (сюда пишет `agy mcp add`); также `~/.gemini/antigravity-cli/mcp_config.json` | Merge по именам в `~/.gemini/config/mcp_config.json` | Вживую: agy 1.4.2 Windows, macOS |
| MCP глобально, IDE | `~/.gemini/antigravity-ide/mcp_config.json` → `mcpServers` | Merge по именам в этот же файл (одновременно с CLI) | Разбор бандла IDE |
| MCP проекта | `mcp_config.json` плагина; также `.agents/mcp_config.json` | Own-файл `.agents/plugins/miksy/mcp_config.json` | Вживую: agy (Windows), IDE и 2.0 (Windows), вызов инструмента моделью |
| Формат сервера | stdio: `command`, `args`, `env`; HTTP (Streamable): `url`, `headers`; `disabled` | Пишет эти поля; `agents.gemini` слоя может дополнить или выключить (`skip`) | Вживую: `agy mcp list` |
| stdio с секретом | Подстановок в `env`/`headers` нет (`${V}`, `$V`, `%V%`, `{env:V}`, `{file:…}` — литерал) | `command` — обёртка `local/run/gemini/<цель>/<сервер>-stdio-<хеш>.cmd\|.sh`, `args: []` | Вживую: agy 1.4.3–1.4.7 Windows, 1.4.2 macOS; IDE Windows |
| HTTP с секретом | То же | Мост: `command` — обёртка `<сервер>-bridge-<хеш>.cmd\|.sh` (stdio-сервер, пересылающий на HTTP) | Вживую: agy 1.4.3–1.4.7 Windows, 1.4.2 и 1.4.7 macOS (`tools/list`); вызов инструмента — Windows; IDE Windows |
| Каталоги-группы | Без git `AGENTS.md` и плагин читаются только из каталога сессии, вниз не наследуются | Группа получает свой плагин с полным набором слоёв до своего уровня, разности нет | Чтение — вживую agy 1.4.2 Windows; поведение группы заново не проверялось |
| Реестр проектов | `~/.gemini/projects.json` | Источник `knownDirs` для `sync --all` | По коду |

## Куда пишет адаптер

| Что | Глобально (`~`) | Проект (не коммитится) |
|---|---|---|
| Манифест плагина | — | `.agents/plugins/miksy/plugin.json` (own) |
| Правила | блок в `~/.gemini/GEMINI.md` | `.agents/plugins/miksy/rules/AGENTS.md` (own) |
| Skills | `~/.gemini/config/skills/<имя>/` (own) | `.agents/plugins/miksy/skills/<имя>/` (own) |
| MCP | `~/.gemini/config/mcp_config.json` и `~/.gemini/antigravity-ide/mcp_config.json` (merge `mcpServers`) | `.agents/plugins/miksy/mcp_config.json` (own) |
| Обёртки секретов | `local/run/gemini/global/` | `local/run/gemini/<проект>-<хеш>/` |

- Шапка сгенерированных файлов: «Сгенерировано miksy (слои: …). Не править вручную —
  изменения вносить в конфигурацию miksy (слои).»
- Плагин скрывается от git одной строкой `/.agents/plugins/miksy/` в `.git/info/exclude`.
  Если внутри лежит чужой файл с конфликтом (например, свой `rules/AGENTS.md`) — точными
  строками файлов miksy.
- Ручная правка внутри блока `GEMINI.md` — конфликт; `--force` заменяет только блок, `clean`
  удаляет только блок.
- Файлы плагина, закоммиченные командой, и каталог `.agents/plugins`, который версионирует
  команда, — конфликт: личный файл не кладётся среди командных. Личные и импортированные skills
  в такие коллекции тоже не доставляются; метка `team` защиту не обходит.
- Глобальные `mcp_config.json` сливаются только как строгий JSON. Пустой файл (0 байт — так его
  заводит Antigravity) считается `{}`; JSONC с комментариями — предупреждение, серверы не
  записываются. Пользовательские поля и токены OAuth не затрагиваются.
- Пропущенный сервер (нет переменной) остаётся в `mcp_config.json` плагина как был (keep), старая
  версия сверяется по хешу. Ради keep плагин рендерится, только если его `mcp_config.json` уже в
  учёте: на первом sync пропущенный сервер пустой плагин не создаёт.
- MCP-файлы дома и проекта получают права 0600 на macOS/Linux. Запись через отслеживаемую
  командой ссылку запрещена.

## CLI и IDE

| | CLI (`agy`) | IDE и Antigravity 2.0 |
|---|---|---|
| Состояние | `~/.gemini/antigravity-cli/` (`settings.json`, `history.jsonl`, `conversations/`, `brain/`, `log/`) | `~/.gemini/antigravity-ide/` (`user_settings.pb`, `antigravity_state.pbtxt`, `conversations/`, `brain/`) |
| Глобальный MCP | `~/.gemini/config/mcp_config.json`, `~/.gemini/antigravity-cli/mcp_config.json`; `antigravity-ide/` и `~/.gemini/antigravity/` не читает | `~/.gemini/antigravity-ide/mcp_config.json` |
| Общее | `~/.gemini/GEMINI.md`, `~/.gemini/config/skills/`, `~/.gemini/projects.json` | то же |
| MCP плагина | работает | работает; серверы — потомки `language_server_windows_x64.exe`, окон консоли нет |

## Поведение MCP

- Серверы плагина агент видит с префиксом `<плагин>_<сервер>`: `context7` из плагина
  `miksy` — `miksy_context7`. Имена инструментов не меняются; модель вызывает их через
  `call_mcp_tool(ServerName=…, ToolName=…)`.
- Серверы стартуют асинхронно. Первый промпт сессии может уйти без секции `mcp_servers` (в логе
  `~/.gemini/antigravity-cli/log/cli-*.log` — `empty component: prompt section "mcp_servers"`);
  инструменты доступны со второго сообщения. В IDE агент иногда долго ищет способ вызова.
- `agy plugin list` показывает только плагины из `~/.gemini/config/plugins/`; для проектного
  «No imported plugins» — штатно. Проверка проектного: `agy plugin validate .agents/plugins/miksy`.
- Нет файла секрета у обёртки — сервер не стартует, сессия продолжается.
- Legacy HTTP+SSE (протокол 2024-11-05) не поддерживается — нужен Streamable HTTP endpoint
  (документация).
- Удалённый OAuth-сервер в проверке не поднялся — вероятно, нужна авторизация в Antigravity.

## Мост для HTTP с секретом

Antigravity не подставляет в `mcp_config.json` ничего, поэтому любой HTTP-сервер с секретом
(в заголовках или URL) идёт через мост `src/bridge.ts`. Токена нет ни в проекте, ни дома;
OAuth не нужен.

- Обёртка запускает `bun --no-env-file --config=<движок>/src/bridge.bunfig.toml
  <движок>/src/bridge.ts …` из `local/secrets`. Bun — по пути без каталога версии: обновление
  Bun обёртки не ломает. `.env` и `bunfig.toml` каталога сессии в процесс не попадают.
- Сбрасываются `HTTP(S)_PROXY`, `ALL_PROXY`, `NO_PROXY` (оба регистра),
  `NODE_TLS_REJECT_UNAUTHORIZED`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`,
  `BUN_OPTIONS`, `BUN_CONFIG_VERBOSE_FETCH`, `NODE_OPTIONS` — если не заданы в `env` сервера.
  Из `env` HTTP-сервера мосту передаются только они; другой ключ с секретом — пропуск сервера,
  без секрета — предупреждение.
- Мост читает файлы секретов сам: длинные значения (1500 байт, JWT) и значения с `"`/`\`
  доставляются и на Windows. Секрет в `env` моста (прокси) идёт через `.cmd`: на Windows — до
  1023 байт.
- Редиректы не выполняются (3xx — ошибка JSON-RPC): заголовок с секретом не уходит на адрес из
  `Location`.
- Значения секретов не попадают в stdout/stderr: маскируются как есть, в JSON- и URL-форме;
  `id`, `jsonrpc`, `method` не меняются; значение короче 4 символов — только целой строкой.
- Ответ на каждый запрос с id; 404 на запрос с сессией — один повторный `initialize` на истёкшую
  сессию и повтор запроса (неудача повторяется не чаще раза в 5 с); 202/204 на запрос, битый или
  оборванный поток — ошибка. Таймаут
  ответа — 600 с (`--timeout`). После EOF stdin — до 5 с, затем отмена и `DELETE` сессии.
- Ограничение: отдельный GET-поток мост не открывает — уведомления и запросы сервера вне ответа
  на POST (`notifications/tools/list_changed`, sampling) до агента не доходят.
- Память на мост (приватная, после 50 вызовов): Windows — 35,6 → 37,4 МБ (+ cmd.exe 3 МБ;
  пустой Bun — 29,4 МБ); macOS — 7,3 → 7,8 МБ (пустой Bun — 3,9 МБ). `bun --smol` не меняет.

## Не поддерживается

- `.gemini/skills`, `~/.gemini/skills`, `~/.agents/skills`, `antigravity-cli/skills`,
  `antigravity/skills` — агент их не читает.
- `.gemini/mcp_config.json` в проекте — не читается.
- `.agents/rules/*.md` без frontmatter — не подхватились (не разбиралось).
- Отдельного инструмента памяти (`save_memory`) нет: «запомни» — правка `GEMINI.md` моделью; в
  `-p` нужен `--dangerously-skip-permissions`.
- Открытые вопросы: hooks (`hooks.json` в плагине), политики и allowlist инструментов в
  `settings.json`.

## История проверок

- Первая проверка, `agy` 1.3.3 (Windows): плагин проекта, правила, skills, вызов Context7
  моделью из `mcp_config.json` плагина без глобальной установки. Вывод по разбору сборки IDE
  от 13.08.2026 («MCP плагина не запускается») позже не подтвердился.
- 2026-10-10: sync реального проекта — MCP из нескольких слоёв в CLI и Antigravity 2.0
  (сервер из слоя проекта виден только в нём).
- 2026-10-17…20: agy 1.4.2 Windows, 1.4.0 macOS, IDE и 2.0 Windows — пути чтения, подстановки,
  обёртки, маркеры блока; на Windows для модели нужен VPN («User location is not supported»).
- 2026-10-24: секреты без значений в конфигах — `bun test/live/r1.ts gemini`, IDE —
  `test/live/gui-antigravity.ts prep|report`, память моста — `test/live/bridge-memory.ts`.
- Отказы моста — `bun test/live/g1.ts bridge` (agy 1.4.7, Windows и macOS, 15/15);
  длинные значения и кавычки — `bun test/live/g2.ts wrappers` (Windows).
- Базовая проверка адаптера — `bun test/gemini-live.ts` (все вызовы `agy` с временным HOME).
