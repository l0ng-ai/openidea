//! Test fixture for the ide-plugin sandbox. Never shipped.

// `plugin` with syntax and editor providers.
wit_bindgen::generate!({
    inline: "
        package fixture:misbehave;
        world misbehave {
            include openidea:plugin/plugin-syntax@1.3.0;
            export openidea:plugin/providers@1.3.0;
            export openidea:plugin/file-actions@1.3.0;
        }
    ",
    path: "../../../../../wit",
    world: "fixture:misbehave/misbehave",
    generate_all,
});

use exports::openidea::plugin::providers::{
    self, CodeAction, CompletionItem, Document, FileEdit, InlineSuggestion, LineMarker,
};
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
            // The `fs.read` grants: the text of `arg`, or the refusal naming what it needs.
            "fsread" => openidea::plugin::fs::read_file(&arg.unwrap_or_default()).map(Some),
            // The `fs.read-dir` listing: "name kind" lines.
            "read-dir" => {
                use openidea::plugin::workspace::FileKind;
                let entries = openidea::plugin::fs::read_dir(&arg.unwrap_or_default())?;
                let lines: Vec<String> = entries
                    .iter()
                    .map(|e| {
                        let kind = match e.kind {
                            FileKind::File => "file",
                            FileKind::Directory => "dir",
                            FileKind::Symlink => "link",
                            FileKind::Other => "other",
                        };
                        format!("{kind} {}", e.name)
                    })
                    .collect();
                Ok(Some(lines.join("\n")))
            }
            // The `fs.write` grant: replaces the file at `arg`.
            "fswrite" => {
                openidea::plugin::fs::write_file(&arg.unwrap_or_default(), "written by the plugin\n").map(|()| None)
            }
            // The `project.write` grant: writes `arg` inside the project.
            "projwrite" => {
                let project = ctx.project().ok_or_else(|| failed("no project is open"))?;
                project.write_file(&arg.unwrap_or_default(), "written inside the project\n").map(|()| None)
            }
            // `editor.write` is not granted: an error, not a trap.
            "insert" => {
                let editor = ctx.editor().ok_or_else(|| failed("no editor"))?;
                editor.apply_edits(0, &[]).map(|_| None)
            }
            // The user gave up: not the plugin failing.
            "cancel" => Err(types::Error::Cancelled),
            // Event kinds are names: one this IDE doesn't know is refused.
            "subscribe" => openidea::plugin::events::subscribe(&arg.unwrap_or_default()).map(|()| None),
            // Tagged problems from another tool on the line 0 of `arg`.
            "diagnose" => {
                use openidea::plugin::diagnostics::{self, Diagnostic, Severity};
                let start = types::Position { line: 0, character: 0 };
                let d = Diagnostic {
                    range: types::Range { start, end: start },
                    severity: Severity::Warning,
                    message: "unused".into(),
                    code: None,
                    source: Some("lint".into()),
                    tags: vec!["unnecessary".into(), "glowing".into()],
                    related: Vec::new(),
                };
                diagnostics::publish(&arg.unwrap_or_default(), &[d]).map(|()| None)
            }
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

fn action_answer(kind: &str) -> Result<String, types::Error> {
    use openidea::plugin::{ui, views};
    let items = vec![
        ui::PickItem { key: "a".into(), label: "Alpha".into(), description: None },
        ui::PickItem { key: "b".into(), label: "Beta".into(), description: None },
    ];
    let answer = match kind {
        "pick" => ui::pick("Choose translation file", &items)?,
        "pick-many" => ui::pick_many("Choose services", &items)?.map(|keys| keys.join(",")),
        "input" => ui::input("Service name", Some("Service"))?,
        "confirm" => ui::confirm("Rewrite", "Apply this rewrite?")?.then(|| "confirmed".into()),
        "input-multiline" => ui::input_multiline("Not allowed", None)?,
        "reveal" => {
            views::reveal("missing")?;
            None
        }
        "open-url" => {
            ui::open_url("https://example.com")?;
            None
        }
        "clipboard" => {
            ui::copy_to_clipboard("not allowed")?;
            None
        }
        "pick-directory" => ui::pick_directory("Not allowed", None)?,
        "open-project" => {
            openidea::plugin::workspace::open_project("/not-allowed", false)?;
            None
        }
        _ => return Err(types::Error::Invalid("unknown prompt".into())),
    };
    answer.ok_or(types::Error::Cancelled)
}

/// Completion: one item, labelled with the document's path, after [`behave`].
impl providers::Guest for Misbehave {
    fn completion(doc: Document, _at: types::Position, _trigger: Option<String>) -> Vec<CompletionItem> {
        if doc.text == "prompt-provider" {
            assert!(matches!(action_answer("input"), Err(types::Error::Invalid(_))));
        }
        behave(&doc.text);
        // `rich`: a snippet that also adds an import.
        let rich = doc.text == "rich";
        let start = types::Position { line: 0, character: 0 };
        vec![CompletionItem {
            label: doc.path.clone(),
            detail: None,
            kind: Some("keyword".into()),
            insert_text: if rich { "f(${1:x})$0".into() } else { doc.path },
            snippet: rich,
            replace: None,
            sort_text: None,
            filter_text: rich.then(|| "fun".into()),
            documentation: None,
            additional_edits: if rich {
                vec![types::TextEdit { range: types::Range { start, end: start }, text: "use f;\n".into() }]
            } else {
                Vec::new()
            },
        }]
    }

