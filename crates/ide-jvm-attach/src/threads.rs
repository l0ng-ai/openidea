use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Read;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::heap_dump::quoted_path;
use crate::listener::is_hotspot;
use crate::socket::{AttachError, MAX_OUTPUT, jcmd};

/// Default budget for `thread_print`; a dump of a healthy JVM takes milliseconds, so this only
/// bounds a JVM stuck at a safepoint.
pub const THREAD_DUMP_TIMEOUT: Duration = Duration::from_secs(10);

/// System property the IDE adds to a run's JVM so it can be found even when the build tool
/// forks it outside the run's process tree (a Gradle daemon).
pub const RUN_TOKEN_PROPERTY: &str = "-Dopenidea.run.token=";

/// Gradle's own JVMs: the client that waits for the build, the daemon that runs it, and the
/// workers and Kotlin compile daemon it forks (beside the application under `--no-daemon`).
/// None is the application, even when it is the only JVM under the run's root.
const GRADLE_JVM_MARKERS: [&str; 5] = [
    "org.gradle.wrapper.GradleWrapperMain",
    "org.gradle.launcher.GradleMain",
    "org.gradle.launcher.daemon",
    "org.gradle.process.internal.worker.GradleWorkerMain",
    "org.jetbrains.kotlin.daemon.KotlinCompileDaemon",
];

/// `Thread.print -l` also lists the owned `java.util.concurrent` locks, which deadlock
/// reports need.
pub fn thread_print(pid: u32, timeout: Duration) -> Result<String, AttachError> {
    jcmd(pid, "Thread.print -l", timeout)
}

/// `Thread.dump_to_file -format=json`, the only dump that lists virtual threads (JDK 21+). The
/// JVM writes it into `dir`, an absolute directory; the file is read up to [`MAX_OUTPUT`] and
/// deleted whatever the outcome. Never send it to a VM a debugger holds suspended: 21 and 25 hang
/// the request, and every later attach request behind it, until the VM resumes.
pub fn thread_dump_json(pid: u32, dir: &Path, timeout: Duration) -> Result<String, AttachError> {
    dump_json_with(pid, dir, MAX_OUTPUT, |command| jcmd(pid, command, timeout))
}

fn dump_json_with(
    pid: u32,
    dir: &Path,
    max: usize,
    send: impl FnOnce(&str) -> Result<String, AttachError>,
) -> Result<String, AttachError> {
    // The JVM resolves a relative path against its own working directory.
    if !dir.is_absolute() {
        return Err(AttachError::Protocol(format!("thread dump directory {dir:?} is not absolute")));
    }
    // JDK 21 has no `-overwrite` and writes nothing when the file exists.
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |since| since.as_nanos());
    let path = dir.join(format!("threads-{pid}-{nanos}.json"));
    let command = format!("Thread.dump_to_file -format=json {}", quoted_path(&path, "thread dump")?);
    let _delete = DeleteOnDrop(&path);
    let reply = send(&command)?;
    read_capped(&path, max).map_err(|e| match e {
        AttachError::Io(e) if e.kind() == std::io::ErrorKind::NotFound => {
            AttachError::Protocol(format!("the JVM wrote no thread dump: {}", reply.trim()))
        }
        e => e,
    })
}

fn read_capped(path: &Path, max: usize) -> Result<String, AttachError> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)?.take(max as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > max {
        return Err(AttachError::TooLarge);
    }
    String::from_utf8(bytes).map_err(|_| AttachError::Protocol("the thread dump is not UTF-8".into()))
}

struct DeleteOnDrop<'a>(&'a Path);

impl Drop for DeleteOnDrop<'_> {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(self.0);
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProcEntry {
    pub pid: u32,
    pub ppid: u32,
    /// The full argv joined by spaces, as `ps` prints it.
    pub command: String,
}

/// Every process of the machine; empty when `ps` is unavailable.
pub fn process_table() -> Vec<ProcEntry> {
    let Ok(out) = Command::new("ps").args(["-A", "-o", "pid=,ppid=,command="]).output() else {
        return Vec::new();
    };
    String::from_utf8_lossy(&out.stdout).lines().filter_map(parse_ps_line).collect()
}

fn parse_ps_line(line: &str) -> Option<ProcEntry> {
    let (pid, rest) = line.trim_start().split_once(char::is_whitespace)?;
    let (ppid, command) = rest.trim_start().split_once(char::is_whitespace)?;
    Some(ProcEntry { pid: pid.parse().ok()?, ppid: ppid.parse().ok()?, command: command.trim().to_string() })
}

