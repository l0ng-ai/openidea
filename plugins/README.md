# Writing OpenIDEA plugins

OpenIDEA plugins are sandboxed **WebAssembly components** (wasmtime, component
model, WASI preview 2). A plugin can register commands (they become IDE actions
you can search for and bind to keys), read project files, edit the focused
editor, react to workbench events, run background tasks, show notifications
and status bar items, keep data in its own storage, read and fetch git
repositories, provide completion, quick fixes, navigation and gutter markers,
call web services and run approved programs, show tool windows and custom
editors, and contribute menus, shortcuts, settings, themes, file icon themes
and languages. Plugins that only contribute data (themes, icons, languages,
menus, settings) need no code at all.

> **Preview.** The plugin system ships as a preview and the official plugins
> are versioned `0.x`. Released API versions only grow: a plugin built for
> `openidea:plugin@1.0` keeps loading in later 1.x IDEs. See _Evolving the
> plugin API_ below.

```
plugins/
└─ official/
   ├─ harbor-night/           # data only: a colour theme (UI and editor scheme)
   ├─ material-icons/         # data only: a file icon theme
   ├─ solidity/               # language + syntax provider + run configurations
   ├─ string-tools/           # 26 text commands, versioned multi-cursor edits
   ├─ key-promoter/           # action events, storage
   ├─ git-toolbox/            # on-schedule fetch, tasks, VCS, status bar item
   ├─ checkstyle/             # one-shot process, diagnostics, quick fixes
   ├─ ai-completion/          # inline completion over the network, secrets
   ├─ mybatis/                # navigation, gutter markers, completion across files
   ├─ csv-editor/             # custom editor sharing the text document
   ├─ excalidraw/             # web view custom editor, file icons, a template
   ├─ graphviz/               # web view with code: live preview, problems from the page, a language
   ├─ regex-tester/           # html view talking to its code, settings, the editor's selection
   └─ license-header/         # file-opened events, quick fix, project scan in a task
sdk/rust/openidea-plugin/     # the Rust SDK (host API, Plugin trait, mock host)
crates/ide-plugin/tests/fixtures/  # test plugins: hello, jobs, language-toy, misbehave, semantic-tokens, hover, commit, inlay-hints
```

The plugin API is defined in [`wit/`](../wit/) (`openidea:plugin@1.3.0`, world
`plugin`).

## 1. Quick start

The `openidea-plugin` tool scaffolds, builds, checks and links plugins:

```sh
cargo install --locked --git https://github.com/l0ng-ai/openidea ide-host --bin openidea-plugin
# in a checkout of this repository: cargo install --path crates/ide-host --bin openidea-plugin

openidea-plugin new my-plugin                          # Rust command plugin (SDK)
openidea-plugin new my-theme --template theme          # also: icon-theme, language
cd my-plugin
cargo test                                             # logic, against the SDK's mock host
openidea-plugin build                                  # → dist/plugin.wasm, then `check`
openidea-plugin link                                   # load this folder in the IDE
```

Each release also attaches the tool for Linux x64
(`openidea-plugin-linux-x86_64.gz`). A plugin is a project of its own: keep it
in its own repository, and list it in the community marketplace when it is
ready (§8.1).

A Rust plugin made by `new` depends on the SDK of the tool's release, from
this repository's tag (`openidea-plugin = { git = "…", tag = "vX.Y.Z" }`);
change the tag to build against a later API. Inside a checkout of this
repository, or with `--sdk <path to sdk/rust/openidea-plugin>`, it depends on
that SDK by path instead.

`build` runs `cargo build --release --target wasm32-wasip2` (installing the
target through rustup if needed), copies the component to the manifest's
`wasm` path and runs `check`. `check` validates the package exactly as
_Install Plugin from Disk…_ would — manifest, every contribution, the SVG
sanitiser, the component — and that the component imports nothing but the
plugin API and WASI and links against the IDE's: every function it imports
exists with the same signature, and it exports the plugin world. It prints what the user will be asked to grant.

`link` adds the folder to `links.json` in the IDE's plugins directory
(`$OPENIDEA_PLUGINS_DIR`, default `<app-data>/ai.l0ng.openidea/plugins`). Linked
plugins are read from the folder itself, so the edit loop is `build` then
Settings › Plugins › _Reload_. `unlink` and `links` undo and list.

## 2. The package

A plugin is a directory with a `plugin.toml`:

```toml
id = "acme.word-tools"            # [a-z0-9][a-z0-9_-]*, optionally with dotted namespaces
name = "Word Tools"
version = "1.2.0"                 # semver
description = "Counts and transforms words."
authors = ["You <you@example.com>"]
homepage = "https://example.com"  # optional
license = "MIT"                   # optional
change-notes = "1.2.0 — …"        # shown under What's New
categories = ["tools"]            # marketplace categories, see below
icon = "icon.svg"                 # optional, see below
icon-dark = "icon_dark.svg"       # optional
engines.openidea = "^1.0"         # the plugin API this package needs
wasm = "dist/plugin.wasm"         # omit for data-only plugins
activation = ["on-language:markdown"]   # optional, see below

[capabilities]
required = ["project.read", "editor.write"]
optional = ["net:api.example.com"]

[[contributes.commands]]
id = "count"                      # [a-z0-9][a-z0-9._-]*
title = "Word Tools: Count Words"
category = "Word Tools"           # group in Search Everywhere / Keymap
when = "editorFocus"              # optional: same expressions as built-in actions
```

`categories` (up to 3) file the plugin in the marketplace: `languages`,
`themes`, `icon-themes`, `linters` (linters and formatters), `vcs`, `ai`,
`frameworks`, `tools`, `other`. Without them, a plugin contributing themes,
icon themes or languages is filed under those, any other under `other`.
Categories an IDE doesn't know, and any after the first three it knows, are
ignored (`check` warns about both).

`icon` is an SVG of the package shown in Settings › Plugins and the
marketplace; `icon-dark`, if given, replaces it with dark themes. Each is at
most 16 KiB and sanitised like file icons (no scripts, external references or
`foreignObject`); an invalid one fails the package. Without `icon`, the
plugin gets the generic plugin icon. `icon` is new in API 1.2: IDEs before it
refuse the manifest, so a package with one declares `engines.openidea = "^1.2"`
(`check` and installing refuse it otherwise).

All paths are relative to the package directory and may not leave it. A
manifest is validated as a whole: if one contribution is invalid, nothing is
installed or loaded. Contribution types the IDE does not know (a newer API) are
skipped with a warning.

Manifests in the 0.1 format (`openidea-api = "0.1"`, `permissions = [...]`)
still load (their permissions become required capabilities; contributions
work), but 0.1 code no longer runs: rebuild it against the 1.0 SDK.

### Contribution points

| Point           | Declaration                                                                                                                                                   | Code needed   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `commands`      | `id`, `title`, `category?`, `when?`                                                                                                                           | to run them   |
| `themes`        | `path` (theme JSON), `editor-scheme?`                                                                                                                         | no            |
| `iconThemes`    | `id`, `label`, `path` (icon theme JSON, see §5)                                                                                                               | no            |
| `languages`     | `path` (`languages/<id>.toml` format, see §6)                                                                                                                 | no            |
| `runDetectors`  | `id`, `name`, `files`, `command`, `args?`, `test?` (§6.2)                                                                                                     | no            |
| `providers`     | `kinds`, `languages` (editor providers, see _Providers_)                                                                                                      | yes           |
| `secrets`       | `name`, `label`, `description?` (see _Network_)                                                                                                               | to use them   |
| `menus`         | `menu` (`editor.context`, `projectView.context`, `editorTab.context`, `viewItem.context`, `tools`, `commit.message`), `view?`, `command`, `when?`             | no            |
| `keymaps`       | `command`, `key`, `mac?` (`Ctrl+Alt+C`; a chord: `Meta+K Meta+C`)                                                                                             | no            |
| `statusBar`     | `id`, `text`, `tooltip?`, `command?`, `align?`, `priority?`                                                                                                   | no            |
| `settings`      | `schema` (JSON file) or `pages` (API 1.3), `title?` — see _Settings_                                                                                          | no            |
| `views`         | `id`, `title`, `icon?` (an icon name or a package SVG), `location` (`left`, `right`, `bottom`, `services`), `web?` (_Web views_), `group?`, `when?` (API 1.3) | without `web` |
| `customEditors` | `id`, `title`, `patterns` (file names), `priority` (`default`, `option`), `layout?`, `web?`                                                                   | without `web` |
| `fileIcons`     | `id`, `patterns` (file names), `icon` (SVG), `iconDark?` — whatever icon theme is in use                                                                      | no            |
| `fileTemplates` | `id`, `name`, `extension`, `path`; API 1.3: `fileName`, `variables = [{ name, prompt }]` — New menu                                                           | no            |
| `commitChecks`  | `id`, `title` — a before-commit check in Commit Options (see _Commits_)                                                                                       | yes           |

A `viewItem.context` menu needs `view`, the id of one of the plugin's own
views. It adds the commands to the right-click menu of the items in that
view's `tree` or `list`, and each command gets the item's key as its argument.
`when` clauses can use `viewItem` (the key) and `viewItemKind` (the key up to
its first `:`, so `pod` for `pod:default/nginx`; the whole key when it has no
`:`). Only the menu's `when` sees them, not the command's own `when`; a command
whose `when` is false shows greyed out. Other menus refuse `view`, a web view
has no item menu, and no menu opens when no declaration matches the item.
The menu is new in API 1.2, so a plugin using it declares
`engines.openidea = "^1.2"`. For example:

```toml
[[contributes.menus]]
menu = "viewItem.context"
view = "pods"
command = "kube.logs"
when = "viewItemKind == pod"
```

A `commit.message` menu puts the command, with the plugin's icon, in the
toolbar above the commit message of the Commit tool window and the Commit
dialog (see _Commits_). It is new in API 1.3 (`engines.openidea = "^1.3"`).

In a context menu (`editor.context`, `projectView.context`, `editorTab.context`,
`viewItem.context`), entries can name a `submenu`: the plugin's entries of that
menu with the same `submenu` are shown under it (`Arthas` ▸ _Watch_ / _Trace_),
in declaration order; a submenu with one visible entry shows it as a plain
entry, and entries without `submenu` stay where they are. The label goes
through the plugin's translations. It is new in API 1.3
(`engines.openidea = "^1.3"`):

```toml
[[contributes.menus]]
menu = "editor.context"
command = "arthas.watch"
submenu = "Arthas"
```

Declared contributions are live as soon as the plugin is enabled — commands
show in Find Action, menus and the status bar, shortcuts work, themes and icon
themes can be applied, settings pages are there — **before** any plugin code
is loaded. Menus, shortcuts and status bar items refer to the plugin's
declared commands. A plugin shortcut never takes a keystroke the IDE (or the
user) already uses; the user can rebind it in the keymap editor.

A `when` clause (on commands and menus) can test whether the open project
contains a file or folder: `when = "workspaceContains:.devcontainer/devcontainer.json"`.
The path is exact (no globs) and relative to the project root; in a workspace the
key is true when any of its projects contains the path. It updates when
files change. An IDE that doesn't know the key treats it as
false: the plugin still installs and the key reads as false there.
Plugins can set their own keys, `plugin.<id>.<key>`, with `host::set_context`:
a key set from a command or event applies to that window, one set outside any
applies to every window, and a window's value wins over the global one. Keys are
kept across a window reload and idle reclaim, and dropped when the plugin stops.

### File template names and variables (API 1.3)

With `engines.openidea = "^1.3"`, `fileName` creates an exact single filename
(including dotfiles) without a name prompt. `extension` may be omitted for these
files; it is never appended to `fileName`. Without `fileName`, naming behaves as before.
Declared variables are required text fields shown together in the new-file dialog;
cancelling creates nothing. Names must be unique ASCII identifiers and cannot
replace built-in variables (`NAME`, `PACKAGE`, `END`, etc.). Prompts can be translated
through the plugin's text catalog. Values are inserted literally with `$ENTITY$`
or `${ENTITY}` syntax.

