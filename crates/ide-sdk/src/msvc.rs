//! Visual Studio toolchains for CMake (CLion's "Visual Studio" toolchain): the installations
//! `vswhere.exe` lists, and the environment their `vcvarsall.bat` sets up for an architecture,
//! which CMake configure, build and run then use. Windows only: elsewhere none are found and a
//! profile naming one (settings shared with a Windows machine) keeps the IDE's environment.

use crate::Sdk;
use ide_core::error::ErrorKind;
use ide_core::{IdeError, IdeResult};
use ide_run::RunConfig;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime};

const MARKER: &str = "__OPENIDEA_VCVARSALL__";

/// Installed Visual Studio editions and Build Tools with the C++ x86/x64 tools, newest first.
pub(crate) fn detect() -> Vec<Sdk> {
    if !cfg!(windows) {
        return Vec::new();
    }
    let Some(vswhere) = ["ProgramFiles(x86)", "ProgramFiles"]
        .into_iter()
        .filter_map(std::env::var_os)
        .map(|dir| PathBuf::from(dir).join("Microsoft Visual Studio").join("Installer").join("vswhere.exe"))
        .find(|p| p.is_file())
    else {
        return Vec::new();
    };
    let required =
        ["-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-format", "json"];
    let timeout = Duration::from_secs(15);
    // An older vswhere rejects options it does not know: retry with only the required ones.
    let json = crate::exec::query(&vswhere, &[&required[..], &["-prerelease", "-sort", "-utf8"]].concat(), timeout)
        .or_else(|| crate::exec::query(&vswhere, &required, timeout))
        .unwrap_or_default();
    parse_vswhere(&json).into_iter().filter(|sdk| vcvarsall(Path::new(&*sdk.path)).is_file()).collect()
}

/// `vswhere -format json`: one entry per installation that names its directory.
fn parse_vswhere(json: &str) -> Vec<Sdk> {
    let Ok(serde_json::Value::Array(instances)) = serde_json::from_str(json) else { return Vec::new() };
    instances
        .iter()
        .filter_map(|instance| {
            let path = instance["installationPath"].as_str().filter(|p| !p.trim().is_empty())?;
            let name = instance["displayName"].as_str().unwrap_or("Visual Studio");
            let version = instance["catalog"]["productDisplayVersion"]
                .as_str()
                .or_else(|| instance["installationVersion"].as_str())
                .map(str::to_owned);
            Some(Sdk {
                path: PathBuf::from(path).into(),
                name: name.to_owned(),
                version,
                source: "vswhere".into(),
                home: None,
                extra: None,
            })
        })
        .collect()
}

fn vcvarsall(installation: &Path) -> PathBuf {
    installation.join("VC").join("Auxiliary").join("Build").join("vcvarsall.bat")
}

/// The architecture `vcvarsall.bat` sets up when the profile names none: the host's.
fn default_arch() -> &'static str {
    if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" }
}

/// `cmd /d /u /s /c` script: the environment before and after `vcvarsall.bat <arch>`, apart by
/// [`MARKER`]. The script's own messages go to stderr, to explain a failure.
fn script(vcvarsall: &Path, arch: &str) -> IdeResult<String> {
    let path = vcvarsall.to_string_lossy();
    if path.contains(['"', '%']) {
        return Err(IdeError::invalid(format!("Unsupported Visual Studio path: {path}")));
    }
    if arch.is_empty() || !arch.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(IdeError::invalid(format!("Unsupported vcvarsall.bat architecture: {arch}")));
    }
    Ok(format!("\"set && echo {MARKER}&& call \"{path}\" {arch} 1>&2 && set\""))
}

/// `set` output (`NAME=value` lines) as variables. Lines without a name are skipped.
fn parse_set(text: &str) -> BTreeMap<String, String> {
    text.lines()
        .filter_map(|line| line.split_once('='))
        .filter(|(name, _)| !name.trim().is_empty())
        .map(|(name, value)| (name.to_owned(), value.trim_end_matches('\r').to_owned()))
        .collect()
}

/// The variables `vcvarsall.bat` added or changed, from the output of [`script`].
fn changed_variables(stdout: &str) -> Option<BTreeMap<String, String>> {
    let mut parts = stdout.splitn(2, MARKER);
    let before = parse_set(parts.next()?);
    let after = parse_set(parts.next()?);
    // Windows names are case-insensitive: `Path` and `PATH` are one variable.
    let before: HashMap<String, &String> = before.iter().map(|(k, v)| (k.to_ascii_uppercase(), v)).collect();
    if !["INCLUDE", "LIB"].iter().all(|name| after.keys().any(|k| k.eq_ignore_ascii_case(name))) {
        return None;
    }
    Some(after.into_iter().filter(|(k, v)| before.get(&k.to_ascii_uppercase()) != Some(&v)).collect())
}

