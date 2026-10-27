//! Proofreading › Typo: spell checking of open documents.

use super::doc::blocking;
use crate::state::{AppState, Project};
use ide_core::settings::SpellingSettings;
use ide_core::{DocId, IdeError, IdeResult, RequestId};
use ide_language::SpellingKind;
use ide_spell::{Region, RegionKind, SpellScope, Speller, Typo};
use std::path::{Path, PathBuf};
use tauri::{State, Window};

/// Languages checked as prose (all text but code spans).
const PROSE: &[&str] = &["plaintext", "markdown", "restructuredtext", "asciidoc", "latex"];

/// Custom dictionary paths: `~/…` from home, relative ones from the project root.
fn dictionary_paths(settings: &SpellingSettings, root: &Path) -> Vec<PathBuf> {
    settings
        .custom_dictionaries
        .iter()
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .map(|p| match p.strip_prefix("~/") {
            Some(rest) => dirs::home_dir().unwrap_or_default().join(rest),
            None => root.join(p),
        })
        .collect()
}

fn speller(project: &Project) -> Speller {
    let s = project.settings.effective().spelling;
    let words = s.ide_words.iter().chain(&s.project_words);
    Speller::new(words, &dictionary_paths(&s, &project.root))
}

/// Misspelt words in the comments, string literals and declared names of
/// `doc` that `scope` includes (all of its text for prose). Cancel with
/// `cancel_request(request)`.
#[tauri::command]
#[specta::specta]
pub async fn spell_check(
    window: Window,
    state: State<'_, AppState>,
    doc: DocId,
    scope: SpellScope,
    request: RequestId,
) -> IdeResult<Vec<Typo>> {
    let project = state.project(window.label())?;
    let syntax = state.syntax();
    let cancel = state.begin_request(request);
    let result = blocking(move || {
        let snap = project.documents.text_snapshot(doc)?;
        if snap.large {
            return Ok(Vec::new());
        }
        let regions = if PROSE.contains(&snap.language.as_str()) {
            ide_spell::prose_regions(&snap.text)
        } else {
            let Some(found) = syntax.spelling_regions(&snap.language, &snap.text) else { return Ok(Vec::new()) };
            found
                .into_iter()
                .map(|r| Region {
                    start: r.start,
                    end: r.end,
                    kind: match r.kind {
                        SpellingKind::Comment => RegionKind::Comment,
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
        speller(&project).check(&snap.text, &regions, &|| cancel.is_cancelled()).ok_or_else(IdeError::cancelled)
    })
    .await;
    state.end_request(request);
    result
}

/// Replacements for a misspelt `word`, best first (Typo › Change to…).
#[tauri::command]
#[specta::specta]
pub async fn spell_suggest(window: Window, state: State<'_, AppState>, word: String) -> IdeResult<Vec<String>> {
    let project = state.project(window.label()).ok();
    blocking(move || {
        let speller = project.as_deref().map(speller).unwrap_or_default();
        Ok(speller.suggest(&word, 8))
    })
    .await
}
