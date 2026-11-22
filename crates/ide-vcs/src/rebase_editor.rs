use crate::{RebaseAction, RebaseOptions, Repo, cli, log_index::subject, manage::rebase_args, ops, repo::resolve};
use gix::bstr::ByteSlice;
use ide_core::{CancellationToken, IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashSet};
use std::ffi::OsStr;
use std::fs;

#[derive(Deserialize, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RebaseEditorOperation {
    Start { upstream: Option<String>, options: RebaseOptions },
    Continue { stage: bool },
    Skip,
}

#[derive(Clone, Copy, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RebaseEditKind {
    Plan,
    Message,
}

#[derive(Serialize, Type)]
pub struct RebaseEdit {
    pub kind: RebaseEditKind,
    pub text: String,
    pub plan: Option<Vec<RebaseTodoRow>>,
}

#[derive(Deserialize, Type)]
pub struct RebaseEditorReply {
    pub text: String,
    #[serde(default)]
    pub rewords: BTreeMap<String, String>,
}

impl From<String> for RebaseEditorReply {
    fn from(text: String) -> Self {
        Self { text, rewords: BTreeMap::new() }
    }
}

#[derive(Clone, Copy, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RebaseFixupMessage {
    Replace,
    Edit,
}

#[derive(Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RebaseTodoRow {
    Commit {
        line: usize,
        action: RebaseAction,
        #[serde(rename = "fixupMessage", skip_serializing_if = "Option::is_none")]
        fixup_message: Option<RebaseFixupMessage>,
        id: String,
        revision: String,
        author: String,
        summary: String,
        message: String,
    },
    UpdateRef {
        line: usize,
        reference: String,
    },
}

// Git removes the saved drafts when it removes its rebase state.
const EDITOR_MARKER: &str = "rebase-merge/openidea-editor";
const EDITOR_COMMENT: &str = "\u{1}";
const EDITOR_COMMENT_CONFIG: &str = "core.commentChar=\u{1}";
const SCISSORS: &str = "------------------------ >8 ------------------------";

#[derive(Deserialize, Serialize)]
struct SavedEditor {
    rewords: BTreeMap<String, String>,
}

// Blank lines keep the editor tied to the host's output pipe and are dropped by the reader.
const EDITOR: &str = r#"set -e
dir=$OPENIDEA_GIT_EDITOR_DIR
cp -- "$2" "$dir/input"
printf '\n%s:%s\n' "$OPENIDEA_GIT_EDITOR_SIGNAL" "$1"
while [ -d "$dir" ] && [ ! -f "$dir/reply" ] && [ ! -f "$dir/cancel" ]; do
    sleep 0.1
    printf '\n'
done
[ ! -f "$dir/cancel" ] || exit 1
cp -- "$dir/reply" "$2"
rm -- "$dir/reply"
"#;

impl Repo {
    pub fn rebase_editor_operation(
        &self,
        operation: RebaseEditorOperation,
        cancel: &CancellationToken,
        out: &dyn Fn(String),
        edit: &dyn Fn(RebaseEdit) -> Option<RebaseEditorReply>,
    ) -> IdeResult<()> {
        if let RebaseEditorOperation::Start { upstream, options } = operation {
            return self.rebase_with_editor(upstream.as_deref(), &options, cancel, out, edit);
        }
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        let _scope = self.execution_scope();
        if self.operation()?.as_deref() != Some("rebase") {
            return Err(IdeError::invalid("No rebase in progress"));
        }
        let run = |args: &[&str]| {
            if self.git_dir.join(EDITOR_MARKER).is_file() {
                self.run_rebase_editor(args, false, cancel, out, edit)
            } else {
                cli::run_streaming(self.root(), args, cancel, out)
            }
        };
        match operation {
            RebaseEditorOperation::Start { .. } => unreachable!(),
            RebaseEditorOperation::Continue { stage } => ops::continue_op(self, stage, run),
            RebaseEditorOperation::Skip => ops::skip_op(self, run),
        }
    }

    /// Lets Git generate and execute its own interactive plan, including merge instructions.
    pub fn rebase_with_editor(
        &self,
        upstream: Option<&str>,
        options: &RebaseOptions,
        cancel: &CancellationToken,
        out: &dyn Fn(String),
        edit: &dyn Fn(RebaseEdit) -> Option<RebaseEditorReply>,
    ) -> IdeResult<()> {
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        let _scope = self.execution_scope();
        let mut args = rebase_args(upstream, options)?;
        self.validate_rebase(options)?;
        args.insert(1, "--interactive".into());
        let args: Vec<_> = args.iter().map(String::as_str).collect();
        crate::preserve::around(self, "Local changes saved before rebase", || {
            self.run_rebase_editor(&args, true, cancel, out, edit)
        })
    }