```toml
engines.openidea = "^1.3"

[[contributes.fileTemplates]]
id = "ignore"
name = "Docker ignore"
fileName = ".dockerignore"
path = "templates/dockerignore.txt"
variables = [{ name = "OUTPUT", prompt = "Output folder" }]
```

Plugin templates infer `$PACKAGE$` with the built-in rules for their extension:
Java/Kotlin use source roots, Go uses sibling packages or the directory, and PHP
uses Composer PSR-4 mappings. No `packageStyle` manifest field is needed.

These declarations do not grant the plugin filesystem access: files are created
only when the user invokes a template, through the IDE's normal New File flow.
See `crates/ide-plugin/tests/fixtures/file-templates` for a minimal buildable
plugin covering dotfiles, multiple variables, and Java/Kotlin packages. Build
its component with `plugins/build.sh crates/ide-plugin/tests/fixtures/file-templates`.

### Background associations

`[[contributes.documentIndexers]]` declares file `extensions` and requires the optional
`document-indexer` export. It publishes cross-file associations (definitions, references,
aliases and gutter markers) in background batches, not on the editing path. See
[Background document indexers](../docs/plugins/indexing.md).

API 1.3 also uses this graph for Find Usages and Rename on published definitions
and references, alongside language-server results. Name anchors must cover exactly
the name in UTF-16 columns; markers are excluded. Indexed renames always show a
preview and apply as one undoable workspace edit. No new WIT export or capability
is required: the existing `project.read` declaration and trusted-project checks
still apply. Use `engines.openidea = "^1.3"` when relying on this behavior. The
[indexer fixture](../crates/ide-plugin/tests/fixtures/indexer) exercises both flows.

### Activation

Code is instantiated lazily: when one of the plugin's commands runs, or when
an event in `activation` fires:

| Event                 | Fires when                                             |
| --------------------- | ------------------------------------------------------ |
| `on-command:<id>`     | the command runs (implied for every command)           |
| `on-language:<id>`    | a file of that language is opened (`*`: any)           |
| `on-file:<glob>`      | a project file matching the glob is opened (`**`)      |
| `on-view:<id>`        | one of the plugin's views is shown                     |
| `on-schedule:<secs>`  | every `secs` seconds (at least 60): `Event::Scheduled` |
| `on-event:<kind>`     | a workbench event of that kind (see _Events_)          |
| `on-startup-finished` | shortly after the workbench is ready (use sparingly)   |

Until then the plugin is listed as _Inactive_ and costs nothing at start-up.
An instance unused for 5 minutes is reclaimed (its `deactivate` runs) and the
plugin is _Inactive_ again until its next event; `on-schedule` activates it
when due but does not keep it alive. Keep nothing in memory you can't rebuild
in `activate`.

### Capabilities

Code can only do what its capabilities allow, and the user approves them when
installing (or when a new version asks for more). Low-risk capabilities are
listed; high-risk ones are called out as equivalent to running code on the
machine. Users can revoke optional capabilities in Settings › Plugins.

| Capability          | Risk   | Unlocks today                                                                                                                |
| ------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `project.read`      | low    | `Project::root`, `read_file`, `find_files`, `symbols`, `host::projects`, `publish_diagnostics`                               |
| `project.write`     | medium | `Project::write_file` — creates and replaces text files inside the open projects                                             |
| `fs.read:<path>`    | high   | `host::fs::read_file`, `read_bytes`, `stat`, `read_dir` — files outside the projects, under the grant's directory            |
| `fs.write:<path>`   | high   | `host::fs::write_file`, `write_bytes` — files under that path; doesn't imply reading                                         |
| `editor.read`       | low    | `TextEditor::document`, `selections`                                                                                         |
| `editor.write`      | medium | `TextEditor::apply_edits`                                                                                                    |
| `vcs.read`          | low    | `Project::vcs_status` (branch, upstream, ahead/behind, changes), `vcs_remotes`, `host::pending_commit`, before-commit checks |
| `vcs.write`         | medium | `Project::vcs_fetch` (trusted projects only), `host::set_commit_message`                                                     |
| `storage`           | low    | `host::storage` (64 MiB per plugin, counting UTF-8 bytes of keys and values)                                                 |
| `events`            | low    | file opened/saved, editor focused, repository changed events                                                                 |
| `events.input`      | medium | `action-performed` events (which actions you run, and how)                                                                   |
| `process:<program>` | high   | `Project::run_process`, language servers, debug adapters, runs                                                               |
| `net:<host>`        | medium | `host::fetch` to that host (`*.example.com`: its subdomains)                                                                 |
| `secrets`           | medium | `{{secret:<name>}}` in request headers, `host::secret_is_set`                                                                |
| `clipboard`         | medium | `host::copy_to_clipboard` and the clipboard API in the plugin's web views                                                    |

`process:` capabilities are also derived from what the contributions start: a
language's `language-servers` and `debugger` commands and a run detector's
`command`. Those are optional — refusing one keeps the rest of the plugin
working. On grant the program is resolved to an absolute path and its content
hash is recorded; it is checked again right before every start, and a replaced
file is refused until the user approves it again. In a remote project the
server resolves and pins the program on its own machine (see _Remote
projects_).

