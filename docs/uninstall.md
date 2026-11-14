# Как удалить miksy

Как убрать всё, что miksy записал агентам, вернуть настройки «до miksy» и удалить саму программу.

← [README](../README.md)

Коротко: шаг 1 убирает всё, что записал miksy, — обычно этого хватает. Шаг 4 — удалить сам miksy; `local/`
конфигурации удаляйте последней.

**До шага 1 знайте, что пропадёт у агентов:** вместе с записанным miksy `clean` уберёт и то, что вы сами перенесли в
конфигурацию, — MCP-серверы, которые перенёс мастер или `miksy adopt`, ваши правила и skills, перенесённые в слои.
Оригинала у них нет. Вернуть — шагом 3 (копия «до miksy») или из слоёв вручную (шаг 2). Шаг 3 нужен и тогда, когда
после шага 1 что-то работает не так, как до miksy.

## 1. Уберите всё, что записал miksy

Сначала закройте окна агентов (Claude Code, Codex, opencode, Antigravity): открытая сессия может записать свои
настройки поверх (так же — перед возвратом копии в шаге 3).

```
miksy clean --all --dry-run     # посмотреть план
miksy clean --all               # проекты и папки без git
miksy clean --global            # домашние настройки агентов
```

Агента, которого вы убрали из `agents` в `local/machine.yaml`, — `--agent <имя>`. Если `clean --all` в конце что-то
перечислил — выполните команды из его вывода. Проверка: `--dry-run` обеих команд — убирать больше нечего.

В каждой цели (папке, куда miksy записывал настройки) `clean` удаляет свои файлы, блоки в файлах правил и ключи в
общих конфигах агентов, возвращает **оригиналы** заменённых файлов (если файл менялся после замены — оставляет его и
называет путь оригинала), снимает своё доверие и одобрения серверов (ваши не трогает).