    fn inline_completion(_doc: Document, _at: types::Position) -> Option<InlineSuggestion> {
        None
    }

    /// `lazy`: one action whose edits come from `resolve-code-action`.
    fn code_actions(doc: Document, _selection: types::Range) -> Vec<CodeAction> {
        if doc.text == "prompts" {
            return [
                "pick",
                "pick-many",
                "input",
                "confirm",
                "input-multiline",
                "reveal",
                "open-url",
                "clipboard",
                "pick-directory",
                "open-project",
            ]
            .into_iter()
            .map(|kind| CodeAction {
                title: format!("Ask {kind}"),
                kind: Some("quickfix".into()),
                preferred: false,
                edits: Vec::new(),
                data: Some(kind.into()),
            })
            .collect();
        }
        if doc.text != "lazy" {
            return Vec::new();
        }
        vec![CodeAction {
            title: "Fix later".into(),
            kind: Some("quickfix".into()),
            preferred: false,
            edits: Vec::new(),
            data: Some("fix".into()),
        }]
    }

    fn resolve_code_action(doc: Document, action: CodeAction) -> Result<CodeAction, types::Error> {
        if doc.text == "prompts" {
            let kind = action.data.as_deref().unwrap_or_default();
            let answer = action_answer(kind)?;
            // Longer than the 50 ms provider budget, within the command budget.
            behave("sleep:80");
            let start = types::Position { line: 0, character: 0 };
            let edit = types::TextEdit { range: types::Range { start, end: start }, text: answer };
            return Ok(CodeAction {
                edits: vec![FileEdit { path: doc.path, edits: vec![edit] }],
                data: None,
                ..action
            });
        }
        if action.data.as_deref() != Some("fix") {
            return Err(types::Error::Invalid("not one of mine".into()));
        }
        let start = types::Position { line: 0, character: 0 };
        let edit = types::TextEdit { range: types::Range { start, end: start }, text: "fixed ".into() };
        Ok(CodeAction { edits: vec![FileEdit { path: doc.path, edits: vec![edit] }], ..action })
    }

    fn definition(_doc: Document, _at: types::Position) -> Vec<types::Location> {
        Vec::new()
    }

    fn line_markers(_doc: Document) -> Vec<LineMarker> {
        Vec::new()
    }
}

/// `files`: one action that creates, renames and deletes files, then opens
/// one, and one listed with `data` only, whose file `resolve` creates.
impl exports::openidea::plugin::file_actions::Guest for Misbehave {
    fn code_actions(
        doc: exports::openidea::plugin::file_actions::Document,
        _selection: types::Range,
    ) -> Vec<exports::openidea::plugin::file_actions::FileAction> {
        use exports::openidea::plugin::file_actions::{CreateFile, DeleteFile, FileAction, FileOperation, RenameFile};
        if doc.text == "prompt-files" {
            return vec![FileAction {
                title: "Create a service".into(),
                kind: Some("quickfix".into()),
                preferred: false,
                operations: Vec::new(),
                edits: Vec::new(),
                open: None,
                data: Some("input".into()),
            }];
        }
        if doc.text != "files" {
            return Vec::new();
        }
        let dir = doc.path.rsplit_once('/').map_or("", |(dir, _)| dir).to_owned();
        vec![
            FileAction {
                title: "Reorganise".into(),
                kind: Some("quickfix".into()),
                preferred: false,
                operations: vec![
                    FileOperation::Create(CreateFile {
                        path: format!("{dir}/created.txt"),
                        text: "hello".into(),
                        overwrite: false,
                    }),
                    FileOperation::Rename(RenameFile {
                        path: format!("{dir}/old.txt"),
                        new_path: format!("{dir}/renamed.txt"),
                    }),
                    FileOperation::Delete(DeleteFile { path: format!("{dir}/gone.txt") }),
                ],
                edits: Vec::new(),
                open: Some(format!("{dir}/created.txt")),
                data: None,
            },
            FileAction {
                title: "Create later".into(),
                kind: Some("quickfix".into()),
                preferred: false,
                operations: Vec::new(),
                edits: Vec::new(),
                open: None,
                data: Some(dir),
            },
        ]
    }

    fn resolve(
        doc: exports::openidea::plugin::file_actions::Document,
        action: exports::openidea::plugin::file_actions::FileAction,
    ) -> Result<exports::openidea::plugin::file_actions::FileAction, types::Error> {
        use exports::openidea::plugin::file_actions::{CreateFile, FileOperation};
        if doc.text == "prompt-files" {
            let name = action_answer("input")?;
            let dir = doc.path.rsplit_once('/').map_or("", |(dir, _)| dir);
            let path = format!("{dir}/{name}.txt");
            return Ok(exports::openidea::plugin::file_actions::FileAction {
                operations: vec![FileOperation::Create(CreateFile {
                    path: path.clone(),
                    text: name,
                    overwrite: false,
                })],
                open: Some(path),
                data: None,
                ..action
            });
        }
        let dir = action.data.clone().ok_or_else(|| types::Error::Invalid("no data".into()))?;
        let operations = vec![FileOperation::Create(CreateFile {
            path: format!("{dir}/later.txt"),
            text: "later".into(),
            overwrite: false,
        })];
        Ok(exports::openidea::plugin::file_actions::FileAction { operations, data: None, ..action })
    }
}

export!(Misbehave);