/// `cmd /u` writes UTF-16LE; what `vcvarsall.bat` starts may write its own code page.
fn decode(bytes: &[u8]) -> String {
    let utf16 = bytes.len() >= 2 && bytes.len().is_multiple_of(2) && bytes.iter().skip(1).step_by(2).any(|b| *b == 0);
    if utf16 {
        let units: Vec<u16> = bytes.as_chunks::<2>().0.iter().map(|c| u16::from_le_bytes(*c)).collect();
        String::from_utf16_lossy(&units)
    } else {
        ide_core::output_encoding::decode_tool_output(bytes)
    }
}

type Captured = Arc<BTreeMap<String, String>>;
/// `vcvarsall.bat`, architecture, and when the installed MSVC version last changed.
type Key = (PathBuf, String, Option<SystemTime>);

fn cache() -> &'static Mutex<HashMap<Key, Captured>> {
    static CACHE: OnceLock<Mutex<HashMap<Key, Captured>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// What `vcvarsall.bat` of `installation` changes for `arch`, run once per installation,
/// architecture and installed MSVC version (a failure is not remembered).
fn environment(installation: &Path, arch: &str) -> IdeResult<Captured> {
    let bat = vcvarsall(installation);
    if !bat.is_file() {
        return Err(IdeError::not_found(format!(
            "No vcvarsall.bat in the Visual Studio installation {}: select an installed toolchain in the CMake profile",
            installation.display()
        )));
    }
    let arch = if arch.trim().is_empty() { default_arch() } else { arch.trim() };
    let tools_version = bat.with_file_name("Microsoft.VCToolsVersion.default.txt");
    let key = (bat.clone(), arch.to_owned(), std::fs::metadata(tools_version).and_then(|m| m.modified()).ok());
    // Held while vcvarsall runs, so profiles launched together run it once.
    let mut cache = cache().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(found) = cache.get(&key) {
        return Ok(found.clone());
    }
    let (success, stdout, stderr) = run(&script(&bat, arch)?)?;
    let failed = |what: &str| {
        let detail = decode(&stderr);
        let detail = detail.trim();
        let mut message = format!("{} {arch} {what}", bat.display());
        if !detail.is_empty() {
            message.push_str(":\n");
            message.push_str(detail);
        }
        IdeError::new(ErrorKind::Unavailable, message)
    };
    if !success {
        return Err(failed("failed"));
    }
    let captured = Arc::new(
        changed_variables(&decode(&stdout)).ok_or_else(|| failed("set up no MSVC environment (no INCLUDE or LIB)"))?,
    );
    cache.insert(key, captured.clone());
    Ok(captured)
}

#[cfg(windows)]
fn run(script: &str) -> IdeResult<(bool, Vec<u8>, Vec<u8>)> {
    use std::io::Read;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::sync::mpsc;
    use std::time::Instant;
    const TIMEOUT: Duration = Duration::from_secs(60);
    let mut cmd = Command::new("cmd");
    // `raw_arg`: Rust's quoting would escape the inner quotes cmd expects as they are.
    cmd.args(["/d", "/u", "/s", "/c"]).raw_arg(script);
    // Its telemetry upload would outlive cmd and hold the pipes open.
    cmd.env("VSCMD_SKIP_SENDTELEMETRY", "1");
    let mut child = ide_core::process::prepare(&mut cmd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    // Chunks as they come, `None` at the end of a pipe.
    let (tx, rx) = mpsc::channel::<(bool, Option<Vec<u8>>)>();
    let pipes: [(bool, Option<Box<dyn Read + Send>>); 2] = [
        (true, child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>)),
        (false, child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>)),
    ];
    for (is_out, pipe) in pipes {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            if let Some(mut pipe) = pipe {
                while let Ok(n @ 1..) = pipe.read(&mut buf) {
                    if tx.send((is_out, Some(buf[..n].to_vec()))).is_err() {
                        return;
                    }
                }
            }
            let _ = tx.send((is_out, None));
        });
    }
    drop(tx);
    let (mut out, mut err, mut open) = (Vec::new(), Vec::new(), 2);
    let deadline = Instant::now() + TIMEOUT;
    let mut drain_until = None;
    let status = loop {
        if drain_until.is_none()
            && let Some(status) = child.try_wait()?
        {
            drain_until = Some((status, Instant::now() + Duration::from_secs(2)));
        }
        if let Some((status, until)) = drain_until
            && (open == 0 || Instant::now() >= until)
        {
            break status;
        }
        if drain_until.is_none() && Instant::now() >= deadline {
            ide_core::process::kill_tree(&mut child);
            return Err(IdeError::new(
                ErrorKind::TimedOut,
                format!("vcvarsall.bat did not finish within {} seconds", TIMEOUT.as_secs()),
            ));
        }
        match rx.recv_timeout(Duration::from_millis(20)) {
            Ok((is_out, Some(chunk))) => if is_out { &mut out } else { &mut err }.extend(chunk),
            Ok((_, None)) => open -= 1,
            Err(_) => {}
        }
    };
    Ok((status.success(), out, err))
}

