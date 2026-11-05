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
crates/ide-plugin/tests/fixtures/  # test plugins: hello, jobs, language-toy, misbehave
```

The plugin API is defined in [`wit/`](../wit/) (`openidea:plugin@1.1.0`, world
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

All paths are relative to the package directory and may not leave it. A
manifest is validated as a whole: if one contribution is invalid, nothing is
installed or loaded. Contribution types the IDE does not know (a newer API) are
skipped with a warning.

Manifests in the 0.1 format (`openidea-api = "0.1"`, `permissions = [...]`)
still load (their permissions become required capabilities; contributions
work), but 0.1 code no longer runs: rebuild it against the 1.0 SDK.

### Contribution points

| Point           | Declaration                                                                                                                       | Code needed   |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `commands`      | `id`, `title`, `category?`, `when?`                                                                                               | to run them   |
| `themes`        | `path` (theme JSON), `editor-scheme?`                                                                                             | no            |
| `iconThemes`    | `id`, `label`, `path` (icon theme JSON, see §5)                                                                                   | no            |
| `languages`     | `path` (`languages/<id>.toml` format, see §6)                                                                                     | no            |
| `runDetectors`  | `id`, `name`, `files`, `command`, `args?`, `test?` (§6.2)                                                                         | no            |
| `providers`     | `kinds`, `languages` (editor providers, see _Providers_)                                                                          | yes           |
| `secrets`       | `name`, `label`, `description?` (see _Network_)                                                                                   | to use them   |
| `menus`         | `menu` (`editor.context`, `projectView.context`, `editorTab.context`, `view.item.context`, `tools`), `view?`, `command`, `when?`  | no            |
| `keymaps`       | `command`, `key`, `mac?` (`Ctrl+Alt+C`; a chord: `Meta+K Meta+C`)                                                                 | no            |
| `statusBar`     | `id`, `text`, `tooltip?`, `command?`, `align?`, `priority?`                                                                       | no            |
| `settings`      | `schema` (JSON file), `title?` — one table, see _Settings_                                                                        | no            |
| `views`         | `id`, `title`, `icon?` (an icon name, or an SVG of the package), `location` (`left`, `right`, `bottom`), `web?` (see _Web views_) | without `web` |
| `customEditors` | `id`, `title`, `patterns` (file names), `priority` (`default`, `option`), `layout?`, `web?`                                       | without `web` |
| `fileIcons`     | `id`, `patterns` (file names), `icon` (SVG), `iconDark?` — whatever icon theme is in use                                          | no            |
| `fileTemplates` | `id`, `name`, `extension`, `path` (the new file's content; template variables work) — New menu                                    | no            |

A `view.item.context` menu needs `view`, the id of one of the plugin's own
views. It adds the commands to the right-click menu of the items in that
view's `tree` or `list`, and each command gets the item's key as its argument.
`when` clauses can use `viewItem` (the key) and `viewItemKind` (the key up to
its first `:`, so `pod` for `pod:default/nginx`):

```toml
[[contributes.menus]]
menu = "view.item.context"
view = "pods"
command = "kube.logs"
when = "viewItemKind == pod"
```

Declared contributions are live as soon as the plugin is enabled — commands
show in Find Action, menus and the status bar, shortcuts work, themes and icon
themes can be applied, settings pages are there — **before** any plugin code
is loaded. Menus, shortcuts and status bar items refer to the plugin's
declared commands. A plugin shortcut never takes a keystroke the IDE (or the
user) already uses; the user can rebind it in the keymap editor.

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

| Capability          | Risk   | Unlocks today                                                                       |
| ------------------- | ------ | ----------------------------------------------------------------------------------- |
| `project.read`      | low    | `Project::root`, `read_file`, `find_files`, `host::projects`, `publish_diagnostics` |
| `editor.read`       | low    | `TextEditor::document`, `selections`                                                |
| `editor.write`      | medium | `TextEditor::apply_edits`                                                           |
| `vcs.read`          | low    | `Project::vcs_status` (branch, upstream, ahead/behind, changes), `vcs_remotes`      |
| `vcs.write`         | medium | `Project::vcs_fetch` (trusted projects only)                                        |
| `storage`           | low    | `host::storage` (1 MiB per plugin)                                                  |
| `events`            | low    | file opened/saved, editor focused, repository changed events                        |
| `events.input`      | medium | `action-performed` events (which actions you run, and how)                          |
| `process:<program>` | high   | `Project::run_process`, language servers, debug adapters, runs                      |
| `net:<host>`        | medium | `host::fetch` to that host (`*.example.com`: its subdomains)                        |
| `secrets`           | medium | `{{secret:<name>}}` in request headers, `host::secret_is_set`                       |
| `clipboard`         | medium | `host::copy_to_clipboard` and the clipboard API in the plugin's web views           |

`process:` capabilities are also derived from what the contributions start: a
language's `language-servers` and `debugger` commands and a run detector's
`command`. Those are optional — refusing one keeps the rest of the plugin
working. On grant the program is resolved to an absolute path and its content
hash is recorded; it is checked again right before every start, and a replaced
file is refused until the user approves it again. In a remote project the
server resolves and pins the program on its own machine (see _Remote
projects_). `fs.read:<path>` can be declared and granted; it unlocks nothing
yet.

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
| `Project::root()`, `read_file(path)`                                     | `workspace.project`              | Absolute or project-relative; `..`/symlinks escaping the root are rejected; UTF-8 only, ≤ 16 MiB; unsaved editor contents win.                                                                                       |
| `host::projects()`                                                       | `workspace.projects`             | Every open project (for scheduled work without a window).                                                                                                                                                            |
| `Project::vcs_status()`, `vcs_remotes()`, `vcs_fetch()`                  | `vcs`                            | `vcs_remotes` returns `(name, url)` pairs; fetch runs git, so only in trusted projects (call it inside a task).                                                                                                      |
| `host::subscribe(kind)`                                                  | `events.subscribe`               | For the session, across idle reclaim (an event activates the plugin). Or declare `on-event:<kind>`.                                                                                                                  |
| `host::begin_task(title, cancellable)` → `Task`                          | `tasks.begin`                    | Shown with the background tasks; `report`, `is_cancelled`; the call may run 60 s instead of 5 s while it is open; dropping it ends it.                                                                               |
| `host::storage::{get, set, delete, keys}`                                | `storage`                        | Survives restarts; the instance's memory does not. Deleted on uninstall.                                                                                                                                             |
| `host::set_status_item(id, item)`, `remove_status_item`                  | `ui`                             | `text`, `tooltip`, `command` (one of yours, run on click); at most 8; kept while the plugin is idle.                                                                                                                 |
| `host::notify(level, title, body)`                                       | `ui.show-notification`           | Balloon in the window the command or events came from (every window otherwise).                                                                                                                                      |
| `host::copy_to_clipboard(text)`                                          | `ui.copy-to-clipboard`           | Copies `text` to the system clipboard. Needs `clipboard`.                                                                                                                                                            |
| `host::open_url(url)`                                                    | `ui.open-url`                    | Opens an `http://` or `https://` URL in the user's default browser.                                                                                                                                                  |
| `host::log(level, msg)`                                                  | `log`                            | IDE log, tagged with the plugin id. `eprintln!` output is logged too and shown when the plugin crashes.                                                                                                              |
| `Project::find_files(glob, limit)`                                       | `workspace.project.find-files`   | Project-relative glob (`**/*Mapper.xml`); honours `.gitignore`; at most `limit` paths.                                                                                                                               |
| `host::publish_diagnostics(path, items)`                                 | `diagnostics.publish`            | Replaces this plugin's problems for the file (editor squiggles and the Problems view); an empty list clears them.                                                                                                    |
| `host::fetch(request)` → `{status, headers, body}`                       | `net.fetch`                      | See _Network_.                                                                                                                                                                                                       |
| `Project::run_process(program, args, stdin)` → `{code, stdout, stderr}`  | `process.run`                    | Only the pinned program of a `process:` grant; runs in the project root of a trusted project; 4 MiB of output; killed when the call is cancelled or times out.                                                       |
| `host::refresh_view(view)`                                               | `views.refresh`                  | The view (or custom editors) render again; call it when the content changed.                                                                                                                                         |
| `host::post_view_message(view, text)`                                    | `views.post-message`             | To the script of the view's `html` body.                                                                                                                                                                             |
| `host::open_terminal(title, program, args)`                              | `views.open-terminal`            | A terminal tab in the invoking window running the approved `process:<program>` in the project root: output that keeps coming, interactive sessions.                                                                  |
| `host::open_location(path, line, column)`                                | `views.open-location`            | Opens a file inside the project in an editor of the invoking window, the caret at `line`/`column` (0-based, UTF-16): a view's links to code. Needs `project.read`.                                                   |
| `host::setting(key)`, `setting_bool`, `setting_string`, `setting_number` | `settings.get`                   | The user's value (project over global) or the schema's default.                                                                                                                                                      |

