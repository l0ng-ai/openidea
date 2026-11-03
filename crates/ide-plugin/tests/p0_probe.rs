//! Runtime experiments, kept as regression tests: they pin the
//! wasmtime behaviour the plugin runtime is designed around.
//!
//! Components: `tests/fixtures/p0-probe/dist/{min,full}.wasm`, rebuilt with
//! `tests/fixtures/p0-probe/build.sh`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use wasmtime::component::{Component, HasSelf, Linker, Resource, ResourceTable};
use wasmtime::{Config, Engine, Store};
use wasmtime_wasi::p2::{DynPollable, Pollable, subscribe};
use wasmtime_wasi::{WasiCtx, WasiCtxView, WasiView};

mod bindings {
    wasmtime::component::bindgen!({
        world: "probe-host",
        path: "tests/fixtures/p0-probe/wit",
        imports: {
            "openidea:probe/host-api.sleep-ms": async | trappable,
            default: trappable,
        },
        exports: { default: async },
        with: {
            "wasi:io/poll": wasmtime_wasi::p2::bindings::io::poll,
            "openidea:probe/host-api.task": super::Task,
        },
    });
}

use bindings::openidea::probe::host_api;

/// Host side of the `task` resource: a queue the host pushes into.
pub struct Task {
    queue: Arc<parking_lot::Mutex<Vec<String>>>,
    cancelled: Arc<AtomicBool>,
    notify: Arc<tokio::sync::Notify>,
    progress: Arc<AtomicU64>,
}

/// The pollable of `next-ready`: ready once an item is queued or the task is cancelled.
struct NextReady {
    queue: Arc<parking_lot::Mutex<Vec<String>>>,
    cancelled: Arc<AtomicBool>,
    notify: Arc<tokio::sync::Notify>,
}

#[wasmtime_wasi::async_trait]
impl Pollable for NextReady {
    async fn ready(&mut self) {
        loop {
            let notified = self.notify.notified();
            if self.cancelled.load(Ordering::Acquire) || !self.queue.lock().is_empty() {
                return;
            }
            notified.await;
        }
    }
}

#[derive(Clone, Default)]
struct TaskHandle {
    queue: Arc<parking_lot::Mutex<Vec<String>>>,
    cancelled: Arc<AtomicBool>,
    notify: Arc<tokio::sync::Notify>,
    progress: Arc<AtomicU64>,
}

impl TaskHandle {
    fn push(&self, item: &str) {
        self.queue.lock().push(item.to_owned());
        self.notify.notify_waiters();
    }
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }
}

struct Data {
    wasi: WasiCtx,
    table: ResourceTable,
    task: TaskHandle,
}

impl WasiView for Data {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView { ctx: &mut self.wasi, table: &mut self.table }
    }
}

impl host_api::HostTask for Data {
    fn report(&mut self, task: Resource<Task>, done: u32, _total: Option<u32>) -> wasmtime::Result<()> {
        self.table.get(&task)?.progress.store(u64::from(done), Ordering::Release);
        Ok(())
    }
    fn is_cancelled(&mut self, task: Resource<Task>) -> wasmtime::Result<bool> {
        Ok(self.table.get(&task)?.cancelled.load(Ordering::Acquire))
    }
    fn next_ready(&mut self, task: Resource<Task>) -> wasmtime::Result<Resource<DynPollable>> {
        let t = self.table.get(&task)?;
        let ready = NextReady { queue: t.queue.clone(), cancelled: t.cancelled.clone(), notify: t.notify.clone() };
        let r = self.table.push(ready)?;
        subscribe(&mut self.table, r)
    }
    fn take(&mut self, task: Resource<Task>) -> wasmtime::Result<Option<String>> {
        let mut q = self.table.get(&task)?.queue.lock();
        Ok(if q.is_empty() { None } else { Some(q.remove(0)) })
    }
    fn drop(&mut self, task: Resource<Task>) -> wasmtime::Result<()> {
        self.table.delete(task)?;
        Ok(())
    }
}

