//! Syntax highlighting from a grammar's own `highlights.scm`, for languages the
//! UI has no CodeMirror mode for.
//!
//! Capture names follow the nvim-treesitter / Zed conventions (`@keyword`,
//! `@string.special.symbol`, ...) and are folded into [`SyntaxHighlightKind`] by
//! their longest known dotted prefix. Overlaps resolve the way those editors
//! do: a smaller node wins over the node containing it, and for the same node
//! the later pattern wins (the first one for tree-sitter CLI style queries). `@embedded` (string interpolation) clears the
//! surrounding colour. Besides tree-sitter's own text predicates, nvim's
//! `#lua-match?` is understood; patterns with other predicates never match.

use super::lines::LineIndex;
use serde::{Deserialize, Serialize};
use specta::Type;
use tree_sitter::{Language, Query, QueryCursor, QueryMatch, QueryPredicateArg, StreamingIterator, Tree};

/// Highlight classes sent to the UI, which maps each onto a Lezer tag.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SyntaxHighlightKind {
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

impl SyntaxHighlightKind {
    /// Every kind, in `as u32` order: the legend for [`SyntaxHighlights::data`].
    pub const ALL: [Self; 24] = [
        Self::Keyword,
        Self::String,
        Self::StringSpecial,
        Self::Escape,
        Self::Regexp,
        Self::Atom,
        Self::Number,
        Self::Constant,
        Self::Comment,
        Self::DocComment,
        Self::Function,
        Self::FunctionCall,
        Self::Builtin,
        Self::Type,
        Self::Namespace,
        Self::Variable,
        Self::SelfVariable,
        Self::Property,
        Self::Attribute,
        Self::Macro,
        Self::Label,
        Self::Tag,
        Self::Operator,
        Self::Punctuation,
    ];
}

/// Highlighted ranges of a whole document, packed like LSP semantic tokens.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxHighlights {
    /// Legend: `data` kind `i` is `kinds[i]`.
    pub kinds: Vec<SyntaxHighlightKind>,
    /// `[from, to, kind]` triples: sorted, non-overlapping UTF-16 offsets.
    pub data: Vec<u32>,
}

impl SyntaxHighlights {
    pub(crate) fn new(data: Vec<u32>) -> Self {
        Self { kinds: SyntaxHighlightKind::ALL.to_vec(), data }
    }
}

/// What a capture paints over its node.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Paint {
    Kind(SyntaxHighlightKind),
    /// `@embedded`: code inside a string, uncoloured unless captured itself.
    Clear,
}

/// Capture name prefixes, most specific first within each family.
const CAPTURES: &[(&str, Paint)] = {
    use Paint::{Clear, Kind};
    use SyntaxHighlightKind as K;
    &[
        ("embedded", Clear),
        ("keyword", Kind(K::Keyword)),
        ("include", Kind(K::Keyword)),
        ("import", Kind(K::Keyword)),
        ("conditional", Kind(K::Keyword)),
        ("repeat", Kind(K::Keyword)),
        ("exception", Kind(K::Keyword)),
        ("boolean", Kind(K::Keyword)),
        ("string.escape", Kind(K::Escape)),
        ("escape", Kind(K::Escape)),
        ("string.regex", Kind(K::Regexp)),
        ("string.regexp", Kind(K::Regexp)),
        ("string.special.symbol", Kind(K::Atom)),
        ("symbol", Kind(K::Atom)),
        ("string.special", Kind(K::StringSpecial)),
        ("string", Kind(K::String)),
        ("character", Kind(K::String)),
        ("number", Kind(K::Number)),
        ("float", Kind(K::Number)),
        ("constant.builtin", Kind(K::Constant)),
        ("constant.macro", Kind(K::Macro)),
        ("constant", Kind(K::Constant)),
        // nvim greys out unused bindings (`_acc`); IDEA shows them as variables.
        ("comment.unused", Kind(K::Variable)),
        ("comment.doc", Kind(K::DocComment)),
        ("comment.documentation", Kind(K::DocComment)),
        ("comment", Kind(K::Comment)),
        ("function.builtin", Kind(K::Builtin)),
        ("function.macro", Kind(K::Macro)),
        ("function.definition", Kind(K::Function)),
        ("function", Kind(K::FunctionCall)),
        ("method", Kind(K::FunctionCall)),
        ("constructor", Kind(K::Type)),
        ("type.builtin", Kind(K::Builtin)),
        ("type", Kind(K::Type)),
        ("module", Kind(K::Namespace)),
        ("namespace", Kind(K::Namespace)),
        ("variable.builtin", Kind(K::SelfVariable)),
        ("variable.member", Kind(K::Property)),
        ("variable.field", Kind(K::Property)),
        ("variable", Kind(K::Variable)),
        ("parameter", Kind(K::Variable)),
        ("property", Kind(K::Property)),
        ("field", Kind(K::Property)),
        ("attribute", Kind(K::Attribute)),
        ("label", Kind(K::Label)),
        ("tag", Kind(K::Tag)),
        ("operator", Kind(K::Operator)),
        ("punctuation", Kind(K::Punctuation)),
    ]
};

