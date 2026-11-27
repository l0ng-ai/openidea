//! Profiling `fixtures/python-profiling` under cProfile with a real Python 3, to the end and
//! when Stop interrupts it. Without `python3` (`python` on Windows) on the search path the
//! tests return early.

use ide_profiler::{Profile, ProfileMode, ProfilePrepared, collect, prepare};
use ide_run::RunConfig;
use std::collections::BTreeMap;
#[cfg(unix)]
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/python-profiling").canonicalize().unwrap()
}

fn python() -> Option<String> {
    let name = if cfg!(windows) { "python" } else { "python3" };
    let ok = Command::new(name).arg("--version").output().is_ok_and(|o| o.status.success());
    ok.then(|| name.to_owned())
}

fn config(python: &str, args: &[&str]) -> RunConfig {
    RunConfig {
        id: "cpu".into(),
        name: "cpu_heavy".into(),
        kind: "python".into(),
        command: python.into(),
        args: args.iter().map(|a| a.to_string()).collect(),
        cwd: Some(fixture().into()),
        env: BTreeMap::new(),
        detected: false,
        is_test: false,
        debug_adapter: None,
        allow_parallel: false,
        extras: Default::default(),
    }
}

/// The cProfile launch for `args` and where its profile goes.
fn plan(python: &str, args: &[&str], out: &Path) -> (Command, ide_profiler::ProfileSpec) {
    let c = config(python, args);
    let ProfilePrepared::Ready { profiler, launch, spec } = prepare(&fixture(), &c, out, ProfileMode::Cpu, "cprofile")
    else {
        panic!("not ready");
    };
    assert_eq!(profiler, "cProfile");
    let mut cmd = Command::new(&launch.command);
    cmd.args(&launch.args).current_dir(fixture()).stdout(Stdio::piped());
    (cmd, spec)
}

fn method<'a>(p: &'a Profile, name: &str) -> &'a ide_profiler::MethodStat {
    p.methods.iter().find(|m| p.frames[m.frame as usize].name == name).unwrap_or_else(|| panic!("no {name}"))
}

#[test]
fn a_finished_run_maps_functions_to_the_fixture() {
    let Some(python) = python() else { return };
    let out = tempfile::tempdir().unwrap();
    let (mut cmd, spec) = plan(&python, &["cpu_heavy.py"], out.path());
    assert!(cmd.status().unwrap().success());
    let p = collect(&spec).unwrap();
    let fib = method(&p, "fib");
    // fib(22): 57,313 calls, one of them not recursive.
    assert_eq!((fib.calls, fib.primitive_calls), (Some(57313.0), Some(1.0)));
    let frame = &p.frames[fib.frame as usize];
    assert_eq!(frame.file.as_deref(), Some(fixture().join("cpu_heavy.py").as_path()));
    assert_eq!(frame.line, Some(9), "def fib is on line 10");
    let main = method(&p, "main");
    let checksum = method(&p, "checksum");
    assert!(main.total >= checksum.total && checksum.total > 0.0);
    assert!(p.calls.iter().any(|e| e.caller == main.frame && e.callee == fib.frame));
}

#[cfg(unix)]
#[test]
fn a_stopped_run_still_writes_its_profile() {
    let Some(python) = python() else { return };
    let out = tempfile::tempdir().unwrap();
    let (mut cmd, spec) = plan(&python, &["cpu_heavy.py", "--loop"], out.path());
    let mut child = cmd.spawn().unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
    assert_eq!(line.trim(), "done");
    // What the first Stop sends.
    assert!(Command::new("kill").args(["-INT", &child.id().to_string()]).status().unwrap().success());
    child.wait().unwrap();
    let p = collect(&spec).unwrap();
    assert!(method(&p, "fib").calls.unwrap() > 57313.0, "the loop ran");
}
