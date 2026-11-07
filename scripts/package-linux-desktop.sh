#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <rust-target> <executable> <output-directory>" >&2
  exit 2
fi

target=$1
binary=$2
out_dir=$3
case "$target" in
  x86_64-unknown-linux-gnu) arch=x86_64 ;;
  aarch64-unknown-linux-gnu) arch=aarch64 ;;
  *) echo "unsupported Linux target: $target" >&2; exit 1 ;;
esac

if [ ! -f "$binary" ] || [ ! -x "$binary" ]; then
  echo "expected an executable binary at $binary" >&2
  exit 1
fi

mkdir -p "$out_dir"
asset="openidea-linux-${arch}.tar.gz"
tar -czf "$out_dir/$asset" -C "$(dirname "$binary")" "$(basename "$binary")"
(cd "$out_dir" && sha256sum "$asset" > "$asset.sha256")
