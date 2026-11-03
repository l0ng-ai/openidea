//! The files of `openidea-plugin new`. Placeholders: `__ID__` (plugin id),
//! `__SLUG__` (last id segment), `__NAME__`, `__CRATE__`, `__SDK__`.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Template {
    Command,
    Theme,
    IconTheme,
    Language,
}

impl Template {
    pub const ALL: [Template; 4] = [Self::Command, Self::Theme, Self::IconTheme, Self::Language];

    pub fn parse(s: &str) -> Result<Self, String> {
        Self::ALL
            .into_iter()
            .find(|t| t.label() == s)
            .ok_or_else(|| format!("unknown template {s:?} (command, theme, icon-theme, language)"))
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Command => "command",
            Self::Theme => "theme",
            Self::IconTheme => "icon-theme",
            Self::Language => "language",
        }
    }
}

pub struct Vars<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub sdk: Option<&'a str>,
}

/// `(relative path, contents)` of every file of the template.
pub fn render(template: Template, vars: &Vars) -> Vec<(String, String)> {
    let slug = vars.id.rsplit('.').next().unwrap_or(vars.id).to_owned();
    let crate_name = format!("openidea-plugin-{}", vars.id.replace('.', "-"));
    let fill = |s: &str| {
        s.replace("__ID__", vars.id)
            .replace("__SLUG__", &slug)
            .replace("__NAME__", vars.name)
            .replace("__CRATE__", &crate_name)
            .replace("__SDK__", vars.sdk.unwrap_or(""))
            // The theme files come from templates/theme-plugin.
            .replace("harbor-night", &slug)
            .replace("Harbor Night", vars.name)
    };
    let files: Vec<(String, &str)> = match template {
        Template::Command => vec![
            ("plugin.toml".into(), COMMAND_MANIFEST),
            ("Cargo.toml".into(), COMMAND_CARGO),
            ("src/lib.rs".into(), COMMAND_LIB),
            (".gitignore".into(), "/target\n"),
            ("README.md".into(), COMMAND_README),
        ],
        Template::Theme => vec![
            ("plugin.toml".into(), THEME_MANIFEST),
            (format!("themes/{slug}.theme.json"), THEME_UI),
            (format!("themes/{slug}.scheme.json"), THEME_SCHEME),
        ],
        Template::IconTheme => vec![
            ("plugin.toml".into(), ICON_MANIFEST),
            ("icons/theme.json".into(), ICON_THEME),
            ("icons/file.svg".into(), ICON_FILE),
            ("icons/folder.svg".into(), ICON_FOLDER),
            ("icons/folder-open.svg".into(), ICON_FOLDER_OPEN),
            ("icons/markdown.svg".into(), ICON_MARKDOWN),
        ],
        Template::Language => {
            vec![("plugin.toml".into(), LANGUAGE_MANIFEST), (format!("languages/{slug}.toml"), LANGUAGE_DEF)]
        }
    };
    files.into_iter().map(|(path, content)| (path, fill(content))).collect()
}

const COMMAND_MANIFEST: &str = r#"id = "__ID__"
name = "__NAME__"
version = "0.1.0"
description = "Adds two sample commands."
authors = []
engines.openidea = "^1.0"
# Built by `openidea-plugin build`. The code is loaded the first time one of
# its commands runs; the commands below show in Find Action before that.
wasm = "dist/plugin.wasm"

# What the code may do. The user approves these when installing.
[capabilities]
required = ["editor.read"]

[[contributes.commands]]
id = "say-hello"
title = "__NAME__: Say Hello"
category = "__NAME__"

[[contributes.commands]]
id = "line-count"
title = "__NAME__: Line Count of Active File"
category = "__NAME__"
"#;

const COMMAND_CARGO: &str = r#"[package]
name = "__CRATE__"
version = "0.1.0"
edition = "2024"
publish = false

# A plugin builds on its own (target wasm32-wasip2), outside any IDE workspace.
[workspace]

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
openidea-plugin = { path = "__SDK__" }

[profile.release]
opt-level = "s"
lto = true
strip = true
codegen-units = 1
panic = "abort"
"#;

const COMMAND_LIB: &str = r#"//! __NAME__: an OpenIDEA plugin.

use openidea_plugin::{Invocation, NotificationLevel, Plugin, host, register_plugin};

#[derive(Default)]
pub struct Main {
    greetings: u32,
}

impl Plugin for Main {
    fn run_command(&mut self, id: &str, ctx: &Invocation, _arg: Option<&str>) -> Result<Option<String>, String> {
        match id {
            "say-hello" => {
                // Instance state lasts until the plugin is idle for a while;
                // keep what must survive in `host::storage`.
                self.greetings += 1;
                let body = format!("Hello #{} from __NAME__!", self.greetings);
                host::notify(NotificationLevel::Info, "__NAME__", &body);
                Ok(None)
            }
            "line-count" => {
                let editor = ctx.editor().ok_or("no file is open")?;
                let text = editor.document()?.text;
                Ok(Some(format!("{} lines in {}", text.lines().count(), editor.path())))
            }
            _ => Err(format!("unknown command {id}")),
        }
    }
}

