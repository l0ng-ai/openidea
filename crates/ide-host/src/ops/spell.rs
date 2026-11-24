//! Proofreading › Typo: spell checking of open documents.
use crate::Host;
use crate::Project;
use ide_command::command;

use super::blocking;
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
        let entry = dictionary.trim();
        if entry.is_empty()
            || !project.settings.read_effective(|s| s.spelling.custom_dictionaries.iter().any(|p| p.trim() == entry))
        {
            return Err(IdeError::invalid("Select a configured custom dictionary"));
        }
        let w = word.trim();
        // One word per line: no whitespace, no line breaks; digits and hyphens
        // may appear, but at least one letter (a number list checks nothing).
        if w.starts_with('#')
            || w.contains('/')
            || w.chars().any(|c| c.is_whitespace() || c.is_control())
            || !w.chars().any(|c| c.is_alphabetic())
        {
            return Err(IdeError::invalid(format!("'{word}' is not a word a dictionary can list")));
        }
        let path = resolve_dictionary(entry, &project.root);
        // Serialize the read/modify/write across projects that share a dictionary.
        static SAVES: parking_lot::Mutex<()> = parking_lot::Mutex::new(());
        let _save = SAVES.lock();
        let mut text = match std::fs::metadata(&path) {
            Ok(m) if !m.is_file() || m.permissions().readonly() => {
                return Err(IdeError::invalid(format!("{} is not a writable dictionary file", path.display())));
            }
            Ok(_) => std::fs::read_to_string(&path)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(e.into()),
        };
        let hunspell = ide_spell::affix_file(&path).is_some();
        let already_listed = if hunspell {
            text.lines().any(|line| line.trim() == w)
        } else {
            ide_spell::parse_word_list(&text).contains(&w.to_lowercase())
        };
        if already_listed {
            return Ok(String::new());
        }
        let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
        if hunspell {
            let body = text.strip_prefix('\u{feff}').unwrap_or(&text);
            let start = text.len() - body.len()
                + body
                    .split_inclusive('\n')
                    .take_while(|line| line.trim_start().starts_with('#'))
                    .map(str::len)
                    .sum::<usize>();
            let header = text[start..].lines().next().unwrap_or_default();
            if let Some(count) = header.trim().parse::<usize>().ok().and_then(|n| n.checked_add(1)) {
                text.replace_range(start..start + header.len(), &count.to_string());
            } else if text.is_empty() {
                text.push_str("1\n");
            }
        }
        if !text.is_empty() && !text.ends_with('\n') {
            text.push_str(newline);
        }
        text.push_str(w);
        text.push_str(newline);
        // A dictionary file may name folders that do not exist yet (a fresh
        // project layout): create them, then write.
        if let Some(dir) = path.parent()
            && !dir.is_dir()
        {
            std::fs::create_dir_all(dir)?;
        }
        ide_vfs::write_atomic_strict(&path, text.as_bytes())?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
}

ide_command::domain!(spell: spell_check, spell_suggest, spell_save_to_dictionary);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_home_dictionaries() {
        if let Some(home) = dirs::home_dir() {
            assert_eq!(
                resolve_dictionary("~/words/personal.txt", Path::new("project")),
                home.join("words/personal.txt")
            );
        }
    }
}