impl host_api::Host for Data {
    fn current_task(&mut self) -> wasmtime::Result<Resource<Task>> {
        let h = self.task.clone();
        Ok(self.table.push(Task { queue: h.queue, cancelled: h.cancelled, notify: h.notify, progress: h.progress })?)
    }

    async fn sleep_ms(&mut self, ms: u32) -> wasmtime::Result<()> {
        tokio::time::sleep(Duration::from_millis(u64::from(ms))).await;
        Ok(())
    }
}

fn dist(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/p0-probe/dist").join(name)
}

struct Env {
    engine: Engine,
    linker: Linker<Data>,
    stop: Arc<AtomicBool>,
}

impl Drop for Env {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
    }
}

fn env() -> Env {
    let mut config = Config::new();
    config.wasm_component_model(true).epoch_interruption(true).consume_fuel(true);
    let engine = Engine::new(&config).unwrap();
    let mut linker = Linker::new(&engine);
    wasmtime_wasi::p2::add_to_linker_async(&mut linker).unwrap();
    host_api::add_to_linker::<_, HasSelf<_>>(&mut linker, |d| d).unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let (weak, flag) = (engine.weak(), stop.clone());
    std::thread::spawn(move || {
        while !flag.load(Ordering::Acquire)
            && let Some(e) = weak.upgrade()
        {
            e.increment_epoch();
            drop(e);
            std::thread::sleep(Duration::from_millis(5));
        }
    });
    Env { engine, linker, stop }
}

fn store(env: &Env, task: TaskHandle) -> Store<Data> {
    let data = Data { wasi: WasiCtx::builder().build(), table: ResourceTable::new(), task };
    let mut store = Store::new(&env.engine, data);
    store.set_fuel(u64::MAX).unwrap();
    // Yield to the executor every tick instead of trapping: long calls share the thread.
    store.epoch_deadline_async_yield_and_update(1);
    store
}

const BASE: &str = "openidea:probe/base@0.1.0";
const CODE_ACTIONS: &str = "openidea:probe/code-actions@0.1.0";

/// P0-1: a component that lacks optional exports still binds; presence is
/// detectable per interface, and present interfaces are callable.
#[tokio::test]
async fn optional_exports_bind_per_interface() {
    let env = env();
    let min = Component::from_file(&env.engine, dist("min.wasm")).unwrap();
    let full = Component::from_file(&env.engine, dist("full.wasm")).unwrap();

    // Presence is visible from the compiled component, before instantiation.
    assert!(min.get_export_index(None, BASE).is_some());
    assert!(min.get_export_index(None, CODE_ACTIONS).is_none());
    assert!(full.get_export_index(None, CODE_ACTIONS).is_some());

    // The whole-world binding requires every export ...
    let pre_min = env.linker.instantiate_pre(&min).unwrap();
    assert!(bindings::ProbeHostPre::new(pre_min.clone()).is_err());

    // ... but per-interface indices bind what is there.
    use bindings::exports::openidea::probe::{base, code_actions, completion};
    let base_idx = base::GuestIndices::new(&pre_min).unwrap();
    assert!(code_actions::GuestIndices::new(&pre_min).is_err());
    let mut s = store(&env, TaskHandle::default());
    let inst = pre_min.instantiate_async(&mut s).await.unwrap();
    let b = base_idx.load(&mut s, &inst).unwrap();
    assert_eq!(b.call_run(&mut s, "echo", "hi").await.unwrap().unwrap(), "hi");

    let pre_full = env.linker.instantiate_pre(&full).unwrap();
    let ca_idx = code_actions::GuestIndices::new(&pre_full).unwrap();
    let co_idx = completion::GuestIndices::new(&pre_full).unwrap();
    let mut s = store(&env, TaskHandle::default());
    let inst = pre_full.instantiate_async(&mut s).await.unwrap();
    let ca = ca_idx.load(&mut s, &inst).unwrap();
    assert_eq!(ca.call_actions(&mut s, "a.rs").await.unwrap(), ["fix:a.rs"]);
    let co = co_idx.load(&mut s, &inst).unwrap();
    assert_eq!(co.call_complete(&mut s, "x").await.unwrap(), ["x1", "x2"]);
}