register_plugin!(Main);

#[cfg(test)]
mod tests {
    use super::*;
    use openidea_plugin::mock::MockHost;

    #[test]
    fn says_hello() {
        let host = MockHost::install();
        let mut plugin = Main::default();
        plugin.run_command("say-hello", &host.invocation(), None).unwrap();
        plugin.run_command("say-hello", &host.invocation(), None).unwrap();
        assert_eq!(host.notifications()[1].body, "Hello #2 from __NAME__!");
    }

    #[test]
    fn counts_lines() {
        let host = MockHost::install();
        host.open_editor("/project/src/main.rs", "rust", "fn main() {\n}\n", &[]);
        let out = Main::default().run_command("line-count", &host.invocation(), None).unwrap();
        assert_eq!(out.as_deref(), Some("2 lines in /project/src/main.rs"));
    }
}
"#;

const COMMAND_README: &str = r#"# __NAME__

An OpenIDEA plugin.

```sh
cargo test                       # logic, against the SDK's mock host
openidea-plugin build            # → dist/plugin.wasm, validated like an install
openidea-plugin link             # load this folder in the IDE (Settings › Plugins)
```

`plugin.toml` declares the commands, so they appear in Find Action before the
code is loaded, and the capabilities the code needs. `src/lib.rs` implements
them with the `openidea-plugin` SDK.
"#;

const THEME_MANIFEST: &str = r#"id = "__ID__"
name = "__NAME__"
version = "0.1.0"
description = "A dark theme."
authors = []
engines.openidea = "^1.0"

# One entry per theme. `editor-scheme` is optional: its tokens are merged over
# the theme's (IntelliJ's .theme.json + .icls pair). Reference: docs/plugins/themes.md.
[[contributes.themes]]
path = "themes/__SLUG__.theme.json"
editor-scheme = "themes/__SLUG__.scheme.json"
"#;

const THEME_UI: &str = include_str!("../../../../../templates/theme-plugin/themes/harbor-night.theme.json");
const THEME_SCHEME: &str = include_str!("../../../../../templates/theme-plugin/themes/harbor-night.scheme.json");

const ICON_MANIFEST: &str = r#"id = "__ID__"
name = "__NAME__"
version = "0.1.0"
description = "File and folder icons."
authors = []
engines.openidea = "^1.0"

# Apply it in Settings › Plugins › __NAME__. SVGs are sanitised on install:
# no scripts, event handlers, external references or entities.
[[contributes.iconThemes]]
id = "__SLUG__"
label = "__NAME__"
path = "icons/theme.json"
"#;

const ICON_THEME: &str = r#"{
  "iconDefinitions": {
    "file": "icons/file.svg",
    "folder": "icons/folder.svg",
    "folder-open": "icons/folder-open.svg",
    "markdown": "icons/markdown.svg"
  },
  "file": "file",
  "folder": "folder",
  "folderExpanded": "folder-open",
  "fileExtensions": { "md": "markdown", "markdown": "markdown" },
  "fileNames": { "readme": "markdown" },
  "folderNames": {}
}
"#;

const ICON_FILE: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#90a4ae" d="M4 1.5h5.5L13 5v9.5H4z"/><path fill="#cfd8dc" d="M9.5 1.5V5H13z"/></svg>
"##;

const ICON_FOLDER: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#90a4ae" d="M1.5 3h5l1.5 1.5h6.5v9h-13z"/></svg>
"##;

const ICON_FOLDER_OPEN: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#90a4ae" d="M1.5 3h5l1.5 1.5h6v2h-10l-2 7h-.5z"/><path fill="#b0bec5" d="M4 7.5h11.5l-2 6H2z"/></svg>
"##;

const ICON_MARKDOWN: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="1" y="3.5" width="14" height="9" rx="1.5" fill="#42a5f5"/><path fill="#fff" d="M3 10.5v-5h1.5L6 7.5l1.5-2H9v5H7.5V8L6 10 4.5 8v2.5zm8 0L9.5 8h1V5.5H12V8h1z"/></svg>
"##;

const LANGUAGE_MANIFEST: &str = r#"id = "__ID__"
name = "__NAME__"
version = "0.1.0"
description = "Language support for .__SLUG__ files: detection, comments and indentation."
authors = []
engines.openidea = "^1.0"

# Same format as languages/<id>.toml in the IDE repository.
[[contributes.languages]]
path = "languages/__SLUG__.toml"
"#;

const LANGUAGE_DEF: &str = r##"id = "__SLUG__"
name = "__NAME__"
extensions = ["__SLUG__"]
line-comment = "#"
indent = { tab-size = 2, insert-spaces = true }
# Borrow an existing CodeMirror mode for instant highlighting.
ui-mode = "Properties files"
"##;
