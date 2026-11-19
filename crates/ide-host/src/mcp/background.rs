//! Projects the MCP server serves without a window ("background projects"): opened by a
//! client's first tool call under the key `mcp:<root>` in the host's projects, held by the
//! calls and runs in flight, unloaded when idle or when the limit needs room, and closed
//! when a window opens the same root or the settings and trust decisions stop serving it.

mod policy;
#[cfg(test)]
mod tests;

use crate::{Host, Project};
use ide_core::settings::McpBackgroundProjects;
use ide_core::{IdeError, IdeResult, IpcPath};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

/// Starts the key of every background project; window labels never contain `:`.
const KEY_PREFIX: &str = "mcp:";
/// `mcpServer.backgroundIdleMinutes` counts up to a day.
const MAX_IDLE_MINUTES: u32 = 24 * 60;
/// `mcpServer.backgroundProjectLimit` stays within these bounds.
const MIN_PROJECTS: u32 = 1;
const MAX_PROJECTS: u32 = 32;
/// How often idle projects are looked for.
const SWEEP_EVERY: Duration = Duration::from_secs(30);

/// A project served without a window, as the IDE lists it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpBackgroundProject {
    pub root: IpcPath,
    /// Seconds since its last tool call began or ended.
    pub idle_seconds: u32,
    /// Seconds until it is unloaded for being idle. Absent while something keeps it open
    /// and when idle projects are never unloaded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub unloads_in_seconds: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub kept_open_by: Option<McpBackgroundHold>,
}

/// What keeps an idle background project loaded.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum McpBackgroundHold {
    /// A tool call is in flight.
    Request,
    /// A run it started is alive; `name` is the first one's.
    Run { name: String },
}

type Observer = Arc<dyn Fn() + Send + Sync>;

/// The background projects of one [`Host`].
#[derive(Default)]
pub struct BackgroundProjects {
    /// Serializes opens and unloads, and is held across the open itself. Taken before
    /// `state`, never with it held.
    gate: Mutex<()>,
    state: Mutex<State>,
    observer: RwLock<Option<Observer>>,
    /// Set by [`BackgroundProjects::serve_none`].
    serves_none: AtomicBool,
}

#[derive(Default)]
struct State {
    entries: HashMap<PathBuf, Arc<Entry>>,
    /// Windows that are opening a root right now, counted per root.
    claims: HashMap<PathBuf, usize>,
    /// The root a background open under way is opening; the gate allows one at a time.
    opening: Option<PathBuf>,
}

/// Marks the root of the open under way in [`State::opening`] until that open is over.
struct Opening<'a>(&'a BackgroundProjects);

impl Drop for Opening<'_> {
    fn drop(&mut self) {
        self.0.state.lock().opening = None;
    }
}

struct Entry {
    /// Tool calls running in the project.
    in_flight: AtomicUsize,
    /// When a call last reached the project or left it.
    last_used: Mutex<Instant>,
}

/// Keeps a background project loaded while a tool call runs in it.
pub(crate) struct ActivityGuard(Arc<Entry>);

/// What answers a tool call: the window label or background key, the project, and the
/// call's guard when the project is served in the background.
pub(crate) type Served = (String, Arc<Project>, Option<ActivityGuard>);

impl Drop for ActivityGuard {
    fn drop(&mut self) {
        // The time first: a sweep that sees no call in flight then sees a fresh time.
        *self.0.last_used.lock() = Instant::now();
        self.0.in_flight.fetch_sub(1, Ordering::AcqRel);
    }
}

/// A window is opening the root: no background project of it is opened meanwhile.
pub(crate) struct Claim<'a> {
    owner: &'a BackgroundProjects,
    root: PathBuf,
}

impl Drop for Claim<'_> {
    fn drop(&mut self) {
        let mut state = self.owner.state.lock();
        if let Some(count) = state.claims.get_mut(&self.root) {
            *count -= 1;
            if *count == 0 {
                state.claims.remove(&self.root);
            }
        }
    }
}

/// When [`BackgroundProjects::remove`] unloads a project.
#[derive(Clone, Copy)]
enum Only {
    Always,
    /// No call or run holds it.
    Unheld,
    /// Nothing holds it and it has been idle for the configured time at this moment.
    Idle(Instant),
}

/// The inputs of [`policy::resolve`] at one moment.
struct Policy {
    mode: McpBackgroundProjects,
    listed: Vec<PathBuf>,
    decisions: crate::trust::TrustDecisions,
    recents: Vec<PathBuf>,
    home: Option<PathBuf>,
}