    fn run_rebase_editor(
        &self,
        args: &[&str],
        starting: bool,
        cancel: &CancellationToken,
        out: &dyn Fn(String),
        edit: &dyn Fn(RebaseEdit) -> Option<RebaseEditorReply>,
    ) -> IdeResult<()> {
        let session = tempfile::Builder::new().prefix("openidea-git-editor-").tempdir()?;
        let dir = session.path();
        let script = dir.join("editor.sh");
        fs::write(&script, EDITOR)?;
        let sequence = format!("sh {} plan", ops::quote_for_shell(&script));
        let message = format!("sh {} message", ops::quote_for_shell(&script));
        let signal = dir.file_name().and_then(OsStr::to_str).unwrap_or("openidea-git-editor");
        let dir_env = dir.to_string_lossy().replace('\\', "/");
        let env = [
            ("GIT_SEQUENCE_EDITOR", OsStr::new(&sequence)),
            ("GIT_EDITOR", OsStr::new(&message)),
            ("OPENIDEA_GIT_EDITOR_DIR", OsStr::new(&dir_env)),
            ("OPENIDEA_GIT_EDITOR_SIGNAL", OsStr::new(signal)),
        ];
        let declined = Cell::new(false);
        let pipe_failed = Cell::new(false);
        let editor_error = RefCell::new(None);
        let marker = self.git_dir.join(EDITOR_MARKER);
        let saved = fs::read(&marker).unwrap_or_default();
        let editor = serde_json::from_slice::<SavedEditor>(&saved).ok();
        // Older sessions used the repository's own comment convention in their saved state.
        let private_comments = starting || editor.is_some();
        let drafts = RefCell::new(
            editor.map(|editor| editor.rewords).or_else(|| serde_json::from_slice(&saved).ok()).unwrap_or_default(),
        );
        let comment = todo_comment(self);
        let mut command = Vec::with_capacity(args.len() + 2);
        if private_comments {
            command.extend(["-c", EDITOR_COMMENT_CONFIG]);
        }
        command.extend_from_slice(args);
        // Once the editor has declined, let Git handle the exit and clean up its rebase state.
        let should_cancel = || pipe_failed.get() || (!declined.get() && cancel.is_cancelled());
        let result = cli::run_streaming_env_until(self.root(), &command, &env, &should_cancel, &|line| {
            let prompt = line.strip_prefix(signal).and_then(|suffix| match suffix {
                ":plan" => Some(RebaseEditKind::Plan),
                ":message" => Some(RebaseEditKind::Message),
                _ => None,
            });
            let Some(kind) = prompt else {
                out(line);
                return;
            };
            let reply = (|| -> IdeResult<()> {
                let input = dir.join("input");
                let text = fs::read_to_string(&input)?;
                fs::remove_file(input)?;
                let is_plan = matches!(kind, RebaseEditKind::Plan);
                let plan_comment = if private_comments { EDITOR_COMMENT } else { &comment };
                let plan = if is_plan { simple_plan(self, &text, plan_comment, cancel) } else { None };
                let prepared = if is_plan { None } else { reword_for_git_step(self, &drafts.borrow()) };
                let answer = prepared.map(RebaseEditorReply::from).or_else(|| {
                    let text = match (private_comments, is_plan) {
                        (true, true) => display_todo_comments(&text, &comment),
                        (true, false) => message_body(&text),
                        _ => text,
                    };
                    edit(RebaseEdit { kind, text, plan })
                });
                if let Some(mut answer) = answer {
                    let pending = dir.join("reply.tmp");
                    if is_plan && private_comments {
                        // Help and notes have no effect on the replay. The saved todo remains
                        // readable by Git using the repository's own comment convention.
                        answer.text = answer
                            .text
                            .split_inclusive('\n')
                            .filter(|line| !todo_line(line).starts_with(&comment))
                            .collect();
                    }
                    fs::write(&pending, &answer.text)?;
                    if is_plan {
                        let approved = approved_rewords(self, &answer.text, &answer.rewords);
                        let editor = SavedEditor { rewords: approved };
                        let bytes = serde_json::to_vec(&editor).map_err(|e| IdeError::internal(e.to_string()))?;
                        fs::write(&marker, bytes)?;
                        drafts.replace(editor.rewords);
                    }
                    fs::rename(&pending, dir.join("reply"))?;
                } else {
                    declined.set(true);
                    fs::write(dir.join("cancel"), [])?;
                }
                Ok(())
            })();
            if let Err(error) = reply {
                *editor_error.borrow_mut() = Some(error);
                if fs::write(dir.join("cancel"), []).is_err() {
                    pipe_failed.set(true);
                }
            }
        });
        if let Some(error) = editor_error.into_inner() {
            return Err(error);
        }
        if declined.get() {
            return Err(IdeError::cancelled());
        }
        result
    }
}

fn todo_line(line: &str) -> &str {
    line.trim_start_matches([' ', '\t'])
}

fn todo_comment(r: &Repo) -> String {
    r.gix()
        .ok()
        .and_then(|repo| {
            let config = repo.config_snapshot();
            config
                .string("core.commentString")
                .or_else(|| config.string("core.commentChar"))
                .map(|comment| comment.to_str_lossy().into_owned())
        })
        .filter(|comment| !comment.is_empty() && comment != "auto" && !comment.starts_with(char::is_alphabetic))
        .unwrap_or_else(|| "#".into())
}

