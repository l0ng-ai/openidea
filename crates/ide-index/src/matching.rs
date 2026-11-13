//! IDEA-like fuzzy ranking over the in-memory index.
//!
//! Two phases: a parallel scan computes a cheap score for every candidate
//! (bit-mask pre-filter, nucleo score, exact/prefix boosts) and keeps the best
//! few; the survivors then get match indices, CamelHump and recency boosts and
//! are re-sorted.
//!
//! The scan streams the compact tables in `data` (`HotFiles`/`HotDirs`/`SymTable`):
//! only the hot fields per candidate and strings from contiguous arenas, with the
//! thread-local matcher and one UTF-32 buffer per scan rather than per candidate.

use crate::data::{DirRow, FileEntry, FileRow, IndexData, SymTable, char_mask};
use crate::{FileMatch, SymbolFilter, SymbolMatch};
use ide_core::SymbolKind;
use nucleo_matcher::{Config, Matcher, Utf32Str, Utf32String};
use rayon::prelude::*;
use std::cell::RefCell;
use std::cmp::Ordering;
use std::path::{Path, PathBuf};

const TIER_NAME: u32 = 1 << 20;
const EXACT: u32 = 4000;
const EXACT_STEM: u32 = 3000;
const PREFIX: u32 = 600;
const CASE_EXACT: u32 = 200;
const HUMP: u32 = 12;
const FIRST_AT_START: u32 = 40;
const RECENT_MAX: u32 = 900;
const TYPE_LIKE: u32 = 20;

thread_local! {
    static MATCHER: RefCell<Matcher> = RefCell::new(Matcher::new(Config::DEFAULT.match_paths()));
}

fn with_matcher<R>(f: impl FnOnce(&mut Matcher) -> R) -> R {
    MATCHER.with(|m| f(&mut m.borrow_mut()))
}

struct Needle {
    /// Lower-cased query text.
    lower: String,
    original: String,
    utf32: Utf32String,
    mask: u64,
}

impl Needle {
    fn new(s: &str) -> Self {
        let lower = s.to_lowercase();
        Self { mask: char_mask(&lower), utf32: Utf32String::from(lower.as_str()), lower, original: s.to_owned() }
    }

    fn is_empty(&self) -> bool {
        self.lower.is_empty()
    }

    fn score(&self, m: &mut Matcher, hay: &str, buf: &mut Vec<char>) -> Option<u32> {
        m.fuzzy_match(Utf32Str::new(hay, buf), self.utf32.slice(..)).map(u32::from)
    }

    /// `hay` is pure ASCII: skip `Utf32Str::new`'s check and UTF-32 conversion.
    fn score_ascii(&self, m: &mut Matcher, hay: &str) -> Option<u32> {
        m.fuzzy_match(Utf32Str::Ascii(hay.as_bytes()), self.utf32.slice(..)).map(u32::from)
    }

    fn indices(&self, m: &mut Matcher, hay: &str, buf: &mut Vec<char>, out: &mut Vec<u32>) -> Option<u32> {
        out.clear();
        let s = m.fuzzy_indices(Utf32Str::new(hay, buf), self.utf32.slice(..), out).map(u32::from);
        out.sort_unstable();
        out.dedup();
        s
    }

    /// Exact / prefix boosts against a candidate name.
    fn name_boost(&self, name: &str) -> u32 {
        let (q, n) = (self.lower.as_bytes(), name.as_bytes());
        let mut b = 0;
        if n.eq_ignore_ascii_case(q) {
            b += EXACT;
        } else if let Some(dot) = name.find('.')
            && name.as_bytes()[..dot].eq_ignore_ascii_case(q)
        {
            b += EXACT_STEM;
        } else if n.len() >= q.len() && n[..q.len()].eq_ignore_ascii_case(q) {
            b += PREFIX;
        }
        if b > 0 && name.as_bytes().starts_with(self.original.as_bytes()) {
            b += CASE_EXACT;
        }
        b
    }
}

