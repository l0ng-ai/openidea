//! Tree-sitter grammar for NEON. `src/parser.c` is generated from `grammar.js`:
//! run `tree-sitter generate` (CLI 0.25, ABI 15) here after changing the grammar.

use tree_sitter_language::LanguageFn;

unsafe extern "C" {
    fn tree_sitter_neon() -> *const ();
}

pub const LANGUAGE: LanguageFn = unsafe { LanguageFn::from_raw(tree_sitter_neon) };