impl Policy {
    /// `None` when the MCP server or its background projects are off, and when the trust
    /// decisions cannot be read.
    fn current(host: &Host) -> Option<Self> {
        let settings = host.global_settings.effective().mcp_server;
        // Without the server no client is served, a request it accepted before it stopped included.
        if !settings.enabled || host.mcp_background.serves_none.load(Ordering::Relaxed) {
            return None;
        }
        let mode = settings.background_projects;
        let by_trust = match mode {
            McpBackgroundProjects::Off => return None,
            McpBackgroundProjects::Trusted => true,
            McpBackgroundProjects::Listed => false,
        };
        let recents = if by_trust { ide_workspace::RecentProjects::load(&host.config_dir).paths() } else { Vec::new() };
        Some(Self {
            mode,
            listed: settings.background_project_paths.iter().map(PathBuf::from).collect(),
            decisions: host.trust.decisions().ok()?,
            recents,
            home: dirs::home_dir(),
        })
    }

    fn resolve(&self, path: &Path) -> Option<PathBuf> {
        policy::resolve(self.mode, &self.listed, &self.decisions, &self.recents, self.home.as_deref(), path)
    }
}

/// The root of the project that serves `path` in the background under the current
/// settings and trust decisions. Opens nothing.
pub(crate) fn serving_root(host: &Host, path: &Path) -> Option<PathBuf> {
    Policy::current(host)?.resolve(path)
}

/// How long a project may stay idle; `None` when `minutes` is 0 (never unloaded).
fn idle_limit(minutes: u32) -> Option<Duration> {
    (minutes > 0).then(|| Duration::from_secs(u64::from(minutes.min(MAX_IDLE_MINUTES)) * 60))
}

fn project_limit(limit: u32) -> usize {
    limit.clamp(MIN_PROJECTS, MAX_PROJECTS) as usize
}

fn whole_seconds(time: Duration) -> u32 {
    u32::try_from(time.as_secs()).unwrap_or(u32::MAX)
}

/// What keeps the project at `root` loaded, a call before a run.
fn hold(host: &Host, root: &Path, entry: &Entry) -> Option<McpBackgroundHold> {
    if entry.in_flight.load(Ordering::Acquire) > 0 {
        return Some(McpBackgroundHold::Request);
    }
    host.processes.running_in(root).into_iter().next().map(|run| McpBackgroundHold::Run { name: run.name })
}

impl BackgroundProjects {
    /// The key of the background project at `root` in the host's projects.
    pub fn key(root: &Path) -> String {
        format!("{KEY_PREFIX}{}", root.display())
    }

    /// Serves no project in the background, whatever the settings say: the remote server,
    /// which exists for its window's project and holds no trust decisions of its own.
    pub fn serve_none(&self) {
        self.serves_none.store(true, Ordering::Relaxed);
    }

    /// Whether `window` is the key of a background project and not a window's label.
    pub fn is_key(window: &str) -> bool {
        window.starts_with(KEY_PREFIX)
    }

    /// The loaded background project at `root`. Leaves its idle time alone.
    pub(crate) fn project(&self, host: &Host, root: &Path) -> Option<Arc<Project>> {
        self.state.lock().entries.contains_key(root).then(|| host.project(&Self::key(root)).ok()).flatten()
    }

    /// The project that answers a tool call for `root`, opened now unless it is loaded: its
    /// key, the project and the guard of the call, which counts as in flight from here on,
    /// so nothing unloads the project before the call runs. A window that opened the root
    /// meanwhile answers instead, with its label and no guard. Refused while a window is
    /// opening the root, when the settings and trust decisions do not serve it, and when
    /// the limit is reached with every loaded project held.
    pub(crate) fn open(&self, host: &Host, root: &Path) -> IdeResult<Served> {
        let key = Self::key(root);
        // Without the gate, which the open of another root may hold for seconds.
        if let Some((project, call)) = self.reach(host, root, &key) {
            return Ok((key, project, Some(call)));
        }
        let mut changed = false;
        let opened = {
            let _gate = self.gate.lock();
            self.open_gated(host, root, &key, &mut changed)
        };
        if changed {
            self.notify();
        }
        opened
    }

    /// The loaded project at `root`, with a call entered in it.
    fn reach(&self, host: &Host, root: &Path, key: &str) -> Option<(Arc<Project>, ActivityGuard)> {
        let call = {
            // Under `state`, so an unload either sees the call or has removed the entry.
            let state = self.state.lock();
            let entry = state.entries.get(root)?.clone();
            entry.in_flight.fetch_add(1, Ordering::AcqRel);
            *entry.last_used.lock() = Instant::now();
            ActivityGuard(entry)
        };
        // A project closed behind its entry drops the guard here; the gated open replaces both.
        host.project(key).ok().map(|project| (project, call))
    }

