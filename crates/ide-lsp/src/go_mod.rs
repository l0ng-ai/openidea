//! go.mod as GoLand shows it: available upgrades, vulnerabilities and deprecated modules are
//! reported as soon as the file is opened. gopls reports upgrades only from its "Check for
//! upgrades" code lens, so that runs once per go.mod and session; its results (and the
//! vulnerabilities from the `vulncheck` setting) come back as gopls diagnostics with quick fixes.
//! gopls never reports a deprecated module, so `go list -m -u` does, on open and on save.

use crate::LspManager;
use crate::server::Server;
use ide_core::{CancellationToken, DocId, Pos, Range};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::io::AsyncReadExt;

pub(crate) const CHECK_UPGRADES: &str = "gopls.check_upgrades";
/// gopls answers code lenses once it has loaded the module.
const ATTEMPTS: u32 = 10;
const RETRY: Duration = Duration::from_secs(2);
/// Producer of the deprecation diagnostics (one full set per go.mod).
const DEPRECATIONS: &str = "go-mod-deprecations";
// This optional background check must not wait indefinitely on a proxy or toolchain download.
const QUERY_TIMEOUT: Duration = Duration::from_secs(60);
const OUTPUT_LIMIT: u64 = 8 * 1024 * 1024;

#[derive(Default)]
pub(crate) struct Queries {
    generation: u64,
    running: HashMap<DocId, (u64, CancellationToken)>,
}

impl Queries {
    fn begin(&mut self, doc: DocId) -> (u64, CancellationToken) {
        self.cancel(doc);
        self.generation += 1;
        let cancel = CancellationToken::new();
        self.running.insert(doc, (self.generation, cancel.clone()));
        (self.generation, cancel)
    }

    fn finish(&mut self, doc: DocId, generation: u64) {
        if self.running.get(&doc).is_some_and(|(current, _)| *current == generation) {
            self.running.remove(&doc);
        }
    }

    pub(crate) fn cancel(&mut self, doc: DocId) {
        if let Some((_, cancel)) = self.running.remove(&doc) {
            cancel.cancel();
        }
    }

    pub(crate) fn cancel_all(&mut self) {
        for (_, (_, cancel)) in self.running.drain() {
            cancel.cancel();
        }
    }
}

fn is_go_mod(path: &Path) -> bool {
    path.file_name().is_some_and(|n| n == "go.mod")
}

impl LspManager {
    pub(crate) async fn check_go_mod(&self, doc: DocId, path: &Path, server: Arc<Server>) {
        if server.name != "gopls" || !is_go_mod(path) {
            return;
        }
        self.report_deprecated_modules(doc, &server).await;
        if !self.go_mod_checked.lock().insert(path.to_owned()) {
            return;
        }
        for attempt in 0..ATTEMPTS {
            if attempt > 0 {
                tokio::time::sleep(RETRY).await;
            }
            if !self.docs.lock().contains_key(&doc) {
                break;
            }
            let Ok(lenses) = self.code_lens(doc).await else { continue };
            let Some(command) = lenses.into_iter().filter_map(|l| l.command).find(|c| c.command == CHECK_UPGRADES)
            else {
                continue;
            };
            if let Err(e) = self.execute_command(doc, command).await {
                tracing::debug!("gopls: {CHECK_UPGRADES} for {}: {}", path.display(), e.message);
            }
            return;
        }
        // Not checked after all (closed, or gopls never offered the lens): a later open retries.
        self.go_mod_checked.lock().remove(path);
    }

    /// After a save of a go.mod: its requirements may have changed.
    pub(crate) fn go_mod_saved(&self, doc: DocId) {
        let server = {
            let docs = self.docs.lock();
            let Some(d) = docs.get(&doc).filter(|d| is_go_mod(&d.path)) else { return };
            let Some(a) = d.servers.iter().find(|a| a.server.name == "gopls") else { return };
            a.server.clone()
        };
        let Some(me) = self.me.upgrade() else { return };
        self.runtime.spawn(async move { me.report_deprecated_modules(doc, &server).await });
    }

