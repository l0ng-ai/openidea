//! JetBrains kotlin-lsp's debugger: a DAP server inside the language server, reached through
//! the `debugServer` port it opens once the project is imported.

pub const ADAPTER: &str = "kotlin-lsp";
/// The `adapterID` its debug server expects in `initialize`.
pub const DAP_ADAPTER_ID: &str = "intellij_jvm";
