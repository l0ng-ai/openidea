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

/// Queues `incoming`, folding a filesystem batch into the queued one it continues:
/// the project batch, or the watched-paths batch of the same project.
pub(super) fn append(events: &mut Vec<WorkbenchEvent>, incoming: Vec<WorkbenchEvent>) {
    for event in incoming {
        let previous = events.iter_mut().find_map(|queued| match (queued, &event) {
            (WorkbenchEvent::FilesChanged(previous), WorkbenchEvent::FilesChanged(_)) => Some(previous),
            (WorkbenchEvent::WatchedFilesChanged(previous), WorkbenchEvent::WatchedFilesChanged(batch))
                if previous.project == batch.project =>
            {
                Some(previous)
            }
            _ => None,
        });
        if let (WorkbenchEvent::FilesChanged(batch) | WorkbenchEvent::WatchedFilesChanged(batch), Some(previous)) =
            (&event, previous)
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
            let project = batch.project.clone().or_else(|| previous.project.clone());
            let generation = batch.generation.or(previous.generation);
            *previous = FilesChanged { project, generation, ..Default::default() };
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
        let created = paths(&batch.created);
        let modified = paths(&batch.modified);
        let removed = paths(&batch.removed);
        if created.is_empty() && modified.is_empty() && removed.is_empty() {
            return;
        }
        let generation = self.shared.bump_project_generation(root);
        let batch =
            FilesChanged { project: Some(to_ipc(root)), generation: Some(generation), created, modified, removed };
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
                root,
                &new,
                &ide_vfs::FsBatch { created: vec![root.join("new.rs")], ..Default::default() },
            );
            release.send(()).unwrap();
        });
        let queues = host.queues.lock();
        let queue = queues.values().next().expect("new session queue");
        assert!(queue.files_source.as_ref().unwrap().same(&Source { active: Arc::downgrade(&new) }));
        assert_eq!(
            queue.events,
            [WorkbenchEvent::FilesChanged(FilesChanged {
                project: Some(to_ipc(&root)),
                generation: Some(2),
                created: vec![to_ipc(&root.join("new.rs"))],
                ..Default::default()
            })]
        );
    }

    #[test]
    fn files_changed_restarts_after_an_actor_drops_queued_work() {
        use std::time::Duration;
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        let host = files_changed_host(&root);
        let plugin = host.get("files-events").unwrap();
        let (actor, _) = host.ensure_active(&plugin, Some("main")).unwrap();
        let (entered, waiting) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel();
        let crash = actor
            .submit(None, move |_| {
                entered.send(()).unwrap();
                released.recv().unwrap();
                Err::<(), _>(ide_plugin::CallError::Trap(ide_plugin::CANCELLED.into()))
            })
            .unwrap();
        waiting.recv_timeout(Duration::from_secs(10)).unwrap();
        host.post_events(Some("main"), vec![delta(0, &to_ipc(&root.join("discarded.rs")))]);
        host.flush_events();
        release.send(()).unwrap();
        assert!(crash.wait().is_err());
        host.flush_events();
        host.post_events(Some("main"), vec![delta(0, &to_ipc(&root.join("after-restart.rs")))]);
        host.flush_events();
        assert!(host.wait_events(Duration::from_secs(1)), "dropped actor work must not keep its mailbox alive");
        let data = host.run_command("files-events", "events", None, Default::default()).unwrap().unwrap();
        let batches: Vec<FilesChanged> = serde_json::from_str(&data).unwrap();
        assert_eq!(
            batches,
            [FilesChanged { created: vec![to_ipc(&root.join("after-restart.rs"))], ..Default::default() }]
        );
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
                    ..Default::default()
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
                        ..Default::default()
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
    fn files_changed_dropped_actor_job_releases_mailbox_before_restart() {
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
                Err::<(), _>(ide_plugin::CallError::Trap("test actor exit".into()))
            },
            |_| {},
        );
        waiting.recv_timeout(Duration::from_secs(10)).unwrap();
        host.post_events(Some("main"), vec![delta(0, &to_ipc(&root.join("dropped.rs")))]);
        host.flush_events();
        assert_eq!(plugin.batches.lock().pending, 1);
        release.send(()).unwrap();
        actor.stop(true);
        assert_eq!(plugin.batches.lock().pending, 0, "dropped closures must release their batch ticket");
        assert!(plugin.batches.lock().files_pending.is_empty());
        host.set_enabled("files-events", false).unwrap();
        host.set_enabled("files-events", true).unwrap();
        host.post_events(Some("main"), vec![delta(0, &to_ipc(&root.join("fresh.rs")))]);
        host.flush_events();
        assert!(host.wait_events(Duration::from_secs(10)));
        let data = host.run_command("files-events", "events", None, Default::default()).unwrap().unwrap();
        let batches: Vec<FilesChanged> = serde_json::from_str(&data).unwrap();
        assert_eq!(batches, [FilesChanged { created: vec![to_ipc(&root.join("fresh.rs"))], ..Default::default() }]);
    }

    #[test]
    fn files_changed_old_ticket_cannot_clear_successor_mailbox_or_running_state() {
        use super::super::{BatchTicket, Batches, PendingFiles};
        let batches = Arc::new(parking_lot::Mutex::new(Batches::default()));
        let key = (Some("main".into()), Some(PathBuf::from("/project")));
        let old = Arc::new(());
        let new = Arc::new(());
        let ticket = BatchTicket { batches: batches.clone(), files_key: Some(key.clone()), token: old };
        {
            let mut state = batches.lock();
            state.pending = 2;
            state.running = Some([ide_plugin::EventKind::FilesChanged].into());
            state.running_token = Some(new.clone());
            state.files_pending.insert(
                key.clone(),
                PendingFiles {
                    queue: super::super::EventQueue {
                        since: std::time::Instant::now(),
                        last_event: std::time::Instant::now(),
                        events: vec![delta(0, "/project/new")],
                        files_source: None,
                    },
                    actor: std::sync::Weak::new(),
                    token: new.clone(),
                },
            );
        }
        drop(ticket);
        let state = batches.lock();
        assert_eq!(state.pending, 1);
        assert!(Arc::ptr_eq(&state.files_pending[&key].token, &new));
        assert!(Arc::ptr_eq(state.running_token.as_ref().unwrap(), &new));
        assert!(state.running.is_some());
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
                    ..Default::default()
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
        fn apply_edits(
            &self,
            _: &Path,
            _: u64,
            _: &[ide_core::TextEdit],
            _: bool,
        ) -> Result<u64, ide_plugin::HostError> {
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
        let backend = crate::Host::new(crate::HostConfig::for_test(tmp.path()));
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
        assert_eq!(
            received,
            [FilesChanged {
                project: Some(to_ipc(&root)),
                generation: Some(3),
                created: vec![to_ipc(&root.join("new.rs"))],
                ..Default::default()
            }]
        );
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

    #[test]
    fn files_changed_debounce_coalesces_bursts_of_edits_without_repeated_delivery() {
        use super::super::event_paths::PathFilter;
        use std::time::Duration;
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        let host = files_changed_host(&root);
        host.shared.subscriptions.lock().set_paths(
            "files-events",
            "files-changed",
            PathFilter::with_debounce("files-changed", vec!["**/*".into()], Some(Duration::from_millis(80))).unwrap(),
        );

        let active = Arc::new(AtomicBool::new(true));
        // Post 3 bursts of file changes quickly within debounce window
        host.post_files_changed(
            "main",
            &root,
            &active,
            &ide_vfs::FsBatch { created: vec![root.join("file1.rs")], ..Default::default() },
        );
        host.flush_events();
        assert_eq!(host.instances(), 0, "first change must be debounced, not delivered immediately");

        std::thread::sleep(Duration::from_millis(20));
        host.post_files_changed(
            "main",
            &root,
            &active,
            &ide_vfs::FsBatch { modified: vec![root.join("file2.rs")], ..Default::default() },
        );
        host.flush_events();
        assert_eq!(host.instances(), 0, "second change within debounce window resets debounce");

        std::thread::sleep(Duration::from_millis(20));
        host.post_files_changed(
            "main",
            &root,
            &active,
            &ide_vfs::FsBatch { removed: vec![root.join("file3.rs")], ..Default::default() },
        );
        host.flush_events();
        assert_eq!(host.instances(), 0, "third change still debouncing");

        // Wait until debounce expires (> 80 ms since last event)
        std::thread::sleep(Duration::from_millis(100));
        host.flush_events();
        assert!(host.wait_events(Duration::from_secs(5)));

        let inv = ide_plugin::Invocation {
            client: Some("main".into()),
            workspace_root: Some(root.clone()),
            ..Default::default()
        };
        let data = host.run_command("files-events", "events", None, inv).unwrap().unwrap();
        let batches: Vec<FilesChanged> = serde_json::from_str(&data).unwrap();
        assert_eq!(batches.len(), 1, "rapid edit bursts must coalesce into exactly 1 batch");
        assert_eq!(batches[0].created, [to_ipc(&root.join("file1.rs"))]);
        assert_eq!(batches[0].modified, [to_ipc(&root.join("file2.rs"))]);
        assert_eq!(batches[0].removed, [to_ipc(&root.join("file3.rs"))]);
        assert_eq!(host.shared.project_generation(&root).unwrap(), 4);
    }

    struct MultiWorkspace(std::sync::Mutex<Vec<PathBuf>>);
    impl super::super::PluginWorkspace for MultiWorkspace {
        fn projects(&self) -> Vec<PathBuf> {
            self.0.lock().unwrap().clone()
        }
        fn buffer_text(&self, _: &Path) -> Option<String> {
            None
        }
        fn document(&self, _: &Path) -> Option<(u64, String)> {
            None
        }
        fn apply_edits(
            &self,
            _: &Path,
            _: u64,
            _: &[ide_core::TextEdit],
            _: bool,
        ) -> Result<u64, ide_plugin::HostError> {
            unreachable!()
        }
        fn trusted(&self, _: &Path) -> bool {
            true
        }
        fn project_of(&self, window: &str) -> Option<PathBuf> {
            let projects = self.0.lock().unwrap();
            match window {
                "main" => projects.first().cloned(),
                "other" => projects.get(1).cloned(),
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

    #[test]
    fn stale_run_target_registration_rejected_after_generation_bump() {
        use ide_plugin::HostError;
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        let host = files_changed_host(&root);
        let dummy = root.join("dummy");
        std::fs::write(&dummy, b"dummy").unwrap();
        host.shared.pins.write().insert(
            ("files-events".into(), "process:dummy".into()),
            ide_language::ProgramPin::approve(&dummy).unwrap(),
        );
        let plugin = host.get("files-events").unwrap();
        let api = super::super::api::PluginApi { pkg: plugin.pkg.clone(), shared: host.shared.clone() };

        let target = ide_plugin::PluginRunTarget {
            id: "target-1".into(),
            name: "Target 1".into(),
            program: "dummy".into(),
            args: vec!["test".into()],
            workdir_args: vec![],
            container_root: None,
            commands: vec![],
        };

        // Generation starts at 1
        let gen1 = host.shared.project_generation(&root).unwrap();
        assert_eq!(gen1, 1);

        // Registering with matching generation succeeds
        assert!(api.register_target(&root, target.clone(), Some(gen1)).is_ok());

        // Bump generation (simulating filesystem change or manual bump)
        let gen2 = host.shared.bump_project_generation(&root);
        assert_eq!(gen2, 2);

        // Registering with old generation is rejected with Stale
        let err = api.register_target(&root, target.clone(), Some(gen1)).unwrap_err();
        assert!(matches!(err, HostError::Stale));

        // Registering with new generation succeeds
        assert!(api.register_target(&root, target, Some(gen2)).is_ok());
    }

    #[test]
    fn project_isolation_and_project_closed_lifecycle() {
        let tmp = tempfile::tempdir().unwrap();
        let root_a = dunce::canonicalize(tmp.path()).unwrap().join("project_a");
        let root_b = dunce::canonicalize(tmp.path()).unwrap().join("project_b");
        std::fs::create_dir_all(&root_a).unwrap();
        std::fs::create_dir_all(&root_b).unwrap();
        let host = files_changed_host(&root_a);
        let ws = Arc::new(MultiWorkspace(std::sync::Mutex::new(vec![root_a.clone(), root_b.clone()])));
        host.set_workspace(Some(ws.clone()));

        let dummy = tmp.path().join("dummy");
        std::fs::write(&dummy, b"dummy").unwrap();
        host.shared.pins.write().insert(
            ("files-events".into(), "process:dummy".into()),
            ide_language::ProgramPin::approve(&dummy).unwrap(),
        );
        let plugin = host.get("files-events").unwrap();
        let api = super::super::api::PluginApi { pkg: plugin.pkg.clone(), shared: host.shared.clone() };

        let active_a = Arc::new(AtomicBool::new(true));
        let active_b = Arc::new(AtomicBool::new(true));

        // Post changes to Project A and B
        host.post_files_changed(
            "main",
            &root_a,
            &active_a,
            &ide_vfs::FsBatch { created: vec![root_a.join("a.rs")], ..Default::default() },
        );
        host.post_files_changed(
            "other",
            &root_b,
            &active_b,
            &ide_vfs::FsBatch { created: vec![root_b.join("b.rs")], ..Default::default() },
        );

        assert_eq!(host.shared.project_generation(&root_a).unwrap(), 2);
        assert_eq!(host.shared.project_generation(&root_b).unwrap(), 2);

        // Bumping project A does not bump project B
        let bump_a = host.shared.bump_project_generation(&root_a);
        assert_eq!(bump_a, 3);
        assert_eq!(host.shared.project_generation(&root_b).unwrap(), 2);

        // Register target for project A and B
        let target = ide_plugin::PluginRunTarget {
            id: "run".into(),
            name: "Run".into(),
            program: "dummy".into(),
            args: vec![],
            workdir_args: vec![],
            container_root: None,
            commands: vec![],
        };
        assert!(api.register_target(&root_a, target.clone(), None).is_ok());
        assert!(api.register_target(&root_b, target.clone(), None).is_ok());

        assert_eq!(host.run_targets(&root_a).len(), 1);
        assert_eq!(host.run_targets(&root_b).len(), 1);

        // Close project A
        ws.0.lock().unwrap().retain(|p| p != &root_a);
        host.project_closed(&root_a, "main");

        // Project A targets withdrawn, Project B untouched
        assert!(host.run_targets(&root_a).is_empty());
        assert_eq!(host.run_targets(&root_b).len(), 1);

        // Project A generation closed (NotFound on lookup), Project B intact
        assert!(host.shared.project_generation(&root_a).is_err());
        assert_eq!(host.shared.project_generation(&root_b).unwrap(), 2);
    }
}
