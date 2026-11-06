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
# Each rustc/link.exe can take 2+ GB; unlimited parallel jobs ran the machine out of memory.
# Sessions inherit this, so their own cargo runs are limited too.
export CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-4}
# The incremental cache grew to 35 GB under target/ and filled the disk. Sessions inherit this.
export CARGO_INCREMENTAL=0
# After each phase, drop build output not used for a day, then the oldest until target/ is
# under SWEEP_MAX. Needs cargo-sweep (cargo install cargo-sweep --locked); skipped if missing.
SWEEP_MAX=${SWEEP_MAX:-60GB}
sweep() {
    command -v cargo-sweep >/dev/null || return 0
    cargo sweep --time 1 >/dev/null 2>&1
    cargo sweep --maxsize "$SWEEP_MAX" >/dev/null 2>&1
    say "swept target/: $(du -sh target 2>/dev/null | cut -f1)"
}

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

KNOWN=docs/php-engine/known-failures.txt
LOCK=$LOGS/loop.pid
if [[ -f "$LOCK" ]] && kill -0 "$(cat "$LOCK")" 2>/dev/null; then
    echo "another php-engine loop is running (pid $(cat "$LOCK")); stop it first" >&2
    exit 1
fi
echo $$ >"$LOCK"
trap 'rm -f "$LOCK"' EXIT
# On a stop signal take the running session (claude, cargo, linkers) down with the loop,
# instead of leaving it to finish the phase and start the next check on its own.
on_signal() {
    trap '' INT TERM HUP
    say "loop stopped by a signal"
    kill -- -$$ 2>/dev/null
    kill 0 2>/dev/null
    exit 130
}
trap on_signal INT TERM HUP

say "loop started (pid $$): $(progress)"
stuck=0
for ((i = 1; i <= MAX_ITER; i++)); do
    next=$(grep -m1 '^- \[ \]' "$ROADMAP" || true)
    if [[ -z "$next" ]]; then
        say "no open phase left: $(progress)"
        blocked=$(grep '^- \[!\]' "$ROADMAP" || true)
        [[ -n "$blocked" ]] && printf 'Blocked phases:\n%s\n' "$blocked" | tee -a "$LIVE"
        exit 0
    fi
    prompt=$PROMPT
    if ! git diff --quiet || ! git diff --cached --quiet || [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
        if ((i > 1)); then
            say "the working tree has uncommitted changes before session $i: stopping"
            git status --short | tee -a "$LIVE"
            exit 1
        fi
        # The previous run was interrupted mid-phase: let the first session carry on from its work.
        say "resuming: the working tree holds unfinished work for this phase"
        git status --short | tee -a "$LIVE"
        prompt="$PROMPT The working tree already holds uncommitted work for this phase from an interrupted session (see git status and git diff). Review it, keep what is right, finish the phase from there, and include it in the one commit."
    fi
    head_before=$(git rev-parse HEAD)
    log=$(printf '%s/session-%s-%03d.log' "$LOGS" "$(date +%Y%m%d-%H%M%S)" "$i")
    say "════ session $i: ${next#- \[ \] } ($(progress))"
    claude -p "$prompt" --max-turns "$MAX_TURNS" --permission-mode acceptEdits \
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
    check=$LOGS/check-$i.log
    # Only failures that are not already known (docs/php-engine/known-failures.txt) count.
    new_failures() {
        grep -E '^test .* \.\.\. FAILED$' "$check" | sed -E 's/^test (.*) \.\.\. FAILED$/\1/' |
            grep -vxF -f <(grep -v '^#' "$KNOWN" | tr -d '\r') || true
    }
    passed=0
    cargo test "${crates[@]}" --no-fail-fast >"$check" 2>&1 && passed=1
    if ((!passed)) && [[ -n "$(new_failures)" ]]; then
        # Some tests time warm calls and can miss their budget under load: run once more.
        say "new failures, running the tests once more: $(echo $(new_failures))"
        cargo test "${crates[@]}" --no-fail-fast >"$check" 2>&1 && passed=1
    fi
    if ((!passed)); then
        new=$(new_failures)
        if [[ -n "$new" ]] || ! grep -qE '^test .* \.\.\. FAILED$' "$check"; then
            say "tests are red after session $i (see $check): stopping"
            [[ -n "$new" ]] && printf '  new failure: %s\n' $new | tee -a "$LIVE"
            exit 1
        fi
        say "only known failures (docs/php-engine/known-failures.txt)"
    fi
    say "tests green: $(progress)"
    sweep
done
say "reached MAX_ITER=$MAX_ITER"
exit 1