    fn open_gated(&self, host: &Host, root: &Path, key: &str, changed: &mut bool) -> IdeResult<Served> {
        // Another call opened it while this one waited for the gate.
        if let Some((project, call)) = self.reach(host, root, key) {
            return Ok((key.to_owned(), project, Some(call)));
        }
        if let Some((window, project)) = host.window_project(root) {
            return Ok((window, project, None));
        }
        let _opening = {
            let mut state = self.state.lock();
            if state.claims.contains_key(root) {
                return Err(IdeError::unavailable(format!("{} is opening in a window; retry", root.display())));
            }
            // An entry whose project was closed behind its back would count against the limit.
            *changed |= state.entries.remove(root).is_some();
            // In the same step as the look at the claims: a window that claims the root from
            // here on sees this open and waits for it.
            state.opening = Some(root.to_path_buf());
            Opening(self)
        };
        if serving_root(host, root).as_deref() != Some(root) {
            return Err(IdeError::unavailable(format!("{} is not served in the background", root.display())));
        }
        let limit = project_limit(host.global_settings.effective().mcp_server.background_project_limit);
        while self.state.lock().entries.len() >= limit {
            let Some(idle) = self.longest_idle(host) else {
                return Err(IdeError::unavailable(format!(
                    "the limit of {limit} background projects is reached and all are busy"
                )));
            };
            // A call that entered it meanwhile keeps it; the loop then looks again.
            *changed |= self.remove(host, &idle, Only::Unheld);
        }
        let project = host.open_project(key, root)?;
        // Entered from the start: the next open cannot evict it before this call runs.
        let entry = Arc::new(Entry { in_flight: AtomicUsize::new(1), last_used: Mutex::new(Instant::now()) });
        self.state.lock().entries.insert(root.to_path_buf(), entry.clone());
        if let Some(plugins) = host.plugin_host() {
            plugins.reopen_client(key);
        }
        *changed = true;
        Ok((key.to_owned(), project, Some(ActivityGuard(entry))))
    }

    /// Unloads the background project at `root` and stops what it started; its workers
    /// finish shutting down in the background. It waits for a background open that is under
    /// way, so call it from a blocking context. With `only_if_idle`, a project that a call
    /// or a run holds, or that is not idle for the configured time at that moment, stays.
    /// `false` when nothing was unloaded, an unknown root included.
    pub fn detach(&self, host: &Host, root: &Path, only_if_idle: Option<Instant>) -> bool {
        let removed = {
            let _gate = self.gate.lock();
            self.remove(host, root, only_if_idle.map_or(Only::Always, Only::Idle))
        };
        if removed {
            self.notify();
        }
        removed
    }

    /// The single way a background project closes. The caller holds the gate.
    fn remove(&self, host: &Host, root: &Path, only: Only) -> bool {
        // Before `state`: the runs have a lock of their own.
        let running = !host.processes.running_in(root).is_empty();
        let may_idle = idle_limit(host.global_settings.effective().mcp_server.background_idle_minutes);
        {
            let mut state = self.state.lock();
            let Some(entry) = state.entries.get(root) else { return false };
            let held = running || entry.in_flight.load(Ordering::Acquire) > 0;
            let idle = |now: Instant| {
                may_idle.is_some_and(|limit| now.saturating_duration_since(*entry.last_used.lock()) >= limit)
            };
            let stays = match only {
                Only::Always => false,
                Only::Unheld => held,
                Only::Idle(now) => held || !idle(now),
            };
            if stays {
                return false;
            }
            state.entries.remove(root);
        }
        let key = Self::key(root);
        if let Some(plugins) = host.plugin_host() {
            plugins.forget_client(&key);
        }
        host.close_project_detached(&key);
        true
    }

    /// The projects no call or run holds that have been idle for the configured time at `now`.
    pub(crate) fn sweep_candidates(&self, host: &Host, now: Instant) -> Vec<PathBuf> {
        let minutes = host.global_settings.effective().mcp_server.background_idle_minutes;
        let Some(limit) = idle_limit(minutes) else { return Vec::new() };
        let idle = |entry: &Entry| now.saturating_duration_since(*entry.last_used.lock()) >= limit;
        let entries = self.entries().into_iter();
        entries.filter(|(root, entry)| idle(entry) && hold(host, root, entry).is_none()).map(|(root, _)| root).collect()
    }

    /// Unloads the projects that are idle at `now`; each is checked again as it is unloaded.
    pub(crate) fn sweep(&self, host: &Host, now: Instant) {
        for root in self.sweep_candidates(host, now) {
            self.detach(host, &root, Some(now));
        }
    }

