#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::path::PathBuf;

/// Placed before the user's JVM arguments, and only added when `wants_listener_flag` is true.
pub const START_LISTENER_FLAG: &str = "-XX:+StartAttachListener";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JavaVersion {
    pub major: u32,
    /// As the JDK prints it: `1.8.0_512`, `17.0.21`, `25`.
    pub text: String,
}

/// Reads `JAVA_VERSION="…"` from a JDK `release` file.
pub fn parse_release(contents: &str) -> Option<JavaVersion> {
    let value = contents.lines().find_map(|line| line.trim().strip_prefix("JAVA_VERSION="))?;
    version_from(value.trim().trim_matches('"'))
}

/// Reads the `JDK …` line of `VM.version`; JDK 8 prints `JDK 8.0_512`.
pub fn parse_vm_version(output: &str) -> Option<JavaVersion> {
    let value = output.lines().find_map(|line| line.trim().strip_prefix("JDK "))?;
    version_from(value.trim())
}

fn version_from(text: &str) -> Option<JavaVersion> {
    let mut parts = text.split(|c: char| !c.is_ascii_digit()).filter(|p| !p.is_empty());
    let first: u32 = parts.next()?.parse().ok()?;
    // Pre-9 versions are `1.<major>.…`.
    let major = if first == 1 && text.starts_with("1.") { parts.next()?.parse().ok()? } else { first };
    Some(JavaVersion { major, text: text.to_owned() })
}

/// JDK version of the process `pid`, from the `release` file next to its `java` executable.
pub fn java_version_of(pid: u32) -> Option<JavaVersion> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let exe = std::fs::canonicalize(exe_path(pid)?).ok()?;
        // `<jdk>/bin/java`, or `<jdk>/jre/bin/java` on JDK 8.
        let home = exe.parent()?.parent()?;
        // Only climb out of `jre/`, so a JDK without its own `release` cannot pick up an
        // unrelated file in a shared parent such as `/usr/lib/jvm`.
        let outer = if home.file_name().is_some_and(|n| n == "jre") { home.parent() } else { None };
        [Some(home), outer].into_iter().flatten().find_map(|dir| {
            let contents = std::fs::read_to_string(dir.join("release")).ok()?;
            parse_release(&contents)
        })
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
        None
    }
}

#[cfg(target_os = "linux")]
fn exe_path(pid: u32) -> Option<PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/exe")).ok()
}

#[cfg(target_os = "macos")]
fn exe_path(pid: u32) -> Option<PathBuf> {
    use std::{ffi::c_void, os::unix::ffi::OsStringExt};

    let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: `buf` is writable for `buf.len()` bytes and proc_pidpath writes at most that many.
    let n = unsafe { libc::proc_pidpath(pid as i32, buf.as_mut_ptr() as *mut c_void, buf.len() as u32) };
    if n <= 0 {
        return None;
    }
    buf.truncate(n as usize);
    Some(PathBuf::from(std::ffi::OsString::from_vec(buf)))
}

// JDK 8 and 11 were measured to hang while suspended (12–16 unmeasured).
pub fn histogram_safe_while_suspended(major: u32) -> bool {
    major >= 17
}

/// False when the user's JVM arguments already decide the attach listener's fate.
pub fn wants_listener_flag(jvm_args: &str) -> bool {
    !(jvm_args.contains("StartAttachListener") || jvm_args.contains("DisableAttachMechanism"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_versions() {
        assert_eq!(parse_release("IMPLEMENTOR=\"Eclipse Adoptium\"\nJAVA_VERSION=\"17.0.21\"\n").unwrap().major, 17);
        assert_eq!(parse_release("JAVA_VERSION=\"1.8.0_512\"").unwrap().major, 8);
        assert_eq!(parse_release("JAVA_VERSION=\"25\"").unwrap(), JavaVersion { major: 25, text: "25".into() });
        assert!(parse_release("IMPLEMENTOR=x").is_none());
    }

    #[test]
    fn vm_version_lines() {
        assert_eq!(parse_vm_version("OpenJDK 64-Bit Server VM version 17.0.21+9\nJDK 17.0.21\n").unwrap().major, 17);
        assert_eq!(parse_vm_version("OpenJDK 64-Bit Server VM version 25.512-b09\nJDK 8.0_512\n").unwrap().major, 8);
    }

    #[test]
    fn suspended_gate() {
        assert!(!histogram_safe_while_suspended(11));
        assert!(!histogram_safe_while_suspended(16));
        assert!(histogram_safe_while_suspended(17));
    }

    #[test]
    fn listener_flag_respects_user_choice() {
        assert!(wants_listener_flag("-Xmx1g"));
        assert!(!wants_listener_flag("-XX:-StartAttachListener"));
        assert!(!wants_listener_flag("-Xmx1g -XX:+DisableAttachMechanism"));
    }
}
