use ide_core::CancellationToken;
use std::collections::VecDeque;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

pub(super) fn run(script: &Path, worktree: &Path, cancel: &CancellationToken) -> Option<String> {
    let mut tail = VecDeque::new();
    let on_line = |line: String| {
        if tail.len() == 12 {
            tail.pop_front();
        }
        tail.push_back(line.chars().take(500).collect::<String>());
    };
    let mut command = script_command(script);
    command.arg(worktree);
    let result = crate::environment::run_command(command, worktree, cancel, Some(Duration::from_secs(300)), on_line);
    if cancel.is_cancelled() {
        return None;
    }
    result.err().map(|error| std::iter::once(error).chain(tail).collect::<Vec<_>>().join("\n"))
}

fn script_command(script: &Path) -> Command {
    #[cfg(windows)]
    if script.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("ps1")) {
        let windows = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
        let mut command = Command::new(Path::new(&windows).join(r"System32\WindowsPowerShell\v1.0\powershell.exe"));
        command.args(["-NoProfile", "-NonInteractive", "-File"]).arg(script);
        return command;
    }
    Command::new(script)
}