fn display_todo_comments(text: &str, comment: &str) -> String {
    let mut display = String::with_capacity(text.len());
    for line in text.split_inclusive('\n') {
        let command = todo_line(line);
        if let Some(note) = command.strip_prefix(EDITOR_COMMENT) {
            display.push_str(&line[..line.len() - command.len()]);
            display.push_str(comment);
            display.push_str(note);
        } else {
            display.push_str(line);
        }
    }
    display
}

fn message_body(text: &str) -> String {
    text.split_inclusive('\n')
        .take_while(|line| line.strip_prefix(EDITOR_COMMENT).is_none_or(|note| note.trim() != SCISSORS))
        .filter(|line| !line.starts_with(EDITOR_COMMENT))
        .collect()
}

struct CommitCommand<'a> {
    action: RebaseAction,
    revision: &'a str,
    fixup_message: Option<RebaseFixupMessage>,
}

fn commit_command(line: &str) -> Option<CommitCommand<'_>> {
    let mut words = line.split_ascii_whitespace();
    let action = match words.next()? {
        "p" | "pick" => RebaseAction::Pick,
        "r" | "reword" => RebaseAction::Reword,
        "e" | "edit" => RebaseAction::Edit,
        "s" | "squash" => RebaseAction::Squash,
        "f" | "fixup" => RebaseAction::Fixup,
        "d" | "drop" => RebaseAction::Drop,
        _ => return None,
    };
    let first = words.next()?;
    let fixup_message = match (action, first) {
        (RebaseAction::Fixup, "-C") => Some(RebaseFixupMessage::Replace),
        (RebaseAction::Fixup, "-c") => Some(RebaseFixupMessage::Edit),
        _ => None,
    };
    let revision = if fixup_message.is_some() { words.next()? } else { first };
    revision.bytes().all(|b| b.is_ascii_hexdigit()).then_some(CommitCommand { action, revision, fixup_message })
}

fn approved_rewords(r: &Repo, text: &str, proposed: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    let mut approved = BTreeMap::new();
    if proposed.is_empty() {
        return approved;
    }
    let Ok(repo) = r.gix() else { return approved };
    let mut seen = HashSet::new();
    for CommitCommand { action, revision, .. } in text.lines().filter_map(commit_command) {
        let Ok(id) = resolve(&repo, revision) else { continue };
        let key = id.to_string();
        let Some(message) = proposed.get(&key).filter(|message| !message.trim().is_empty()) else { continue };
        if !seen.insert(id) {
            approved.remove(&key);
        } else if action == RebaseAction::Reword {
            approved.insert(key, message.clone());
        }
    }
    approved
}

fn reword_for_git_step(r: &Repo, drafts: &BTreeMap<String, String>) -> Option<String> {
    if drafts.is_empty() {
        return None;
    }
    // Git records the original object here even when HEAD already names the rewritten commit.
    let done = fs::read_to_string(r.git_dir.join("rebase-merge/done")).ok()?;
    let CommitCommand { action, revision, .. } =
        commit_command(done.lines().rev().find(|line| !line.trim().is_empty())?)?;
    if action != RebaseAction::Reword {
        return None;
    }
    drafts.get(revision).cloned().or_else(|| {
        let id = resolve(&r.gix().ok()?, revision).ok()?;
        drafts.get(&id.to_string()).cloned()
    })
}

fn simple_plan(r: &Repo, text: &str, comment: &str, cancel: &CancellationToken) -> Option<Vec<RebaseTodoRow>> {
    let repo = r.gix().ok()?;
    let mut todo = Vec::new();
    let mut seen = HashSet::new();
    let mut seen_refs = HashSet::new();
    for (line, source) in text.lines().enumerate() {
        let source = todo_line(source);
        if source.is_empty() || source.starts_with(comment) {
            continue;
        }
        if cancel.is_cancelled() {
            return None;
        }
        let mut words = source.split_ascii_whitespace();
        if matches!(words.next(), Some("update-ref" | "u")) {
            let reference = words.next().filter(|reference| reference.starts_with("refs/"))?;
            if words.next().is_some() || !seen_refs.insert(reference) {
                return None;
            }
            todo.push(RebaseTodoRow::UpdateRef { line, reference: reference.to_owned() });
            continue;
        }
        let CommitCommand { action, revision, fixup_message } = commit_command(source)?;
        let id = resolve(&repo, revision).ok()?;
        if !seen.insert(id) {
            return None;
        }
        let commit = repo.find_commit(id).ok()?;
        let raw = commit.message_raw_sloppy();
        let author = commit.author().ok()?.name.trim().to_str_lossy().into_owned();
        todo.push(RebaseTodoRow::Commit {
            line,
            action,
            fixup_message,
            id: id.to_string(),
            revision: revision.to_owned(),
            author,
            summary: subject(raw),
            message: raw.to_str_lossy().trim_end().to_owned(),
        });
    }
    (!todo.is_empty()).then_some(todo)
}