`fs.read:<path>` grants reading outside the open projects: a directory (its
files, at any depth) or one file. The path is resolved to its real location
before it is compared, so a symlink pointing out of the granted directory is
refused, and a sibling whose name merely starts with the granted one (`/opt/see`
vs `/opt/seeyon`) is not covered. Granting a whole file system (`/`, `C:\`) is
refused when the manifest is read: declare the directories you need. Reads are
capped — text over the limit fails rather than truncating, and files that are
not text have to be read as bytes.

`fs.write:<path>` grants replacing files outside the projects under that path,
creating them when they are not there. A write is separate from a read and does
not imply one. Writes are atomic (a temporary file is renamed over the old one),
keep the file's encoding and BOM (a new file is UTF-8), are capped at 16 MiB,
and are refused while the editor holds unsaved changes for the same file. The
path is resolved as a read's is, so a link inside a granted directory cannot be
used to write outside it. `project.write` does the same inside the open
projects, creating missing directories. Both are new in API 1.3
(`engines.openidea = "^1.3"`).

`host::fs::plugin_dir()` (API 1.3) returns a private directory belonging only to
this plugin, separate from its installed code and key-value storage. Reading and
writing inside it needs no `fs.*` or `project.read` grant, including during
activation or provider calls without an open project. The host creates the
directory owner-only (0700 on Unix, an owner-only inheritable ACL on Windows),
and files written there are owner-only from creation (0600 on Unix). Paths are
checked after symlink resolution: another plugin's directory, adjacent paths,
and links escaping this directory receive no implicit grant. Explicit `fs.*`
grants retain their normal behavior.

Use it for generated editor content or caches larger than `storage`. Files and
the directory survive idle reclaim, plugin reloads, updates, and app restarts;
uninstall removes them. There is no TTL or stop-time deletion. A returned path
works with `host::open_location` and as an argument to an approved process;
normal UI, trust, and process approval rules still apply. Editor saves preserve
the private file's permissions. Filesystem writes keep the usual size limits,
encoding behavior, and protection of unsaved editor changes.

Logging, notifications, status bar items, tasks and run-time contributions
are always available. Calling a gated function without its capability returns
`Error::Denied("<capability>")` — the plugin keeps running and can degrade
(Git Toolbox still shows the branch without `vcs.write`).

## 3. Writing code (Rust SDK)

`openidea-plugin new` writes this for you. `Cargo.toml`:

```toml
[package]
name = "openidea-plugin-word-tools"
version = "0.1.0"
edition = "2024"

[workspace]                       # keep it out of any parent workspace

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
openidea-plugin = { git = "https://github.com/l0ng-ai/openidea", tag = "vX.Y.Z" }   # or { path = "…/sdk/rust/openidea-plugin" }

[profile.release]
opt-level = "s"
lto = true
strip = true
panic = "abort"
```

`src/lib.rs`:

```rust
use openidea_plugin::{Error, Invocation, NotificationLevel, Plugin, host, register_plugin};

#[derive(Default)]
struct WordTools;

impl Plugin for WordTools {
    fn run_command(&mut self, id: &str, ctx: &Invocation, _arg: Option<&str>) -> Result<Option<String>, Error> {
        let editor = ctx.editor().ok_or("no file is open")?;
        match id {
            "count" => {
                let words = editor.document()?.text.split_whitespace().count();
                host::notify(NotificationLevel::Info, "Word count", &format!("{words} words"));
                Ok(None)
            }
            // Every selection (a cursor: empty) in one undoable change.
            "shout" => {
                editor.transform_selections(|s| s.to_uppercase())?;
                Ok(None)
            }
            _ => Err(Error::NotFound(format!("command {id}"))),
        }
    }
}

register_plugin!(WordTools);
```

On `wasm32-wasip2` the SDK calls the IDE; on your machine it calls the SDK's
mock host, so the logic is unit-tested with `cargo test`:

```rust
#[test]
fn counts_and_shouts() {
    let host = openidea_plugin::mock::MockHost::install();
    host.open_editor("/project/a.md", "markdown", "one two three", &[(0, 4, 0, 7)]);
    WordTools.run_command("count", &host.invocation(), None).unwrap();
    assert_eq!(host.notifications()[0].body, "3 words");
    WordTools.run_command("shout", &host.invocation(), None).unwrap();
    assert_eq!(host.editor_text(), "one TWO three");
}
```

The mock enforces capabilities like the IDE (`MockHost::install().with_capabilities(&[...])`),
keeps a versioned editor document (`type_in_editor` makes edits stale), and
records notifications, status items, storage, subscriptions, tasks, fetches,
commands, languages, themes and log lines.

Any language with component-model tooling works (`componentize-py`,
`jco componentize`, TinyGo): the only contract is the `plugin` world in
[`wit/`](../wit/) (`plugin-syntax` adds the syntax provider). Build it yourself,
then run `openidea-plugin check`.

### The API

| Rust SDK                                                                 | WIT                              | Notes                                                                                                                                                                                                                |
| ------------------------------------------------------------------------ | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Plugin::run_command(id, ctx, arg)`                                      | export `commands.run`            | `ctx` is the window: `ctx.project()`, `ctx.editor()`. An error shows _"<title> failed: …"_; the plugin keeps running. `"msg".into()` is `Error::Failed`; `Cancelled` and `Denied` don't count as the plugin failing. |
| `Plugin::handle_events(events, ctx)`                                     | export `event-handler.handle`    | Batches of subscribed events, oldest first, per window.                                                                                                                                                              |
| `Plugin::activate` / `deactivate`                                        | export `lifecycle`               | Per instance: after a crash or idle reclaim a new one is activated.                                                                                                                                                  |
| `TextEditor::document()` → `{version, text}`                             | `editor.text-editor.document`    | `selections()` are those when the command ran (0-based lines, UTF-16 columns).                                                                                                                                       |
| `TextEditor::apply_edits(version, edits)`                                | `editor.text-editor.apply-edits` | One undoable change, only if the document is still at `version` — else `Error::Stale` and nothing changes. `transform_selections` retries once.                                                                      |
| `Project::root()`, `read_file(path)`                                     | `workspace.project`              | Absolute or project-relative; `..`/symlinks escaping the root are rejected; UTF-8 only, ≤ 16 MiB; unsaved editor contents win; a missing path is `Error::NotFound`.                                                  |
| `Project::exists(path)`, `stat(path)`                                    | `workspace.project`              | `exists` covers files and directories, hidden and ignored included, without reading content; `stat` gives kind, size and modified time (`Error::NotFound` for a missing path).                                       |
| `host::projects()`                                                       | `workspace.projects`             | Every open project (for scheduled work without a window).                                                                                                                                                            |
| `Project::vcs_status()`, `vcs_remotes()`, `vcs_fetch()`                  | `vcs`                            | `vcs_remotes` returns `(name, url)` pairs; fetch runs git, so only in trusted projects (call it inside a task).                                                                                                      |
| `host::pending_commit()`, `host::set_commit_message(revision, text)`     | `commit`                         | The commit being prepared in the calling window and its message; see _Commits_.                                                                                                                                      |
| `host::subscribe(kind)`                                                  | `events.subscribe`               | For the session, across idle reclaim (an event activates the plugin). Or declare `on-event:<kind>`.                                                                                                                  |
| `host::begin_task(title, cancellable)` → `Task`                          | `tasks.begin`                    | Shown with the background tasks; `report`, `is_cancelled`; the call may run 60 s instead of 5 s while it is open; dropping it ends it.                                                                               |
| `host::storage::{get, set, delete, keys}`                                | `storage`                        | Survives restarts; the instance's memory does not. Deleted on uninstall.                                                                                                                                             |
| `host::set_status_item(id, item)`, `remove_status_item`                  | `ui`                             | `text`, `tooltip`, `command` (one of yours, run on click); at most 8; kept while the plugin is idle.                                                                                                                 |
| `host::set_context(key, value)`, `remove_context`                        | `ui.{set,remove}-context`        | Sets `plugin.<id>.<key>` for `when` clauses in the window the call came from (`true`, `3.5`, `"text"`; `ContextValue`). Key 1–64 of `A-Za-z0-9_-`, 100 per plugin; gone when the plugin stops.                       |
| `host::notify(level, title, body)`                                       | `ui.show-notification`           | Balloon in the window the command or events came from (every window otherwise).                                                                                                                                      |
| `host::copy_to_clipboard(text)`                                          | `ui.copy-to-clipboard`           | Copies `text` to the system clipboard. Needs `clipboard`.                                                                                                                                                            |
| `host::open_url(url)`                                                    | `ui.open-url`                    | Opens an `http://` or `https://` URL in the user's default browser.                                                                                                                                                  |
| `host::pick(title, items)`, `pick_many`                                  | `ui.pick`, `ui.pick-many`        | Picks key(s) from `PickItem`s, or `None` when dismissed. From a command/event or code-action resolution in its editor window (else `invalid`); waiting is excluded from the budget.                                  |
| `host::input(prompt, value)`                                             | `ui.input`                       | A one-line text box pre-filled with `value`; `None` when dismissed. Same rules as `pick`.                                                                                                                            |
| `host::input_multiline(prompt, value)`                                   | `ui.input-multiline`             | A multi-line text box pre-filled with `value`; `None` when dismissed; Cmd/Ctrl+Enter confirms. Only from a command or event of a window.                                                                             |
| `host::confirm(title, body)`                                             | `ui.confirm`                     | OK / Cancel; `true` on OK. Same rules as `pick`.                                                                                                                                                                     |
| `host::locale()`                                                         | `ui.locale`                      | The IDE's UI language as a BCP 47 tag (`en`, `fr`, `zh-CN`); no capability. See _Translations_.                                                                                                                      |
| `host::log(level, msg)`                                                  | `log`                            | IDE log, tagged with the plugin id. `eprintln!` output is logged too and shown when the plugin crashes.                                                                                                              |
| `Project::find_files(glob, limit)`                                       | `workspace.project.find-files`   | Project-relative glob (`**/*Mapper.xml`); honours `.gitignore`; at most `limit` paths.                                                                                                                               |
| `Project::symbols(query, limit)`                                         | `workspace.symbols`              | New in 1.3; `project.read`. Fuzzy in-memory search (no LSP): name, camelCase kind, container and UTF-16 location. Queries ≤ 256 UTF-8 bytes; limits capped at 1000. Snapshot notes below.                            |
| `host::publish_diagnostics(path, items)`                                 | `diagnostics.publish`            | Replaces this plugin's problems for the file (editor squiggles and the Problems view); an empty list clears them.                                                                                                    |
| `host::fetch(request)` → `{status, headers, body}`                       | `net.fetch`                      | See _Network_.                                                                                                                                                                                                       |
| `Project::run_process(program, args, stdin)` → `{code, stdout, stderr}`  | `process.run`                    | Only the pinned program of a `process:` grant; runs in the project root of a trusted project; 4 MiB of output; killed when the call is cancelled or times out.                                                       |
| `host::run_command(cmd, project, stdin)` → `{code, stdout, stderr}`      | `process.run-command`            | API 1.3: same limits as `run_process`, with append-only environment variables; needs the pinned `process:<program>` grant.                                                                                           |
| `host::start(cmd, project)` → `Child`                                    | `process.start`                  | API 1.3: `poll(max_bytes)`, `write(text)`, `close_stdin()`, `wait(timeout_ms)`, `kill()`; at most 8 handles; dropping one kills its process.                                                                         |
| `host::refresh_view(view)`                                               | `views.refresh`                  | The view (or custom editors) render again; call it when the content changed.                                                                                                                                         |
| `host::reveal_view(view)`                                                | `views.reveal`                   | Brings one of your declared `[[contributes.views]]` to the front in the calling window.                                                                                                                              |
| `host::post_view_message(view, text)`                                    | `views.post-message`             | To the script of the view's `html` body.                                                                                                                                                                             |
| `host::open_terminal(title, program, args)`                              | `views.open-terminal`            | A terminal tab in the invoking window running the approved `process:<program>` in the project root: output that keeps coming, interactive sessions.                                                                  |
| `host::open_location(path, line, column)`                                | `views.open-location`            | Opens a file inside the project in an editor of the invoking window, the caret at `line`/`column` (0-based, UTF-16): a view's links to code. Needs `project.read`.                                                   |
| `host::setting(key)`, `setting_bool`, `setting_string`, `setting_number` | `settings.get`                   | The user's value (project over global) or the schema's default.                                                                                                                                                      |

`Project::symbols` reads the current in-memory index: results may be partial
while indexing, and locations can lag unsaved edits. Normal saves and filesystem
changes update the index in the background. Results are confined to the project's
root, with normal exclusions; external content roots and updates through escaping
symlinks are excluded. Search honours the current call's cancellation and deadline.
Empty queries and zero limits return no symbols; a closed project returns
`Error::NotFound`.

Type resolution and member queries remain deferred to the asynchronous API 2.0
model. Providers can select their project with `host::project_of(&doc.path)` and
call `symbols` synchronously; `crates/ide-plugin/tests/fixtures/symbols` demonstrates
a definition provider. `MockHost::set_symbols(root, symbols)` replaces a test
snapshot; its mock uses case-insensitive substring matching rather than fuzzy ranking.

Both process APIs only add environment variables. A key already in the prepared child
environment (including the login-shell `PATH`) fails with an error naming the key;
variables are never replaced or removed. Names compare case-insensitively on Windows.
At most 64 entries are allowed: nonempty names up to 256 bytes without `=` or NUL,
and values up to 4 KiB without NUL. The approved file still decides what runs.

Unpolled child output keeps the last 1 MiB per stream; each read is capped at 1 MiB
and preserves complete characters. Disabling, unloading, reclaiming or stopping a
plugin ends its children, as does closing the window that started them.

`run-command` receives an optional string argument: `executeAction("plugin.<plugin id>.<command id>", "arg")`
from another feature, or nothing when run from Search Everywhere / a shortcut. `ctx.selected_paths()` lists the files and folders a Project view or editor tab menu ran the command on (the argument is the first of them); it is empty otherwise. No capability is needed.

### Events

| Kind               | Capability     | Delivered                                                                 |
| ------------------ | -------------- | ------------------------------------------------------------------------- |
| `file-opened`      | `events`       | a file opens in an editor                                                 |
| `files-changed`    | `events`       | debounced created, modified and removed paths in open projects (API 1.3)  |
| `file-saved`       | `events`       | after the file is written                                                 |
| `editor-focused`   | `events`       | the focused editor changes (path, or none)                                |
| `vcs-changed`      | `events`       | a repository's state changed (commit, checkout, fetch…; its root)         |
| `action-performed` | `events.input` | an IDE action ran: id, title, source (keyboard, menu, toolbar…), shortcut |
| `scheduled`        | —              | the `on-schedule` period elapsed                                          |

Events are batched: a running plugin gets them within a fraction of a second,
an idle one collects them for 2 s before it is woken, so frequent events
(Key Promoter's actions) don't keep it alive. `files-changed` is already debounced
by the project's watcher (100 ms quiet period, at most 1 s during a continuous
burst), so it bypasses the idle delay. Queued filesystem batches coalesce paths;
a later batch does not cancel an earlier one. Closed project sessions discard
pending filesystem events. Excluded and git-ignored paths follow the normal
project watcher rules; scratch files and language-server dependency watches do
not produce this event.

The released WIT event remains unchanged: `event::other` carries kind
`files-changed` and JSON `{ "created": [...], "modified": [...], "removed": [...] }`.
The Rust SDK exposes `Event::FilesChanged(FilesChanged)` and
`EventKind::FilesChanged`. Paths have the same absolute form as `file-saved`.
Subscribe with `host::subscribe(EventKind::FilesChanged)` or
`activation = ["on-event:files-changed"]`. Plugins using this event must declare
`engines.openidea = "^1.3"`.

Kinds are names (`subscribe` takes a string), so later IDEs add kinds without
a new API: an IDE refuses a kind it doesn't know with `invalid`, and a kind
newer than the plugin's SDK arrives as `Event::Other { kind, data }` (JSON).
The SDK's event enums are `#[non_exhaustive]`; match them with a `_` arm.

API 1.3 adds `host::subscribe_paths("file-opened", &["config/*.yaml"])`
(`events.subscribe-paths`). The host matches project-relative globs before
queueing an event or waking an idle plugin. `file-saved` and `files-changed` work
the same way. For `files-changed`, each category is filtered and an empty batch
is omitted; replacing or pausing a filter also affects batches already queued.
Patterns use `/`, `*` stays within a directory, and `**` crosses
directories. Up to 64 patterns of 1024 bytes each are accepted; absolute paths,
parent traversal and malformed patterns fail without replacing the old filter.

Register filters in `activate`, using a startup or command activation to install
them before observing events. Patterns are ORed; another call replaces the same
kind's filter, an empty list pauses it, `subscribe(kind)` restores all paths,
and `unsubscribe(kind)` removes it. Filters survive idle reclaim and disappear
on disable, uninstall or reload. Each window's events use its current project;
files outside that project do not match.

Provider calls can use `host::project_of(&doc.path)` (`workspace.project-of`)
without an invocation project or enumerating every open project. It returns the
deepest open project containing the absolute path, or `None` outside open roots.
Symlinks and missing file tails are resolved before checking containment.
Obtaining a handle grants no read access: `Project::root` and file operations
still require `project.read`.

### Commits

A plugin can work on the commit the user is preparing, in the Commit tool
window or the Commit dialog (API 1.3, `engines.openidea = "^1.3"`):

- **A button above the message.** `[[contributes.menus]]` with
  `menu = "commit.message"` shows one of the plugin's commands there, with the
  plugin's icon.
- **The pending commit.** `host::pending_commit()` (`vcs.read`) returns what
  Commit would commit right now: per file its repository, path, status and a
  `git diff` of only the included changes (the checked files and changed
  blocks, against HEAD; 1 MiB in all, then `truncated`), plus the message,
  Amend and a `revision`. Unsaved editors of those files are saved first, as
  Commit does; nothing is staged or committed. `None` without a repository.
- **The message.** `host::set_commit_message(revision, text)` (`vcs.write`)
  replaces it only while the draft is still at `revision`. If the user typed
  or changed the included changes meanwhile, it fails with `Error::Stale` and
  nothing is overwritten. The user reviews the text and commits.

Both work from a command or event of a window, in a trusted project; they wait
for the window, which isn't charged to the time limit. A message generator
calls a model with `host::fetch` and a `{{secret:…}}` key (see _Network_)
inside a task:

```rust
let draft = host::pending_commit()?.ok_or("no repository")?;
let message = ask_the_model(&draft.changes)?;
host::set_commit_message(draft.revision, &message)?;
```

**Before-commit checks.** Each `[[contributes.commitChecks]]` (`id`, `title`)
is listed in Commit Options, on by default. When the user commits, after the
IDE's own checks, the IDE calls the optional `commit-checker` export
(`register_plugin!(MyPlugin, commit_checks)`, trait `commit::CommitChecks`)
with the check's id and the draft. Problems (`message`, `location?`) stop the
commit and show beside the message with the check's title, until the user
changes it or chooses Commit Anyway. A check that fails, times out or lacks
`vcs.read` is reported as a problem too.

### Providers

Declare what the plugin provides in the editor; only plugins whose
declaration matches the file's language are called (and loaded):

```toml
[[contributes.providers]]
kinds = ["definition", "line-markers", "completion"]  # also "inline-completion", "code-actions", "semantic-tokens", "hover", "inlay-hints", "diagnostics"
languages = ["java", "xml"]                           # editor language ids; "*" for any
```

Line marker `icon` accepts an icon name (including registered plugin icons),
the aliases `navigate`, `implemented`, `implementing`, `overridden`, `overriding`
and `run`, or a package SVG path. Declare package marker icons so installation
includes and validates the SVGs (`engines.openidea = "^1.3"`):

```toml
[[contributes.markerIcons]]
id = "resource"
icon = "icons/resource.svg"
iconDark = "icons/resource_dark.svg" # optional dark-theme variant
```

Return `icon = Some("icons/resource.svg".into())` from `line_markers` to use it.
The referenced icon path is package-relative, up to 256 bytes; both SVGs use the same sandbox,
64 KiB size limit and sanitization as view icons. Active content and external SVG or CSS
references are rejected during installation. Missing or unknown icons retain the
navigation glyph. A marker's optional target still navigates on click. For
several cross-file targets, publish document-index mappings; the existing
chooser lists every matching definition. Command clicks are deferred; use a
code action on the same line.

Then `register_plugin!(MyPlugin, providers)` and implement
`openidea_plugin::providers::Providers` for it: `completion`,
`inline_completion`, `code_actions`, `definition`, `line_markers`. Each gets
the document (path, language, version, text). Results join the language
servers' (completion lists, ⌥⏎ quick fixes, ⌘B, gutter icons; a code action
carries edits for any files, applied as one change). A completion item's
`kind` (`CompletionKind` in the SDK, a string in the WIT) picks its icon; it
can be a `snippet` (`$1`, `${1:name}`, `$0`), match on `filter_text` instead
of its label, and bring `additional_edits` elsewhere in the document (an
import). A code action can leave `edits` empty and set `data`: its edits are
then computed by `resolve_code_action` when the user picks it, under the
command budget instead of the 50 ms. During resolution, `pick`, `pick_many`,
`input` and `confirm` ask in the editor's window; waiting for an answer does
not consume that budget. Dismissal returns `None` (or `false` for `confirm`):
return `Error::Cancelled` or no edits to abandon the fix. Lazy plugin actions
resolve only when invoked, never for the intention preview or Actions on Save. Commands/events-only
APIs remain unavailable during resolution. A quick fix that creates, renames or
deletes files implements `file_actions::FileActions` too
(`register_plugin!(T, providers, file_actions)`; the `code-actions` kind
covers both): a `FileAction` carries `operations` (`FileOperation::Create {
path, text, overwrite }`, `Rename`, `Delete`) and `edits`, applied as one
workspace edit, so a failure changes nothing and one undo reverses it. A path
outside the project root disables the action; `open` shows a file once the
action is applied. Like a code action, it can leave `operations` and `edits`
empty and set `data`: `resolve_file_action` computes them when the user picks
it, with the same prompts and editor window as `resolve_code_action`. File actions are new in API 1.3. Problems (`publish_diagnostics`) can name
the tool that found them (`source`) and be `unnecessary` (faded) or
`deprecated` (struck through).
Editor providers run under the edit-path budget: 50 ms, after which the
result is dropped, and an interruption at 500 ms. Every plugin providing a
kind is asked at the same time, so each has the whole budget.

