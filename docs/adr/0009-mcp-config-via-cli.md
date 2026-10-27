# ADR 0009: MCP configuration via the claude CLI with a file fallback

- Status: accepted
- Date: 2026-10-27
- Amends: [ADR 0006](0006-file-write-policy.md) (MCP servers were CLI-only there)

## Context

Agent Hub lists and edits MCP servers in Claude Code's three scopes. Claude Code owns the storage: `user` and `local` servers live in `~/.claude.json`, a large file that also holds account details, per-project trust and history and is rewritten by every running Claude Code process; `project` servers live in `<project>/.mcp.json`, which is committed to the repository. ADR 0006 allowed only `claude mcp add-json` / `remove`. That leaves Agent Hub without MCP management when the `claude` binary is not on the server's `PATH`, and the CLI offers no machine-readable listing.

## Decision

- **Writes are CLI-first.** `claude --version` decides the mode (cached for 60 s). When it succeeds, upsert runs `claude mcp add-json -s <scope> <name> <json>` and remove runs `claude mcp remove -s <scope> <name>`, both through `run()` (no shell) with `cwd` set to the project for `project`/`local` and `CLAUDE_CONFIG_DIR` passed on when set. An update is `remove` + `add-json`; if the add fails, the previous entry is added back through the CLI, then by writing the file; if both fail the answer is `500 internal` and the entry must be re-added by hand.
- **File mode is the fallback** when the CLI is missing, and **listing always reads the files** (`claude mcp list`/`get` print human-readable text and health-check every server, which spawns stdio servers). File edits use `jsonc-parser`'s `modify`/`applyEdits` on the exact `mcpServers.<name>` path, so unknown keys, key order and indentation stay as they are; a file that is not strict JSON (or has a non-object section on the path) is `409 conflict` and never overwritten. Writes reuse the file service's atomic write (hash re-checked right before `rename`) and backups. In file mode `~/.claude.json` is written with mode `0600`; in CLI mode Claude Code sets the mode itself (it created a fresh file as `0644` in our experiment), so the `0600` guarantee holds for file mode only.
- **Scope mapping:** Agent Hub `global` -> `user`; `project`/`worktree` -> `project` (`.mcp.json`, shared via git) or `local` (`projects["<path>"].mcpServers` in `~/.claude.json`, private), chosen by the user (`toMcpScope(scope, shared)`).
- **Allowlist:** only `~/.claude.json` (root: its directory) and `<root>/.mcp.json` of a configured project or worktree (root: that directory); the real path must keep the managed file name, so a link to another file is `403`. Symlinks whose target stays inside that root and keeps the file name are followed and the link is kept (accepted, same rule as the file service).
- **Names:** `^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$`, and Claude Code's reserved built-in names (`RESERVED_MCP_NAMES`: `workspace`, `claude-in-chrome`, `computer-use`, `Claude Preview`, `Claude Browser`, compared case-insensitively) are rejected.
- **Secrets:** env and header values are masked as `{ masked: true, set }` on every read path except `PATH`, `HOME`, `NODE_ENV`, `LOG_LEVEL`. On update `{ keep: true }` per key keeps the stored value. Logs carry only name, scope kind and mode; CLI error output is scrubbed of the request's secret values (raw and JSON-escaped), and an invalid JSON file is reported by error code, line and column only, never with a quote of its content. `args` and URL query strings are not masked: a secret placed there is shown in full.
- **Unknown entry keys survive an update** (`oauth`, `timeout`, `headersHelper`, ...) as long as the transport family (stdio vs. remote) stays the same. Entries with other transports (`ws`) or names outside `[A-Za-z0-9_-]` are not listed and cannot be overwritten through Agent Hub.

## Verified vs. assumed

Verified against `code.claude.com/docs/en/mcp`, `/settings`, `/claude-directory` and `claude mcp <cmd> --help` of Claude Code 2.1.311 (2026-10-27):

| Fact | Source |
| --- | --- |
| Subcommands `add`, `add-json <name> <json>`, `remove <name>`, `list`, `get <name>`; no update subcommand | docs + `--help` |
| `add-json` and `remove` take `-s, --scope <local\|user\|project>`, default `local`; `remove` without `-s` removes from whichever scope has it | `--help` |
| `list` and `get` have no `--json` flag and health-check servers | `--help` |
| Storage: `user` and `local` in `~/.claude.json` (`local` under `projects["<path>"].mcpServers`), `project` in `.mcp.json` under `mcpServers` | docs |
| JSON format: `type` is `stdio`, `http`, `sse` (`streamable-http` alias) or `ws`; an entry without `type` is stdio; `command`/`args`/`env`, `url`/`headers` | docs |
| `${VAR}` and `${VAR:-default}` are expanded in `command`, `args`, `env`, `url`, `headers` | docs |
| Names: letters, digits, `-`, `_` | docs |
| Removing a remote server deletes its stored OAuth tokens | docs |
| `~/.claude.json` must be strict JSON; Claude Code keeps its own backups in `~/.claude/backups/` | docs |
| With `CLAUDE_CONFIG_DIR` set, the CLI writes `$CLAUDE_CONFIG_DIR/.claude.json` instead of `~/.claude.json` | experiment with a temp `HOME`, CLI 2.1.311 |
| `add-json -s local` in a non-git directory writes `projects["<absolute cwd>"].mcpServers`; the stored entry is the JSON as given | same experiment |
| Reserved names `workspace`, `claude-in-chrome`, `computer-use`, `Claude Preview`, `Claude Browser`; `claude mcp add` rejects them | docs |

Assumed (not stated in the docs):

- `local` scope keys by the realpath of the CLI's working directory, also inside a git repository. Agent Hub canonicalizes `projectPath` with `realpath` and runs the CLI in that project or worktree root, so the CLI and the file reader use the same key.
- The `CLAUDE_CONFIG_DIR` location is stable across CLI versions (the docs only say that `~/.claude` paths move).
- Running Claude Code processes re-read `~/.claude.json` before writing it, so a file-mode edit is not overwritten by stale in-memory state.
- Names are limited to 64 characters and must not start with `-` (Agent Hub's own limit, so a name is never read as a flag).

## Consequences

- MCP management works with or without the `claude` binary; the UI can show the mode and CLI version from `GET /api/mcp`.
- CLI updates stay non-atomic (remove + add, with a best-effort restore); removing or replacing a remote server can drop its OAuth tokens.
- In CLI mode, secret values are part of the `claude` process's argv: other local users can read `/proc/<pid>/cmdline` for the CLI's lifetime unless `/proc` is mounted with `hidepid`. Other OS users are outside the threat model.
- If an update fails and both restores (CLI, then file) fail, the entry is gone and the API answers `500 internal` ("re-add it manually").
- File mode depends on the documented layout of `~/.claude.json`; a format change in Claude Code needs a code change here.

## Alternatives considered

- CLI only (ADR 0006): no MCP management without the binary, no reliable listing.
- Files only: works offline from the CLI, but bypasses Claude Code's own validation and locking when it is available.
- Re-serializing with `JSON.stringify`: keeps keys but loses the file's indentation and rewrites the whole file on every edit; `jsonc-parser` edits only the touched range.
