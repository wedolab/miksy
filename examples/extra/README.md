# Дополнительные примеры слоёв

`miksy setup` копирует в новую конфигурацию только `examples/config`. Здесь — примеры,
которые нужны не всем: возьмите нужное и положите в свою конфигурацию по тому же пути
(`layers/tree/Acme/…` → `<конфигурация>/layers/tree/<ваша организация>/…`).

| Файл | Что показывает |
|---|---|
| `layers/tree/Acme/layer.yaml` | каталог организации как цель-группа (`target: true`) и доверие проектам с исполняемыми настройками команды (`trust`) |
| `layers/tree/Acme/instructions/10-acme.md` | правило для всех проектов организации |
| `layers/tree/Acme/mcp/gitlab.yaml` | локальный (stdio) MCP с секретом в `env` — miksy подключит его через обёртку |
| `layers/tree/Acme/mcp/tracker.yaml` | удалённый (HTTP) MCP с секретом в заголовке — helper заголовков, `{file:}` или мост, по агенту |
| `layers/tree/Acme/billing-api/layer.yaml` | слой одного проекта: `exclude` и импорт командных skills |

Секреты из примеров (`ACME_GITLAB_TOKEN`, `ACME_TRACKER_TOKEN`) задаются в
`local/secrets.env` этой машины; в слоях — только ссылки `${ИМЯ}`. Без значения `sync`
пропустит сервер с сообщением, остальное запишет.
