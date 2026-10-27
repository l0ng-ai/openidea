//! Spell checking for IDEA's "Proofreading › Typo" inspection: words of
//! comments, string literals and declared names (regions come from the
//! syntax layer), checked against the bundled en_US Hunspell dictionary, a
//! list of programming terms and the user's accepted words and dictionaries.
//! Regular agent nouns of known words (`checkpointer`) pass everywhere; in
//! identifiers so do closed compounds of known words (`codebase`).

mod words;

use ide_core::{Pos, Range};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::SystemTime;

pub use words::{MIN_WORD_CHARS, WordSpan, words};

/// Where a region's words come from; strings and comments understand escapes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RegionKind {
    Comment,
    String,
    /// A declared identifier (`camelCase` / `snake_case` split).
    Name,
    /// Plain text / Markdown prose.
    Prose,
}

/// A byte range of the text to check.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Region {
    pub start: usize,
    pub end: usize,
    pub kind: RegionKind,
}

/// What a typo is part of: correcting one in `Code` (a declared name) must
/// rename the symbol; the others may replace the word in place.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TypoContext {
    Code,
    Literal,
    Comment,
    Prose,
}

impl From<RegionKind> for TypoContext {
    fn from(kind: RegionKind) -> Self {
        match kind {
            RegionKind::Name => Self::Code,
            RegionKind::String => Self::Literal,
            RegionKind::Comment => Self::Comment,
            RegionKind::Prose => Self::Prose,
        }
    }
}

/// A misspelt word.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct Typo {
    /// UTF-16 range of the word.
    pub range: Range,
    pub word: String,
    pub context: TypoContext,
}

/// The Typo inspection's options (IDEA's "Process code / literals / comments");
/// plain text and Markdown are always checked.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct SpellScope {
    pub code: bool,
    pub literals: bool,
    pub comments: bool,
}

impl Default for SpellScope {
    fn default() -> Self {
        Self { code: true, literals: true, comments: true }
    }
}

impl SpellScope {
    pub fn includes(&self, kind: RegionKind) -> bool {
        match kind {
            RegionKind::Name => self.code,
            RegionKind::String => self.literals,
            RegionKind::Comment => self.comments,
            RegionKind::Prose => true,
        }
    }
}

/// At most this many typos are reported per text.
pub const MAX_TYPOS: usize = 2000;

fn english() -> &'static spellbook::Dictionary {
    static DICT: OnceLock<spellbook::Dictionary> = OnceLock::new();
    DICT.get_or_init(|| {
        let aff = include_str!("dict/en_US.aff");
        let dic = include_str!("dict/en_US.dic");
        spellbook::Dictionary::new(aff, dic).expect("bundled en_US dictionary parses")
    })
}

/// Lowercase entries of the dictionary as listed (no affixes applied, no proper nouns).
fn lemmas() -> &'static HashSet<&'static str> {
    static LEMMAS: OnceLock<HashSet<&'static str>> = OnceLock::new();
    LEMMAS.get_or_init(|| {
        include_str!("dict/en_US.dic")
            .lines()
            .skip(1)
            .map(|l| l.split('/').next().unwrap_or(l).trim())
            .filter(|w| !w.is_empty() && w.chars().all(|c| c.is_ascii_lowercase()))
            .collect()
    })
}

/// Common misspellings made of two words; never accepted as compounds.
const NOT_COMPOUNDS: &[&str] = &["eachother", "everytime", "publically", "aswell", "infact", "atleast", "alot"];

/// Shortest dictionary word in a derivation or compound (programming terms: 3).
const MIN_PART: usize = 4;

/// Whether English doubles the final consonant before `-er` (`program` →
/// `programmer`): the stem ends consonant, single vowel, consonant (not w/x/y).
fn doubles_final_consonant(stem: &str) -> bool {
    let vowel = |c: u8| b"aeiou".contains(&c);
    match stem.as_bytes() {
        [.., a, b, c] => !vowel(*a) && vowel(*b) && !vowel(*c) && !b"wxy".contains(c),
        _ => false,
    }
}

