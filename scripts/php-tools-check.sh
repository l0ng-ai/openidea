#!/usr/bin/env bash
# Check the tools the PHP engine roadmap needs (docs/php-engine/RULES.md › Tools):
#   - intelephense starts with --stdio and answers a scripted LSP initialize
#   - cargo-nextest is installed
#   - the corpora are cloned at their pinned tags (scripts/php-corpus.sh --check)
# Exit status 1 if any check fails.
set -uo pipefail

cd "$(dirname "$0")/.."
status=0

lsp_frame() { printf 'Content-Length: %d\r\n\r\n%s' "${#1}" "$1"; }

if command -v intelephense >/dev/null; then
    root=$(mktemp -d)
    init='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"processId":null,"rootUri":null,"capabilities":{}}}'
    out=$(
        {
            lsp_frame "$init"
            # Like a real client, wait for the initialize result before `initialized`:
            # Intelephense crashes when it gets `initialized` first.
            for _ in $(seq 1 60); do
                sleep 0.5
                grep -q '"capabilities"' "$root/reply" 2>/dev/null && break
            done
            lsp_frame '{"jsonrpc":"2.0","method":"initialized","params":{}}'
            sleep 2
            lsp_frame '{"jsonrpc":"2.0","id":2,"method":"shutdown","params":null}'
            for _ in $(seq 1 20); do
                sleep 0.5
                grep -q '"id":2' "$root/reply" 2>/dev/null && break
            done
            lsp_frame '{"jsonrpc":"2.0","method":"exit","params":null}'
        } | timeout 60 intelephense --stdio 2>&1 | tee "$root/reply"
    )
    rm -rf "$root"
    if [[ "$out" == *'"id":1,"result":{"capabilities"'* && "$out" == *'"id":2,"result"'* ]]; then
        version=$(npm ls -g intelephense 2>/dev/null | grep -o 'intelephense@[^ ]*' || echo intelephense)
        echo "ok       $version answers initialize and shutdown"
    else
        echo "FAIL     intelephense --stdio did not answer initialize and shutdown:" >&2
        printf '%s\n' "$out" | awk 'length($0) < 400' | tail -20 >&2
        status=1
    fi
else
    echo "missing  intelephense (npm i -g intelephense)" >&2
    status=1
fi

if cargo nextest --version >/dev/null 2>&1; then
    echo "ok       $(cargo nextest --version 2>/dev/null | head -1)"
else
    echo "missing  cargo-nextest (see docs/php-engine/RULES.md › Tools)" >&2
    status=1
fi

bash scripts/php-corpus.sh --check || status=1
exit $status