Providers run in the plugin's one instance, with its commands, events and
views: they see the same memory (Checkstyle answers quick fixes from the
results of its last check) but also wait behind them. Keep commands and event
handlers short where you can; a provider call queued behind a long one is
dropped at 50 ms like a slow one. Inline completion is exempt from the 50 ms (it may
need the network) but is cancelled as soon as the user types on: check
`Task::is_cancelled` or just let the host interrupt the call.

#### Semantic highlighting

The `semantic-tokens` kind (API 1.3: `engines.openidea = "^1.3"`) colours
tokens in documents of the declared languages, including languages the plugin
doesn't contribute, such as `php`. Register with
`register_plugin!(MyPlugin, semantic_tokens)` (any combination works:
`(MyPlugin, providers, views, semantic_tokens)`) and implement
`openidea_plugin::semantic_tokens::SemanticTokens`:

```rust
impl SemanticTokens for MyPlugin {
    fn semantic_tokens(&mut self, doc: &Document) -> Vec<SemanticToken> {
        let (start, end) = (text::position(&doc.text, 10), text::position(&doc.text, 14));
        vec![SemanticToken::new(Range { start, end }, TokenKind::Method)]
    }
}
```

A token covers part of one line and carries an LSP token kind (`TokenKind`:
`method`, `property`, `type`, …) and modifiers (`TokenModifier`: `static`,
`deprecated`, …); the WIT takes them as kebab-case strings. The tokens join
the language server's semantic tokens and win where they overlap one, so the
editor's colour scheme styles them like the server's. They are asked again
after each edit, under the edit-path budget; at most 65,536 per document.

#### Hover

The `hover` kind (API 1.3) adds Markdown to the hover of documents of the
declared languages, here too including languages the plugin doesn't
contribute. Register with `register_plugin!(MyPlugin, hover)` and implement
`openidea_plugin::hover::HoverProvider`:

```rust
impl HoverProvider for MyPlugin {
    fn hover(&mut self, doc: &Document, at: Position) -> Option<Hover> {
        Some(Hover::new("**orders.index** · `GET /orders`"))
    }
}
```

The host asks the language server and the plugins together, under the
edit-path budget, and shows the server's hover first, then each plugin's
below a rule. `range`, when given, is the text the hover describes (used when
the server names none). At most 64 KiB of Markdown per plugin.

#### Diagnostics while typing

The `diagnostics` kind (API 1.3) checks unsaved documents in its declared
`languages` (`"*"` matches any language). Implement
`openidea_plugin::diagnostics::DiagnosticsProvider` and register with
`register_plugin!(MyPlugin, diagnostics)`:

```rust
impl DiagnosticsProvider for MyPlugin {
    fn diagnostics(&mut self, doc: &Document) -> Vec<Diagnostic> {
        // doc.path is absolute; doc.language is the editor language id.
        // doc.version identifies this snapshot; doc.text includes unsaved edits.
        check(&doc.text)
    }
}
```

The optional WIT export is `diagnostics-provider.diagnostics(document) ->
list<diagnostic>` in worlds `plugin-diagnostics` / `editor-diagnostics`. It uses the
same diagnostic record as `diagnostics.publish`, including 0-based UTF-16
ranges. The export-only world uses `editor-diagnostics` because `diagnostics`
already names the released host interface. The provider declaration supplies the current document without an
additional capability; host imports keep their usual capability checks
(`publish` still requires `project.read`). Providers run without an interactive
invocation, so they cannot open prompts or write to the active editor.

The host requests diagnostics about 300 ms after opening a document or after
its latest edit, under the editor-provider budget (normally 50 ms soft /
500 ms hard). It snapshots the buffer in the background, cancels superseded
requests, and drops older document versions. Documents over 2 MiB and virtual
library documents are excluded. Return an empty list to remove provider
problems. At most 5,000 diagnostics are retained per provider and document;
messages are limited to 4 KiB, source/code to 128 bytes.

Provider problems and manually published problems use separate producers,
`plugin-provider:<plugin-id>` and `plugin:<plugin-id>`, and both appear alongside
language-server diagnostics. Each producer replaces only its own results.
Closing the document/project or disabling, uninstalling, reloading or failing
the plugin clears provider results. A reclaimed idle instance keeps its results
until the next request. Requests and results stay with the originating project
and window, including when two windows edit the same path differently. Project
plugins receive documents only from the project where they were granted.

Native plugin tests can use `MockHost::refresh_diagnostics(&mut provider)` to
check the current versioned mock editor and `provider_diagnostics()` to inspect
its answers separately from `diagnostics()` (manual publishing). The mock call
is explicit; debounce and cancellation are exercised by the real Wasm host tests.

#### Inlay hints

The `inlay-hints` kind (API 1.3) shows short labels inside the code of
documents of the declared languages, such as a type after a call. Register
with `register_plugin!(MyPlugin, inlay_hints)` and implement
`openidea_plugin::inlay_hints::InlayHints`:

```rust
impl InlayHints for MyPlugin {
    fn inlay_hints(&mut self, doc: &Document, range: Range) -> Vec<InlayHint> {
        vec![InlayHint::new(range.start, ": string").kind(InlayKind::Type).tooltip("returns string")]
    }
}
```

`range` is the visible part of the document; hints outside it are dropped. A
hint's kind (`type`, `parameter` or `other`) decides which Inlay Hints setting
shows it. The host asks the language server and the plugins together, under
the edit-path budget, and shows both; the editor asks again after edits and
scrolling. Labels are cut at 256 bytes and tooltips at 1 KiB.

### Network and secrets

`host::fetch` makes an HTTPS request (plain HTTP only to `localhost`) to a host
the plugin was granted with `net:<host>`; redirects to another host are
refused and responses are limited to 8 MiB. Requests are made from the
machine the project is on.

Secrets declared under `[[contributes.secrets]]` are entered by the user in
Settings › Plugins and kept in the system keychain. The plugin never reads
them: it writes `{{secret:<name>}}` in a request header and the host fills it
in on the way out (`secrets` capability). `host::secret_is_set(name)` tells
whether the user has entered one.

### Views and custom editors

A view is data: a toolbar, a body — `Tree`, `List`, `Form`, `Table`,
`Message` or `Html` — and a status line. Declare it, then
`register_plugin!(MyPlugin, views)` (or `(MyPlugin, providers, views)`) and
implement `openidea_plugin::views::Views`:

```rust
impl Views for MyPlugin {
    fn render(&mut self, view: &str, viewport: Option<Viewport>, ctx: &Invocation) -> Result<View, Error> {
        Ok(View::new(Body::Tree(vec![TreeItem::new("a", "A").expandable(self.open)]))
            .button(Button::new("refresh", "Refresh").icon("refresh")))
    }
    fn handle(&mut self, view: &str, event: ViewEvent, ctx: &Invocation) -> Result<(), Error> {
        if let ViewEvent::Expand(_) = event {
            self.open = true;
            host::refresh_view(view);
        }
        Ok(())
    }
}
```