Изменённое вручную `clean` не трогает (конфликт) — `--force` уберёт и его (с бэкапом). Проект был «забыт»
(`--forget`, [что это](roots.md#корень-недоступен)), а потом нашёлся — сначала `miksy sync <путь>`, затем `miksy clean <путь>` (вывод `clean` подскажет).

## 2. Что остаётся после clean

Подробности для особых случаев. Учёт — список того, что miksy записал ([подробнее](layers.md#учёт-бэкапы-оригиналы)).

- **Пустые файлы, папки и разделы** (`{"mcp": {}}`) в конфигах агентов — удалите, если мешают.
- **Цели, которых нет в конфигурации или на диске** (их перечисляют `clean --all` и `doctor`) — `miksy clean <путь>`
  для каждой. Если miksy спросит, забыть ли записанное в пропавшую папку, а терминала нет — `miksy clean <путь> --forget`.
- **Записанное на недоступном диске** — подключите диск и повторите `miksy clean --all`. Данных больше нет:
  дополнительная папка с проектами — `miksy root remove "<папка>" --forget`, основная — `miksy clean "<путь проекта>"
  --forget` для каждого проекта.
- **MCP-серверы, перенесённые в конфигурацию** мастером или `miksy adopt`, `clean` у агентов **удалил** — оригинала
  нет. Вернуть — копией (шаг 3) или добавьте агенту заново (определение — в слое, `mcp/<имя>.yaml`). Что переносили —
  в `layers/global/mcp/`, `layers/tree/mcp/` и слоях проектов; сервер context7 из стартовой конфигурации возвращать
  не нужно.
- **Правила и skills, перенесённые в слои** (из `~/.claude/CLAUDE.md` и т. п.), `clean` тоже убрал. Вернуть: текст из
  `layers/global/instructions/<имя>.md` — в файл агента, папку из `layers/global/skills/<имя>/` — в каталог skills
  агента (или шаг 3); skill `miksy` возвращать не нужно. Skills, которые miksy заменил своими, `clean` вернул сам.

## 3. Вернуть копию «до miksy»

Только если нужно (см. начало) и **до** удаления `local/`: копия лежит в нём. Копия повторяет домашний каталог:
`…/before-miksy-<метка>/.codex/config.toml` — это `~/.codex/config.toml`. Копия **затрёт** изменения, сделанные после
установки в тех же файлах:

- `~/.claude.json` из копии **не возвращайте**: в нём Claude хранит вход, настройки и список проектов — команды ниже
  его пропускают. MCP-серверы Claude перенесите руками: закройте Claude и скопируйте нужные записи `"mcpServers"` из
  `…/before-miksy-<метка>/.claude.json` в то же место нынешнего `~/.claude.json` (общие — верхний уровень, серверы
  проекта — `"projects"` → `"<путь проекта>"`). Проверка — `claude mcp list` (в папке проекта — и его серверы);
- ваши правки после установки в `~/.codex/config.toml` и других файлах сохраните заранее или верните только нужные
  файлы.

Копия — в `<конфигурация>/local/backups/before-miksy-<метка>/` (`<конфигурация>` — папка конфигурации, например
`$HOME\Projects\miksy-config`; `<метка>` — дата и время установки). Найти её и посмотреть, что в ней:

```
(Get-ChildItem $HOME\Projects\miksy-config\local\backups -Filter before-miksy-*).FullName              # Windows: копии, полный путь
Get-ChildItem -Recurse -Force "$HOME\Projects\miksy-config\local\backups\before-miksy-<метка>"         # что в копии
find -H ~/Projects/miksy-config/local/backups -maxdepth 1 -name 'before-miksy-*'                   # macOS, Linux: копии, полный путь
find ~/Projects/miksy-config/local/backups/before-miksy-<метка> ! -type d                           # что в копии
```

Ничего не нашлось — копии нет (на вопрос 3 мастера ответили «нет» или ставили `setup --yes` без `--backup`): вернуть
прежнее можно только архивом из «[Установки вручную](install.md#установка-вручную)», если вы его делали (ниже).
Копий несколько — берите самую раннюю.

**Один файл** (например, конфиг Codex) — тоже после шага 1:

```
Copy-Item "$HOME\Projects\miksy-config\local\backups\before-miksy-<метка>\.codex\config.toml" "$HOME\.codex\config.toml"   # Windows
cp ~/Projects/miksy-config/local/backups/before-miksy-<метка>/.codex/config.toml ~/.codex/config.toml                          # macOS, Linux
```

**Всё, кроме `~/.claude.json`,** — **после шага 1**: вернувшееся раньше `clean` уберёт, как своё. Команду с вашим путём
печатал мастер (вопрос 3, «вернуть …»). Вывод не сохранился — возьмите команду ниже и замените первый путь в одинарных
кавычках (в команде для Windows — после `-LiteralPath`, для macOS и Linux — после `cd --`) на полный путь своей копии
(его показывает команда «копии, полный путь» выше; без `$HOME` и `~` — в одинарных кавычках они не раскрываются).
Кавычка в самом пути: в PowerShell удвойте её (`'` → `''`, так же `’`, `‘`, `‚`, `‛`), в macOS и Linux замените `'` на
`'\''`. Первая команда — для Windows (PowerShell), вторая — для macOS и Linux:

```
& { try { $c = (Get-Item -LiteralPath 'C:\Users\you\Projects\miksy-config\local\backups\before-miksy-2026-11-10T09-00-00' -Force -ErrorAction Stop).FullName.TrimEnd([char]92) } catch { Write-Host "не возвращён ни один файл: $_"; $global:LASTEXITCODE = 1; return }; $st = @{ e = 0 }; $f = { param($d) try { $items = @(Get-ChildItem -LiteralPath $d -Force -ErrorAction Stop) } catch { Write-Host "не возвращён: $d — $_"; $st.e = 1; return }; foreach ($i in $items) { $rel = $i.FullName.Substring($c.Length + 1); $t = Join-Path $env:USERPROFILE $rel; $link = $i.LinkType -in 'Junction', 'SymbolicLink'; if ($i.PSIsContainer -and -not $link) { & $f $i.FullName; continue }; if ($rel -eq '.claude.json') { continue }; try { $o = Get-Item -LiteralPath $t -Force -ErrorAction SilentlyContinue; $olink = $o -and $o.LinkType -in 'Junction', 'SymbolicLink'; if ($o -and $o.PSIsContainer -and -not $olink) { throw 'папка' }; [void][IO.Directory]::CreateDirectory((Split-Path $t)); if ($link) { $to = @($i.Target)[0]; if ($olink -and @($o.Target)[0] -eq $to) { continue }; $n = $(if ($o) { "$t.miksy-new" } else { $t }); $rl = { param($p) $x = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue; if ($x -and $x.LinkType -in 'Junction', 'SymbolicLink') { if ($x.PSIsContainer) { [IO.Directory]::Delete($p) } else { [IO.File]::Delete($p) } } }; & $rl "$t.miksy-new"; $env:MIKSY_L = $n; $env:MIKSY_T = $(if ($i.PSIsContainer) { [IO.Path]::GetFullPath([IO.Path]::Combine((Split-Path $t), $to)) } else { $to }); & cmd /d /c $(if ($i.PSIsContainer) { 'mklink /J "%MIKSY_L%" "%MIKSY_T%"' } else { 'mklink "%MIKSY_L%" "%MIKSY_T%"' }) | Out-Null; $ok = -not $LASTEXITCODE; Remove-Item Env:MIKSY_L, Env:MIKSY_T; if (-not $ok) { if ($o) { & $rl $n }; throw 'mklink' }; if ($o) { try { if ($o.PSIsContainer) { [IO.Directory]::Delete($t) } else { [IO.File]::Delete($t) }; if ($i.PSIsContainer) { [IO.Directory]::Move($n, $t) } else { [IO.File]::Move($n, $t) } } catch { if (Test-Path -LiteralPath $t) { & $rl $n }; throw } } } else { $b = [IO.File]::ReadAllBytes($i.FullName); $w = [IO.File]::Open($t, 'OpenOrCreate', 'Write'); try { $w.SetLength(0); $w.Write($b, 0, $b.Length) } finally { $w.Close() } } } catch { Write-Host "не возвращён: $rel"; $st.e = 1 } } }; & $f $c; $global:LASTEXITCODE = $st.e }
```

```
(cd -- '/Users/you/Projects/miksy-config/local/backups/before-miksy-2026-11-10T09-00-00' && find . ! -type d ! -path ./.claude.json -exec sh -c 'r=0; for f; do t="$HOME/${f#./}"; if [ -L "$f" ]; then if [ -d "$t" ] && [ ! -L "$t" ]; then false; else mkdir -p "${t%/*}" && ln -sfn "$(readlink "$f")" "$t"; fi; else if [ -d "$t" ]; then false; else mkdir -p "${t%/*}" && cp "$f" "$t"; fi; fi || { echo "не возвращён: ${f#./}" >&2; r=1; }; done; exit $r' _ {} +)
```

Обе возвращают в домашний каталог всё из копии, кроме `.claude.json`, — через ваши ссылки (dotfiles) тоже, а ссылки
из копии — ссылками (на Windows ссылки на папку — junction).

Команда ничего не напечатала — всё вернулось (код выхода 0; в PowerShell — `$LASTEXITCODE`). Иначе она перечисляет
файлы строками «не возвращён: …». Причины и что сделать:
- на этом месте в домашнем каталоге папка — посмотрите, что в ней; не нужна — удалите или переименуйте её;
- на Windows — ссылка на файл, которую Windows не дала создать: включите режим разработчика (Параметры → Система →
  Для разработчиков) или откройте PowerShell от имени администратора;
- файл занят (открыт агент или редактор) — закройте агентов и редакторы;
- файл «только для чтения» — снимите пометку: `attrib -r "$HOME\<файл>"` (Windows), `chmod u+w ~/'<файл>'` (macOS, Linux);
  `<файл>` — путь из строки «не возвращён» (он от домашнего каталога);
- «не возвращён ни один файл: …» — неверен путь копии: проверьте его первой командой выше.

Затем запустите ту же команду ещё раз — повторять её безопасно.

**Архив** из «[Установки вручную](install.md#установка-вручную)» — так же без `.claude.json`:
`tar xzf ~/agents-before-miksy.tgz -C ~ --exclude=.claude.json` (Windows:
`tar xzf "$HOME/agents-before-miksy.tgz" -C $HOME --exclude=.claude.json`).

Бэкапы `local/backups/<метка>/` (без `before-miksy`) для этого не годятся: хранятся только 20 последних запусков, а
секреты в них заменены заглушками `<secret:ИМЯ>`.

## 4. Удалите остальное

Если не нужно, — в таком порядке:
- **команда `miksy`**: `~/.bun/bin/miksy` (на Windows — `miksy.cmd` в той же папке, `$HOME\.bun\bin`) и файл
  `~/.miksy`, если есть (в нём записано, где лежит конфигурация);
- **Bun**, если он нужен был только miksy: папку `~/.bun` (`Remove-Item -Recurse $HOME\.bun` в PowerShell) и
  `~/.bun/bin` в PATH. macOS и Linux — строки `# miksy`, `# bun`, `export BUN_INSTALL=…`, `export PATH=…` в
  `~/.zshrc`, `~/.bash_profile` или `~/.bashrc`. Windows — Пуск → «Изменение переменных среды текущего пользователя»
  → Path → все строки с `.bun\bin` → «Удалить»;
- **программы для MCP-серверов** (Node.js, uv и т. п.), которые ставил мастер (в его выводе — «Выполнить «…»?» с
  ответом «y»), если они нужны были только miksy. Удаляются как обычные программы: Windows — «Установленные
  приложения» (сортировка по дате установки), macOS — `brew list`. uv — файлы `uv`, `uvx` (Windows — ещё `uvw`) в
  `~/.local/bin` (Windows — `%USERPROFILE%\.local\bin`);
- **папка движка**;
- **`local/` конфигурации** (`secrets.env`, `secrets/`, `state/`, `trust.json`; `backups/` — последней: в ней копия
  «до miksy» и оригиналы ваших файлов) и папка конфигурации (её стоит сохранить — это ваши слои).
