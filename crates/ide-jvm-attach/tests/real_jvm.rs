#![cfg(unix)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use ide_jvm_attach::{
    AttachError, HeapDumpReply, LISTENER_START_TIMEOUT, THREAD_DUMP_TIMEOUT, agent_properties, ensure_listener,
    find_jvm_by_jdwp_port, has_listener, heap_dump, heap_dump_command, histogram_safe_while_suspended, is_hotspot,
    java_version_of, jcmd, jdwp_port, parse_class_histogram, parse_heap_dump_reply, parse_release, process_table,
    select_run_jvm, temp_dir, thread_dump_json, thread_print, vm_flags,
};

/// Two threads that each hold one monitor and wait for the other's after 200 ms.
const DEADLOCK_JAVA: &str = r#"
public class Deadlock {
    static final Object A = new Object(), B = new Object();

    static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException e) { throw new RuntimeException(e); }
    }

    public static void main(String[] args) {
        new Thread(() -> { synchronized (A) { sleep(200); synchronized (B) { } } }, "sync-1").start();
        new Thread(() -> { synchronized (B) { sleep(200); synchronized (A) { } } }, "sync-2").start();
        System.out.println("READY");
        System.out.flush();
        sleep(60_000);
    }
}
"#;

/// Two virtual threads in a monitor deadlock, which `Thread.print` does not list.
const VIRTUAL_DEADLOCK_JAVA: &str = r#"
public class VirtualDeadlock {
    static final Object A = new Object(), B = new Object();

    static void sleep(long ms) {
        try { Thread.sleep(ms); } catch (InterruptedException e) { throw new RuntimeException(e); }
    }

    public static void main(String[] args) {
        Thread.ofVirtual().name("v-sync-1").start(() -> { synchronized (A) { sleep(200); synchronized (B) { } } });
        Thread.ofVirtual().name("v-sync-2").start(() -> { synchronized (B) { sleep(200); synchronized (A) { } } });
        System.out.println("READY");
        System.out.flush();
        sleep(60_000);
    }
}
"#;

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

/// Lines of the child's stdout and stderr, interleaved.
fn output_lines(child: &mut Child) -> mpsc::Receiver<String> {
    let (lines, received) = mpsc::channel::<String>();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    for stream in [Box::new(stdout) as Box<dyn Read + Send>, Box::new(stderr)] {
        let lines = lines.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                if lines.send(line).is_err() {
                    break;
                }
            }
        });
    }
    received
}

/// First value `pick` returns within 30 s.
fn wait_for_line<T>(lines: &mpsc::Receiver<String>, mut pick: impl FnMut(&str) -> Option<T>) -> Option<T> {
    let deadline = Instant::now() + Duration::from_secs(30);
    while let Ok(line) = lines.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
        if let Some(value) = pick(&line) {
            return Some(value);
        }
    }
    None
}

/// Port from JDWP's "Listening for transport dt_socket at address: N" line, which JDKs print on
/// stdout or stderr depending on the version.
fn jdwp_port_in(line: &str) -> Option<u16> {
    let (_, port) = line.split_once("Listening for transport dt_socket at address:")?;
    Some(port.trim().parse().expect("numeric JDWP port"))
}

fn read_jdwp_port(child: &mut Child) -> u16 {
    wait_for_line(&output_lines(child), jdwp_port_in).expect("the JVM never reported its JDWP port")
}