/// Whether dropping one letter or swapping two adjacent ones gives a dictionary
/// word: then a compound (`writ`+`ting`) is more likely a typo of
/// it (`writing`), as Hunspell's CHECKCOMPOUNDREP reasons.
fn near_word(lower: &str) -> bool {
    let b = lower.as_bytes();
    let dict = english();
    let check = |v: &[u8]| std::str::from_utf8(v).is_ok_and(|w| dict.check(w));
    (0..b.len()).any(|i| check(&[&b[..i], &b[i + 1..]].concat()))
        || (0..b.len().saturating_sub(1)).any(|i| {
            let mut v = b.to_vec();
            v.swap(i, i + 1);
            v != b && check(&v)
        })
}

fn software_terms() -> &'static HashSet<&'static str> {
    static TERMS: OnceLock<HashSet<&'static str>> = OnceLock::new();
    TERMS.get_or_init(|| {
        include_str!("dict/software.txt")
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .collect()
    })
}

/// Words of a custom dictionary file: a plain word list or a Hunspell `.dic`
/// (leading count line and `/FLAGS` ignored). Cached by modification time.
fn dictionary_file(path: &Path) -> Arc<HashSet<String>> {
    type Cache = HashMap<PathBuf, (Option<SystemTime>, Arc<HashSet<String>>)>;
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    let modified = std::fs::metadata(path).and_then(|m| m.modified()).ok();
    let mut cache = CACHE.get_or_init(Default::default).lock();
    if let Some((at, words)) = cache.get(path)
        && *at == modified
    {
        return words.clone();
    }
    let words: HashSet<String> = match std::fs::read_to_string(path) {
        Ok(text) => parse_word_list(&text),
        Err(e) => {
            tracing::debug!("custom dictionary {}: {e}", path.display());
            HashSet::new()
        }
    };
    let words = Arc::new(words);
    cache.insert(path.to_path_buf(), (modified, words.clone()));
    words
}

/// Lowercased words of a word list / Hunspell `.dic` text.
pub fn parse_word_list(text: &str) -> HashSet<String> {
    let mut lines = text.lines().map(str::trim).peekable();
    if lines.peek().is_some_and(|l| !l.is_empty() && l.chars().all(|c| c.is_ascii_digit())) {
        lines.next();
    }
    lines
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(|l| l.split('/').next().unwrap_or(l).trim().to_lowercase())
        .filter(|w| !w.is_empty())
        .collect()
}

/// The dictionary plus the user's accepted words and custom dictionaries.
#[derive(Default)]
pub struct Speller {
    accepted: HashSet<String>,
    custom: Vec<Arc<HashSet<String>>>,
}

impl Speller {
    pub fn new<S: AsRef<str>>(accepted: impl IntoIterator<Item = S>, dictionaries: &[PathBuf]) -> Self {
        Self {
            accepted: accepted.into_iter().map(|w| w.as_ref().trim().to_lowercase()).collect(),
            custom: dictionaries.iter().map(|p| dictionary_file(p)).collect(),
        }
    }

    /// Whether `word` (of prose, a comment or a string) is spelt correctly.
    /// Case is forgiven the way identifiers need it: `url` passes for `URL`,
    /// `paris` for `Paris`. Regular agent nouns of known words pass too
    /// (`checkpointer`, `serializers`).
    pub fn is_correct(&self, word: &str) -> bool {
        let lower = word.to_lowercase();
        self.listed(word, &lower) || self.agent_noun(&lower)
    }

    /// [`Self::is_correct`] for a part of an identifier, which may also be two
    /// known words run together (`codebase`, `urlpath`), as identifiers often are.
    pub fn is_correct_identifier(&self, word: &str) -> bool {
        self.is_correct(word) || self.compound(&word.to_lowercase())
    }

    fn user_word(&self, lower: &str) -> bool {
        self.accepted.contains(lower)
            || software_terms().contains(lower)
            || self.custom.iter().any(|d| d.contains(lower))
    }

