[Русский](README.md) | **English**

# Miksy

One source of rules, skills and MCP servers for several AI coding agents:
**Claude Code, Codex, opencode, Gemini (Antigravity)**.

> **The interface is in Russian for now.** The setup wizard, command output and the full
> documentation ([README.md](README.md)) are Russian-only. This page is a short overview. An English
> interface is planned if there is interest — tell us in an [issue](https://github.com/wedolab/miksy/issues).

Instead of configuring every agent by hand in every project, you describe everything once — in
layers — and miksy writes it into the native config of every agent in every project: rules into
their instruction files, MCP servers into their configs, skills into their skill folders. Miksy does
not run in the background: after you change the layers, you run `miksy sync`.

**Miksy is not an agent and not an "agent harness".** It does not run anything on behalf of your
agents and does not sit between you and them: it is a configuration generator for agents you
already have. The name comes from what it distributes: **M**CP, **I**nstructions, **K**eys
(secrets), **S**kills.

## How it works

Your settings live in a personal configuration folder (usually `miksy-config` next to the engine,
ideally in your own private git repo), organised in layers:

```
miksy-config/
├── map.yaml          global layers, special bindings
├── layers/
│   ├── global/       your rules for all agents everywhere → home folder
│   ├── env-windows/, env-macos/, env-linux/   OS-specific rules (shell, syntax)
│   └── tree/         → every project in your workspace; mirrors the workspace tree
│       ├── instructions/          rules for all projects
│       ├── mcp/context7.yaml      an MCP server for all projects
│       └── Acme/billing-api/      → only the project ~/Projects/Acme/billing-api
└── local/            this machine only, not in git: workspace, agents, secret values, backups
```

A project gets every layer along its path, top to bottom; a lower layer adds to and overrides the
upper ones. Secrets are referenced as `${NAME}` and stored in `local/secrets.env` — agent configs get
wrappers, not the values.

Miksy only touches what it wrote itself: your own and your team's files stay as they are, and if it
has to replace a file, it keeps the original and restores it when you remove miksy.

## Requirements

- **Agents:** Claude Code, Codex, opencode **2.x**, Antigravity — any of them; miksy configures only the
  ones you have installed. Works in the terminal and in editors that run agents through ACP (Zed);
  Antigravity gets them in its IDE and CLI (`agy`), not yet through ACP in Zed.
- **OS:** Windows, macOS and Linux (Ubuntu 24.04) are tested on real machines and in CI.
- **git** and **[Bun](https://bun.sh)** 1.3.14 or newer (the installer offers to install Bun).

## Installation

Pick your **workspace** — the folder with your projects, e.g. `~/Projects` — and clone miksy into it.
`-b stable` is the latest release; `miksy update` updates it later.

macOS and Linux:

```
git clone -b stable https://github.com/wedolab/miksy.git ~/Projects/miksy
cd ~/Projects/miksy && ./install.sh
```

Windows (PowerShell):

```
git clone -b stable https://github.com/wedolab/miksy.git $HOME\Projects\miksy
cd $HOME\Projects\miksy; powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Or in one line (the script asks where to put miksy, `~/Projects/miksy` by default):

```
curl -fsSL https://raw.githubusercontent.com/wedolab/miksy/main/install.sh | bash
irm https://raw.githubusercontent.com/wedolab/miksy/main/install.ps1 | iex
```

The installer checks git, installs Bun if needed and starts the setup wizard (`miksy setup`). You can
also hand the installation to your agent: give it [INSTALL-AGENT.md](INSTALL-AGENT.md) — the agent
reads Russian fine and can explain the steps to you in English.

## Everyday commands

| Command | What it does |
|---|---|
| `miksy setup` | setup wizard; rerun to continue or to pick up newly installed agents |
| `miksy sync --global`, `miksy sync --all` | write your settings to the agents (home folder / all projects); `--dry-run` shows the plan |
| `miksy doctor` | checks that everything is written and nothing has drifted (changes nothing) |
| `miksy explain <path>` | what a folder gets and from which layer |
| `miksy update` | update miksy to the latest release (`--check` only checks) |

## More

- Full documentation (Russian): [README.md](README.md), design: [DESIGN.md](DESIGN.md)
- Changes by version: [CHANGELOG.md](CHANGELOG.md)
- Security issues: report privately via **Security → Report a vulnerability** ([SECURITY.md](SECURITY.md))
- License: [MIT](LICENSE)
