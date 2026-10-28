//! Language registry and syntax-tree powered structure.
//!
//! Every language is described by `languages/<id>.toml` at the repo root
//! (embedded at build time). Tree-sitter gives zero-config outline, folding
//! and symbol tags; LSP/DAP configs are consumed by `ide-lsp` / `ide-dap`.

use ide_core::{LanguageId, Range, SymbolKind};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;

mod registry;
mod syntax;
pub use registry::{FileTypes, LanguageRegistry};
pub use syntax::{
    CSS_CLASS, CSS_ID, CSS_VARIABLE, FileReference, Literal, LiteralKind, MAX_CACHED_TREES, MAX_PARSE_BYTES,
    ParsedTree, SpellingKind, SpellingRegion, Syntax, SyntaxCache, SyntaxCacheStats, SyntaxHighlightKind,
    SyntaxHighlights, TreeError, WebReference, WebReferenceKind, merge_visibility,
};

/// Parsed form of `languages/<id>.toml`. Backend-only; the UI gets [`LanguageInfo`].
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct LanguageConfig {
    pub id: LanguageId,
    pub name: String,
    #[serde(default)]
    pub extensions: Vec<String>,
    /// Exact file names, e.g. `Cargo.lock`, `Dockerfile`.
    #[serde(default)]
    pub filenames: Vec<String>,
    /// First-line regex, e.g. shebang `^#!.*\bpython`.
    #[serde(default)]
    pub first_line: Option<String>,
    #[serde(default)]
    pub line_comment: Option<String>,
    #[serde(default)]
    pub block_comment: Option<(String, String)>,
    #[serde(default)]
    pub indent: Option<IndentConfig>,
    /// Name of the CodeMirror/Lezer language the UI should load for instant highlighting.
    #[serde(default)]
    pub ui_mode: Option<String>,
    #[serde(default)]
    pub tree_sitter: Option<String>,
    #[serde(default)]
    pub language_servers: Vec<LanguageServerConfig>,
    #[serde(default)]
    pub debugger: Option<DebuggerConfig>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all(serialize = "camelCase", deserialize = "kebab-case"))]
pub struct IndentConfig {
    pub tab_size: u32,
    pub insert_spaces: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct LanguageServerConfig {
    /// Stable name, e.g. `rust-analyzer`.
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Files whose presence marks a workspace root, e.g. `Cargo.toml`.
    #[serde(default)]
    pub root_markers: Vec<String>,
    /// Serve only files below a root marker, not the whole project: a framework's
    /// server (Angular) next to the language's own one.
    #[serde(default)]
    pub require_root_marker: bool,
    /// JSON passed as `initializationOptions`.
    #[serde(default)]
    pub initialization_options: Option<toml::Value>,
    /// Answers `workspace/configuration`; without it the sections are looked up
    /// in `initialization_options`.
    #[serde(default)]
    pub settings: Option<serde_json::Value>,
    /// Human hint shown when the binary is missing.
    #[serde(default)]
    pub install_hint: Option<String>,
    /// `host:port` of a server that speaks LSP over TCP (Godot's editor). Connects
    /// there when something listens; otherwise starts `command` (when installed)
    /// and connects once it accepts: to `127.0.0.1:${port}` when the arguments
    /// contain `${port}` (a free port), else to this address. `${root}` in the
    /// arguments is the workspace root. A server reached without starting it is
    /// never shut down or killed by the IDE.
    #[serde(default)]
    pub connect: Option<String>,
    /// An alternative to the servers listed before it (pyright after
    /// basedpyright): only used while none of those is installed.
    #[serde(default)]
    pub fallback: bool,
    /// Newest Java release the server runs on (kotlin-language-server: 21). A
    /// newer `JAVA_HOME` is replaced by the newest installed JDK that fits.
    #[serde(default)]
    pub max_java: Option<u32>,
    /// Set by the settings hook when the server can't run here (jdtls without
    /// a JDK 21+); reported as the failure instead of launching it.
    #[serde(skip)]
    pub launch_error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct DebuggerConfig {
    /// DAP adapter name, e.g. `codelldb`, `debugpy`, `js-debug`, `delve`.
    pub adapter: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// `stdio` or `tcp`.
    #[serde(default = "default_transport")]
    pub transport: String,
    /// `tcp` only: `host:port` of an adapter running inside another program (the
    /// Godot editor). Used when it accepts connections; otherwise `command` is started.
    #[serde(default)]
    pub connect: Option<String>,
    #[serde(default)]
    pub install_hint: Option<String>,
}

fn default_transport() -> String {
    "stdio".into()
}

/// The UI-facing view of a language.
#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LanguageInfo {
    pub id: LanguageId,
    pub name: String,
    pub extensions: Vec<String>,
    pub ui_mode: Option<String>,
    pub line_comment: Option<String>,
    pub block_comment: Option<(String, String)>,
    pub indent: Option<IndentConfig>,
    /// A debug adapter is configured (breakpoints make sense in these files).
    #[serde(default)]
    #[specta(optional)]
    pub debuggable: bool,
    /// Names of the configured language servers (Settings › Inspections).
    #[serde(default)]
    #[specta(optional)]
    pub language_servers: Vec<String>,
    /// Exact file names and file-name patterns of the definition (Settings › File Types).
    #[serde(default)]
    #[specta(optional)]
    pub filenames: Vec<String>,
    /// First-line regex of the definition (shebangs, `<?php`).
    #[serde(default)]
    #[specta(optional)]
    pub first_line: Option<String>,
}

impl From<&LanguageConfig> for LanguageInfo {
    fn from(c: &LanguageConfig) -> Self {
        Self {
            id: c.id.clone(),
            name: c.name.clone(),
            extensions: c.extensions.clone(),
            ui_mode: c.ui_mode.clone(),
            line_comment: c.line_comment.clone(),
            block_comment: c.block_comment.clone(),
            indent: c.indent,
            debuggable: c.debugger.is_some(),
            language_servers: c.language_servers.iter().map(|s| s.name.clone()).collect(),
            filenames: c.filenames.clone(),
            first_line: c.first_line.clone(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum FoldKind {
    Region,
    Comment,
    Imports,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct FoldRange {
    pub start_line: u32,
    pub end_line: u32,
    pub kind: FoldKind,
}

/// A symbol definition extracted for the project index.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SymbolTag {
    pub name: String,
    pub kind: SymbolKind,
    /// Enclosing symbol, e.g. class name for a method.
    pub container: Option<String>,
    pub range: Range,
}
