# Releasing

Releases are built and published by the GitHub Actions workflow [`.github/workflows/release.yml`](../.github/workflows/release.yml) when a version tag is pushed. `install.sh` installs the release marked as latest (`releases/latest`) unless `--version <tag>` is given.

## Procedure

1. On `main`, set `version` in the root `package.json` to the new version (for example `0.2.0`), add its section to [`CHANGELOG.md`](../CHANGELOG.md) and merge that change.
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
| `package` | a matrix with Node 22, one runner per target: `linux-x64` on `ubuntu-24.04`, `linux-arm64` on `ubuntu-24.04-arm`, `darwin-arm64` on `macos-15`, `darwin-x64` on `macos-15-intel`. Verifies that the tag is `v<package.json version>`, runs `scripts/release-pack.sh --target <target>`, smoke-tests the tarball with `scripts/release-smoke.sh`, uploads it as a workflow artifact |
| `package-generic` | on `ubuntu-24.04`: packs the generic tarball (`--no-deps`) and collects `install.sh` and `install.ps1` |
| `release` | tag pushes only, the only job with `contents: write`: verifies every checksum and runs `gh release create` with all assets |

The smoke test extracts the tarball, installs it with its own `install.sh --from-source <tarball> --no-service` into a temporary `HOME` (with failing `make`/`gcc`/`g++`/`clang` stubs on `PATH`, so any compile step fails), starts the server on a spare port and checks `GET /api/health` and the web app. It runs on Linux and macOS alike; no systemd unit or launchd agent is installed on the runner, so the units and agents themselves are covered by `scripts/test-install.sh` (stubbed `systemctl` and `launchctl`).

`macos-15-intel` is the last Intel image GitHub offers. When it is retired, drop `darwin-x64` from the matrix: Intel Macs then get the generic tarball, and `install.sh` installs node-pty with pnpm (its upstream package ships macOS prebuilds, so usually nothing is compiled).

## Release assets

| Asset | Used by `install.sh` |
| --- | --- |
| `paneful-manager-<tag>-<target>.tar.gz` for `linux-x64`, `linux-arm64`, `darwin-arm64`, `darwin-x64` | the tarball for the machine's system and node architecture, downloaded from `releases/download/<tag>/`; `<tag>` comes from the redirect of `releases/latest` or from `--version`. With a token both come from the GitHub API instead, see [Private repository](install.md#private-repository) |
| `paneful-manager-<tag>.tar.gz` | generic tarball without `node_modules`, used when there is no tarball for the target (and by `install.sh` versions before the per-target assets); node-pty is installed with pnpm |
| `*.tar.gz.sha256` | checksum of each tarball; without it a download is refused unless `--no-verify` is given |
| `install.sh` | the `curl ... releases/latest/download/install.sh \| sh` entry point (Linux, WSL, macOS) |
| `install.ps1` | the `irm ... releases/latest/download/install.ps1 \| iex` entry point (Windows) |

A target tarball contains the built server, web app and shared package, `install.sh`, `packaging/` and the server's production `node_modules` with the node-pty addon of that platform: compiled on the runner for Linux (glibc of Ubuntu 24.04), node-pty's own prebuild for macOS; Node-API, so any Node 22 or later works. Installing it on such a system needs no compiler and no pnpm. With an older glibc the bundled node-pty does not load; `install.sh` then removes the bundled `node_modules` and compiles node-pty with pnpm and the build tools.

## Local checks

```bash
pnpm release:pack                                      # dist/release/paneful-manager-v<version>-<target>.tar.gz + .sha256
sh scripts/release-smoke.sh dist/release/paneful-manager-v<version>-<target>.tar.gz 17399
sh scripts/test-install.sh                             # install.sh with stubbed systemctl/launchctl, incl. macOS paths
sh scripts/test-install-ps1.sh                         # install.ps1 with stubbed wsl.exe (powershell.exe from WSL, or pwsh)
```

`release-pack.sh --no-deps` packs the generic tarball without `node_modules`, which `install.sh` installs by compiling node-pty. `--target <target>` only asserts that the machine is that target; the bundled addon always comes from the machine that packs.

## Re-running a release

`gh release create` fails when the release already exists. Delete the release on GitHub (keep the tag), then re-run the failed workflow run. To publish a fixed build, bump the version and tag again instead of moving a published tag.
