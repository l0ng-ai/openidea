//! Syntax for the plugin's own languages (highlighting, structure view,
//! folding) when the IDE has no grammar for them. Implement [`SyntaxProvider`]
//! and register with `register_plugin!(MyPlugin, syntax)`.
//!
//! The IDE calls these with the whole document on the editing path, so keep
//! them fast (a hand-written lexer is typical). Offsets are UTF-8 byte offsets
//! into `text`; lines are 0-based.

use std::ops::Range;

/// Highlight categories; the theme decides the colours.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Highlight {
    Keyword,
    String,
    StringSpecial,
    Escape,
    Regexp,
    Atom,
    Number,
    Constant,
    Comment,
    DocComment,
    Function,
    FunctionCall,
    Builtin,
    Type,
    Namespace,
    Variable,
    SelfVariable,
    Property,
    Attribute,
    Macro,
    Label,
    Tag,
    Operator,
    Punctuation,
}

impl Highlight {
    pub fn name(self) -> &'static str {
        match self {
            Self::Keyword => "keyword",
            Self::String => "string",
            Self::StringSpecial => "string-special",
            Self::Escape => "escape",
            Self::Regexp => "regexp",
            Self::Atom => "atom",
            Self::Number => "number",
            Self::Constant => "constant",
            Self::Comment => "comment",
            Self::DocComment => "doc-comment",
            Self::Function => "function",
            Self::FunctionCall => "function-call",
            Self::Builtin => "builtin",
            Self::Type => "type",
            Self::Namespace => "namespace",
            Self::Variable => "variable",
            Self::SelfVariable => "self-variable",
            Self::Property => "property",
            Self::Attribute => "attribute",
            Self::Macro => "macro",
            Self::Label => "label",
            Self::Tag => "tag",
            Self::Operator => "operator",
            Self::Punctuation => "punctuation",
        }
    }
}

/// A highlighted range. Tokens must not overlap; the IDE sorts them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Token {
    pub range: Range<usize>,
    pub kind: Highlight,
}

/// Kinds of structure-view symbols.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SymbolKind {
    Module,
    Namespace,
    Package,
    Class,
    Interface,
    Struct,
    Enum,
    EnumMember,
    Trait,
    Function,
    Method,
    Constructor,
    Field,
    Property,
    Variable,
    Constant,
    TypeParameter,
    TypeAlias,
    Macro,
    Event,
    Operator,
    Key,
}

impl SymbolKind {
    pub fn name(self) -> &'static str {
        match self {
            Self::Module => "module",
            Self::Namespace => "namespace",
            Self::Package => "package",
            Self::Class => "class",
            Self::Interface => "interface",
            Self::Struct => "struct",
            Self::Enum => "enum",
            Self::EnumMember => "enum-member",
            Self::Trait => "trait",
            Self::Function => "function",
            Self::Method => "method",
            Self::Constructor => "constructor",
            Self::Field => "field",
            Self::Property => "property",
            Self::Variable => "variable",
            Self::Constant => "constant",
            Self::TypeParameter => "type-parameter",
            Self::TypeAlias => "type-alias",
            Self::Macro => "macro",
            Self::Event => "event",
            Self::Operator => "operator",
            Self::Key => "key",
        }
    }
}

/// A symbol of the structure view. `parent` is the index of the enclosing
/// symbol in the same list, which must come before it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Symbol {
    pub name: String,
    pub detail: Option<String>,
    pub kind: SymbolKind,
    /// The whole declaration.
    pub range: Range<usize>,
    /// The name; where navigation lands.
    pub name_range: Range<usize>,
    pub parent: Option<usize>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FoldKind {
    Region,
    Comment,
    Imports,
}

/// A foldable range of lines (the first stays visible).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fold {
    pub start_line: u32,
    pub end_line: u32,
    pub kind: FoldKind,
}

/// Syntax of the languages the plugin contributes. `language` is the
/// language id from the plugin's definition.
pub trait SyntaxProvider {
    fn highlights(&mut self, language: &str, text: &str) -> Vec<Token>;

    fn outline(&mut self, _language: &str, _text: &str) -> Vec<Symbol> {
        Vec::new()
    }

    fn folding(&mut self, _language: &str, _text: &str) -> Vec<Fold> {
        Vec::new()
    }
}

/// Folds for every multi-line `open` … `close` pair (braces, brackets),
/// skipping the ones inside the given non-code ranges (strings, comments).
pub fn bracket_folds(text: &str, open: u8, close: u8, skip: &[Range<usize>]) -> Vec<Fold> {
    let mut folds = Vec::new();
    let mut stack: Vec<u32> = Vec::new();
    let mut line = 0u32;
    let mut skip = skip.iter().peekable();
    for (i, b) in text.bytes().enumerate() {
        while skip.peek().is_some_and(|r| r.end <= i) {
            skip.next();
        }
        if b == b'\n' {
            line += 1;
            continue;
        }
        if skip.peek().is_some_and(|r| r.start <= i) {
            continue;
        }
        if b == open {
            stack.push(line);
        } else if b == close
            && let Some(start) = stack.pop()
            && line > start
        {
            folds.push(Fold { start_line: start, end_line: line, kind: FoldKind::Region });
        }
    }
    folds
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bracket_folds_skip_strings() {
        let text = "a {\n  \"{\"\n  b {\n  }\n}\n";
        let s = text.find('"').unwrap();
        let folds = bracket_folds(text, b'{', b'}', std::slice::from_ref(&(s..s + 3)));
        assert_eq!(
            folds,
            [
                Fold { start_line: 2, end_line: 3, kind: FoldKind::Region },
                Fold { start_line: 0, end_line: 4, kind: FoldKind::Region },
            ]
        );
    }
}
