#!/usr/bin/env bash
# Installs a kotlin-lsp build and puts a `kotlin-lsp` launcher on PATH for later steps.
# Usage: install-kotlin-lsp.sh <version> <sha256|-> <linux|windows> <dest>
# A "-" sha256 takes the one JetBrains publishes next to the archive (used for the newest build,
# which has no pin). $DOWNLOAD_DIR holds the archives (cached between runs).
#
# The app runs bin/intellij-server (crates/ide-tools registry.rs); `kotlin-lsp.sh` / `kotlin-lsp.cmd`
# are deprecated wrappers around it. languages/kotlin.toml starts the command `kotlin-lsp` from PATH,
# so the shim below is a one-line launcher that execs the real binary.
set -euo pipefail
version=$1
sha=$2
os=$3
posix() { if command -v cygpath > /dev/null; then cygpath -u "$1"; else printf '%s' "$1"; fi; }
dest=$(posix "$4")
here=$(dirname "${BASH_SOURCE[0]}")
downloads=$(posix "${DOWNLOAD_DIR:-${RUNNER_TEMP:-/tmp}/downloads}")
base=https://download.jetbrains.com/language-server/kotlin-server/$version

case "$os" in
  linux) archive=kotlin-server-$version.tar.gz ;;
  windows) archive=kotlin-server-$version.win.zip ;;
  *) echo "unknown os: $os" >&2; exit 2 ;;
esac

if [ "$sha" = "-" ]; then
  sha=$(curl --fail --silent --show-error --location --retry 3 --retry-all-errors "$base/$archive.sha256" | cut -d' ' -f1 | tr -d '\r\n')
fi
"$here/fetch-verified.sh" "$base/$archive" "$sha" "$downloads/$archive"

rm -rf "$dest"
mkdir -p "$dest"
if [ "$os" = linux ]; then
  tar xz -C "$dest" --strip-components=1 -f "$downloads/$archive"
  mkdir -p "$dest/shim"
  printf '#!/usr/bin/env bash\nexec "%s" "$@"\n' "$dest/bin/intellij-server" > "$dest/shim/kotlin-lsp"
  chmod +x "$dest/shim/kotlin-lsp"
  shim_dir=$dest/shim
else
  # The Windows archive has no top-level directory. Git Bash's tar (GNU) can't read zip: use Windows' bsdtar.
  "$(cygpath "$SYSTEMROOT")/System32/tar.exe" -xf "$(cygpath -w "$downloads/$archive")" -C "$(cygpath -w "$dest")"
  mkdir -p "$dest/shim"
  printf '@echo off\r\n"%s" %%*\r\n' "$(cygpath -w "$dest/bin/intellij-server.exe")" > "$dest/shim/kotlin-lsp.cmd"
  shim_dir=$(cygpath -w "$dest/shim")
  dest=$(cygpath -w "$dest")
fi

echo "kotlin-lsp $version installed in $dest (launcher: bin/intellij-server)"
if [ -n "${GITHUB_PATH:-}" ]; then echo "$shim_dir" >> "$GITHUB_PATH"; fi
if [ -n "${GITHUB_ENV:-}" ]; then echo "KOTLIN_LSP_HOME=$dest" >> "$GITHUB_ENV"; fi
