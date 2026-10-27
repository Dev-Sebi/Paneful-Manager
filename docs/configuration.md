# Configuration

Agent Hub reads one app config file and one preset file per workspace. The server validates both with zod schemas from `packages/shared`. A missing config file means the defaults. An invalid file stops the server at startup with the path and the failing keys, so a typo is never ignored.

Related: [Install guide](install.md), [Troubleshooting](troubleshooting.md).

<!-- screenshot: Settings view with the "Confirm before closing a tab" switch and the read-only config dump -->

## Files

| File or directory | Content | Written by |
| --- | --- | --- |
| `~/.config/agent-hub/config.yaml` | app config (keys below) | you, and the server on `PATCH /api/config` |
| `~/.config/agent-hub/workspaces/<name>.yaml` | one workspace preset per file; the file name is the preset `name` | you, and the server through the preset API |
| `~/.local/state/agent-hub/` | runtime state, mode `0700` | server only |
| `~/.local/state/agent-hub/sessions/<id>.json` | one record per session | server |
| `~/.local/state/agent-hub/tabs.json` | open tabs, including pane sizes | server |
| `~/.local/state/agent-hub/preset-launches.json` | preset name to the session ids it launched (autostart guard) | server |
| `~/.local/state/agent-hub/hook-token` | hook token, mode `0600`, created once | server |
| `~/.local/state/agent-hub/tmux.conf` | tmux config for the Agent Hub tmux server | installer |
| `~/.local/state/agent-hub/backups/<encoded-path>/<timestamp>` | backups of Claude settings, CLAUDE.md, skills and presets before they are overwritten or deleted (mode `0600`, last 20 per file, at most 50 MB in total) | server |
| `$CLAUDE_CONFIG_DIR/settings.json` (default `~/.claude/settings.json`) | Claude Code settings; Agent Hub only adds or removes its own `hooks` entries | server, on hook install |
| `~/.claude.json`, `<project>/.mcp.json` | MCP server entries | server, through the `claude` CLI or a file edit |
| journald (`journalctl --user -u agent-hub`) | server logs | server |

The config and state directories follow `XDG_CONFIG_HOME` and `XDG_STATE_HOME` when they are set to absolute paths. A relative value is ignored.

## config.yaml