#[test]
#[ignore = "needs a real JDK: set OPENIDEA_TEST_JAVA to its bin/java"]
fn finds_a_real_jvm_by_its_jdwp_port() {
    let Some(java) = std::env::var_os("OPENIDEA_TEST_JAVA").map(PathBuf::from) else {
        eprintln!("OPENIDEA_TEST_JAVA is not set; skipping");
        return;
    };
    let child = Command::new(&java)
        .arg("-XX:+StartAttachListener")
        .arg("-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:0")
        .arg("-version")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn java");
    let mut guard = JvmGuard(child);
    let pid = guard.0.id();
    let port = read_jdwp_port(&mut guard.0);

    // The listener thread may start a moment after the JDWP banner.
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut found = None;
    while found.is_none() && Instant::now() < deadline {
        // Only the JVM this test started: other JVMs of the developer are left alone.
        found = find_jvm_by_jdwp_port(port, Duration::from_secs(1), Duration::from_secs(2), |p| p == pid);
        if found.is_none() {
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    assert_eq!(found, Some(pid), "port {port}");

    let props = agent_properties(pid, Duration::from_secs(2)).unwrap();
    assert_eq!(jdwp_port(&props), Some(port));
    assert_eq!(find_jvm_by_jdwp_port(port ^ 1, Duration::from_secs(1), Duration::from_secs(2), |p| p == pid), None);
}

/// Compiles `MAIN_JAVA` with the `javac` next to `java`, since JDK 8 has no source launcher.
fn launch_main(java: &Path, dir: &Path, jvm_args: &[&str]) -> JvmGuard {
    launch_class(java, dir, "Main", MAIN_JAVA, jvm_args)
}

fn launch_class(java: &Path, dir: &Path, class: &str, source_text: &str, jvm_args: &[&str]) -> JvmGuard {
    let source = dir.join(format!("{class}.java"));
    std::fs::write(&source, source_text).unwrap();
    let status = Command::new(java.with_file_name("javac")).arg("-d").arg(dir).arg(&source).status().expect("javac");
    assert!(status.success(), "javac failed");
    let child = Command::new(java)
        .args(jvm_args)
        .arg("-cp")
        .arg(dir)
        .arg(class)
        .current_dir(dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn java");
    JvmGuard(child)
}

fn wait_for_ready(lines: &mpsc::Receiver<String>) {
    assert!(wait_for_line(lines, |line| (line.trim() == "READY").then_some(())).is_some(), "no READY from the JVM");
}

fn wait_for_listener(pid: u32) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !has_listener(pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(has_listener(pid), "no attach listener for pid {pid}");
}

/// `<dir>/a b/x.hprof`: the space is what an unquoted path would break on.
fn dump_path_with_space(dir: &Path) -> PathBuf {
    let parent = dir.join("a b");
    std::fs::create_dir(&parent).unwrap();
    parent.join("x.hprof")
}

fn assert_created(reply: HeapDumpReply, path: &Path) {
    let HeapDumpReply::Created { bytes } = reply else { panic!("{reply:?}") };
    let len = std::fs::metadata(path).expect("dump file").len();
    assert!(len > 0);
    if let Some(bytes) = bytes {
        assert_eq!(bytes, len);
    }
}

#[test]
#[ignore = "needs a real JDK >= 8: set OPENIDEA_TEST_JAVA to its bin/java"]
fn dumps_a_running_jvm() {
    let Some(java) = std::env::var_os("OPENIDEA_TEST_JAVA").map(PathBuf::from) else {
        eprintln!("OPENIDEA_TEST_JAVA is not set; skipping");
        return;
    };
    let major = reported_major(&java);
    let dir = tempfile::tempdir().unwrap();
    let mut guard = launch_main(&java, dir.path(), &["-XX:+StartAttachListener", "-Xmx64m"]);
    let pid = guard.0.id();
    wait_for_ready(&output_lines(&mut guard.0));
    wait_for_listener(pid);

    let flags = vm_flags(pid, Duration::from_secs(10)).unwrap();
    eprintln!("JDK {major} VM.flags: {}", flags.trim());
    assert!(flags.contains("-XX:+StartAttachListener"), "{flags}");
    // The array layout reads this exact token.
    assert!(flags.contains("-XX:+UseCompressedOops"), "{flags}");

    let path = dump_path_with_space(dir.path());
    let body = jcmd(pid, &heap_dump_command(&path).unwrap(), Duration::from_secs(30)).unwrap();
    eprintln!("JDK {major} running dump reply: {body:?}");
    assert_created(parse_heap_dump_reply(&body), &path);

    let second = heap_dump(pid, &path, Duration::from_secs(30)).unwrap();
    eprintln!("JDK {major} second dump to the same path: {second:?}");
    assert!(matches!(second, HeapDumpReply::Refused { .. }), "{second:?}");
}

/// Sends a JDWP command without data and waits for its reply, skipping any event packets.
fn jdwp_command(stream: &mut TcpStream, id: u32, command_set: u8, command: u8) {
    let mut packet = 11u32.to_be_bytes().to_vec();
    packet.extend_from_slice(&id.to_be_bytes());
    packet.extend_from_slice(&[0, command_set, command]);
    stream.write_all(&packet).unwrap();
    loop {
        let mut header = [0u8; 11];
        stream.read_exact(&mut header).unwrap();
        let len = u32::from_be_bytes(header[0..4].try_into().unwrap()) as usize;
        let mut data = vec![0u8; len.saturating_sub(header.len())];
        stream.read_exact(&mut data).unwrap();
        let is_reply = header[8] & 0x80 != 0;
        if is_reply && u32::from_be_bytes(header[4..8].try_into().unwrap()) == id {
            assert_eq!(u16::from_be_bytes([header[9], header[10]]), 0, "JDWP error for {command_set}/{command}");
            return;
        }
    }
}

#[test]
#[ignore = "needs a real JDK >= 17: set OPENIDEA_TEST_JAVA to its bin/java"]
fn dumps_while_suspended() {
    let Some(java) = std::env::var_os("OPENIDEA_TEST_JAVA").map(PathBuf::from) else {
        eprintln!("OPENIDEA_TEST_JAVA is not set; skipping");
        return;
    };
    let major = reported_major(&java);
    if !histogram_safe_while_suspended(major) {
        eprintln!("JDK {major} hangs attach requests while suspended; skipping");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let mut guard = launch_main(
        &java,
        dir.path(),
        &["-XX:+StartAttachListener", "-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:0"],
    );
    let pid = guard.0.id();
    let lines = output_lines(&mut guard.0);
    let (mut port, mut ready) = (None, false);
    let port = wait_for_line(&lines, |line| {
        port = port.or_else(|| jdwp_port_in(line));
        ready |= line.trim() == "READY";
        port.filter(|_| ready)
    })
    .expect("JDWP port and READY from the JVM");
    wait_for_listener(pid);

    let mut jdwp = TcpStream::connect(("127.0.0.1", port)).unwrap();
    jdwp.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    jdwp.write_all(b"JDWP-Handshake").unwrap();
    let mut handshake = [0u8; 14];
    jdwp.read_exact(&mut handshake).unwrap();
    assert_eq!(&handshake, b"JDWP-Handshake");
    jdwp_command(&mut jdwp, 1, 1, 8); // VirtualMachine.Suspend

    let path = dump_path_with_space(dir.path());
    let started = Instant::now();
    let body = jcmd(pid, &heap_dump_command(&path).unwrap(), Duration::from_secs(30)).unwrap();
    eprintln!("JDK {major} suspended dump reply ({:?}): {body:?}", started.elapsed());
    assert_created(parse_heap_dump_reply(&body), &path);

    jdwp_command(&mut jdwp, 2, 1, 9); // VirtualMachine.Resume
    assert!(guard.0.try_wait().unwrap().is_none(), "the JVM exited after resume");
    vm_flags(pid, Duration::from_secs(10)).expect("the attach listener answers after resume");
}

#[test]
#[ignore = "needs a real JDK >= 8: set OPENIDEA_TEST_JAVA to its bin/java"]
fn ensure_listener_starts_a_listener_on_demand() {
    let Some(java) = std::env::var_os("OPENIDEA_TEST_JAVA").map(PathBuf::from) else {
        eprintln!("OPENIDEA_TEST_JAVA is not set; skipping");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let mut guard = launch_main(&java, dir.path(), &[]);
    let pid = guard.0.id();
    wait_for_ready(&output_lines(&mut guard.0));
    assert!(!has_listener(pid), "the JVM opened its listener without being asked");
    assert!(is_hotspot(pid));

    let started = Instant::now();
    ensure_listener(pid, LISTENER_START_TIMEOUT).unwrap();
    eprintln!("on-demand listener for pid {pid} in {:?}", started.elapsed());
    assert!(has_listener(pid));
    jcmd(pid, "VM.version", Duration::from_secs(10)).expect("the new listener answers");

    let trigger = format!(".attach_pid{pid}");
    for parent in [temp_dir(), dir.path().to_path_buf()] {
        assert!(!parent.join(&trigger).exists(), "trigger file left in {parent:?}");
    }
    ensure_listener(pid, LISTENER_START_TIMEOUT).expect("an open listener is accepted as is");
}

#[test]
#[ignore = "needs a real JDK >= 8: set OPENIDEA_TEST_JAVA to its bin/java"]
fn thread_print_reports_a_deadlock() {
    let Some(java) = std::env::var_os("OPENIDEA_TEST_JAVA").map(PathBuf::from) else {
        eprintln!("OPENIDEA_TEST_JAVA is not set; skipping");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let mut guard = launch_class(&java, dir.path(), "Deadlock", DEADLOCK_JAVA, &["-XX:+StartAttachListener"]);
    let pid = guard.0.id();
    wait_for_ready(&output_lines(&mut guard.0));
    wait_for_listener(pid);
    // The threads take their first monitor at once and the second after 200 ms.
    std::thread::sleep(Duration::from_secs(1));

    let dump = thread_print(pid, THREAD_DUMP_TIMEOUT).unwrap();
    assert!(dump.contains("Found one Java-level deadlock"), "{dump}");
    assert!(dump.contains("sync-1") && dump.contains("sync-2"), "{dump}");

    // The run's JVM is found through the real process table, as the dump action does.
    let table = process_table();
    assert!(table.iter().any(|entry| entry.pid == pid && entry.command.contains("Deadlock")));
    assert_eq!(select_run_jvm(&table, pid, None, is_hotspot), Some(pid));
}

#[test]
#[ignore = "needs a real JDK >= 21: set OPENIDEA_TEST_JAVA to its bin/java"]
fn thread_dump_json_lists_virtual_threads() {
    let Some(java) = std::env::var_os("OPENIDEA_TEST_JAVA").map(PathBuf::from) else {
        eprintln!("OPENIDEA_TEST_JAVA is not set; skipping");
        return;
    };
    let major = reported_major(&java);
    if major < 21 {
        eprintln!("JDK {major} has no virtual threads; skipping");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let mut guard =
        launch_class(&java, dir.path(), "VirtualDeadlock", VIRTUAL_DEADLOCK_JAVA, &["-XX:+StartAttachListener"]);
    let pid = guard.0.id();
    wait_for_ready(&output_lines(&mut guard.0));
    wait_for_listener(pid);
    std::thread::sleep(Duration::from_secs(1));

    let dumps = dir.path().join("a b");
    std::fs::create_dir(&dumps).unwrap();
    let started = Instant::now();
    let json = thread_dump_json(pid, &dumps, THREAD_DUMP_TIMEOUT).unwrap();
    eprintln!("JDK {major} JSON thread dump: {} bytes in {:?}", json.len(), started.elapsed());
    assert!(json.contains("\"threadContainers\""), "{json}");
    assert!(json.contains("\"v-sync-1\"") && json.contains("\"v-sync-2\""), "{json}");
    assert!(std::fs::read_dir(&dumps).unwrap().next().is_none(), "dump file left in {dumps:?}");
}
