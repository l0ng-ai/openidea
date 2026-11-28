//! Proofreading › Grammar: grammar checking of open documents and commit messages.
use crate::Host;
use crate::Project;
use ide_command::command;

use super::blocking;
use ide_core::{DocId, IdeError, IdeResult, RequestId};
use ide_grammar::{Block, BlockKind, GrammarProblem, GrammarRule, Options};
use ide_language::SpellingKind;

fn options(project: Option<&Project>) -> Options {
    let Some(project) = project else { return Options::default() };
    let s = project.settings.effective();
    Options {
        dialect: s.grammar.dialect.unwrap_or_default(),
        disabled_rules: s.grammar.disabled_rules,
        words: s.spelling.ide_words.into_iter().chain(s.spelling.project_words).collect(),
    }
}

/// Grammar problems in the comments and docstrings of `doc`, or in all of
/// its text for Markdown and plain text. Cancel with `cancel_request(request)`.
#[command(trust = always)]
pub async fn grammar_check(
    host: &Host,
    window: &str,
    doc: DocId,
    request: RequestId,
) -> IdeResult<Vec<GrammarProblem>> {
    let project = host.project(window)?;
    let syntax = host.syntax();
    let cancel = host.begin_request(request);
    let result = blocking(move || {
        let path = project.documents.snapshot(doc)?.path.0.clone();
        let snap = project.documents.text_snapshot(doc)?;
        if snap.large {
            return Ok((path, Vec::new()));
        }
        let whole = |kind| vec![Block { start: 0, end: snap.text.len(), kind }];
        let blocks = match snap.language.as_str() {
            "markdown" | "mdx" => whole(BlockKind::Markdown),
            "plaintext" => whole(BlockKind::Plain),
            _ => {
                let Some(found) = syntax.spelling_regions(&snap.language, &snap.text) else {
                    return Ok((path, Vec::new()));
                };
                found
                    .into_iter()
                    .filter_map(|r| {
                        let kind = match r.kind {
                            SpellingKind::Comment => BlockKind::Comment,
                            SpellingKind::String if r.doc => BlockKind::Docstring,
                            _ => return None,
                        };
                        Some(Block { start: r.start, end: r.end, kind })
                    })
                    .collect()
            }
        };
        let problems = ide_grammar::check(&snap.text, &blocks, &options(Some(&project)), &|| cancel.is_cancelled())
            .ok_or_else(IdeError::cancelled)?;
        Ok((path, problems))
    })
    .await;
    host.end_request(request);
    // Line-end annotations read the host's diagnostics snapshot, as for Typo.
    if let Ok((path, problems)) = &result {
        let items = problems
            .iter()
            .map(|p| ide_core::Diagnostic {
                range: p.range,
                severity: ide_core::Severity::Info,
                message: p.message.clone(),
                source: Some("Grammar".into()),
                code: Some(p.rule.clone()),
                unnecessary: false,
                deprecated: false,
                server: None,
            })
            .collect();
        host.diagnostics.replace(path, "Grammar", items);
    }
    result.map(|(_, problems)| problems)
}

/// Grammar problems in a plain text that is not a document (the commit
/// message). Cancel with `cancel_request(request)`.
#[command(trust = always)]
pub async fn grammar_check_text(
    host: &Host,
    window: &str,
    text: String,
    request: RequestId,
) -> IdeResult<Vec<GrammarProblem>> {
    let project = host.project(window).ok();
    let cancel = host.begin_request(request);
    let result = blocking(move || {
        let blocks = [Block { start: 0, end: text.len(), kind: BlockKind::Plain }];
        ide_grammar::check(&text, &blocks, &options(project.as_deref()), &|| cancel.is_cancelled())
            .ok_or_else(IdeError::cancelled)
    })
    .await;
    host.end_request(request);
    result
}

/// Every grammar rule, for the Grammar settings page.
#[command(trust = always)]
pub async fn grammar_rules() -> IdeResult<Vec<GrammarRule>> {
    blocking(|| Ok(ide_grammar::rules())).await
}

ide_command::domain!(grammar: grammar_check, grammar_check_text, grammar_rules);
