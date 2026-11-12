//! 通过 UnityDebug 的发现协议枚举可附加的 Unity 编辑器。

use crate::{
    adapter,
    attach::{AttachKind, AttachableProcess},
};
use ide_core::{IdeError, IdeResult};
use std::{path::PathBuf, process::Stdio, time::Duration};

/// 等待 Mono 报告可用线程。
pub(crate) async fn wait_for_threads(session: &crate::session::Session) -> IdeResult<()> {
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let body = session.conn.request_timeout("threads", serde_json::json!({}), Duration::from_secs(5)).await?;
            if body.get("threads").and_then(serde_json::Value::as_array).is_some_and(|t| !t.is_empty()) {
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

// Mono 会异步绑定断点，并在启动阶段自行恢复线程。等待这一批事件处理完。
pub(crate) async fn settle_startup(session: &crate::session::Session) {
    *session.unity_startup_activity.lock() = std::time::Instant::now();
    let _ = tokio::time::timeout(Duration::from_secs(3), async {
        while session.unity_startup_activity.lock().elapsed() < Duration::from_secs(1) {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await;
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
        .env("PATH", ide_core::tool_path::search_path())
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
    if !rows.is_empty() {
        let editors = editor_process_ids()?;
        rows.retain(|p| editors.contains(&p.pid));
    }
    // 优先显示当前项目的实例，等待用户选择后再附加。
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
fn editor_process_ids() -> IdeResult<std::collections::HashSet<u32>> {
    use std::collections::HashMap;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
        },
    };

    let mut unity = HashMap::new();
    // 适配器也会发现资源导入子进程，通过父进程筛出真正的编辑器。
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error().into());
        }
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..std::mem::zeroed() };
        let mut found = Process32FirstW(snapshot, &mut entry);
        while found != 0 {
            let end = entry.szExeFile.iter().position(|c| *c == 0).unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..end]);
            if name.eq_ignore_ascii_case("Unity.exe") {
                unity.insert(entry.th32ProcessID, entry.th32ParentProcessID);
            }
            found = Process32NextW(snapshot, &mut entry);
        }
        CloseHandle(snapshot);
    }
    Ok(unity.iter().filter_map(|(&pid, parent)| (!unity.contains_key(parent)).then_some(pid)).collect())
}

pub fn parse_editors(output: &str) -> Vec<AttachableProcess> {
    let mut editors = Vec::new();
    for line in output.lines() {
        let line = line.trim().trim_start_matches('\u{feff}');
        if !line.starts_with("Unity Editor (") {
            continue;
        }
        // 3.0.1 输出 Unity Editor (Unity) (123)，新版会附加项目名。
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