/// The JVM that runs a run configuration: the deepest HotSpot JVM below `root` that is not
/// Gradle's own (a Maven `spring-boot:run` forks the application under the Maven JVM), else
/// the one carrying `token` (a Gradle daemon forks it outside the run's tree, which then holds
/// only the Gradle client). Ties go to the highest pid.
pub fn select_run_jvm(
    table: &[ProcEntry],
    root: u32,
    token: Option<&str>,
    is_hotspot: impl Fn(u32) -> bool,
) -> Option<u32> {
    // The tree first: a token is only as unique as the configuration and project it names.
    deepest_jvm_in_tree(table, root, &is_hotspot).or_else(|| {
        let wanted = format!("{RUN_TOKEN_PROPERTY}{}", token.filter(|token| !token.is_empty())?);
        table
            .iter()
            // The Gradle client carries the token too: a delegated run passes it on its command line.
            .filter(|entry| {
                entry.command.split_whitespace().any(|arg| arg == wanted)
                    && !is_gradle_jvm(&entry.command)
                    && is_hotspot(entry.pid)
            })
            .map(|entry| entry.pid)
            .max()
    })
}

/// Confirmed HotSpot (`is_hotspot`) and, by its command line, not one of Gradle's own JVMs.
pub fn is_application_jvm(pid: u32) -> bool {
    is_hotspot(pid) && !command_line(pid).is_some_and(|command| is_gradle_jvm(&command))
}