`run-command` receives an optional string argument: `executeAction("plugin.<plugin id>.<command id>", "arg")`
from another feature, or nothing when run from Search Everywhere / a shortcut.

### Events

| Kind               | Capability     | Delivered                                                                 |
| ------------------ | -------------- | ------------------------------------------------------------------------- |
| `file-opened`      | `events`       | a file opens in an editor                                                 |
| `file-saved`       | `events`       | after the file is written                                                 |
| `editor-focused`   | `events`       | the focused editor changes (path, or none)                                |
| `vcs-changed`      | `events`       | a repository's state changed (commit, checkout, fetch…; its root)         |
| `action-performed` | `events.input` | an IDE action ran: id, title, source (keyboard, menu, toolbar…), shortcut |
| `scheduled`        | —              | the `on-schedule` period elapsed                                          |

Events are batched: a running plugin gets them within a fraction of a second,
an idle one collects them for 2 s before it is woken, so frequent events
(Key Promoter's actions) don't keep it alive.

Kinds are names (`subscribe` takes a string), so later IDEs add kinds without
a new API: an IDE refuses a kind it doesn't know with `invalid`, and a kind
newer than the plugin's SDK arrives as `Event::Other { kind, data }` (JSON).
The SDK's event enums are `#[non_exhaustive]`; match them with a `_` arm.

### Providers

Declare what the plugin provides in the editor; only plugins whose
declaration matches the file's language are called (and loaded):

```toml
[[contributes.providers]]
kinds = ["definition", "line-markers", "completion"]  # also "inline-completion", "code-actions"
languages = ["java", "xml"]                           # editor language ids; "*" for any
```

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
command budget instead of the 50 ms. Problems (`publish_diagnostics`) can name
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
`plugins/official/excalidraw` is a complete example: a Vite + React page in
`web-src/`, built into `web/` by `plugins/build.sh`. `plugins/official/graphviz`
pairs a page with code: the page renders (Graphviz compiled to WebAssembly) and
sends what Graphviz reports to the plugin, which publishes it as problems. The built page is not
checked in (it is tens of MB): run `plugins/build.sh official/excalidraw`
before installing the plugin from the repository.

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

Released versions are frozen: 1.0.0 shipped with OpenIDEA 0.1.36 and 1.1.0
with 0.1.37. wasmtime decides what stays compatible: it resolves interface names
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
- Releasing: when the `wit/` version changes, copy `wit/*.wit` over
  `tests/api/released/` in the release commit. The release workflow refuses a
  tag whose `wit/` version differs from the snapshot's.
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
