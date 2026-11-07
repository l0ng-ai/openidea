//! Validated results of the Dev Containers CLI.

use ide_core::{IdeError, IdeResult};
use serde::Deserialize;

/// The container `devcontainer up` started, as it reported it.
#[derive(Debug, PartialEq, Eq)]
pub struct Up {
    pub container: String,
    /// The user the IDE works as (`remoteUser`).
    pub user: String,
    /// The project folder in the container (`remoteWorkspaceFolder`).
    pub folder: String,
}

/// The JSON line `devcontainer up` ends with.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpResult {
    outcome: String,
    container_id: Option<String>,
    remote_user: Option<String>,
    remote_workspace_folder: Option<String>,
    message: Option<String>,
    description: Option<String>,
}

fn is_container_id(id: &str) -> bool {
    (12..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A user name or `uid[:gid]`, never something `docker exec` could read as an option.
fn is_user(user: &str) -> bool {
    !user.is_empty()
        && !user.starts_with('-')
        && user.len() <= 64
        && user.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ':'))
}

fn is_container_path(path: &str) -> bool {
    path.starts_with('/') && !path.chars().any(char::is_control)
}

/// Reads the result of `devcontainer up` from its stdout (the last JSON line).
pub fn parse_up(stdout: &str) -> IdeResult<Up> {
    let line = stdout.lines().rev().map(str::trim).find(|l| l.starts_with('{'));
    let result: UpResult = line
        .and_then(|l| serde_json::from_str(l).ok())
        .ok_or_else(|| IdeError::unavailable("devcontainer up did not report a result"))?;
    if result.outcome != "success" {
        let why = [result.message, result.description].into_iter().flatten().collect::<Vec<_>>().join(": ");
        return Err(IdeError::unavailable(format!("devcontainer up failed: {why}")));
    }
    let container = result.container_id.filter(|id| is_container_id(id));
    let user = result.remote_user.filter(|u| is_user(u));
    let folder = result.remote_workspace_folder.filter(|f| is_container_path(f));
    match (container, user, folder) {
        (Some(container), Some(user), Some(folder)) => Ok(Up { container, user, folder }),
        _ => Err(IdeError::unavailable("devcontainer up reported an unexpected container, user or folder")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "3f1c2b9a7d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8";

    fn result(fields: &str) -> String {
        format!("[1 ms] Start: Run: docker build\n{{\"outcome\":\"success\",{fields}}}\n")
    }

    #[test]
    fn reads_the_container_from_the_last_json_line() {
        let out =
            result(&format!(r#""containerId":"{ID}","remoteUser":"vscode","remoteWorkspaceFolder":"/workspaces/app""#));
        let up = parse_up(&out).unwrap();
        assert_eq!(up, Up { container: ID.into(), user: "vscode".into(), folder: "/workspaces/app".into() });
    }

    #[test]
    fn a_failure_reports_the_cli_message() {
        let out = r#"{"outcome":"error","message":"Command failed: docker build","description":"An error occurred"}"#;
        let err = parse_up(out).unwrap_err();
        assert!(err.message.contains("Command failed: docker build: An error occurred"), "{}", err.message);
        assert!(parse_up("no json at all").is_err());
    }

    #[test]
    fn unexpected_values_never_reach_docker_exec() {
        for fields in [
            r#""containerId":"--privileged","remoteUser":"vscode","remoteWorkspaceFolder":"/w""#.to_owned(),
            format!(r#""containerId":"{ID}","remoteUser":"-u0","remoteWorkspaceFolder":"/w""#),
            format!(r#""containerId":"{ID}","remoteUser":"a b","remoteWorkspaceFolder":"/w""#),
            format!(r#""containerId":"{ID}","remoteUser":"vscode","remoteWorkspaceFolder":"relative""#),
            format!(r#""containerId":"{ID}","remoteUser":"vscode""#),
        ] {
            assert!(parse_up(&result(&fields)).is_err(), "{fields}");
        }
        assert!(is_user("1000:1000") && is_user("node") && is_user("dev.user"));
    }
}
