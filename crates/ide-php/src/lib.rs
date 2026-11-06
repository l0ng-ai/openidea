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
//! - [`names`]: PHP name resolution ([`names::FileNames`]): namespaces,
//!   imports and aliases, the global fallback of functions and constants,
//!   and `self`/`static`/`parent` markers.
//! - [`summary`]: per-file declaration summaries ([`summary::FileSummary`]):
//!   class-likes with their members and signatures, functions and constants,
//!   serialized with postcard.
//! - [`index`]: the persistent redb indexes ([`index::PhpIndex`]): summaries
//!   by content hash, FQN, short name, direct subclasses and namespace
//!   children, built in parallel and updated incrementally.
//! - [`project`]: which files belong to the project
//!   ([`project::ProjectLayout`]): the project folder, Composer autoload
//!   rules and installed packages, include paths and excluded folders, and
//!   the PSR-4/PSR-0 namespace ⇄ directory map ([`project::AutoloadMap`]).
//! - [`stubs`]: built-in declarations from the bundled phpstorm-stubs
//!   ([`stubs::BundledStubs`]), filtered by PHP version and enabled
//!   extensions ([`stubs::StubFilter`]).
//! - [`engine`]: the engine of one open project ([`engine::PhpEngine`]):
//!   a background worker that keeps the indexes up to date with the layout
//!   and watcher batches, dumb-mode and readiness events, and open
//!   documents overriding the disk.
//! - [`meta`]: `.phpstorm.meta.php` directives ([`meta::PhpStormMeta`]):
//!   return-type overrides and exit points applied through a type provider,
//!   expected argument and return values for completion.
//! - [`complete`]: context-aware code completion
//!   ([`complete::Completions`]): members, variables, keywords, names with
//!   auto-import, named arguments, expected values, enum cases and array
//!   keys.
//! - [`imports`]: the auto-import quick-fix for unresolved names, Optimize
//!   Imports, and inserting `use` statements in the file's own style.
//! - [`semantic`]: semantic tokens (classes, interfaces, enums, functions,
//!   methods, properties, constants, enum cases, parameters and variables,
//!   with declaration, static, readonly, deprecated and built-in modifiers).
//! - [`signature`]: signature help (the call around the caret, its active
//!   parameter) and inlay hints (parameter names, variable and closure
//!   return types).
//! - [`navigate`]: document symbols, fuzzy workspace symbols and goto
//!   definition of class-like, function and constant names.
//! - [`types`]: the type model ([`types::Type`]): parsing from native hints
//!   and PHPDoc, display in PHP syntax, unions and intersections, and
//!   subtyping against a class [`types::Hierarchy`].
//! - [`probe`]: the declaration outline used by the Mago test-drive
//!   (`examples/parse_corpus.rs`, results in `docs/php-engine/spike.md`).

pub mod complete;
pub mod engine;
pub mod imports;
pub mod index;
pub mod meta;
pub mod names;
pub mod navigate;
pub mod probe;
pub mod project;
pub mod semantic;
pub mod signature;
pub mod stubs;
pub mod summary;
pub mod syntax;
pub mod types;

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
