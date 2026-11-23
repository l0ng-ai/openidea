# Self-Hosted GitHub Actions Runners

Runs _N_ persistent, isolated GitHub Actions runners via Docker Compose on a single Docker named volume (`runner-persist`) without requiring repository admin Personal Access Tokens.

## How It Works

On startup, each container replica acquires an exclusive `flock` on a numeric slot (`1..N`) and isolates its own persistent state under `/persist/slot-<N>/`:

| Path            | Purpose                                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `runner-data/`  | Saved `.runner` and `.credentials` reused across container restarts (`CONFIGURED_ACTIONS_RUNNER_FILES_DIR`)                   |
| `work/`         | Runner workspace and repository checkouts (`RUNNER_WORKDIR`)                                                                  |
| `cargo-target/` | Pre-compiled Rust build artifacts (`CARGO_TARGET_DIR`), kept outside checkouts so `actions/checkout` cleanup does not wipe it |
| `cargo/`        | Cargo crate registry and git cache (`CARGO_HOME`)                                                                             |
| `rustup/`       | Installed Rust toolchains (`RUSTUP_HOME`)                                                                                     |
| `pnpm-store/`   | Content-addressable `pnpm` store on the same filesystem as `work/` for fast hardlinks into `node_modules`                     |
| `toolcache/`    | Tools cached by `actions/setup-*` (`/opt/hostedtoolcache`)                                                                    |
| `cache/`        | General `/root/.cache` directory                                                                                              |

All slots also share `/persist/shared/npm-cache` for downloaded npm tarballs.

## Prerequisites (First-Time Registration Only)

Ask a repository admin to generate **one** 1-hour registration token from:

> **GitHub Repository → Settings → Actions → Runners → New self-hosted runner**

A single registration token can register multiple runner slots within its 1-hour validity window. Once registered, each slot saves its own runner credentials and reconnects across restarts without needing a token again.

## Quick Start

Run all commands from `.github/selfhost-runner/`:

1. **Initial registration** (registers slots `1..4` and saves credentials):

   ```bash
   RUNNER_TOKEN=<one-time-token> docker compose up -d
   ```

2. **Normal start, restart, or recreate** (no token needed once slots are registered):

   ```bash
   docker compose up -d
   docker compose restart
   ```

3. **Scale down** (for example `4` → `2`; unused slots stay saved on disk for later):

   ```bash
   RUNNER_COUNT=2 docker compose up -d
   ```

4. **Scale up** (for example `4` → `6`):

   - If slots `5..6` were previously registered:

     ```bash
     RUNNER_COUNT=6 docker compose up -d
     ```

   - If slots `5..6` have never been registered:

     ```bash
     RUNNER_COUNT=6 RUNNER_TOKEN=<new-token> docker compose up -d
     ```

## Configuration

You can pass variables on the command line or place them in a local `.env` file in this directory (git-ignored):

| Variable             | Default                               | Description                                                            |
| -------------------- | ------------------------------------- | ---------------------------------------------------------------------- |
| `RUNNER_COUNT`       | `4`                                   | Number of concurrent runner replicas                                   |
| `RUNNER_NAME_PREFIX` | `myrunner-mac`                        | Runner name prefix; registers as `<prefix>-1`, `<prefix>-2`, …         |
| `RUNNER_LABELS`      | `local`                               | Comma-separated labels attached to each runner                         |
| `REPO_URL`           | `https://github.com/l0ng-ai/openidea` | Target GitHub repository URL                                           |
| `RUNNER_TOKEN`       | _(empty)_                             | One-time registration token (required only when registering new slots) |

## Troubleshooting & Tips

- **Offline expiry (> 14 days) or deleted runner:** GitHub automatically removes runners that stay offline for more than 14 days. To clear a stale slot `<N>` and re-register it:

  ```bash
  docker compose run --rm --entrypoint /bin/bash github-runner \
    -c "rm -rf /persist/slot-<N>/runner-data/*"
  RUNNER_TOKEN=<new-token> docker compose up -d
  ```

- **Full reset** (wipes all saved runner credentials and cached build artifacts):

  ```bash
  docker compose down -v
  ```

- **Workflow caching tips:** `CARGO_TARGET_DIR` persists automatically across runs. To also preserve in-repo `node_modules/` across runs without re-linking, pass `clean: false` to `actions/checkout` (otherwise `pnpm install` quickly re-hardlinks packages from `pnpm-store/`).
