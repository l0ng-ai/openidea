//! Proofreading › Typo: spell checking of open documents.
use crate::Host;
use crate::Project;
use ide_command::command;

use super::doc::blocking;
use ide_core::settings::SpellingSettings;
use ide_core::{DocId, IdeError, IdeResult, RequestId};
use ide_language::SpellingKind;
use ide_spell::{Region, RegionKind, SpellScope, Speller, Typo};
use std::path::{Path, PathBuf};

/// Languages checked as prose (all text but code spans).
const PROSE: &[&str] = &["plaintext", "markdown", "restructuredtext", "asciidoc", "latex"];

/// Custom dictionary paths: `~/…` from home, relative ones from the project root.
fn dictionary_paths(settings: &SpellingSettings, root: &Path) -> Vec<PathBuf> {
    settings
        .custom_dictionaries
        .iter()
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .map(|p| resolve_dictionary(p, root))
        .collect()
}

/// One `spelling.customDictionaries` entry resolved: `~/…` from home, relative from the project root.
fn resolve_dictionary(text: &str, root: &Path) -> PathBuf {
    match text.strip_prefix("~/") {
        Some(rest) => dirs::home_dir().unwrap_or_default().join(rest),
        None => root.join(text),
    }
}

fn speller(project: &Project) -> Speller {
    let s = project.settings.effective().spelling;
    let words = s.ide_words.iter().chain(&s.project_words);
    Speller::new(words, &dictionary_paths(&s, &project.root))
}

/// Misspelt words in the comments, string literals and declared names of
/// `doc` that `scope` includes (all of its text for prose). Cancel with
/// `cancel_request(request)`.
#[command(trust = always)]
pub async fn spell_check(
    host: &Host,
    window: &str,
    doc: DocId,
    scope: SpellScope,
    request: RequestId,
) -> IdeResult<Vec<Typo>> {
    let project = host.project(window)?;
    let syntax = host.syntax();
    let cancel = host.begin_request(request);
    let result = blocking(move || {
        let path = project.documents.snapshot(doc)?.path.0.clone();
        let snap = project.documents.text_snapshot(doc)?;
        if snap.large {
            return Ok((path, Vec::new()));
        }
        let regions = if PROSE.contains(&snap.language.as_str()) {
            ide_spell::prose_regions(&snap.text)
        } else {
            let Some(found) = syntax.spelling_regions(&snap.language, &snap.text) else {
                return Ok((path, Vec::new()));
            };
            found
                .into_iter()
                .map(|r| Region {
                    start: r.start,
                    end: r.end,
                    kind: match r.kind {
                        SpellingKind::Comment => RegionKind::Comment,
                        SpellingKind::String if r.raw => RegionKind::RawString,
                        SpellingKind::String => RegionKind::String,
                        SpellingKind::Name => RegionKind::Name,
                    },
                })
                .filter(|r| scope.includes(r.kind))
                .collect()
        };
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        let typos =
            speller(&project).check(&snap.text, &regions, &|| cancel.is_cancelled()).ok_or_else(IdeError::cancelled)?;
        Ok((path, typos))
    })
    .await;
    host.end_request(request);
    // Record the typos in the host's diagnostics snapshot so line-end annotations
    // see them without waiting for a UI report; the editor still draws from its
    // own call above, unchanged.
    if let Ok((path, typos)) = &result {
        let items: Vec<ide_core::Diagnostic> = typos
            .iter()
            .map(|t| ide_core::Diagnostic {
                range: t.range,
                severity: ide_core::Severity::Info,
                message: format!("Typo: In word '{}'", t.word),
                source: Some("Spelling".into()),
                code: None,
                unnecessary: false,
                deprecated: false,
                server: None,
            })
            .collect();
        host.diagnostics.replace(path, "Spelling", items);
    }
    result.map(|(_, typos)| typos)
}

/// Replacements for a misspelt `word`, best first (Typo › Change to…).
#[command(trust = always)]
pub async fn spell_suggest(host: &Host, window: &str, word: String) -> IdeResult<Vec<String>> {
    let project = host.project(window).ok();
    blocking(move || {
        let speller = project.as_deref().map(speller).unwrap_or_default();
        Ok(speller.suggest(&word, 8))
    })
    .await
}

/// Appends `word` to the custom dictionary `dictionary` (a
/// `spelling.customDictionaries` entry: `~/…` from home, relative from the
/// project root) and reports which file was written, creating it when missing.
/// A Hunspell `.dic` with a `.aff` beside it keeps its word count line current;
/// the speller picks the change up through its own mtime cache.
#[command(trust = always)]
pub async fn spell_save_to_dictionary(
    host: &Host,
    window: &str,
    dictionary: String,
    word: String,
) -> IdeResult<String> {
    let project = host.project(window)?;
    blocking(move || {
        let root = project.root.clone();
        let entry = dictionary.trim();
        if entry.is_empty() {
            return Err(IdeError::invalid("No custom dictionary selected"));
        }
        let w = word.trim();
        // One word per line: no whitespace, no line breaks; digits and hyphens
        // may appear, but at least one letter (a number list checks nothing).
        if w.is_empty() || w.chars().any(|c| c.is_whitespace()) || !w.chars().any(|c| c.is_alphabetic()) {
            return Err(IdeError::invalid(format!("'{word}' is not a word a dictionary can list")));
        }
        let path = resolve_dictionary(entry, &root);
        let existing = std::fs::read(&path).ok();
        if let Some(bytes) = &existing {
            let text = String::from_utf8_lossy(bytes);
            if text.lines().any(|l| l.trim() == w) {
                return Ok(String::new());
            }
        }
        let aff = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("dic"))
            && ["aff", "AFF"].into_iter().any(|ext| path.with_extension(ext).is_file());
        let updated = match existing.as_deref().map(String::from_utf8_lossy) {
            None => format!("{w}\n"),
            Some(text) if aff && text.starts_with(|c: char| c.is_ascii_digit()) => {
                // A Hunspell dictionary: its first line counts the words.
                let (count, rest) = text.split_once('\n').unwrap_or((text.trim(), ""));
                match count.trim().parse::<usize>() {
                    Ok(n) => format!("{}\n{rest}{w}\n", n + 1),
                    Err(_) => format!("{w}\n{text}"),
                }
            }
            Some(text) if !text.is_empty() && !text.ends_with('\n') => format!("{text}\n{w}\n"),
            Some(text) => format!("{text}{w}\n"),
        };
        // A dictionary file may name folders that do not exist yet (a fresh
        // project layout): create them, then write.
        if let Some(dir) = path.parent()
            && !dir.is_dir()
        {
            std::fs::create_dir_all(dir)?;
        }
        ide_vfs::write_atomic_strict(&path, updated.as_bytes())?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
}

ide_command::domain!(spell: spell_check, spell_suggest, spell_save_to_dictionary);
