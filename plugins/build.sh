#!/usr/bin/env bash
# Builds Rust plugins into WebAssembly components (wasm32-wasip2 emits a
# component directly; no cargo-component / wasm-tools needed).
#
#   plugins/build.sh            # all plugins with a Cargo.toml
#   plugins/build.sh hello      # one plugin
#
# Output: <plugin>/dist/plugin.wasm (referenced by `wasm = ...` in plugin.toml).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
rustup target list --installed | grep -qx wasm32-wasip2 || rustup target add wasm32-wasip2

# Plugins with C sources (tree-sitter grammars) need a WASI sysroot and a clang
# that targets wasm32: wasi-sdk, or Homebrew's wasi-libc + llvm. Set
# WASI_SYSROOT (and CC_wasm32_wasip2) yourself to use another one.
if [ -z "${WASI_SYSROOT:-}" ]; then
  for candidate in "${WASI_SDK_PATH:-}/share/wasi-sysroot" /opt/homebrew/opt/wasi-libc/share/wasi-sysroot /usr/local/opt/wasi-libc/share/wasi-sysroot /opt/wasi-sdk/share/wasi-sysroot; do
    if [ -d "$candidate/include" ]; then export WASI_SYSROOT="$candidate"; break; fi
  done
fi
if [ -n "${WASI_SYSROOT:-}" ]; then
  export CFLAGS_wasm32_wasip2="${CFLAGS_wasm32_wasip2:---sysroot=$WASI_SYSROOT}"
  if [ -z "${CC_wasm32_wasip2:-}" ]; then
    for cc in "${WASI_SDK_PATH:-}/bin/clang" /opt/homebrew/opt/llvm/bin/clang /usr/local/opt/llvm/bin/clang clang; do
      if command -v "$cc" >/dev/null 2>&1 && "$cc" --print-targets 2>/dev/null | grep -q wasm32; then export CC_wasm32_wasip2="$cc"; break; fi
    done
  fi
fi

build() {
  local dir="$1"
  local name
  name="$(sed -n 's/^name *= *"\(.*\)"/\1/p' "$dir/Cargo.toml" | head -1)"
  echo "building $name ($dir)"
  CARGO_TARGET_DIR="$dir/target" cargo build --manifest-path "$dir/Cargo.toml" --release --target wasm32-wasip2
  mkdir -p "$dir/dist"
  cp "$dir/target/wasm32-wasip2/release/${name//-/_}.wasm" "$dir/dist/plugin.wasm"
  echo "  -> $dir/dist/plugin.wasm ($(wc -c < "$dir/dist/plugin.wasm" | tr -d " ") bytes)"
}

if [ $# -gt 0 ]; then
  for p in "$@"; do
    case "$p" in /*) build "$p" ;; *) build "$here/$p" ;; esac
  done
else
  for manifest in "$here"/*/Cargo.toml; do build "$(dirname "$manifest")"; done
fi
