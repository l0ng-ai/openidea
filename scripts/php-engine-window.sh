#!/usr/bin/env bash
# Runs the roadmap loop in its own terminal window, outside any Claude Code session, so the
# loop isn't stopped together with that session. Keeps the window open when the loop ends.
cd "$(dirname "$0")/.."
bash scripts/php-engine-loop.sh
echo
read -rp "the loop has ended (see logs/php-engine/live.log); press Enter to close "
