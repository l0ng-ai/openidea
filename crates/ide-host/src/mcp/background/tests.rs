use super::*;
use crate::HostConfig;
use ide_workspace::SettingsScope;
use serde_json::json;

const MINUTE: Duration = Duration::from_secs(60);
const SECOND: Duration = Duration::from_secs(1);

/// A host with the MCP server on that serves the folders `inventory`, `billing` and
/// `orders` as listed background projects; no window is open.
struct Fixture {
    host: Arc<Host>,
    base: PathBuf,
    syntax: Arc<std::sync::OnceLock<Arc<ide_language::Syntax>>>,
    _tmp: tempfile::TempDir,
}

/// The grammars' warm-up, held unfinished as at start-up until this is dropped. Every open
/// waits for it after it has read the settings and the trust decision, before it registers
/// its project.
struct WarmUp(#[expect(dead_code, reason = "dropping it ends the warm-up")] std::sync::mpsc::Sender<()>);

/// Returns once `done` holds; no later than half a minute from now.
fn wait_until(what: &str, done: impl Fn() -> bool) {
    let deadline = Instant::now() + 30 * SECOND;
    while !done() {
        assert!(Instant::now() < deadline, "{what}");
        std::thread::yield_now();
    }
}

/// Long enough to tell work that waits from work that has finished.
const A_MOMENT: Duration = Duration::from_millis(300);

impl Fixture {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(tmp.path()).unwrap();
        for name in ["inventory", "billing", "orders"] {
            std::fs::create_dir_all(base.join(name).join("parts")).unwrap();
            std::fs::write(base.join(name).join("notes.txt"), "stock\n").unwrap();
        }
        let syntax: Arc<std::sync::OnceLock<Arc<ide_language::Syntax>>> = Arc::default();
        let host = Arc::new(Host::new(HostConfig {
            config_dir: base.join("config"),
            data_dir: base.join("data"),
            local_data_dir: base.join("local"),
            languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
            syntax: syntax.clone(),
            sink_for: Box::new(|_| Arc::new(|_| {})),
            owner: |w| w,
            runtime: tokio::runtime::Handle::current(),
            project_environment: false,
        }));
        let fixture = Self { host, base, syntax, _tmp: tmp };
        fixture.set("enabled", json!(true));
        fixture.set("backgroundProjects", json!("listed"));
        fixture.list(&["inventory", "billing", "orders"]);
        fixture
    }

    fn set(&self, key: &str, value: serde_json::Value) {
        self.host.global_settings.set(SettingsScope::Global, &format!("mcpServer.{key}"), value).unwrap();
    }

    fn list(&self, names: &[&str]) {
        self.set("backgroundProjectPaths", json!(names.iter().map(|name| self.root(name)).collect::<Vec<_>>()));
    }

    fn root(&self, name: &str) -> PathBuf {
        self.base.join(name)
    }

    fn background(&self) -> &BackgroundProjects {
        &self.host.mcp_background
    }

    fn open(&self, name: &str) -> Arc<Project> {
        self.background().open(&self.host, &self.root(name)).expect("the project is served").1
    }

    /// A tool call that reached the project `name` and has not ended yet.
    fn call(&self, name: &str) -> ActivityGuard {
        let (_, _, call) = self.background().open(&self.host, &self.root(name)).expect("the project is served");
        call.expect("in the background")
    }

    fn hold_warm_up(&self) -> WarmUp {
        let (started, holding) = std::sync::mpsc::channel();
        let (finish, finished) = std::sync::mpsc::channel::<()>();
        let syntax = self.syntax.clone();
        std::thread::spawn(move || {
            syntax.get_or_init(|| {
                // Both ends hang up when the test is over.
                let _ = started.send(());
                let _ = finished.recv();
                Arc::new(ide_language::Syntax::new())
            });
        });
        holding.recv_timeout(30 * SECOND).expect("the warm-up starts");
        WarmUp(finish)
    }

    /// A client's first call for `name` on another thread, once its open is under way.
    fn open_in_flight(&self, name: &str) -> tokio::task::JoinHandle<Arc<Project>> {
        let (host, root) = (self.host.clone(), self.root(name));
        let open = tokio::task::spawn_blocking(move || host.mcp_background.open(&host, &root).expect("served").1);
        wait_until("the open is under way", || self.background().gate.is_locked());
        open
    }

    /// Whether an open has read its settings and trust decision: Local History, which it
    /// creates next, is there.
    fn an_open_has_read_its_decisions(&self) -> bool {
        std::fs::read_dir(self.base.join("data/history")).is_ok_and(|mut entries| entries.next().is_some())
    }

    fn refused(&self, name: &str) -> String {
        self.background().open(&self.host, &self.root(name)).err().expect("the open is refused").message
    }

    fn snapshot(&self) -> Vec<McpBackgroundProject> {
        self.background().snapshot(&self.host, Instant::now())
    }

    /// The folder names of the loaded projects, sorted.
    fn loaded(&self) -> Vec<String> {
        let name = |project: McpBackgroundProject| project.root.0.file_name().unwrap().to_string_lossy().into_owned();
        self.snapshot().into_iter().map(name).collect()
    }

    fn held_by(&self, name: &str) -> Option<McpBackgroundHold> {
        let root = self.root(name);
        self.snapshot().into_iter().find(|project| project.root.0 == root).unwrap().kept_open_by
    }

    fn used(&self, name: &str) -> Instant {
        *self.background().state.lock().entries[&self.root(name)].last_used.lock()
    }

    fn claims(&self, name: &str) -> usize {
        self.background().state.lock().claims.get(&self.root(name)).copied().unwrap_or(0)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Waits for each shutdown, so nothing still works in the folder when it is deleted.
        for (root, _) in self.background().entries() {
            self.host.close_project(&BackgroundProjects::key(&root));
        }
        self.host.close_project("main");
    }
}

