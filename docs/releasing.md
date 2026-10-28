# Releasing

Releases are built and published by the GitHub Actions workflow [`.github/workflows/release.yml`](../.github/workflows/release.yml) when a version tag is pushed. `install.sh` installs the release marked as latest (`releases/latest`) unless `--version <tag>` is given.

## Procedure

1. On `main`, set `version` in the root `package.json` to the new version (for example `0.2.0`) and merge that change.
2. Optional dry run: in the Actions tab, run the **Release** workflow on `main` with the input `tag` set to `v0.2.0`. It runs every step except publishing and uploads the assets as a workflow artifact (kept 7 days).
3. Tag the merged commit and push the tag:

   ```bash
   git tag -a v0.2.0 -m "v0.2.0"
   git push origin v0.2.0
   ```

4. The workflow publishes the GitHub release `v0.2.0` with generated release notes. Check the release page and the assets.

A tag with a suffix (for example `v0.2.0-rc.1`) is published as a pre-release. `releases/latest` skips pre-releases, so `install.sh` installs one only with `--version v0.2.0-rc.1`.

## What the workflow does

| Job | Steps |
| --- | --- |
| `checks` | the whole [CI workflow](../.github/workflows/ci.yml) (lint, typecheck, unit tests, build, installer tests, e2e), called with `workflow_call` |
| `package` | on `ubuntu-24.04` with Node 22: verifies that the tag is `v<package.json version>`, runs `scripts/release-pack.sh`, smoke-tests the tarball with `scripts/release-smoke.sh`, uploads the assets as a workflow artifact |
| `release` | tag pushes only, the only job with `contents: write`: verifies the checksum and runs `gh release create` with the three assets |

The smoke test extracts the tarball, installs it with its own `install.sh --from-source <tarball> --no-systemd` into a temporary `HOME` (with failing `make`/`gcc`/`g++` stubs on `PATH`, so any compile step fails), starts the server on a spare port and checks `GET /api/health` and the web app.

## Release assets

| Asset | Used by `install.sh` |
| --- | --- |
| `agent-hub-<tag>.tar.gz` | downloaded from `releases/download/<tag>/`; `<tag>` comes from the redirect of `releases/latest` or from `--version` |
| `agent-hub-<tag>.tar.gz.sha256` | checksum of the tarball; without it a download is refused unless `--no-verify` is given |
| `install.sh` | the `curl ... releases/latest/download/install.sh \| sh` entry point |

The tarball contains the built server, web app and shared package, `install.sh`, `packaging/` and the server's production `node_modules` with node-pty compiled on the release runner (linux x64, glibc of Ubuntu 24.04, Node-API, so any Node 22 or later works). Installing it on such a system needs no compiler and no pnpm. On another architecture or an older glibc the bundled node-pty does not load; `install.sh` then removes the bundled `node_modules` and compiles node-pty with pnpm and the build tools.

## Local checks

```bash
pnpm release:pack                                      # dist/release/agent-hub-v<version>.tar.gz + .sha256
sh scripts/release-smoke.sh dist/release/agent-hub-v<version>.tar.gz 17399
```

`release-pack.sh --no-deps` packs a tarball without `node_modules`, which `install.sh` installs by compiling node-pty.

## Re-running a release

`gh release create` fails when the release already exists. Delete the release on GitHub (keep the tag), then re-run the failed workflow run. To publish a fixed build, bump the version and tag again instead of moving a published tag.