fn command_line(pid: u32) -> Option<String> {
    let out = Command::new("ps").args(["-o", "command=", "-p", &pid.to_string()]).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

fn is_gradle_jvm(command: &str) -> bool {
    GRADLE_JVM_MARKERS.iter().any(|marker| command.contains(marker))
}

fn deepest_jvm_in_tree(table: &[ProcEntry], root: u32, is_hotspot: &dyn Fn(u32) -> bool) -> Option<u32> {
    let mut children: HashMap<u32, Vec<&ProcEntry>> = HashMap::new();
    for entry in table {
        children.entry(entry.ppid).or_default().push(entry);
    }
    let by_pid: HashMap<u32, &ProcEntry> = table.iter().map(|entry| (entry.pid, entry)).collect();

    let mut seen = HashSet::from([root]);
    let mut queue = VecDeque::from([(root, 0usize)]);
    let mut best: Option<(usize, u32)> = None;
    while let Some((pid, depth)) = queue.pop_front() {
        let is_app_jvm = by_pid.get(&pid).is_some_and(|entry| !is_gradle_jvm(&entry.command)) && is_hotspot(pid);
        if is_app_jvm && best.is_none_or(|found| (depth, pid) > found) {
            best = Some((depth, pid));
        }
        for child in children.get(&pid).into_iter().flatten() {
            if seen.insert(child.pid) {
                queue.push_back((child.pid, depth + 1));
            }
        }
    }
    best.map(|(_, pid)| pid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn entry(pid: u32, ppid: u32, command: &str) -> ProcEntry {
        ProcEntry { pid, ppid, command: command.to_string() }
    }

    fn any_pid(_: u32) -> bool {
        true
    }

    /// The shell at pid 10 is not a JVM, as the real `is_hotspot` would say.
    fn not_the_shell(pid: u32) -> bool {
        pid != 10
    }

    fn gradle_run() -> Vec<ProcEntry> {
        vec![
            entry(10, 1, "/bin/zsh"),
            entry(11, 10, "/jdk/bin/java -classpath wrapper.jar org.gradle.wrapper.GradleWrapperMain run"),
            entry(50, 40, "/jdk/bin/java -Dopenidea.run.token=cfg-1 -cp app Main"),
        ]
    }

    #[test]
    fn select_falls_back_to_the_token_when_the_tree_holds_only_gradle() {
        let table = gradle_run();
        assert_eq!(select_run_jvm(&table, 10, Some("cfg-1"), not_the_shell), Some(50));
        assert_eq!(select_run_jvm(&table, 10, Some("cfg-2"), not_the_shell), None);
    }

    #[test]
    fn select_skips_the_gradle_client_that_carries_the_token() {
        let client = |pid| {
            entry(
                pid,
                10,
                "/jdk/bin/java -Dopenidea.run.token=cfg-1 -classpath wrapper.jar org.gradle.wrapper.GradleWrapperMain run",
            )
        };
        let app = entry(50, 40, "/jdk/bin/java -Dopenidea.run.token=cfg-1 -cp app Main");
        for client_pid in [11, 99] {
            let table = vec![entry(10, 1, "/bin/zsh"), client(client_pid), app.clone()];
            assert_eq!(select_run_jvm(&table, 10, Some("cfg-1"), not_the_shell), Some(50), "client {client_pid}");
        }
        // Only the client carries it: the tree rules apply, which skip the client too.
        let table = vec![entry(10, 1, "/bin/zsh"), client(11), entry(12, 11, "/jdk/bin/java -cp app Main")];
        assert_eq!(select_run_jvm(&table, 10, Some("cfg-1"), not_the_shell), Some(12));
        let alone = vec![entry(10, 1, "/bin/zsh"), client(11)];
        assert_eq!(select_run_jvm(&alone, 10, Some("cfg-1"), not_the_shell), None);
        let launcher = entry(13, 10, "java -Dopenidea.run.token=cfg-1 org.gradle.launcher.GradleMain run");
        assert_eq!(select_run_jvm(&[entry(10, 1, "sh"), launcher], 10, Some("cfg-1"), not_the_shell), None);
    }

    #[test]
    fn select_prefers_the_run_tree_over_a_token_elsewhere() {
        // Another worktree's delegated JVM carries the same token as this plain run.
        let table = vec![
            entry(10, 1, "/bin/zsh"),
            entry(11, 10, "/jdk/bin/java -Dopenidea.run.token=cfg-1 -cp app Main"),
            entry(50, 40, "/jdk/bin/java -Dopenidea.run.token=cfg-1 -cp app Main"),
        ];
        assert_eq!(select_run_jvm(&table, 10, Some("cfg-1"), not_the_shell), Some(11));
    }

    #[test]
    fn select_picks_deepest_jvm_in_tree() {
        let table = vec![
            entry(10, 1, "/bin/zsh"),
            entry(11, 10, "/jdk/bin/java -classpath maven.jar org.codehaus.plexus.classworlds.launcher.Launcher"),
            entry(12, 11, "/jdk/bin/java -cp app Main"),
        ];
        assert_eq!(select_run_jvm(&table, 10, None, not_the_shell), Some(12));
    }

    #[test]
    fn select_ignores_token_substring() {
        let table = vec![entry(50, 1, "java -Dopenidea.run.token=cfg-10 -cp app Main")];
        assert_eq!(select_run_jvm(&table, 10, Some("cfg-1"), any_pid), None);
        assert_eq!(select_run_jvm(&table, 10, Some("cfg-10"), any_pid), Some(50));
    }

    #[test]
    fn select_none_when_tree_has_no_jvm() {
        let table = vec![entry(10, 1, "/bin/zsh"), entry(11, 10, "/bin/sleep 5"), entry(12, 1, "java -cp app Main")];
        assert_eq!(select_run_jvm(&table, 10, None, |pid| pid == 12), None);
    }

    #[test]
    fn select_treats_an_empty_token_as_no_token() {
        // "-Dopenidea.run.token=" with nothing after it must not tag every such process.
        let table =
            vec![entry(50, 1, "java -Dopenidea.run.token= -cp app Main"), entry(10, 1, "sh"), entry(11, 10, "java a")];
        assert_eq!(select_run_jvm(&table, 10, Some(""), not_the_shell), Some(11));
    }

    #[test]
    fn select_takes_the_highest_pid_among_equally_deep_jvms() {
        let table = vec![entry(10, 1, "sh"), entry(11, 10, "java a"), entry(12, 10, "java b")];
        assert_eq!(select_run_jvm(&table, 10, None, not_the_shell), Some(12));
        let tagged = vec![entry(5, 1, "java -Dopenidea.run.token=t"), entry(7, 1, "java -Dopenidea.run.token=t")];
        assert_eq!(select_run_jvm(&tagged, 10, Some("t"), any_pid), Some(7));
    }

    #[test]
    fn select_skips_tagged_processes_that_are_not_a_hotspot_jvm() {
        let table = vec![entry(50, 1, "native -Dopenidea.run.token=t"), entry(10, 1, "sh"), entry(11, 10, "java a")];
        assert_eq!(select_run_jvm(&table, 10, Some("t"), |pid| pid == 11), Some(11));
    }

    #[test]
    fn select_includes_the_root_itself() {
        let table = vec![entry(10, 1, "java -cp app Main")];
        assert_eq!(select_run_jvm(&table, 10, None, any_pid), Some(10));
    }

    #[test]
    fn select_survives_a_parent_cycle() {
        let table = vec![entry(10, 11, "sh"), entry(11, 10, "java a")];
        assert_eq!(select_run_jvm(&table, 10, None, not_the_shell), Some(11));
    }

    /// The path the fake JVM is asked to write, from `Thread.dump_to_file … "<path>"`.
    fn requested_path(command: &str) -> PathBuf {
        PathBuf::from(command.split('"').nth(1).expect("quoted path"))
    }

    fn is_empty(dir: &Path) -> bool {
        std::fs::read_dir(dir).unwrap().next().is_none()
    }

    /// `<tmp>/a b`: the space is what an unquoted path would break on.
    fn dir_with_space() -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("a b");
        std::fs::create_dir(&dir).unwrap();
        (root, dir)
    }

    #[test]
    fn json_dump_reads_the_file_and_deletes_it() {
        let (_root, dir) = dir_with_space();
        let mut sent = String::new();
        let json = dump_json_with(42, &dir, 1024, |command| {
            sent = command.to_owned();
            std::fs::write(requested_path(command), "{\"threadDump\":{}}").unwrap();
            Ok(format!("Created {}\n", requested_path(command).display()))
        })
        .unwrap();
        assert_eq!(json, "{\"threadDump\":{}}");
        let prefix = format!("Thread.dump_to_file -format=json \"{}", dir.join("threads-42-").display());
        assert!(sent.starts_with(&prefix) && sent.ends_with(".json\""), "{sent}");
        assert!(is_empty(&dir));
    }

    #[test]
    fn json_dump_file_is_deleted_when_it_is_too_large() {
        let (_root, dir) = dir_with_space();
        let result = dump_json_with(42, &dir, 1024, |command| {
            std::fs::write(requested_path(command), vec![b' '; 1025]).unwrap();
            Ok(String::new())
        });
        assert!(matches!(result, Err(AttachError::TooLarge)), "{result:?}");
        assert!(is_empty(&dir));
    }

    #[test]
    fn json_dump_file_is_deleted_when_the_request_fails() {
        let (_root, dir) = dir_with_space();
        let result = dump_json_with(42, &dir, 1024, |command| {
            // The JVM wrote the file but the reply came too late.
            std::fs::write(requested_path(command), "{}").unwrap();
            Err(AttachError::Timeout)
        });
        assert!(matches!(result, Err(AttachError::Timeout)), "{result:?}");
        assert!(is_empty(&dir));
    }

    #[test]
    fn json_dump_without_a_file_reports_the_reply() {
        let (_root, dir) = dir_with_space();
        // JDK 21 answers result code 0 when it writes nothing.
        let result = dump_json_with(42, &dir, 1024, |_| Ok("/x.json exists, use -overwrite to overwrite\n".into()));
        let Err(AttachError::Protocol(message)) = result else { panic!("{result:?}") };
        assert!(message.contains("exists"), "{message}");
    }

    #[test]
    fn json_dump_refuses_a_relative_directory() {
        let result = dump_json_with(42, Path::new("dumps"), 1024, |_| panic!("sent a relative path"));
        assert!(matches!(result, Err(AttachError::Protocol(_))), "{result:?}");
    }

    #[test]
    fn select_skips_gradle_workers_and_the_kotlin_daemon() {
        // `--no-daemon`: the build's helper JVMs sit beside the application in the run's tree.
        let worker = "/jdk/bin/java -cp gradle-worker.jar worker.org.gradle.process.internal.worker.GradleWorkerMain 'Gradle Worker Daemon 1'";
        let kotlin = "/jdk/bin/java -cp kotlin-compiler-embeddable.jar org.jetbrains.kotlin.daemon.KotlinCompileDaemon --daemon-runFilesPath x";
        let build =
            entry(11, 10, "/jdk/bin/java -cp gradle-launcher.jar org.gradle.launcher.GradleMain --no-daemon run");
        let table = vec![
            entry(10, 1, "/bin/zsh"),
            build.clone(),
            entry(12, 11, "/jdk/bin/java -cp app Main"),
            entry(20, 11, worker),
            entry(21, 11, kotlin),
        ];
        assert_eq!(select_run_jvm(&table, 10, None, not_the_shell), Some(12));
        let helpers = vec![entry(10, 1, "/bin/zsh"), build, entry(20, 11, worker), entry(21, 11, kotlin)];
        assert_eq!(select_run_jvm(&helpers, 10, None, not_the_shell), None);
    }

    #[cfg(unix)]
    #[test]
    fn command_line_of_a_process_and_a_sleep_is_no_application_jvm() {
        let mut sleep = Command::new("sleep").arg("30").spawn().expect("spawn sleep");
        let pid = sleep.id();
        let (command, application) = (command_line(pid), is_application_jvm(pid));
        let _ = sleep.kill();
        let _ = sleep.wait();
        assert_eq!(command.as_deref(), Some("sleep 30"));
        assert!(!application);
        assert_eq!(command_line(pid), None, "an ended process has no command line");
    }

    #[test]
    fn parses_ps_lines_with_arguments_and_padding() {
        let parsed = parse_ps_line("  123    45 /jdk/bin/java -Dk=v  -cp a b").unwrap();
        assert_eq!(parsed, entry(123, 45, "/jdk/bin/java -Dk=v  -cp a b"));
        assert_eq!(parse_ps_line("  PID PPID COMMAND"), None);
        assert_eq!(parse_ps_line("   7 1"), None);
    }
}