/// Returns once the clock reads later than `time`, so the next reading is strictly after it.
fn tick_past(time: Instant) {
    while Instant::now() <= time {
        std::hint::spin_loop();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_first_call_opens_a_project_under_its_key_and_the_next_one_reuses_it() {
    let f = Fixture::new();
    let root = f.root("inventory");
    let (key, project, _) = f.background().open(&f.host, &root).unwrap();
    assert_eq!(key, format!("mcp:{}", root.display()));
    assert!(BackgroundProjects::is_key(&key));
    assert!(!BackgroundProjects::is_key("main") && !BackgroundProjects::is_key("settings-main"));
    assert_eq!(project.root, root);
    assert!(Arc::ptr_eq(&f.host.project(&key).unwrap(), &project));
    assert!(!project.is_trusted(), "a listed folder nobody trusted opens in Restricted Mode");
    let (_, again, _) = f.background().open(&f.host, &root).unwrap();
    assert!(Arc::ptr_eq(&again, &project));
    assert_eq!(f.loaded(), ["inventory"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_root_the_settings_do_not_serve_is_refused_and_nothing_opens() {
    let f = Fixture::new();
    f.list(&["billing"]);
    let root = f.root("inventory");
    assert_eq!(f.refused("inventory"), format!("{} is not served in the background", root.display()));
    // A folder inside a served root is not a root itself.
    assert!(f.refused("billing/parts").contains("is not served in the background"));
    f.set("backgroundProjects", json!("off"));
    assert!(f.refused("billing").contains("is not served in the background"));
    assert!(f.loaded().is_empty());
    assert!(f.host.projects().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_call_in_flight_holds_the_project_and_its_end_restarts_the_idle_time() {
    let f = Fixture::new();
    f.open("inventory");
    let root = f.root("inventory");
    let opened = f.used("inventory");
    tick_past(opened);
    let call = f.call("inventory");
    let entered = f.used("inventory");
    assert!(entered > opened, "entering counts as use");
    assert_eq!(f.held_by("inventory"), Some(McpBackgroundHold::Request));
    // Held: no idle time unloads it.
    let days_later = entered + 2 * 24 * 60 * MINUTE;
    assert!(f.background().sweep_candidates(&f.host, days_later).is_empty());
    assert!(!f.background().detach(&f.host, &root, Some(days_later)));
    tick_past(entered);
    drop(call);
    let left = f.used("inventory");
    assert!(left > entered, "the end of the call restarts the idle time");
    assert_eq!(f.held_by("inventory"), None);
    assert!(f.background().sweep_candidates(&f.host, left + 30 * MINUTE - SECOND).is_empty());
    assert_eq!(f.background().sweep_candidates(&f.host, left + 30 * MINUTE), [root]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_call_that_outlives_its_project_leaves_the_reopened_project_alone() {
    let f = Fixture::new();
    f.open("inventory");
    let root = f.root("inventory");
    let outlived = f.call("inventory");
    assert!(f.background().detach(&f.host, &root, None), "an unload by hand does not wait for the call");
    f.open("inventory");
    let current = f.call("inventory");
    drop(outlived);
    assert_eq!(
        f.held_by("inventory"),
        Some(McpBackgroundHold::Request),
        "the call in the reopened project still counts"
    );
    drop(current);
    assert_eq!(f.held_by("inventory"), None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_idle_project_is_unloaded_exactly_when_its_idle_time_is_up() {
    let f = Fixture::new();
    f.open("inventory");
    let used = f.used("inventory");
    f.background().sweep(&f.host, used + 30 * MINUTE - SECOND);
    assert_eq!(f.loaded(), ["inventory"], "one second short");
    f.set("backgroundIdleMinutes", json!(0));
    f.background().sweep(&f.host, used + 365 * 24 * 60 * MINUTE);
    assert_eq!(f.loaded(), ["inventory"], "0 never unloads");
    // More than a day counts as a day.
    f.set("backgroundIdleMinutes", json!(5000));
    f.background().sweep(&f.host, used + 1440 * MINUTE - SECOND);
    assert_eq!(f.loaded(), ["inventory"]);
    f.background().sweep(&f.host, used + 1440 * MINUTE);
    assert!(f.loaded().is_empty());
    assert!(f.host.project(&BackgroundProjects::key(&f.root("inventory"))).is_err());

    f.set("backgroundIdleMinutes", json!(30));
    f.open("inventory");
    f.background().sweep(&f.host, f.used("inventory") + 30 * MINUTE);
    assert!(f.loaded().is_empty(), "exactly at the limit");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_call_that_arrives_between_the_sweep_and_the_unload_keeps_the_project() {
    let f = Fixture::new();
    f.open("inventory");
    let root = f.root("inventory");
    let now = f.used("inventory") + 30 * MINUTE;
    assert_eq!(f.background().sweep_candidates(&f.host, now), std::slice::from_ref(&root));
    let call = f.call("inventory");
    assert!(!f.background().detach(&f.host, &root, Some(now)), "held by the call");
    drop(call);
    assert!(!f.background().detach(&f.host, &root, Some(now)), "used since the sweep looked");
    assert_eq!(f.loaded(), ["inventory"]);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_live_run_holds_the_project_and_an_unload_by_hand_stops_it() {
    let f = Fixture::new();
    f.open("inventory");
    let root = f.root("inventory");
    let (exits, exited) = std::sync::mpsc::channel();
    let exits = Mutex::new(exits);
    let sink: ide_core::SharedSink = Arc::new(move |event: ide_core::IdeEvent| {
        if let ide_core::IdeEvent::RunExited { run, .. } = event {
            // The receiver is gone once the test has seen the exit.
            let _ = exits.lock().send(run);
        }
    });
    let config = ide_run::RunConfig {
        id: "serve".into(),
        name: "serve stock".into(),
        kind: "shell".into(),
        command: "sleep 30".into(),
        args: Vec::new(),
        cwd: None,
        env: Default::default(),
        detected: false,
        is_test: false,
        debug_adapter: None,
        allow_parallel: false,
        extras: Default::default(),
    };
    let run = f.host.processes.start(&root, &config, &Default::default(), sink, Box::new(|_| {})).unwrap();
    assert_eq!(f.held_by("inventory"), Some(McpBackgroundHold::Run { name: "serve stock".into() }));
    assert_eq!(f.snapshot()[0].unloads_in_seconds, None);
    let days_later = f.used("inventory") + 2 * 24 * 60 * MINUTE;
    assert!(f.background().sweep_candidates(&f.host, days_later).is_empty());
    assert!(!f.background().detach(&f.host, &root, Some(days_later)));
    // The limit does not unload it either.
    f.set("backgroundProjectLimit", json!(1));
    assert_eq!(f.refused("billing"), "the limit of 1 background projects is reached and all are busy");

    assert!(f.background().detach(&f.host, &root, None));
    assert_eq!(exited.recv_timeout(Duration::from_secs(30)).unwrap(), run.id);
    assert!(f.host.processes.running_in(&root).is_empty());
    assert!(!f.background().detach(&f.host, &root, None), "already unloaded");
    assert!(!f.background().detach(&f.host, &f.root("billing"), None), "never loaded");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_limit_unloads_the_project_used_longest_ago_and_refuses_when_all_are_held() {
    let f = Fixture::new();
    f.set("backgroundProjectLimit", json!(2));
    f.open("inventory");
    tick_past(f.used("inventory"));
    f.open("billing");
    // A call in `inventory` makes `billing` the one used longest ago.
    tick_past(f.used("billing"));
    drop(f.call("inventory"));
    f.open("orders");
    assert_eq!(f.loaded(), ["inventory", "orders"]);
    assert!(f.host.project(&BackgroundProjects::key(&f.root("billing"))).is_err());

    let in_inventory = f.call("inventory");
    let in_orders = f.call("orders");
    assert_eq!(f.refused("billing"), "the limit of 2 background projects is reached and all are busy");
    assert_eq!(f.loaded(), ["inventory", "orders"]);
    // A loaded project answers at the limit.
    f.open("inventory");
    drop(in_orders);
    f.open("billing");
    assert_eq!(f.loaded(), ["billing", "inventory"]);
    // A lowered limit is reached by the next open.
    drop(in_inventory);
    f.set("backgroundProjectLimit", json!(0));
    f.open("orders");
    assert_eq!(f.loaded(), ["orders"], "0 serves one project");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_project_whose_call_has_not_started_running_is_not_evicted_for_another_client() {
    let f = Fixture::new();
    f.set("backgroundProjectLimit", json!(1));
    // The open hands the call over already counted: nothing unloads the project before it runs.
    let call = f.call("inventory");
    assert_eq!(f.refused("billing"), "the limit of 1 background projects is reached and all are busy");
    assert_eq!(f.loaded(), ["inventory"]);
    assert_eq!(f.held_by("inventory"), Some(McpBackgroundHold::Request));
    drop(call);
    f.open("billing");
    assert_eq!(f.loaded(), ["billing"], "with the call over, the other client's project takes the place");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
async fn a_trust_refresh_leaves_its_runtime_worker_to_other_tasks_while_it_unloads_projects() {
    let f = Fixture::new();
    f.open("inventory");
    f.set("backgroundProjects", json!("off"));
    // The observer runs inside the policy step: holding it there holds the step.
    let (inside, entered) = std::sync::mpsc::channel();
    let (release, released) = std::sync::mpsc::channel::<()>();
    let released = Mutex::new(Some(released));
    f.host.set_background_projects_observer(Arc::new(move || {
        if let Some(released) = released.lock().take() {
            // Both ends hang up when the test is over.
            let _ = inside.send(());
            let _ = released.recv();
        }
    }));
    let host = f.host.clone();
    let refresh = tokio::spawn(async move { host.refresh_project_trust().await });
    // Waits on this thread, which is none of the runtime's: its timers stand while the worker is held.
    entered.recv_timeout(30 * SECOND).expect("the policy step unloads the project");
    // The runtime's only worker is inside the step; a task spawned now still runs.
    let (ran, other) = std::sync::mpsc::channel();
    tokio::spawn(async move {
        // The test may have given up waiting.
        let _ = ran.send(());
    });
    other.recv_timeout(10 * SECOND).expect("another task runs meanwhile");
    drop(release);
    refresh.await.unwrap().unwrap();
    assert!(f.loaded().is_empty());
}

#[test]
fn the_limit_and_the_idle_time_stay_within_their_bounds() {
    for (setting, limit) in [(0, 1), (1, 1), (8, 8), (32, 32), (99, 32), (u32::MAX, 32)] {
        assert_eq!(project_limit(setting), limit, "{setting}");
    }
    let day = 24 * 60 * MINUTE;
    for (minutes, limit) in [
        (0, None),
        (1, Some(MINUTE)),
        (30, Some(30 * MINUTE)),
        (1440, Some(day)),
        (5000, Some(day)),
        (u32::MAX, Some(day)),
    ] {
        assert_eq!(idle_limit(minutes), limit, "{minutes}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_window_that_opens_the_root_takes_it_over_and_gives_it_back_when_it_closes() {
    let f = Fixture::new();
    let background = f.open("inventory");
    f.open("billing");
    let root = f.root("inventory");
    let key = BackgroundProjects::key(&root);
    let window = f.host.open_project("main", &root).unwrap();
    assert!(!Arc::ptr_eq(&window, &background));
    assert!(f.host.project(&key).is_err());
    assert_eq!(f.loaded(), ["billing"], "the other project is left alone");
    assert_eq!(f.claims("inventory"), 0);
    // A call for the root reaches the window now.
    let (label, project, call) = f.background().open(&f.host, &root).unwrap();
    assert_eq!(label, "main");
    assert!(call.is_none(), "a window is not held by calls");
    assert!(Arc::ptr_eq(&project, &window));
    assert_eq!(f.loaded(), ["billing"]);

    f.host.close_project("main");
    assert_eq!(f.background().open(&f.host, &root).unwrap().0, key);
    assert_eq!(f.loaded(), ["billing", "inventory"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_background_open_is_refused_until_every_window_opening_the_root_is_done() {
    let f = Fixture::new();
    let root = f.root("inventory");
    let first = f.background().claim(&f.host, &root);
    let second = f.background().claim(&f.host, &root);
    let refusal = format!("{} is opening in a window; retry", root.display());
    assert_eq!(f.refused("inventory"), refusal);
    drop(first);
    assert_eq!(f.refused("inventory"), refusal, "the second window is still opening it");
    f.open("billing");
    drop(second);
    assert_eq!(f.claims("inventory"), 0);
    f.open("inventory");
    assert_eq!(f.loaded(), ["billing", "inventory"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_window_open_that_fails_releases_the_root() {
    let f = Fixture::new();
    // Local History cannot be created, which fails the open after the window claimed the root.
    let history = f.base.join("data/history");
    std::fs::create_dir_all(history.parent().unwrap()).unwrap();
    std::fs::write(&history, "").unwrap();
    assert!(f.host.open_project("main", &f.root("inventory")).is_err());
    assert_eq!(f.claims("inventory"), 0);
    std::fs::remove_file(&history).unwrap();
    f.open("inventory");
    assert_eq!(f.loaded(), ["inventory"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revoked_trust_unloads_a_project_served_for_its_trust_and_restricts_a_listed_one() {
    let f = Fixture::new();
    f.set("backgroundProjects", json!("trusted"));
    f.list(&["billing"]);
    for name in ["inventory", "billing"] {
        f.host.trust.decide(&f.root(name), true, false).unwrap();
    }
    let inventory = f.open("inventory");
    let billing = f.open("billing");
    assert!(inventory.is_trusted() && billing.is_trusted());
    for name in ["inventory", "billing"] {
        f.host.set_project_trust(&f.root(name), false, false).await.unwrap();
    }
    assert_eq!(f.loaded(), ["billing"]);
    assert!(!billing.is_trusted(), "the listed project stays, in Restricted Mode");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_folder_taken_off_the_list_is_unloaded_and_the_others_stay() {
    let f = Fixture::new();
    f.open("inventory");
    f.open("billing");
    f.list(&["billing", "orders"]);
    f.host.apply_background_policy();
    assert_eq!(f.loaded(), ["billing"]);
    f.host.apply_background_policy();
    assert_eq!(f.loaded(), ["billing"], "nothing more to unload");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn turning_background_projects_or_the_server_off_unloads_every_project() {
    for (key, value) in [("backgroundProjects", json!("off")), ("enabled", json!(false))] {
        let f = Fixture::new();
        f.open("inventory");
        f.open("billing");
        f.set(key, value);
        f.host.apply_background_policy();
        assert!(f.loaded().is_empty(), "{key}");
        assert!(f.host.projects().is_empty(), "{key}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_observer_hears_of_every_open_unload_and_eviction_outside_the_locks() {
    let f = Fixture::new();
    let heard = Arc::new(AtomicUsize::new(0));
    let locked = Arc::new(AtomicUsize::new(0));
    let (count, under_lock, host) = (heard.clone(), locked.clone(), Arc::downgrade(&f.host));
    f.host.set_background_projects_observer(Arc::new(move || {
        count.fetch_add(1, Ordering::AcqRel);
        let host = host.upgrade().unwrap();
        let background = &host.mcp_background;
        if background.gate.try_lock().is_none() || background.state.try_lock().is_none() {
            under_lock.fetch_add(1, Ordering::AcqRel);
        }
    }));
    let heard = || heard.load(Ordering::Acquire);
    let root = f.root("inventory");
    f.open("inventory");
    assert_eq!(heard(), 1, "an open");
    f.open("inventory");
    assert_eq!(heard(), 1, "a loaded project is reused silently");
    assert!(f.background().detach(&f.host, &root, None));
    assert_eq!(heard(), 2, "an unload");
    assert!(!f.background().detach(&f.host, &root, None));
    f.list(&["inventory", "billing"]);
    assert!(f.refused("orders").contains("not served"));
    assert_eq!(heard(), 2, "nothing changed");
    f.set("backgroundProjectLimit", json!(1));
    f.open("inventory");
    f.open("billing");
    assert_eq!(heard(), 4, "an open, then an eviction with its open");
    f.background().sweep(&f.host, f.used("billing") + 30 * MINUTE);
    assert_eq!(heard(), 5, "an idle unload");
    f.open("billing");
    f.host.open_project("main", &f.root("billing")).unwrap();
    assert_eq!(heard(), 7, "an open, then a window taking the root over");
    assert_eq!(locked.load(Ordering::Acquire), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_background_project_is_not_a_window_of_its_root() {
    use crate::plugins::{HostWorkspace, PluginWorkspace};
    let f = Fixture::new();
    f.open("inventory");
    f.host.open_project("main", &f.root("billing")).unwrap();
    let workspace = HostWorkspace(Arc::downgrade(&f.host));
    assert!(f.host.windows_for_root(&f.root("inventory")).is_empty());
    assert!(workspace.project_windows(&f.root("inventory")).is_empty(), "a plugin's notification finds no window");
    assert_eq!(f.host.windows_for_root(&f.root("billing")), ["main"]);
    assert_eq!(workspace.project_windows(&f.root("billing")), ["main"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unloading_a_project_keeps_the_diagnostics_of_a_window_around_it() {
    let f = Fixture::new();
    f.list(&["inventory/parts", "billing"]);
    f.host.open_project("main", &f.root("inventory")).unwrap();
    f.open("inventory/parts");
    f.open("billing");
    let problem = ide_core::Diagnostic {
        range: ide_core::Range::point(ide_core::Pos::new(0, 0)),
        severity: ide_core::Severity::Warning,
        message: "low stock".into(),
        source: Some("lint".into()),
        code: None,
        unnecessary: false,
        deprecated: false,
        server: None,
    };
    let (nested, apart) = (f.root("inventory/parts/list.txt"), f.root("billing/notes.txt"));
    for file in [&nested, &apart] {
        f.host.diagnostics.replace(file, "lint", vec![problem.clone()]);
    }
    assert!(f.background().detach(&f.host, &f.root("inventory/parts"), None));
    assert!(f.background().detach(&f.host, &f.root("billing"), None));
    assert!(!f.host.diagnostics.file(&nested).is_empty(), "the window on `inventory` still shows them");
    assert!(f.host.diagnostics.file(&apart).is_empty(), "no project is left for these");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_snapshot_lists_projects_by_root_with_their_idle_time_and_what_holds_them() {
    let f = Fixture::new();
    f.open("orders");
    f.open("billing");
    let now = f.used("billing") + 10 * MINUTE;
    let snapshot = f.background().snapshot(&f.host, now);
    let roots: Vec<_> = snapshot.iter().map(|project| project.root.0.clone()).collect();
    assert_eq!(roots, [f.root("billing"), f.root("orders")]);
    let expected = McpBackgroundProject {
        root: f.root("billing").into(),
        idle_seconds: 600,
        unloads_in_seconds: Some(1200),
        kept_open_by: None,
    };
    assert_eq!(snapshot[0], expected);
    assert_eq!(
        serde_json::to_value(&snapshot[0]).unwrap(),
        json!({ "root": IpcPath::from(f.root("billing")), "idleSeconds": 600, "unloadsInSeconds": 1200 })
    );
    // Past its time and not swept yet: due now.
    assert_eq!(f.background().snapshot(&f.host, now + 60 * MINUTE)[0].unloads_in_seconds, Some(0));

    let call = f.call("billing");
    let held = f.background().snapshot(&f.host, f.used("billing") + MINUTE).remove(0);
    assert_eq!((held.idle_seconds, held.unloads_in_seconds), (60, None));
    assert_eq!(serde_json::to_value(&held).unwrap()["keptOpenBy"], json!({ "kind": "request" }));
    drop(call);
    let run = McpBackgroundHold::Run { name: "serve stock".into() };
    assert_eq!(serde_json::to_value(run).unwrap(), json!({ "kind": "run", "name": "serve stock" }));

    f.set("backgroundIdleMinutes", json!(0));
    assert!(f.snapshot().iter().all(|project| project.unloads_in_seconds.is_none()), "never unloaded");
}

#[tokio::test(start_paused = true)]
async fn the_timer_unloads_a_project_once_it_has_been_idle_for_the_configured_time() {
    let f = Fixture::new();
    f.set("backgroundIdleMinutes", json!(1));
    f.open("inventory");
    f.host.start_background_sweeper();
    // The clock is the runtime's and stands still unless the test moves it.
    tokio::time::sleep(45 * SECOND).await;
    assert_eq!(f.loaded(), ["inventory"], "swept once, half a minute idle");
    tokio::time::sleep(60 * SECOND).await;
    assert!(f.loaded().is_empty(), "swept again at a minute and a half");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn trust_revoked_while_a_project_opens_restricts_or_unloads_it_once_it_is_open() {
    use ide_mcp::ToolRegistry;
    for (mode, stays) in [("listed", true), ("trusted", false)] {
        let f = Fixture::new();
        let root = f.root("inventory");
        f.set("backgroundProjects", json!(mode));
        f.list(if stays { &["inventory"] } else { &[] });
        f.host.trust.decide(&root, true, false).unwrap();
        let warm_up = f.hold_warm_up();
        let open = f.open_in_flight("inventory");
        wait_until("the open reads the trust decision", || f.an_open_has_read_its_decisions());

        let (host, folder) = (f.host.clone(), root.clone());
        let (done, refreshed) = std::sync::mpsc::channel();
        tokio::spawn(async move {
            // The test may have given up waiting.
            let _ = done.send(host.set_project_trust(&folder, false, false).await.is_ok());
        });
        let waited = refreshed.recv_timeout(A_MOMENT).is_err();
        drop(warm_up);
        let project = open.await.unwrap();
        if waited {
            assert!(refreshed.recv_timeout(30 * SECOND).unwrap(), "{mode}");
        }

        assert!(!project.is_trusted(), "{mode}: opened with the trust it read, the project is restricted afterwards");
        if stays {
            assert_eq!(f.loaded(), ["inventory"]);
            let tools = crate::mcp::Registry::new(f.host.clone()).tools(&root).unwrap();
            assert!(tools.iter().all(|tool| tool.read_only), "only the tools that read stay on offer");
        } else {
            assert!(f.loaded().is_empty(), "served for its trust, it is unloaded");
            assert!(f.host.project(&BackgroundProjects::key(&root)).is_err());
        }
        assert!(waited, "{mode}: the refresh waits for the open under way");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_policy_change_while_a_project_opens_unloads_it_once_it_is_open() {
    for change in ["the mode turned off", "the folder taken off the list", "the server turned off"] {
        let f = Fixture::new();
        let root = f.root("inventory");
        let warm_up = f.hold_warm_up();
        let open = f.open_in_flight("inventory");
        wait_until("the open reads the settings", || f.an_open_has_read_its_decisions());

        match change {
            "the mode turned off" => f.set("backgroundProjects", json!("off")),
            "the folder taken off the list" => f.list(&["billing"]),
            _ => f.set("enabled", json!(false)),
        }
        let host = f.host.clone();
        let (done, applied) = std::sync::mpsc::channel();
        tokio::task::spawn_blocking(move || {
            host.apply_background_policy();
            // The test may have given up waiting.
            let _ = done.send(());
        });
        let waited = applied.recv_timeout(A_MOMENT).is_err();
        drop(warm_up);
        open.await.unwrap();
        if waited {
            applied.recv_timeout(30 * SECOND).expect(change);
        }

        assert!(f.loaded().is_empty(), "{change}: the project that was opening is unloaded");
        assert!(f.host.project(&BackgroundProjects::key(&root)).is_err(), "{change}");
        assert!(waited, "{change}: the policy waits for the open under way");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_host_that_serves_none_refuses_every_folder_whatever_the_settings_say() {
    use ide_mcp::ToolRegistry;
    let f = Fixture::new();
    let root = f.root("inventory");
    f.host.mcp_background.serve_none();
    let registry = crate::mcp::Registry::new(f.host.clone());
    assert_eq!(registry.resolve(&root.join("parts")), None);
    assert_eq!(f.refused("inventory"), format!("{} is not served in the background", root.display()));
    assert!(f.loaded().is_empty());
    assert!(f.host.projects().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_call_that_arrives_after_the_server_was_turned_off_opens_nothing() {
    use ide_mcp::ToolRegistry;
    let f = Fixture::new();
    let root = f.root("inventory");
    // A request the server had accepted before it stopped still reaches the open.
    f.set("enabled", json!(false));
    f.host.apply_background_policy();
    assert_eq!(f.refused("inventory"), format!("{} is not served in the background", root.display()));
    assert!(f.loaded().is_empty());
    assert!(f.host.projects().is_empty());
    let registry = crate::mcp::Registry::new(f.host.clone());
    assert_eq!(registry.resolve(&root.join("parts")), None, "no folder is served with the server off");
    assert!(registry.tools(&root).is_err());

    f.set("enabled", json!(true));
    assert_eq!(registry.resolve(&root.join("parts")), Some(root));
    f.open("inventory");
    assert_eq!(f.loaded(), ["inventory"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_window_opening_another_folder_does_not_wait_for_a_background_open() {
    let f = Fixture::new();
    let key = BackgroundProjects::key(&f.root("inventory"));
    // The background open stops at its own open lock, which it takes with the gate held.
    let lock = f.host.opening(&key);
    let held = lock.lock();
    let open = f.open_in_flight("inventory");

    let (host, billing) = (f.host.clone(), f.root("billing"));
    let (done, opened) = std::sync::mpsc::channel();
    tokio::task::spawn_blocking(move || {
        // The test may have given up waiting.
        let _ = done.send(host.open_project("main", &billing).map(|project| project.root.clone()));
    });
    let window = opened.recv_timeout(10 * SECOND).expect("the window opens while the background open is held");
    assert_eq!(window.unwrap(), f.root("billing"));
    assert!(f.loaded().is_empty(), "the background open is still under way");

    drop(held);
    open.await.unwrap();
    assert_eq!(f.loaded(), ["inventory"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_window_opening_the_folder_that_is_being_opened_waits_for_it_and_takes_it_over() {
    let f = Fixture::new();
    let root = f.root("inventory");
    let key = BackgroundProjects::key(&root);
    let lock = f.host.opening(&key);
    let held = lock.lock();
    let open = f.open_in_flight("inventory");
    wait_until("the open marks its root", || f.background().state.lock().opening.as_deref() == Some(root.as_path()));

    let (host, folder) = (f.host.clone(), root.clone());
    let (done, opened) = std::sync::mpsc::channel();
    tokio::task::spawn_blocking(move || {
        // The test may have given up waiting.
        let _ = done.send(host.open_project("main", &folder).map(|project| project.root.clone()));
    });
    let early = opened.recv_timeout(A_MOMENT).ok();
    assert!(early.is_none(), "the window waits for the background open of its own folder");
    drop(held);
    open.await.unwrap();
    assert_eq!(opened.recv_timeout(30 * SECOND).unwrap().unwrap(), root);
    assert!(f.host.project(&key).is_err(), "the window took the folder over");
    assert!(f.loaded().is_empty());
    assert_eq!(f.claims("inventory"), 0);
}
