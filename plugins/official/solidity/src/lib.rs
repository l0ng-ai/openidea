//! Solidity for OpenIDEA: highlighting, structure view and folding from a
//! small hand-written lexer (the IDE has no Solidity grammar), exported as the
//! plugin's `syntax-provider`. Detection and the language server come from
//! `languages/solidity.toml`.

use openidea_plugin::syntax::{Fold, FoldKind, Highlight, Symbol, SymbolKind, SyntaxProvider, Token, bracket_folds};
use openidea_plugin::{Invocation, Plugin, register_plugin};
use std::ops::Range;

#[derive(Default)]
pub struct Solidity;

impl Plugin for Solidity {
    fn run_command(&mut self, id: &str, _ctx: &Invocation, _arg: Option<&str>) -> Result<Option<String>, String> {
        Err(format!("unknown command {id}"))
    }
}

impl SyntaxProvider for Solidity {
    fn highlights(&mut self, _language: &str, text: &str) -> Vec<Token> {
        highlights(text)
    }

    fn outline(&mut self, _language: &str, text: &str) -> Vec<Symbol> {
        outline(text)
    }

    fn folding(&mut self, _language: &str, text: &str) -> Vec<Fold> {
        folding(text)
    }
}

register_plugin!(Solidity, syntax);

// --- lexer -------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Ident,
    Number,
    Str,
    Comment,
    DocComment,
    Op,
    Punct,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Lexeme {
    kind: Kind,
    start: usize,
    end: usize,
}

impl Lexeme {
    fn text<'a>(&self, src: &'a str) -> &'a str {
        &src[self.start..self.end]
    }

    fn is_trivia(&self) -> bool {
        matches!(self.kind, Kind::Comment | Kind::DocComment)
    }
}

fn is_ident_start(b: u8) -> bool {
    b.is_ascii_alphabetic() || b == b'_' || b == b'$'
}

fn is_ident(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'$'
}

fn lex(text: &str) -> Vec<Lexeme> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        let start = i;
        let kind = if b.is_ascii_whitespace() {
            i += 1;
            continue;
        } else if bytes[i..].starts_with(b"//") {
            let end = text[i..].find('\n').map_or(bytes.len(), |n| i + n);
            let doc = bytes[i..].starts_with(b"///") && !bytes[i..].starts_with(b"////");
            i = end;
            if doc { Kind::DocComment } else { Kind::Comment }
        } else if bytes[i..].starts_with(b"/*") {
            let end = text[i + 2..].find("*/").map_or(bytes.len(), |n| i + 2 + n + 2);
            let doc = bytes[i..].starts_with(b"/**") && !bytes[i..].starts_with(b"/**/");
            i = end;
            if doc { Kind::DocComment } else { Kind::Comment }
        } else if b == b'"' || b == b'\'' {
            i = string_end(bytes, i);
            Kind::Str
        } else if b.is_ascii_digit() {
            i = number_end(bytes, i);
            Kind::Number
        } else if is_ident_start(b) {
            while i < bytes.len() && is_ident(bytes[i]) {
                i += 1;
            }
            // hex"…", unicode"…"
            let word = &text[start..i];
            if (word == "hex" || word == "unicode") && matches!(bytes.get(i), Some(b'"' | b'\'')) {
                i = string_end(bytes, i);
                Kind::Str
            } else {
                Kind::Ident
            }
        } else if b"(){}[];,.".contains(&b) {
            i += 1;
            Kind::Punct
        } else if b"+-*/%=!<>&|^~?:".contains(&b) {
            while i < bytes.len() && b"+-*/%=!<>&|^~?:".contains(&bytes[i]) && !bytes[i..].starts_with(b"//") {
                i += 1;
            }
            Kind::Op
        } else {
            // Anything else (non-ASCII outside strings): skip the whole character.
            i += text[i..].chars().next().map_or(1, char::len_utf8);
            continue;
        };
        out.push(Lexeme { kind, start, end: i });
    }
    out
}

fn string_end(bytes: &[u8], open: usize) -> usize {
    let quote = bytes[open];
    let mut i = open + 1;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            b'\n' => return i,
            c if c == quote => return i + 1,
            _ => i += 1,
        }
    }
    bytes.len()
}