    /// A window is about to open `root`: unloads the root's background project and keeps
    /// another from opening until the claim drops. It waits for a background open only when
    /// the root is loaded or is the one being opened; a window on any other folder goes on
    /// at once.
    pub(crate) fn claim(&self, host: &Host, root: &Path) -> Claim<'_> {
        let contested = {
            let mut state = self.state.lock();
            // From here no background open of the root gets past its look at the claims.
            *state.claims.entry(root.to_path_buf()).or_default() += 1;
            state.entries.contains_key(root) || state.opening.as_deref() == Some(root)
        };
        let claim = Claim { owner: self, root: root.to_path_buf() };
        if contested {
            let removed = {
                let _gate = self.gate.lock();
                self.remove(host, root, Only::Always)
            };
            if removed {
                self.notify();
            }
        }
        claim
    }

    /// Waits for a background open that is under way. After it, the project that open
    /// read its settings and trust for is registered, and an open that starts later reads
    /// what is stored now.
    pub(crate) fn wait_for_open(&self) {
        drop(self.gate.lock());
    }

    /// The loaded background projects at `now`, sorted by root.
    pub fn snapshot(&self, host: &Host, now: Instant) -> Vec<McpBackgroundProject> {
        let may_idle = idle_limit(host.global_settings.effective().mcp_server.background_idle_minutes);
        let mut projects: Vec<_> = self
            .entries()
            .into_iter()
            .map(|(root, entry)| {
                let idle = now.saturating_duration_since(*entry.last_used.lock());
                let kept_open_by = hold(host, &root, &entry);
                let unloads_in = may_idle.filter(|_| kept_open_by.is_none()).map(|limit| limit.saturating_sub(idle));
                McpBackgroundProject {
                    root: root.into(),
                    idle_seconds: whole_seconds(idle),
                    unloads_in_seconds: unloads_in.map(whole_seconds),
                    kept_open_by,
                }
            })
            .collect();
        projects.sort_by(|a, b| a.root.cmp(&b.root));
        projects
    }

    fn entries(&self) -> Vec<(PathBuf, Arc<Entry>)> {
        self.state.lock().entries.iter().map(|(root, entry)| (root.clone(), entry.clone())).collect()
    }

    /// The project nothing holds that was used the longest ago.
    fn longest_idle(&self, host: &Host) -> Option<PathBuf> {
        let unheld = self.entries().into_iter().filter(|(root, entry)| hold(host, root, entry).is_none());
        unheld.min_by_key(|(_, entry)| *entry.last_used.lock()).map(|(root, _)| root)
    }

    /// Tells the observer that the loaded projects changed. Never called with a lock of
    /// this type held.
    fn notify(&self) {
        let observer = self.observer.read().clone();
        if let Some(observer) = observer {
            observer();
        }
    }
}

impl Host {
    /// The window, and its project, that has `root` open as a project (not in LightEdit).
    fn window_project(&self, root: &Path) -> Option<(String, Arc<Project>)> {
        let projects = self.projects.read();
        let windows = projects.iter().filter(|(w, p)| !BackgroundProjects::is_key(w) && !p.light && p.root == root);
        windows.min_by_key(|(w, _)| w.as_str()).map(|(w, p)| (w.clone(), p.clone()))
    }

    /// Unloads the background projects the settings and trust decisions no longer serve:
    /// all of them when the MCP server is off, otherwise each whose root no longer serves
    /// itself. Call it after either changes, from a blocking context: it reads the recent
    /// projects and waits for a background open that is under way.
    pub fn apply_background_policy(&self) {
        // First: a project that is being opened under the old settings has no entry yet.
        self.mcp_background.wait_for_open();
        let roots: Vec<PathBuf> = self.mcp_background.entries().into_iter().map(|(root, _)| root).collect();
        if roots.is_empty() {
            return;
        }
        let policy = Policy::current(self);
        for root in roots {
            if policy.as_ref().and_then(|policy| policy.resolve(&root)).as_deref() != Some(&root) {
                self.mcp_background.detach(self, &root, None);
            }
        }
    }

    /// Starts the timer that unloads idle background projects for as long as the host lives.
    pub fn start_background_sweeper(self: &Arc<Self>) {
        let host = Arc::downgrade(self);
        self.runtime.spawn(async move {
            let mut tick = tokio::time::interval(SWEEP_EVERY);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            tick.tick().await;
            loop {
                tick.tick().await;
                let Some(host) = host.upgrade() else { break };
                // The timer's clock, so a sweep and its tick agree on the time.
                let now = tokio::time::Instant::now().into_std();
                // An unload waits for the gate, which an open in flight holds: off the async workers.
                let sweep = tokio::task::spawn_blocking(move || host.mcp_background.sweep(&host, now));
                if let Err(error) = sweep.await {
                    tracing::warn!(%error, "sweeping idle background projects failed");
                }
            }
        });
    }

    /// Sets what is told when a background project is opened or unloaded. It runs on the
    /// thread that made the change, outside the locks of the background projects.
    pub fn set_background_projects_observer(&self, observer: Arc<dyn Fn() + Send + Sync>) {
        *self.mcp_background.observer.write() = Some(observer);
    }
}