#[cfg(not(windows))]
fn run(_script: &str) -> IdeResult<(bool, Vec<u8>, Vec<u8>)> {
    Err(IdeError::unavailable("Visual Studio toolchains are only available on Windows"))
}

/// `env` over `vars`: a variable `env` sets (in any case) wins.
fn merge(env: &mut BTreeMap<String, String>, vars: &BTreeMap<String, String>) {
    for (name, value) in vars {
        if !env.keys().any(|k| k.eq_ignore_ascii_case(name)) {
            env.insert(name.clone(), value.clone());
        }
    }
}

/// `env` (a CMake profile's variables) over the environment of the profile's Visual Studio
/// `toolchain` for `arch`. No toolchain, or not on Windows: `env` as it is.
pub fn apply(env: &mut BTreeMap<String, String>, toolchain: &str, arch: &str) -> IdeResult<()> {
    if toolchain.trim().is_empty() || !cfg!(windows) {
        return Ok(());
    }
    merge(env, &*environment(Path::new(toolchain.trim()), arch)?);
    Ok(())
}

/// [`apply`] for a configuration of a CMake profile (configure, build, CTest or an executable).
pub fn apply_to_config(config: &mut RunConfig) -> IdeResult<()> {
    let params = &config.extras.params;
    let Some(toolchain) = params.get(ide_run::CMAKE_TOOLCHAIN_PARAM).cloned() else { return Ok(()) };
    let arch = params.get(ide_run::CMAKE_TOOLCHAIN_ARCH_PARAM).cloned().unwrap_or_default();
    apply(&mut config.env, &toolchain, &arch)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vswhere_lists_each_installation_with_its_display_version() {
        let json = r#"[
          {"instanceId":"a1","installationPath":"C:\\Program Files\\Microsoft Visual Studio\\2022\\Community",
           "installationVersion":"17.9.34728.123","displayName":"Visual Studio Community 2022",
           "catalog":{"productDisplayVersion":"17.9.6","productLineVersion":"2022"}},
          {"installationPath":"C:\\BuildTools","installationVersion":"16.11.35",
           "displayName":"Visual Studio Build Tools 2019"},
          {"installationPath":"C:\\Unnamed"},
          {"displayName":"No path"},
          {"installationPath":""},
          "garbage"
        ]"#;
        let found = parse_vswhere(json);
        let view: Vec<_> = found
            .iter()
            .map(|s| (s.path.to_string_lossy().into_owned(), s.name.as_str(), s.version.as_deref()))
            .collect();
        assert_eq!(
            view,
            [
                (
                    r"C:\Program Files\Microsoft Visual Studio\2022\Community".to_owned(),
                    "Visual Studio Community 2022",
                    Some("17.9.6")
                ),
                (r"C:\BuildTools".to_owned(), "Visual Studio Build Tools 2019", Some("16.11.35")),
                (r"C:\Unnamed".to_owned(), "Visual Studio", None),
            ]
        );
        assert!(found.iter().all(|s| s.source == "vswhere"));
        for empty in ["[]", "", "not json", "{}"] {
            assert!(parse_vswhere(empty).is_empty(), "{empty:?}");
        }
    }

    #[test]
    fn script_quotes_the_path_for_cmd_and_rejects_what_cmd_would_expand() {
        let bat = Path::new(r"C:\Program Files (x86)\VS & Co\VC\Auxiliary\Build\vcvarsall.bat");
        assert_eq!(
            script(bat, "x64_arm64").unwrap(),
            format!("\"set && echo {MARKER}&& call \"{}\" x64_arm64 1>&2 && set\"", bat.display())
        );
        for arch in ["", "x64 & calc", "x64\"", "%PATH%", "x64 /?"] {
            assert!(script(bat, arch).is_err(), "{arch:?}");
        }
        assert!(script(Path::new(r"C:\100%\vcvarsall.bat"), "x64").is_err());
    }

    #[test]
    fn only_the_variables_vcvarsall_changes_are_kept() {
        let stdout = [
            "ALLUSERSPROFILE=C:\\ProgramData",
            "Path=C:\\Windows\\system32;C:\\Users\\张三\\bin",
            "PROMPT=$P$G",
            "EQUALS=a=b",
            MARKER,
            "ALLUSERSPROFILE=C:\\ProgramData",
            "Path=C:\\VS\\VC\\Tools\\MSVC\\14.39\\bin\\HostX64\\x64;C:\\Windows\\system32;C:\\Users\\张三\\bin",
            "PROMPT=$P$G",
            "EQUALS=a=b=c",
            "INCLUDE=C:\\VS\\VC\\Tools\\MSVC\\14.39\\include;C:\\Kits\\10\\include\\ucrt",
            "LIB=C:\\VS\\VC\\Tools\\MSVC\\14.39\\lib\\x64",
            "VSCMD_ARG_TGT_ARCH=x64",
            "",
        ]
        .join("\r\n");
        let changed = changed_variables(&stdout).unwrap();
        assert_eq!(
            changed.keys().map(String::as_str).collect::<Vec<_>>(),
            ["EQUALS", "INCLUDE", "LIB", "Path", "VSCMD_ARG_TGT_ARCH"]
        );
        assert_eq!(changed["EQUALS"], "a=b=c");
        assert!(changed["Path"].starts_with(r"C:\VS\VC\Tools") && changed["Path"].ends_with(r"张三\bin"));
        assert_eq!(changed["VSCMD_ARG_TGT_ARCH"], "x64");
        // The IDE started from a developer prompt: nothing changes, and that is no failure.
        let unchanged = "INCLUDE=x\r\nLIB=y\r\n".to_owned() + MARKER + "\r\nINCLUDE=x\r\nLIB=y\r\n";
        assert_eq!(changed_variables(&unchanged), Some(BTreeMap::new()));
        // vcvarsall stopped (`&&` skipped the second `set`), or set up no compiler.
        assert_eq!(changed_variables("Path=a\r\n"), None);
        assert_eq!(changed_variables(&format!("Path=a\r\n{MARKER}\r\n")), None);
        assert_eq!(changed_variables(&format!("Path=a\r\n{MARKER}\r\nPath=b\r\nLIB=c\r\n")), None);
    }

    #[test]
    fn cmd_unicode_output_and_code_page_messages_both_decode() {
        let text = "Path=C:\\Users\\张三\r\n";
        let utf16: Vec<u8> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert_eq!(decode(&utf16), text);
        assert_eq!(
            decode(b"[ERROR:vcvarsall.bat] Invalid argument found : x65\r\n").trim(),
            "[ERROR:vcvarsall.bat] Invalid argument found : x65"
        );
    }

    #[test]
    fn the_profile_environment_wins_over_the_toolchain_in_any_case() {
        let mut env: BTreeMap<String, String> =
            [("PATH".into(), "mine".into()), ("CC".into(), "cl".into())].into_iter().collect();
        let vars: BTreeMap<String, String> =
            [("Path".into(), "vs".into()), ("INCLUDE".into(), "inc".into())].into_iter().collect();
        merge(&mut env, &vars);
        assert_eq!(
            env,
            [("CC", "cl"), ("INCLUDE", "inc"), ("PATH", "mine")]
                .into_iter()
                .map(|(k, v)| (k.to_owned(), v.to_owned()))
                .collect()
        );
    }

    #[test]
    fn configurations_without_a_toolchain_keep_their_environment() {
        let mut config = RunConfig {
            id: "cmake:profile:0:build".into(),
            name: "CMake Build".into(),
            kind: "cmake".into(),
            command: "cmake".into(),
            args: Vec::new(),
            cwd: None,
            env: [("FOO".into(), "bar".into())].into(),
            detected: true,
            is_test: false,
            debug_adapter: None,
            allow_parallel: false,
            extras: Default::default(),
        };
        let before = config.env.clone();
        apply_to_config(&mut config).unwrap();
        assert_eq!(config.env, before);
        // Settings shared with a Windows machine: elsewhere the IDE's environment is kept.
        config.extras.params.insert(ide_run::CMAKE_TOOLCHAIN_PARAM.into(), r"C:\VS".into());
        if !cfg!(windows) {
            apply_to_config(&mut config).unwrap();
            assert_eq!(config.env, before);
        }
    }

    #[test]
    fn a_missing_installation_names_the_installation() {
        let dir = tempfile::tempdir().unwrap();
        let error = environment(dir.path(), "x64").unwrap_err();
        assert_eq!(error.kind, ErrorKind::NotFound);
        assert!(error.message.contains(&dir.path().display().to_string()), "{}", error.message);
    }
}
