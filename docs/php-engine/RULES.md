# PHP engine roadmap: execution rules

These rules are for the sessions that work through `docs/php-engine/ROADMAP.md`. Usually that's the headless sessions started by `scripts/php-engine-loop.sh`. AGENTS.md applies as well. Where the two disagree, these rules win, but only for roadmap work.

## One phase per session

- `docs/php-engine/ROADMAP.md` is the source of truth. Boxes mean:
  - `- [ ]` to do
  - `- [x]` done
  - `- [!]` blocked, with the reason after the title
- Work on exactly one phase per session: the first `- [ ]` line in file order. Don't start the next one, and don't edit other phases. The exception is adding a new `- [ ]` follow-up phase directly after the current one, when the current phase turns out too large. In that case, finish a coherent part, describe the rest in the new phase, and tick the current one.
- First read the phase's paragraph and the design section of the roadmap. Then read the code it names. Reuse what's already there before writing anything new.

## Definition of done

1. The code does what the phase's paragraph says.
2. Tests cover the new and changed behaviour:
   - Unit tests in the crate. For `ide-php`, inline fixtures with a `/*|*/` caret marker.
   - Integration tests where the paragraph asks for them.
3. `cargo fmt --all` has been run.
4. `cargo clippy --workspace --all-targets -- -D warnings` passes.
5. `cargo test -p ide-php -p ide-host` passes, along with the tests of every other crate the phase touched. If frontend files changed, `pnpm typecheck` and `pnpm test` pass. If `src-tauri` commands changed, run `pnpm gen:bindings` and commit the result.
6. New user-visible text is added to both `src/platform/locales/text/en.json` and `zh.json`.
7. The phase line is changed to `- [x]`, and one line is added to `docs/php-engine/PROGRESS.md` in this format:
   `- YYYY-MM-DD · Phase N.M Title · what was done · follow-ups`
8. There is exactly one git commit containing the code, the roadmap tick and the progress line. Use this message, ending with these two lines:

   ```
   feat(php-engine): phase N.M <title>

   <one or two plain sentences>

   Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
   ```

## Never

- Never weaken, skip or delete an existing test to make things pass.
  - Never add `#[ignore]` to hide a failure. Tests that need installed tools or corpora are ignored by design and say so.
- Never push. Never switch branches. Never rewrite history (`reset --hard`, `rebase`, `commit --amend` on earlier phases).
- Never decompile, disassemble or copy code from PhpStorm, Intelephense or any other closed-source product.
  - Allowed design inputs: public documentation and open-source code under compatible licences (Mago, IntelliJ Community, phpactor, PHPStan, Psalm, phpstorm-stubs). Note the source in a comment when you adapt an idea.
- Don't add workspace-level lint allowances to silence clippy.

## Blocked

If a phase can't be done after a real effort (missing information, an external dependency, a product decision):

1. Change the line to `- [!] Phase N.M: Title — BLOCKED: <reason>`.
2. Add a PROGRESS line.
3. Commit (`chore(php-engine): block phase N.M`), then stop.

A product decision needs the `needs-decision` label from AGENTS.md. Write the question in the reason.

## Project notes

- The engine lives in `crates/ide-php`. It answers editor requests through the `LanguageService` dispatch in `crates/ide-host/src/ops/lsp.rs` (from phase 1.9), so the frontend doesn't change.
- IPC uses 0-based lines and **UTF-16** columns (`ide-core::text`, `ide-text`). Commands return `IdeResult<T>`.
- Long work runs on `spawn_blocking` or rayon and respects `CancellationToken`. It never runs on a Tauri command thread.
- The corpora (laravel/framework, symfony/symfony, WordPress) are in `D:\projects\php-corpus`, set up by `scripts/php-corpus.sh`. Tests that use them are `#[ignore]` and read `PHP_CORPUS_DIR`.

## Tools

Install these once per machine, then run `scripts/php-tools-check.sh`. It exits non-zero if anything is missing.

- **Intelephense** (the baseline the engine is compared against): `npm i -g intelephense`. It needs Node 18 or newer. It has no `--version` flag; the check script starts `intelephense --stdio` and sends a scripted `initialize`, `initialized` and `shutdown`. Send `initialized` only after the `initialize` result arrives, because Intelephense 1.18 crashes otherwise.
- **cargo-nextest:** use the prebuilt binary rather than compiling it.
  - Windows (Git Bash): `curl -LsSf https://get.nexte.st/latest/windows-tar | tar zxf - -C ~/.cargo/bin`
  - Linux: `curl -LsSf https://get.nexte.st/latest/linux | tar zxf - -C ~/.cargo/bin`
  - macOS: `curl -LsSf https://get.nexte.st/latest/mac | tar zxf - -C ~/.cargo/bin`
  - Anywhere, slower: `cargo install cargo-nextest --locked`

  Run tests with `cargo nextest run -p ide-php`. `cargo test` still works.

- **Corpora:** `scripts/php-corpus.sh` needs only git. It shallow-clones laravel/framework, symfony/symfony and WordPress/WordPress at the tags pinned in the script into `${PHP_CORPUS_DIR:-../php-corpus}` and skips any that are already there. `--check` only verifies them. To move to a new tag, change the script and delete that corpus directory.