/// Word starts in `s` (char indices): start, after a separator, lower→Upper, letter→digit.
fn hump_bonus(s: &str, indices: &[u32]) -> u32 {
    if indices.is_empty() {
        return 0;
    }
    let chars: Vec<char> = s.chars().collect();
    let is_start = |i: usize| {
        if i == 0 {
            return true;
        }
        let (p, c) = (chars[i - 1], chars[i]);
        !p.is_alphanumeric() || (p.is_lowercase() && c.is_uppercase()) || (!p.is_ascii_digit() && c.is_ascii_digit())
    };
    let humps = indices.iter().filter(|&&i| (i as usize) < chars.len() && is_start(i as usize)).count() as u32;
    let first = if is_start(indices[0] as usize) { FIRST_AT_START } else { 0 };
    humps * HUMP + first
}

#[derive(Clone, Copy)]
struct Cand {
    slot: u32,
    sym: u32,
    score: u32,
    /// Candidate name/rel length: the first tie-break key, cached so ranking a pool
    /// does not chase it through the tables.
    len: u32,
}

fn keep_best(mut v: Vec<Cand>, k: usize, tiebreak: &impl Fn(&Cand, &Cand) -> Ordering) -> Vec<Cand> {
    if v.len() > k {
        v.select_nth_unstable_by(k, |a, b| b.score.cmp(&a.score).then_with(|| tiebreak(a, b)));
        v.truncate(k);
    }
    v
}

fn scan(
    data: &IndexData,
    pool: usize,
    tiebreak: &(impl Fn(&Cand, &Cand) -> Ordering + Sync),
    per_file: impl Fn(u32, &FileRow, &mut Matcher, &mut Vec<Cand>) + Sync,
) -> Vec<Cand> {
    scan_until(data, pool, tiebreak, &|| false, per_file).unwrap_or_default()
}

fn scan_until(
    data: &IndexData,
    pool: usize,
    tiebreak: &(impl Fn(&Cand, &Cand) -> Ordering + Sync),
    stopped: &(impl Fn() -> bool + Sync),
    per_file: impl Fn(u32, &FileRow, &mut Matcher, &mut Vec<Cand>) + Sync,
) -> Option<Vec<Cand>> {
    // One row per slot, so this is exactly the old scan over `files`: same item
    // order and count, and free slots are skipped exactly like `None` was, keeping
    // the pruning boundaries (and therefore the candidate pool) unchanged.
    data.hot
        .rows
        .par_iter()
        .enumerate()
        .with_min_len(256)
        .try_fold(Vec::new, |mut acc, (slot, row)| {
            if stopped() {
                return None;
            }
            if row.live {
                with_matcher(|m| per_file(slot as u32, row, m, &mut acc));
                if acc.len() >= pool * 2 {
                    acc = keep_best(acc, pool, tiebreak);
                }
            }
            Some(acc)
        })
        .try_reduce(Vec::new, |mut a, b| {
            a.extend(b);
            Some(if a.len() >= pool * 2 { keep_best(a, pool, tiebreak) } else { a })
        })
}

pub(crate) struct Recents<'a> {
    pub paths: &'a [PathBuf],
}

impl Recents<'_> {
    fn rank(&self, path: &std::path::Path) -> Option<usize> {
        self.paths.iter().position(|p| p == path)
    }

    fn bonus(&self, path: &std::path::Path) -> u32 {
        self.rank(path).map_or(0, |r| RECENT_MAX.saturating_sub(r as u32 * 12))
    }
}

/// `Foo.kt:12:3` -> `Foo.kt`; `\` -> `/`; strips leading `./` and `/`.
fn normalize_file_query(q: &str) -> String {
    let mut q = q.trim().replace('\\', "/");
    while let Some((head, tail)) = q.rsplit_once(':')
        && !tail.is_empty()
        && tail.bytes().all(|b| b.is_ascii_digit())
    {
        q = head.to_owned();
    }
    let q = q.trim_start_matches("./").trim_start_matches('/');
    q.chars().filter(|c| !c.is_whitespace()).collect()
}

enum FileQuery {
    Name(Needle),
    Path { dir: Needle, name: Needle },
}