The IDE draws the view with its own components (theme, keyboard, speed
search) and sends what the user does: buttons, select / activate / expand /
collapse of items, form fields, table cells, inserted and deleted rows, and
`html` messages. A tree is a flat list whose items name their `parent`; an
`expandable` item gets its children when it is expanded. A table gets only
the rows it shows (`viewport`): report `total_rows` and return those.
For a table the user can sort by clicking a header, build it with
`Body::sortable_table(&table, sort)`: it travels as a `table` through `other`
(so IDEs and plugins of any API version keep working), the IDE makes the
column headers clickable and asks for a column and direction with
`ViewEvent::sort()` — sort your rows and render again; the sort you report
shows as an arrow in the header.
API 1.3 adds read-only form values without changing the released field record:
`FieldValue::label(text)` uses `other { kind: "label", data }`, where `data`
is a JSON string. `FieldValue::readonly_text(text, multiline)` uses kind
`readonly-text` with JSON `{ "text": "…", "multiline": false }` (the flag
defaults to false). Labels render as plain selectable values; read-only text
keeps the single-line or multiline text control and never sends field events.

Table row clicks and Space send `other` kind `table-select`; double-click
and Enter send `table-activate`, both with JSON `{ "row": 0 }`.
`ViewEvent::table_select()` and `table_activate()` decode the absolute,
zero-based index, including `first_row` for paged tables. These work for both
plain tables and the same `other` table shape used by sortable tables above;
no new table shape is needed. Editable cells still double-click to edit;
activate their row with Enter on the focused row or double-click its row number.
`viewItem.context` menus also work on table rows: the command argument and
`viewItem` context key are the decimal row index, e.g. `"0"`. Editable tables
keep their insert/delete entries alongside contributed commands. After sorting
or changing data, plugins resolve row indices against their current row order.
Declare `engines.openidea = "^1.3"` when relying on these additions.

Bodies, field types and view events added by later APIs travel as `Other {
kind, data }`: an IDE that doesn't know a body says it needs updating, and
leaves out a field type it doesn't know.

Showing a view activates the plugin (`on-view:<id>`). `views` become tool
windows; a `customEditors` file (`priority = "default"`) opens in the
plugin's editor, or through _Open With_ for `option`. For a custom editor
`ctx.editor()` is its document: read it with `document()` and change it with
`apply_edits(version, …)` — the text editor of the same file follows,
Undo / Redo are one history with it, and Save, the dirty mark and the close
prompts are the document's. _Open as Text_ opens the text editor. For a
tool window `ctx.editor()` is the window's active text editor, as for a
command, so a view's buttons can act on what the user is editing (a click in
the tool window doesn't change which editor that is).

API 1.3 adds optional `group` and `when` fields to `[[contributes.views]]`;
using either requires `engines.openidea = "^1.3"`. `when` uses the same
context clauses as commands and menus, including `workspaceContains:pom.xml`
and keys set with `set_context`. A false condition removes the view from the
stripe and its group tabs; context changes, file creation/removal and project
changes evaluate it again. Hidden views are not rendered or activated.

Tool-window views (`left`, `right` or `bottom`) with the same `group`
**within one plugin** share a tool window, with
tabs in manifest declaration order. The first declaration supplies the window's
title, icon and default location, even when that view is hidden; the window
is absent when all its tabs are hidden. Group ids follow the same rules as
view ids and are scoped to the declaring plugin. Tabs load on first selection
and keep their content mounted while they apply, preserving web-view state
when switching tabs. Ungrouped views keep their
existing window ids and placement. `reveal_view` selects a visible grouped
view's tab; it does not override its condition. Services views remain providers
of the built-in Services window, and also support `when`.

```toml
[[contributes.views]]
id = "endpoints"
title = "Spring"
group = "spring"
when = "workspaceContains:pom.xml || workspaceContains:build.gradle"

[[contributes.views]]
id = "beans"
title = "Beans"
group = "spring"
when = "plugin.my-plugin.ready"
```

The `crates/ide-plugin/tests/fixtures/grouped-views` sample exercises both
fields without requesting capabilities. Build it with
`plugins/build.sh crates/ide-plugin/tests/fixtures/grouped-views`, then install
that directory. Run **Grouped Views: Show** to expose the first tab, create
`grouped-views.txt` in the project root to expose **Project Files**, and run
**Grouped Views: Hide** or remove the file to withdraw those tabs. The
**Ungrouped View** window stays separate. These fields control visibility;
they grant no access to project contents or another plugin's views.

`layout` puts a custom editor beside the text editor instead of in a tab of
its own: with `"split"` or `"preview"` the file opens in the text editor,
with your editor next to it (the layout files start in) and the _Editor Only /
Editor and … / … Only_ switch in the tab strip, as for Markdown. `"tab"`
(the default) is the editor's own tab.

`Html` is the escape hatch for content the declarative bodies can't show. It
runs in a sandboxed frame — an opaque origin under a CSP that allows only its
inline scripts and styles and `data:` images, no network, no IDE API — and
talks to the plugin only through `openidea.postMessage(text)` /
`openidea.onMessage(fn)` (`ViewEvent::Message`, `host::post_view_message`).

The frame follows the IDE theme without reloading: its root carries
`data-theme="light|dark"` and these CSS variables, with concrete colour
values (the body already uses the text colour, UI font and size):

| Variable                                                                                                          | Meaning                                                          |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `--openidea-bg`, `--openidea-bg-elevated`, `--openidea-bg-hover`, `--openidea-bg-selected`, `--openidea-bg-input` | Surfaces (the frame itself is transparent)                       |
| `--openidea-fg`, `--openidea-fg-strong`, `--openidea-fg-muted`                                                    | Text                                                             |
| `--openidea-border`, `--openidea-focus-ring`, `--openidea-link`                                                   | Lines, focus, links                                              |
| `--openidea-accent`, `--openidea-fg-on-accent`                                                                    | Accent and text on it                                            |
| `--openidea-danger`, `--openidea-warning`, `--openidea-success`, `--openidea-info`                                | Status colours                                                   |
| `--openidea-font-ui`, `--openidea-font-mono`, `--openidea-font-size`                                              | Fonts (web fonts the IDE bundles are not available in the frame) |

Scripts get the same as `openidea.theme` (`{ dark, vars }`) and
`openidea.onThemeChange(fn)`, for drawing on a canvas, say. Variables are only
ever added.

#### List and detail views

With API 1.3 (`engines.openidea = "^1.3"`), a rendered `tree` or `list` view
in any location can declare `detail = true`:

```toml
[[contributes.views]]
id = "endpoints"
title = "Endpoints"
location = "bottom"
detail = true
```

Implement the same `details::Details` export shown below. The host requests
the selected item's tabs after its `select` event finishes, and again after
`host::refresh_view(view)`. The list and tabs appear side by side with a
resizable divider remembered per plugin/view. Changing or removing the selected
item closes its pane and stops its log. Changing projects or remote hosts clears
selection; hiding the window stops its log. Other body kinds render as before;
`detail` cannot be combined with `web`. Services uses its existing single
list/detail split, so this declaration never adds a nested split.

#### Services views

`location = "services"` (API 1.3: `engines.openidea = "^1.3"`) puts a view's
tree in the Services tool window, next to Docker and the run configurations,
instead of a tool window of its own. Its code renders it (no `web`):

```toml
[[contributes.views]]
id = "kube"
title = "Kubernetes"
icon = "icons/kubernetes.svg"
location = "services"

[capabilities]
optional = ["process:kubectl"]
```

The items of the view's `tree` are Services nodes: `render`, `handle` and the
toolbar work as in a tool window, the toolbar's buttons acting on the one
selected node, and `viewItem.context` menus give the nodes a right-click menu.
The pane beside the tree comes from the `detail-provider` export: register
`register_plugin!(MyPlugin, views, details)` and implement
`openidea_plugin::details::Details`, which returns the selected node's tabs
(at most 8; asked again after `host::refresh_view("kube")`):

```rust
impl Details for MyPlugin {
    fn detail(&mut self, view: &str, key: &str, _ctx: &Invocation) -> Result<Vec<Tab>, Error> {
        let pod = key.trim_start_matches("pod:");
        let log = ProcessLog::new("kubectl", &["logs", "-f", "--tail=1000", pod])
            .toggle("ts", "Timestamps", &["--timestamps"]);
        Ok(vec![Tab::new("log", "Log", log), Tab::new("inspect", "Inspect", Pane::Text(self.describe(pod)?))])
    }
}
```

The IDE switches tabs without calling the plugin. A tab is a `Pane::Message`,
read-only `Pane::Text` (at most 1 MiB) or a `ProcessLog`: the IDE asks for the
pane again and runs that program (it needs the plugin's `process:<program>`
grant) in the project root, following its output in the log Docker containers
use (ANSI stripped, the last 5000 lines and 16 KiB per line, Soft-wrap, Clear,
the exit code at the end). A toggle appends its `args` and starts the program
again. It stops when the node's pane closes or the Services window is hidden.

#### Web views

A view or custom editor can instead be a web page of the package, for UIs the
declarative bodies can't express (a drawing canvas, a diagram editor) — no
code needed:

```toml
[[contributes.customEditors]]
id = "canvas"
title = "Drawing"
patterns = ["*.excalidraw"]
layout = "preview"
web = "web/index.html"   # the page; its directory is what it can load
```

The page's directory (never the package root) is part of the declaration:
every file under it is checked (at most 4096 files and 256 MiB, no links),
installed and signed with the package. The IDE loads the page from its own
`openidea-plugin` URL scheme into an `<iframe sandbox="allow-scripts">`: an
opaque origin, no network, no cookies or storage, no IDE API, and only the
page's own files (relative URLs, ES modules, fonts, WebAssembly) — so build
it with relative paths (Vite: `base: "./"`). The same `openidea` object as
in `html` bodies is there before the page's scripts run, plus:

| `window.openidea`                    | What it does                                                                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `document.get()`                     | `{ version, text, readOnly, name }` of the custom editor's document (`name`: the file's, without its directory; none in a tool window)                             |
| `document.edit(version, edits)`      | Applies `[{ from, to, insert }]` (UTF-16 offsets) as one change of the document's undo history; rejects with `stale` when not at `version`; resolves `{ version }` |
| `document.replace(version, text)`    | The same with the whole text (sent as the smallest edit)                                                                                                           |
| `document.onChange(fn)`              | `{ version, text }` after changes made elsewhere: the text editor, Undo, another window                                                                            |
| `saveFile({ name, data, filters? })` | The IDE's save dialog; `data` is a string, bytes or a Blob; the chosen path, or `null`. The page never names a path itself                                         |
| `openFile({ filters? })`             | The IDE's open dialog; `{ name, data }` (bytes), or `null`                                                                                                         |
| `postMessage` / `onMessage`          | To and from the plugin's code, when it has some                                                                                                                    |

Save, the dirty mark and Undo are the document's, as for every custom editor.
IDE shortcuts the page doesn't handle itself (Save, Close, Find Action…) still
work while it has focus; editing keys (⌘C, ⌘V, ⌘Z…) stay with the page. With
the `clipboard` capability the page may use `navigator.clipboard`.
An ungrouped tool-window web view that renders its own top bar can declare
`header = "none"` (API 1.3: `engines.openidea = "^1.3"`): once the page is
ready, the IDE replaces the standard tool-window header with top-right corner
actions (`Options` and `Hide`) and sets `--openidea-corner-inset-width` (`64px`)
and `--openidea-corner-inset-height` (`34px`) on the frame's root element (and
in `openidea.theme.vars`) so the page can pad its top bar around them. Loading
and error states keep the standard tool-window header.
Omitting `header` (or setting `header = "default"`) keeps the standard header.
For example, a page can reserve the corner in its own toolbar:

```css
.toolbar {
  min-height: var(--openidea-corner-inset-height, 0px);
  padding-right: var(--openidea-corner-inset-width, 0px);
}
```

`plugins/official/excalidraw` is a complete example: a Vite + React page in
`web-src/`, built into `web/` by `plugins/build.sh`. `plugins/official/graphviz`
pairs a page with code: the page renders (Graphviz compiled to WebAssembly) and
sends what Graphviz reports to the plugin, which publishes it as problems. The built page is not
checked in (it is tens of MB): run `plugins/build.sh official/excalidraw`
before installing the plugin from the repository.

