//! Automatic runtime provisioning belongs to the host, not SDK discovery.
use ide_core::{CancellationToken, IdeEvent, SharedSink, TaskId};
use ide_language::LanguageServerConfig;
use ide_sdk::java::{jdtls_jdks, jdtls_min_java, jdtls_runtime, language_server_runtimes_dir};
use parking_lot::{Condvar, Mutex};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Weak};
use std::time::Duration;

#[derive(Default)]
struct State {
    busy: bool,
    sinks: Vec<Weak<dyn ide_core::EventSink>>,
    attempted: HashSet<(PathBuf, u32)>,
}

#[derive(Default)]
struct Provisioner {
    state: Mutex<State>,
    changed: Condvar,
}

static PROVISIONER: LazyLock<Provisioner> = LazyLock::new(Provisioner::default);

fn needs_download(explicit: bool, suitable: bool, attempted: bool) -> bool {
    !explicit && !suitable && !attempted
}

impl Provisioner {
    fn subscribe(&self, sink: &SharedSink) {
        let mut state = self.state.lock();
        state.sinks.retain(|s| s.strong_count() > 0);
        let weak = Arc::downgrade(sink);
        if !state.sinks.iter().any(|s| s.ptr_eq(&weak)) {
            state.sinks.push(weak);
        }
    }

    fn emit(&self, event: IdeEvent) {
        let sinks: Vec<_> = self.state.lock().sinks.iter().filter_map(Weak::upgrade).collect();
        for sink in sinks {
            sink.emit(event.clone());
        }
    }

    fn run(&self, key: (PathBuf, u32), cancel: &CancellationToken, work: impl FnOnce()) {
        let mut state = self.state.lock();
        while state.busy && !cancel.is_cancelled() {
            self.changed.wait_for(&mut state, Duration::from_millis(100));
        }
        if cancel.is_cancelled() || !state.attempted.insert(key) {
            return;
        }
        state.busy = true;
        drop(state);
        // Even a panicking installer must release waiters and retain the attempt.
        struct Flight<'a>(&'a Provisioner);
        impl Drop for Flight<'_> {
            fn drop(&mut self) {
                self.0.state.lock().busy = false;
                self.0.changed.notify_all();
            }
        }
        let _flight = Flight(self);
        work();
    }
}

pub(crate) fn prepare(
    cfg: &LanguageServerConfig,
    data_dir: &Path,
    explicit: bool,
    sink: &SharedSink,
    launch_cancel: &CancellationToken,
) {
    let min_java = jdtls_min_java(cfg);
    let jdks = jdtls_jdks(min_java, data_dir);
    // A launch environment override is explicit too, even if it is invalid.
    if !needs_download(explicit || cfg.env.contains_key("JAVA_HOME"), jdtls_runtime(&jdks, min_java).is_some(), false) {
        return;
    }
    PROVISIONER.subscribe(sink);
    PROVISIONER.run((data_dir.to_path_buf(), min_java), launch_cancel, || {
        if jdtls_runtime(&jdtls_jdks(min_java, data_dir), min_java).is_some() {
            return;
        }
        let id = TaskId::next();
        let title = format!("Downloading Java {min_java} language server runtime");
        // Closing one project must not cancel a download other projects await.
        let cancel = CancellationToken::new();
        let _handle = ide_core::task::on_cancel(id, {
            let cancel = cancel.clone();
            move || cancel.cancel()
        });
        let emit = |message, fraction, done| {
            PROVISIONER.emit(IdeEvent::Task { id, title: title.clone(), message, fraction, done, cancellable: !done });
        };
        emit(Some("Eclipse Temurin".into()), None, false);
        let result = ide_tools::Tools::new(data_dir).download_java_runtime(
            min_java,
            &language_server_runtimes_dir(data_dir),
            &cancel,
            &|event| match event {
                ide_tools::InstallEvent::Line { text } => emit(Some(text), None, false),
                ide_tools::InstallEvent::Progress { fraction, message } => {
                    emit(Some(message), fraction.map(|f| f as f32), false)
                }
            },
        );
        emit(result.as_ref().err().map(ToString::to_string), Some(1.0), true);
        if let Err(error) = result {
            // The configuration hook retains the existing manual download action.
            tracing::warn!("automatic jdtls runtime download: {error}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn download_decision() {
        assert!(needs_download(false, false, false));
        for (explicit, suitable, attempted) in [(true, false, false), (false, true, false), (false, false, true)] {
            assert!(!needs_download(explicit, suitable, attempted));
        }
    }

    #[test]
    fn simultaneous_projects_share_one_attempt_and_failures_do_not_retry() {
        let provisioner = Provisioner::default();
        let calls = AtomicUsize::new(0);
        let barrier = std::sync::Barrier::new(8);
        std::thread::scope(|scope| {
            for _ in 0..8 {
                scope.spawn(|| {
                    barrier.wait();
                    provisioner.run((PathBuf::from("/data"), 25), &CancellationToken::new(), || {
                        calls.fetch_add(1, Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(30));
                    });
                });
            }
        });
        provisioner.run((PathBuf::from("/data"), 25), &CancellationToken::new(), || panic!("retried"));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn different_versions_are_still_single_flight() {
        let provisioner = Provisioner::default();
        let active = AtomicUsize::new(0);
        let calls = AtomicUsize::new(0);
        std::thread::scope(|scope| {
            for feature in [25, 26, 27] {
                let provisioner = &provisioner;
                let active = &active;
                let calls = &calls;
                scope.spawn(move || {
                    provisioner.run((PathBuf::from("/data"), feature), &CancellationToken::new(), || {
                        assert_eq!(active.fetch_add(1, Ordering::SeqCst), 0);
                        std::thread::sleep(Duration::from_millis(10));
                        calls.fetch_add(1, Ordering::SeqCst);
                        active.fetch_sub(1, Ordering::SeqCst);
                    });
                });
            }
        });
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn cancelled_waiter_does_not_consume_an_attempt() {
        let provisioner = Provisioner::default();
        let cancel = CancellationToken::new();
        cancel.cancel();
        provisioner.run((PathBuf::from("/data"), 25), &cancel, || panic!("cancelled"));
        assert!(provisioner.state.lock().attempted.is_empty());
    }
}