fn number_end(bytes: &[u8], mut i: usize) -> usize {
    if bytes[i..].starts_with(b"0x") || bytes[i..].starts_with(b"0X") {
        i += 2;
        while i < bytes.len() && (bytes[i].is_ascii_hexdigit() || bytes[i] == b'_') {
            i += 1;
        }
        return i;
    }
    while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'_') {
        i += 1;
    }
    if i + 1 < bytes.len() && bytes[i] == b'.' && bytes[i + 1].is_ascii_digit() {
        i += 1;
        while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'_') {
            i += 1;
        }
    }
    if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
        let mut j = i + 1;
        if j < bytes.len() && (bytes[j] == b'-' || bytes[j] == b'+') {
            j += 1;
        }
        if j < bytes.len() && bytes[j].is_ascii_digit() {
            i = j;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
        }
    }
    i
}

// --- highlighting --------------------------------------------------------------

const KEYWORDS: &[&str] = &[
    "abstract",
    "anonymous",
    "as",
    "assembly",
    "break",
    "calldata",
    "catch",
    "constant",
    "constructor",
    "continue",
    "contract",
    "default",
    "delete",
    "do",
    "else",
    "emit",
    "enum",
    "error",
    "event",
    "external",
    "fallback",
    "for",
    "from",
    "function",
    "global",
    "if",
    "immutable",
    "import",
    "indexed",
    "interface",
    "internal",
    "is",
    "let",
    "library",
    "memory",
    "modifier",
    "new",
    "override",
    "payable",
    "pragma",
    "private",
    "public",
    "pure",
    "receive",
    "return",
    "returns",
    "revert",
    "solidity",
    "storage",
    "struct",
    "switch",
    "case",
    "transient",
    "try",
    "type",
    "unchecked",
    "using",
    "view",
    "virtual",
    "while",
    "leave",
    "wei",
    "gwei",
    "ether",
    "seconds",
    "minutes",
    "hours",
    "days",
    "weeks",
    "years",
];

const BUILTINS: &[&str] = &[
    "msg",
    "block",
    "tx",
    "abi",
    "now",
    "gasleft",
    "blockhash",
    "blobhash",
    "keccak256",
    "sha256",
    "ripemd160",
    "ecrecover",
    "addmod",
    "mulmod",
    "selfdestruct",
    "require",
    "assert",
    "this",
    "super",
];

const ATOMS: &[&str] = &["true", "false"];

fn is_elementary_type(word: &str) -> bool {
    if matches!(
        word,
        "address" | "bool" | "string" | "byte" | "bytes" | "int" | "uint" | "fixed" | "ufixed" | "mapping" | "var"
    ) {
        return true;
    }
    let sized = |prefix: &str| {
        word.strip_prefix(prefix).is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit() || b == b'x'))
    };
    sized("uint") || sized("int") || sized("bytes") || sized("ufixed") || sized("fixed")
}

/// The next lexeme that is not a comment.
fn next_code(lexemes: &[Lexeme], i: usize) -> Option<&Lexeme> {
    lexemes[i + 1..].iter().find(|l| !l.is_trivia())
}

fn prev_code(lexemes: &[Lexeme], i: usize) -> Option<&Lexeme> {
    lexemes[..i].iter().rev().find(|l| !l.is_trivia())
}

fn highlights(text: &str) -> Vec<Token> {
    let lexemes = lex(text);
    let mut out = Vec::with_capacity(lexemes.len());
    for (i, l) in lexemes.iter().enumerate() {
        let kind = match l.kind {
            Kind::Comment => Highlight::Comment,
            Kind::DocComment => Highlight::DocComment,
            Kind::Str => Highlight::String,
            Kind::Number => Highlight::Number,
            Kind::Op => Highlight::Operator,
            Kind::Punct => Highlight::Punctuation,
            Kind::Ident => {
                let word = l.text(text);
                let prev = prev_code(&lexemes, i).map(|p| p.text(text));
                let next = next_code(&lexemes, i).map(|n| n.text(text));
                if prev == Some(".") {
                    if next == Some("(") { Highlight::FunctionCall } else { Highlight::Property }
                } else if ATOMS.contains(&word) {
                    Highlight::Atom
                } else if KEYWORDS.contains(&word) {
                    Highlight::Keyword
                } else if is_elementary_type(word) {
                    Highlight::Type
                } else if matches!(prev, Some("function" | "modifier" | "event" | "error")) {
                    Highlight::Function
                } else if matches!(prev, Some("contract" | "interface" | "library" | "struct" | "enum" | "is" | "new"))
                {
                    Highlight::Type
                } else if BUILTINS.contains(&word) {
                    Highlight::Builtin
                } else if next == Some("(") {
                    Highlight::FunctionCall
                } else if word.starts_with(|c: char| c.is_ascii_uppercase()) {
                    if word.len() > 1 && word.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
                    {
                        Highlight::Constant
                    } else {
                        Highlight::Type
                    }
                } else {
                    continue;
                }
            }
        };
        out.push(Token { range: l.start..l.end, kind });
    }
    out
}

