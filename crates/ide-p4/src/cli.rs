//! Runs the `p4` executable. Tagged commands use `-Mj -ztag`: one JSON object
//! per line, where a message of the server is `{data, severity, generic}`.

use ide_core::{IdeError, IdeResult, error::ErrorKind};
use parking_lot::RwLock;
use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

static EXECUTABLE: RwLock<Option<PathBuf>> = RwLock::new(None);

/// The `p4` executable of Settings › Version Control › Perforce (`None` = look on `PATH`).
pub fn set_executable(path: Option<PathBuf>) {
    *EXECUTABLE.write() = path.filter(|p| !p.as_os_str().is_empty());
}

/// The configured `p4`, else the one on `PATH` or in a usual install folder.
pub fn executable() -> IdeResult<PathBuf> {
    if let Some(path) = EXECUTABLE.read().clone() {
        return Ok(path);
    }
    detect().ok_or_else(|| IdeError::missing_tool("p4"))
}

pub fn detect() -> Option<PathBuf> {
    which::which("p4").ok().or_else(|| {
        [
            r"C:\Program Files\Perforce\p4.exe",
            r"C:\Program Files (x86)\Perforce\p4.exe",
            "/usr/local/bin/p4",
            "/opt/homebrew/bin/p4",
            "/opt/perforce/bin/p4",
        ]
        .iter()
        .map(PathBuf::from)
        .find(|p| p.is_file())
    })
}

/// One tagged record of a command's output.
#[derive(Clone, Debug, Default)]
pub struct Record(pub serde_json::Map<String, Value>);

impl Record {
    pub fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(Value::as_str)
    }

    pub fn text(&self, key: &str) -> String {
        self.get(key).unwrap_or_default().to_owned()
    }

    pub fn num(&self, key: &str) -> Option<u32> {
        self.get(key)?.parse().ok()
    }

    pub fn has(&self, key: &str) -> bool {
        self.0.contains_key(key)
    }

    /// The values of an indexed field: `depotFile0`, `depotFile1`, …
    pub fn list(&self, key: &str) -> Vec<String> {
        (0..).map_while(|i| self.get(&format!("{key}{i}")).map(str::to_owned)).collect()
    }
}

/// What a tagged command printed: its records and the server's messages.
#[derive(Debug, Default)]
pub struct Output {
    pub records: Vec<Record>,
    /// Warnings and notes (`severity` below 3): "file(s) up-to-date", "not on client"…
    pub messages: Vec<String>,
}

/// The connection every command of a workspace runs with.
#[derive(Clone, Debug)]
pub struct Invocation {
    pub exe: PathBuf,
    pub cwd: PathBuf,
    /// `-p`, `-u`, `-c`, `-C`: empty to leave what `P4CONFIG` and the environment give.
    pub globals: Vec<String>,
}

impl Invocation {
    fn command(&self, tagged: bool, args: &[String]) -> Command {
        let mut cmd = Command::new(&self.exe);
        cmd.current_dir(&self.cwd).args(&self.globals);
        if tagged {
            cmd.args(["-Mj", "-ztag"]);
        }
        cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        // A command never waits for a terminal: forms come through `-i`, passwords through stdin.
        cmd.env("P4EDITOR", "true").env_remove("P4DIFF").env_remove("P4MERGE").env("PWD", &self.cwd);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        cmd
    }