/// P0-2a: with `epoch_deadline_async_yield_and_update`, a spinning guest yields,
/// so other tasks on the same (single) thread keep running.
#[tokio::test(flavor = "current_thread")]
async fn spinning_guest_yields_to_the_executor() {
    let env = env();
    let pre = env.linker.instantiate_pre(&Component::from_file(&env.engine, dist("min.wasm")).unwrap()).unwrap();
    let idx = bindings::exports::openidea::probe::base::GuestIndices::new(&pre).unwrap();
    let mut s = store(&env, TaskHandle::default());
    let inst = pre.instantiate_async(&mut s).await.unwrap();
    let base = idx.load(&mut s, &inst).unwrap();

    let ticks = Arc::new(AtomicU64::new(0));
    let ticker = {
        let ticks = ticks.clone();
        tokio::spawn(async move {
            loop {
                ticks.fetch_add(1, Ordering::Relaxed);
                tokio::task::yield_now().await;
            }
        })
    };
    let spin = base.call_run(&mut s, "spin", "");
    assert!(tokio::time::timeout(Duration::from_millis(200), spin).await.is_err(), "spin never returns");
    ticker.abort();
    // How often depends on how busy the machine is; that it ran at all shows the guest yielded.
    assert!(ticks.load(Ordering::Relaxed) > 0, "the executor kept running other tasks while the guest spun");
}

/// P0-2b: dropping the call future cancels the call — and poisons the instance:
/// the next call fails with `CannotEnterComponent`. A fresh instance from the
/// same `InstancePre` is cheap (no compilation) and starts with fresh state.
#[tokio::test]
async fn cancelled_instance_cannot_be_reused_but_reinstantiates_fast() {
    let env = env();
    let pre = env.linker.instantiate_pre(&Component::from_file(&env.engine, dist("min.wasm")).unwrap()).unwrap();
    let idx = bindings::exports::openidea::probe::base::GuestIndices::new(&pre).unwrap();
    let mut s = store(&env, TaskHandle::default());
    let inst = pre.instantiate_async(&mut s).await.unwrap();
    let base = idx.load(&mut s, &inst).unwrap();
    assert_eq!(base.call_run(&mut s, "count", "").await.unwrap().unwrap(), "1");

    // Cancel while the guest computes.
    let _ = tokio::time::timeout(Duration::from_millis(50), base.call_run(&mut s, "spin", "")).await;
    let err = base.call_run(&mut s, "echo", "x").await.unwrap_err();
    assert_eq!(err.downcast_ref::<wasmtime::Trap>(), Some(&wasmtime::Trap::CannotEnterComponent), "{err:?}");

    // Cancel while the guest waits in an async host import: same result.
    let mut s = store(&env, TaskHandle::default());
    let inst = pre.instantiate_async(&mut s).await.unwrap();
    let base = idx.load(&mut s, &inst).unwrap();
    let _ = tokio::time::timeout(Duration::from_millis(20), base.call_run(&mut s, "sleep", "5000")).await;
    assert!(base.call_run(&mut s, "echo", "x").await.is_err());

    // Re-instantiation: a new store + instance from the pre-instantiated component.
    let started = Instant::now();
    let mut runs = 0;
    while runs < 20 {
        let mut s = store(&env, TaskHandle::default());
        let inst = pre.instantiate_async(&mut s).await.unwrap();
        let base = idx.load(&mut s, &inst).unwrap();
        assert_eq!(base.call_run(&mut s, "count", "").await.unwrap().unwrap(), "1", "state starts fresh");
        runs += 1;
    }
    let per = started.elapsed() / runs;
    eprintln!("re-instantiate + first call: {per:?} per instance");
    assert!(per < Duration::from_millis(30), "{per:?}");
}