// --- structure ------------------------------------------------------------------

/// An open `{`: the symbol whose body it is, and what may be declared inside.
struct Frame {
    symbol: Option<usize>,
    body: Body,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Body {
    File,
    Contract,
    Struct,
    Enum,
    Code,
}

const MEMBER_MODIFIERS: &[&str] =
    &["public", "private", "internal", "external", "constant", "immutable", "override", "transient", "payable"];

fn outline(text: &str) -> Vec<Symbol> {
    let code: Vec<Lexeme> = lex(text).into_iter().filter(|l| !l.is_trivia()).collect();
    let word = |i: usize| code.get(i).map_or("", |l| l.text(text));
    let mut symbols: Vec<Symbol> = Vec::new();
    let mut frames = vec![Frame { symbol: None, body: Body::File }];
    // A declaration waiting for its body (`{`) or its end (`;`).
    let mut pending: Option<(usize, Body)> = None;
    let mut stmt_start = 0usize;
    let mut i = 0;
    while i < code.len() {
        let l = code[i];
        let w = l.text(text);
        let body = frames.last().map_or(Body::File, |f| f.body);
        let parent = frames.iter().rev().find_map(|f| f.symbol);
        let add = |symbols: &mut Vec<Symbol>, name_at: usize, kind: SymbolKind, detail: Option<&str>| {
            let name = code[name_at];
            symbols.push(Symbol {
                name: name.text(text).to_owned(),
                detail: detail.map(str::to_owned),
                kind,
                range: l.start..name.end,
                name_range: name.start..name.end,
                parent,
            });
            symbols.len() - 1
        };
        let declares = matches!(body, Body::File | Body::Contract) && pending.is_none();
        match (l.kind, w) {
            (Kind::Punct, "{") => {
                let (symbol, inner) = match pending.take() {
                    Some((s, b)) => (Some(s), b),
                    None => (None, if body == Body::Code || body == Body::Contract { Body::Code } else { body }),
                };
                frames.push(Frame { symbol, body: inner });
                stmt_start = i + 1;
            }
            (Kind::Punct, "}") => {
                if frames.len() > 1
                    && let Some(frame) = frames.pop()
                    && let Some(s) = frame.symbol
                {
                    symbols[s].range.end = l.end;
                }
                stmt_start = i + 1;
            }
            (Kind::Punct, ";") => {
                if let Some((s, _)) = pending.take() {
                    symbols[s].range.end = l.end;
                } else if matches!(body, Body::Contract | Body::Struct | Body::File) && stmt_start < i {
                    // `Type [modifiers] name [= value];`: a state variable, struct member or file constant.
                    let stmt = &code[stmt_start..i];
                    let head = stmt[0].text(text);
                    let skip = matches!(head, "using" | "import" | "pragma" | "return" | "emit" | "type");
                    let until = stmt.iter().position(|s| s.text(text) == "=").unwrap_or(stmt.len());
                    let name = stmt[..until].iter().rposition(|s| {
                        s.kind == Kind::Ident
                            && !MEMBER_MODIFIERS.contains(&s.text(text))
                            && !is_elementary_type(s.text(text))
                    });
                    if let (false, Some(n)) = (skip, name)
                        && n > 0
                    {
                        let constant = stmt[..until].iter().any(|s| matches!(s.text(text), "constant" | "immutable"));
                        let kind = if constant { SymbolKind::Constant } else { SymbolKind::Field };
                        if body != Body::File || constant {
                            let at = stmt_start + n;
                            let name = code[at];
                            symbols.push(Symbol {
                                name: name.text(text).to_owned(),
                                detail: None,
                                kind,
                                range: code[stmt_start].start..l.end,
                                name_range: name.start..name.end,
                                parent,
                            });
                        }
                    }
                }
                stmt_start = i + 1;
            }
            (Kind::Ident, "contract" | "interface" | "library") if declares && word(i + 1) != "" => {
                if code.get(i + 1).is_some_and(|n| n.kind == Kind::Ident) {
                    let kind = match w {
                        "interface" => SymbolKind::Interface,
                        "library" => SymbolKind::Module,
                        _ => SymbolKind::Class,
                    };
                    let abstract_ = i > 0 && word(i - 1) == "abstract";
                    let s = add(&mut symbols, i + 1, kind, abstract_.then_some("abstract"));
                    if abstract_ {
                        symbols[s].range.start = code[i - 1].start;
                    }
                    pending = Some((s, Body::Contract));
                    i += 1;
                }
            }
            (Kind::Ident, "function" | "modifier" | "event" | "error") if declares => {
                if code.get(i + 1).is_some_and(|n| n.kind == Kind::Ident) {
                    let (kind, detail) = match w {
                        "function" if body == Body::Contract => (SymbolKind::Method, None),
                        "function" => (SymbolKind::Function, None),
                        "modifier" => (SymbolKind::Method, Some("modifier")),
                        "event" => (SymbolKind::Event, None),
                        _ => (SymbolKind::Event, Some("error")),
                    };
                    let s = add(&mut symbols, i + 1, kind, detail);
                    pending = Some((s, Body::Code));
                    i += 1;
                }
            }
            (Kind::Ident, "constructor" | "fallback" | "receive") if declares && word(i + 1) == "(" => {
                let kind = if w == "constructor" { SymbolKind::Constructor } else { SymbolKind::Method };
                let s = add(&mut symbols, i, kind, None);
                pending = Some((s, Body::Code));
            }
            (Kind::Ident, "struct" | "enum") if declares => {
                if code.get(i + 1).is_some_and(|n| n.kind == Kind::Ident) {
                    let (kind, inner) =
                        if w == "struct" { (SymbolKind::Struct, Body::Struct) } else { (SymbolKind::Enum, Body::Enum) };
                    let s = add(&mut symbols, i + 1, kind, None);
                    pending = Some((s, inner));
                    i += 1;
                }
            }
            (Kind::Ident, "type") if declares && word(i + 2) == "is" => {
                let s = add(&mut symbols, i + 1, SymbolKind::TypeAlias, None);
                pending = Some((s, Body::Code));
                i += 1;
            }
            (Kind::Ident, _) if body == Body::Enum && matches!(word(i + 1), "," | "}") => {
                symbols.push(Symbol {
                    name: w.to_owned(),
                    detail: None,
                    kind: SymbolKind::EnumMember,
                    range: l.start..l.end,
                    name_range: l.start..l.end,
                    parent,
                });
            }
            _ => {}
        }
        i += 1;
    }
    symbols
}

// --- folding -----------------------------------------------------------------------

fn folding(text: &str) -> Vec<Fold> {
    let lexemes = lex(text);
    let line_of = |offset: usize| text[..offset].bytes().filter(|&b| b == b'\n').count() as u32;
    let skip: Vec<Range<usize>> = lexemes
        .iter()
        .filter(|l| matches!(l.kind, Kind::Str | Kind::Comment | Kind::DocComment))
        .map(|l| l.start..l.end)
        .collect();
    let mut folds = bracket_folds(text, b'{', b'}', &skip);
    for l in lexemes.iter().filter(|l| l.is_trivia()) {
        let (start, end) = (line_of(l.start), line_of(l.end));
        if end > start {
            folds.push(Fold { start_line: start, end_line: end, kind: FoldKind::Comment });
        }
    }
    // Consecutive `import` lines.
    let mut run: Option<(u32, u32)> = None;
    let flush = |run: &mut Option<(u32, u32)>, folds: &mut Vec<Fold>| {
        if let Some((s, e)) = run.take()
            && e > s
        {
            folds.push(Fold { start_line: s, end_line: e, kind: FoldKind::Imports });
        }
    };
    for (n, line) in text.lines().enumerate() {
        let n = n as u32;
        let t = line.trim_start();
        if t.starts_with("import ") || t.starts_with("import{") {
            run = Some(run.map_or((n, n), |(s, _)| (s, n)));
        } else if !t.is_empty() {
            flush(&mut run, &mut folds);
        }
    }
    flush(&mut run, &mut folds);
    folds
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IERC20.sol";
import {Ownable} from "./Ownable.sol";

/// @title A token
abstract contract Token is IERC20, Ownable {
    uint256 public constant MAX_SUPPLY = 1_000_000e18;
    mapping(address => uint256) private balances;
    string name = "tök";

    enum State { Idle, Running }
    struct Holder {
        address who;
        uint96 amount;
    }

    event Transfer(address indexed from, address indexed to, uint256 value);
    error Insufficient(uint256 needed);

    modifier onlyHolder() {
        require(balances[msg.sender] > 0, "no");
        _;
    }

    constructor(string memory n) {
        name = n;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        /* multi
           line */
        if (balances[msg.sender] < value) revert Insufficient(value);
        emit Transfer(msg.sender, to, value);
        return true;
    }

    function total() public view virtual returns (uint256);
}

interface IThing {
    function thing() external;
}

function free(uint x) pure returns (uint) { return x; }
"#;

    fn names(symbols: &[Symbol], parent: Option<usize>) -> Vec<(&str, SymbolKind)> {
        symbols.iter().filter(|s| s.parent == parent).map(|s| (s.name.as_str(), s.kind)).collect()
    }

    #[test]
    fn outline_lists_declarations_with_their_members() {
        let symbols = outline(SAMPLE);
        let top = names(&symbols, None);
        assert_eq!(
            top,
            [("Token", SymbolKind::Class), ("IThing", SymbolKind::Interface), ("free", SymbolKind::Function)]
        );
        let token = symbols.iter().position(|s| s.name == "Token").unwrap();
        assert_eq!(symbols[token].detail.as_deref(), Some("abstract"));
        assert!(SAMPLE[symbols[token].range.clone()].starts_with("abstract contract Token"));
        assert!(SAMPLE[symbols[token].range.clone()].ends_with('}'));
        assert_eq!(
            names(&symbols, Some(token)),
            [
                ("MAX_SUPPLY", SymbolKind::Constant),
                ("balances", SymbolKind::Field),
                ("name", SymbolKind::Field),
                ("State", SymbolKind::Enum),
                ("Holder", SymbolKind::Struct),
                ("Transfer", SymbolKind::Event),
                ("Insufficient", SymbolKind::Event),
                ("onlyHolder", SymbolKind::Method),
                ("constructor", SymbolKind::Constructor),
                ("transfer", SymbolKind::Method),
                ("total", SymbolKind::Method),
            ]
        );
        let state = symbols.iter().position(|s| s.name == "State").unwrap();
        assert_eq!(
            names(&symbols, Some(state)),
            [("Idle", SymbolKind::EnumMember), ("Running", SymbolKind::EnumMember)]
        );
        let holder = symbols.iter().position(|s| s.name == "Holder").unwrap();
        assert_eq!(names(&symbols, Some(holder)), [("who", SymbolKind::Field), ("amount", SymbolKind::Field)]);
        let total = symbols.iter().find(|s| s.name == "total").unwrap();
        assert!(SAMPLE[total.range.clone()].ends_with("returns (uint256);"));
        // Parents come first.
        assert!(symbols.iter().enumerate().all(|(i, s)| s.parent.is_none_or(|p| p < i)));
    }

    #[test]
    fn highlights_classify_tokens() {
        let tokens = highlights(SAMPLE);
        let kind_of = |needle: &str| {
            let at = SAMPLE.find(needle).unwrap();
            tokens.iter().find(|t| t.range.start == at).map(|t| t.kind)
        };
        assert_eq!(kind_of("// SPDX"), Some(Highlight::Comment));
        assert_eq!(kind_of("/// @title"), Some(Highlight::DocComment));
        assert_eq!(kind_of("pragma"), Some(Highlight::Keyword));
        assert_eq!(kind_of("uint256 public"), Some(Highlight::Type));
        assert_eq!(kind_of("MAX_SUPPLY"), Some(Highlight::Constant));
        assert_eq!(kind_of("1_000_000e18"), Some(Highlight::Number));
        assert_eq!(kind_of("\"tök\""), Some(Highlight::String));
        assert_eq!(kind_of("Transfer(address"), Some(Highlight::Function));
        assert_eq!(kind_of("require("), Some(Highlight::Builtin));
        assert_eq!(kind_of("sender]"), Some(Highlight::Property));
        assert_eq!(kind_of("true;"), Some(Highlight::Atom));
        assert_eq!(kind_of("IERC20, Ownable"), Some(Highlight::Type));
        // Sorted and non-overlapping, on char boundaries.
        assert!(tokens.windows(2).all(|w| w[0].range.end <= w[1].range.start));
        assert!(tokens.iter().all(|t| SAMPLE.is_char_boundary(t.range.start) && SAMPLE.is_char_boundary(t.range.end)));
    }

    #[test]
    fn folds_bodies_comments_and_imports() {
        let folds = folding(SAMPLE);
        let line = |needle: &str| SAMPLE[..SAMPLE.find(needle).unwrap()].matches('\n').count() as u32;
        assert!(folds.contains(&Fold { start_line: 3, end_line: 4, kind: FoldKind::Imports }));
        assert!(folds.iter().any(|f| f.kind == FoldKind::Comment && f.start_line == line("/* multi")));
        let contract = line("abstract contract");
        assert!(folds.iter().any(|f| f.kind == FoldKind::Region && f.start_line == contract));
    }

    #[test]
    fn lexer_survives_unterminated_input() {
        for text in ["\"abc", "/* open", "0x", "a.", "uint256 x = 1e", "é∑ unknown"] {
            let _ = highlights(text);
            let _ = outline(text);
            let _ = folding(text);
        }
    }
}