pub(crate) fn find_files(data: &IndexData, recents: &Recents, query: &str, limit: usize) -> Vec<FileMatch> {
    if limit == 0 {
        return Vec::new();
    }
    let q = normalize_file_query(query);
    if q.is_empty() {
        return recents
            .paths
            .iter()
            .filter_map(|p| data.get(p))
            .take(limit)
            .enumerate()
            .map(|(i, e)| FileMatch {
                path: e.path.clone().into(),
                rel_path: e.rel.to_string(),
                score: (RECENT_MAX - i as u32).max(1),
                indices: Vec::new(),
            })
            .collect();
    }
    let fq = match q.rsplit_once('/') {
        Some((dir, name)) => FileQuery::Path { dir: Needle::new(dir), name: Needle::new(name) },
        None => FileQuery::Name(Needle::new(&q)),
    };
    let tiebreak = |a: &Cand, b: &Cand| a.len.cmp(&b.len).then_with(|| data.hot.rel(a.slot).cmp(data.hot.rel(b.slot)));
    let pool = limit * 4 + 64;
    let mut cands = scan(data, pool, &tiebreak, |slot, row, m, acc| {
        let mut buf = Vec::new();
        if let Some(score) = base_file_score(m, &fq, row, data.hot.text(), &mut buf) {
            acc.push(Cand { slot, sym: u32::MAX, score, len: row.rel.len });
        }
    });
    // Recent files always compete for the final ranking.
    with_matcher(|m| {
        let mut buf = Vec::new();
        for p in recents.paths {
            if data.get(p).is_none() {
                continue;
            }
            let Some(slot) = data.slot(p) else { continue };
            if cands.iter().any(|c| c.slot == slot) {
                continue;
            }
            let Some(row) = data.hot.row_of_slot(slot) else { continue };
            if let Some(score) = base_file_score(m, &fq, row, data.hot.text(), &mut buf) {
                cands.push(Cand { slot, sym: u32::MAX, score, len: row.rel.len });
            }
        }
    });
    let mut out: Vec<(u32, &FileEntry, Vec<u32>)> = with_matcher(|m| {
        let mut buf = Vec::new();
        cands
            .iter()
            .filter_map(|c| {
                let e = file(data, c.slot);
                let indices = file_indices(m, &fq, e, &mut buf)?;
                let display_bonus = match &fq {
                    FileQuery::Name(_) if c.score >= TIER_NAME => {
                        let name_idx: Vec<u32> = indices.iter().map(|i| i - e.name_start_chars).collect();
                        hump_bonus(e.name(), &name_idx)
                    }
                    _ => hump_bonus(&e.rel, &indices),
                };
                Some((c.score + display_bonus + recents.bonus(&e.path), e, indices))
            })
            .collect()
    });
    out.sort_by(|a, b| {
        b.0.cmp(&a.0).then_with(|| a.1.rel.len().cmp(&b.1.rel.len())).then_with(|| a.1.rel.cmp(&b.1.rel))
    });
    out.truncate(limit);
    out.into_iter()
        .map(|(score, e, indices)| FileMatch {
            path: e.path.clone().into(),
            rel_path: e.rel.to_string(),
            score,
            indices,
        })
        .collect()
}