    /// In a dictionary, in any case style.
    fn listed(&self, word: &str, lower: &str) -> bool {
        if self.user_word(lower) {
            return true;
        }
        let dict = english();
        dict.check(word) || dict.check(lower) || dict.check(&capitalize(lower)) || dict.check(&lower.to_uppercase())
    }

    /// `<stem>er(s)` / `<stem>r(s)` of a listed stem: `checkpointer`
    /// (checkpoint), `serializers` (serialize), `queriers` (query). Not when
    /// English doubles the final consonant (`programer`) or the `-or` noun is
    /// the word (`processer`, `generater`).
    fn agent_noun(&self, lower: &str) -> bool {
        if !lower.bytes().all(|c| c.is_ascii_lowercase()) {
            return false;
        }
        let singular = lower.strip_suffix('s').unwrap_or(lower);
        let Some(before_r) = singular.strip_suffix('r') else { return false };
        let Some(before_er) = before_r.strip_suffix('e') else { return false };
        // (stem, root the `-or` noun would be built on)
        let mut stems = vec![(before_r.to_string(), before_er)];
        if let Some(y) = before_er.strip_suffix('i') {
            stems.push((format!("{y}y"), before_er));
        } else if !before_er.ends_with('e') && !doubles_final_consonant(before_er) {
            stems.push((before_er.to_string(), before_er));
        }
        stems.into_iter().any(|(stem, root)| {
            stem.len() >= MIN_PART
                && (lemmas().contains(stem.as_str()) || self.user_word(&stem))
                && !english().check(&format!("{root}or"))
        })
    }

    /// Two known words run together, each at least [`MIN_PART`] letters (or a
    /// 3-letter programming term: `urlpath`). Proper nouns don't count.
    fn compound(&self, lower: &str) -> bool {
        if lower.len() < 6 || !lower.bytes().all(|c| c.is_ascii_lowercase()) || NOT_COMPOUNDS.contains(&lower) {
            return false;
        }
        let part = |p: &str| {
            (p.len() >= 3 && self.user_word(p)) || (p.len() >= MIN_PART && (english().check(p) || self.agent_noun(p)))
        };
        (3..=lower.len() - 3).any(|i| part(&lower[..i]) && part(&lower[i..])) && !near_word(lower)
    }

    /// Replacements for `word`, best first, in the word's case style.
    pub fn suggest(&self, word: &str, limit: usize) -> Vec<String> {
        let mut out = Vec::new();
        english().suggest(word, &mut out);
        if out.is_empty() && word.chars().next().is_some_and(char::is_uppercase) {
            english().suggest(&word.to_lowercase(), &mut out);
            out = out.into_iter().map(|s| capitalize(&s)).collect();
        }
        let mut seen = HashSet::new();
        out.retain(|s| s != word && seen.insert(s.clone()));
        out.truncate(limit);
        out
    }

    /// Misspelt words of `regions` (document order) in `text`; `None` when
    /// `cancelled` fires.
    pub fn check(&self, text: &str, regions: &[Region], cancelled: &dyn Fn() -> bool) -> Option<Vec<Typo>> {
        let mut spans = Vec::new();
        let mut verdicts: HashMap<(&str, bool), bool> = HashMap::new();
        let mut bad: Vec<(WordSpan, RegionKind)> = Vec::new();
        for (i, r) in regions.iter().enumerate() {
            if i % 64 == 0 && cancelled() {
                return None;
            }
            spans.clear();
            words(text, r.start, r.end, r.kind, &mut spans);
            let name = r.kind == RegionKind::Name;
            for w in &spans {
                let word = &text[w.start..w.end];
                let ok = *verdicts
                    .entry((word, name))
                    .or_insert_with(|| if name { self.is_correct_identifier(word) } else { self.is_correct(word) });
                if !ok {
                    bad.push((*w, r.kind));
                }
            }
            if bad.len() >= MAX_TYPOS {
                bad.truncate(MAX_TYPOS);
                break;
            }
        }
        bad.sort_by_key(|(w, _)| w.start);
        bad.dedup_by_key(|(w, _)| *w);
        let mut index = Utf16Walker::new(text);
        Some(
            bad.into_iter()
                .map(|(w, kind)| Typo {
                    range: Range::new(index.pos(w.start), index.pos(w.end)),
                    word: text[w.start..w.end].to_string(),
                    context: kind.into(),
                })
                .collect(),
        )
    }
}

fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    chars.next().into_iter().flat_map(char::to_uppercase).chain(chars).collect()
}

/// Regions of a plain-text / Markdown document: everything but fenced code
/// blocks and inline code spans.
pub fn prose_regions(text: &str) -> Vec<Region> {
    let mut out = Vec::new();
    let mut fence: Option<&str> = None;
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        let start = offset;
        offset += line.len();
        let trimmed = line.trim_start();
        let marker = ["```", "~~~"].into_iter().find(|m| trimmed.starts_with(m));
        match (fence, marker) {
            (Some(open), Some(m)) if m == open => {
                fence = None;
                continue;
            }
            (Some(_), _) => continue,
            (None, Some(m)) => {
                fence = Some(m);
                continue;
            }
            (None, None) => {}
        }
        // Text between backtick pairs is code.
        let mut in_code = false;
        let mut seg = start;
        for (i, c) in line.char_indices() {
            if c == '`' {
                if !in_code && seg < start + i {
                    out.push(Region { start: seg, end: start + i, kind: RegionKind::Prose });
                }
                in_code = !in_code;
                seg = start + i + 1;
            }
        }
        if !in_code && seg < offset {
            out.push(Region { start: seg, end: offset, kind: RegionKind::Prose });
        }
    }
    out
}

/// Byte offset → line / UTF-16 column, for increasing offsets.
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

#[cfg(test)]
mod tests {
    use super::*;

    fn whole(text: &str, kind: RegionKind) -> Vec<Region> {
        vec![Region { start: 0, end: text.len(), kind }]
    }

    #[test]
    fn flags_misspellings_only() {
        let s = Speller::default();
        let text = "// Recieve the mesage from the server's backend";
        let typos = s.check(text, &whole(text, RegionKind::Comment), &|| false).unwrap();
        let words: Vec<_> = typos.iter().map(|t| t.word.as_str()).collect();
        assert_eq!(words, ["Recieve", "mesage"]);
        assert_eq!(typos[0].range, Range::new(Pos::new(0, 3), Pos::new(0, 10)));
    }

    #[test]
    fn identifiers_forgive_case_and_terms() {
        let s = Speller::default();
        for ok in ["url", "Paris", "json", "parser", "println"] {
            assert!(s.is_correct(ok), "{ok}");
        }
        assert!(!s.is_correct("lenght"));
    }

    #[test]
    fn agent_nouns_of_known_words() {
        let s = Speller::default();
        for ok in ["checkpointer", "Checkpointers", "serializer", "queriers", "tokenizer", "serializers", "pointer"] {
            assert!(s.is_correct(ok), "{ok}");
        }
        // Real misspellings of the same shape stay flagged.
        for bad in ["programer", "processer", "generater", "writter", "mesager", "begginer"] {
            assert!(!s.is_correct(bad), "{bad}");
        }
    }

    #[test]
    fn compounds_only_in_identifiers() {
        let s = Speller::default();
        for ok in ["filepath", "dataframe", "username", "codebase", "pathname", "urlpath", "timestampfile"] {
            assert!(s.is_correct_identifier(ok), "{ok}");
        }
        assert!(!s.is_correct("dataframe"));
        for bad in ["eachother", "everytime", "publically", "mesage", "lenght", "recieve", "comming", "withold"] {
            assert!(!s.is_correct_identifier(bad), "{bad}");
        }
    }

