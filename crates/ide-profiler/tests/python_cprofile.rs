//! Profiling `fixtures/python-profiling` under cProfile with a real Python 3, to the end and
//! when Stop interrupts it; exit codes, `-c` code and `-m` modules run as Python runs them. Without `python3` (`python` on Windows) on the search path the
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
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    for marker in ["done", "looped"] {
        let mut line = String::new();
        stdout.read_line(&mut line).unwrap();
        assert_eq!(line.trim(), marker);
    }
    // What the first Stop sends.
    assert!(Command::new("kill").args(["-INT", &child.id().to_string()]).status().unwrap().success());
    child.wait().unwrap();
    let p = collect(&spec).unwrap();
    // One completed fib(22) followed by one completed fib(18).
    assert!(method(&p, "fib").calls.unwrap() >= 65_674.0, "both completed passes were profiled");
}

/// Waits up to a minute: a run that hangs fails the test instead of the whole suite.
fn finish(mut child: std::process::Child) -> std::process::ExitStatus {
    for _ in 0..600 {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    child.kill().unwrap();
    panic!("the profiled run did not end");
}

#[test]
fn the_runs_exit_code_and_c_code_are_kept() {
    let Some(python) = python() else { return };
    let out = tempfile::tempdir().unwrap();
    let (mut cmd, spec) =
        plan(&python, &["-c", "import sys\ndef work(): return sum(range(9))\nwork()\nsys.exit(3)"], out.path());
    assert_eq!(finish(cmd.spawn().unwrap()).code(), Some(3));
    let p = collect(&spec).unwrap();
    assert_eq!(method(&p, "work (<string>:2)").calls, Some(1.0));
}

#[test]
fn a_module_runs_as_main_so_multiprocessing_finds_its_functions() {
    let Some(python) = python() else { return };
    let project = tempfile::tempdir().unwrap();
    std::fs::write(
        project.path().join("pooled.py"),
        "import multiprocessing as mp\n\ndef square(x):\n    return x * x\n\nif __name__ == '__main__':\n    with mp.get_context('spawn').Pool(2) as pool:\n        print(pool.map(square, [1, 2, 3]))\n",
    )
    .unwrap();
    let out = tempfile::tempdir().unwrap();
    let (mut cmd, spec) = plan(&python, &["-m", "pooled"], out.path());
    // A free-threaded CPython (3.14t) hangs a Pool under cProfile, with `-m cProfile` too.
    cmd.current_dir(project.path()).env("PYTHON_GIL", "1");
    let mut child = cmd.spawn().unwrap();
    let mut printed = String::new();
    BufReader::new(child.stdout.take().unwrap()).read_line(&mut printed).unwrap();
    assert_eq!(printed.trim(), "[1, 4, 9]");
    assert!(finish(child).success());
    collect(&spec).unwrap();
}

/// What Stop does on Windows: the stop command creates the file the launcher watches. A run
/// blocked in a call that the interrupt does not wake is saved by the watcher.
#[test]
fn a_stop_file_ends_the_run_and_keeps_its_profile() {
    let Some(python) = python() else { return };
    let out = tempfile::tempdir().unwrap();
    let code = "import time\ndef wait():\n    while True:\n        time.sleep(30)\nprint('done', flush=True)\nwait()";
    let (mut cmd, spec) = plan(&python, &["-c", code], out.path());
    let stop = out.path().join("stop");
    let launch: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
    if !launch.iter().any(|a| a == "--stop") {
        let at = launch.iter().position(|a| a == "-c").unwrap();
        let mut args = launch[..at].to_vec();
        args.extend(["--stop".to_owned(), stop.to_string_lossy().into_owned()]);
        args.extend(launch[at..].iter().cloned());
        let program = cmd.get_program().to_owned();
        cmd = Command::new(program);
        cmd.args(args).current_dir(fixture()).stdout(Stdio::piped());
    }
    let mut child = cmd.spawn().unwrap();
    let mut line = String::new();
    BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
    std::fs::write(&stop, "").unwrap();
    assert!(!finish(child).success());
    assert!(collect(&spec).unwrap().methods.iter().any(|m| m.calls.is_some()));
}