### Web frame PTYs (API 1.3)

Packages requiring `engines.openidea = "^1.3"` can exchange JSON strings through
`openidea.postMessage` / `onMessage` to own an interactive PTY. Declare
`process:<program>` in the manifest; the install dialog shows its high-risk
permission and the user must grant it. The host runs the exact approved file,
never a fresh PATH lookup or an implicit fallback shell. A shell requires its
own grant. The cwd is always this window's trusted project root; a frame cannot
supply a cwd. Environment entries only add variables: replacing an inherited
variable (including PATH) is refused.

| Message      | Fields beyond `op` and `sessionId`                                                         |
| ------------ | ------------------------------------------------------------------------------------------ |
| `pty-spawn`  | `program`, optional `args` (default `[]`), `env` (default `{}`), `cols` (100), `rows` (28) |
| `pty-input`  | `data`, at most 64 Ki UTF-16 code units pending or in flight                               |
| `pty-resize` | Integer `cols` (2–500), `rows` (1–500)                                                     |
| `pty-kill`   | None                                                                                       |
| `pty-ack`    | `sequence` from the last `pty-data`, after consuming its data                              |

`sessionId` is 1–64 ASCII letters, digits, underscores, dots or hyphens. Duplicate
live session ids are refused. There are at most 8 sessions per plugin across its
frames, including pending spawns. A frame controls only its own sessions. Limits:
256 arguments of 4096 UTF-8 bytes each, 64 new environment entries (names 256
bytes, values 4096), no NUL. Bridge messages are at most 2 Mi UTF-16 code units.

The host sends `pty-data { sessionId, data, sequence }`,
`pty-exit { sessionId, exitCode }` (nullable), or
`pty-error { sessionId, error }`. Only one output chunk is unacknowledged at a
time. Outstanding output, including that chunk, is capped at 256 Ki UTF-16 code
units; overflowing input or output terminates the session and reports an error.
Exit follows consumption of the remaining output. Unmounting, reloading,
disabling, unloading, changing grants, switching projects or closing the window
kills its PTYs, including spawns that complete after cleanup. Pages may start fresh sessions after a reload or grant change.

`crates/ide-plugin/tests/fixtures/web-pty` is a minimal built Wasm package with a
web page: start bash without the optional grant to see refusal, grant
`process:bash` in Settings → Plugins, then send commands and resize or stop it.
This API is a web bridge extension; existing WIT signatures are unchanged.

### Streaming log editor tabs (API 1.3)

A web view can open a read-only editor tab backed by an authorized process:

```js
openidea.postMessage(JSON.stringify({
  op: "open-log-tab",
  key: "server-output",
  title: "Server logs",
  program: "my-server",
  baseArgs: ["logs"],
  toggles: [{ id: "verbose", label: "Verbose", args: ["--verbose"] }],
}));
```

Declare `engines.openidea = "^1.3"` and `process:my-server` in the manifest.
The install permission prompt and exact pinned executable, trusted project cwd,
session caps and lifecycle rules are the same as for web frame PTYs. The tab
uses the backend PTY API, never a shell fallback. It supplies no environment
overrides; the environment is inherited. A shell requires its own explicit grant.

`program` is required. `baseArgs` and `toggles` default to empty arrays; `title`
defaults to the program. Each toggle has a unique `id`, a plugin-localized
`label`, and `args` appended after `baseArgs` in declaration order. Changing a
toggle terminates the previous process and replaces the stream. `key` defaults
to the title and is scoped to the calling plugin and view; reopening the same
key focuses its existing tab. Titles are at most 256 characters, keys 128,
and at most 32 toggles have ids of 64 and labels of 128 characters. The combined
arguments must fit the PTY limits above. `cwd` and `env` are refused. Invalid or
ungranted requests send `log-error { error }` through `openidea.onMessage`;
backend start errors appear in the tab.

The viewer supports selection/copy, soft wrap, Find, font zoom and Clear. It
retains at most 5,000 lines and 1 Mi UTF-16 code units, including partial lines.
Output is acknowledged only after rendering; the PTY bridge's 256 Ki pending
output cap also applies. Tabs are read-only, never dirty and not restored on
restart. Recently used tabs keep streaming while hidden under the editor's
five-tab retention limit; evicting a hidden tab stops its process. Closing the
tab, disabling/updating the plugin, changing grants, switching projects or
closing the window stops it, including a pending spawn.

The built fixture `crates/ide-plugin/tests/fixtures/web-log` exercises permission
refusal, continuous Unicode output and a plugin-defined Verbose toggle. On Unix,
grant its optional `process:bash` permission and use its Log Probe tool window.
Its `Log Probe: Open Stream` and `Log Probe: Try Undeclared Program` commands
also ask the sandboxed page to open a tab, exercising the Wasm-to-page bridge.
This extends the web bridge without changing released WIT signatures.

### Plugin-backed content editor tabs (API 1.3)

A web view can open an editor tab on content the plugin supplies, with
plugin-defined toolbar actions that call back into the plugin. Declare
`engines.openidea = "^1.3"` when using this protocol:

```js
openidea.postMessage(JSON.stringify({
  op: "open-content-tab",
  key: "service-config",
  title: "service.toml",
  fileName: "service.toml",
  language: "toml",
  content: "name = \"demo\"\nreplicas = 2\n",
  readOnly: false,
  actions: [
    { id: "reload", label: "Reload", icon: "rerun" },
    { id: "diff", label: "Diff", icon: "diff" },
    { id: "save", label: "Apply", icon: "green-checkmark", primary: true, save: true },
  ],
}));
```

`title` (1–256 characters) and `content` (at most 1 Mi UTF-16 code units, no NUL)
are required. `key` (1–128 characters) defaults to `title` and is scoped to the
calling plugin and view; `fileName` (1–256 characters, no path separators) and
`language` (1–64 characters) select syntax highlighting and the tab's file icon.
`readOnly` defaults to `false`. `actions` lists up to 16 toolbar buttons with
unique `id`s (1–64 characters), `label`s (1–128 characters), an optional built-in
`icon` name, `primary`, and `save` (at most one action may set `save: true`).
Invalid requests send `content-tab-error { error }` through `openidea.onMessage`.

Clicking an action (or saving via ⌘S / the close-with-changes prompt) sends
`content-tab-action { requestId, key, action, content }` to the web view and, when
the plugin has code, as a `ViewEvent::Message`. The plugin replies with
`content-tab-reply { requestId, content?, saved?, readOnly?, status?, error?, diff? }`:

- `content` replaces unchanged editor text and updates the clean baseline (unless `saved: false`); later edits stay in the editor;
- `saved: true` marks the submitted content clean; edits made while the action is pending remain dirty;
- `saved: false` rejects a pending Save and keeps the tab open and dirty;
- `status` / `error` update the toolbar status (and `error` rejects a pending Save so the tab stays open and dirty);
- `diff: { left, right, leftLabel?, rightLabel?, title? }` opens the IDE's diff viewer.

The tab participates in the standard `EditorDocumentLifecycle` (dirty indicator,
Save / Don't Save / Cancel prompt on close, Undo / Redo, and read-only toggle).
`crates/ide-plugin/tests/fixtures/web-content` is a built fixture exercising this flow.

### Translations

A package translates its own text with `locales/<tag>.json`, one file per language
(`fr.json`, `zh-CN.json`), no manifest entry needed. A catalog maps the English source
text to its translation, like the IDE's text catalogs:

```json
{ "Count Words": "Compter les mots", "Refresh": "Actualiser" }
```

The IDE applies the catalog of the selected language (the exact tag, then the language,
then a variant such as `zh-TW` for `zh`) to the titles, categories, labels and tooltips
of the manifest's commands, views, editors, status bar items, settings (and their
properties), file templates, themes and secrets, and to what views show: toolbar
buttons, tree and list items, form field labels, table column names, messages and the
status line, and status bar items set by code. Text without an entry, and every text
when the language has no catalog, shows as written. A catalog applies to its own plugin
only and never changes the IDE's text. `openidea-plugin check` refuses a catalog that is
not a JSON object of strings.

Text the plugin builds itself (notifications, error messages, `html` bodies, cell data)
is not translated: read `host::locale()` when making it. It follows a change of
language, and `MockHost::set_locale` sets it in tests.

### Settings

```toml
[contributes.settings]
schema = "settings.schema.json"
```

```json
{
  "properties": {
    "context": { "type": "string", "title": "Context", "default": "" },
    "tailLines": { "type": "integer", "title": "Log lines", "default": 200 },
    "shell": { "type": "string", "enum": ["sh", "bash"], "default": "sh" }
  }
}
```

Types are `boolean`, `string` (optionally `enum`, `multiline`), `number` and
`integer`, each with a `default`. The IDE generates the page under
Settings › Plugins (searchable; projects can override values) and the plugin
reads values with `host::setting*`; a stored value of the wrong type falls
back to the default.

#### Multiple pages, groups, lists and tables (API 1.3)

Require `engines.openidea = "^1.3"` when using pages, groups, arrays or actions.
The single `schema` form above remains supported; do not combine it with `pages`.

```toml
[contributes.settings]
title = "Model Profiles"

[[contributes.settings.pages]]
id = "templates"
title = "Commit Template"
schema = "templates.json"

[[contributes.settings.pages]]
id = "llm"
title = "LLM Settings"
schema = "llm.json"

[[contributes.settings.pages.actions]]
title = "Test"
command = "test" # must also be declared under contributes.commands
```

Each page appears under the plugin's Settings node. Page titles, property
labels, descriptions, groups, table columns, enum options and action titles
are searchable. Page ids must be unique, contain no dots, and follow the
contribution id rules. Setting keys are unique across the entire plugin;
`host::setting(key)` still returns JSON, including arrays.

Properties with `"group": "Provider"` share a heading in schema order.
An `array` with `"items": {"type": "string"}` provides add/remove/reorder.
For a model-profile table, use:

```json
{
  "properties": {
    "profiles": {
      "type": "array", "title": "Model profiles", "group": "Provider",
      "items": {
        "type": "object",
        "properties": {
          "name": { "type": "string", "title": "Name" },
          "provider": { "type": "string", "title": "Provider", "enum": ["local", "openai"], "default": "local" },
          "baseUrl": { "type": "string", "title": "Base URL" },
          "model": { "type": "string", "title": "Model" }
        }
      }
    }
  }
}
```

Table cells support scalar types, including enums. Rows edit inline; new rows
use each column's default. Nested collections are unsupported. Arrays default
to `[]` and contain at most 1,000 entries. A plugin can declare at most 32 pages,
200 settings across pages, and 32 actions per page.

Edits use the normal Apply/OK/Cancel flow. **Running a page action applies all
pending settings first**, then invokes its declared command. A failed save
prevents the command; a command error appears beside the button. Successful
commands report through plugin notifications. Cancel after an action does not
undo settings that action already applied. Secrets remain under
`[[contributes.secrets]]`; never store API keys in a profile table. Custom web
settings pages and conditional fields are unsupported; use a plugin view for
other custom UI.