/// The paint for a capture name: its longest prefix (on `.` boundaries) in
/// [`CAPTURES`]. Private captures (`@__name__`) and unknown names paint nothing.
fn paint_for(name: &str) -> Option<Paint> {
    if name.starts_with('_') {
        return None;
    }
    let mut prefix = name;
    loop {
        if let Some((_, p)) = CAPTURES.iter().find(|(n, _)| *n == prefix) {
            return Some(*p);
        }
        prefix = &prefix[..prefix.rfind('.')?];
    }
}

/// A predicate tree-sitter leaves to the caller.
enum Check {
    /// `#lua-match?` / `#not-lua-match?` on a capture's text.
    Matches {
        capture: u32,
        regex: regex_lite::Regex,
        negate: bool,
    },
    Unsupported,
}

pub(crate) struct HighlightQuery {
    query: Query,
    /// By capture index.
    paints: Vec<Option<Paint>>,
    /// By pattern index.
    checks: Vec<Vec<Check>>,
    first_wins: bool,
}

impl HighlightQuery {
    pub(crate) fn new(language: &Language, source: &str, first_wins: bool) -> Result<Self, tree_sitter::QueryError> {
        let query = Query::new(language, source)?;
        let paints = query.capture_names().iter().map(|n| paint_for(n)).collect();
        let checks = (0..query.pattern_count())
            .map(|i| {
                query
                    .general_predicates(i)
                    .iter()
                    .filter_map(|p| match (&*p.operator, &*p.args) {
                        // Locals are not tracked: builtins are assumed not to be shadowed.
                        ("is-not?", [QueryPredicateArg::String(s)]) if &**s == "local" => None,
                        (
                            op @ ("lua-match?" | "not-lua-match?"),
                            [QueryPredicateArg::Capture(c), QueryPredicateArg::String(pat)],
                        ) => Some(match regex_lite::Regex::new(&lua_pattern_to_regex(pat)) {
                            Ok(regex) => Check::Matches { capture: *c, regex, negate: op.starts_with("not-") },
                            Err(_) => Check::Unsupported,
                        }),
                        _ => Some(Check::Unsupported),
                    })
                    .collect()
            })
            .collect();
        Ok(Self { query, paints, checks, first_wins })
    }

    fn accepts(&self, m: &QueryMatch<'_, '_>, text: &str) -> bool {
        self.checks[m.pattern_index].iter().all(|check| match check {
            Check::Matches { capture, regex, negate } => m
                .captures
                .iter()
                .filter(|c| c.index == *capture)
                .all(|c| regex.is_match(&text[c.node.byte_range()]) != *negate),
            Check::Unsupported => false,
        })
    }
}

