//! Grammar checking for Proofreading › Grammar: Harper's English rules
//! (`harper-core`, run in process) over the comments and docstrings of source
//! files, Markdown and plain text, and commit messages. Harper's own spell
//! check stays off; Proofreading › Typo covers spelling.

use harper_core::linting::{FlatConfig, LintGroup, Suggestion};
use harper_core::parsers::{Markdown, MarkdownOptions, PlainEnglish};
use harper_core::spell::{Dictionary, FstDictionary, MergedDictionary, MutableDictionary};
use harper_core::{Dialect, DictWordMetadata, Document};
use ide_core::{Pos, Range};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::Arc;

/// Harper's spelling rule, always off.
const SPELL_CHECK: &str = "SpellCheck";

/// Characters checked per text at most; the rest is skipped.
pub const MAX_CHARS: usize = 120_000;

/// What a [`Block`] holds, which decides what is stripped before checking.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlockKind {
    /// A comment: its markers (`//`, `#`, `/*`, `*`, `--`…) are not text.
    Comment,
    /// A string statement (Python docstring): quotes and `>>>` lines are not text.
    Docstring,
    /// Markdown: code blocks and spans are skipped.
    Markdown,
    /// Plain text (a commit message).
    Plain,
}

/// A byte range of the text to check.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Block {
    pub start: usize,
    pub end: usize,
    pub kind: BlockKind,
}

/// One edit that resolves a problem.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct GrammarFix {
    /// UTF-16 range replaced (empty to insert).
    pub range: Range,
    pub text: String,
}

/// A grammar problem.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GrammarProblem {
    /// UTF-16 range of the flagged text.
    pub range: Range,
    /// The flagged text.
    pub text: String,
    /// Harper's rule name (`AnA`), what "Disable rule" turns off.
    pub rule: String,
    pub message: String,
    /// Edits Harper suggests, best first; none when the text spans comment markers.
    pub fixes: Vec<GrammarFix>,
    /// The flagged text is one word Harper's dictionary lacks (a name, a
    /// term): saving it to the spelling dictionary makes Harper accept it.
    pub unknown_word: bool,
}

/// A rule the Grammar settings page lists.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct GrammarRule {
    pub name: String,
    pub description: String,
}

/// How to check: dialect, rules turned off, words to accept.
#[derive(Clone, Debug, Default)]
pub struct Options {
    /// `american` (default), `british`, `canadian`, `australian`, `indian`.
    pub dialect: String,
    pub disabled_rules: Vec<String>,
    /// Words of the spelling dictionaries, which Harper accepts too.
    pub words: Vec<String>,
}

fn dialect(name: &str) -> Dialect {
    match name.to_ascii_lowercase().as_str() {
        "british" => Dialect::British,
        "canadian" => Dialect::Canadian,
        "australian" => Dialect::Australian,
        "indian" => Dialect::Indian,
        _ => Dialect::American,
    }
}

/// Harper's dictionary and rules, built once (the dictionary takes about a
/// second and 150 MB) and rebuilt only when the dialect or the words change.
struct Engine {
    dialect: Dialect,
    words: Vec<String>,
    dictionary: Arc<MergedDictionary>,
    group: LintGroup,
    /// Harper's curated rule settings, restored before each check.
    defaults: FlatConfig,
}

impl Engine {
    fn new(dialect: Dialect, words: Vec<String>) -> Self {
        let mut user = MutableDictionary::new();
        for w in &words {
            user.append_word_str(w, DictWordMetadata::default());
        }
        let mut dictionary = MergedDictionary::new();
        dictionary.add_dictionary(FstDictionary::curated());
        dictionary.add_dictionary(Arc::new(user));
        let dictionary = Arc::new(dictionary);
        let group = LintGroup::new_curated(dictionary.clone(), dialect);
        let defaults = group.config.clone();
        Self { dialect, words, dictionary, group, defaults }
    }
}

static ENGINE: Mutex<Option<Engine>> = Mutex::new(None);

/// Runs `f` with the engine for `options`, its rules set from them.
fn with_engine<T>(options: &Options, f: impl FnOnce(&mut Engine) -> T) -> T {
    let mut guard = ENGINE.lock();
    let d = dialect(&options.dialect);
    let mut words = options.words.clone();
    words.sort();
    words.dedup();
    let engine = match guard.as_mut() {
        Some(e) if e.dialect == d && e.words == words => e,
        _ => guard.insert(Engine::new(d, words)),
    };
    engine.group.config = engine.defaults.clone();
    engine.group.config.set_rule_enabled(SPELL_CHECK, false);
    for rule in &options.disabled_rules {
        engine.group.config.set_rule_enabled(rule, false);
    }
    f(engine)
}

