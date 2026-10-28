# Contributing to Agent Hub

Thanks for your interest in contributing.

## Setup

Requirements are listed in the [README](README.md#requirements).

```bash
pnpm install
pnpm dev
```

The UI is served at `http://localhost:3000` (Vite dev server). Open the URL from `pnpm login-url --port 3000` once, so the browser stores the access key for that origin. Port `7337` is the server port used by the installed app.

## Branch and PR Flow

1. Branch from `main`, e.g. `feat/<short-name>` or `fix/<short-name>`.
2. Keep each PR focused on a single task.
3. Open a pull request against `main` and fill in the PR template.

## Commit Messages

- Use the imperative mood: `add workspace preset validation`.
- Keep the subject short (ideally 72 characters or less).
- No trailing period.

## Checks

These must pass before a PR is ready for review:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Scope Rule

A PR touches only the files needed for its task. Unrelated refactors or formatting changes belong in a separate PR.

## Content Rules

Do not add company-specific names, internal URLs, paths or personal data. Use generic examples such as `~/git/project1`.

## Dependencies

Add a new dependency only with a clear reason stated in the PR description.

## Code of Conduct

Be respectful and constructive in all project spaces.
