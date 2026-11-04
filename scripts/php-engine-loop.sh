#!/usr/bin/env bash
# Work through docs/php-engine/ROADMAP.md one phase per headless Claude session, until no
# "- [ ]" phase is left. Each session follows docs/php-engine/RULES.md and makes one commit.
#   MAX_ITER (200)  sessions at most
#   MAX_TURNS (200) turns per session
#   MAX_STUCK (3)   sessions in a row without a commit before giving up
set -uo pipefail

cd "$(dirname "$0")/.."
ROADMAP=docs/php-engine/ROADMAP.md
MAX_ITER=${MAX_ITER:-200}
MAX_TURNS=${MAX_TURNS:-200}
MAX_STUCK=${MAX_STUCK:-3}
LOGS=logs/php-engine
mkdir -p "$LOGS"

PROMPT='Follow docs/php-engine/RULES.md. Open docs/php-engine/ROADMAP.md, find the FIRST phase marked "- [ ]", and complete it end-to-end: read the design section and the code the phase names first, implement, write tests, run fmt + clippy + the required tests, fix everything until green, tick the checkbox, append to docs/php-engine/PROGRESS.md, and make ONE commit. Then stop. Do not start the next phase.'

branch=$(git rev-parse --abbrev-ref HEAD)
if [[ "$branch" != "feat/php-engine" ]]; then
    echo "run this on the feat/php-engine branch (now on $branch)" >&2
    exit 1
fi

stuck=0
for ((i = 1; i <= MAX_ITER; i++)); do
    next=$(grep -m1 '^- \[ \]' "$ROADMAP" || true)
    if [[ -z "$next" ]]; then
        echo "$(date '+%F %T') no open phase left."
        blocked=$(grep '^- \[!\]' "$ROADMAP" || true)
        [[ -n "$blocked" ]] && printf 'Blocked phases:\n%s\n' "$blocked"
        exit 0
    fi
    head_before=$(git rev-parse HEAD)
    log=$(printf '%s/session-%s-%03d.log' "$LOGS" "$(date +%Y%m%d-%H%M%S)" "$i")
    echo "$(date '+%F %T') session $i: $next"
    claude -p "$PROMPT" --max-turns "$MAX_TURNS" --permission-mode acceptEdits --output-format text >"$log" 2>&1
    head_after=$(git rev-parse HEAD)
    if [[ "$head_after" == "$head_before" ]]; then
        stuck=$((stuck + 1))
        echo "$(date '+%F %T') session $i made no commit ($stuck in a row), log: $log"
        if ((stuck >= MAX_STUCK)); then
            echo "$(date '+%F %T') giving up: $MAX_STUCK sessions in a row without a commit" >&2
            exit 1
        fi
        continue
    fi
    stuck=0
    echo "$(date '+%F %T') session $i committed $(git log -1 --format='%h %s')"
    if ! git diff --quiet || ! git diff --cached --quiet; then
        echo "$(date '+%F %T') session $i left uncommitted changes: stopping" >&2
        exit 1
    fi
    crates=(-p ide-host)
    [[ -d crates/ide-php ]] && crates=(-p ide-php -p ide-host)
    if ! cargo test "${crates[@]}" --quiet >"$LOGS/check-$i.log" 2>&1; then
        echo "$(date '+%F %T') tests are red after session $i (see $LOGS/check-$i.log): stopping" >&2
        exit 1
    fi
done
echo "$(date '+%F %T') reached MAX_ITER=$MAX_ITER" >&2
exit 1
