//! Test fixture for the ide-plugin sandbox. Never shipped.

// `plugin` with syntax and editor providers.
wit_bindgen::generate!({
    inline: "
        package fixture:misbehave;
        world misbehave {
            include openidea:plugin/plugin-syntax@1.0.0;
            export openidea:plugin/providers@1.0.0;
        }
    ",
    path: "../../../../../wit",
    world: "fixture:misbehave/misbehave",
    generate_all,
});

use exports::openidea::plugin::providers::{self, CodeAction, CompletionItem, Document, InlineSuggestion, LineMarker};
use exports::openidea::plugin::syntax_provider::{self, Fold, Symbol, Token};
use exports::openidea::plugin::{commands, event_handler, lifecycle};
use openidea::plugin::{invocation::Invocation, types};

struct Misbehave;

fn failed(message: &str) -> types::Error {
    types::Error::Failed(message.into())
}

impl lifecycle::Guest for Misbehave {
    fn activate(ctx: types::Context) -> Result<(), types::Error> {
        // A deliberately broken build (rollback tests): `version = "…-broken"`.
        if ctx.plugin_version.ends_with("-broken") {
            return Err(failed("this build is broken"));
        }
        Ok(())
    }

    fn deactivate() {}
}

impl commands::Guest for Misbehave {
    fn run(id: String, ctx: &Invocation, arg: Option<String>) -> Result<Option<String>, types::Error> {
        match id.as_str() {
            "echo" => Ok(arg),
            "panic" => panic!("boom"),
            "spin" => {
                let mut x: u64 = 0;
                loop {
                    x = std::hint::black_box(x.wrapping_add(1));
                }
            }
            "alloc" => {
                let mut chunks: Vec<Vec<u8>> = Vec::new();
                loop {
                    chunks.push(vec![1u8; 16 << 20]);
                    std::hint::black_box(&chunks);
                }
            }
            "read" => {
                let project = ctx.project().ok_or_else(|| failed("no project is open"))?;
                project.read_file(&arg.unwrap_or_default()).map(Some)
            }
            "root" => ctx.project().map(|p| p.root()).transpose(),
            // `editor.write` is not granted: an error, not a trap.
            "insert" => {
                let editor = ctx.editor().ok_or_else(|| failed("no editor"))?;
                editor.apply_edits(0, &[]).map(|_| None)
            }
            // The user gave up: not the plugin failing.
            "cancel" => Err(types::Error::Cancelled),
            other => Err(types::Error::NotFound(format!("command {other}"))),
        }
    }
}

impl event_handler::Guest for Misbehave {
    fn handle(_events: Vec<openidea::plugin::events::Event>, _ctx: &Invocation) {}
}

/// Edit-path budgets: the text says how to behave. `sleep:<ms>` busy-waits
/// that long, `spin` never returns, `panic` traps.
fn behave(text: &str) {
    if let Some(ms) = text.strip_prefix("sleep:").and_then(|n| n.trim().parse::<u64>().ok()) {
        let until = std::time::Instant::now() + std::time::Duration::from_millis(ms);
        while std::time::Instant::now() < until {
            std::hint::black_box(0);
        }
    } else if text == "spin" {
        loop {
            std::hint::black_box(0);
        }
    } else if text == "panic" {
        panic!("boom");
    }
}

/// One keyword token over the whole text, after [`behave`].
impl syntax_provider::Guest for Misbehave {
    fn highlights(_language: String, text: String) -> Vec<Token> {
        behave(&text);
        vec![Token { start: 0, end: text.len() as u32, kind: "keyword".into() }]
    }

    fn outline(_language: String, _text: String) -> Vec<Symbol> {
        Vec::new()
    }

    fn folding(_language: String, _text: String) -> Vec<Fold> {
        Vec::new()
    }
}

/// Completion: one item, labelled with the document's path, after [`behave`].
impl providers::Guest for Misbehave {
    fn completion(doc: Document, _at: types::Position, _trigger: Option<String>) -> Vec<CompletionItem> {
        behave(&doc.text);
        vec![CompletionItem {
            label: doc.path.clone(),
            detail: None,
            kind: Some("keyword".into()),
            insert_text: doc.path,
            replace: None,
            sort_text: None,
            documentation: None,
        }]
    }

    fn inline_completion(_doc: Document, _at: types::Position) -> Option<InlineSuggestion> {
        None
    }

    fn code_actions(_doc: Document, _selection: types::Range) -> Vec<CodeAction> {
        Vec::new()
    }

    fn definition(_doc: Document, _at: types::Position) -> Vec<types::Location> {
        Vec::new()
    }

    fn line_markers(_doc: Document) -> Vec<LineMarker> {
        Vec::new()
    }
}

export!(Misbehave);