/// P0-2c: a guest that returns an error (not a trap) leaves the instance usable,
/// and an async host import does not block the thread.
#[tokio::test(flavor = "current_thread")]
async fn async_host_import_does_not_block() {
    let env = env();
    let pre = env.linker.instantiate_pre(&Component::from_file(&env.engine, dist("min.wasm")).unwrap()).unwrap();
    let idx = bindings::exports::openidea::probe::base::GuestIndices::new(&pre).unwrap();
    let mut s = store(&env, TaskHandle::default());
    let inst = pre.instantiate_async(&mut s).await.unwrap();
    let base = idx.load(&mut s, &inst).unwrap();
    assert!(base.call_run(&mut s, "nope", "").await.unwrap().is_err());
    let other = tokio::spawn(async { tokio::time::sleep(Duration::from_millis(10)).await });
    let started = Instant::now();
    assert_eq!(base.call_run(&mut s, "sleep", "100").await.unwrap().unwrap(), "slept");
    assert!(other.is_finished(), "the other task ran during the host sleep");
    assert!(started.elapsed() >= Duration::from_millis(100));
    assert_eq!(base.call_run(&mut s, "echo", "still").await.unwrap().unwrap(), "still");
}

/// P0-3: streaming + cancellation on WASI p2 alone: the guest blocks on a host
/// `pollable` (which yields to the executor), consumes pushed items, reports
/// progress, and returns cleanly when the host flags cancellation — the instance
/// stays usable (cooperative cancellation, unlike dropping the future).
#[tokio::test]
async fn pollable_task_streams_and_cancels_cooperatively() {
    let env = env();
    let pre = env.linker.instantiate_pre(&Component::from_file(&env.engine, dist("min.wasm")).unwrap()).unwrap();
    let idx = bindings::exports::openidea::probe::base::GuestIndices::new(&pre).unwrap();
    let task = TaskHandle::default();
    let mut s = store(&env, task.clone());
    let inst = pre.instantiate_async(&mut s).await.unwrap();
    let base = idx.load(&mut s, &inst).unwrap();

    let driver = {
        let task = task.clone();
        tokio::spawn(async move {
            for item in ["a", "b", "c"] {
                tokio::time::sleep(Duration::from_millis(10)).await;
                task.push(item);
            }
            // Wait until the guest consumed everything, then cancel.
            while task.progress.load(Ordering::Acquire) < 3 {
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
            task.cancel();
        })
    };
    let out = tokio::time::timeout(Duration::from_secs(5), base.call_run(&mut s, "task", "")).await.unwrap();
    driver.await.unwrap();
    assert_eq!(out.unwrap().unwrap(), "cancelled after a,b,c");
    assert_eq!(task.progress.load(Ordering::Acquire), 3);
    assert_eq!(base.call_run(&mut s, "echo", "reusable").await.unwrap().unwrap(), "reusable");
}

/// Serialized compilation output loads without recompiling (P4 cache).
#[test]
fn serialized_component_round_trips() {
    let env = env();
    let bytes = std::fs::read(dist("full.wasm")).unwrap();
    let t = Instant::now();
    let compiled = Component::new(&env.engine, &bytes).unwrap();
    let compile = t.elapsed();
    let blob = compiled.serialize().unwrap();
    let t = Instant::now();
    // SAFETY: the blob was produced by this engine just above.
    let loaded = unsafe { Component::deserialize(&env.engine, &blob) }.unwrap();
    let load = t.elapsed();
    eprintln!("compile {compile:?}, deserialize {load:?}");
    assert!(loaded.get_export_index(None, CODE_ACTIONS).is_some());
    assert!(load < compile);
}
