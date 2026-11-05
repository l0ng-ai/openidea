//! Native, in-process PHP code intelligence.
//!
//! The engine is built up phase by phase following `docs/php-engine/ROADMAP.md`:
//! a syntax layer on top of the Mago parser, per-file declaration summaries,
//! redb-backed indexes, two-phase type inference, flow analysis and
//! inspections. `ide-host` consults it through a `LanguageService` before
//! falling back to LSP, so the frontend and IPC stay unchanged.
//!
//! Coordinates follow the rest of the backend: 0-based lines and UTF-16
//! columns at the crate edge (`ide-core::text`). Mago works in byte offsets, so
//! the syntax layer converts between the two.
//!
//! Modules so far:
//!
//! - [`syntax`]: parsed files ([`syntax::ParsedFile`]), byte ⇄ UTF-16
//!   conversion ([`syntax::LineIndex`]) and the per-document parse cache.
//! - [`probe`]: the declaration outline used by the Mago test-drive
//!   (`examples/parse_corpus.rs`, results in `docs/php-engine/spike.md`).

pub mod probe;
pub mod syntax;

/// Re-exports of the pinned Mago crates, so later phases and the examples use
/// exactly the versions this crate was built against.
pub mod mago {
    pub use mago_allocator as allocator;
    pub use mago_database as database;
    pub use mago_names as names;
    pub use mago_phpdoc_syntax as phpdoc;
    pub use mago_span as span;
    pub use mago_syntax as syntax;
    /// Lexer input (`syntax_core::input::Input`) for driving
    /// `syntax::lexer::Lexer` directly.
    pub use mago_syntax_core as syntax_core;
}