/// Fuzzy folder search over the folders holding indexed files: folder-name matches beat
/// path matches; `/` in the query matches the whole path. `rel_path` ends in `/`.
pub(crate) fn find_dirs(data: &IndexData, query: &str, limit: usize) -> Vec<FileMatch> {
    let q = normalize_file_query(query);
    if limit == 0 || q.is_empty() {
        return Vec::new();
    }
    let by_path = q.contains('/');
    let needle = Needle::new(q.trim_end_matches('/'));
    let text = data.dirs_hot.text();
    // (score, rel without the trailing `/`, char offset of the name when it matched by name)
    let (mut best, _): (Vec<_>, Vec<char>) = data
        .dirs_hot
        .rows
        .par_iter()
        .fold(
            || (Vec::new(), Vec::new()),
            |(mut found, mut buf), row: &DirRow| {
                let rel = row.rel(text);
                let trimmed = &rel[..rel.len() - 1];
                let name = &trimmed[row.name_start as usize..];
                with_matcher(|m| {
                    let hit = if !by_path
                        && needle.mask & row.name_mask == needle.mask
                        && let Some(s) = needle.score(m, name, &mut buf)
                    {
                        Some((
                            TIER_NAME + s * 4 + needle.name_boost(name),
                            Some(trimmed[..row.name_start as usize].chars().count() as u32),
                        ))
                    } else if needle.mask & row.rel_mask != needle.mask {
                        None
                    } else {
                        needle.score(m, trimmed, &mut buf).map(|s| (s, None))
                    };
                    if let Some((s, at)) = hit {
                        found.push((s, rel, row.path.as_path(), at));
                    }
                });
                (found, buf)
            },
        )
        .reduce(
            || (Vec::new(), Vec::new()),
            |mut a, b| {
                a.0.extend(b.0);
                a
            },
        );
    let order = |a: &(u32, &str, &Path, Option<u32>), b: &(u32, &str, &Path, Option<u32>)| {
        b.0.cmp(&a.0).then_with(|| a.1.len().cmp(&b.1.len())).then_with(|| a.1.cmp(b.1))
    };
    if best.len() > limit {
        best.select_nth_unstable_by(limit, order);
        best.truncate(limit);
    }
    // Match indices and the CamelHump bonus `find_files` gives, so equal matches rank alike.
    let mut out: Vec<FileMatch> = with_matcher(|m| {
        let (mut buf, mut idx) = (Vec::new(), Vec::new());
        best.into_iter()
            .map(|(score, rel, path, name_at)| {
                let trimmed = &rel[..rel.len() - 1];
                let (bonus, indices) = match name_at {
                    Some(at) => {
                        let name = &trimmed[trimmed.rfind('/').map_or(0, |i| i + 1)..];
                        needle.indices(m, name, &mut buf, &mut idx);
                        (hump_bonus(name, &idx), idx.iter().map(|i| i + at).collect())
                    }
                    None => {
                        needle.indices(m, trimmed, &mut buf, &mut idx);
                        (hump_bonus(trimmed, &idx), idx.clone())
                    }
                };
                FileMatch { path: path.to_path_buf().into(), rel_path: rel.to_owned(), score: score + bonus, indices }
            })
            .collect()
    });
    out.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| a.rel_path.len().cmp(&b.rel_path.len()))
            .then_with(|| a.rel_path.cmp(&b.rel_path))
    });
    out
}

fn file(data: &IndexData, slot: u32) -> &FileEntry {
    data.files[slot as usize].as_ref().expect("candidate slots are live")
}

fn base_file_score(m: &mut Matcher, q: &FileQuery, row: &FileRow, text: &str, buf: &mut Vec<char>) -> Option<u32> {
    // Strings are sliced only once their mask passes, so a rejected row costs two masks.
    match q {
        FileQuery::Name(n) => {
            if n.mask & row.name_mask == n.mask {
                let name = row.name(text);
                let s = if row.ascii { n.score_ascii(m, name) } else { n.score(m, name, buf) };
                if let Some(s) = s {
                    return Some(TIER_NAME + s * 4 + n.name_boost(name));
                }
            }
            if n.mask & row.rel_mask == n.mask {
                let rel = row.rel(text);
                return if row.ascii { n.score_ascii(m, rel) } else { n.score(m, rel, buf) };
            }
            None
        }
        FileQuery::Path { dir, name: n } => {
            let name_score = if n.is_empty() {
                0
            } else {
                if n.mask & row.name_mask != n.mask {
                    return None;
                }
                let name = row.name(text);
                let s = if row.ascii { n.score_ascii(m, name) } else { n.score(m, name, buf) }?;
                s * 4 + n.name_boost(name)
            };
            if dir.mask & row.dir_mask != dir.mask {
                return None;
            }
            let dir_str = row.dir(text);
            let dir_score = if row.ascii { dir.score_ascii(m, dir_str) } else { dir.score(m, dir_str, buf) }?;
            Some(TIER_NAME + name_score + dir_score)
        }
    }
}

