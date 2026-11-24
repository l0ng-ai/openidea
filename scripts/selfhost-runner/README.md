# Self-Hosted GitHub Actions Runners

Runs _N_ persistent, isolated GitHub Actions runners via Docker Compose on a single Docker named volume (`runner-persist`) without requiring repository admin Personal Access Tokens.

In `.github/workflows/ci.yml`, the Linux leg of `Rust (${{ matrix.os }})` routes to `["self-hosted", "openidea-selfhosted"]` on trusted events (`push`, `merge_group`, `workflow_dispatch`, and same-repo pull requests) while the `SELFHOSTED_RUNNERS` repository variable is `true`. Fork pull requests, and every run while the variable is unset, use GitHub-hosted runners.

> **Availability requirement:** GitHub Actions `runs-on` cannot fall back to GitHub-hosted runners when no matching self-hosted runner is online; jobs stay queued until one connects. Set `SELFHOSTED_RUNNERS=true` (**Settings → Secrets and variables → Actions → Variables**) only once the runners are up, and delete it before taking the host down.

## Security Constraints

Because this repository is public and these runners retain persistent build caches and credentials across runs, workflows and runner hosts must follow these rules:

- **Trusted events only:** Route jobs to `openidea-selfhosted` only for `push`, `merge_group`, `workflow_dispatch`, or `pull_request` events where `github.event.pull_request.head.repo.full_name == github.repository`. Fork pull requests must stay on GitHub-hosted runners so untrusted code never reaches persistent caches or runner credentials.
- **Read-only `GITHUB_TOKEN`:** Jobs targeting `openidea-selfhosted` must set `permissions: { contents: read }` (least privilege).
- **No secret-bearing jobs:** Never pass repository or organization `secrets.*` to jobs running on `openidea-selfhosted`.
- **Never feed releases:** Artifacts or outputs from `openidea-selfhosted` runners must never be uploaded for consumption by release or nightly workflows.
- **Container isolation:** Jobs run as the `runner` user (`RUN_AS_ROOT=false`) from a pinned image tag and digest, but the image grants that user passwordless `sudo` (CI needs it for `apt-get`), so a job can become root inside its container. The container is the isolation boundary: never mount `/var/run/docker.sock` or host directories into it, and never run it `--privileged`.
- **Shared build state:** Same-repo pull requests and `main` share each slot's Cargo target directory, so only collaborators you trust with `main`'s build should push branches to this repository.
- **Network isolation:** Run the Docker host on an isolated network segment away from sensitive devices or internal services.

## How It Works

On startup, each container replica acquires an exclusive `flock` on a numeric slot (`1..N`) before dropping privileges to the `runner` user, isolating its persistent state under `/persist/slot-<N>/`:

| Path            | Purpose                                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `runner-data/`  | Saved `.runner` and `.credentials` reused across container restarts (`CONFIGURED_ACTIONS_RUNNER_FILES_DIR`)                   |
| `work/`         | Runner workspace and repository checkouts (`RUNNER_WORKDIR`)                                                                  |
| `cargo-target/` | Pre-compiled Rust build artifacts (`CARGO_TARGET_DIR`), kept outside checkouts so `actions/checkout` cleanup does not wipe it |
| `cargo/`        | Cargo crate registry and git cache (`CARGO_HOME`)                                                                             |
| `rustup/`       | Installed Rust toolchains (`RUSTUP_HOME`)                                                                                     |
| `pnpm-store/`   | Content-addressable `pnpm` store on the same filesystem as `work/` for fast hardlinks into `node_modules`                     |
| `toolcache/`    | Tools cached by `actions/setup-*` (`/opt/hostedtoolcache`)                                                                    |
| `cache/`        | General `/home/runner/.cache` directory                                                                                       |

All slots also share `/persist/shared/npm-cache` for downloaded npm tarballs.

## Prerequisites (First-Time Registration Only)

Ask a repository admin to generate **one** 1-hour registration token from:

> **GitHub Repository → Settings → Actions → Runners → New self-hosted runner**

A single registration token can register multiple runner slots within its 1-hour validity window. Once registered, each slot saves its own runner credentials and reconnects across restarts without needing a token again.

## Quick Start

Run all commands from `scripts/selfhost-runner/`:

1. **Initial registration** (registers slots `1..4` and saves credentials):

   ```bash
   RUNNER_TOKEN=<one-time-token> docker compose up -d
   ```

2. **Normal start, restart, or recreate** (no token needed once slots are registered):

   ```bash
   docker compose up -d
   docker compose restart
   ```

3. **Scale down** (for example `4` → `2`):

   ```bash
   RUNNER_COUNT=2 docker compose up -d
   ```

   Docker Compose does not guarantee which container replicas it removes, so scaling `4` → `2` may leave slots `3` and `4` running rather than `1` and `2`. Stopped slots keep their saved credentials and caches on disk and will be reclaimed on the next restart or scale-up.

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
| `RUNNER_NAME_PREFIX` | `openidea-runner`                     | Runner name prefix; registers as `<prefix>-1`, `<prefix>-2`, …         |
| `RUNNER_LABELS`      | `openidea-selfhosted`                 | Comma-separated labels attached to each runner                         |
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

- **Workflow caching tips:** `CARGO_TARGET_DIR` persists automatically across runs; CI enables incremental compilation on these runners and clears a slot's target directory once it exceeds 40 GB. To also preserve in-repo `node_modules/` across runs without re-linking, pass `clean: false` to `actions/checkout` (otherwise `pnpm install` quickly re-hardlinks packages from `pnpm-store/`).
