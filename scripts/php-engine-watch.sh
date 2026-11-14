#!/usr/bin/env bash
# Follow the PHP engine roadmap loop live: the roadmap tally, the last commits, then every step
# of every session as it happens (logs/php-engine/live.log, written by php-engine-loop.sh).
cd "$(dirname "$0")/.."
ROADMAP=docs/php-engine/ROADMAP.md
LIVE=logs/php-engine/live.log
mkdir -p logs/php-engine
touch "$LIVE"
echo "Roadmap: $(grep -c '^- \[x\]' "$ROADMAP") done, $(grep -c '^- \[ \]' "$ROADMAP") open, $(grep -c '^- \[!\]' "$ROADMAP") blocked"
echo "Next:    $(grep -m1 '^- \[ \]' "$ROADMAP" | sed 's/^- \[ \] //')"
echo "Recent commits:"
git log --oneline -5 main..HEAD | sed 's/^/  /'
echo "──────── live ────────"
exec tail -n 40 -F "$LIVE"
