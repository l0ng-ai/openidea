//! Filesystem batches retain their project incarnation until delivery.
use super::{PluginHost, WorkbenchEvent};
use ide_core::ipc_path::to_ipc;
use ide_plugin::FilesChanged;
use std::path::{Path, PathBuf};
use std::sync::{
    Arc, Weak,
    atomic::{AtomicBool, Ordering},
};

#[derive(Clone)]
pub(super) struct Source {
    active: Weak<AtomicBool>,
}

impl Source {
    pub fn same(&self, other: &Self) -> bool {
        self.active.ptr_eq(&other.active)
    }
    fn live(&self) -> bool {
        self.active.upgrade().is_some_and(|active| active.load(Ordering::Acquire))
    }
}

pub(super) fn retain_live(events: &mut Vec<WorkbenchEvent>, source: Option<&Source>) {
    if source.is_some_and(|source| !source.live()) {
        events.retain(|e| !matches!(e, WorkbenchEvent::FilesChanged(_)));
    }
}

pub(super) fn append(events: &mut Vec<WorkbenchEvent>, incoming: Vec<WorkbenchEvent>) {
    for event in incoming {
        if let WorkbenchEvent::FilesChanged(batch) = &event
            && let Some(WorkbenchEvent::FilesChanged(previous)) =
                events.iter_mut().find(|e| matches!(e, WorkbenchEvent::FilesChanged(_)))
        {
            for (target, paths) in [
                (&mut previous.created, &batch.created),
                (&mut previous.modified, &batch.modified),
                (&mut previous.removed, &batch.removed),
            ] {
                target.extend(paths.iter().cloned());
                target.sort_unstable();
                target.dedup();
            }
        } else {
            events.push(event);
        }
    }
}

