#!/usr/bin/env bash
# Rebuild crates/ide-php/stubs/phpstorm-stubs.zip, the built-in PHP declarations the native
# engine embeds, from the pinned JetBrains/phpstorm-stubs release. Needs git and cargo.
# The archive is checked in, so this only runs when moving to a new release: change TAG and
# COMMIT here and STUBS_TAG / STUBS_COMMIT in crates/ide-php/src/stubs/mod.rs together.
#   scripts/php-stubs.sh   clone into target/phpstorm-stubs-src (reused when on COMMIT) and pack
set -euo pipefail

cd "$(dirname "$0")/.."
TAG=v2026.2
COMMIT=709e512210784a7c0a677b3a89d35def844a59b9
SRC=target/phpstorm-stubs-src
OUT=crates/ide-php/stubs/phpstorm-stubs.zip

if [[ -d "$SRC/.git" ]] && [[ "$(git -C "$SRC" rev-parse HEAD)" == "$COMMIT" ]]; then
    echo "ok       phpstorm-stubs $TAG already in $SRC"
else
    if [[ -e "$SRC" ]]; then
        echo "$SRC exists but is not phpstorm-stubs $TAG; delete it and run again" >&2
        exit 1
    fi
    git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$TAG" \
        https://github.com/JetBrains/phpstorm-stubs.git "$SRC"
    have=$(git -C "$SRC" rev-parse HEAD)
    if [[ "$have" != "$COMMIT" ]]; then
        echo "tag $TAG is at $have, expected $COMMIT" >&2
        exit 1
    fi
fi

cargo run --quiet -p ide-php --example pack_stubs -- "$SRC" "$OUT"