/// Translates the Lua patterns used by nvim queries (`^[A-Z][A-Z_0-9]+$`, `^//!`) to regex syntax.
fn lua_pattern_to_regex(pat: &str) -> String {
    let class = |c: char| match c {
        'a' => Some("A-Za-z"),
        'd' => Some("0-9"),
        'l' => Some("a-z"),
        'u' => Some("A-Z"),
        'w' => Some("A-Za-z0-9"),
        's' => Some("\\s"),
        'x' => Some("0-9A-Fa-f"),
        'p' => Some("[:punct:]"),
        _ => None,
    };
    let mut out = String::with_capacity(pat.len() + 8);
    let mut in_set = false;
    let mut chars = pat.chars();
    while let Some(c) = chars.next() {
        match c {
            '%' => {
                let Some(next) = chars.next() else { break };
                match class(next) {
                    Some(set) if in_set => out.push_str(set),
                    Some(set) => {
                        out.push('[');
                        out.push_str(set);
                        out.push(']');
                    }
                    None => out.push_str(&regex_lite::escape(&next.to_string())),
                }
            }
            '[' if !in_set => {
                in_set = true;
                out.push(c);
            }
            ']' if in_set => {
                in_set = false;
                out.push(c);
            }
            // Lua's lazy `*` (inside a set, `-` is a range).
            '-' if !in_set => out.push_str("*?"),
            '\\' | '{' | '}' | '|' => {
                out.push('\\');
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out
}

/// Byte value for "no colour" in the paint buffer; kinds are `1 + index`.
const NONE: u8 = 0;

/// `[from, to, kind]` UTF-16 triples for `text`; see [`SyntaxHighlights::data`].
pub(crate) fn highlights(q: &HighlightQuery, tree: &Tree, text: &str) -> Vec<u32> {
    // (byte len, rank, start, end, paint): painted largest first, then by rank,
    // so inner nodes and winning patterns overwrite.
    let mut captures: Vec<(usize, usize, usize, usize, Paint)> = Vec::new();
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(&q.query, tree.root_node(), text.as_bytes());
    while let Some(m) = matches.next() {
        if !q.accepts(m, text) {
            continue;
        }
        for c in m.captures {
            if let Some(paint) = q.paints[c.index as usize] {
                let r = c.node.byte_range();
                if r.start < r.end {
                    let rank = if q.first_wins { usize::MAX - m.pattern_index } else { m.pattern_index };
                    captures.push((r.end - r.start, rank, r.start, r.end, paint));
                }
            }
        }
    }
    captures.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));

    let mut painted = vec![NONE; text.len()];
    for &(_, _, start, end, paint) in &captures {
        let v = match paint {
            Paint::Kind(k) => 1 + k as u8,
            Paint::Clear => NONE,
        };
        painted[start..end].fill(v);
    }

    let lines = LineIndex::new(text);
    let mut data = Vec::new();
    let mut i = 0;
    while i < painted.len() {
        let v = painted[i];
        let start = i;
        while i < painted.len() && painted[i] == v {
            i += 1;
        }
        // Node boundaries are char boundaries; whitespace-only runs stay uncoloured.
        if v != NONE && text.is_char_boundary(start) && text.is_char_boundary(i) && !text[start..i].trim().is_empty() {
            data.extend([lines.utf16_at(start) as u32, lines.utf16_at(i) as u32, (v - 1) as u32]);
        }
    }
    data
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_names_fold_to_the_longest_known_prefix() {
        use SyntaxHighlightKind as K;
        assert_eq!(paint_for("keyword.function"), Some(Paint::Kind(K::Keyword)));
        assert_eq!(paint_for("string.special.symbol"), Some(Paint::Kind(K::Atom)));
        assert_eq!(paint_for("string.special.path"), Some(Paint::Kind(K::StringSpecial)));
        assert_eq!(paint_for("comment.doc.__attribute__"), Some(Paint::Kind(K::DocComment)));
        assert_eq!(paint_for("punctuation.bracket"), Some(Paint::Kind(K::Punctuation)));
        assert_eq!(paint_for("embedded"), Some(Paint::Clear));
        assert_eq!(paint_for("__name__"), None);
        assert_eq!(paint_for("spell"), None);
    }

    /// `(text, kind)` of every highlighted range.
    fn spans(lang: &str, text: &str) -> Vec<(String, SyntaxHighlightKind)> {
        let h = crate::Syntax::new().highlights(&ide_core::LanguageId::new(lang), text).unwrap();
        let units: Vec<u16> = text.encode_utf16().collect();
        h.data
            .chunks(3)
            .map(|t| (String::from_utf16(&units[t[0] as usize..t[1] as usize]).unwrap(), h.kinds[t[2] as usize]))
            .collect()
    }

    #[test]
    fn highlights_elixir() {
        use SyntaxHighlightKind as K;
        let src = "defmodule Greeter do\n  @moduledoc \"Hi\"\n  # 😀 note\n  def hello(name, _opts) do\n    IO.puts(\"Hello #{name}\")\n    :ok\n  end\nend\n";
        let got = spans("elixir", src);
        let kind = |t: &str| got.iter().find(|(s, _)| s == t).map(|(_, k)| *k);
        assert_eq!(kind("defmodule"), Some(K::Keyword));
        assert_eq!(kind("Greeter"), Some(K::Namespace));
        assert_eq!(kind("\"Hi\""), Some(K::DocComment));
        assert_eq!(kind("# 😀 note"), Some(K::Comment));
        assert_eq!(kind("def"), Some(K::Keyword));
        assert_eq!(kind("hello"), Some(K::FunctionCall));
        assert_eq!(kind("_opts"), Some(K::Variable));
        assert_eq!(kind("puts"), Some(K::FunctionCall));
        // Interpolation clears the string colour; its contents are coloured on their own.
        assert_eq!(kind("\"Hello "), Some(K::String));
        assert_eq!(kind("#{"), Some(K::Punctuation));
        assert_eq!(kind(":ok"), Some(K::Atom));
        assert_eq!(kind("end"), Some(K::Keyword));
        // Sorted and non-overlapping.
        let h = crate::Syntax::new().highlights(&ide_core::LanguageId::new("elixir"), src).unwrap();
        assert!(h.data.chunks(3).zip(h.data.chunks(3).skip(1)).all(|(a, b)| a[0] < a[1] && a[1] <= b[0]));
    }

    #[test]
    fn highlights_other_grammar_only_languages() {
        use SyntaxHighlightKind as K;
        type Expect<'a> = &'a [(&'a str, SyntaxHighlightKind)];
        let cases: &[(&str, &str, Expect)] = &[
            (
                "zig",
                "const std = @import(\"std\");\n// hi\npub fn main() void {\n    var x: u32 = 42;\n    _ = x;\n}\n",
                &[
                    ("const", K::Keyword),
                    ("\"std\"", K::String),
                    ("// hi", K::Comment),
                    ("42", K::Number),
                    ("u32", K::Builtin),
                ],
            ),
            (
                "nix",
                "{ pkgs ? import <nixpkgs> {} }:\n# hi\nlet x = 1; in pkgs.mkShell { name = \"dev\"; }\n",
                &[
                    ("let", K::Keyword),
                    ("# hi", K::Comment),
                    ("1", K::Number),
                    ("\"dev\"", K::String),
                    ("import", K::Builtin),
                ],
            ),
            (
                "graphql",
                "# hi\nquery Hero($id: ID!) @cached {\n  hero(id: $id) { name ...Friends }\n}\nenum Episode { NEWHOPE }\n",
                &[
                    ("# hi", K::Comment),
                    ("query", K::Keyword),
                    ("Hero", K::FunctionCall),
                    ("$id", K::Variable),
                    ("ID", K::Type),
                    ("@cached", K::Attribute),
                    ("name", K::Property),
                    ("Friends", K::FunctionCall),
                    ("NEWHOPE", K::Constant),
                ],
            ),
            (
                "hcl",
                "# hi\nresource \"aws_instance\" \"web\" {\n  ami   = var.ami\n  count = 2\n  tags  = { Name = \"web-${var.env}\" }\n  name  = upper(\"x\")\n}\n",
                &[
                    ("# hi", K::Comment),
                    ("resource", K::Keyword),
                    ("aws_instance", K::Type),
                    ("ami", K::Property),
                    ("2", K::Number),
                    ("upper", K::FunctionCall),
                    ("\"web-", K::String),
                    ("env", K::Property),
                    ("var", K::Variable),
                ],
            ),
            ("make", "# hi\nCC := gcc\nall: main.o\n\t$(CC) -o app main.o\n", &[("# hi", K::Comment)]),
            (
                "gdscript",
                "extends Node2D\nclass_name Player\n# hi\n@export var speed: float = 1.5\nconst MAX_HP = 10\nsignal died(cause)\n\nfunc _ready() -> void:\n\tvar label = $Label\n\tself.position.x += speed\n\tprint(\"ready\", &\"name\", 3)\n",
                &[
                    ("extends", K::Keyword),
                    ("Node2D", K::Type),
                    ("class_name", K::Keyword),
                    ("Player", K::Type),
                    ("# hi", K::Comment),
                    ("@export", K::Attribute),
                    ("var", K::Keyword),
                    ("float", K::Type),
                    ("1.5", K::Number),
                    ("MAX_HP", K::Constant),
                    ("signal", K::Keyword),
                    ("func", K::Keyword),
                    ("_ready", K::Function),
                    ("$Label", K::StringSpecial),
                    ("self", K::SelfVariable),
                    ("print", K::FunctionCall),
                    ("\"ready\"", K::String),
                    ("&\"name\"", K::StringSpecial),
                    ("3", K::Number),
                ],
            ),
        ];
        for (lang, src, expect) in cases {
            let got = spans(lang, src);
            for (text, kind) in *expect {
                assert!(got.iter().any(|(s, k)| s == text && k == kind), "{lang}: {text:?} as {kind:?} in {got:?}");
            }
        }
    }

    #[test]
    fn languages_without_a_query_have_none() {
        assert_eq!(crate::Syntax::new().highlights(&ide_core::LanguageId::new("rust"), "fn a() {}"), None);
    }

    #[test]
    fn every_highlights_query_compiles() {
        for spec in super::super::grammars::SPECS {
            if let Some(h) = &spec.highlights {
                let lang = Language::new(spec.language);
                if let Err(e) = HighlightQuery::new(&lang, h.query, h.first_wins) {
                    panic!("{}: {e}", spec.name);
                }
            }
        }
    }

    #[test]
    fn lua_patterns_translate() {
        assert_eq!(lua_pattern_to_regex("^[A-Z][A-Z_0-9]+$"), "^[A-Z][A-Z_0-9]+$");
        assert_eq!(lua_pattern_to_regex("^//!"), "^//!");
        assert_eq!(lua_pattern_to_regex("^%u[%w_]*$"), "^[A-Z][A-Za-z0-9_]*$");
        assert_eq!(lua_pattern_to_regex("a.-b%."), "a.*?b\\.");
    }

    #[test]
    fn legend_matches_discriminants() {
        for (i, k) in SyntaxHighlightKind::ALL.iter().enumerate() {
            assert_eq!(*k as usize, i);
        }
    }
}
