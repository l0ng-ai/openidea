#!/usr/bin/env bash
# Builds the repository's plugins: Rust code into WebAssembly components
# (wasm32-wasip2 emits a component directly; no cargo-component / wasm-tools),
# and web pages (`web-src/`, a Vite project) into `web/`.
#
#   plugins/build.sh                 # every plugin with code or a web page
#   plugins/build.sh official/csv-editor  # one plugin (a path under plugins/, or any path)
#   plugins/build.sh --check [...]   # change nothing tracked; fail if a checked-in
#                                    # component is stale or a plugin doesn't build (CI)
#
# Output: <plugin>/dist/plugin.wasm (referenced by `wasm = ...` in plugin.toml)
# and <plugin>/dist/plugin.wasm.sources, a fingerprint of the sources it was
# built from: the plugin (minus target/, dist/, web/ and web-src/), the SDK
# and wit/. Components are small and checked in; builds are not
# byte-reproducible across machines, so --check compares fingerprints, not
# bytes. A web page (web-src/, a pnpm project) is built into <plugin>/web/,
# which is not checked in (it can be tens of MB): build it before installing
# the plugin from the repository. web.sources (not checked in either) skips
# rebuilding an unchanged page; --check builds it too and checks the result.
# CARGO_TARGET_DIR, when set, is shared by all plugins.
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
    { grep -Ev '(^|/)(dist|target|node_modules)/|(^|/)\.DS_Store$|^web(-src)?/|^web\.sources$' || true; } | LC_ALL=C sort -u | while read -r f; do
      if [ -f "$dir/$f" ]; then printf '%s %s\n' "$f" "$(sha256 <"$dir/$f" | cut -d' ' -f1)"; fi
    done
}

# Prints the fingerprint of everything plugin $1's component is built from.
fingerprint() {
  { list "$1" .; list "$repo" sdk/rust/openidea-plugin/Cargo.toml sdk/rust/openidea-plugin/src sdk/rust/openidea-plugin/wit wit; } |
    sha256 | cut -d' ' -f1
}

# Prints the fingerprint of plugin $1's web page sources.
web_fingerprint() {
  (cd "$1/web-src" && git ls-files --cached --others --exclude-standard -- .) |
    { grep -Ev '(^|/)node_modules/|(^|/)\.DS_Store$' || true; } | LC_ALL=C sort -u | while read -r f; do
      if [ -f "$1/web-src/$f" ]; then printf '%s %s\n' "$f" "$(sha256 <"$1/web-src/$f" | cut -d' ' -f1)"; fi
    done | sha256 | cut -d' ' -f1
}

# Builds plugin $1's web page into web/ unless it was built from the current
# web-src/, then checks what the manifest's `web = "…"` entries need: each
# page is there and loads its files by relative URL (it is served from the package).
build_web() {
  local dir="$1" rel="${1#"$repo"/}" want entry
  want="$(web_fingerprint "$dir")"
  if [ "$want" != "$(cat "$dir/web.sources" 2>/dev/null || true)" ] || [ ! -d "$dir/web" ]; then
    echo "building the web page of $rel"
    if ! { pnpm --dir "$dir/web-src" install --frozen-lockfile --ignore-workspace --silent &&
      pnpm --dir "$dir/web-src" run build; }; then
      echo "FAIL $rel: the web page does not build"
      failed=1
      return
    fi
    echo "$want" >"$dir/web.sources"
  fi
  for entry in $(sed -n 's/^web *= *"\(.*\)".*/\1/p' "$dir/plugin.toml" | sort -u); do
    if [ ! -f "$dir/$entry" ]; then
      echo "FAIL $rel: $entry was not built"
      failed=1
    elif grep -Eq '(src|href)="/' "$dir/$entry"; then
      echo "FAIL $rel: $entry loads files by absolute URL; build it with relative paths (Vite: base: \"./\")"
      failed=1
    fi
  done
  echo "ok $rel (web, $(du -sh "$dir/web" | cut -f1))"
}

failed=0
build() {
  local dir="$1"
  if [ -f "$dir/web-src/package.json" ]; then build_web "$dir"; fi
  [ -f "$dir/Cargo.toml" ] || return 0
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
  # Every component (plugin.toml + Cargo.toml) and web page (plugin.toml + web-src/).
  for manifest in "$here"/official/*/plugin.toml "$repo"/crates/ide-plugin/tests/fixtures/*/plugin.toml; do
    dir="$(dirname "$manifest")"
    if [ -f "$dir/Cargo.toml" ] || [ -f "$dir/web-src/package.json" ]; then build "$dir"; fi
  done
fi
exit "$failed"
