# ADR 0006: File-write policy

- Status: accepted
- Date: 2026-10-27
- Amended 2026-10-27: hash-only conflict version, per-file skill backups, stricter symlink rule (T31)

## Context

Paneful Manager edits files that belong to the user and to Claude Code (settings, CLAUDE.md, skills, MCP config). Losing a user's edit or corrupting a settings file is worse than any missing feature.

## Decision

- The server writes only: its own config, presets and state; the `hooks` key of `settings.json` in the Claude config dir (`$CLAUDE_CONFIG_DIR` or `~/.claude`; merge, never replace foreign entries); CLAUDE.md and skills inside allowlisted scopes (global Claude config dir, configured projects and their git worktrees). MCP servers change only through `claude mcp add-json` / `claude mcp remove` via `execFile`; an edit is remove + add.
- Every write is atomic: temp file in the same directory, `fsync`, `rename`.
- Every write of an existing file carries the sha256 `expectedHash` it was based on; a mismatch, or a missing hash for an existing file, returns `409 conflict` with the current hash. There is no force overwrite.
- The requested path must match a managed pattern. Symlinks are resolved with `realpath` and followed only if the target stays inside the same scope root, has no hidden segment (except the skills prefix) and is a managed or `.md` file; the link is preserved.
- Before overwriting or deleting a non-state file, the old content is backed up to `$STATE/backups/<encoded-path>/<timestamp>` (mode `0600`; deleted skill directories file by file, and a directory with unmanaged entries is not deleted but answered with `409 conflict` listing them). Retention: last 20 per file, 50 MB total, oldest pruned first.

## Consequences

- Concurrent edits in an editor and in Paneful Manager are detected instead of lost.
- Claude Code file formats stay owned by Claude Code where a CLI exists.
- Backups cost at most 50 MB in the state directory.
- MCP edits are not atomic (remove + add), and removing a remote server drops its OAuth tokens; the UI warns and offers a retry.

## Alternatives considered

- Direct writes with last-writer-wins: simple, silently loses edits.
- Editing `~/.claude.json` directly for MCP: undocumented internal format, high corruption risk.
- File locking: not honored by editors, does not help.
