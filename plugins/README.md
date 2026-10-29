# Writing OpenIDEA plugins

OpenIDEA plugins are sandboxed **WebAssembly components** (wasmtime, component
model, WASI preview 2), in the style of Zed extensions. A plugin can register
commands (they become IDE actions you can search for and bind to keys), read
project files, insert text into the editor, show notifications and contribute
themes and languages. Plugins that only contribute themes or languages need no
code at all.

```
plugins/
├─ build.sh                 # builds Rust plugins into components
├─ hello/                   # Rust plugin: two commands
└─ language-toy/            # manifest-only: a language definition
```

The API is defined in [`wit/plugin.wit`](../wit/plugin.wit) (`openidea:plugin/plugin@0.1.0`).

## 1. The package

A plugin is a directory with a `plugin.toml`:

```toml
id = "hello"                    # [a-z0-9][a-z0-9_-]*, unique
name = "Hello"
version = "0.1.0"               # semver
description = "Inserts today's date and counts words."
authors = ["You <you@example.com>"]
homepage = "https://example.com" # optional
openidea-api = "0.1"                # API version this plugin targets
wasm = "dist/plugin.wasm"       # omit for contribution-only plugins
permissions = ["project-read", "editor-read", "editor-write"]

# Optional static contributions (active even before / without code):
[[contributes.commands]]
id = "insert-date"              # [a-z0-9][a-z0-9._-]*
title = "Hello: Insert Date"
category = "Hello"              # group in Search Everywhere / Keymap

[[contributes.themes]]
path = "themes/my-theme.json"

[[contributes.languages]]
path = "languages/my-lang.toml"
```

All paths are relative to the package directory and may not leave it.

### Permissions

| Permission     | Unlocks                                           |
| -------------- | ------------------------------------------------- |
| `project-read` | `workspace-root`, `read-file` (project root only) |
| `editor-read`  | `active-file`                                     |
| `editor-write` | `insert-text`, `replace-selection`                |

`log`, `register-command`, `show-notification`, `register-language` and
`register-theme` are always available. Calling a gated function without its
permission **traps**: the plugin is stopped and the user is told which
permission is missing.

## 2. Writing code (Rust)

`wasm32-wasip2` produces a component directly, so all you need is rustup:

```sh
rustup target add wasm32-wasip2
```

`Cargo.toml`:

```toml
[package]
name = "my-plugin"
version = "0.1.0"
edition = "2024"

[workspace]              # keep it out of any parent workspace

[lib]
crate-type = ["cdylib"]

[dependencies]
wit-bindgen = "0.63"

[profile.release]
opt-level = "s"
lto = true
strip = true
panic = "abort"
```

`src/lib.rs`:

```rust
wit_bindgen::generate!({ world: "plugin", path: "path/to/openidea/wit" });

use openidea::plugin::host::{self, LogLevel, NotificationLevel};

struct MyPlugin;

impl Guest for MyPlugin {
    fn activate(_ctx: Context) -> Result<(), String> {
        host::register_command("shout", "My Plugin: Shout Selection", Some("My Plugin"));
        Ok(())
    }

    fn deactivate() {}

    fn run_command(id: String, arg: Option<String>) -> Result<Option<String>, String> {
        match id.as_str() {
            "shout" => {
                host::replace_selection(&arg.unwrap_or_default().to_uppercase());
                Ok(None)
            }
            _ => Err(format!("unknown command {id}")),
        }
    }
}

export!(MyPlugin);
```

