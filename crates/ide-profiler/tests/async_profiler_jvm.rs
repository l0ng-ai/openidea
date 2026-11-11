//! Allocation and live-object profiles of a real JVM under async-profiler.
//!
//! Run with `OPENIDEA_TEST_JAVA=<path to java> ASYNC_PROFILER_HOME=<async-profiler home>
//! cargo test -p ide-profiler --test async_profiler_jvm -- --ignored`; without both the tests return early.
#![cfg(unix)]

use ide_profiler::{Profile, ProfileFrameKind, ProfileMode, ProfilePrepared, collect, gc_before_stop, prepare};
use ide_run::RunConfig;
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

const MIB: f64 = 1024.0 * 1024.0;

/// 64 MiB stay reachable from a static field; 256 MiB are dropped at once. The volatile store
/// keeps the JIT from removing the garbage allocations.
const ALLOC_JAVA: &str = r#"
import java.util.ArrayList;
import java.util.List;

public class Alloc {
    static final List<byte[]> keep = new ArrayList<>();
    static volatile Object sink;

    static void retained() {
        for (int i = 0; i < 16384; i++) keep.add(new byte[4096]);
    }

    static void garbage() {
        for (int i = 0; i < 262144; i++) sink = new byte[1024];
    }

    public static void main(String[] args) throws Exception {
        retained();
        garbage();
        if (args.length > 0 && args[0].equals("wait")) {
            System.out.println("WAITING");
            System.out.flush();
            while (true) Thread.sleep(1000);
        }
    }
}
"#;

struct Env {
    java: PathBuf,
}

fn env() -> Option<Env> {
    let java = std::env::var_os("OPENIDEA_TEST_JAVA")?;
    std::env::var_os("ASYNC_PROFILER_HOME")?;
    Some(Env { java: java.into() })
}

/// A started JVM that is always stopped when the test ends, even by a failed assertion.
struct Jvm {
    child: Child,
    lines: Receiver<String>,
}

impl Jvm {
    fn start(launch: &RunConfig, cwd: &Path) -> Jvm {
        let mut child = Command::new(&launch.command)
            .args(&launch.args)
            .envs(&launch.env)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("start java");
        let stdout = child.stdout.take().unwrap();
        let (tx, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        Jvm { child, lines }
    }

    fn pid(&self) -> i32 {
        self.child.id() as i32
    }

    fn wait_for_line(&self, wanted: &str, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.lines.recv_timeout(left) {
                Ok(line) if line.trim() == wanted => return,
                Ok(_) => {}
                Err(e) => panic!("the JVM never printed {wanted}: {e}"),
            }
        }
    }

    fn interrupt(&self) {
        Command::new("kill").args(["-INT", &self.pid().to_string()]).status().expect("run kill");
    }

    fn wait_exit(&mut self, timeout: Duration) -> ExitStatus {
        self.try_wait_exit(timeout).unwrap_or_else(|| panic!("the JVM did not exit in {timeout:?}"))
    }

    fn try_wait_exit(&mut self, timeout: Duration) -> Option<ExitStatus> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Ok(Some(status)) = self.child.try_wait() {
                return Some(status);
            }
            if Instant::now() >= deadline {
                return None;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

impl Drop for Jvm {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_some() {
            return;
        }
        self.interrupt();
        if self.try_wait_exit(Duration::from_secs(10)).is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

struct Run {
    _dir: tempfile::TempDir,
    cwd: PathBuf,
    launch: RunConfig,
    spec: ide_profiler::ProfileSpec,
}

fn prepared(env: &Env, mode: ProfileMode, program_mode: &str) -> Run {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_path_buf();
    let source = cwd.join("Alloc.java");
    std::fs::write(&source, ALLOC_JAVA).unwrap();
    let out = cwd.join("out");
    std::fs::create_dir(&out).unwrap();
    let config = RunConfig {
        id: "alloc".into(),
        name: "Alloc".into(),
        kind: "application".into(),
        command: env.java.to_string_lossy().into_owned(),
        args: vec![source.to_string_lossy().into_owned(), program_mode.into()],
        cwd: None,
        env: BTreeMap::new(),
        detected: false,
        is_test: false,
        debug_adapter: None,
        allow_parallel: false,
        extras: Default::default(),
    };
    match prepare(&cwd, &config, &out, mode) {
        ProfilePrepared::Ready { launch, spec, .. } => Run { _dir: dir, cwd, launch: *launch, spec },
        other => panic!("{other:?}"),
    }
}

/// Weight of every node whose function is `name`.
fn weight_of(profile: &Profile, name: &str) -> f64 {
    profile.nodes.iter().filter(|n| profile.frames[n.frame as usize].name == name).fold(0.0, |sum, n| sum + n.total)
}

#[test]
#[ignore = "needs a JDK (OPENIDEA_TEST_JAVA) and async-profiler (ASYNC_PROFILER_HOME)"]
fn allocations_profile_weighs_bytes() {
    let Some(env) = env() else { return };
    let run = prepared(&env, ProfileMode::Allocations, "exit");
    let mut jvm = Jvm::start(&run.launch, &run.cwd);
    assert!(jvm.wait_exit(Duration::from_secs(120)).success());

    let profile = collect(&run.spec).unwrap();
    assert_eq!(profile.unit, "bytes");
    let garbage = weight_of(&profile, "Alloc.garbage");
    eprintln!("allocations: Alloc.garbage = {:.1} MiB, total = {:.1} MiB", garbage / MIB, profile.total / MIB);
    assert!((200.0 * MIB..=330.0 * MIB).contains(&garbage), "Alloc.garbage = {:.1} MiB", garbage / MIB);
    assert!(profile.frames.iter().any(|f| f.name == "byte[]" && f.kind == ProfileFrameKind::AllocatedType));
}

#[test]
#[ignore = "needs a JDK (OPENIDEA_TEST_JAVA) and async-profiler (ASYNC_PROFILER_HOME)"]
fn live_objects_after_gc_keep_only_retained() {
    let Some(env) = env() else { return };
    let run = prepared(&env, ProfileMode::LiveObjects, "wait");
    let mut jvm = Jvm::start(&run.launch, &run.cwd);
    jvm.wait_for_line("WAITING", Duration::from_secs(120));
    assert_eq!(gc_before_stop(&[jvm.pid()]), 1);
    jvm.interrupt();
    jvm.wait_exit(Duration::from_secs(60));

    let profile = collect(&run.spec).unwrap();
    assert_eq!(profile.unit, "samples");
    let retained = weight_of(&profile, "Alloc.retained");
    let garbage = weight_of(&profile, "Alloc.garbage");
    let share = retained / (retained + garbage);
    eprintln!("live objects: retained = {retained}, garbage = {garbage}, share = {:.1} %", share * 100.0);
    assert!(retained > 0.0, "no live sample under Alloc.retained");
    assert!(share >= 0.9, "retained share {:.1} %", share * 100.0);
}