fn file_indices(m: &mut Matcher, q: &FileQuery, e: &FileEntry, buf: &mut Vec<char>) -> Option<Vec<u32>> {
    let mut idx = Vec::new();
    match q {
        FileQuery::Name(n) => {
            if n.indices(m, e.name(), buf, &mut idx).is_some() {
                return Some(idx.into_iter().map(|i| i + e.name_start_chars).collect());
            }
            n.indices(m, &e.rel, buf, &mut idx)?;
            Some(idx)
        }
        FileQuery::Path { dir, name } => {
            dir.indices(m, e.dir(), buf, &mut idx)?;
            let mut out = idx.clone();
            if !name.is_empty() {
                name.indices(m, e.name(), buf, &mut idx)?;
                out.extend(idx.iter().map(|i| i + e.name_start_chars));
            }
            Some(out)
        }
    }
}

fn symbol_score(
    m: &mut Matcher,
    name: &Needle,
    container: Option<&Needle>,
    syms: &SymTable,
    i: u32,
    buf: &mut Vec<char>,
) -> Option<u32> {
    let symbol = syms.name(i);
    let mut score = if name.is_empty() { 0 } else { name.score(m, symbol, buf)? * 4 };
    score += name.name_boost(symbol);
    if let Some(cq) = container {
        let c = syms.container(i)?;
        if cq.mask & char_mask(c) != cq.mask {
            return None;
        }
        score += cq.score(m, c, buf)? + cq.name_boost(c) / 4;
    }
    if syms.kind(i).is_type_like() {
        score += TYPE_LIKE;
    }
    Some(score)
}

/// `Foo.bar`, `Foo::bar`, `Foo#bar` -> (container `Foo`, name `bar`).
fn split_symbol_query(q: &str) -> (Option<&str>, &str) {
    for sep in ["::", "#", "."] {
        if let Some((c, n)) = q.rsplit_once(sep)
            && !c.is_empty()
        {
            return (Some(c.rsplit(['.', ':', '#']).next().unwrap_or(c)), n);
        }
    }
    (None, q)
}

pub(crate) fn find_symbols(
    data: &IndexData,
    recents: &Recents,
    query: &str,
    filter: SymbolFilter,
    limit: usize,
) -> Vec<SymbolMatch> {
    find_symbols_until(data, recents, query, filter, limit, &|_| true, &|| false).unwrap_or_default()
}

pub(crate) fn find_symbols_until(
    data: &IndexData,
    recents: &Recents,
    query: &str,
    filter: SymbolFilter,
    limit: usize,
    include: &(impl Fn(&Path) -> bool + Sync),
    stopped: &(impl Fn() -> bool + Sync),
) -> Option<Vec<SymbolMatch>> {
    let q: String = query.trim().chars().filter(|c| !c.is_whitespace()).collect();
    if q.is_empty() || limit == 0 {
        return Some(Vec::new());
    }
    let (container_q, name_q) = split_symbol_query(&q);
    let name = Needle::new(name_q);
    let container = container_q.map(Needle::new);
    let syms = &data.syms;
    let tiebreak = |a: &Cand, b: &Cand| a.len.cmp(&b.len).then_with(|| data.hot.rel(a.slot).cmp(data.hot.rel(b.slot)));
    let pool = limit * 4 + 64;
    let cands = scan_until(data, pool, &tiebreak, stopped, |slot, row, m, acc| {
        if row.sym_len == 0 {
            return;
        }
        let e = file(data, slot);
        if !include(&e.path) {
            return;
        }
        let mut buf = Vec::new();
        for (k, head) in syms.heads(row.sym_start, row.sym_len).iter().enumerate() {
            if stopped() {
                break;
            }
            if filter == SymbolFilter::Types && !syms.kind(row.sym_start + k as u32).is_type_like() {
                continue;
            }
            if name.mask & head.mask != name.mask {
                continue;
            }
            let i = row.sym_start + k as u32;
            if let Some(score) = symbol_score(m, &name, container.as_ref(), syms, i, &mut buf) {
                acc.push(Cand { slot, sym: i, score, len: head.name.len });
            }
        }
    })?;
    if stopped() {
        return None;
    }
    let mut out: Vec<(u32, Cand, Vec<u32>)> = with_matcher(|m| {
        let mut buf = Vec::new();
        cands
            .into_iter()
            .take_while(|_| !stopped())
            .filter_map(|c| {
                let symbol = syms.name(c.sym);
                let e = file(data, c.slot);
                let mut idx = Vec::new();
                if !name.is_empty() {
                    name.indices(m, symbol, &mut buf, &mut idx)?;
                }
                let bonus = hump_bonus(symbol, &idx) + recents.bonus(&e.path) / 4;
                Some((c.score + bonus, c, idx))
            })
            .collect()
    });
    out.sort_by(|a, b| {
        b.0.cmp(&a.0).then_with(|| tiebreak(&a.1, &b.1)).then_with(|| syms.range(a.1.sym).cmp(&syms.range(b.1.sym)))
    });
    out.truncate(limit);
    let results = out
        .into_iter()
        .map(|(score, c, indices)| {
            let e = file(data, c.slot);
            SymbolMatch {
                name: syms.name(c.sym).to_string(),
                kind: syms.kind(c.sym),
                container: syms.container(c.sym).map(str::to_owned),
                path: e.path.clone().into(),
                rel_path: e.rel.to_string(),
                range: syms.range(c.sym),
                score,
                indices,
            }
        })
        .collect();
    (!stopped()).then_some(results)
}

