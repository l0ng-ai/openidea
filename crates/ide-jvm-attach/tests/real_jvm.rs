#![cfg(unix)]

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use ide_jvm_attach::{AttachError, has_listener, java_version_of, jcmd, parse_class_histogram, parse_release};

const MAIN_JAVA: &str = r#"
import java.util.ArrayList;
import java.util.List;

public class Main {
    static class Item {}

    public static void main(String[] args) throws Exception {
        List<Item> items = new ArrayList<>();
        for (int i = 0; i < 1000; i++) items.add(new Item());
        System.out.println("READY");
        System.out.flush();
        while (true) Thread.sleep(1000);
    }
}
"#;

/// Kills the JVM even when an assertion fails.
struct JvmGuard(Child);

impl Drop for JvmGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Major version `java -version` reports, via the same parser as the `release` file.
fn reported_major(java: &PathBuf) -> u32 {
    let out = Command::new(java).arg("-version").output().expect("run java -version");
    let stderr = String::from_utf8_lossy(&out.stderr);
    let quoted = stderr.split('"').nth(1).expect("quoted version in java -version output");
    parse_release(&format!("JAVA_VERSION=\"{quoted}\"")).expect("parse reported version").major
}

#[test]
#[ignore = "needs a real JDK >= 11: set OPENIDEA_TEST_JAVA to its bin/java"]
fn attaches_to_a_real_jvm() {
    let Some(java) = std::env::var_os("OPENIDEA_TEST_JAVA").map(PathBuf::from) else {
        eprintln!("OPENIDEA_TEST_JAVA is not set; skipping");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("Main.java");
    std::fs::write(&source, MAIN_JAVA).unwrap();

    let child = Command::new(&java)
        .arg("-XX:+StartAttachListener")
        .arg(&source)
        .current_dir(dir.path())
        .stdout(Stdio::piped())
        .spawn()
        .expect("spawn java");
    let mut guard = JvmGuard(child);
    let pid = guard.0.id();

    let stdout = guard.0.stdout.take().unwrap();
    let ready = BufReader::new(stdout).lines().map_while(Result::ok).any(|line| line.trim() == "READY");
    assert!(ready, "the JVM exited before printing READY");

    let deadline = Instant::now() + Duration::from_secs(5);
    while !has_listener(pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(has_listener(pid), "no attach listener for pid {pid}");

    let version = java_version_of(pid).expect("JDK version of the running JVM");
    assert_eq!(version.major, reported_major(&java));

    let text = jcmd(pid, "GC.class_histogram -all", Duration::from_secs(10)).unwrap();
    let histogram = parse_class_histogram(&text);
    let item = histogram.rows.iter().find(|row| row.name == "Main$Item").expect("Main$Item row");
    assert_eq!(item.instances, 1000);

    assert!(matches!(jcmd(pid, "No.such", Duration::from_secs(10)), Err(AttachError::Command { .. })));
}