Build (copy `build.sh` or run it with your plugin's path):

```sh
plugins/build.sh hello                 # → plugins/hello/dist/plugin.wasm
plugins/build.sh /path/to/my-plugin
```

Any language with component-model tooling works (e.g. `componentize-py`,
`jco componentize`, TinyGo): the only contract is the `plugin` world.

### Host functions

| Function                                 | Notes                                                                                                                                    |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `log(level, msg)`                        | Goes to the IDE log, tagged with the plugin id. `eprintln!` output is logged too and shown when the plugin crashes.                      |
| `register-command(id, title, category?)` | Becomes action `plugin.<plugin-id>.<id>`; call again to rename. Max 256 commands.                                                        |
| `show-notification(level, title, body)`  | Balloon in the invoking window.                                                                                                          |
| `workspace-root()`                       | Root of the project the command runs in.                                                                                                 |
| `active-file()`                          | Absolute path of the focused editor's file.                                                                                              |
| `read-file(path)`                        | Absolute or project-relative; `..`/symlinks escaping the root are rejected; UTF-8 only, ≤ 16 MiB. Unsaved editor contents win over disk. |
| `insert-text(text)`                      | Inserts at every cursor of the active editor (cursor ends after the text).                                                               |
| `replace-selection(text)`                | Replaces every selection and selects the new text.                                                                                       |
| `register-language(toml)`                | Same format as `languages/<id>.toml`.                                                                                                    |
| `register-theme(json)`                   | See _Themes_ below.                                                                                                                      |

`run-command` receives an optional string argument: `executeAction("plugin.hello.insert-date", "arg")`
from another feature, or nothing when run from Search Everywhere / a shortcut.
Returning `Err(msg)` shows _"<title> failed: msg"_; the plugin keeps running.

### Sandbox and limits

Each plugin gets its own wasmtime `Store`: no preopened directories, no
environment, no network, no inherited stdio — only clocks and randomness from
WASI, plus the host functions above. Every call into the plugin is bounded:

- **CPU:** a fuel budget (≈ 5·10⁹ wasm instructions) per call;
- **time:** 5 s wall clock per call (epoch interruption);
- **memory:** 256 MiB of linear memory.

A panic, trap, permission violation or exceeded limit stops the plugin and
marks it _Failed_ for the session (with the reason in Settings › Plugins);
toggling it off and on, or _Reload_, starts a fresh instance. The IDE itself is
never affected.

## 3. Themes

```json
{
  "id": "harbor-night",
  "name": "Harbor Night",
  "kind": "dark",
  "tokens": { "--bg-app": "#14171c", "--accent": "#2b9e93", "--syn-keyword": "#e0a46e" }
}
```

Tokens are the CSS variables of `src/styles/tokens.css` (`--bg-*`, `--fg-*`,
`--border*`, `--accent`, `--syn-*`, `--vcs-*`, `--gutter-*`, …). Unlisted tokens
keep the values of the built-in base named by `kind`. Values must be plain CSS
values (no `url()`, `;`, braces); `//` and `/* */` comments are allowed. A
manifest theme entry may add `editor-scheme = "themes/x.scheme.json"` (editor
colours, merged over the theme). Pick a theme in Settings › Plugins › _Apply_.

Start from [`templates/theme-plugin`](../templates/theme-plugin); the full guide,
token reference and IntelliJ / VS Code porting tables are in
[`docs/plugins/themes.md`](../docs/plugins/themes.md).

## 4. Languages

`languages/<id>.toml` files use the IDE's own language format; see any file in
[`languages/`](../languages) (`id`, `name`, `extensions`, `filenames`,
`first-line`, `line-comment`, `block-comment`, `indent`, `ui-mode`,
`framework-ui-modes`, `language-servers`, `debugger`). `language-toy` is a
minimal example. `[[framework-ui-modes]]` entries (`ui-mode`, `root-markers`)
replace `ui-mode` for the files of a framework's projects: the first whose
root marker is in a directory above the file, up to the project folder, applies
(see [`languages/html.toml`](../languages/html.toml), Angular templates).
Markers are matched like a language server's `root-markers`.

## 5. Installing and developing

- **Install:** Settings › Plugins › _Install Plugin from Disk…_ (or the action
  _Install Plugin from Disk…_) and pick the package folder. The manifest and the
  files it references are copied to `<app-data>/plugins/<id>/`.
- **Dev plugins:** put (or symlink) the package in `<project>/.openidea/plugins/<name>/`.
  It loads when the project is opened, is listed with a _dev_ tag, and _Reload_
  (or the _Reload Plugins_ action) picks up a rebuilt `plugin.wasm` without
  restarting the IDE.
- Commands appear in Search Everywhere › Actions under their category, and can
  be bound in Settings › Keymap like any other action.

## 6. Testing

The host's integration tests (`crates/ide-plugin/tests/host.rs`) load the
checked-in `hello` and test-fixture components; rebuild them after changing the
WIT file:

```sh
plugins/build.sh hello
plugins/build.sh crates/ide-plugin/tests/fixtures/misbehave
cargo test -p ide-plugin
```