Keys, types and defaults come from `AppConfigSchema` in `packages/shared/src/config.ts` and `DEFAULT_CONFIG` in `packages/shared/src/defaults.ts`.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `port` | integer, 1 to 65535 | `7337` | Port of the server on `127.0.0.1`. `AGENT_HUB_PORT` overrides it. A changed value takes effect after a restart. |
| `experimental.agentTeams` | boolean | `false` | Enables the experimental agent-team views (see [Agent teams](#agent-teams-experimental)). |
| `confirmCloseTab` | boolean | `true` | Ask for confirmation before a tab is closed. Also available as a switch in the Settings view. |
| `projects` | list of paths | `[]` | Project directories. Each project and its git worktrees become scopes for CLAUDE.md, skills and MCP servers. A leading `~` is expanded. |
| `logLevel` | `trace`, `debug`, `info`, `warn`, `error`, `fatal` | `info` | Server log level. |
| `theme` | `dark`, `light`, `system` | `dark` | Default UI theme. A theme chosen in the UI is stored in the browser and takes precedence there. |

Rules:

- Keys not listed above are kept when the server rewrites the file, so notes and newer keys survive.
- The server writes changes through the YAML document API, so comments and key order stay.
- `PATCH /api/config` accepts only the keys above (unknown keys are rejected). Changing `port` returns `restartRequired: true`.

Example (`examples/config.yaml`):

```yaml
# Example app config. Copy to ~/.config/agent-hub/config.yaml and adapt.
port: 7337
theme: dark
confirmCloseTab: true
experimental:
  agentTeams: false
projects:
  - ~/git/project1
```

## Environment variables

| Variable | Read by | Effect |
| --- | --- | --- |
| `AGENT_HUB_PORT` | server | Port; overrides `port` in `config.yaml`. Only digits, 1 to 65535; any other value stops the server at startup. |
| `AGENT_HUB_DEV_ORIGINS` | server | Comma-separated extra Origins, each `http://localhost:<port>` or `http://127.0.0.1:<port>`. Honored only when `NODE_ENV=development`; other entries are logged and ignored. |
| `AGENT_HUB_WEB_DIST` | server | Directory of the built web app. Default: `apps/web/dist` next to the server. Without an `index.html` there, only the API is served. |
| `XDG_CONFIG_HOME` | server, installer | Base of the config directory (absolute values only). |
| `XDG_STATE_HOME` | server, installer | Base of the state directory (absolute values only). |
| `XDG_DATA_HOME` | installer | Base of the default install prefix (absolute values only). |
| `CLAUDE_CONFIG_DIR` | server | Claude Code config directory; default `~/.claude`. |
| `NODE_ENV` | server | `development` enables the Vite origins (`localhost:3000`, `127.0.0.1:3000`) and pretty logs. The systemd unit sets `production`. |
| `TMUX_TMPDIR` | server | Passed to tmux calls, so tmux finds the socket directory. |
| `AGENT_HUB_REPO` | installer | GitHub `<owner>/<repo>` to download releases from (default `agent-hub/agent-hub`). |

The server also sets these variables in every session it starts: `AGENT_HUB_SESSION_ID`, `AGENT_HUB_HOOK_TOKEN` and `AGENT_HUB_URL`. The hook handler in Claude Code uses them to report session state.

## Workspace presets

A preset describes tabs with panes. Each pane starts one command in one directory. Presets are files in `~/.config/agent-hub/workspaces/`, validated by `WorkspacePresetSchema` in `packages/shared/src/preset.ts`.

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | string | required | Preset name, 1 to 64 characters, `[A-Za-z0-9][A-Za-z0-9_-]*`. Must equal the file name without `.yaml`. |
| `description` | string | none | Free text. |
| `autostart` | boolean | `false` | Launch the preset once when the server starts. It is skipped while one of the sessions it launched before is still live (not exited). |
| `tabs` | list | required, at least 1 | Tabs of the preset. |
| `tabs[].title` | string | none | Tab title. An untitled tab is named after the preset, with its position when the preset has several tabs. |
| `tabs[].layout` | layout | `row` | Arrangement of the panes (see below). |
| `tabs[].panes` | list | required, 1 to 6 | Panes of the tab. |
| `panes[].cwd` | path | required | Working directory. A leading `~` is expanded. The directory must exist when the session starts. |
| `panes[].command` | string | `claude` | Command started in the pane. |
| `panes[].args` | list of strings | `[]` | Arguments of the command. |
| `panes[].title` | string | none | Pane title. |
| `panes[].size` | positive number | equal share | Relative weight of the pane along its split. |

Layout shorthands:

| Layout | Panes | Arrangement |
| --- | --- | --- |
| `single` | exactly 1 | one pane |
| `row` | 1 to 6 | side by side |
| `column` | 1 to 6 | stacked |
| `grid-2x2` | exactly 4 | 2 by 2 grid |
| `custom` | 1 to 6, each index used once | tree of splits (object form only) |

A `custom` layout is an object with `kind: custom` and a `root` node. A node is either `{ type: pane, pane: <index>, size? }`, where `<index>` points at `panes[<index>]` of the tab, or `{ type: split, direction: row | column, children: [...], size? }`. A split needs at least 2 children. Every pane index from `0` to `panes.length - 1` must appear exactly once.

Full example:

```yaml
# Two tabs: a review tab with three panes in a custom layout, and a single agent tab.
name: review-setup
description: Implementation agent with a reviewer and a test runner
autostart: false
tabs:
  - title: review
    layout:
      kind: custom
      root:
        type: split
        direction: row
        children:
          - type: pane
            pane: 0
            size: 2
          - type: split
            direction: column
            children:
              - type: pane
                pane: 1
              - type: pane
                pane: 2
    panes:
      - cwd: ~/git/project1
        title: implementer
      - cwd: ~/git/project1
        title: reviewer
      - cwd: ~/git/project1
        title: tests
  - title: single
    layout: single
    panes:
      - cwd: ~/git/project2
        title: agent
```

Smaller examples from `examples/workspaces/`:

- `project1.yaml`: one tab, `layout: row`, four `claude` panes in `~/git/project1`, `autostart: true`.
- `two-projects.yaml`: a `grid-2x2` tab in `~/git/project1` and a `single` tab in `~/git/project2`.

The preset API (`/api/presets`) creates, updates and deletes these files. Updates keep comments and unknown keys, and the previous file is backed up.

## Agent teams (experimental)

Agent teams are experimental and off by default. Set `experimental.agentTeams: true` in `config.yaml` (or through `PATCH /api/config`) to enable them.

With the flag on, the server reads, without writing:

- team configs in `$CLAUDE_CONFIG_DIR/teams/<team>/config.json`, and
- task files in `$CLAUDE_CONFIG_DIR/tasks/<task-list-id>/*.json`.

It shows them as a task board and links team members to Agent Hub sessions by tmux pane. With the flag off, `GET /api/teams` returns `enabled: false` and reads no files; team tabs are hidden. The lowest Claude Code version tested with agent teams is 2.1.309.

Team templates (a YAML file that launches a team) are not part of this version. [ADR 0010](adr/0010-agent-teams.md) is still `proposed`.
