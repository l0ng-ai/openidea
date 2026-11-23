use std::collections::{HashMap, HashSet, VecDeque};
use std::process::Command;
use std::time::Duration;

use crate::socket::{AttachError, jcmd};

/// Default budget for `thread_print`; a dump of a healthy JVM takes milliseconds, so this only
/// bounds a JVM stuck at a safepoint.
pub const THREAD_DUMP_TIMEOUT: Duration = Duration::from_secs(10);

/// System property the IDE adds to a run's JVM so it can be found even when the build tool
/// forks it outside the run's process tree (a Gradle daemon).
pub const RUN_TOKEN_PROPERTY: &str = "-Dopenidea.run.token=";

/// Gradle's own JVMs: the client that waits for the build and the daemon that runs it. Neither
/// is the application, even when it is the only JVM under the run's root.
const GRADLE_JVM_MARKERS: [&str; 3] =
    ["org.gradle.wrapper.GradleWrapperMain", "org.gradle.launcher.GradleMain", "org.gradle.launcher.daemon"];

/// `Thread.print -l` also lists the owned `java.util.concurrent` locks, which deadlock
/// reports need.
pub fn thread_print(pid: u32, timeout: Duration) -> Result<String, AttachError> {
    jcmd(pid, "Thread.print -l", timeout)
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProcEntry {
    pub pid: u32,
    pub ppid: u32,
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

/// The JVM that runs a run configuration: the one carrying `token` when any does, else the
/// deepest HotSpot JVM below `root` that is not Gradle's own (a Maven `spring-boot:run` forks
/// the application under the Maven JVM). Ties go to the highest pid.
pub fn select_run_jvm(
    table: &[ProcEntry],
    root: u32,
    token: Option<&str>,
    is_hotspot: impl Fn(u32) -> bool,
) -> Option<u32> {
    if let Some(token) = token {
        let wanted = format!("{RUN_TOKEN_PROPERTY}{token}");
        let tagged = table
            .iter()
            .filter(|entry| entry.command.split_whitespace().any(|arg| arg == wanted) && is_hotspot(entry.pid))
            .map(|entry| entry.pid)
            .max();
        if tagged.is_some() {
            return tagged;
        }
    }
    deepest_jvm_in_tree(table, root, &is_hotspot)
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
        let is_app_jvm = by_pid
            .get(&pid)
            .is_some_and(|entry| !GRADLE_JVM_MARKERS.iter().any(|marker| entry.command.contains(marker)))
            && is_hotspot(pid);
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
    fn select_prefers_token_and_skips_gradle_clients() {
        let table = gradle_run();
        assert_eq!(select_run_jvm(&table, 10, Some("cfg-1"), not_the_shell), Some(50));
        assert_eq!(select_run_jvm(&table, 10, Some("cfg-2"), not_the_shell), None);
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

    #[test]
    fn parses_ps_lines_with_arguments_and_padding() {
        let parsed = parse_ps_line("  123    45 /jdk/bin/java -Dk=v  -cp a b").unwrap();
        assert_eq!(parsed, entry(123, 45, "/jdk/bin/java -Dk=v  -cp a b"));
        assert_eq!(parse_ps_line("  PID PPID COMMAND"), None);
        assert_eq!(parse_ps_line("   7 1"), None);
    }
}
