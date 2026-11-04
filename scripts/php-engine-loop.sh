#!/usr/bin/env bash
# Work through docs/php-engine/ROADMAP.md one phase per headless Claude session, until no
# "- [ ]" phase is left. Each session follows docs/php-engine/RULES.md and makes one commit.
#   MAX_ITER (200)  sessions at most
#   MAX_TURNS (200) turns per session
#   MAX_STUCK (3)   sessions in a row without a commit before giving up
# Everything is streamed, as it happens, to the terminal and to logs/php-engine/live.log
# (watch it with scripts/php-engine-watch.sh); each session also has its own log.
set -uo pipefail

cd "$(dirname "$0")/.."
ROADMAP=docs/php-engine/ROADMAP.md
MAX_ITER=${MAX_ITER:-200}
MAX_TURNS=${MAX_TURNS:-200}
MAX_STUCK=${MAX_STUCK:-3}
LOGS=logs/php-engine
LIVE=$LOGS/live.log
mkdir -p "$LOGS"
export FORCE_COLOR=1

PROMPT='Follow docs/php-engine/RULES.md. Open docs/php-engine/ROADMAP.md, find the FIRST phase marked "- [ ]", and complete it end-to-end: read the design section and the code the phase names first, implement, write tests, run fmt + clippy + the required tests, fix everything until green, tick the checkbox, append to docs/php-engine/PROGRESS.md, and make ONE commit. Run every command in the foreground (never in the background, never wait for notifications): this session ends the moment you stop replying. Then stop. Do not start the next phase.'

say() { echo "$(date '+%F %T') $*" | tee -a "$LIVE"; }

progress() {
    local done open blocked
    done=$(grep -c '^- \[x\]' "$ROADMAP")
    open=$(grep -c '^- \[ \]' "$ROADMAP")
    blocked=$(grep -c '^- \[!\]' "$ROADMAP")
    echo "$done done, $open open, $blocked blocked"
}

branch=$(git rev-parse --abbrev-ref HEAD)
if [[ "$branch" != "feat/php-engine" ]]; then
    echo "run this on the feat/php-engine branch (now on $branch)" >&2
    exit 1
fi

say "loop started: $(progress)"
stuck=0
for ((i = 1; i <= MAX_ITER; i++)); do
    next=$(grep -m1 '^- \[ \]' "$ROADMAP" || true)
    if [[ -z "$next" ]]; then
        say "no open phase left: $(progress)"
        blocked=$(grep '^- \[!\]' "$ROADMAP" || true)
        [[ -n "$blocked" ]] && printf 'Blocked phases:\n%s\n' "$blocked" | tee -a "$LIVE"
        exit 0
    fi
    if ! git diff --quiet || ! git diff --cached --quiet; then
        say "the working tree has uncommitted changes before session $i: stopping"
        git status --short | tee -a "$LIVE"
        exit 1
    fi
    head_before=$(git rev-parse HEAD)
    log=$(printf '%s/session-%s-%03d.log' "$LOGS" "$(date +%Y%m%d-%H%M%S)" "$i")
    say "════ session $i: ${next#- \[ \] } ($(progress))"
    claude -p "$PROMPT" --max-turns "$MAX_TURNS" --permission-mode acceptEdits \
        --output-format stream-json --verbose 2>&1 |
        node scripts/php-engine-format.mjs | tee "$log" >>"$LIVE"
    head_after=$(git rev-parse HEAD)
    if [[ "$head_after" == "$head_before" ]]; then
        stuck=$((stuck + 1))
        say "session $i made no commit ($stuck in a row), log: $log"
        if ((stuck >= MAX_STUCK)); then
            say "giving up: $MAX_STUCK sessions in a row without a commit"
            exit 1
        fi
        continue
    fi
    stuck=0
    say "session $i committed $(git log -1 --format='%h %s')"
    if ! git diff --quiet || ! git diff --cached --quiet; then
        say "session $i left uncommitted changes: stopping"
        exit 1
    fi
    crates=(-p ide-host)
    [[ -d crates/ide-php ]] && crates=(-p ide-php -p ide-host)
    say "checking: cargo test ${crates[*]}"
    if ! cargo test "${crates[@]}" --quiet >"$LOGS/check-$i.log" 2>&1; then
        say "tests are red after session $i (see $LOGS/check-$i.log): stopping"
        exit 1
    fi
    say "tests green: $(progress)"
done
say "reached MAX_ITER=$MAX_ITER"
exit 1