/// Every rule but Harper's spell check, by name.
pub fn rules() -> Vec<GrammarRule> {
    with_engine(&Options::default(), |e| {
        let mut out: Vec<GrammarRule> = e
            .group
            .all_descriptions()
            .into_iter()
            .filter(|(name, _)| *name != SPELL_CHECK)
            .map(|(name, description)| GrammarRule { name: name.to_string(), description: description.to_string() })
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    })
}

/// The checked text of a block: its characters and, for each, its byte offset
/// in the document (one more entry: the end).
struct Stripped {
    chars: Vec<char>,
    offsets: Vec<usize>,
}

impl Stripped {
    fn push(&mut self, text: &str, at: usize) {
        for (i, c) in text.char_indices() {
            self.chars.push(c);
            self.offsets.push(at + i);
        }
    }
}

/// The comment markers at the start of `line` (after indentation): `//`,
/// `///`, `/*`, `*`, `#`, `--`, `;`, `%`, `<!--`, then one space.
fn leading_marker(line: &str) -> usize {
    let indent = line.len() - line.trim_start().len();
    let rest = &line[indent..];
    let mut n = 0;
    let bytes = rest.as_bytes();
    while n < bytes.len() {
        match bytes[n] {
            b'/' | b'*' | b'#' | b'!' | b';' | b'%' => n += 1,
            b'-' if bytes.get(n + 1) == Some(&b'-') => n += 2,
            b'<' if rest[n..].starts_with("<!--") => n += 4,
            _ => break,
        }
    }
    if n > 0 && bytes.get(n) == Some(&b' ') {
        n += 1;
    }
    indent + n
}

/// The length of `line` without its closing marker: `*/` (with more `*`) or `-->`.
fn before_closing_marker(line: &str) -> usize {
    let t = line.trim_end();
    t.strip_suffix("*/")
        .map(|b| b.trim_end_matches('*'))
        .or_else(|| t.strip_suffix("-->"))
        .unwrap_or(t)
        .trim_end()
        .len()
}

/// `block`'s text without what is not prose: comment markers, docstring
/// quotes and doctest lines; Markdown and plain text unchanged.
fn strip(text: &str, block: Block) -> Stripped {
    let mut out = Stripped { chars: Vec::new(), offsets: Vec::new() };
    let body = &text[block.start..block.end];
    match block.kind {
        BlockKind::Markdown | BlockKind::Plain => out.push(body, block.start),
        BlockKind::Comment => {
            let mut at = block.start;
            for line in body.split_inclusive('\n') {
                let content = line.trim_end_matches(['\n', '\r']);
                let from = leading_marker(content);
                let to = from + before_closing_marker(&content[from..]);
                out.push(&content[from..to], at + from);
                if content.len() < line.len() {
                    out.push("\n", at + content.len());
                }
                at += line.len();
            }
        }
        BlockKind::Docstring => {
            let prefix = body.find(['"', '\'']).unwrap_or(0);
            let quote = if body[prefix..].starts_with("\"\"\"") || body[prefix..].starts_with("'''") { 3 } else { 1 };
            let inner_start = (prefix + quote).min(body.len());
            let inner_end = body.len().saturating_sub(quote).max(inner_start);
            let inner = &body[inner_start..inner_end];
            let mut at = block.start + inner_start;
            for line in inner.split_inclusive('\n') {
                let content = line.trim_end_matches(['\n', '\r']);
                let trimmed = content.trim_start();
                let indent = content.len() - trimmed.len();
                if !trimmed.starts_with(">>>") && !trimmed.starts_with("...") {
                    out.push(trimmed, at + indent);
                }
                if content.len() < line.len() {
                    out.push("\n", at + content.len());
                }
                at += line.len();
            }
        }
    }
    out.offsets.push(block.end);
    out
}

/// Byte offset → line / UTF-16 column, for mostly increasing offsets.
struct Utf16Walker<'a> {
    text: &'a str,
    byte: usize,
    pos: Pos,
}

impl<'a> Utf16Walker<'a> {
    fn new(text: &'a str) -> Self {
        Self { text, byte: 0, pos: Pos::new(0, 0) }
    }