    fn output(&self, mut cmd: Command, stdin: Option<&[u8]>) -> IdeResult<std::process::Output> {
        if stdin.is_some() {
            cmd.stdin(Stdio::piped());
        }
        let mut child = cmd.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound { IdeError::missing_tool("p4") } else { IdeError::from(e) }
        })?;
        if let (Some(bytes), Some(mut pipe)) = (stdin, child.stdin.take()) {
            // A command that fails early closes its end; its message is the error then.
            let _ = pipe.write_all(bytes);
        }
        Ok(child.wait_with_output()?)
    }

    /// Runs a tagged command. Messages of severity 3 and above fail it; the others are kept as notes.
    pub fn tagged(&self, args: &[String], stdin: Option<&[u8]>) -> IdeResult<Output> {
        let out = self.output(self.command(true, args), stdin)?;
        let mut parsed = Output::default();
        let mut errors = Vec::new();
        for line in out.stdout.split(|b| *b == b'\n').filter(|l| !l.is_empty()) {
            let Ok(Value::Object(map)) = serde_json::from_slice::<Value>(line) else { continue };
            let severity = map.get("severity").and_then(Value::as_u64);
            match severity {
                Some(level) if map.contains_key("generic") => {
                    let text = map.get("data").and_then(Value::as_str).unwrap_or_default().trim().to_owned();
                    if level >= 3 { errors.push(text) } else { parsed.messages.push(text) }
                }
                // A note about a file: "//depot/a.txt - must resolve #2 before submitting".
                None if map.len() == 2 && map.contains_key("level") && map.contains_key("data") => {
                    parsed.messages.push(map["data"].as_str().unwrap_or_default().trim().to_owned());
                }
                _ => parsed.records.push(Record(map)),
            }
        }
        let stderr = String::from_utf8_lossy(&out.stderr);
        if errors.is_empty() && !out.status.success() && !stderr.trim().is_empty() {
            errors.push(stderr.trim().to_owned());
        }
        if errors.is_empty() { Ok(parsed) } else { Err(classify(&errors.join("\n"))) }
    }

    /// Runs a command for its plain output (`print -q`, a spec form).
    pub fn raw(&self, args: &[String], stdin: Option<&[u8]>) -> IdeResult<Vec<u8>> {
        let out = self.output(self.command(false, args), stdin)?;
        let stderr = String::from_utf8_lossy(&out.stderr);
        if !out.status.success() || (out.stdout.is_empty() && !stderr.trim().is_empty()) {
            let message = if stderr.trim().is_empty() { String::from_utf8_lossy(&out.stdout) } else { stderr };
            return Err(classify(message.trim()));
        }
        Ok(out.stdout)
    }
}

pub fn args<I: IntoIterator<Item = S>, S: Into<String>>(items: I) -> Vec<String> {
    items.into_iter().map(Into::into).collect()
}

/// A local path as a file argument: `@`, `#`, `%` and `*` are revision and wildcard syntax.
pub fn escape(path: &Path) -> String {
    let text = path.to_string_lossy();
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '%' => out.push_str("%25"),
            '@' => out.push_str("%40"),
            '#' => out.push_str("%23"),
            '*' => out.push_str("%2A"),
            c => out.push(c),
        }
    }
    out
}

/// The reverse of [`escape`], for depot paths the server reports.
pub fn unescape(text: &str) -> String {
    text.replace("%40", "@").replace("%23", "#").replace("%2A", "*").replace("%25", "%")
}

/// True when the server's answer means "that file is not there", not a failure.
pub fn is_absent(message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    [
        "no such file",
        "not on client",
        "not in client view",
        "no file(s) at that",
        "not opened",
        "no such changelist",
        "not under client's root",
        "is not under",
    ]
    .iter()
    .any(|needle| m.contains(needle))
}

pub(crate) fn classify(message: &str) -> IdeError {
    let m = message.to_ascii_lowercase();
    let connection = [
        "connect to server failed",
        "tcp connect to",
        "host unknown",
        "timed out",
        "connection refused",
        "ssl connection",
        "p4trust",
    ];
    let login = [
        "your session has expired",
        "please login again",
        "perforce password (p4passwd) invalid or unset",
        "password invalid",
        "session was logged out",
    ];
    if connection.iter().any(|n| m.contains(n)) {
        return IdeError::unavailable(format!("Perforce server is unreachable: {message}")).with_tool("p4");
    }
    if login.iter().any(|n| m.contains(n)) {
        return IdeError::new(ErrorKind::Unavailable, format!("Perforce login required: {message}")).with_tool("p4");
    }
    if is_absent(message) {
        return IdeError::not_found(message);
    }
    IdeError::new(ErrorKind::Internal, message).with_tool("p4")
}

/// True when [`classify`] reported an expired or missing ticket.
pub fn is_login_required(error: &IdeError) -> bool {
    error.message.starts_with("Perforce login required")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_revision_and_wildcard_characters() {
        let path = Path::new("/ws/a@b#c%d*e.txt");
        assert_eq!(escape(path), "/ws/a%40b%23c%25d%2Ae.txt");
        assert_eq!(unescape(&escape(path)), path.to_string_lossy());
    }

    #[test]
    fn classifies_failures() {
        assert_eq!(classify("Connect to server failed; check $P4PORT.").kind, ErrorKind::Unavailable);
        assert!(is_login_required(&classify("Your session has expired, please login again.")));
        assert_eq!(classify("a.txt - no such file(s).").kind, ErrorKind::NotFound);
        assert_eq!(classify("Out of date files must be resolved or reverted.").kind, ErrorKind::Internal);
    }

    #[test]
    fn reads_indexed_fields() {
        let Value::Object(map) = serde_json::json!({"depotFile0": "//a", "depotFile1": "//b", "change": "7"}) else {
            unreachable!()
        };
        let record = Record(map);
        assert_eq!(record.list("depotFile"), ["//a", "//b"]);
        assert_eq!(record.num("change"), Some(7));
    }
}
