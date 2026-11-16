#!/usr/bin/env bash
# Installs the pinned jdtls tarball and puts its bin/ on PATH for later steps.
# Needs JDTLS and JDTLS_SHA256 (.github/tool-versions.env); $DOWNLOAD_DIR holds the cached tarball.
# jdtls is found on PATH as `jdtls` (a python script) or, on Windows, `jdtls.bat`
# (crates/ide-tools registry.rs locates both; the app resolves the name via PATHEXT).
set -euo pipefail
here=$(dirname "${BASH_SOURCE[0]}")
posix() { if command -v cygpath > /dev/null; then cygpath -u "$1"; else printf '%s' "$1"; fi; }
downloads=$(posix "${DOWNLOAD_DIR:-${RUNNER_TEMP:-/tmp}/downloads}")
dest=$(posix "${RUNNER_TEMP:-/tmp}/jdtls")

archive=$downloads/jdt-language-server-$JDTLS.tar.gz
"$here/fetch-verified.sh" \
  "https://download.eclipse.org/jdtls/milestones/${JDTLS%-*}/jdt-language-server-$JDTLS.tar.gz" \
  "$JDTLS_SHA256" "$archive"

rm -rf "$dest"
mkdir -p "$dest"
tar xzf "$archive" -C "$dest"
bin=$dest/bin
if command -v cygpath > /dev/null; then bin=$(cygpath -w "$bin"); fi
echo "jdtls $JDTLS installed in $dest"
if [ -n "${GITHUB_PATH:-}" ]; then echo "$bin" >> "$GITHUB_PATH"; fi