    async fn report_deprecated_modules(&self, doc: DocId, server: &Server) {
        let (generation, cancel) = self.go_mod_queries.lock().begin(doc);
        self.report_deprecated_modules_query(doc, server, &cancel).await;
        self.go_mod_queries.lock().finish(doc, generation);
    }

    async fn report_deprecated_modules_query(&self, doc: DocId, server: &Server, cancel: &CancellationToken) {
        if self.shutting_down.load(Ordering::Acquire) || !self.execution_allowed.load(Ordering::Acquire) {
            return;
        }
        let Some((path, text)) = self.docs.lock().get(&doc).map(|d| (d.path.clone(), d.text.as_str().to_owned()))
        else {
            return;
        };
        let required = required_modules(&text);
        if required.is_empty() {
            return;
        }
        let config = server.effective_config();
        let search = crate::launch::server_search_path(&config);
        let Some(dir) = path.parent().map(Path::to_path_buf) else { return };
        let modules: Vec<String> = required.iter().map(|r| r.path.clone()).collect();
        let Some(deprecated) = list_deprecations(&dir, &search, &modules, cancel).await else { return };
        // The document changed meanwhile: its own save runs again.
        if cancel.is_cancelled() || self.docs.lock().get(&doc).is_none_or(|d| d.text.as_str() != text) {
            return;
        }
        let items = required
            .into_iter()
            .filter_map(|r| {
                let message = deprecated.iter().find(|(p, _)| *p == r.path)?.1.trim();
                Some(ide_core::Diagnostic {
                    range: r.range,
                    severity: ide_core::Severity::Warning,
                    message: format!("{} is deprecated: {message}", r.path),
                    source: Some("go".into()),
                    code: None,
                    unnecessary: false,
                    deprecated: true,
                    server: Some("gopls".into()),
                })
            })
            .collect();
        self.sink().emit(ide_core::IdeEvent::Diagnostics { path: path.into(), source: DEPRECATIONS.into(), items });
    }
}

#[derive(Debug, PartialEq)]
struct Required {
    path: String,
    /// The module path in go.mod (UTF-16 columns).
    range: Range,
}

/// Modules of go.mod's `require` directives, single-line or in a block.
fn required_modules(text: &str) -> Vec<Required> {
    let mut out = Vec::new();
    let mut in_block = false;
    for (line, raw) in text.lines().enumerate() {
        let code = raw.split("//").next().unwrap_or("");
        let trimmed = code.trim_start();
        let entry = if in_block {
            if trimmed.starts_with(')') {
                in_block = false;
                continue;
            }
            trimmed
        } else if let Some(rest) = trimmed.strip_prefix("require").filter(|r| r.starts_with(char::is_whitespace)) {
            let rest = rest.trim_start();
            if rest.starts_with('(') {
                in_block = true;
                continue;
            }
            rest
        } else {
            continue;
        };
        let mut words = entry.split_whitespace();
        let (Some(module), Some(_version)) = (words.next(), words.next()) else { continue };
        let module = module.trim_matches('"');
        let Some(start) = code.find(module) else { continue };
        let col = |byte: usize| code[..byte].encode_utf16().count() as u32;
        let line = line as u32;
        out.push(Required {
            path: module.to_owned(),
            range: Range { start: Pos { line, col: col(start) }, end: Pos { line, col: col(start + module.len()) } },
        });
    }
    out
}

#[derive(Deserialize)]
struct ListedModule {
    #[serde(rename = "Path")]
    path: String,
    #[serde(rename = "Deprecated", default)]
    deprecated: Option<String>,
}

/// `(module, message)` of each deprecated module in `modules`; `None` when `go` failed.
async fn list_deprecations(
    dir: &Path,
    search: &std::ffi::OsStr,
    modules: &[String],
    cancel: &CancellationToken,
) -> Option<Vec<(String, String)>> {
    let (dir, search, modules) = (dir.to_path_buf(), search.to_owned(), modules.to_vec());
    let command = tokio::task::spawn_blocking(move || {
        let go: PathBuf = ide_core::tool_path::find_command("go", &search, &dir)?;
        let mut command = Command::new(go);
        command.args(["list", "-m", "-u", "-e", "-json"]).args(modules).current_dir(dir).env("PATH", search);
        Some(command)
    })
    .await
    .ok()??;
    let output = run_query(command, cancel, QUERY_TIMEOUT).await?;
    if output.is_empty() {
        return None;
    }
    tokio::task::spawn_blocking(move || parse_deprecations(&output)).await.ok()
}

