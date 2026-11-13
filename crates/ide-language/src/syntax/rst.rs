//! reStructuredText section titles for the outline. No bundled grammar nests
//! sections (tree-sitter-rst emits them flat), so levels follow docutils: each
//! adornment style (character, with or without overline) takes the next level
//! the first time it appears.

use super::lines::LineIndex;
use ide_core::{OutlineItem, SymbolKind};

struct Line<'a> {
    start: usize,
    text: &'a str,
}

struct Heading {
    level: usize,
    start: usize,
    end: usize,
    name_start: usize,
    name_end: usize,
}

pub(crate) fn outline(text: &str) -> Vec<OutlineItem> {
    let lines: Vec<Line> = text
        .split_inclusive('\n')
        .scan(0, |at, raw| {
            let start = *at;
            *at += raw.len();
            Some(Line { start, text: raw.trim_end_matches(['\n', '\r']) })
        })
        .collect();
    let mut heads = headings(&lines);
    for k in 0..heads.len() {
        let end = heads[k + 1..].iter().find(|h| h.level <= heads[k].level).map_or(text.len(), |h| h.start);
        heads[k].end = heads[k].start + text[heads[k].start..end].trim_end().len();
    }
    let index = LineIndex::new(text);
    let mut i = 0;
    nest(&heads, &mut i, None, text, &index)
}

fn headings(lines: &[Line]) -> Vec<Heading> {
    let mut styles: Vec<(char, bool)> = Vec::new();
    let mut out = Vec::new();
    let mut push = |style: (char, bool), start: usize, title: &Line| {
        let level = styles.iter().position(|&s| s == style).unwrap_or_else(|| {
            styles.push(style);
            styles.len() - 1
        });
        let name = title.text.trim();
        let name_start = title.start + (title.text.len() - title.text.trim_start().len());
        out.push(Heading { level, start, end: 0, name_start, name_end: name_start + name.len() });
    };
    // A title starts a new block: it follows a blank line, the start, or another title.
    let mut at_block_start = true;
    let mut i = 0;
    while i < lines.len() {
        let line = &lines[i];
        if line.text.trim().is_empty() {
            at_block_start = true;
            i += 1;
            continue;
        }
        if at_block_start {
            if let Some(over) = adornment(line.text) {
                if let [title, under, ..] = &lines[i + 1..]
                    && !title.text.trim().is_empty()
                    && adornment(title.text).is_none()
                    && adornment(under.text) == Some(over)
                    && fits(title.text.trim_end(), over.1)
                {
                    push((over.0, true), line.start, title);
                    i += 3;
                    continue;
                }
            } else if !line.text.starts_with([' ', '\t'])
                && !starts_body_element(line.text)
                && let Some(under) = lines.get(i + 1).and_then(|l| adornment(l.text))
                && fits(line.text.trim_end(), under.1)
            {
                push((under.0, false), line.start, line);
                i += 2;
                continue;
            }
        }
        // Indented lines (literal blocks after `::`, directive bodies, quotes)
        // never hold titles: they are skipped here because adornments and
        // underlined titles must start in column 0.
        at_block_start = false;
        i += 1;
    }
    out
}

/// `(character, length)` of a line made of one repeated ASCII punctuation character.
fn adornment(line: &str) -> Option<(char, usize)> {
    let line = line.trim_end();
    let c = line.chars().next().filter(char::is_ascii_punctuation)?;
    line.chars().all(|x| x == c).then_some((c, line.len()))
}

/// docutils accepts a short adornment (with a warning) unless it is shorter
/// than 4 characters, which reads as ordinary text instead.
// ponytail: counts chars, not display columns; wide CJK titles get a looser check.
fn fits(title: &str, adornment_len: usize) -> bool {
    adornment_len >= title.chars().count() || adornment_len >= 4
}

/// Lines docutils parses as another body element before trying a title:
/// explicit markup (`..`, `__`), bullets, field lists, doctests, line blocks.
fn starts_body_element(line: &str) -> bool {
    let marker = |m: &str| line == m || line.strip_prefix(m).is_some_and(|r| r.starts_with(' '));
    ["..", "__", "-", "*", "+", "•", ">>>", "|"].into_iter().any(marker)
        || (line.starts_with(':') && line[1..].find(':').is_some_and(|k| k > 0 && marker(&line[..k + 2])))
}

fn nest(heads: &[Heading], i: &mut usize, parent: Option<usize>, text: &str, index: &LineIndex) -> Vec<OutlineItem> {
    let mut items = Vec::new();
    while let Some(h) = heads.get(*i).filter(|h| parent.is_none_or(|p| h.level > p)) {
        *i += 1;
        items.push(OutlineItem {
            name: text[h.name_start..h.name_end].to_owned(),
            detail: None,
            kind: SymbolKind::Key,
            range: index.range(h.start, h.end),
            selection_range: index.range(h.name_start, h.name_end),
            children: nest(heads, i, Some(h.level), text, index),
            visibility: None,
        });
    }
    items
}