    fn pos(&mut self, target: usize) -> Pos {
        if target < self.byte {
            *self = Self::new(self.text);
        }
        for c in self.text[self.byte..target].chars() {
            if c == '\n' {
                self.pos = Pos::new(self.pos.line + 1, 0);
            } else {
                self.pos.col += c.len_utf16() as u32;
            }
        }
        self.byte = target;
        self.pos
    }
}

/// Grammar problems of `blocks` (document order) in `text`. Neighbouring
/// comments with only whitespace between them (consecutive `//` lines) are
/// checked as one text. `None` when `cancelled` fires.
pub fn check(
    text: &str,
    blocks: &[Block],
    options: &Options,
    cancelled: &dyn Fn() -> bool,
) -> Option<Vec<GrammarProblem>> {
    let mut merged: Vec<Block> = Vec::new();
    for b in blocks {
        match merged.last_mut() {
            Some(last)
                if last.kind == BlockKind::Comment
                    && b.kind == BlockKind::Comment
                    && text[last.end..b.start].chars().all(char::is_whitespace)
                    && text[last.end..b.start].matches('\n').count() <= 1 =>
            {
                last.end = b.end
            }
            _ => merged.push(*b),
        }
    }
    with_engine(options, |engine| {
        let mut found: Vec<(usize, usize, GrammarProblem)> = Vec::new();
        let mut walker = Utf16Walker::new(text);
        let mut budget = MAX_CHARS;
        for block in merged {
            if cancelled() {
                return None;
            }
            let s = strip(text, block);
            if s.chars.iter().all(|c| c.is_whitespace()) {
                continue;
            }
            if s.chars.len() > budget {
                break;
            }
            budget -= s.chars.len();
            let source: String = s.chars.iter().collect();
            let doc = match block.kind {
                BlockKind::Plain => Document::new(&source, &PlainEnglish, engine.dictionary.as_ref()),
                _ => Document::new(&source, &Markdown::new(MarkdownOptions::default()), engine.dictionary.as_ref()),
            };
            for (rule, lints) in engine.group.organized_lints(&doc) {
                for lint in lints {
                    let (cs, ce) = (lint.span.start, lint.span.end.min(s.chars.len()));
                    if cs >= ce {
                        continue;
                    }
                    let (start, end) = (s.offsets[cs], s.offsets[ce - 1] + s.chars[ce - 1].len_utf8());
                    let flagged: String = s.chars[cs..ce].iter().collect();
                    // A span across stripped markers can't be edited in place.
                    let editable = text[start..end] == flagged;
                    let mut fixes: Vec<GrammarFix> = Vec::new();
                    if editable {
                        for suggestion in &lint.suggestions {
                            let (from, to, insert) = match suggestion {
                                Suggestion::ReplaceWith(chars) => (start, end, chars.iter().collect::<String>()),
                                Suggestion::InsertAfter(chars) => (end, end, chars.iter().collect()),
                                Suggestion::Remove => (start, end, String::new()),
                            };
                            let range = Range::new(walker.pos(from), walker.pos(to));
                            if !fixes.iter().any(|f| f.range == range && f.text.trim_end() == insert.trim_end()) {
                                fixes.push(GrammarFix { range, text: insert });
                            }
                        }
                    }
                    let unknown_word = flagged.chars().all(|c| c.is_alphabetic() || c == '\'' || c == '-')
                        && !engine.dictionary.contains_word_str(&flagged);
                    let range = Range::new(walker.pos(start), walker.pos(end));
                    found.push((
                        start,
                        end,
                        GrammarProblem {
                            range,
                            text: flagged,
                            rule: rule.clone(),
                            message: lint.message,
                            fixes,
                            unknown_word,
                        },
                    ));
                }
            }
        }
        found.sort_by_key(|(start, end, _)| (*start, *end));
        Some(found.into_iter().map(|(_, _, p)| p).collect())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(text: &str, blocks: &[Block]) -> Vec<GrammarProblem> {
        check(text, blocks, &Options::default(), &|| false).unwrap()
    }

    fn whole(text: &str, kind: BlockKind) -> Vec<GrammarProblem> {
        run(text, &[Block { start: 0, end: text.len(), kind }])
    }

    fn slice(text: &str, r: Range) -> &str {
        // Single-line ASCII test texts: UTF-16 columns are byte offsets of the line.
        let line = text.lines().nth(r.start.line as usize).unwrap();
        &line[r.start.col as usize..r.end.col as usize]
    }

    #[test]
    fn plain_text_problems_carry_rule_and_fixes() {
        let text = "This is an test.";
        let found = whole(text, BlockKind::Plain);
        let p = found.iter().find(|p| p.rule == "AnA").expect("AnA reported");
        assert_eq!(p.text, "an");
        assert_eq!(slice(text, p.range), "an");
        assert_eq!(p.fixes[0].text, "a");
        assert_eq!(p.fixes[0].range, p.range);
        assert!(!p.unknown_word, "'an' is a known word");
    }

    #[test]
    fn spelling_is_left_to_typo() {
        assert!(whole("I recieve the file.", BlockKind::Plain).iter().all(|p| p.rule != SPELL_CHECK));
    }

    #[test]
    fn disabled_rules_are_skipped() {
        let text = "This is an test.";
        let options = Options { disabled_rules: vec!["AnA".into()], ..Default::default() };
        let found = check(text, &[Block { start: 0, end: text.len(), kind: BlockKind::Plain }], &options, &|| false);
        assert!(found.unwrap().iter().all(|p| p.rule != "AnA"));
        // The rule is back for the next check without it.
        assert!(whole(text, BlockKind::Plain).iter().any(|p| p.rule == "AnA"));
    }

    #[test]
    fn comment_markers_are_not_text() {
        let text = "fn main() {}\n// This is an test.\n";
        let start = text.find("//").unwrap();
        let found = run(text, &[Block { start, end: text.len() - 1, kind: BlockKind::Comment }]);
        let p = found.iter().find(|p| p.rule == "AnA").expect("AnA reported");
        assert_eq!((p.range.start.line, p.range.start.col), (1, 11));
        assert_eq!(p.fixes[0].text, "a");
    }

    #[test]
    fn markers_are_stripped_per_line() {
        let text = "/**\n * Returns an value.\n */";
        let s = strip(text, Block { start: 0, end: text.len(), kind: BlockKind::Comment });
        let stripped: String = s.chars.iter().collect();
        assert_eq!(stripped, "\nReturns an value.\n");
        assert_eq!(&text[s.offsets[1]..s.offsets[1] + 7], "Returns");
        let text = "# Note -- read this.  -->";
        let s = strip(text, Block { start: 0, end: text.len(), kind: BlockKind::Comment });
        assert_eq!(s.chars.iter().collect::<String>(), "Note -- read this.");
    }

    #[test]
    fn docstrings_skip_quotes_and_doctests() {
        let text = "\"\"\"Load it.\n\n    >>> load()\n    Returns an value.\n    \"\"\"";
        let s = strip(text, Block { start: 0, end: text.len(), kind: BlockKind::Docstring });
        assert_eq!(s.chars.iter().collect::<String>(), "Load it.\n\n\nReturns an value.\n");
    }

    #[test]
    fn neighbouring_line_comments_are_one_text() {
        // Checked apart, "the" ends one line and starts the next: no repetition.
        let text = "// Pass the\n// the value.\n";
        let blocks: Vec<Block> = text
            .match_indices("//")
            .map(|(i, _)| Block { start: i, end: i + text[i..].find('\n').unwrap(), kind: BlockKind::Comment })
            .collect();
        let found = run(text, &blocks);
        let p = found.iter().find(|p| p.rule.contains("Repeat") || p.message.contains("repeat"));
        let p = p.expect("repetition across lines reported");
        // The repeated words sit on two lines, around a marker: no in-place fix.
        assert!(p.fixes.is_empty(), "{p:?}");
    }

    #[test]
    fn markdown_code_is_skipped() {
        assert!(whole("Text.\n\n```\nThis is an test.\n```\n", BlockKind::Markdown).is_empty());
    }

    #[test]
    fn rules_list_names_and_descriptions() {
        let rules = rules();
        assert!(rules.iter().any(|r| r.name == "AnA" && !r.description.is_empty()));
        assert!(rules.iter().all(|r| r.name != SPELL_CHECK));
    }

    #[test]
    fn cancelled_check_returns_none() {
        let text = "This is an test.";
        assert!(
            check(text, &[Block { start: 0, end: text.len(), kind: BlockKind::Plain }], &Options::default(), &|| true)
                .is_none()
        );
    }
}
