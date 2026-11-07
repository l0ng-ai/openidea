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
            use std::collections::BTreeMap;
            #[derive(Clone, Copy)]
            enum Change {
                Created,
                Modified,
                Removed,
            }
            use Change::*;
            let mut paths = BTreeMap::new();
            for (kind, entries) in
                [(Created, &previous.created), (Modified, &previous.modified), (Removed, &previous.removed)]
            {
                for path in entries {
                    paths.insert(path.clone(), kind);
                }
            }
            for (next, entries) in [(Created, &batch.created), (Modified, &batch.modified), (Removed, &batch.removed)] {
                for path in entries {
                    let kind = match (paths.get(path), next) {
                        (Some(Created), Created | Modified) => Created,
                        (Some(Removed), Created) | (Some(Modified), Created | Modified) => Modified,
                        (Some(Removed), Modified) => Removed,
                        (_, next) => next,
                    };
                    paths.insert(path.clone(), kind);
                }
            }
            *previous = FilesChanged::default();
            for (path, kind) in paths {
                match kind {
                    Created => previous.created.push(path),
                    Modified => previous.modified.push(path),
                    Removed => previous.removed.push(path),
                }
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

    fn files_changed_host(root: &Path) -> PluginHost {
        use super::super::Consent;
        let host =
            PluginHost::new(root.join("plugins"), Arc::new(|_: Option<&str>, _| {}), Default::default()).unwrap();
        host.set_workspace(Some(Arc::new(Workspace(root.to_path_buf()))));
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../ide-plugin/tests/fixtures/files-events");
        host.install_from_dir(&fixture, &Consent::all()).unwrap();
        host
    }

    fn delta(kind: usize, path: &str) -> WorkbenchEvent {
        let mut batch = FilesChanged::default();
        match kind {
            0 => batch.created.push(path.into()),
            1 => batch.modified.push(path.into()),
            _ => batch.removed.push(path.into()),
        }
        WorkbenchEvent::FilesChanged(batch)
    }

    #[test]
    fn files_changed_preserves_ordered_path_transitions() {
        for (first, next, expected) in
            [(0, 0, 0), (0, 1, 0), (0, 2, 2), (1, 0, 1), (1, 1, 1), (1, 2, 2), (2, 0, 1), (2, 1, 2), (2, 2, 2)]
        {
            let mut events = vec![delta(first, "/project/path")];
            append(&mut events, vec![delta(next, "/project/path")]);
            assert_eq!(events, [delta(expected, "/project/path")], "transition {first} -> {next}");
        }
        let mut events = vec![delta(0, "/project/transient"), delta(2, "/project/old-name")];
        append(&mut events, vec![delta(2, "/project/transient"), delta(0, "/project/new-name")]);
        append(&mut events, vec![delta(1, "/project/transient")]);
        // Seed through append too: one coalesced batch keeps both sides of a rename.
        let mut merged = vec![];
        append(&mut merged, events);
        assert_eq!(
            merged,
            [WorkbenchEvent::FilesChanged(FilesChanged {
                created: vec!["/project/new-name".into()],
                removed: vec!["/project/old-name".into(), "/project/transient".into()],
                ..Default::default()
            })]
        );
    }

    #[test]
    fn files_changed_stale_admission_cannot_replace_reopened_queue() {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        let host = files_changed_host(&root);
        let old = Arc::new(AtomicBool::new(true));
        let new = Arc::new(AtomicBool::new(true));
        let (entered, waiting) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            let host = &host;
            let old = &old;
            let root = &root;
            scope.spawn(move || {
                assert!(old.load(Ordering::Acquire));
                entered.send(()).unwrap();
                released.recv().unwrap();
                host.post_events_from(
                    Some("main"),
                    vec![delta(0, &to_ipc(&root.join("stale.rs")))],
                    Some(Source { active: Arc::downgrade(old) }),
                );
            });
            waiting.recv().unwrap();
            old.store(false, Ordering::Release);
            host.post_files_changed(
                "main",
                &root,
                &new,
                &ide_vfs::FsBatch { created: vec![root.join("new.rs")], ..Default::default() },
            );
            release.send(()).unwrap();
        });
        let queues = host.queues.lock();
        let queue = queues.values().next().expect("new session queue");
        assert!(queue.files_source.as_ref().unwrap().same(&Source { active: Arc::downgrade(&new) }));
        assert_eq!(queue.events, [delta(0, &to_ipc(&root.join("new.rs")))]);
    }

    #[test]
    fn files_changed_actor_mailbox_is_bounded_and_yields_to_commands() {
        use std::time::Duration;
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        let host = files_changed_host(&root);
        let plugin = host.get("files-events").unwrap();
        let (actor, _) = host.ensure_active(&plugin, Some("main")).unwrap();
        let (entered, waiting) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel();
        actor.post(
            move |_| {
                entered.send(()).unwrap();
                released.recv().unwrap();
                Ok(())
            },
            |_| {},
        );
        waiting.recv_timeout(Duration::from_secs(10)).unwrap();
        for i in 0..600 {
            host.post_events(Some("main"), vec![delta(i % 3, &to_ipc(&root.join(format!("path-{i}"))))]);
            host.flush_events();
        }
        let pending = plugin.batches.lock().pending;
        // A command gets a scheduling turn after one coalesced delivery.
        let command = actor.submit(None, move |rt| rt.run_command("events", None, Default::default())).unwrap();
        release.send(()).unwrap();
        let data = command.wait().unwrap().unwrap();
        assert_eq!(pending, 1, "flushes must not grow the actor job queue");
        let batches: Vec<FilesChanged> = serde_json::from_str(&data).unwrap();
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].created.len(), 200);
        assert_eq!(batches[0].modified.len(), 200);
        assert_eq!(batches[0].removed.len(), 200);
        assert!(host.wait_events(Duration::from_secs(10)));
    }

    #[test]
    fn files_changed_rechecks_filters_after_a_busy_actor_command() {
        use std::time::Duration;
        for globs in ["", "other/**", "config/*.yaml"] {
            let tmp = tempfile::tempdir().unwrap();
            let root = dunce::canonicalize(tmp.path()).unwrap();
            let host = files_changed_host(&root);
            let plugin = host.get("files-events").unwrap();
            let (actor, _) = host.ensure_active(&plugin, Some("main")).unwrap();
            let (entered, waiting) = std::sync::mpsc::channel();
            let (release, released) = std::sync::mpsc::channel();
            actor.post(
                move |_| {
                    entered.send(()).unwrap();
                    released.recv().unwrap();
                    Ok(())
                },
                |_| {},
            );
            waiting.recv_timeout(Duration::from_secs(10)).unwrap();
            let filter =
                actor.submit(None, move |rt| rt.run_command("filter", Some(globs), Default::default())).unwrap();
            host.post_events(
                Some("main"),
                vec![WorkbenchEvent::FilesChanged(FilesChanged {
                    created: vec![to_ipc(&root.join("config/a.yaml")), to_ipc(&root.join("src/a.rs"))],
                    modified: vec![to_ipc(&root.join("config/b.yaml"))],
                    removed: vec![to_ipc(&root.join("config/c.yaml"))],
                })],
            );
            host.flush_events();
            release.send(()).unwrap();
            filter.wait().unwrap();
            assert!(host.wait_events(Duration::from_secs(10)));
            let data = host.run_command("files-events", "events", None, Default::default()).unwrap();
            if globs == "config/*.yaml" {
                let batches: Vec<FilesChanged> = serde_json::from_str(&data.unwrap()).unwrap();
                assert_eq!(
                    batches,
                    [FilesChanged {
                        created: vec![to_ipc(&root.join("config/a.yaml"))],
                        modified: vec![to_ipc(&root.join("config/b.yaml"))],
                        removed: vec![to_ipc(&root.join("config/c.yaml"))],
                    }]
                );
            } else {
                assert_eq!(data, None, "excluded batches must not invoke the guest handler");
            }
        }
    }

    #[test]
    fn files_changed_delivery_honors_filters_registered_during_activation() {
        use super::super::Consent;
        use std::time::{Duration, Instant};
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        let host =
            PluginHost::new(root.join("plugins"), Arc::new(|_: Option<&str>, _| {}), Default::default()).unwrap();
        host.set_workspace(Some(Arc::new(Workspace(root.clone()))));
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../ide-plugin/tests/fixtures/path-events");
        let copy = root.join("activation-fixture");
        std::fs::create_dir_all(copy.join("dist")).unwrap();
        std::fs::write(
            copy.join("plugin.toml"),
            std::fs::read_to_string(fixture.join("plugin.toml"))
                .unwrap()
                .replace("[\"on-command:*\"]", "[\"on-command:*\", \"on-event:file-opened\"]"),
        )
        .unwrap();
        std::fs::copy(fixture.join("dist/plugin.wasm"), copy.join("dist/plugin.wasm")).unwrap();
        host.install_from_dir(&copy, &Consent::all()).unwrap();
        host.post_events(Some("main"), vec![WorkbenchEvent::FileOpened(to_ipc(&root.join("src/excluded.rs")))]);
        host.flush_events_at(Instant::now() + Duration::from_secs(3));
        assert!(host.wait_events(Duration::from_secs(10)));
        assert_eq!(host.run_command("test.path-events", "count", None, Default::default()).unwrap(), None);
    }

    #[test]
    fn files_changed_rechecks_runtime_unsubscribe_on_busy_actor() {
        use super::super::Consent;
        use std::time::Duration;
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        let host =
            PluginHost::new(root.join("plugins"), Arc::new(|_: Option<&str>, _| {}), Default::default()).unwrap();
        host.set_workspace(Some(Arc::new(Workspace(root.clone()))));
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../ide-plugin/tests/fixtures/files-events");
        let copy = root.join("runtime-fixture");
        std::fs::create_dir_all(copy.join("dist")).unwrap();
        std::fs::write(
            copy.join("plugin.toml"),
            std::fs::read_to_string(fixture.join("plugin.toml")).unwrap().replace(", \"on-event:files-changed\"", ""),
        )
        .unwrap();
        std::fs::copy(fixture.join("dist/plugin.wasm"), copy.join("dist/plugin.wasm")).unwrap();
        host.install_from_dir(&copy, &Consent::all()).unwrap();
        host.run_command("files-events", "filter", Some("**"), Default::default()).unwrap();
        let plugin = host.get("files-events").unwrap();
        let (actor, _) = host.ensure_active(&plugin, Some("main")).unwrap();
        let (entered, waiting) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel();
        actor.post(
            move |_| {
                entered.send(()).unwrap();
                released.recv().unwrap();
                Ok(())
            },
            |_| {},
        );
        waiting.recv_timeout(Duration::from_secs(10)).unwrap();
        let off = actor.submit(None, |rt| rt.run_command("unsubscribe", None, Default::default())).unwrap();
        host.post_events(Some("main"), vec![delta(0, &to_ipc(&root.join("excluded.rs")))]);
        host.flush_events();
        release.send(()).unwrap();
        off.wait().unwrap();
        assert!(host.wait_events(Duration::from_secs(10)));
        assert_eq!(host.run_command("files-events", "events", None, Default::default()).unwrap(), None);
    }

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
