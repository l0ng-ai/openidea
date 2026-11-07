//! Bridges configuration syntax to the app-owned JDT extension. No additional
//! language server, build, or network request is needed. Disk parsing runs on a
//! blocking worker; open buffers always win over cached disk contents.
use super::*;
use crate::text::Encoding;
use crate::types::{References, ReferencesIncomplete};
use crate::{DocSnap, Target};
use ide_core::{Location, Pos};
use ide_language::{ConfigurationKey, Syntax};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::SystemTime;

const COMMAND: &str = "openidea.java.configuration";
const MAX_BYTES: u64 = 2 * 1024 * 1024;
const MAX_FILES: usize = 2000;
const MAX_CACHED_KEYS: usize = 100_000;

#[derive(Default)]
pub(crate) struct ConfigurationCache {
    files: HashMap<PathBuf, CachedFile>,
}
struct CachedFile {
    stamp: (SystemTime, u64),
    keys: Vec<ConfigurationKey>,
}
#[derive(Deserialize)]
struct Pattern {
    name: String,
    relaxed: bool,
}
#[derive(Deserialize)]
struct Response {
    #[serde(default)]
    locations: Vec<lsp_types::Location>,
    #[serde(default)]
    keys: Vec<Pattern>,
    #[serde(default)]
    roots: Vec<String>,
    #[serde(default)]
    incomplete: bool,
}
fn syntax() -> &'static Syntax {
    static SYNTAX: OnceLock<Syntax> = OnceLock::new();
    SYNTAX.get_or_init(Syntax::new)
}
fn language(path: &Path) -> Option<LanguageId> {
    match path.extension()?.to_str()? {
        "yaml" | "yml" => Some(LanguageId::new("yaml")),
        "properties" => Some(LanguageId::new("properties")),
        // Spring XML wiring declares properties in `<prop key="...">` values
        // and placeholder-configurer `<property name="...">` entries.
        "xml" => Some(LanguageId::new("xml")),
        _ => None,
    }
}
fn parts(key: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut part = String::new();
    let mut chars = key.chars().peekable();
    let mut bracket = false;
    while let Some(ch) = chars.next() {
        match ch {
            '[' => {
                if !part.is_empty() {
                    out.push(std::mem::take(&mut part));
                }
                for ch in chars.by_ref() {
                    if ch == ']' {
                        break;
                    }
                    if !matches!(ch, '-' | '_') {
                        part.extend(ch.to_lowercase());
                    }
                }
                out.push(std::mem::take(&mut part));
                bracket = true;
            }
            '.' => {
                if !bracket {
                    out.push(std::mem::take(&mut part));
                }
                bracket = false;
            }
            '-' | '_' => {}
            ch => {
                part.extend(ch.to_lowercase());
                bracket = false;
            }
        }
    }
    if !part.is_empty() {
        out.push(part);
    }
    out
}
fn matches(pattern: &Pattern, key: &str) -> bool {
    if !pattern.relaxed {
        return pattern.name == key;
    }
    let (a, b) = (parts(&pattern.name), parts(key));
    a.len() == b.len() && a.iter().zip(b).all(|(a, b)| a == "*" || *a == b)
}

