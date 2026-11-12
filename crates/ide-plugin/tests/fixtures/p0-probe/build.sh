#!/usr/bin/env bash
# Builds dist/min.wasm (probe-min) and dist/full.wasm (probe-full).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export CARGO_TARGET_DIR="$here/target"
mkdir -p "$here/dist"
cargo build --manifest-path "$here/Cargo.toml" --release --target wasm32-wasip2
cp "$CARGO_TARGET_DIR/wasm32-wasip2/release/openidea_p0_probe.wasm" "$here/dist/min.wasm"
cargo build --manifest-path "$here/Cargo.toml" --release --target wasm32-wasip2 --features full
cp "$CARGO_TARGET_DIR/wasm32-wasip2/release/openidea_p0_probe.wasm" "$here/dist/full.wasm"
ls -l "$here/dist"