See the [complete two-page fixture](../crates/ide-plugin/tests/fixtures/settings-pages)
for a model-profile table and working Test action, and the
[Rust SDK settings example](../sdk/rust/openidea-plugin/README.md#multi-page-settings-api-13).

### Remote projects

Plugin code runs where the project is. When a window opens a remote project,
the desktop sends its enabled code plugins and their grants to
`openidea-server`, which runs them next to the files: `read_file`,
`find_files`, `run_process`, `fetch` and diagnostics all act on the remote
machine, and `process:` programs are resolved on its `PATH`. Changes on the
desktop (install, disable, grants) follow within a second. Secrets stay in the
desktop's keychain; the server asks for one when a request header needs it.
Status items, notifications, tasks, views, custom editors and terminals of
remote plugins show in that window; a custom editor edits the remote
document.
Project plugins (`.openidea/plugins`) don't run in remote projects yet, and a
plugin's storage on the server starts empty.

### Sandbox and limits

Each plugin gets its own wasmtime `Store`: no preopened directories, no
environment, no network, no inherited stdio — only clocks and randomness from
WASI, plus the host functions above. Every call into the plugin is bounded:

- **CPU:** a fuel budget (≈ 5·10⁹ wasm instructions) per call;
- **time:** 5 s wall clock for commands, activation and deactivation; editor
  providers (syntax, completion, code actions, navigation, line markers) get
  50 ms — a later result is dropped, but the instance keeps running — and are
  interrupted at 500 ms;
- **memory:** 256 MiB of linear memory.

Each active plugin runs on its own thread; calls are queued, never run
concurrently in one instance. A panic, trap, permission violation or exceeded
limit drops the instance: the user is told once, and the plugin starts afresh
the next time it is needed, after a pause that doubles with each crash in a
row (1 s, 2 s, …). Three crashes in a row mark it _Failed_ for the session
(with the reason in Settings › Plugins); toggling it off and on, or _Reload_,
starts it again. A call that returns normally resets the count. Settings ›
Plugins shows activations, call latency (p95), crashes, late editor results
and reclaims. The IDE itself is never affected.

## 4. Themes

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

Start with `openidea-plugin new <dir> --template theme` (or a copy of
[`official/harbor-night`](official/harbor-night)); the full guide, token
reference and IntelliJ / VS Code porting tables are in
[`docs/plugins/themes.md`](../docs/plugins/themes.md).

## 5. File icon themes

```toml
[[contributes.iconThemes]]
id = "material"
label = "Material Icons"
path = "icons/theme.json"
```

`theme.json` maps names to SVGs (paths relative to the package):

```json
{
  "iconDefinitions": { "rust": "icons/rust.svg", "folder-src": "icons/folder-src.svg" },
  "file": "file", "folder": "folder", "folderExpanded": "folder-open",
  "fileExtensions": { "rs": "rust", "d.ts": "typescript-def" },
  "fileNames": { "cargo.toml": "cargo" },
  "folderNames": { "src": "folder-src" }
}
```

Files match by exact name, then the longest extension (`a.test.ts` tries
`test.ts`, then `ts`), then `file`. Folders match by name, then
`folder`/`folderExpanded`; folders with a role (source root, excluded, module)
keep their built-in icons. Names are case-insensitive. Up to 5000 icons of at
most 64 KiB each. Every SVG is sanitised on install: allow-listed elements and
attributes only, no scripts, event handlers, external references, `url()` or
entities. Apply a theme in Settings › Plugins; see
[`official/material-icons`](official/material-icons) for a complete one.

Optional fields:

```json
{
  "iconDefinitions": { "rust": { "light": "icons/rust.svg", "dark": "icons/rust_dark.svg" } },
  "folderOpen": "folder-open",
  "patterns": [
    { "pattern": "^.*\\.spec\\.ts$", "icon": "test-ts", "ignoreCase": true },
    { "pattern": "/fixtures/", "icon": "fixture", "path": true, "group": "tests" },
    { "pattern": "^src$", "icon": "folder-src", "target": "folder", "openIcon": "folder-src-open" }
  ],
  "overrides": { "chevron-right": "arrow-right", "symbol-class": "class" },
  "groups": [{ "id": "tests", "name": "Tests", "enabled": false }],
  "choices": [
    {
      "id": "arrows", "name": "Arrows", "default": "plain",
      "options": [
        { "id": "plain", "name": "Default" },
        { "id": "plus", "name": "Plus-Minus", "overrides": { "chevron-right": "plus" } }
      ]
    }
  ],
  "accent": true,
  "settings": [
    {
      "title": "Icons",
      "items": [
        { "option": "hideFiles", "invert": true, "label": "Show file icons", "hint": "In trees, lists and tabs" },
        { "option": "groups", "columns": 2 },
        { "option": "choice", "choice": "arrows" },
        { "option": "iconSize", "label": "Icon size", "default": 16 }
      ]
    }
  ]
}
```

- `iconDefinitions` values may be `{ "light", "dark" }`; the dark SVG is used
  in dark themes. Icon ids may not end in `_dark`.
- `patterns` are regular expressions checked in order, before `fileNames`
  and `fileExtensions`. `target` is `file` (default) or `folder`; with `path`
  a pattern matches the whole path (`/` separators) instead of the name;
  `ignoreCase` ignores case. Patterns that could backtrack badly (a repeated
  group, too many ways to match one name), lookaround, inline flags and
  named groups are refused.
- `openIcon` (folder patterns) and `folderOpen` (other folders) are used for
  folders holding a file open in the editor when _Hollow folders_ is on.
- `overrides` replace built-in IDE icons by name (`chevron-right`,
  `folder-source`, …); symbol icons (`symbol-<kind>`, `class`, `method`, …)
  are PSI icons.
- `groups` are packs of patterns the user turns on or off; `enabled` is the
  default.
- `choices` are variants the user picks one of; the picked option's
  `overrides` win over `overrides`.
- `accent: true`: elements with `data-tint="true"` take the colour the user
  picks.
- Elements with `data-themed="true"` take the accent colour of Settings ›
  Appearance, or the theme's custom accent colour.

- `settings` describe the theme's page in Settings › Plugins › _theme label_;
  a theme without them has no page. Sections have a `title` and `items`; an
  item names an `option` the IDE implements, with the theme's `label`,
  optional `hint` and, where the option needs one, `default`:

  | `option`                                                                   | Control              | Item fields                                          |
  | -------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------- |
  | `hideFiles`, `hideFolders`, `hideUiIcons`, `hidePsiIcons`, `hollowFolders` | checkbox             | `invert`: checked means off                          |
  | `groups`                                                                   | a checkbox per group | `columns` (1–4), `label?` (group names are shown)    |
  | `choice`                                                                   | the choice's options | `choice` (its id), `label?` (default: its name)      |
  | `accent`, `monochrome`                                                     | checkbox and colour  | `default` (`#rrggbb`); `accent` needs `accent: true` |
  | `saturation` (0–20), `opacity` (10–100), `iconSize`, `rowHeight` (px)      | checkbox and number  | `default` within the range                           |

  `iconSize` is 12–32 and `rowHeight` 16–48. Values are kept per theme in
  `appearance.fileIconThemeOptions` and apply while the theme is selected.

The first icon theme of a plugin is selected when the plugin is installed or
enabled while no icon theme is.

## 6. Languages

`languages/<id>.toml` files use the IDE's own language format; see any file in
[`languages/`](../languages); [`official/solidity`](official/solidity) is a
complete example.

Plugin languages join the IDE's language registry like built-in ones: file
detection (`extensions`, `filenames`, `first-line`), comments, indentation,
`ui-mode`, `framework-ui-modes`, and the `language-servers` and `debugger`
they declare (each needs its `process:` grant). A plugin cannot replace a
built-in or user definition: their ids, extensions and file names win (users
can still map files to a plugin language in Settings › File Types). In a
remote project the definitions are sent to the server, which starts the
servers there.

`[[framework-ui-modes]]` entries (`ui-mode`, `root-markers`)
replace `ui-mode` for the files of a framework's projects: the first whose
root marker is in a directory above the file, up to the project folder, applies
(see [`languages/html.toml`](../languages/html.toml), Angular templates).
Markers are matched like a language server's `root-markers`.

### 6.1 Syntax for languages without a grammar

The IDE parses its built-in languages with tree-sitter. For a plugin language
it has no grammar for, the plugin's component can export `syntax-provider`
(world `plugin-syntax`): flat highlight tokens, structure-view symbols and
folds for a whole document, in UTF-8 byte offsets. With the SDK:

```rust
use openidea_plugin::syntax::{Fold, Highlight, Symbol, SyntaxProvider, Token};

impl SyntaxProvider for MyPlugin {
    fn highlights(&mut self, language: &str, text: &str) -> Vec<Token> { … }
    fn outline(&mut self, language: &str, text: &str) -> Vec<Symbol> { … }   // optional
    fn folding(&mut self, language: &str, text: &str) -> Vec<Fold> { … }     // optional
}

register_plugin!(MyPlugin, syntax);
```

It runs on the editing path (once per document version, cached), so keep it
fast — a hand-written lexer is typical (`syntax::bracket_folds` helps with
folding). Add `activation = ["on-language:<id>"]` so the component loads with
the first file. Results are validated (clamped to the text, overlaps dropped).

### 6.2 Run configurations

```toml
[[contributes.runDetectors]]
id = "forge-test"
name = "forge test"
files = ["foundry.toml"]     # offered in projects with any of these at the root
command = "forge"            # one program; needs process:forge
args = ["test"]
test = true                  # results go to the test tree
```

The configuration appears among the detected ones while `process:<command>` is
granted, and starts the approved program.

## 7. Installing and developing

- **Install:** Settings › Plugins › _Install Plugin from Disk…_ (a package
  folder) or _Install Plugin from Package File…_ (a `.oiplugin`, a `.zip` with
  the package at its root or in its only folder, or a folder's `plugin.toml`;
  a zip without a `plugin.toml` there, such as an IntelliJ plugin, is refused; IntelliJ
  theme plugins are imported instead: _Import IntelliJ Theme from File…_ and _Import Theme
  from JetBrains IDE…_, see [`docs/plugins/themes.md`](../docs/plugins/themes.md)). The install
  page lists every capability and whether the package is signed by a publisher
  the marketplace trusts; nothing is copied until you accept.
- **Versions:** installed plugins live in `<app-data>/plugins/<id>/<version>/`
  with an `active` pointer that is switched only once the new version is in
  place. An update whose code fails to start the first time is rolled back to
  the version it replaced automatically (you're told why); _Roll Back to …_
  in the plugin's details does it by hand. Data (`storage`) is per plugin, not
  per version.
- **Updates:** when the daily marketplace check finds newer versions of
  installed plugins, the IDE says so once, with _Update All_ (also in the gear
  menu and as the _Update All Plugins_ action). An update that asks for
  nothing new installs with the grants the installed version has; the install
  page is shown only for new capabilities, an unsigned package or another
  signer (see _Distribution_).
- **Linked plugins:** `openidea-plugin link <dir>` (§1). Listed with a _linked_
  tag; capabilities are granted per folder.
- **Project plugins:** put (or symlink) the package in
  `<project>/.openidea/plugins/<name>/`. They load only in trusted projects and
  only after you approve their capabilities.
- **Where:** installing, removing, enabling, granting and reloading plugins
  work on the welcome screen and in trusted projects. A project opened in
  restricted mode can browse the marketplace and show a package's install
  page, but not change which plugin code runs.
- Commands appear in Search Everywhere › Actions under their category, and can
  be bound in Settings › Keymap like any other action.
- **Troubleshooting:** `openidea-plugin check` says why a package would be
  refused. Settings › Plugins shows each plugin's state, why it failed if it
  did, and its call stats (§3, _Sandbox and limits_). `host::log` lines go to
  the IDE log (Help › _Show Log in Finder_ / _Explorer_ / _Files_) tagged with
  the plugin id; debug and trace lines are written when the IDE is started
  with `RUST_LOG=info,ide_plugin=trace`. `eprintln!` output is logged as
  well, and a panic's message is shown with the crash.

## 8. Distribution

A **package** is a zip named `<id>-<version>.oiplugin`: the manifest, the
files it references, the component, licence files and, when signed,
`SIGNATURE.json` (Ed25519 over the plugin id, version and the digest of its
files).

```sh
openidea-plugin keygen acme.key                     # once; keep the file secret
openidea-plugin pack plugins/acme-tools --key acme.key --publisher acme
openidea-plugin index market/ --publisher acme --name "ACME" --key acme.key
openidea-plugin check acme.tools-1.0.0.oiplugin      # a package as installing would check it
openidea-plugin merge market/index.json https://example.com/index.json --keep acme
openidea-plugin endorse <new public key> --key acme.key --publisher acme   # when rotating keys
```

A **marketplace** is static: an `index.json` and the packages next to it, on
any web server or folder. It lists publishers and their public keys (the trust
root: publisher `acme` owns plugin ids `acme.*`), the plugins with their
digests, and revocations. Settings › Plugins › Available reads it from the URL
you set; installing downloads the package, checks it against the index entry
and the publisher's key, then shows the install page.

- A package whose signature doesn't hold (changed after signing, a key that
  isn't the publisher's, another publisher's id prefix, a revoked key) is
  refused. Unsigned packages install from disk with a warning.
- **Revocation:** the index can revoke plugin versions (or all versions) and
  publisher keys. The IDE reads the index daily; revoked plugins are disabled
  with the reason and the user is notified — also after a restart, before
  their code could run.
- **Key rotation:** a publisher rotates keys by registering the new one with
  `index --key new.key --previous-key old.key`: the old key endorses the new
  one, and older keys stay valid until revoked (`endorse` prints the
  endorsement for an index someone else writes, such as the registry's). An installed plugin updates
  silently only to a package signed with the key it was installed with, or
  one that key endorsed (directly or through endorsed keys; endorsements by
  revoked keys don't count). Another signer — an unendorsed key, or an
  unsigned package replacing a signed one — is shown on the install page and
  needs the user's confirmation.
- **Official key:** release builds carry the official publisher's public key
  (`OPENIDEA_OFFICIAL_PLUGIN_KEYS`, derived from the release's signing key).
  `openidea.*` plugins must be signed with it, or with a key it endorsed,
  whatever keys an index lists for `openidea`.
- **Format:** fields are only ever added to the index (an IDE ignores those it
  doesn't know), and `format` stays `1` unless older IDEs can't read the
  change. An IDE reading a newer format still applies its revocations and
  `moved`, lists no plugins, and asks the user to update.
- **Moving:** an index with `"moved": "<url>"` sends the IDE to the index at
  that URL (relative or absolute; https stays https), so a marketplace can
  change hosts while released IDEs keep the address they were built with.

**Versions.** Each index entry records the plugin API it needs (`engine`: the
manifest's `engines.openidea`, narrowed to the API its component was built
for; an entry without one is offered to no IDE), and a plugin may be listed in
several versions. Settings › Plugins
offers the newest version this IDE can load; when there is none, it shows the
plugin as incompatible and says which API it needs. Entries also carry the
plugin's categories, which Settings › Plugins › Available filters by. Indexing keeps, of each
plugin, the newest version per API requirement, so users of an older IDE keep
the last version built for them.

`index` with a key registers the publisher and lists the folder's packages
as its plugins (their earlier versions stay as above; plugins no longer in the
folder go), keeping the other publishers'; `--download-base` makes downloads
absolute, so a version stays where it was first published. Without a key, it
lists every package in the folder, each checked against the publishers the
index already has. `merge` takes the
publishers, plugins and revocations of another index (downloads made absolute)
in place of every publisher but `--keep`; `check` also takes a `.oiplugin`.

### 8.1 Official and community plugins

The IDE's default marketplace is `plugins-index.json` of the latest release.
It lists two kinds of plugins:

- **Official** (`plugins/official/`, ids `openidea.*`): maintained in this
  repository, built and signed by its release workflow, and kept working as
  the API changes. New official plugins are proposed in an issue first; they
  cover general needs or show how to use part of the API.
- **Community** (their authors' ids and keys): developed in their authors'
  repositories and listed through the registry,
  [l0ng-ai/openidea-plugins](https://github.com/l0ng-ai/openidea-plugins).
  An author registers a publisher (an id prefix, its public key and the GitHub
  accounts that may change it) and adds each plugin version by pull request;
  the registry checks the package (digest, signature, `openidea-plugin check`)
  and publishes its index, which `plugins-index.yml` merges into the release's
  within the hour. Its README has the rules.

Pull requests that add a plugin to this repository are for official plugins.
A plugin that needs a new extension point brings the extension point here, as
its own pull request, and the plugin to the registry.

## 9. Testing the host

The host's integration tests (`crates/ide-host/tests/plugins.rs`) load the
checked-in components of the official plugins and of the test fixtures
(`crates/ide-plugin/tests/fixtures/`).
Rebuild them after changing a plugin, the SDK or the WIT files:

```sh
plugins/build.sh                         # all of them
plugins/build.sh official/solidity       # one
plugins/build.sh --check                 # what CI runs: nothing stale, everything builds
cargo test -p ide-host --test plugins
```

Next to each `dist/plugin.wasm`, `dist/plugin.wasm.sources` fingerprints the
sources it was built from (the plugin, the SDK and `wit/`); builds are not
byte-reproducible across machines, so `--check` compares fingerprints.

The SDK carries a copy of `wit/` in `sdk/rust/openidea-plugin/wit`; keep them
identical (a test in `crates/ide-plugin/tests/api_compat.rs` checks). Changing
the API itself follows _Evolving the plugin API_ below.

## 10. Evolving the plugin API

Released versions are frozen: 1.0.0 shipped with OpenIDEA 0.1.36, 1.1.0
with 0.1.37 and 1.2.0 with 0.1.38. wasmtime decides what stays compatible: it resolves interface names
by semver (a component importing `openidea:plugin/x@1.0.0` links against a
host defining `@1.1.0`, and the host finds its exports the same way), but
function types must match exactly — a record with another field count, or a
variant or enum with another case count, doesn't link. So a released 1.x
only grows:

1. **Released types and signatures never change**, whichever way the data
   flows: no new record fields, variant or enum cases, renames or parameters.
   Extend with new types and new functions (or interfaces). `types.error` is
   used everywhere and is no exception; new situations use `failed(string)`
   or `invalid(string)`. Sets that keep growing (completion, token, symbol and
   fold kinds, icons, event kinds, action sources, diagnostic tags) are
   strings for this reason, and variants that grow (`event`, view `body`,
   `view-event`, `field-value`) have an `other(extension)` case, a kind and
   JSON data, that carries later cases to older plugins and IDEs.
2. **Host interfaces (imports) may gain functions and interfaces**: older
   components don't import them.
3. **Plugin interfaces (exports) never gain functions** once released: the
   host would not find them in older components. New capabilities get new
   interfaces (e.g. a `hover-provider`) in new optional worlds.
4. **The host knows each component's API version** (the highest version of
   its `openidea:plugin/*` imports and exports, `PluginEngine::check_component`).
   Installing and `openidea-plugin check` refuse another major or a newer
   minor with a message that says to update the IDE or rebuild with the SDK.
   They also link the component, so one that imports a function this host
   lacks under the same version (built from unreleased WIT) is refused too.
5. **One version number**: the `wit/` package version, `ENGINE_VERSION` and
   `API_VERSION` agree, and the SDK's `wit/` copy is identical to `wit/`.
6. **1.x calls are synchronous and pass documents whole.** Host calls block
   the plugin's instance, and providers get the document's text with each
   call. WASI 0.3 async components come with 2.0, behind an adapter in the
   host that keeps 1.x plugins running; incremental document sync, if
   needed, is a new interface.

Checked automatically:

- SDK `tests/api_frozen.rs`: `tests/api/released/` holds the WIT of the latest
  released version; every interface, type, function and world import or
  export in it must still exist unchanged in `wit/` (rules 1–3). Under the
  released version `wit/` must match it exactly, so additions start with a
  version bump. Each snapshot passed this check against the one before, so
  one snapshot covers every release.
- Releasing: `pnpm release:prepare <version>` makes the release commit's
  changes; when the `wit/` version changed, it copies `wit/*.wit` over
  `tests/api/released/`. The release workflow refuses a tag whose `wit/`
  version differs from the snapshot's.
- `crates/ide-plugin/tests/api_compat.rs`: the versions agree, the SDK's copy
  matches, the version check (rules 4, 5); a simulated next-minor host (every
  import stubbed at the newer version, plus extra functions and an extra
  interface) links every shipped component and finds its exports; another
  major doesn't link; a host missing one function doesn't link.

A new host function touches:

| Where                                                     | Checked by                                     |
| --------------------------------------------------------- | ---------------------------------------------- |
| `wit/*.wit`, copied to `sdk/rust/openidea-plugin/wit`     | `api_compat.rs::the_sdk_carries_the_hosts_wit` |
| `crates/ide-plugin/src/wit_host.rs`: binding, capability  | the compiler (bindgen's traits)                |
| `crates/ide-plugin/src/runtime.rs`: `HostApi` method      | the compiler                                   |
| `crates/ide-host/src/plugins/api.rs`: implementation      | the compiler (desktop and `openidea-server`)   |
| SDK `src/host.rs`: the wasm and the mock `imp`            | the compiler (CI builds both targets)          |
| SDK public wrapper                                        | SDK `tests/wit_coverage.rs`                    |
| Capability: `ide-extension/src/capability.rs`, consent UI | review; a test that a missing grant is denied  |
| The API table above                                       | review                                         |

Then run `plugins/build.sh`; CI's `plugins` job runs `plugins/build.sh --check`
plus fmt, clippy (host and wasm) and the tests of the SDK, the official
plugins and the fixtures.

### Directory selection and opening projects (API 1.3)

`host::pick_directory(title, initial)` opens the window's native folder chooser
and returns an absolute path, or `None` when dismissed. Like `pick`, it is only
available during a command or event from a window; waiting for the user does not
consume the plugin's call budget. `initial` is an optional absolute directory.

`host::open_project(path, new_window)` requests the normal File › Open flow in
that window (`false`) or a new window (`true`). Existing project windows are
reused as usual, and the normal trust prompt and unsaved-change guard apply.
The call acknowledges the request; cancellation or opening errors are handled by
the window. Neither API needs a capability. Paths belong to the UI machine,
including when plugin code runs on a remote host.

### Project HTTP endpoints (API 1.3)

A plugin with `project.read` can export `endpoints-provider` to share its routes
with Search Everywhere's Endpoints section, request URL completion in `.http`
files, and the declaration's **Open in HTTP Client** gutter action. The action
opens the generated-requests scratch; requests start at `http://localhost:8080`
and path parameters become HTTP client variables. Adjust the host for the app.

```toml
engines.openidea = "^1.3"
[capabilities]
required = ["project.read"]
[[contributes.endpoints]]
files = ["config/routes.rb", "routes/**/*.php"]
```

Implement `endpoints::EndpointsProvider` and use
`register_plugin!(MyPlugin, endpoints)` in the Rust SDK. `endpoints(ctx)` receives
an explicit project invocation. It runs the first time the IDE needs that
project's routes, and again after a file matching `files` is created, changed or
removed; in between the host answers from its cache. Return the complete list
(an empty list clears it). `method = None` accepts any method; the optional handler is a display name.
Each endpoint has a required declaration location inside that project, with
zero-based lines and UTF-16 columns. The generated request uses GET for any-method
routes. Calls run in the background and cannot open prompts.

The host validates a whole batch before replacing the last valid result (up to
10,000 endpoints, 4 MiB of route metadata, 16 MiB of declaration documents).
Disabling, uninstalling, reloading or crashing a plugin withdraws its routes;
idle instance reclamation keeps them cached. Closing a project withdraws its
cache. Windows only receive routes for their current project. This API does not
add an Endpoints tool window.

### Notifications with commands

`host::notify_with_actions(level, title, body, actions)` shows up to three
buttons. Build each with `NotificationAction::new(label, command)` and an
optional `.argument(text)`. Commands must be declared by that plugin; choosing
one dismisses the balloon and runs the command in the receiving window with
its normal editor and project context. No capability is needed. Invalid or
undeclared actions reject the whole notification. Labels are limited to 256
bytes and arguments to 64 KiB. Plain `host::notify` behaves as before.
