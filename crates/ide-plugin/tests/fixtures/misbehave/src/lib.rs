//! Test fixture for the ide-plugin sandbox. Never shipped.

wit_bindgen::generate!({
    world: "plugin-syntax",
    path: "../../../../../wit",
});

use exports::openidea::plugin::syntax_provider::{self, Fold, Symbol, Token};
use exports::openidea::plugin::{commands, event_handler, lifecycle};
use openidea::plugin::{contributions, invocation::Invocation, types};

struct Misbehave;

fn err(e: types::Error) -> String {
    format!("{e:?}")
}

impl lifecycle::Guest for Misbehave {
    fn activate(ctx: types::Context) -> Result<(), String> {
        // A deliberately broken build (rollback tests): `version = "…-broken"`.
        if ctx.plugin_version.ends_with("-broken") {
            return Err("this build is broken".into());
        }
        for id in ["echo", "panic", "spin", "alloc", "read", "root", "insert", "language", "theme"] {
            contributions::register_command(id, id, None).map_err(err)?;
        }
        Ok(())
    }

    fn deactivate() {}
}

impl commands::Guest for Misbehave {
    fn run(id: String, ctx: &Invocation, arg: Option<String>) -> Result<Option<String>, String> {
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
                let project = ctx.project().ok_or("no project is open")?;
                project.read_file(&arg.unwrap_or_default()).map(Some).map_err(err)
            }
            "root" => ctx.project().map(|p| p.root().map_err(err)).transpose(),
            // `editor.write` is not granted: an error, not a trap.
            "insert" => {
                let editor = ctx.editor().ok_or("no editor")?;
                editor.apply_edits(0, &[]).map(|_| None).map_err(err)
            }
            "language" => contributions::register_language(&arg.unwrap_or_default()).map(|_| None).map_err(err),
            "theme" => contributions::register_theme(&arg.unwrap_or_default()).map(|_| None).map_err(err),
            other => Err(format!("unknown command: {other}")),
        }
    }
}

impl event_handler::Guest for Misbehave {
    fn handle(_events: Vec<openidea::plugin::events::Event>, _ctx: &Invocation) {}
}

/// Edit-path budgets: the text says how to behave. `sleep:<ms>` busy-waits
/// that long, `spin` never returns, `panic` traps; anything else is one
/// keyword token over the whole text.
impl syntax_provider::Guest for Misbehave {
    fn highlights(_language: String, text: String) -> Vec<Token> {
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
            panic!("highlight boom");
        }
        vec![Token { start: 0, end: text.len() as u32, kind: "keyword".into() }]
    }

    fn outline(_language: String, _text: String) -> Vec<Symbol> {
        Vec::new()
    }

    fn folding(_language: String, _text: String) -> Vec<Fold> {
        Vec::new()
    }
}

export!(Misbehave);
