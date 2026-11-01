# QA fixtures

Small, realistic projects for manual QA and end-to-end tests of OpenIDEA. Each one
has a few source files, passing tests, an **opt-in failing test**, `TODO`/`FIXME`
comments and at least one **intentional warning**, so every IDE feature has
something to show.

| Fixture          | Toolchain                                                       | Run                                 | Tests                | Failing test                          | Intentional warning                                      |
| ---------------- | --------------------------------------------------------------- | ----------------------------------- | -------------------- | ------------------------------------- | -------------------------------------------------------- |
| `rust-app/`      | cargo                                                           | `cargo run`                         | `cargo test`         | `cargo test --features failing-tests` | unused variable in `src/parser.rs`                       |
| `ts-app/`        | Node 22+, pnpm/npm                                              | `pnpm start`                        | `pnpm test` (vitest) | `OPENIDEA_FAIL=1 pnpm test`               | unused function in `src/index.ts`                        |
| `python-app/`    | Python 3.10+, pytest                                            | `python -m tasks.cli` (from `src/`) | `pytest`             | `OPENIDEA_FAIL=1 pytest`                  | unused imports in `models.py`                            |
| `go-app/`        | Go 1.22+                                                        | `go run ./cmd/server`               | `go test ./...`      | `OPENIDEA_FAIL=1 go test ./...`           | unused `fmt.Sprintf` result in `internal/store/store.go` |
| `kotlin-gradle/` | JDK 21, Gradle 8 (no wrapper)                                   | `gradle run`                        | `gradle test`        | `gradle test -PopenideaFail`              | unused variable in `App.kt`                              |
| `polyglot/`      | Go, TS, Python, C, shell, SQL, TOML/YAML/JSON, proto, Terraform | `make`                              | `make test`          | —                                     | unused variable in `native/hash.c`                       |

The fixtures are standalone: `rust-app` declares its own `[workspace]` and
`fixtures/eslint.config.js` keeps them out of the IDE's own lint run.

## Setup

`astro-app/` is a small Astro project for mixed-language highlighting and official
language-server checks. Copy it outside the checkout and run `npm install`;
see [Astro support](../docs/astro.md) for the opt-in LSP test and prerequisites.

Work on a **copy** so git and edits never touch this repository:

```sh
cp -R fixtures/rust-app /tmp/qa-rust && cd /tmp/qa-rust
git init -q && git add -A && git commit -qm "initial"   # for the VCS checks
```

Then open the folder with **File › Open…** (`⌘⇧⌥O`) or from the Welcome screen.
For `ts-app` / `polyglot/web` run `pnpm install` first; for `python-app` create a
venv (`python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'`).

Missing language servers / debuggers can be installed from the IDE:
**Settings › Languages & Frameworks › Language Servers**, or from the
"… is not installed — Install" notification shown when a file is opened.

## QA checklist

Run each block on at least `rust-app` and one other fixture; tick `polyglot` for
language detection and highlighting.

### Open & workbench

- [ ] Opening the folder shows the project name in the title bar, the Project tool
      window (`⌘1`) on the left, stripes on both sides and the status bar.
- [ ] Indexing progress appears in the status bar and finishes.
- [ ] Closing and reopening the window restores open tabs and tool windows.

### Project tree

- [ ] Arrow keys move the selection; `→`/`←` expand/collapse; `Enter`/`F4` opens a file.
- [ ] Ignored folders (`target/`, `node_modules/`, `build/`) appear dimmed.
- [ ] New file (`⌘N`), rename (`⇧F6`), delete (`⌫`) work and the tree updates.

### Search Everywhere & navigation

- [ ] Double `⇧` opens Search Everywhere; typing `parser` finds `src/parser.rs`.
- [ ] `⌘O` (classes) finds `Inventory` / `Cart` / `TaskList` / `Library`.
- [ ] `⌘⇧O` (files) and `⌘⌥O` (symbols) find `format_price` / `formatMoney`.
- [ ] `⌘E` lists recent files; `⌘[` / `⌘]` navigate back/forward.
- [ ] `⌘B` on a call (`format_price` in `main.rs`, `cart.total()` in `index.ts`)
      jumps to the declaration; `⌥F7` lists usages.
- [ ] `⌘F12` shows the file structure; `⌘L` goes to a line.

### Editing & code insight

- [ ] Typing in a file marks the tab modified; `⌘S` saves; external edits reload.
- [ ] `⌘F` opens the find bar (match case / words / regex); `⌘R` replaces.
- [ ] `⌘⇧F` finds `TODO` across the project and opens results.
- [ ] Completion (`⌃Space`) on `inventory.` / `cart.` / `tasks.` lists members.
- [ ] Hover / `F1` shows documentation; `⌘P` shows parameter info.
- [ ] Warnings: the intentional warning is underlined and listed in Problems (`⌘6`);
      `F2` jumps to it; `⌥Enter` offers a quick fix.
- [ ] Rename (`⇧F6`) `total_value` / `subtotal` / `pending` updates every usage
      (check the preview) and undo restores them.
- [ ] Reformat (`⌘⌥L`), comment line (`⌘/`), duplicate line (`⌘D`) and extend
      selection (`⌥↑`) behave like IDEA.

### TODO

- [ ] The TODO tool window lists every `TODO`/`FIXME` in the fixture and opens them.

### Run configurations & tests

- [ ] Run configurations are detected: cargo run/test (Rust), package.json scripts
      (TS), pytest (Python), `go test` / `go run` (Go), Gradle tasks (Kotlin).
- [ ] Gutter run icons appear next to `main` and test functions; running one opens
      the Run tool window (`⌘4`) with the output.
- [ ] The test tree shows passed tests; enabling the failing test (table above)
      shows it red with the assertion message and a link to the source line.
- [ ] `⌘F2` stops a running process (try `go run ./cmd/server`).

### Debugger

- [ ] Each fixture's entry point has a "Set a breakpoint here" comment: toggle a
      breakpoint there (`⌘F8`) and start debugging (`⌃D`).
- [ ] Execution stops on the line; Frames and Variables show `inventory` / `cart` /
      `tasks` / `library`; inline values appear in the editor.
- [ ] Step over (`F8`), into (`F7`), out (`⇧F8`), resume (`⌘⌥R`) and evaluate (`⌥F8`).
- [ ] If the debug adapter is missing (CodeLLDB, debugpy, Delve), the error offers
      the installer and debugging works after installing.

### Git

- [ ] Edited lines show gutter change markers; the tree and tabs colour modified files.
- [ ] Commit tool window (`⌘0` / `⌘K`) lists changes with a diff; partial staging works.
- [ ] Committing clears the changes; Git log (`⌘9`) shows the commit; blame works.
- [ ] Creating and switching branches from the status bar widget works.

### Terminal

- [ ] `⌥F12` opens the terminal in the project root; run the test command there.
- [ ] Several tabs, resize, copy/paste and `exit` behave; the shell's `PATH` includes
      tools installed by the IDE.

### Settings & installer

- [ ] `⌘,` opens Settings; search finds "Language Servers".
- [ ] Language Servers lists each tool with languages, status (Installed / On PATH /
      Missing) and version; Install streams progress and can be cancelled;
      Uninstall removes managed tools. Nothing downloads without clicking Install.