async fn run_query(command: Command, cancel: &CancellationToken, timeout: Duration) -> Option<Vec<u8>> {
    let cancel = cancel.child_token();
    let _cancel_on_drop = cancel.clone().drop_guard();
    // The supervisor owns cleanup even if the caller's future is dropped.
    tokio::spawn(async move { supervise_query(command, &cancel, timeout).await }).await.ok().flatten()
}

async fn supervise_query(mut command: Command, cancel: &CancellationToken, timeout: Duration) -> Option<Vec<u8>> {
    if cancel.is_cancelled() {
        return None;
    }
    ide_core::process::prepare(&mut command);
    ide_core::process::own_group(&mut command);
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut command = tokio::process::Command::from(command);
    command.kill_on_drop(true);
    let mut child = command.spawn().ok()?;
    #[cfg(windows)]
    let job = child.id().and_then(ide_core::process::Job::for_pid);
    let stdout = child.stdout.take()?;
    let mut reader = tokio::spawn(async move {
        let mut output = Vec::new();
        stdout.take(OUTPUT_LIMIT + 1).read_to_end(&mut output).await.ok()?;
        if output.len() as u64 > OUTPUT_LIMIT {
            tracing::debug!("go module query exceeded stdout budget");
            return None;
        }
        Some(output)
    });
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);
    // Drain before reaping: if a descendant holds stdout open, the root's id
    // still belongs to this child when cancellation kills its process tree.
    let output = tokio::select! {
        biased;
        () = cancel.cancelled() => None,
        () = &mut deadline => {
            tracing::debug!("go module query timed out");
            None
        },
        result = &mut reader => result.ok().flatten(),
    };
    if let Some(bytes) = output {
        let status = tokio::select! {
            biased;
            () = cancel.cancelled() => None,
            () = &mut deadline => {
            tracing::debug!("go module query timed out");
            None
        },
            status = child.wait() => Some(status),
        };
        if let Some(status) = status {
            return status.ok().map(|_| bytes);
        }
    }
    // The root is still unreaped here, so its process/group id cannot be reused.
    if let Some(pid) = child.id() {
        let _ = tokio::task::spawn_blocking(move || {
            #[cfg(windows)]
            if let Some(job) = job {
                job.terminate();
                return;
            }
            ide_core::process::kill_tree_of(pid);
        })
        .await;
    }
    let _ = child.start_kill();
    let _ = child.wait().await;
    reader.abort();
    None
}

