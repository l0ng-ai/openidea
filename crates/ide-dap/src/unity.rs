//! Unity's managed debugger discovers its own targets (`UnityDebug.exe list`).
//! Use that discovery protocol on every platform, including Windows, instead of
//! treating the Editor as a native LLDB process.

use crate::{
    adapter,
    attach::{AttachKind, AttachableProcess},
};
use ide_core::{IdeError, IdeResult};
use std::{path::PathBuf, process::Stdio, time::Duration};

/// UnityDebug acknowledges attach while Mono is still connecting. Do not report a
/// ready session until TargetReady exposes threads, otherwise immediate Play can
/// execute past breakpoints before they bind.
pub(crate) async fn wait_until_ready(session: &crate::session::Session) -> IdeResult<()> {
    *session.unity_startup_activity.lock() = std::time::Instant::now();
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let body = session.conn.request_timeout("threads", serde_json::json!({}), Duration::from_secs(5)).await?;
            // TargetReady precedes the startup event burst. Its automatic VM resumes
            // can otherwise race the first real breakpoint and leave an empty stack.
            if body.get("threads").and_then(serde_json::Value::as_array).is_some_and(|t| !t.is_empty())
                && session.unity_startup_activity.lock().elapsed() >= Duration::from_secs(1)
            {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .map_err(|_| {
        IdeError::unavailable(
            "Unity debugger did not become ready. Enable Editor Attaching and Debug Mode in Unity, then retry.",
        )
    })?
}

pub async fn editors(command: Option<String>, cwd: PathBuf) -> IdeResult<Vec<AttachableProcess>> {
    let command = command.unwrap_or_else(|| "unity-debug".into());
    let lookup = command.clone();
    let dir = cwd.clone();
    let binary = tokio::task::spawn_blocking(move || adapter::resolve_binary(&lookup, &dir))
        .await.map_err(|e| IdeError::internal(e.to_string()))?
        .ok_or_else(|| IdeError::unavailable(
            "debug adapter `unity` not found. Install Unity Debugger in Settings > Language Servers or configure the unity-debug tool path"
        ))?;
    let mut cmd = tokio::process::Command::new(binary);
    ide_core::process::prepare(cmd.as_std_mut());
    cmd.arg("list")
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let out = tokio::time::timeout(Duration::from_secs(15), cmd.output())
        .await
        .map_err(|_| {
            IdeError::unavailable("Unity process discovery timed out. Check that Unity Editor is responsive.")
        })?
        .map_err(|e| IdeError::unavailable(format!("Cannot start Unity process discovery: {e}")))?;
    if !out.status.success() {
        return Err(IdeError::unavailable(format!(
            "Unity process discovery failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    let mut rows = parse_editors(&String::from_utf8_lossy(&out.stdout));
    #[cfg(windows)]
    rows.retain(|p| is_editor_process(p.pid));
    // Prefer the current project's instance without silently attaching to it.
    let path = cwd.join("Library/EditorInstance.json");
    let pid = std::fs::File::open(path).ok().and_then(|file| {
        use std::io::Read;
        let json: serde_json::Value = serde_json::from_reader(file.take(4096)).ok()?;
        json.get("process_id")?.as_u64().and_then(|n| u32::try_from(n).ok())
    });
    for row in &mut rows {
        if Some(row.pid) == pid {
            row.command_line = cwd.to_string_lossy().into_owned();
        }
    }
    rows.sort_by_key(|p| Some(p.pid) != pid);
    Ok(rows)
}

#[cfg(windows)]
fn is_editor_process(pid: u32) -> bool {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW},
    };
    // Query only; do not suspend or modify any target during discovery.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return false;
        }
        let mut buf = vec![0u16; 32768];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(process, 0, buf.as_mut_ptr(), &mut len) != 0;
        CloseHandle(process);
        ok && String::from_utf16_lossy(&buf[..len as usize])
            .replace('\\', "/")
            .to_ascii_lowercase()
            .ends_with("/editor/unity.exe")
    }
}

pub fn parse_editors(output: &str) -> Vec<AttachableProcess> {
    let mut editors = Vec::new();
    for line in output.lines() {
        let line = line.trim().trim_start_matches('\u{feff}');
        if !line.starts_with("Unity Editor (") {
            continue;
        }
        // 3.0.1: Unity Editor (Unity) (123); newer builds append a project name.
        let Some((name, pid, project)) = line.match_indices(" (").find_map(|(at, _)| {
            let (id, project) = line[at + 2..].split_once(')')?;
            let pid = id.parse::<u32>().ok().filter(|n| *n > 0)?;
            Some((&line[..at], pid, project))
        }) else {
            continue;
        };
        if editors.iter().any(|p: &AttachableProcess| p.pid == pid) {
            continue;
        }
        editors.push(AttachableProcess {
            pid,
            name: "Unity Editor".into(),
            command_line: if project.trim().is_empty() { name.into() } else { project.trim().into() },
            kind: AttachKind::Unity,
            adapter: "unity".into(),
            host: None,
            port: None,
        });
    }
    editors.sort_by(|a, b| a.command_line.cmp(&b.command_line).then(a.pid.cmp(&b.pid)));
    editors
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_editor_ids_and_projects_without_mistaking_players_or_logs_for_editors() {
        let rows = parse_editors(
            "\u{feff}Unity Editor (Unity) (42) Game (Test)\r\nUnity Editor (7) My Game\nUnity Editor (42) duplicate\nWindowsPlayer (123) Player\nUnity Hub (44)\nUnity Editor (invalid)\nUnity Editor (0)\nlog text",
        );
        assert_eq!(rows.len(), 2);
        assert_eq!((rows[0].pid, rows[0].command_line.as_str()), (42, "Game (Test)"));
        assert_eq!(rows[1].pid, 7);
        assert!(rows.iter().all(|p| p.kind == AttachKind::Unity && p.adapter == "unity"));
    }
}
