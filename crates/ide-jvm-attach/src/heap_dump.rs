use std::path::Path;
use std::time::Duration;

use crate::socket::{AttachError, jcmd};

#[derive(Debug, PartialEq)]
pub enum HeapDumpReply {
    /// `bytes` is the size the JVM reports; JDK 8 reports none.
    Created { bytes: Option<u64> },
    /// The JVM answered but wrote no dump, e.g. the file exists or the directory is missing.
    Refused { message: String },
}

/// Measured dump speed is about 1.8 GB/s; the budget assumes 256 MiB/s.
const DUMP_BYTES_PER_SEC: u64 = 256 << 20;
const DUMP_BASE_TIMEOUT: Duration = Duration::from_secs(30);

/// Only `-all` and a quoted path: any argument the DCmd rejects while the VM is suspended
/// hangs the attach listener (17/21/25) until resume, and so does an unquoted path with a space.
pub fn heap_dump_command(path: &Path) -> Result<String, AttachError> {
    let text = path.to_str().ok_or_else(|| AttachError::Protocol(format!("heap dump path {path:?} is not UTF-8")))?;
    if text.contains(['"', '\0', '\n', '\r']) {
        return Err(AttachError::Protocol(format!("heap dump path {text:?} cannot be quoted for the JVM")));
    }
    Ok(format!("GC.heap_dump -all \"{text}\""))
}

/// The JVM answers result code 0 for IO failures too, so success is told apart by its text.
pub fn parse_heap_dump_reply(body: &str) -> HeapDumpReply {
    if let Some(line) = body.lines().find(|line| line.contains("Heap dump file created")) {
        let bytes = line.split_once('[').and_then(|(_, rest)| rest.split_whitespace().next()?.parse().ok());
        return HeapDumpReply::Created { bytes };
    }
    let message = body
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty() && !line.starts_with("Dumping heap to"))
        .unwrap_or_else(|| body.trim());
    HeapDumpReply::Refused { message: message.to_owned() }
}

pub fn heap_dump(pid: u32, path: &Path, timeout: Duration) -> Result<HeapDumpReply, AttachError> {
    let body = jcmd(pid, &heap_dump_command(path)?, timeout)?;
    Ok(parse_heap_dump_reply(&body))
}

/// Raw `VM.flags` body: the flags set on the command line or by ergonomics.
pub fn vm_flags(pid: u32, timeout: Duration) -> Result<String, AttachError> {
    jcmd(pid, "VM.flags", timeout)
}

/// `heap_bytes` is the histogram's total; saturates instead of overflowing.
pub fn dump_timeout(heap_bytes: u64) -> Duration {
    let whole = Duration::from_secs(heap_bytes / DUMP_BYTES_PER_SEC);
    // The remainder is below 2^28, so the product stays far below u64::MAX.
    let part = Duration::from_nanos(heap_bytes % DUMP_BYTES_PER_SEC * 1_000_000_000 / DUMP_BYTES_PER_SEC);
    DUMP_BASE_TIMEOUT.saturating_add(whole).saturating_add(part)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heap_dump_command_quotes_path() {
        assert_eq!(heap_dump_command(Path::new("/a b/c.hprof")).unwrap(), r#"GC.heap_dump -all "/a b/c.hprof""#);
        for bad in ["/x\"y", "/x\ny", "/x\ry", "/x\0y"] {
            let result = heap_dump_command(Path::new(bad));
            assert!(matches!(result, Err(AttachError::Protocol(_))), "{bad:?}: {result:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn heap_dump_command_rejects_non_utf8_path() {
        use std::os::unix::ffi::OsStrExt;
        let path = std::path::PathBuf::from(std::ffi::OsStr::from_bytes(b"/x\xffy.hprof"));
        assert!(matches!(heap_dump_command(&path), Err(AttachError::Protocol(_))));
    }

    #[cfg(unix)]
    #[test]
    fn heap_dump_with_bad_path_sends_nothing() {
        // No JVM has pid 0's socket; reaching the socket would give NoListener instead.
        let result = heap_dump(0, Path::new("/x\"y"), Duration::from_secs(1));
        assert!(matches!(result, Err(AttachError::Protocol(_))), "{result:?}");
    }

    #[test]
    fn heap_dump_replies() {
        assert_eq!(parse_heap_dump_reply("Heap dump file created\n"), HeapDumpReply::Created { bytes: None });
        assert_eq!(
            parse_heap_dump_reply(
                "Dumping heap to out/x.hprof ...\nHeap dump file created [16826526 bytes in 0.010 secs]\n"
            ),
            HeapDumpReply::Created { bytes: Some(16826526) }
        );
        assert_eq!(
            parse_heap_dump_reply(
                "Dumping heap to /nonexistent/dir/x.hprof ...\nUnable to create /nonexistent/dir/x.hprof: No such file or directory"
            ),
            HeapDumpReply::Refused {
                message: "Unable to create /nonexistent/dir/x.hprof: No such file or directory".into()
            }
        );
        assert_eq!(
            parse_heap_dump_reply("Dumping heap to s p/dq.hprof ...\nUnable to create s p/dq.hprof: File exists"),
            HeapDumpReply::Refused { message: "Unable to create s p/dq.hprof: File exists".into() }
        );
        // JDK 8 names neither the path nor the action.
        assert_eq!(parse_heap_dump_reply("File exists\n"), HeapDumpReply::Refused { message: "File exists".into() });
    }

    #[test]
    fn heap_dump_reply_without_message_is_refused() {
        assert_eq!(parse_heap_dump_reply(""), HeapDumpReply::Refused { message: String::new() });
        assert_eq!(
            parse_heap_dump_reply("Dumping heap to a.hprof ...\n"),
            HeapDumpReply::Refused { message: "Dumping heap to a.hprof ...".into() }
        );
    }

    #[test]
    fn dump_timeout_scales() {
        assert_eq!(dump_timeout(0), Duration::from_secs(30));
        assert_eq!(dump_timeout(4 << 30), Duration::from_secs(46));
        assert_eq!(dump_timeout(128 << 20), Duration::from_millis(30_500));
        assert!(dump_timeout(u64::MAX) > Duration::from_secs(1 << 35));
    }
}
