//! Language registry and syntax-tree powered structure.
//!
//! Every language is described by `languages/<id>.toml` at the repo root
//! (embedded at build time). Tree-sitter gives zero-config outline, folding
//! and symbol tags; LSP/DAP configs are consumed by `ide-lsp` / `ide-dap`.

use ide_core::{LanguageId, Range, SymbolKind};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

mod markers;
pub mod plugin_point;
mod registry;
mod syntax;
pub use markers::marked_root;
pub use plugin_point::PluginLanguages;
pub use registry::{FileTypes, LanguageRegistry};
pub use syntax::{
    CSS_CLASS, CSS_ID, CSS_VARIABLE, ConfigurationKey, ExternalFold, ExternalSymbol, ExternalSyntax, ExternalToken,
    FileReference, Literal, LiteralKind, MAX_CACHED_TREES, MAX_PARSE_BYTES, ParsedTree, SpellingKind, SpellingRegion,
    Syntax, SyntaxCache, SyntaxCacheStats, SyntaxHighlightKind, SyntaxHighlights, TreeError, WebReference,
    WebReferenceKind, merge_visibility, set_external_syntax,
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
    /// Modes replacing `ui_mode` in a framework's projects (Angular templates);
    /// the first one whose root marker is found applies.
    #[serde(default)]
    pub framework_ui_modes: Vec<FrameworkUiMode>,
    #[serde(default)]
    pub tree_sitter: Option<String>,
    #[serde(default)]
    pub language_servers: Vec<LanguageServerConfig>,
    #[serde(default)]
    pub debugger: Option<DebuggerConfig>,
    /// External formatter used when no language server can format, or selected in settings.
    #[serde(default)]
    pub formatter: Option<FormatterConfig>,
    /// Content of a new scratch file; `$END$` marks where the caret goes.
    #[serde(default)]
    pub scratch_template: Option<String>,
}

/// An external formatting tool and its language-specific parser.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct FormatterConfig {
    pub tool: String,
    pub parser: String,
    #[serde(default)]
    pub range: bool,
}

/// A CodeMirror mode for the files of a framework's projects.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct FrameworkUiMode {
    pub ui_mode: String,
    /// Files whose presence in a directory above a file, up to the project
    /// folder, marks the framework's project, e.g. `angular.json`; matched like
    /// language servers' `root-markers`.
    pub root_markers: Vec<String>,
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
    /// Files whose presence marks a workspace root, e.g. `Cargo.toml`;
    /// `file#table` requires the TOML file to contain that dotted table, e.g.
    /// `pyproject.toml#tool.ruff`.
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
    /// What the server is used for (`completion`, `code-action`, `diagnostics`,
    /// … `FEATURES` in `ide-lsp/src/caps.rs`); empty means everything. The other
    /// capabilities it announces are ignored, so a refactoring-only server next
    /// to the language's own one adds no completion, hover or formatting.
    #[serde(default)]
    pub features: Vec<String>,
    /// Code action kinds kept from the server, matched like LSP's `only`
    /// (`refactor` keeps `refactor.extract`); empty keeps every kind.
    #[serde(default)]
    pub code_action_kinds: Vec<String>,
    /// Newest Java release the server runs on (kotlin-language-server: 21). A
    /// newer `JAVA_HOME` is replaced by the newest installed JDK that fits.
    #[serde(default)]
    pub max_java: Option<u32>,
    /// Set by the settings hook when the server can't run here (jdtls without
    /// a JDK 21+); reported as the failure instead of launching it.
    #[serde(skip)]
    pub launch_error: Option<String>,
    /// Register source files with tsserver when no project configuration exists.
    #[serde(default)]
    pub tsserver_project: bool,
    /// Re-sends the open documents (unchanged) once `workspace/configuration` is answered:
    /// the server (Intelephense) applies some settings, such as the PHP version, only when
    /// it parses a document.
    #[serde(default)]
    pub resync_on_configuration: bool,
    /// Set on plugin languages: start exactly this approved program.
    #[serde(skip)]
    pub pinned: Option<ProgramPin>,
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
    /// Set on plugin languages: start exactly this approved program.
    #[serde(skip)]
    pub pinned: Option<ProgramPin>,
}

/// The program a plugin's `process:` grant approved:
/// a plugin language's server or debug adapter starts from this exact path,
/// and only while the file still has the approved content. Set by the plugin
/// host, never read from a definition.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProgramPin {
    pub path: PathBuf,
    /// blake3 of the file when approved.
    pub hash: String,
}

impl ProgramPin {
    /// Approves `path` as it is now.
    pub fn approve(path: impl Into<PathBuf>) -> std::io::Result<Self> {
        let path = path.into();
        let hash = ide_extension::ledger::file_hash(&path)?;
        Ok(Self { path, hash })
    }

    /// Checks the file right before it is started; the error tells the user what to do.
    pub fn verify(&self) -> Result<&Path, String> {
        match ide_extension::ledger::file_hash(&self.path) {
            Ok(hash) if hash == self.hash => Ok(&self.path),
            Ok(_) => Err(format!(
                "{} changed since it was approved; review the plugin's permissions in Settings › Plugins",
                self.path.display()
            )),
            Err(e) => Err(format!("{}: {e}", self.path.display())),
        }
    }
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
    /// Content of a new scratch file; `$END$` marks where the caret goes.
    #[serde(default)]
    #[specta(optional)]
    pub scratch_template: Option<String>,
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
            scratch_template: c.scratch_template.clone(),
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

/// Import/export/declaration facts of a TS/JS source, or of the `<script>`
/// regions of a Vue SFC / HTML document: what the project index resolves
/// cross-file navigation with when no language server is available
/// (see `docs/vue-ts-semantic-index.md`). Ranges are document-absolute.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Facts {
    /// Module-level declarations (functions, classes, types, variables).
    pub decls: Vec<Decl>,
    /// Import statements: what they bind and from where.
    pub imports: Vec<Import>,
    /// Re-exports (`export { x } from`, `export * from`).
    pub reexports: Vec<Reexport>,
}

/// A module-level declaration.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decl {
    pub name: String,
    pub kind: SymbolKind,
    /// The name's range.
    pub range: Range,
    /// Declared with `export`, or inside an `export` statement.
    pub exported: bool,
}

/// One imported (or re-exported) binding.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImportName {
    /// `import { a as b }`: imported name `a`, local binding `b`.
    Named { imported: String, local: String },
    /// `import d from`: the module's default export, bound to `d`.
    Default { local: String },
    /// `import * as ns`; `export * from` uses the local name `"*"`.
    Namespace { local: String },
}

/// An import statement.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Import {
    pub names: Vec<ImportName>,
    /// The module specifier as written (`'./x'` → `./x`).
    pub source: String,
    /// The statement's range.
    pub range: Range,
}

/// A re-export: `export { x } from './y'`, `export * from`, `export * as ns from`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reexport {
    pub names: Vec<ImportName>,
    pub source: String,
    /// The statement's range.
    pub range: Range,
}

/// One `<script>` block of a Vue SFC / HTML document: what
/// [`crate::Syntax::script_facts`] parses per block.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScriptRegion {
    /// Byte offset of `text` within the document.
    pub base: usize,
    /// The language the block's `lang` attribute picks.
    pub language: LanguageId,
    /// The script text.
    pub text: String,
}
