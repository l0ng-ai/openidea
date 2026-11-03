#!/usr/bin/env bash
# Builds the repository's Rust plugins into WebAssembly components
# (wasm32-wasip2 emits a component directly; no cargo-component / wasm-tools).
#
#   plugins/build.sh                 # every component the repo checks in
#   plugins/build.sh hello           # one plugin (a name under plugins/, or a path)
#   plugins/build.sh --check [...]   # change nothing; fail if a checked-in component
#                                    # is stale or a plugin doesn't build (CI)
#
# Output: <plugin>/dist/plugin.wasm (referenced by `wasm = ...` in plugin.toml)
# and <plugin>/dist/plugin.wasm.sources, a fingerprint of the sources it was
# built from: the plugin (minus target/ and dist/), the SDK and wit/. Builds
# are not byte-reproducible across machines, so --check compares fingerprints,
# not bytes. CARGO_TARGET_DIR, when set, is shared by all plugins.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/.." && pwd)"
rustup target list --installed | grep -qx wasm32-wasip2 || rustup target add wasm32-wasip2

check=0
if [ "${1:-}" = "--check" ]; then
  check=1
  shift
fi

sha256() { if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi; }

# Lists "<path> <sha256>" for the files git sees (tracked, or new and not
# ignored) under the given paths of directory $1, minus build output and Finder
# metadata; so a
# checkout fingerprints the same as the working tree that committed it.
list() {
  local dir="$1"
  shift
  (cd "$dir" && git ls-files --cached --others --exclude-standard -- "$@") |
    { grep -Ev '(^|/)(dist|target)/|(^|/)\.DS_Store$' || true; } | LC_ALL=C sort -u | while read -r f; do
      if [ -f "$dir/$f" ]; then printf '%s %s\n' "$f" "$(sha256 <"$dir/$f" | cut -d' ' -f1)"; fi
    done
}

# Prints the fingerprint of everything plugin $1 is built from.
fingerprint() {
  { list "$1" .; list "$repo" sdk/rust/openidea-plugin/Cargo.toml sdk/rust/openidea-plugin/src sdk/rust/openidea-plugin/wit wit; } |
    sha256 | cut -d' ' -f1
}

failed=0
build() {
  local dir="$1"
  local name target out
  name="$(sed -n 's/^name *= *"\(.*\)"/\1/p' "$dir/Cargo.toml" | head -1)"
  target="${CARGO_TARGET_DIR:-$dir/target}"
  out="$target/wasm32-wasip2/release/${name//-/_}.wasm"
  local rel="${dir#"$repo"/}"
  if [ "$check" = 1 ]; then
    if ! CARGO_TARGET_DIR="$target" cargo build -q --locked --manifest-path "$dir/Cargo.toml" --release --target wasm32-wasip2; then
      echo "FAIL $rel: does not build"
      failed=1
      return
    fi
    local want have
    want="$(fingerprint "$dir")"
    have="$(cat "$dir/dist/plugin.wasm.sources" 2>/dev/null || true)"
    if [ "$want" != "$have" ]; then
      echo "STALE $rel: dist/plugin.wasm was not built from the current sources; run plugins/build.sh $rel"
      failed=1
    else
      echo "ok $rel"
    fi
    return
  fi
  echo "building $name ($rel)"
  CARGO_TARGET_DIR="$target" cargo build --manifest-path "$dir/Cargo.toml" --release --target wasm32-wasip2
  mkdir -p "$dir/dist"
  cp "$out" "$dir/dist/plugin.wasm"
  fingerprint "$dir" >"$dir/dist/plugin.wasm.sources"
  echo "  -> $rel/dist/plugin.wasm ($(wc -c <"$dir/dist/plugin.wasm" | tr -d " ") bytes)"
}

if [ $# -gt 0 ]; then
  for p in "$@"; do
    if [ -d "$here/$p" ]; then build "$here/$p"
    elif [ -d "$repo/$p" ]; then build "$(cd "$repo/$p" && pwd)"
    elif [ -d "$p" ]; then build "$(cd "$p" && pwd)"
    else echo "no plugin at $p" >&2; exit 2
    fi
  done
else
  # Every checked-in component built from a plugin.toml + Cargo.toml directory.
  for manifest in "$here"/*/Cargo.toml "$here"/official/*/Cargo.toml "$repo"/crates/ide-plugin/tests/fixtures/*/Cargo.toml; do
    dir="$(dirname "$manifest")"
    [ -f "$dir/plugin.toml" ] && build "$dir"
  done
fi
exit "$failed"
