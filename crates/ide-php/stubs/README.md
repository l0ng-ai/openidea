# Bundled phpstorm-stubs

`phpstorm-stubs.zip` holds the built-in PHP declarations the native engine embeds
(`ide_php::stubs`): the extension folders' `.php` files of
[JetBrains/phpstorm-stubs](https://github.com/JetBrains/phpstorm-stubs) `v2026.2`
(commit `709e512210784a7c0a677b3a89d35def844a59b9`), unmodified, plus the release's
`LICENSE` (Apache-2.0) and `README.md`. The documentation comments contain material by the
PHP Documentation Group under CC-BY 3.0. See `THIRD_PARTY_LICENSES.md`.

Why a checked-in archive of sources:

- It is how the repo bundles other third-party assets (the Lombok jar is checked in), and
  it keeps builds offline: nothing is fetched at build time.
- The summary format changes with the engine's phases, so a pre-built summary set would
  have to be regenerated each time; the sources are parsed and summarised once per process
  instead (in parallel, well under a second).
- Hover and goto definition need the stub text anyway.

To move to a new release, change `TAG`/`COMMIT` in `scripts/php-stubs.sh` and
`STUBS_TAG`/`STUBS_COMMIT` in `crates/ide-php/src/stubs/mod.rs`, then run the script.