    /// Common English misspellings must survive the derivation and compound rules.
    #[test]
    fn common_misspellings_stay_flagged() {
        let s = Speller::default();
        let typos = [
            "accomodate",
            "acheive",
            "accross",
            "adress",
            "arguement",
            "becuase",
            "beleive",
            "begining",
            "calender",
            "comming",
            "commited",
            "concious",
            "definately",
            "dependancy",
            "enviroment",
            "existance",
            "explaination",
            "fucntion",
            "funtion",
            "goverment",
            "heigth",
            "independant",
            "intial",
            "lenght",
            "maintainance",
            "mesage",
            "neccessary",
            "occured",
            "occurence",
            "paramter",
            "persistant",
            "posession",
            "programer",
            "recieve",
            "refrence",
            "relevent",
            "retreive",
            "seperate",
            "seperator",
            "succesful",
            "tommorow",
            "truely",
            "untill",
            "wich",
            "widht",
            "wierd",
            "writting",
        ];
        let accepted: Vec<_> = typos
            .iter()
            .filter(|t| s.is_correct(t) || s.is_correct_identifier(t))
            .filter(|t| **t != "calender")
            .collect();
        assert!(accepted.is_empty(), "accepted: {accepted:?}");
    }

    #[test]
    fn issue_42_python_example() {
        let s = Speller::default();
        let text = "# Initialize the checkpointer connection pool.\ncheckpointer_pool = None\nmemory_checkpointer = None\nmesage = 'hello'\n";
        let regions = vec![
            Region { start: 0, end: 46, kind: RegionKind::Comment },
            Region { start: 47, end: 64, kind: RegionKind::Name },
            Region { start: 72, end: 91, kind: RegionKind::Name },
            Region { start: 99, end: 105, kind: RegionKind::Name },
        ];
        assert_eq!(&text[99..105], "mesage");
        let typos = s.check(text, &regions, &|| false).unwrap();
        let found: Vec<_> = typos.iter().map(|t| (t.word.as_str(), t.context)).collect();
        assert_eq!(found, [("mesage", TypoContext::Code)]);
    }

    #[test]
    fn scope_filters_region_kinds() {
        let comments_only = SpellScope { code: false, literals: false, comments: true };
        assert!(comments_only.includes(RegionKind::Comment));
        assert!(comments_only.includes(RegionKind::Prose));
        assert!(!comments_only.includes(RegionKind::Name));
        assert!(!comments_only.includes(RegionKind::String));
        let parsed: SpellScope = serde_json::from_str(r#"{"literals":false}"#).unwrap();
        assert_eq!(parsed, SpellScope { code: true, literals: false, comments: true });
    }

    #[test]
    fn accepted_words_and_custom_dictionaries() {
        let dir = std::env::temp_dir().join(format!("ide-spell-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dic = dir.join("team.dic");
        std::fs::write(&dic, "2\nfrobnicate/S\nQuuxify\n").unwrap();
        let s = Speller::new(["Openidea"], std::slice::from_ref(&dic));
        assert!(s.is_correct("openidea"));
        assert!(s.is_correct("frobnicate"));
        assert!(s.is_correct("quuxify"));
        assert!(!s.is_correct("zorblax"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn utf16_ranges() {
        let s = Speller::default();
        let text = "// 中文 é\n// wrng";
        let typos = s.check(text, &whole(text, RegionKind::Comment), &|| false).unwrap();
        assert_eq!(typos.len(), 1);
        assert_eq!(typos[0].range, Range::new(Pos::new(1, 3), Pos::new(1, 7)));
    }

    #[test]
    fn suggestions() {
        let s = Speller::default();
        let out = s.suggest("mesage", 5);
        assert!(out.iter().any(|w| w == "message"), "{out:?}");
        assert!(s.suggest("Recieve", 5).iter().any(|w| w == "Receive"));
    }

    #[test]
    fn markdown_skips_code() {
        let text = "Some prose `codez` here\n```\nfn wrng() {}\n```\nmore\n";
        let regions = prose_regions(text);
        let spans: Vec<_> = regions.iter().map(|r| &text[r.start..r.end]).collect();
        assert_eq!(spans, ["Some prose ", " here\n", "more\n"]);
    }

    #[test]
    fn cancellation() {
        let s = Speller::default();
        assert!(s.check("x", &whole("x", RegionKind::Comment), &|| true).is_none());
    }
}
