//! go.mod as GoLand shows it: available upgrades, vulnerabilities and deprecated modules are
//! reported as soon as the file is opened. gopls reports upgrades only from its "Check for
//! upgrades" code lens, so that runs once per go.mod and session; its results (and the
//! vulnerabilities from the `vulncheck` setting) come back as gopls diagnostics with quick fixes.
//! gopls never reports a deprecated module, so `go list -m -u` does, on open and on save.

use crate::LspManager;
use crate::server::Server;
use ide_core::{DocId, Pos, Range};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

pub(crate) const CHECK_UPGRADES: &str = "gopls.check_upgrades";
/// gopls answers code lenses once it has loaded the module.
const ATTEMPTS: u32 = 10;
const RETRY: Duration = Duration::from_secs(2);
/// Producer of the deprecation diagnostics (one full set per go.mod).
const DEPRECATIONS: &str = "go-mod-deprecations";

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
        let listed = tokio::task::spawn_blocking(move || list_deprecations(&dir, &search, &modules)).await;
        let Ok(Some(deprecated)) = listed else { return };
        // The document changed meanwhile: its own save runs again.
        if self.docs.lock().get(&doc).is_none_or(|d| d.text.as_str() != text) {
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
fn list_deprecations(dir: &Path, search: &std::ffi::OsStr, modules: &[String]) -> Option<Vec<(String, String)>> {
    let go: PathBuf = ide_core::tool_path::find_command("go", search, dir)?;
    let output = ide_core::process::prepare(&mut std::process::Command::new(go))
        .args(["list", "-m", "-u", "-e", "-json"])
        .args(modules)
        .current_dir(dir)
        .env("PATH", search)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if output.stdout.is_empty() {
        tracing::debug!("go list -m -u in {}: {}", dir.display(), output.status);
        return None;
    }
    Some(parse_deprecations(&output.stdout))
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
