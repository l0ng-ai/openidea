use crate::types::Range;

pub use crate::providers::Document;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum TokenKind {
    Namespace,
    Type,
    Class,
    Enum,
    Interface,
    Struct,
    TypeParameter,
    Parameter,
    Variable,
    Property,
    EnumMember,
    Event,
    Function,
    Method,
    Macro,
    Keyword,
    Modifier,
    Comment,
    String,
    Number,
    Regexp,
    Operator,
    Decorator,
}

impl TokenKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Namespace => "namespace",
            Self::Type => "type",
            Self::Class => "class",
            Self::Enum => "enum",
            Self::Interface => "interface",
            Self::Struct => "struct",
            Self::TypeParameter => "type-parameter",
            Self::Parameter => "parameter",
            Self::Variable => "variable",
            Self::Property => "property",
            Self::EnumMember => "enum-member",
            Self::Event => "event",
            Self::Function => "function",
            Self::Method => "method",
            Self::Macro => "macro",
            Self::Keyword => "keyword",
            Self::Modifier => "modifier",
            Self::Comment => "comment",
            Self::String => "string",
            Self::Number => "number",
            Self::Regexp => "regexp",
            Self::Operator => "operator",
            Self::Decorator => "decorator",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum TokenModifier {
    Declaration,
    Definition,
    Readonly,
    Static,
    Deprecated,
    Abstract,
    Async,
    Modification,
    Documentation,
    DefaultLibrary,
}

impl TokenModifier {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Declaration => "declaration",
            Self::Definition => "definition",
            Self::Readonly => "readonly",
            Self::Static => "static",
            Self::Deprecated => "deprecated",
            Self::Abstract => "abstract",
            Self::Async => "async",
            Self::Modification => "modification",
            Self::Documentation => "documentation",
            Self::DefaultLibrary => "default-library",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SemanticToken {
    pub range: Range,
    pub kind: TokenKind,
    pub modifiers: Vec<TokenModifier>,
}

impl SemanticToken {
    pub fn new(range: Range, kind: TokenKind) -> Self {
        Self { range, kind, modifiers: Vec::new() }
    }

    pub fn modifier(mut self, modifier: TokenModifier) -> Self {
        self.modifiers.push(modifier);
        self
    }
}

pub trait SemanticTokens {
    fn semantic_tokens(&mut self, doc: &Document) -> Vec<SemanticToken>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Position;

    #[test]
    fn names_follow_the_wit_vocabulary() {
        assert_eq!(TokenKind::TypeParameter.as_str(), "type-parameter");
        assert_eq!(TokenKind::EnumMember.as_str(), "enum-member");
        assert_eq!(TokenModifier::DefaultLibrary.as_str(), "default-library");
    }

    #[test]
    fn a_token_collects_its_modifiers() {
        let range = Range { start: Position { line: 1, character: 2 }, end: Position { line: 1, character: 6 } };
        let token = SemanticToken::new(range, TokenKind::Method)
            .modifier(TokenModifier::Static)
            .modifier(TokenModifier::Deprecated);
        assert_eq!(token.modifiers, [TokenModifier::Static, TokenModifier::Deprecated]);
    }
}
