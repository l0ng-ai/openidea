# PHP engine progress

One line per finished or blocked phase: `- YYYY-MM-DD · Phase N.M Title · what was done · follow-ups`.

- 2026-11-05 · Phase 0.1 Roadmap harness · rules, roadmap (Plans 0–7), progress log and scripts/php-engine-loop.sh · headless sessions need a permissions allowlist in .claude/settings.local.json (added by the user)
- 2026-11-05 · Phase 0.2 Tools and corpora · scripts/php-corpus.sh clones laravel/framework v13.40.0, symfony v8.1.11 and WordPress 7.1.4 (16,629 .php files) into ../php-corpus; scripts/php-tools-check.sh verifies Intelephense 1.18.5 answers a scripted initialize and shutdown over --stdio, cargo-nextest 0.9.151 is installed and the corpora are on their tags (all ok); install notes in RULES.md › Tools · Intelephense crashes if `initialized` comes before the `initialize` result, so scripted clients must wait for it
