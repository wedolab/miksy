# Установка miksy на Windows (PowerShell 5.1+): проверяет git и Bun, при необходимости скачивает
# движок и запускает мастер настройки (bun src/cli.ts setup). Аргументы передаются мастеру.
#   из клона:      .\install.ps1
#   одной строкой: irm <адрес install.ps1> | iex
# MIKSY_REPO — откуда клонировать движок (по умолчанию — GitHub).

function Invoke-MiksyInstall([string[]]$SetupArgs) {
  $repo = if ($env:MIKSY_REPO) { $env:MIKSY_REPO } else { 'https://github.com/wedolab/miksy.git' }
  $minBun = [version]'1.3.14'
  $yes = { param($q) $a = Read-Host "$q [y/N]"; return ($a -match '^\s*[yYдД]') }

  Write-Host 'Установка miksy'
  Write-Host ''

  # 1. git
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host 'Нужен git — его нет в PATH. Как поставить:'
    Write-Host '  winget install --id Git.Git -e      (или https://git-scm.com/download/win)'
    Write-Host 'Затем откройте новое окно PowerShell и запустите установку снова.'
    return 1
  }

  # 2. Bun: нет в PATH, но установлен в ~\.bun — подхватить; нет совсем — предложить официальный установщик
  $bunDir = Join-Path $(if ($env:BUN_INSTALL) { $env:BUN_INSTALL } else { Join-Path $HOME '.bun' }) 'bin'
  if (-not (Get-Command bun -ErrorAction SilentlyContinue) -and (Test-Path $bunDir)) {
    $env:Path = "$bunDir;$env:Path"
  }
  if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Host "Нужен Bun ($minBun или новее) — его нет. Официальный установщик:"
    Write-Host '  powershell -c "irm bun.sh/install.ps1 | iex"'
    if (-not (& $yes 'Установить Bun сейчас?')) {
      Write-Host 'Без Bun miksy не работает. Поставьте его (README, раздел «Установка») и запустите установку снова.'
      return 1
    }
    & powershell -NoProfile -ExecutionPolicy Bypass -Command 'irm bun.sh/install.ps1 | iex' | Out-Host
    if ($LASTEXITCODE -ne 0) { Write-Host 'Установщик Bun завершился с ошибкой.'; return 1 }
    # Установщик дописал Bun в пользовательский PATH; в этом окне — сразу, без перезапуска
    $env:Path = "$bunDir;$env:Path"
    if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
      Write-Host "Bun установлен, но не найден в $bunDir. Откройте новое окно PowerShell и запустите установку снова."
      return 1
    }
  }
  $bunVersion = (& bun --version) -replace '[^0-9.].*$', ''
  if ([version]$bunVersion -lt $minBun) {
    Write-Host "Bun $bunVersion старше $minBun — обновите: bun upgrade (или менеджером пакетов, которым ставили)."
    return 1
  }
  Write-Host "✓ git, Bun $bunVersion"

  # Несколько установок Bun (PATH и каталог официального установщика ~\.bun\bin — его скрипт подхватывает
  # выше): какая используется — только сообщение. Места вне PATH (scoop и т. п.) не ищутся
  $bunUsed = (Get-Command bun).Source
  $bunAll = @(@(Get-Command bun -All -CommandType Application -ErrorAction SilentlyContinue | ForEach-Object { $_.Source }) +
    @((Join-Path $bunDir 'bun.exe'), (Join-Path $bunDir 'bun.cmd'), (Join-Path $HOME '.bun\bin\bun.exe') | Where-Object { Test-Path $_ -PathType Leaf }) |
    Where-Object { $_ -notmatch '\\Microsoft\\WindowsApps\\' } |
    ForEach-Object { [IO.Path]::GetFullPath($_) } | Group-Object { (Split-Path $_).ToLower() } | ForEach-Object { $_.Group[0] })
  if ($bunAll.Count -gt 1) {
    Write-Host "Внимание: на машине несколько установок Bun — используется ${bunUsed}:"
    foreach ($p in $bunAll) { if ((Split-Path $p) -eq (Split-Path $bunUsed)) { Write-Host "  $p  ← используется" } else { Write-Host "  $p" } }
    Write-Host '  Лучше оставить одну: команда miksy и обёртки MCP запоминают путь Bun, а установки обновляются'
    Write-Host '  по отдельности. Лишние удалите сами (miksy их не трогает).'
  }

  # 3. Движок: запущены из клона — он и есть; иначе — куда скачать
  $engine = $null
  if ($PSCommandPath -and (Test-Path (Join-Path (Split-Path $PSCommandPath) 'src\cli.ts'))) { $engine = Split-Path $PSCommandPath }
  if (-not $engine) {
    $default = Join-Path $HOME 'Projects\miksy'
    $dest = Read-Host "Куда скачать miksy [$default]"
    if (-not $dest -or -not $dest.Trim()) { $dest = $default }
    $dest = $dest.Trim() -replace '^~(?=$|[\\/])', $HOME
    $dest = [IO.Path]::GetFullPath((Join-Path (Get-Location) $dest))
    if (Test-Path (Join-Path $dest 'src\cli.ts')) {
      Write-Host "✓ miksy уже скачан: $dest"
    } elseif ((Test-Path $dest) -and (Get-ChildItem -Force $dest | Select-Object -First 1)) {
      Write-Host "$dest уже есть и это не miksy — укажите другой каталог."
      return 1
    } else {
      New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
      Write-Host "Скачиваю $repo → $dest"
      & git clone $repo $dest | Out-Host
      if ($LASTEXITCODE -ne 0) {
        Write-Host ''
        Write-Host 'Не удалось скачать miksy. Репо пока приватный — нужен доступ к нему:'
        Write-Host '  войдите в GitHub: gh auth login (затем gh auth setup-git) и запустите установку снова,'
        Write-Host '  или добавьте SSH-ключ в GitHub и укажите адрес: $env:MIKSY_REPO = "git@github.com:wedolab/miksy.git"'
        return 1
      }
      # Пользователям — ветка stable (последний релиз), если она есть в репо; иначе — ветка по умолчанию.
      # Клон один (без второго запроса доступа), затем переход на stable
      & git -C $dest rev-parse -q --verify refs/remotes/origin/stable | Out-Null
      if ($LASTEXITCODE -eq 0) {
        & git -C $dest checkout -q stable | Out-Host
        if ($LASTEXITCODE -ne 0) { Write-Host "Не удалось перейти на ветку stable в $dest."; return 1 }
        Write-Host '✓ ветка stable — последний релиз (обновление: miksy update)'
      }
    }
    $engine = $dest
  }

  # 4. Мастер настройки: Start-Process — вывод и вопросы прямо в консоль (вызов внутри функции
  # PowerShell перехватил бы вывод как результат функции)
  Write-Host ''
  $bun = (Get-Command bun).Source
  $argList = @('src/cli.ts', 'setup') + @($SetupArgs | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' })
  $p = Start-Process -FilePath $bun -ArgumentList $argList -WorkingDirectory $engine -NoNewWindow -Wait -PassThru
  return $p.ExitCode
}

$code = Invoke-MiksyInstall $args
# Из файла — код выхода; через iex — без exit (иначе закрылось бы окно PowerShell)
if ($PSCommandPath) { exit $code }
