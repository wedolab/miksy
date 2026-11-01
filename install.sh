#!/bin/sh
# Установка miksy на macOS и Linux: проверяет git и Bun, при необходимости скачивает движок и
# запускает мастер настройки (bun src/cli.ts setup). Аргументы передаются мастеру.
#   из клона:      ./install.sh
#   одной строкой: curl -fsSL <адрес install.sh> | bash   (вопросы читаются из /dev/tty)
# MIKSY_REPO — откуда клонировать движок (по умолчанию — GitHub).
set -u

REPO="${MIKSY_REPO:-https://github.com/wedolab/miksy.git}"
MIN_BUN="1.3.14"

# Откуда читать ответы: скрипт из файла — из stdin; скрипт из конвейера (curl | bash) — stdin занят
# самим скриптом, вопросы — через /dev/tty
if [ -f "$0" ] && [ "$(basename -- "$0")" = "install.sh" ]; then
  FROM_FILE=1
  TTY=/dev/stdin
else
  FROM_FILE=0
  TTY=/dev/tty
  if ! (: <"$TTY") 2>/dev/null; then
    echo "Нет терминала для вопросов: скачайте install.sh и запустите его в терминале." >&2
    exit 1
  fi
fi

say() { printf '%s\n' "$*"; }
ask() { # ask <вопрос> → ответ в $REPLY (пустой — Enter или конец ввода)
  printf '%s ' "$1"
  REPLY=""
  # Из файла — прямо из stdin, не открывая /dev/stdin заново: на Linux повторное открытие файла
  # читает его с начала, и один ответ доставался бы нескольким вопросам
  if [ "$FROM_FILE" = 1 ]; then
    IFS= read -r REPLY || REPLY=""
  else
    IFS= read -r REPLY <"$TTY" || REPLY=""
  fi
}
yes_no() { # yes_no <вопрос>: да — только явным ответом
  ask "$1 [y/N]"
  case "$REPLY" in [yYдД]*) return 0 ;; *) return 1 ;; esac
}

# Версия a >= b (числа через точку)
version_ge() {
  printf '%s\n%s\n' "$2" "$1" | awk -F. '
    NR == 1 { for (i = 1; i <= 3; i++) b[i] = $i + 0 }
    NR == 2 { for (i = 1; i <= 3; i++) a[i] = $i + 0
      for (i = 1; i <= 3; i++) { if (a[i] > b[i]) exit 0; if (a[i] < b[i]) exit 1 }
      exit 0 }'
}

OS="$(uname -s)"

say "Установка miksy"
say ""

# 1. git
if ! command -v git >/dev/null 2>&1; then
  say "Нужен git — его нет в PATH. Как поставить:"
  if [ "$OS" = "Darwin" ]; then
    say "  xcode-select --install      (или: brew install git)"
  else
    say "  через менеджер пакетов системы, например: sudo apt install git"
  fi
  say "Затем запустите установку снова."
  exit 1
fi

# PATH оболочки до правок ниже: по нему мастер решает, надо ли прописать каталог команды miksy
MIKSY_ORIGINAL_PATH="${MIKSY_ORIGINAL_PATH:-$PATH}"
export MIKSY_ORIGINAL_PATH

# 2. Bun: нет в PATH, но установлен в ~/.bun — подхватить; нет совсем — предложить официальный установщик
BUN_DIR="${BUN_INSTALL:-$HOME/.bun}/bin"
if ! command -v bun >/dev/null 2>&1 && [ -x "$BUN_DIR/bun" ]; then
  PATH="$BUN_DIR:$PATH"
  export PATH
fi
if ! command -v bun >/dev/null 2>&1; then
  say "Нужен Bun ($MIN_BUN или новее) — его нет. Официальный установщик:"
  say "  curl -fsSL https://bun.sh/install | bash"
  if ! yes_no "Установить Bun сейчас?"; then
    say "Без Bun miksy не работает. Поставьте его (README, раздел «Установка») и запустите установку снова."
    exit 1
  fi
  curl -fsSL https://bun.sh/install | bash || { say "Установщик Bun завершился с ошибкой."; exit 1; }
  # Установщик дописал PATH в профиль оболочки; в этом процессе — сразу, без нового окна
  PATH="$BUN_DIR:$PATH"
  export PATH
  if ! command -v bun >/dev/null 2>&1; then
    say "Bun установлен, но не найден в $BUN_DIR. Откройте новое окно терминала и запустите установку снова."
    exit 1
  fi
fi
BUN_VERSION="$(bun --version 2>/dev/null)"
if ! version_ge "$BUN_VERSION" "$MIN_BUN"; then
  say "Bun $BUN_VERSION старше $MIN_BUN — обновите: bun upgrade (или менеджером пакетов, которым ставили)."
  exit 1
