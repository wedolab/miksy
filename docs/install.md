# Установка: подробно

Как поставить агентов, что спрашивает мастер установки и как пройти установку командами по шагам — если мастер не
подходит (нестандартная машина, хочется сделать всё по отдельности). Обычная установка — в README.

← [README](../README.md)

Слова: **workspace** — папка с вашими проектами (например, `~/Projects`); **конфигурация** — ваш каталог настроек
`miksy-config`, в нём слои (папки с правилами, MCP-серверами и skills) и `local/` — то, что только для этой машины.
Подробнее — «[Как устроен miksy](../README.md#как-устроен-miksy)».

## Вопросы мастера по порядку

Мастер — `miksy setup`, его запускает установщик. Любой вопрос, кроме первого, можно пропустить; повторный
`miksy setup` продолжит с несделанного. Где вопрос только создаёт своё (2, 3, 5), Enter значит «да» (`[Y/n]`); где
что-то меняется у агентов (4, 6, 9 и «сделать конфигурацию git-репо» в 1) — «нет» (`[y/N]`).

1. **Конфигурация** — цифрой (Enter — отмена). «1» — своя из git: дайте адрес, мастер скачает её рядом с движком.
   «2» — новая из примера, затем «Сделать конфигурацию git-репо…» — ответьте «y»: без git её не перенести на другую
   машину (удалённый репо заведите сами — мастер подскажет). В примере: общие правила для агентов, MCP-сервер context7
   (документация библиотек) и skill `miksy`.
2. **Workspace и агенты** — папка с проектами (Enter — предложенная; путь можно вставить в кавычках, как копирует
   Проводник), по желанию — ещё папки («[Несколько корней workspace](roots.md#несколько-корней-workspace)»). Агентов
   мастер не ставит, только говорит, каких нет. При повторном запуске «Добавить … новых агентов» называет и тех, кого
   вы убрали из `agents` сами, — тогда «n», а нового допишите в `agents` в `local/machine.yaml` руками.
3. **Копия настроек агентов** — один раз, до первой записи: в `local/backups/before-miksy-<метка>/`.
4. **Программы для MCP-серверов** (`npx`, `uvx`, `docker`…) — покажет команду и выполнит после «y».
5. **Команда `miksy`** — `~/.bun/bin/miksy` (на Windows — `miksy.cmd` там же); если надо, добавит каталог в PATH:
   строкой в `~/.zshrc` (zsh), `~/.bash_profile` (bash на macOS) или `~/.bashrc` (bash на Linux), на Windows — в
   PATH пользователя. Действует в новых окнах терминала.
6. **Ручные настройки агентов** — MCP-серверы и skills проектов, которые вы добавляли сами: по каждому спросит, куда
   перенести (цифрой: глобально, все проекты, организация или проект, где найден; «0» — оставить у агента, «s» —
   пропустить остальные). Покажет, где первая запись столкнётся с вашими файлами. Свои правила и домашние skills
   агентов мастер не переносит — как перенести, «Свои правила» в [README, «Установка»](../README.md#установка); лучше до вопроса 9.
7. **Секреты** — каких токенов не хватает и куда вписать (`local/secrets.env` в конфигурации; путь мастер печатает).
   Заполните файл и нажмите Enter или «s» — позже (сервер без секрета `sync` пропустит с сообщением). Значения мастер
   не спрашивает и не показывает.
8. **План** — что будет создано и обновлено (`v` — полный план).
9. **Запись** — «Записать настройки агентам сейчас? [y/N]»: для записи «y». О доверии проектам с хуками или своими
   MCP-серверами спросит по каждому («[Доверие проектам](trust.md)»).
10. **Проверка** — итог `miksy doctor` и вопрос, который задать агенту после перезапуска.

## Без вопросов: скрипты, CI, агенты

`miksy setup --yes` — только безопасные шаги, кроме копии настроек агентов и PATH: конфигурация из примера, `local/`,
`local/machine.yaml`, команда `miksy`; чего не хватает (программы, секреты, каталог в PATH) — напишет. `--yes
--backup` — ещё и копия настроек агентов. `setup --force` спрашивает workspace и агентов заново (прежние ответы — по
умолчанию).

## Установка агентов

miksy агентов не ставит. Команды — из официальной документации (проверено 2026-10-28); где способов два, первый —
официальный установщик.

| Агент | Windows | macOS | Linux | Вход после установки |
|---|---|---|---|---|
| [Claude Code](https://code.claude.com/docs/en/setup) | `irm https://claude.ai/install.ps1 \| iex` или `winget install Anthropic.ClaudeCode` | `curl -fsSL https://claude.ai/install.sh \| bash` или `brew install --cask claude-code` | `curl -fsSL https://claude.ai/install.sh \| bash` | запустите `claude` и войдите в браузере |
| [Codex](https://github.com/openai/codex) | `powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 \| iex"` | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` или `brew install --cask codex` | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` или `npm install -g @openai/codex` | `codex login` (или `codex` → Sign in with ChatGPT) |
| [opencode](https://opencode.ai/v2/docs/) (v2) | файл с [opencode.ai/download](https://opencode.ai/download) | `curl -fsSL https://opencode.ai/v2/install \| bash` или `brew install opencode` | `curl -fsSL https://opencode.ai/v2/install \| bash` или `npm install -g @opencode/cli` | `opencode auth login` (или `/connect` в opencode) |
| [Antigravity](https://antigravity.google/docs/getting-started) (CLI `agy`) | `irm https://antigravity.google/cli/install.ps1 \| iex` | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` | запустите `agy` — вход в Google в браузере |

IDE Antigravity — [antigravity.google/download](https://antigravity.google/download). Поставили агента после
miksy — запустите `miksy setup` ещё раз: он предложит добавить агента.

## Установка вручную

Те же шаги, что у мастера, но командами. Ставили мастером — раздел не нужен.

**1. Поставьте git, Bun (1.3.14 или новее) и агентов** ([выше](#установка-агентов)).

| ОС | Bun | Или менеджером пакетов |
|---|---|---|
| Windows | `powershell -c "irm bun.sh/install.ps1 \| iex"` | `scoop install bun` |
| macOS | `curl -fsSL https://bun.sh/install \| bash` | `brew install oven-sh/bun/bun` |
| Linux | `curl -fsSL https://bun.sh/install \| bash` | — |

Откройте новое окно терминала, чтобы команда `bun` нашлась.

**2. Скачайте miksy** в папку с проектами:

```
mkdir -p ~/Projects && cd ~/Projects                                     # macOS, Linux
mkdir -Force $HOME/Projects; Set-Location $HOME/Projects                 # Windows (PowerShell)
git clone -b stable https://github.com/wedolab/miksy.git miksy
```

Нужна конфигурация с другой вашей машины — скачайте её рядом: `git clone <адрес вашего репо конфигурации>
miksy-config`, а папки разложите так же, как там («[Вторая машина](../README.md#вторая-машина)»). Новая — пропустите,
`setup` создаст её из примера.

**3. Сохраните нынешние настройки агентов** — чтобы вернуть всё как было даже без miksy:

```
tar czf ~/agents-before-miksy.tgz -C ~ \
  .claude.json .claude/CLAUDE.md .claude/settings.json .claude/skills \
  .codex/config.toml .codex/AGENTS.md .codex/AGENTS.override.md .agents/skills \
  .config/opencode .gemini/GEMINI.md .gemini/config \
  .gemini/antigravity-ide/mcp_config.json .gemini/antigravity-cli/mcp_config.json
```

Windows (PowerShell; `tar` есть в Windows 10 и новее):

```
tar czf "$HOME/agents-before-miksy.tgz" -C $HOME .claude.json .claude/CLAUDE.md .claude/settings.json .claude/skills .codex/config.toml .codex/AGENTS.md .codex/AGENTS.override.md .agents/skills .config/opencode .gemini/GEMINI.md .gemini/config .gemini/antigravity-ide/mcp_config.json .gemini/antigravity-cli/mcp_config.json
```

Каких-то файлов нет — tar об этом напишет, но архив создаст.

**4. Настройте машину без вопросов:**

```
cd ~/Projects/miksy
bun src/cli.ts setup --yes
```

Появятся конфигурация из примера (если её нет; по умолчанию — `miksy-config` рядом с движком), `local/machine.yaml`
(workspace — папка движка или выше: `~/Projects/miksy` → `~/Projects`; агенты — те, что нашлись) и команда `miksy`.
Workspace, агентов и пути к программам можно поправить в `local/machine.yaml`; секреты — в `local/secrets.env`
(переносите их через менеджер паролей, не через git или чат). Команда `miksy` не находится — добавьте `~/.bun/bin` в
PATH (Windows: Пуск → «Изменение переменных среды текущего пользователя» → Path → «Создать» →
`%USERPROFILE%\.bun\bin`) и откройте новое окно терминала.

**5. Посмотрите, что у агентов настроено руками:** `miksy doctor`.

- «Добавлено агентами в обход слоёв» — MCP-серверы и skills проектов, добавленные вами. Нужные перенесите:
  `miksy adopt --global <имя> --to global` (из проекта — `miksy adopt <проект> <имя> --to …`). Домашние skills
  агентов (в «Справочно») `adopt` не берёт — скопируйте их папки в `layers/global/skills/` сами. Остальное miksy не
  удалит.
- «Конфликты первого sync» — ваши файлы там, куда miksy хочет писать (например, свой skill с тем же именем).
  Перенесите нужное из них в конфигурацию.

Что получит агент — `miksy explain --global` и `miksy explain ~/Projects/Acme/app`.

**6. Проверьте план, ничего не записывая:**

```
miksy sync --global --dry-run
miksy sync --all --dry-run
```

Сами файлы — `miksy sync --global --out ~/miksy-preview`: miksy сложит их в отдельную папку и покажет разницу с
нынешними настройками. Повторяйте шаги 5–6, пока план не устроит.

**7. Запишите настройки:**

```
miksy sync --global
miksy sync --all
```

Первая — домашние настройки агентов (действуют во всех каталогах), вторая — настройки каждого проекта. Проектов
много — сначала покажет список и спросит подтверждение. В конце может спросить о доверии проектам, где команда
настроила хуки или свои MCP-серверы («[Доверие проектам](trust.md)»). Остались конфликты «файл существует и создан не
miksy», а нужное из файлов уже в конфигурации — повторите с `--force`: miksy заменит файл, оригинал сохранит.

**8. Проверьте:** `miksy doctor` пишет «Всё синхронизировано»; перезапустите сессии агентов; откройте проект и
спросите агента: «Процитируй первую строку раздела „## MCP“ в твоих инструкциях и вызови context7 для „bun“» (раздел —
из стартовой конфигурации, `layers/tree/instructions/`). Ответ «MCP-серверы подключает miksy по слоям…» и найденная
библиотека — всё работает.

**9. Вернуть всё как было** — «[Как удалить miksy](uninstall.md)», затем копия из шага 3:
`tar xzf ~/agents-before-miksy.tgz -C ~ --exclude=.claude.json` (Windows:
`tar xzf "$HOME/agents-before-miksy.tgz" -C $HOME --exclude=.claude.json`). `~/.claude.json` не возвращайте —
почему, сказано в «Как удалить miksy».