fn parse_deprecations(json: &[u8]) -> Vec<(String, String)> {
    serde_json::Deserializer::from_slice(json)
        .into_iter::<ListedModule>()
        .map_while(Result::ok)
        .filter_map(|m| Some((m.path, m.deprecated.filter(|d| !d.trim().is_empty())?)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queries_cancel_only_the_superseded_document() {
        let mut queries = Queries::default();
        let (first, old) = queries.begin(DocId(1));
        let (_, other) = queries.begin(DocId(2));
        let (second, new) = queries.begin(DocId(1));
        assert!(old.is_cancelled());
        assert!(!other.is_cancelled());
        assert!(!new.is_cancelled());
        queries.finish(DocId(1), first);
        assert_eq!(queries.running.len(), 2);
        queries.finish(DocId(1), second);
        assert_eq!(queries.running.len(), 1);
        queries.cancel_all();
        assert!(other.is_cancelled());
        assert!(queries.running.is_empty());
    }

    #[test]
    fn closing_one_document_does_not_cancel_another() {
        let mut queries = Queries::default();
        let (_, closed) = queries.begin(DocId(1));
        let (_, other) = queries.begin(DocId(2));
        queries.cancel(DocId(1));
        assert!(closed.is_cancelled());
        assert!(!other.is_cancelled());
        assert_eq!(queries.running.len(), 1);
    }

    #[cfg(unix)]
    fn shell(script: &str) -> Command {
        let mut command = Command::new("sh");
        command.args(["-c", script]);
        command
    }

    #[cfg(target_os = "linux")]
    async fn assert_stopped(pid: u32) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) {
                if stat.rsplit_once(") ").unwrap().1.split_whitespace().next() == Some("Z") {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancelled_query_never_spawns() {
        let dir = tempfile::tempdir().unwrap();
        let cancel = CancellationToken::new();
        cancel.cancel();
        let mut command = shell("touch started");
        command.current_dir(dir.path());
        assert!(run_query(command, &cancel, Duration::from_secs(5)).await.is_none());
        assert!(!dir.path().join("started").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn queries_keep_working_directories_and_environments_separate() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        std::fs::write(a.path().join("value"), "directory-a").unwrap();
        std::fs::write(b.path().join("value"), "directory-b").unwrap();
        let mut ca = shell("printf '%s:' \"$QUERY_VALUE\"; cat value");
        ca.current_dir(a.path()).env("QUERY_VALUE", "env-a");
        let mut cb = shell("printf '%s:' \"$QUERY_VALUE\"; cat value");
        cb.current_dir(b.path()).env("QUERY_VALUE", "env-b");
        let cancel = CancellationToken::new();
        let (a, b) = tokio::join!(
            run_query(ca, &cancel, Duration::from_secs(5)),
            run_query(cb, &cancel, Duration::from_secs(5)),
        );
        assert_eq!(a.unwrap(), b"env-a:directory-a");
        assert_eq!(b.unwrap(), b"env-b:directory-b");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_kills_and_reaps_the_query() {
        let dir = tempfile::tempdir().unwrap();
        let mut command = shell("echo $$ > pid; exec sleep 2");
        command.current_dir(dir.path());
        let output = run_query(command, &CancellationToken::new(), Duration::from_secs(1)).await;
        assert!(output.is_none());
        let pid = std::fs::read_to_string(dir.path().join("pid")).unwrap().trim().parse().unwrap();
        assert!(!ide_core::process::process_alive(pid));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_kills_the_running_query_and_its_child() {
        let dir = tempfile::tempdir().unwrap();
        let mut command = shell("sleep 30 & echo $$ $! > pids; wait");
        command.current_dir(dir.path());
        let cancel = CancellationToken::new();
        let token = cancel.clone();
        let task = tokio::spawn(async move { run_query(command, &token, Duration::from_secs(10)).await });
        let pids = dir.path().join("pids");
        tokio::time::timeout(Duration::from_secs(5), async {
            while !std::fs::read_to_string(&pids).is_ok_and(|s| s.split_whitespace().count() == 2) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let text = std::fs::read_to_string(pids).unwrap();
        let pids: Vec<u32> = text.split_whitespace().map(|p| p.parse().unwrap()).collect();
        cancel.cancel();
        assert!(task.await.unwrap().is_none());
        assert!(!ide_core::process::process_alive(pids[0]));
        // An orphaned child may remain a zombie until the host's init reaps it.
        #[cfg(target_os = "linux")]
        assert_stopped(pids[1]).await;
        #[cfg(not(target_os = "linux"))]
        tokio::time::timeout(Duration::from_secs(5), async {
            while ide_core::process::process_alive(pids[1]) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dropping_the_caller_still_reaps_its_query() {
        let dir = tempfile::tempdir().unwrap();
        let mut command = shell("sleep 30 & echo $$ $! > pid; wait");
        command.current_dir(dir.path());
        let task =
            tokio::spawn(async move { run_query(command, &CancellationToken::new(), Duration::from_secs(10)).await });
        let file = dir.path().join("pid");
        tokio::time::timeout(Duration::from_secs(5), async {
            while !std::fs::read_to_string(&file).is_ok_and(|s| s.split_whitespace().count() == 2) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let text = std::fs::read_to_string(file).unwrap();
        let pids: Vec<u32> = text.split_whitespace().map(|p| p.parse().unwrap()).collect();
        let pid = pids[0];
        task.abort();
        let _ = task.await;
        tokio::time::timeout(Duration::from_secs(5), async {
            while ide_core::process::process_alive(pid) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        #[cfg(target_os = "linux")]
        assert_stopped(pids[1]).await;
        #[cfg(not(target_os = "linux"))]
        tokio::time::timeout(Duration::from_secs(5), async {
            while ide_core::process::process_alive(pids[1]) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn timeout_cleans_up_a_child_holding_stdout_after_root_exit() {
        let dir = tempfile::tempdir().unwrap();
        let mut command = shell("sleep 30 & echo $! > pid; exit 0");
        command.current_dir(dir.path());
        assert!(run_query(command, &CancellationToken::new(), Duration::from_secs(1)).await.is_none());
        let pid = std::fs::read_to_string(dir.path().join("pid")).unwrap();
        assert_stopped(pid.trim().parse().unwrap()).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn output_at_the_limit_is_not_truncated() {
        let output = run_query(shell("head -c 8388608 /dev/zero"), &CancellationToken::new(), Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(output.len() as u64, OUTPUT_LIMIT);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn oversized_output_kills_the_query() {
        let dir = tempfile::tempdir().unwrap();
        let mut command = shell("echo $$ > pid; head -c 8388609 /dev/zero; exec sleep 30");
        command.current_dir(dir.path());
        assert!(run_query(command, &CancellationToken::new(), Duration::from_secs(5)).await.is_none());
        let pid = std::fs::read_to_string(dir.path().join("pid")).unwrap().trim().parse().unwrap();
        assert!(!ide_core::process::process_alive(pid));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn preserves_output_from_a_nonzero_exit() {
        assert_eq!(
            run_query(shell("printf partial; exit 1"), &CancellationToken::new(), Duration::from_secs(5))
                .await
                .unwrap(),
            b"partial"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn failed_spawn_does_not_poison_a_following_query() {
        assert!(
            run_query(Command::new("/no/such/go-query"), &CancellationToken::new(), Duration::from_secs(5))
                .await
                .is_none()
        );
        assert_eq!(
            run_query(shell("printf ok"), &CancellationToken::new(), Duration::from_secs(5)).await.unwrap(),
            b"ok"
        );
    }

    fn at(line: u32, from: u32, to: u32) -> Range {
        Range { start: Pos { line, col: from }, end: Pos { line, col: to } }
    }

    #[test]
    fn finds_required_modules_in_blocks_and_single_lines() {
        let text = "module example.com/m\n\ngo 1.24\n\nrequire github.com/a/b v1.0.0 // indirect\n\
                    require (\n\tgithub.com/c/d v1.2.0\n\t\"github.com/e/é\" v0.1.0 // indirect\n)\n\
                    // require github.com/x/y v1.0.0\nreplace github.com/c/d => ../d\ntool golang.org/x/tools/cmd/stringer\n";
        assert_eq!(
            required_modules(text),
            vec![
                Required { path: "github.com/a/b".into(), range: at(4, 8, 22) },
                Required { path: "github.com/c/d".into(), range: at(6, 1, 15) },
                Required { path: "github.com/e/é".into(), range: at(7, 2, 16) },
            ]
        );
    }

    #[test]
    fn reads_deprecations_from_the_go_list_stream() {
        let json = br#"{"Path": "github.com/golang/protobuf", "Version": "v1.5.4",
            "Deprecated": "Use the \"google.golang.org/protobuf\" module instead."}
            {"Path": "github.com/sergi/go-diff", "Version": "v1.3.1"}
            {"Path": "example.com/blank", "Deprecated": "  "}"#;
        assert_eq!(
            parse_deprecations(json),
            vec![(
                "github.com/golang/protobuf".to_owned(),
                "Use the \"google.golang.org/protobuf\" module instead.".to_owned()
            )]
        );
    }
}