fi
say "✓ git, Bun $BUN_VERSION"

# Несколько установок Bun (PATH и каталог официального установщика ~/.bun/bin — его скрипт подхватывает
# выше): какая используется — только сообщение. Места вне PATH (Homebrew и т. п.) не ищутся — оттуда
# Bun никто не запускает
real_path() { # путь без ссылок
  p="$1"; n=0
  while [ -L "$p" ] && [ "$n" -lt 20 ]; do
    l="$(readlink "$p")"
    case "$l" in /*) p="$l" ;; *) p="$(dirname -- "$p")/$l" ;; esac
    n=$((n + 1))
  done
  printf '%s/%s\n' "$(cd "$(dirname -- "$p")" 2>/dev/null && pwd -P)" "$(basename -- "$p")"
}
BUN_USED="$(command -v bun)"
BUN_ALL="$(
  { (IFS=:; for d in $PATH; do [ -n "$d" ] && [ -x "$d/bun" ] && [ ! -d "$d/bun" ] && printf '%s\n' "$d/bun"; done)
    for p in "$BUN_DIR/bun" "$HOME/.bun/bin/bun"; do
      [ -x "$p" ] && [ ! -d "$p" ] && printf '%s\n' "$p"
    done; } | while IFS= read -r p; do printf '%s\t%s\n' "$(real_path "$p")" "$p"; done | awk -F'\t' '!seen[$1]++ { print $2 }'
)"
if [ "$(printf '%s\n' "$BUN_ALL" | grep -c .)" -gt 1 ]; then
  USED_REAL="$(real_path "$BUN_USED")"
  say "Внимание: на машине несколько установок Bun — используется $BUN_USED:"
  printf '%s\n' "$BUN_ALL" | while IFS= read -r p; do
    if [ "$(real_path "$p")" = "$USED_REAL" ]; then say "  $p  ← используется"; else say "  $p"; fi
  done
  say "  Лучше оставить одну: команда miksy и обёртки MCP запоминают путь Bun, а установки обновляются"
  say "  по отдельности. Лишние удалите сами (miksy их не трогает)."
fi

# 3. Движок: запущены из клона — он и есть; иначе — куда скачать
ENGINE=""
if [ "$FROM_FILE" = 1 ]; then
  HERE="$(cd "$(dirname -- "$0")" && pwd)"
  [ -f "$HERE/src/cli.ts" ] && ENGINE="$HERE"
fi
if [ -z "$ENGINE" ]; then
  DEFAULT="$HOME/Projects/miksy"
  ask "Куда скачать miksy [$DEFAULT]:"
  DEST="${REPLY:-$DEFAULT}"
  case "$DEST" in "~") DEST="$HOME" ;; "~/"*) DEST="$HOME/${DEST#\~/}" ;; esac
  case "$DEST" in /*) ;; *) DEST="$(pwd)/$DEST" ;; esac
  if [ -f "$DEST/src/cli.ts" ]; then
    say "✓ miksy уже скачан: $DEST"
  elif [ -e "$DEST" ] && [ -n "$(ls -A "$DEST" 2>/dev/null)" ]; then
    say "$DEST уже есть и это не miksy — укажите другой каталог."
    exit 1
  else
    mkdir -p "$(dirname -- "$DEST")" || exit 1
    say "Скачиваю $REPO → $DEST"
    if ! git clone "$REPO" "$DEST"; then
      say ""
      say "Не удалось скачать miksy — проверьте сеть (прокси, VPN) и адрес репо. Ставите из приватной копии —"
      say "  войдите в GitHub: gh auth login (затем gh auth setup-git) и запустите установку снова,"
      say "  или добавьте SSH-ключ в GitHub и укажите адрес: MIKSY_REPO=git@github.com:wedolab/miksy.git"
      exit 1
    fi
    # Пользователям — ветка stable (последний релиз), если она есть в репо; иначе — ветка по умолчанию.
    # Клон один (без второго запроса доступа), затем переход на stable
    if git -C "$DEST" rev-parse -q --verify refs/remotes/origin/stable >/dev/null 2>&1; then
      git -C "$DEST" checkout -q stable || { say "Не удалось перейти на ветку stable в $DEST."; exit 1; }
      say "✓ ветка stable — последний релиз (обновление: miksy update)"
    fi
  fi
  ENGINE="$DEST"
fi

# 4. Мастер настройки
say ""
cd "$ENGINE" || exit 1
if [ "$FROM_FILE" = 1 ]; then
  exec bun src/cli.ts setup "$@"
else
  exec bun src/cli.ts setup "$@" <"$TTY"
fi
