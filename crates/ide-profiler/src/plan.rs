//! Which profiler samples a configuration, and how its command line changes.

use crate::{ProfileMode, ProfilePrepared, ProfileSpec, ProfilerInstall};
use ide_run::RunConfig;
use ide_run::wrap::{self, program_name};
use std::path::{Path, PathBuf};

const ASYNC_PROFILER_HOME: &str = "https://github.com/async-profiler/async-profiler/releases";
const PY_SPY_HOME: &str = "https://github.com/benfred/py-spy";

fn s(v: &str) -> String {
    v.to_owned()
}

fn path(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn unsupported(reason: impl Into<String>) -> ProfilePrepared {
    ProfilePrepared::Unsupported { reason: reason.into() }
}

fn ready(profiler: &str, launch: RunConfig, spec: ProfileSpec) -> ProfilePrepared {
    ProfilePrepared::Ready { profiler: profiler.to_owned(), launch: Box::new(launch), spec }
}

/// What `key` holds for `config`: its own environment first, then the IDE's.
fn env_base(config: &RunConfig, key: &str) -> String {
    config.env.get(key).cloned().or_else(|| std::env::var(key).ok()).unwrap_or_default()
}

/// Appends `value` to the space-separated option variable `key` of `config`'s environment.
fn append_env(config: &mut RunConfig, key: &str, value: &str) {
    let base = env_base(config, key);
    let joined = if base.trim().is_empty() { value.to_owned() } else { format!("{base} {value}") };
    config.env.insert(key.to_owned(), joined);
}

/// How to run `config` under a sampling profiler. `out` is an existing empty
/// directory for the profile. Probes tools: call from a blocking thread.
/// Allocation modes exist for JVM programs only.
pub fn prepare(root: &Path, config: &RunConfig, out: &Path, mode: ProfileMode) -> ProfilePrepared {
    let dir = wrap::run_dir(root, config);
    let program = program_name(&config.command);
    if mode != ProfileMode::Cpu && program != "java" {
        return unsupported("Allocation profiling is available for JVM applications.");
    }
    match program.as_str() {
        "node" | "npx" | "tsx" | "ts-node" | "npm" | "pnpm" | "yarn" => node(root, config, out),
        "java" => jvm(root, config, &dir, out, mode),
        "cargo" => cargo(config, &dir, out),
        "bun" | "deno" => unsupported(format!("Profiling {program} programs is not supported.")),
        _ if config.kind == "native" => native(config, &dir, out),
        _ => match wrap::python_command(config) {
            Some(py) => python(root, config, &dir, out, py),
            None => unsupported(format!("No profiler is known for '{}'.", config.name)),
        },
    }
}

fn node(root: &Path, config: &RunConfig, out: &Path) -> ProfilePrepared {
    let mut launch = config.clone();
    // Every Node.js process of the run writes a profile when it exits.
    append_env(&mut launch, "NODE_OPTIONS", &format!("--cpu-prof --cpu-prof-dir={}", quote_opt(&path(out))));
    ready(
        "node --cpu-prof",
        launch,
        ProfileSpec::CpuProfiles { dir: out.to_path_buf().into(), root: root.to_path_buf().into() },
    )
}

/// `NODE_OPTIONS` / `JAVA_TOOL_OPTIONS` values are split on spaces; quote paths that have them.
fn quote_opt(v: &str) -> String {
    if v.contains(' ') { format!("\"{v}\"") } else { v.to_owned() }
}

fn python(root: &Path, config: &RunConfig, dir: &Path, out: &Path, py: wrap::PythonCommand) -> ProfilePrepared {
    if py.target.is_empty() {
        return unsupported("Profiling needs a Python script or module to run.");
    }
    // py-spy installed into the interpreter's environment lives next to it.
    let beside =
        Path::new(&py.interpreter[0]).parent().map(|d| d.join(if cfg!(windows) { "py-spy.exe" } else { "py-spy" }));
    let Some(py_spy) = beside.filter(|p| p.is_file()).or_else(|| wrap::find_tool("py-spy", config, dir, root)) else {
        let install = (py.manager.is_none()).then(|| {
            let mut argv = py.interpreter.clone();
            argv.extend([s("-m"), s("pip"), s("install"), s("py-spy")]);
            let (command, args) = argv.split_first().map(|(c, a)| (c.clone(), a.to_vec())).unwrap_or_default();
            ProfilerInstall { command, args, cwd: Some(dir.to_path_buf().into()) }
        });
        return ProfilePrepared::MissingTool {
            tool: s("py-spy"),
            message: s("Profiling Python needs py-spy."),
            install,
            homepage: Some(PY_SPY_HOME.into()),
        };
    };
    let mut args = vec![
        s("record"),
        s("--format"),
        s("raw"),
        s("--function"),
        s("--subprocesses"),
        s("-o"),
        path(&out.join("profile.txt")),
        s("--"),
    ];
    args.extend(py.interpreter.iter().cloned());
    args.extend(py.target.iter().cloned());
    let launch = RunConfig { command: path(&py_spy), args, ..config.clone() };
    let spec = ProfileSpec::Folded {
        profiler: s("py-spy"),
        dir: out.to_path_buf().into(),
        ext: s("txt"),
        base: dir.to_path_buf().into(),
        jvm_root: None,
        mode: ProfileMode::Cpu,
    };
    ready("py-spy", launch, spec)
}

/// `libasyncProfiler.{so,dylib}` from `ASYNC_PROFILER_HOME` or next to `asprof` on the search path.
fn async_profiler_lib(config: &RunConfig) -> Option<PathBuf> {
    let lib = if cfg!(target_os = "macos") { "libasyncProfiler.dylib" } else { "libasyncProfiler.so" };
    let mut homes: Vec<PathBuf> = Vec::new();
    if let Some(h) =
        config.env.get("ASYNC_PROFILER_HOME").cloned().or_else(|| std::env::var("ASYNC_PROFILER_HOME").ok())
    {
        homes.push(h.into());
    }
    if let Some(asprof) = ide_run::which::find_executable("asprof", &wrap::search_path(config)) {
        let real = std::fs::canonicalize(&asprof).unwrap_or(asprof);
        if let Some(home) = real.parent().and_then(Path::parent) {
            homes.push(home.to_path_buf());
        }
    }
    homes.into_iter().map(|h| h.join("lib").join(lib)).find(|p| p.is_file())
}

/// async-profiler's `live` option needs JDK 11+. An unreadable version does not stop the run.
/// Only an absolute launcher is checked: a bare `java` is resolved to the project's JDK at
/// launch, which need not be the first `java` on the search path.
fn live_objects_jdk_too_old(config: &RunConfig) -> Option<ProfilePrepared> {
    let command = Path::new(&config.command);
    if !command.is_absolute() {
        return None;
    }
    let version = ide_run::java_cmdline::java_feature_version(command)?;
    (version < 11).then(|| {
        unsupported(format!("Profiling live objects needs JDK 11 or newer; '{}' runs JDK {version}.", config.name))
    })
}

fn jvm(root: &Path, config: &RunConfig, dir: &Path, out: &Path, mode: ProfileMode) -> ProfilePrepared {
    if cfg!(windows) {
        return unsupported("async-profiler, used to profile JVM applications, does not run on Windows.");
    }
    if mode == ProfileMode::LiveObjects
        && let Some(refusal) = live_objects_jdk_too_old(config)
    {
        return refusal;
    }
    let Some(lib) = async_profiler_lib(config) else {
        return ProfilePrepared::MissingTool {
            tool: s("async-profiler"),
            message: s(
                "Profiling JVM applications needs async-profiler: unpack a release and put its bin/asprof on the PATH (or set ASYNC_PROFILER_HOME).",
            ),
            install: None,
            homepage: Some(ASYNC_PROFILER_HOME.into()),
        };
    };
    let mut launch = config.clone();
    let file = out.join("profile-%p.collapsed");
    // One event per run: async-profiler cannot combine `cpu` with `alloc` in collapsed output.
    let event = match mode {
        ProfileMode::Cpu => "cpu",
        ProfileMode::Allocations => "alloc,total",
        ProfileMode::LiveObjects => "alloc,live",
    };
    let agent = format!("-agentpath:{}=start,event={event},collapsed,file={}", path(&lib), path(&file));
    if mode == ProfileMode::LiveObjects {
        // The IDE reaches the running JVM through its attach listener, never by SIGQUIT.
        let jvm_args = format!("{} {}", env_base(config, "JAVA_TOOL_OPTIONS"), config.args.join(" "));
        if ide_jvm_attach::wants_listener_flag(&jvm_args) {
            append_env(&mut launch, "JAVA_TOOL_OPTIONS", ide_jvm_attach::START_LISTENER_FLAG);
        }
    }
    append_env(&mut launch, "JAVA_TOOL_OPTIONS", &quote_opt(&agent));
    let spec = ProfileSpec::Folded {
        profiler: s("async-profiler"),
        dir: out.to_path_buf().into(),
        ext: s("collapsed"),
        base: dir.to_path_buf().into(),
        jvm_root: Some(root.to_path_buf().into()),
        mode,
    };
    ready("async-profiler", launch, spec)
}

fn perf(config: &RunConfig) -> Result<PathBuf, Box<ProfilePrepared>> {
    if !cfg!(target_os = "linux") {
        return Err(Box::new(unsupported(
            "Native programs are profiled with Linux perf; on this system there is no sampling profiler OpenIDEA can drive without root.",
        )));
    }
    ide_run::which::find_executable("perf", &wrap::search_path(config)).ok_or_else(|| {
        Box::new(ProfilePrepared::MissingTool {
            tool: s("perf"),
            message: s("Profiling native programs needs perf (linux-tools / linux-perf package)."),
            install: None,
            homepage: Some(s("https://perfwiki.github.io/main/")),
        })
    })
}

fn record_args(data: &Path) -> Vec<String> {
    vec![s("record"), s("-F"), s("999"), s("-g"), s("-o"), path(data)]
}

fn perf_spec(perf: &Path, data: PathBuf, dir: &Path, config: &RunConfig) -> ProfileSpec {
    ProfileSpec::Perf { perf: path(perf), data: data.into(), cwd: dir.to_path_buf().into(), env: config.env.clone() }
}

fn native(config: &RunConfig, dir: &Path, out: &Path) -> ProfilePrepared {
    let perf = match perf(config) {
        Ok(p) => p,
        Err(e) => return *e,
    };
    let data = out.join("perf.data");
    let mut args = record_args(&data);
    args.push(s("--"));
    args.push(config.command.clone());
    args.extend(config.args.iter().cloned());
    let launch = RunConfig { command: path(&perf), args, ..config.clone() };
    ready("perf", launch, perf_spec(&perf, data, dir, config))
}

fn cargo(config: &RunConfig, dir: &Path, out: &Path) -> ProfilePrepared {
    let toolchain = config.args.iter().take_while(|a| a.starts_with('+')).count();
    if config.args.get(toolchain).map(String::as_str) != Some("run") {
        return unsupported("Profiling runs `cargo run` configurations.");
    }
    let perf = match perf(config) {
        Ok(p) => p,
        Err(e) => return *e,
    };
    let data = out.join("perf.data");
    // Only the program runs under perf (not the build): perf becomes cargo's target runner.
    let runner: Vec<String> =
        std::iter::once(path(&perf)).chain(record_args(&data)).chain(std::iter::once(s("--"))).collect();
    let toml = runner.iter().map(|a| format!("'{}'", a.replace('\'', ""))).collect::<Vec<_>>().join(",");
    let mut args: Vec<String> = config.args[..toolchain].to_vec();
    args.push(s("--config"));
    args.push(format!("target.'cfg(all())'.runner=[{toml}]"));
    args.extend(config.args[toolchain..].iter().cloned());
    let launch = RunConfig { args, ..config.clone() };
    ready("perf", launch, perf_spec(&perf, data, dir, config))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn cfg(kind: &str, command: &str, args: &[&str]) -> RunConfig {
        RunConfig {
            id: "t".into(),
            name: "t".into(),
            kind: kind.into(),
            command: command.into(),
            args: args.iter().map(|s| s.to_string()).collect(),
            cwd: None,
            env: BTreeMap::new(),
            detected: true,
            is_test: false,
            debug_adapter: None,
            allow_parallel: false,
            extras: Default::default(),
        }
    }

    #[test]
    fn node_runs_with_cpu_prof() {
        let dir = tempfile::tempdir().unwrap();
        let mut c = cfg("node", "node", &["index.js"]);
        c.env.insert("NODE_OPTIONS".into(), "--max-old-space-size=4096".into());
        match prepare(dir.path(), &c, dir.path(), ProfileMode::Cpu) {
            ProfilePrepared::Ready { launch, spec, .. } => {
                let opts = &launch.env["NODE_OPTIONS"];
                assert!(opts.starts_with("--max-old-space-size=4096 --cpu-prof --cpu-prof-dir="));
                assert_eq!(launch.args, ["index.js"]);
                assert!(matches!(spec, ProfileSpec::CpuProfiles { .. }));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn python_uses_py_spy_or_asks_for_it() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("venv/bin");
        std::fs::create_dir_all(&bin).unwrap();
        let python = bin.join("python");
        std::fs::write(&python, "").unwrap();
        let mut c = cfg("python", &python.to_string_lossy(), &["main.py"]);
        c.env.insert("PATH".into(), dir.path().join("nothing").to_string_lossy().into_owned());
        match prepare(dir.path(), &c, dir.path(), ProfileMode::Cpu) {
            ProfilePrepared::MissingTool { tool, install: Some(i), .. } => {
                assert_eq!(tool, "py-spy");
                assert_eq!(i.args, ["-m", "pip", "install", "py-spy"]);
            }
            other => panic!("{other:?}"),
        }
        let spy = bin.join(if cfg!(windows) { "py-spy.exe" } else { "py-spy" });
        std::fs::write(&spy, "").unwrap();
        match prepare(dir.path(), &c, dir.path(), ProfileMode::Cpu) {
            ProfilePrepared::Ready { launch, .. } => {
                assert_eq!(launch.command, spy.to_string_lossy());
                assert_eq!(&launch.args[..4], ["record", "--format", "raw", "--function"]);
                let dash = launch.args.iter().position(|a| a == "--").unwrap();
                assert_eq!(&launch.args[dash + 1..], [python.to_string_lossy().as_ref(), "main.py"]);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn jvm_without_async_profiler_points_to_releases() {
        if cfg!(windows) {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let mut c = cfg("application", "java", &["-cp", "${classpath}", "com.x.App"]);
        c.env.insert("PATH".into(), dir.path().to_string_lossy().into_owned());
        c.env.insert("ASYNC_PROFILER_HOME".into(), dir.path().join("none").to_string_lossy().into_owned());
        assert!(matches!(
            prepare(dir.path(), &c, dir.path(), ProfileMode::Cpu),
            ProfilePrepared::MissingTool { install: None, .. }
        ));
        let home = fake_async_profiler(dir.path());
        c.env.insert("ASYNC_PROFILER_HOME".into(), home.to_string_lossy().into_owned());
        match prepare(dir.path(), &c, dir.path(), ProfileMode::Cpu) {
            ProfilePrepared::Ready { launch, spec, .. } => {
                let opts = &launch.env["JAVA_TOOL_OPTIONS"];
                assert!(opts.contains("=start,event=cpu,collapsed,file="));
                assert!(!opts.contains("StartAttachListener"));
                assert!(matches!(spec, ProfileSpec::Folded { mode: ProfileMode::Cpu, .. }));
            }
            other => panic!("{other:?}"),
        }
    }

    /// A JVM configuration whose async-profiler and `PATH` are both under `dir`.
    fn jvm_cfg(dir: &Path, command: &str, args: &[&str]) -> RunConfig {
        let mut c = cfg("application", command, args);
        c.env.insert("PATH".into(), dir.join("nothing").to_string_lossy().into_owned());
        c.env.insert("ASYNC_PROFILER_HOME".into(), fake_async_profiler(dir).to_string_lossy().into_owned());
        c.env.insert("JAVA_TOOL_OPTIONS".into(), "-Xmx2g".into());
        c
    }

    /// Creates `<dir>/ap/lib/libasyncProfiler.*` and returns the home directory.
    fn fake_async_profiler(dir: &Path) -> PathBuf {
        let home = dir.join("ap");
        let lib_dir = home.join("lib");
        std::fs::create_dir_all(&lib_dir).unwrap();
        let lib =
            lib_dir.join(if cfg!(target_os = "macos") { "libasyncProfiler.dylib" } else { "libasyncProfiler.so" });
        std::fs::write(lib, "").unwrap();
        home
    }

    fn ready_jvm(c: &RunConfig, dir: &Path, mode: ProfileMode) -> (RunConfig, ProfileSpec) {
        match prepare(dir, c, dir, mode) {
            ProfilePrepared::Ready { launch, spec, .. } => (*launch, spec),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn jvm_allocations_records_bytes() {
        if cfg!(windows) {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let c = jvm_cfg(dir.path(), "java", &["-cp", "${classpath}", "com.x.App"]);
        let (launch, spec) = ready_jvm(&c, dir.path(), ProfileMode::Allocations);
        let opts = &launch.env["JAVA_TOOL_OPTIONS"];
        assert!(opts.contains("=start,event=alloc,total,collapsed,file="), "{opts}");
        assert!(!opts.contains("StartAttachListener"), "{opts}");
        assert!(!opts.contains("alloc="), "{opts}");
        assert!(
            matches!(spec, ProfileSpec::Folded { mode: ProfileMode::Allocations, ref ext, .. } if ext == "collapsed")
        );
    }

    #[test]
    fn jvm_live_objects_starts_the_attach_listener() {
        if cfg!(windows) {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let c = jvm_cfg(dir.path(), "java", &["-cp", "${classpath}", "com.x.App"]);
        let (launch, spec) = ready_jvm(&c, dir.path(), ProfileMode::LiveObjects);
        let opts = &launch.env["JAVA_TOOL_OPTIONS"];
        assert!(opts.starts_with("-Xmx2g -XX:+StartAttachListener -agentpath:"), "{opts}");
        assert!(opts.contains("event=alloc,live,collapsed"), "{opts}");
        assert!(!opts.contains("total"), "{opts}");
        assert!(
            matches!(spec, ProfileSpec::Folded { mode: ProfileMode::LiveObjects, ref ext, .. } if ext == "collapsed")
        );
    }

    #[test]
    fn live_objects_keeps_user_attach_opt_out() {
        if cfg!(windows) {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let c = jvm_cfg(dir.path(), "java", &["-XX:+DisableAttachMechanism", "com.x.App"]);
        let (launch, _) = ready_jvm(&c, dir.path(), ProfileMode::LiveObjects);
        assert!(!launch.env["JAVA_TOOL_OPTIONS"].contains("StartAttachListener"));

        let mut c = jvm_cfg(dir.path(), "java", &["com.x.App"]);
        c.env.insert("JAVA_TOOL_OPTIONS".into(), "-XX:-StartAttachListener".into());
        let (launch, _) = ready_jvm(&c, dir.path(), ProfileMode::LiveObjects);
        let opts = &launch.env["JAVA_TOOL_OPTIONS"];
        assert!(opts.starts_with("-XX:-StartAttachListener -agentpath:"), "{opts}");
        assert!(!opts.contains("+StartAttachListener"), "{opts}");
    }

    #[test]
    fn live_objects_refuses_jdk8() {
        if cfg!(windows) {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let java = dir.path().join("jdk8/bin/java");
        std::fs::create_dir_all(java.parent().unwrap()).unwrap();
        std::fs::write(&java, "").unwrap();
        std::fs::write(dir.path().join("jdk8/release"), "JAVA_VERSION=\"1.8.0_512\"\n").unwrap();
        // No async-profiler is installed: the refusal does not depend on it.
        let mut c = cfg("application", &java.to_string_lossy(), &["com.x.App"]);
        c.env.insert("PATH".into(), dir.path().join("nothing").to_string_lossy().into_owned());
        c.env.insert("ASYNC_PROFILER_HOME".into(), dir.path().join("none").to_string_lossy().into_owned());
        match prepare(dir.path(), &c, dir.path(), ProfileMode::LiveObjects) {
            ProfilePrepared::Unsupported { reason } => assert!(reason.contains("JDK 11"), "{reason}"),
            other => panic!("{other:?}"),
        }
        // Allocations do not need the attach listener, so JDK 8 is fine.
        assert!(matches!(
            prepare(dir.path(), &c, dir.path(), ProfileMode::Allocations),
            ProfilePrepared::MissingTool { .. }
        ));

        std::fs::write(dir.path().join("jdk8/release"), "JAVA_VERSION=\"11.0.29\"\n").unwrap();
        c.env.insert("ASYNC_PROFILER_HOME".into(), fake_async_profiler(dir.path()).to_string_lossy().into_owned());
        assert!(matches!(prepare(dir.path(), &c, dir.path(), ProfileMode::LiveObjects), ProfilePrepared::Ready { .. }));
    }

    #[test]
    fn live_objects_runs_a_bare_java_command_whatever_jdk_is_on_the_path() {
        if cfg!(windows) {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("jdk8/bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("java"), "").unwrap();
        std::fs::write(dir.path().join("jdk8/release"), "JAVA_VERSION=\"1.8.0_512\"\n").unwrap();
        // The launcher picks the project's JDK, not the first `java` on the search path.
        let mut c = cfg("application", "java", &["com.x.App"]);
        c.env.insert("PATH".into(), bin.to_string_lossy().into_owned());
        c.env.insert("ASYNC_PROFILER_HOME".into(), fake_async_profiler(dir.path()).to_string_lossy().into_owned());
        let prepared = prepare(dir.path(), &c, dir.path(), ProfileMode::LiveObjects);
        assert!(matches!(prepared, ProfilePrepared::Ready { .. }), "{prepared:?}");
    }

    #[test]
    fn allocation_modes_need_a_jvm() {
        let dir = tempfile::tempdir().unwrap();
        let c = cfg("node", "node", &["index.js"]);
        for mode in [ProfileMode::Allocations, ProfileMode::LiveObjects] {
            match prepare(dir.path(), &c, dir.path(), mode) {
                ProfilePrepared::Unsupported { reason } => assert!(reason.contains("JVM"), "{reason}"),
                other => panic!("{other:?}"),
            }
        }
        assert!(matches!(prepare(dir.path(), &c, dir.path(), ProfileMode::Cpu), ProfilePrepared::Ready { .. }));
    }

    #[test]
    fn cargo_and_unknown() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(
            prepare(dir.path(), &cfg("cargo", "cargo", &["test"]), dir.path(), ProfileMode::Cpu),
            ProfilePrepared::Unsupported { .. }
        ));
        assert!(matches!(
            prepare(dir.path(), &cfg("make", "make", &[]), dir.path(), ProfileMode::Cpu),
            ProfilePrepared::Unsupported { .. }
        ));
        if !cfg!(target_os = "linux") {
            assert!(matches!(
                prepare(dir.path(), &cfg("cargo", "cargo", &["run"]), dir.path(), ProfileMode::Cpu),
                ProfilePrepared::Unsupported { .. }
            ));
        }
    }
}