impl LspManager {
    pub(crate) async fn configuration_navigation(
        &self,
        snap: &DocSnap,
        pos: Pos,
        usages: bool,
        include_declaration: bool,
        cancel: &CancellationToken,
    ) -> IdeResult<Option<References>> {
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        let config = language(&snap.path).is_some();
        if !config && snap.language.as_str() != "java" {
            return Ok(None);
        }
        // Definition in ordinary Java code remains JDT's definition. Reverse
        // configuration navigation is offered only inside `@Value` / property
        // lookup arguments: the command builds a project-wide index, and every
        // Ctrl+click and Ctrl+hover probe would otherwise wait on it before JDT
        // answers. Field/config accessor usages are merged into Find Usages.
        if !config && !usages {
            let text = snap.text.as_str();
            if !text.contains("Value") && !text.contains("getProperty") && !text.contains("getRequiredProperty") {
                return Ok(None);
            }
            let text = text.to_owned();
            let cancelled = cancel.clone();
            let site = tokio::task::spawn_blocking(move || {
                syntax().java_configuration_site(&text, pos, &|| cancelled.is_cancelled())
            })
            .await
            .unwrap_or(false);
            if !site {
                return Ok(None);
            }
        }
        let key = if config {
            let text = snap.text.as_str().to_owned();
            if text.len() as u64 > MAX_BYTES {
                return Ok(None);
            }
            let lang = language(&snap.path).expect("configuration language");
            let cancelled = cancel.clone();
            tokio::task::spawn_blocking(move || {
                syntax()
                    .configuration_keys(&lang, &text, &|| cancelled.is_cancelled())
                    .ok()?
                    .into_iter()
                    .find(|key| key.range.start <= pos && pos < key.range.end)
                    .map(|key| key.name)
            })
            .await
            .ok()
            .flatten()
        } else {
            None
        };
        // A click inside a Spring `${name}` placeholder sits on a value, not a
        // key: the name names the property whose declaration lives in
        // configuration files or Spring XML, with Java binding members still
        // answering through the Java index.
        let placeholder = if config && key.is_none() && !usages && snap.text.as_str().len() as u64 <= MAX_BYTES {
            syntax().configuration_placeholder(snap.text.as_str(), pos)
        } else {
            None
        };
        let key = placeholder.clone().or(key);
        if config && key.is_none() {
            return Ok(None);
        }
        if config {
            // Avoid starting a JVM for unrelated YAML (CI, Kubernetes, etc.).
            let path = snap.path.clone();
            let root = self.project_root.clone();
            let java_project = tokio::task::spawn_blocking(move || {
                path.ancestors().take_while(|p| p.starts_with(&root)).any(|p| {
                    ["pom.xml", "build.gradle", "build.gradle.kts", ".classpath"]
                        .iter()
                        .any(|name| p.join(name).is_file())
                })
            })
            .await
            .unwrap_or(false);
            if !java_project {
                return Ok(None);
            }
        }
        let result =
            self.configuration_query(snap, pos, key, placeholder.is_some(), usages, include_declaration, cancel).await;
        match result {
            Err(e) if cancel.is_cancelled() || e.kind == ErrorKind::Cancelled => Err(IdeError::cancelled()),
            Err(e) => {
                tracing::debug!("Configuration navigation unavailable; retaining native language navigation: {e}");
                Ok(None)
            }
            result => result,
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn configuration_query(
        &self,
        snap: &DocSnap,
        pos: Pos,
        key: Option<String>,
        placeholder: bool,
        usages: bool,
        include_declaration: bool,
        cancel: &CancellationToken,
    ) -> IdeResult<Option<References>> {
        // A `${name}` reference resolves from configuration files and Spring
        // XML without Java; those declarations are collected first so
        // navigation survives an unavailable or outdated Java extension.
        let local = if placeholder {
            let name = key.clone().unwrap_or_default();
            Some(
                self.configuration_declarations(
                    vec![Pattern { name, relaxed: true }],
                    std::slice::from_ref(&self.project_root),
                    cancel,
                )
                .await?,
            )
        } else {
            None
        };
        let answered = local.as_ref().is_some_and(|local| !local.locations.is_empty());
        let (server, run) = match self.jdtls(&snap.path, cancel).await {
            Ok(found) => found,
            Err(e) if cancel.is_cancelled() || e.kind == ErrorKind::Cancelled => return Err(IdeError::cancelled()),
            Err(_) if answered => return Ok(local),
            Err(e) => return Err(e),
        };
        if !run.caps.read().commands().iter().any(|command| command == COMMAND) {
            return Ok(if placeholder { local } else { None });
        }
        let target = Target { server: server.clone(), run };
        let position = snap.text.ide_to_lsp(Encoding::Utf16, pos);
        let response: Response = match self
            .call(
                &target,
                "workspace/executeCommand",
                json!({
                    "command": COMMAND, "arguments": [snap.uri, key, position.line, position.character, usages, include_declaration]
                }),
                Some(cancel),
                crate::LONG_TIMEOUT,
            )
            .await
        {
            Ok(response) => response,
            Err(e) if cancel.is_cancelled() || e.kind == ErrorKind::Cancelled => return Err(IdeError::cancelled()),
            Err(_) if answered => return Ok(local),
            Err(e) => return Err(e),
        };
        if cancel.is_cancelled() {
            return Err(IdeError::cancelled());
        }
        if response.keys.is_empty() && !placeholder {
            return Ok(response
                .incomplete
                .then(|| References { incomplete: Some(ReferencesIncomplete::FilesSkipped), ..Default::default() }));
        }
        let mut result = References {
            locations: response.locations.iter().filter_map(|l| self.conv(Encoding::Utf16).location(l)).collect(),
            incomplete: response.incomplete.then_some(ReferencesIncomplete::FilesSkipped),
            ..Default::default()
        };
        self.note_virtual(&server, result.locations.iter().map(|l| l.uri.as_deref()));
        if let Some(local) = local {
            result.locations.extend(local.locations);
            result.incomplete = result.incomplete.or(local.incomplete);
        }
        if key.is_none() || usages {
            let roots: Vec<PathBuf> = response.roots.iter().filter_map(|uri| super::project_path(uri)).collect();
            let files = self.configuration_declarations(response.keys, &roots, cancel).await?;
            result.locations.extend(files.locations);
            result.incomplete = result.incomplete.or(files.incomplete);
        }
        if cancel.is_cancelled() || !self.docs.lock().values().any(|d| d.uri == snap.uri && d.version == snap.version) {
            return Err(IdeError::cancelled());
        }
        if usages && key.is_some() && !include_declaration {
            let source_path = self
                .docs
                .lock()
                .values()
                .find(|d| d.uri == snap.uri)
                .map(|d| d.canonical.clone())
                .unwrap_or_else(|| snap.path.clone());
            result.locations.retain(|location| {
                location.path.to_path_buf() != source_path || !(location.range.start <= pos && pos < location.range.end)
            });
        }
        crate::convert::dedup_locations(&mut result.locations);
        Ok(Some(result))
    }

    /// Configuration-file and Spring-XML declarations matching `patterns` under
    /// `roots`, with open editor contents taking precedence over disk.
    async fn configuration_declarations(
        &self,
        patterns: Vec<Pattern>,
        roots: &[PathBuf],
        cancel: &CancellationToken,
    ) -> IdeResult<References> {
        let overlays: HashMap<PathBuf, String> = self
            .docs
            .lock()
            .values()
            .filter(|d| language(&d.path).is_some() && d.text.as_str().len() as u64 <= MAX_BYTES)
            .map(|d| (d.canonical.clone(), d.text.as_str().to_owned()))
            .collect();
        let cache = self.configuration_cache.clone();
        let cancelled = cancel.clone();
        let roots = roots.to_vec();
        tokio::task::spawn_blocking(move || configuration_files(&roots, &patterns, &overlays, &cache, &cancelled))
            .await
            .map_err(|_| IdeError::unavailable("configuration search worker stopped"))
    }
}

fn in_module(root: &Path, path: &Path) -> bool {
    if !path.starts_with(root) {
        return false;
    }
    for parent in path.parent().into_iter().flat_map(Path::ancestors).take_while(|p| *p != root) {
        if matches!(
            parent.file_name().and_then(|n| n.to_str()),
            Some("target" | "build" | "node_modules" | ".git" | ".gradle")
        ) {
            return false;
        }
        if ["pom.xml", "build.gradle", "build.gradle.kts", ".classpath"].iter().any(|name| parent.join(name).is_file())
        {
            return false;
        }
    }
    true
}

fn configuration_files(
    roots: &[PathBuf],
    patterns: &[Pattern],
    overlays: &HashMap<PathBuf, String>,
    cache: &Mutex<ConfigurationCache>,
    cancel: &CancellationToken,
) -> References {
    let mut result = References::default();
    let mut paths = std::collections::BTreeSet::new();
    // Do not scan a source root twice when its enclosing module is also present.
    let roots: Vec<_> =
        roots.iter().filter(|root| !roots.iter().any(|other| other != *root && root.starts_with(other))).collect();
    for root in &roots {
        let module = (*root).clone();
        let walker = ignore::WalkBuilder::new(root)
            .follow_links(false)
            .filter_entry(move |entry| {
                if !entry.file_type().is_some_and(|t| t.is_dir()) {
                    return true;
                }
                if entry.path() == module {
                    return true;
                }
                if matches!(entry.file_name().to_str(), Some("target" | "build" | "node_modules" | ".git" | ".gradle"))
                {
                    return false;
                }
                // A sibling application's identical key must not leak into this module.
                !["pom.xml", "build.gradle", "build.gradle.kts", ".classpath"]
                    .iter()
                    .any(|name| entry.path().join(name).is_file())
            })
            .build();
        for (visited, entry) in walker.enumerate() {
            if cancel.is_cancelled() {
                return result;
            }
            if visited >= 50_000 || paths.len() >= MAX_FILES {
                result.incomplete = Some(ReferencesIncomplete::TooManyFiles);
                break;
            }
            match entry {
                Ok(entry) if entry.file_type().is_some_and(|t| t.is_file()) && language(entry.path()).is_some() => {
                    paths.insert(entry.into_path());
                }
                Err(_) => result.incomplete = Some(ReferencesIncomplete::FilesSkipped),
                _ => {}
            }
        }
    }
    paths.extend(overlays.keys().filter(|p| roots.iter().any(|r| in_module(r, p))).cloned());
    let mut cache = cache.lock();
    if cache.files.len() > MAX_FILES {
        cache.files.clear();
    }
    for path in paths {
        if cancel.is_cancelled() {
            return result;
        }
        let lang = language(&path).expect("configuration file");
        let keys = if let Some(text) = overlays.get(&path) {
            syntax().configuration_keys(&lang, text, &|| cancel.is_cancelled()).ok()
        } else {
            (|| {
                let metadata = std::fs::metadata(&path).ok()?;
                if metadata.len() > MAX_BYTES {
                    return None;
                }
                let stamp = (metadata.modified().ok()?, metadata.len());
                if let Some(file) = cache.files.get(&path).filter(|f| f.stamp == stamp) {
                    return Some(file.keys.clone());
                }
                let text = std::fs::read_to_string(&path).ok()?;
                let keys = syntax().configuration_keys(&lang, &text, &|| cancel.is_cancelled()).ok()?;
                cache.files.remove(&path);
                if cache.files.len() >= MAX_FILES
                    || cache.files.values().map(|file| file.keys.len()).sum::<usize>() + keys.len() > MAX_CACHED_KEYS
                {
                    cache.files.clear();
                }
                cache.files.insert(path.clone(), CachedFile { stamp, keys: keys.clone() });
                Some(keys)
            })()
        };
        match keys {
            Some(keys) => result.locations.extend(
                keys.into_iter()
                    .filter(|key| patterns.iter().any(|p| matches(p, &key.name)))
                    .map(|key| Location::file(path.clone(), key.range)),
            ),
            None => result.incomplete = Some(ReferencesIncomplete::FilesSkipped),
        }
        if result.locations.len() >= MAX_FILES {
            result.locations.truncate(MAX_FILES);
            result.incomplete = Some(ReferencesIncomplete::TooManyFiles);
            break;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn file_cache_tracks_edits_overlays_removals_and_limits() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().to_path_buf();
        let file = root.join("application.properties");
        std::fs::write(&file, "app.port=1\n").unwrap();
        let patterns = [Pattern { name: "app.port".into(), relaxed: true }];
        let cache = Mutex::new(ConfigurationCache::default());
        let cancel = CancellationToken::new();
        let query = |overlays: &HashMap<PathBuf, String>| {
            configuration_files(std::slice::from_ref(&root), &patterns, overlays, &cache, &cancel)
        };
        assert_eq!(query(&HashMap::new()).locations.len(), 1);
        std::fs::write(&file, "app.other=12\n").unwrap();
        assert!(query(&HashMap::new()).locations.is_empty());
        assert_eq!(query(&HashMap::from([(file.clone(), "app.port=unsaved\n".into())])).locations.len(), 1);
        std::fs::remove_file(&file).unwrap();
        assert!(query(&HashMap::new()).locations.is_empty());
        std::fs::write(&file, "x".repeat(MAX_BYTES as usize + 1)).unwrap();
        assert_eq!(query(&HashMap::new()).incomplete, Some(ReferencesIncomplete::FilesSkipped));
        cancel.cancel();
        assert!(query(&HashMap::new()).locations.is_empty());
    }

    #[test]
    fn relaxed_binding_keeps_boundaries() {
        let pattern = Pattern { name: "app.clients[*].timeOut".into(), relaxed: true };
        assert!(matches(&pattern, "app.clients[2].time-out"));
        assert!(!matches(&pattern, "app.clientsTimeOut"));
        let map = Pattern { name: "app.routes.*.url".into(), relaxed: true };
        assert!(matches(&map, "app.routes[us.east].url"));
        assert!(!matches(&map, "app.routes.us.east.url"));
        assert!(!matches(&Pattern { name: "app.time-out".into(), relaxed: false }, "app.timeOut"));
    }
}
