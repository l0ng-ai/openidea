#!/usr/bin/env bash
# Downloads <url> to <file> unless <file> already has the expected sha256, then verifies it.
# Retries only the download (network flakes), never the check. Usage: fetch-verified.sh <url> <sha256> <file>
set -euo pipefail
url=$1
want=$2
# Windows runners pass backslash paths; Git Bash's dirname and curl need POSIX ones.
posix() { if command -v cygpath > /dev/null; then cygpath -u "$1"; else printf '%s' "$1"; fi; }
out=$(posix "$3")

sha() { sha256sum < "$1" | cut -d' ' -f1; }

mkdir -p "$(dirname "$out")"
if [ -f "$out" ] && [ "$(sha "$out")" = "$want" ]; then
  echo "cached: $out"
  exit 0
fi
curl --fail --silent --show-error --location --retry 3 --retry-all-errors -o "$out" "$url"
got=$(sha "$out")
if [ "$got" != "$want" ]; then
  rm -f "$out"
  echo "::error::sha256 mismatch for $url: expected $want, got $got"
  exit 1
fi
echo "verified: $url"