/// Symbols named exactly `name` (and of `kind`, when given), by path then position.
pub(crate) fn symbols_named(data: &IndexData, name: &str, kind: Option<SymbolKind>, limit: usize) -> Vec<SymbolMatch> {
    symbols_named_within(data, name, kind, &[], limit)
}

/// Symbols named exactly `name` (and of `kind`, when given) whose file is inside one of
/// `roots` (empty = every indexed file), by path then position. Filtering while walking
/// entries keeps symbols outside the roots from materialising or filling the cap.
pub(crate) fn symbols_named_within(
    data: &IndexData,
    name: &str,
    kind: Option<SymbolKind>,
    roots: &[PathBuf],
    limit: usize,
) -> Vec<SymbolMatch> {
    let mask = char_mask(name);
    let within = |e: &FileEntry| roots.is_empty() || roots.iter().any(|root| e.path.starts_with(root));
    let syms = &data.syms;
    let mut out: Vec<SymbolMatch> = data
        .files
        .iter()
        .flatten()
        .filter(|e| within(e))
        .flat_map(|e| {
            (e.sym_start..e.sym_start + e.sym_len)
                .filter(|&i| syms.mask(i) == mask && syms.name(i) == name && kind.is_none_or(|k| syms.kind(i) == k))
                .map(move |i| SymbolMatch {
                    name: syms.name(i).to_string(),
                    kind: syms.kind(i),
                    container: syms.container(i).map(str::to_owned),
                    path: e.path.clone().into(),
                    rel_path: e.rel.to_string(),
                    range: syms.range(i),
                    score: 0,
                    indices: Vec::new(),
                })
        })
        .collect();
    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path).then_with(|| a.range.cmp(&b.range)));
    out.truncate(limit);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_queries() {
        assert_eq!(normalize_file_query(" ./src\\main.rs:12:4 "), "src/main.rs");
        assert_eq!(normalize_file_query("/a b"), "ab");
        assert_eq!(split_symbol_query("Order.save"), (Some("Order"), "save"));
        assert_eq!(split_symbol_query("a::b::C::new"), (Some("C"), "new"));
        assert_eq!(split_symbol_query("save"), (None, "save"));
        assert_eq!(split_symbol_query(".save"), (None, ".save"));
    }

    #[test]
    fn humps() {
        assert!(hump_bonus("OrderController", &[0, 5, 6]) > hump_bonus("OrderController", &[0, 3, 6]));
        assert_eq!(hump_bonus("abc", &[]), 0);
    }
}
