//! Repository version lookups for manifest inspections and completion.
use crate::{Host, rpc::Dispatcher};
use ide_core::{CancellationToken, DocId, IdeError, IdeResult, RequestId};
use ide_workspace::dependencies::{DependencyVersionSource, DependencyVersions, cargo};

struct CratesIo;
impl DependencyVersionSource for CratesIo {
    fn id(&self) -> &'static str {
        "crates-io"
    }

    fn fetch(&self, package: &str, cancel: &CancellationToken) -> IdeResult<Vec<String>> {
        let path = cargo::index_path(package).ok_or_else(|| IdeError::internal("invalid crate name"))?;
        let search_path = std::env::var_os("PATH").unwrap_or_default();
        let text = ide_tools::Http::new(&search_path)?.https_only().get_text_limited(
            &format!("https://index.crates.io/{path}"),
            Some(16 * 1024 * 1024),
            cancel,
        )?;
        cargo::parse_index(&text).ok_or_else(|| IdeError::internal("invalid sparse index"))
    }
}

/// `offset` limits a completion request to its version string; inspections omit it.
pub async fn dependency_versions(
    host: &Host,
    window: &str,
    doc: DocId,
    offset: Option<u32>,
    request: RequestId,
) -> IdeResult<Vec<DependencyVersions>> {
    let project = host.project(window)?;
    let cache = host.dependency_versions.clone();
    let cancel = host.begin_request(request);
    let result = host
        .blocking(move || {
            let snap = project.documents.snapshot(doc)?;
            if snap.large || snap.read_only || snap.path.file_name().is_none_or(|n| n != "Cargo.toml") {
                return Ok(Vec::new());
            }
            let mut out = Vec::new();
            for dependency in cargo::dependencies(&snap.text) {
                if offset.is_some_and(|pos| pos < dependency.from || pos > dependency.to) {
                    continue;
                }
                if cancel.is_cancelled() {
                    return Err(IdeError::cancelled());
                }
                let versions = cache.versions(&CratesIo, &dependency.package, &cancel)?;
                let update = cargo::update(&dependency.requirement, &versions);
                out.push(DependencyVersions { dependency, versions, update });
            }
            Ok(out)
        })
        .await;
    host.end_request(request);
    result
}

pub(crate) fn register(d: &mut Dispatcher) {
    d.add("dependency_versions", |c| async move {
        dependency_versions(&c.host, &c.window, c.arg("doc")?, c.arg("offset")?, c.arg("request")?).await
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::HostConfig;
    use std::sync::Arc;

    struct Source;
    impl DependencyVersionSource for Source {
        fn id(&self) -> &'static str {
            "crates-io"
        }
        fn fetch(&self, _: &str, _: &CancellationToken) -> IdeResult<Vec<String>> {
            Ok(vec!["1.10.0".into(), "0.2.1".into()])
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn host_uses_synced_document_cache_and_cursor_filter_without_network() {
        let temp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(temp.path()).unwrap();
        let root = base.join("project");
        std::fs::create_dir(&root).unwrap();
        let text = "# 中文 😀\n[dependencies]\ntokio = { version = \"0.2\", features = [\"full\"] }\nserde = \"1.0.100\"\nlocal = { path = \"../x\", version = \"0.2\" }\n";
        let path = root.join("Cargo.toml");
        std::fs::write(&path, text).unwrap();
        let host = Host::new(HostConfig {
            config_dir: base.join("config"),
            data_dir: base.join("data"),
            local_data_dir: base.join("local"),
            languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
            syntax: Arc::default(),
            sink_for: Box::new(|_| Arc::new(|_| {})),
            owner: |w| w,
            runtime: tokio::runtime::Handle::current(),
            project_environment: false,
        });
        let project = host.open_project("main", &root).unwrap();
        let info = project.documents.open(&path).unwrap();
        for package in ["tokio", "serde"] {
            host.dependency_versions.versions(&Source, package, &CancellationToken::new()).unwrap();
        }
        let all = dependency_versions(&host, "main", info.id, None, RequestId(410)).await.unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].update.as_ref().unwrap().replacement, "1.10");
        assert!(all[1].update.is_none());
        let offset = all[1].dependency.from;
        let at_cursor = dependency_versions(&host, "main", info.id, Some(offset), RequestId(411)).await.unwrap();
        assert_eq!(at_cursor.len(), 1);
        assert_eq!(at_cursor[0].dependency.package, "serde");
        assert!(dependency_versions(&host, "main", info.id, Some(0), RequestId(412)).await.unwrap().is_empty());
        host.cancel_request(RequestId(413));
        assert!(dependency_versions(&host, "main", info.id, None, RequestId(413)).await.is_err());
        let other = root.join("other.toml");
        std::fs::write(&other, text).unwrap();
        let info = project.documents.open(&other).unwrap();
        assert!(dependency_versions(&host, "main", info.id, None, RequestId(414)).await.unwrap().is_empty());
        host.close_project("main");
    }
}