impl PluginHost {
    pub(crate) fn post_files_changed(
        &self,
        client: &str,
        root: &Path,
        active: &Arc<AtomicBool>,
        batch: &ide_vfs::FsBatch,
    ) {
        if !active.load(Ordering::Acquire) || self.shared.project_of(client).as_deref() != Some(root) {
            return;
        }
        let paths =
            |paths: &[PathBuf]| paths.iter().filter(|p| p.starts_with(root)).map(|p| to_ipc(p)).collect::<Vec<_>>();
        let batch = FilesChanged {
            created: paths(&batch.created),
            modified: paths(&batch.modified),
            removed: paths(&batch.removed),
        };
        if batch.created.is_empty() && batch.modified.is_empty() && batch.removed.is_empty() {
            return;
        }
        self.post_events_from(
            Some(client),
            vec![WorkbenchEvent::FilesChanged(batch)],
            Some(Source { active: Arc::downgrade(active) }),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_runtime_event_has_a_matching_manifest_activation() {
        for kind in ide_plugin::EventKind::ALL {
            if kind != ide_plugin::EventKind::Scheduled {
                assert!(ide_extension::EVENT_KINDS.contains(&kind.name()));
            }
        }
        for kind in ide_extension::EVENT_KINDS {
            assert!(ide_plugin::EventKind::parse(kind).is_some());
        }
    }

    #[test]
    fn batches_coalesce_without_losing_categories_or_paths() {
        let mut events = vec![];
        for i in 0..600 {
            append(
                &mut events,
                vec![WorkbenchEvent::FilesChanged(FilesChanged {
                    created: vec![format!("/project/{i}")],
                    modified: vec!["/project/shared".into()],
                    removed: vec!["/project/gone".into()],
                })],
            );
        }
        let [WorkbenchEvent::FilesChanged(batch)] = events.as_slice() else { panic!("one coalesced batch") };
        assert_eq!(batch.created.len(), 600);
        assert_eq!(batch.modified, ["/project/shared"]);
        assert_eq!(batch.removed, ["/project/gone"]);
    }

    #[test]
    fn closed_incarnations_drop_only_filesystem_events() {
        let active = Arc::new(AtomicBool::new(true));
        let source = Source { active: Arc::downgrade(&active) };
        let mut events = vec![WorkbenchEvent::FilesChanged(FilesChanged::default()), WorkbenchEvent::Scheduled];
        retain_live(&mut events, Some(&source));
        assert_eq!(events.len(), 2);
        active.store(false, Ordering::Release);
        retain_live(&mut events, Some(&source));
        assert_eq!(events, [WorkbenchEvent::Scheduled]);
        assert!(!source.same(&Source { active: Arc::downgrade(&Arc::new(AtomicBool::new(true))) }));
    }
    struct Workspace(PathBuf);
    impl super::super::PluginWorkspace for Workspace {
        fn projects(&self) -> Vec<PathBuf> {
            vec![self.0.clone(), self.0.join("other")]
        }
        fn buffer_text(&self, _: &Path) -> Option<String> {
            None
        }
        fn document(&self, _: &Path) -> Option<(u64, String)> {
            None
        }
        fn apply_edits(&self, _: &Path, _: u64, _: &[ide_core::TextEdit]) -> Result<u64, ide_plugin::HostError> {
            unreachable!()
        }
        fn trusted(&self, _: &Path) -> bool {
            true
        }
        fn project_of(&self, window: &str) -> Option<PathBuf> {
            match window {
                "main" => Some(self.0.clone()),
                "other" => Some(self.0.join("other")),
                _ => None,
            }
        }
        fn publish_diagnostics(
            &self,
            _: &str,
            _: &Path,
            _: Vec<ide_core::Diagnostic>,
        ) -> Result<(), ide_plugin::HostError> {
            Ok(())
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn host_shutdown_discards_queued_filesystem_batches() {
        use super::super::Consent;
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap().join("project");
        std::fs::create_dir(&root).unwrap();
        let backend = crate::Host::new(crate::HostConfig {
            config_dir: tmp.path().join("config"),
            data_dir: tmp.path().join("data"),
            local_data_dir: tmp.path().join("data"),
            languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
            syntax: Arc::default(),
            sink_for: Box::new(|_| Arc::new(ide_core::NullSink)),
            owner: |window| window,
            runtime: tokio::runtime::Handle::current(),
            project_environment: false,
        });
        backend.open_project("main", &root).unwrap();
        let active = backend.project("main").unwrap().files_events_active.clone();
        let plugins =
            PluginHost::new(tmp.path().join("plugins"), Arc::new(|_: Option<&str>, _| {}), Default::default()).unwrap();
        plugins.set_workspace(Some(Arc::new(Workspace(root.clone()))));
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../ide-plugin/tests/fixtures/files-events");
        plugins.install_from_dir(&fixture, &Consent::all()).unwrap();
        let batch = ide_vfs::FsBatch { created: vec![root.join("new.rs")], ..Default::default() };
        plugins.post_files_changed("main", &root, &active, &batch);
        assert!(!plugins.queues.lock().is_empty());
        backend.shutdown().await;
        plugins.flush_events();
        assert_eq!(plugins.instances(), 0, "host shutdown must discard queued filesystem batches");
        plugins.post_files_changed("main", &root, &active, &batch);
        assert!(plugins.queues.lock().is_empty(), "a retained watcher cannot post after host shutdown");
    }

    #[test]
    fn producer_respects_project_incarnation_window_and_dev_root() {
        use super::super::{Consent, PluginSource};
        use std::time::Duration;
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        std::fs::create_dir(root.join("other")).unwrap();
        let host =
            PluginHost::new(root.join("plugins"), Arc::new(|_: Option<&str>, _| {}), Default::default()).unwrap();
        host.set_workspace(Some(Arc::new(Workspace(root.clone()))));
        host.set_project_policy(Arc::new(|_| true));
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../ide-plugin/tests/fixtures/files-events");
        host.load_dir(&fixture, PluginSource::Dev, Some(root.clone()));
        host.grant("files-events", &Consent::all()).unwrap();
        let active = Arc::new(AtomicBool::new(true));
        let batch = ide_vfs::FsBatch {
            created: vec![root.join("new.rs"), root.parent().unwrap().join("outside.rs")],
            ..Default::default()
        };
        host.post_files_changed("closed", &root, &active, &batch);
        host.post_files_changed("main", &root.join("wrong"), &active, &batch);
        host.post_files_changed(
            "other",
            &root.join("other"),
            &active,
            &ide_vfs::FsBatch { modified: vec![root.join("other/a.rs")], ..Default::default() },
        );
        host.post_files_changed(
            "main",
            &root,
            &active,
            &ide_vfs::FsBatch {
                vcs: vec![root.join(".git/HEAD")],
                ignored: vec![root.join(".env")],
                ..Default::default()
            },
        );
        host.flush_events();
        assert_eq!(host.instances(), 0, "unrelated windows, roots, and metadata do not wake a dev plugin");
        host.post_files_changed("main", &root, &active, &batch);
        active.store(false, Ordering::Release);
        host.flush_events();
        assert_eq!(host.instances(), 0, "closing before delivery discards the batch");
        host.post_files_changed("main", &root, &active, &batch);
        assert!(host.queues.lock().is_empty(), "a closing watcher cannot post more events");
        let reopened = Arc::new(AtomicBool::new(true));
        host.post_files_changed("main", &root, &reopened, &batch);
        host.flush_events();
        assert!(host.wait_events(Duration::from_secs(10)));
        let inv = ide_plugin::Invocation {
            client: Some("main".into()),
            workspace_root: Some(root.clone()),
            ..Default::default()
        };
        let data = host.run_command("files-events", "events", None, inv).unwrap().unwrap();
        let received: Vec<FilesChanged> = serde_json::from_str(&data).unwrap();
        assert_eq!(received, [FilesChanged { created: vec![to_ipc(&root.join("new.rs"))], ..Default::default() }]);
    }
    #[test]
    fn queued_filter_replacement_and_pause_do_not_activate() {
        use super::super::{Consent, event_paths::PathFilter};
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        let host =
            PluginHost::new(root.join("plugins"), Arc::new(|_: Option<&str>, _| {}), Default::default()).unwrap();
        host.set_workspace(Some(Arc::new(Workspace(root.clone()))));
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../ide-plugin/tests/fixtures/files-events");
        host.install_from_dir(&fixture, &Consent::all()).unwrap();
        let active = Arc::new(AtomicBool::new(true));
        let filter = |globs: Vec<String>| {
            host.shared.subscriptions.lock().set_paths(
                "files-events",
                "files-changed",
                PathFilter::new("files-changed", globs).unwrap(),
            );
        };
        let batch = ide_vfs::FsBatch {
            created: vec![root.join("config/a.yaml"), root.join("src/unrelated.rs")],
            modified: vec![root.join("config/b.yaml")],
            removed: vec![root.join("config/c.yaml")],
            ..Default::default()
        };
        filter(vec!["config/*.yaml".into()]);
        host.post_files_changed("main", &root, &active, &batch);
        assert!(!host.queues.lock().is_empty());
        filter(vec!["src/**".into()]);
        host.flush_events();
        assert_eq!(host.instances(), 0, "replacement excludes paths already queued");
        filter(vec!["config/*.yaml".into()]);
        host.post_files_changed("main", &root, &active, &batch);
        filter(vec![]);
        host.flush_events();
        assert_eq!(host.instances(), 0, "pausing suppresses a queued batch before activation");
        host.post_files_changed("main", &root, &active, &batch);
        assert!(host.queues.lock().is_empty(), "paused paths never queue work");
    }
}
