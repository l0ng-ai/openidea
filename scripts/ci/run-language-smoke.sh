#!/usr/bin/env bash
# Runs a leg's language_smoke tests, teeing the output into $OPENIDEA_SMOKE_LOG_DIR/cargo-test.txt
# (uploaded when the leg fails). Usage: run-language-smoke.sh <language> <test>...
#
# JetBrains kotlin-lsp builds expire a few weeks after release. When the Kotlin tests fail with that
# build's expiry message, they run once more on the newest published build and pass with a warning
# annotation. Any other failure stays a failure, and nothing else is retried.
set -uo pipefail
language=$1
shift
here=$(dirname "${BASH_SOURCE[0]}")
posix() { if command -v cygpath > /dev/null; then cygpath -u "$1"; else printf '%s' "$1"; fi; }
logs=$(posix "${OPENIDEA_SMOKE_LOG_DIR:?OPENIDEA_SMOKE_LOG_DIR is not set}")
mkdir -p "$logs"

smoke() {
  cargo test --locked -p ide-host --test language_smoke -- --ignored --exact --test-threads=1 "$@" 2>&1 | tee "$logs/cargo-test.txt"
  return "${PIPESTATUS[0]}"
}

smoke "$@"
status=$?
if [ "$status" -eq 0 ] || [ "$language" != kotlin ]; then exit "$status"; fi
if ! grep -Eqs 'This build of .* has expired' "$logs/cargo-test.txt" "$logs"/*.log; then exit "$status"; fi

echo "pinned kotlin-lsp ${KOTLIN_LSP:-?} has expired; looking for the newest build"
latest=$(node "$here/kotlin-lsp-latest.mjs") || exit "$status"
if [ "$latest" = "${KOTLIN_LSP:-}" ]; then
  echo "::error::kotlin-lsp $latest has expired and is still the newest published build"
  exit "$status"
fi
cp "$logs/cargo-test.txt" "$logs/cargo-test-expired-pin.txt"
case "${RUNNER_OS:-}" in
  Windows) os=windows ;;
  *) os=linux ;;
esac
latest_home=${RUNNER_TEMP:-/tmp}/kotlin-lsp-latest
bash "$here/install-kotlin-lsp.sh" "$latest" - "$os" "$latest_home" || exit "$status"

# Later steps get the new build through $GITHUB_PATH (the installer); this shell needs it too.
PATH="$(posix "$latest_home")/shim:$PATH"
smoke "$@" || exit 1
echo "::warning title=Pinned kotlin-lsp expired::pinned kotlin-lsp ${KOTLIN_LSP:-?} expired: bump KOTLIN_LSP in .github/tool-versions.env (the Kotlin tests passed on $latest)"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  echo "**Pinned kotlin-lsp ${KOTLIN_LSP:-?} expired.** The Kotlin tests passed on $latest: bump \`KOTLIN_LSP\` in \`.github/tool-versions.env\`." >> "$GITHUB_STEP_SUMMARY"
fi
