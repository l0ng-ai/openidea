//! The link against a real JVM, with the test playing the adapter:
//! `OPENIDEA_TEST_JAVA=<jdk>/bin/java cargo test -p ide-jdwp --test real_jvm -- --ignored`.
//!
//! A JDK 8 `java` cannot run a source file: also set `OPENIDEA_TEST_JAVAC` to the `javac` of a
//! newer JDK, which compiles `Main.java` with `--release 8` first.

use ide_jdwp::{
    HEADER_LEN, Header, IdSizes, JdwpLink, LinkInspector, LinkOptions, LinkState, Reader, ReplyIds, Writer, object_ids,
};
use ide_jvm_inspect::{JvmInspector, JvmValue, VmTarget};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const WAIT: Duration = Duration::from_secs(30);
const INVALID_OBJECT: u16 = 20;

const MAIN: &str = r#"
import java.util.ArrayList;
import java.util.List;

public class Main {
    static final class Item {
        final int n;
        final String name;
        Item(int n) { this.n = n; this.name = "item-" + n; }
    }

    static final class Row {
        final String label;
        Row(int i) { this.label = "row-" + i; }
    }

    static final List<Item> ITEMS = new ArrayList<Item>();
    static final List<Row> ROWS = new ArrayList<Row>();

    static void pause() {
        try {
            Thread.sleep(20);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    public static void main(String[] args) {
        for (int i = 0; i < 5; i++) {
            ITEMS.add(new Item(i));
        }
        for (int i = 0; i < 1000; i++) {
            ROWS.add(new Row(i));
        }
        System.out.println("READY");
        while (true) {
            pause();
        }
    }
}
"#;

/// The debuggee; killed on drop, so a failed assert never leaves it running.
struct Jvm {
    child: Child,
    lines: mpsc::Receiver<String>,
    _dir: tempfile::TempDir,
}

impl Drop for Jvm {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Jvm {
    fn launch(java: &str) -> Jvm {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("Main.java"), MAIN).unwrap();
        let agent = "-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:0";
        let mut command = Command::new(java);
        command.current_dir(dir.path()).arg(agent);
        match std::env::var("OPENIDEA_TEST_JAVAC") {
            Ok(javac) => {
                let status = Command::new(javac)
                    .current_dir(dir.path())
                    .args(["--release", "8", "-d", ".", "Main.java"])
                    .status()
                    .unwrap();
                assert!(status.success(), "javac failed: {status}");
                command.args(["-cp", ".", "Main"]);
            }
            Err(_) => {
                command.arg("Main.java");
            }
        }
        let mut child = command.stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        Jvm { child, lines, _dir: dir }
    }

    fn line_starting(&self, prefix: &str) -> String {
        loop {
            let line = self.lines.recv_timeout(WAIT).unwrap_or_else(|e| panic!("no line {prefix:?}: {e}"));
            if line.starts_with(prefix) {
                return line;
            }
        }
    }

    fn assert_alive(&mut self) {
        assert_eq!(self.child.try_wait().unwrap(), None, "the JVM exited");
    }
}

/// The debug adapter's side of the link, speaking JDWP through the codec.
struct Adapter {
    stream: TcpStream,
    next_id: u32,
    sizes: Option<IdSizes>,
    events: VecDeque<Vec<u8>>,
}

impl Adapter {
    async fn connect(port: u16) -> Adapter {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream.write_all(b"JDWP-Handshake").await.unwrap();
        let mut handshake = [0; 14];
        within("handshake", stream.read_exact(&mut handshake)).await.unwrap();
        assert_eq!(&handshake, b"JDWP-Handshake");
        let mut adapter = Adapter { stream, next_id: 1, sizes: None, events: VecDeque::new() };
        let sizes = adapter.ok(1, 7, Vec::new()).await;
        adapter.sizes = Some(IdSizes::parse(&sizes).unwrap());
        adapter
    }

    fn sizes(&self) -> IdSizes {
        self.sizes.unwrap()
    }

    async fn packet(&mut self) -> (Header, Vec<u8>) {
        let mut header = [0; HEADER_LEN];
        within("packet", self.stream.read_exact(&mut header)).await.unwrap();
        let h = Header::parse(&header);
        let mut body = vec![0; h.length as usize - HEADER_LEN];
        within("body", self.stream.read_exact(&mut body)).await.unwrap();
        (h, body)
    }

    /// Error code and body of the reply; events that arrive first are kept for later.
    async fn request(&mut self, set: u8, cmd: u8, body: Vec<u8>) -> (u16, Vec<u8>) {
        let id = self.next_id;
        self.next_id += 1;
        let mut packet = Header::command_bytes(id, set, cmd, body.len()).to_vec();
        packet.extend_from_slice(&body);
        self.stream.write_all(&packet).await.unwrap();
        loop {
            let (h, body) = self.packet().await;
            if !h.is_reply() && h.command() == (64, 100) {
                self.events.push_back(body);
                continue;
            }
            // The link's own replies must never get here.
            assert!(h.is_reply() && h.id == id, "unexpected packet id {:#x} command {:?}", h.id, h.command());
            return (h.error(), body);
        }
    }

    async fn ok(&mut self, set: u8, cmd: u8, body: Vec<u8>) -> Vec<u8> {
        let (error, reply) = self.request(set, cmd, body).await;
        assert_eq!(error, 0, "{set}/{cmd} failed");
        reply
    }

    async fn event(&mut self) -> Vec<u8> {
        if let Some(event) = self.events.pop_front() {
            return event;
        }
        loop {
            let (h, body) = self.packet().await;
            assert!(!h.is_reply(), "unexpected reply id {:#x}", h.id);
            if h.command() == (64, 100) {
                return body;
            }
        }
    }

    /// The class's reference type id.
    async fn class(&mut self, signature: &str) -> u64 {
        let mut w = Writer::new();
        w.string(signature);
        let reply = self.ok(1, 2, w.into_vec()).await;
        let mut r = Reader::new(&reply);
        assert_eq!(r.count().unwrap(), 1, "{signature} loaded {reply:?}");
        r.u8().unwrap();
        r.id(self.sizes().reference_type).unwrap()
    }

    async fn method(&mut self, class: u64, name: &str) -> u64 {
        let mut w = Writer::new();
        w.id(class, self.sizes().reference_type);
        let reply = self.ok(2, 5, w.into_vec()).await;
        let mut r = Reader::new(&reply);
        for _ in 0..r.count().unwrap() {
            let id = r.id(self.sizes().method).unwrap();
            let method = r.string().unwrap();
            r.string().unwrap();
            r.i32().unwrap();
            if method == name {
                return id;
            }
        }
        panic!("no method {name}");
    }

    async fn break_at_start(&mut self, class: u64, method: u64) {
        let mut w = Writer::new();
        w.u8(2); // BREAKPOINT
        w.u8(2); // SUSPEND_ALL
        w.i32(1);
        w.u8(7); // LocationOnly
        w.u8(1); // CLASS
        w.id(class, self.sizes().reference_type);
        w.id(method, self.sizes().method);
        w.i64(0);
        self.ok(15, 1, w.into_vec()).await;
    }

    async fn reference_type_error(&mut self, object: u64) -> u16 {
        let mut w = Writer::new();
        w.id(object, self.sizes().object);
        self.request(9, 1, w.into_vec()).await.0
    }
}

fn instances_body(class: u64, sizes: &IdSizes) -> Vec<u8> {
    let mut w = Writer::new();
    w.id(class, sizes.reference_type);
    w.i32(1000);
    w.into_vec()
}

async fn within<T>(what: &str, f: impl Future<Output = T>) -> T {
    tokio::time::timeout(WAIT, f).await.unwrap_or_else(|_| panic!("timed out: {what}"))
}

async fn wait_suspended(link: &JdwpLink, generation: u64) {
    let mut states = link.subscribe();
    let seen = within(
        "link suspended",
        states.wait_for(
            |state| matches!(state, LinkState::Suspended { generation: g, thread: Some(_) } if *g == generation),
        ),
    )
    .await
    .map(|state| state.clone());
    assert!(seen.is_ok(), "link state {:?}", link.state());
}

/// A JVM stopped at a breakpoint in `Main.pause` (generation 1), with the test as its adapter.
struct Session {
    jvm: Jvm,
    link: JdwpLink,
    adapter: Adapter,
}

async fn stopped() -> Session {
    let java = std::env::var("OPENIDEA_TEST_JAVA").expect("OPENIDEA_TEST_JAVA");
    let jvm = Jvm::launch(&java);
    let listening = jvm.line_starting("Listening for transport dt_socket at address: ");
    let port: u16 = listening.rsplit(' ').next().unwrap().trim().parse().unwrap();
    jvm.line_starting("READY");

    let (link, adapter_port) =
        JdwpLink::start("127.0.0.1".into(), port, LinkOptions { hold_resumes: false }).await.unwrap();
    let mut adapter = Adapter::connect(adapter_port).await;
    assert_eq!(link.id_sizes(), Some(adapter.sizes()), "the link's own IDSizes");

    let main = adapter.class("LMain;").await;
    let pause = adapter.method(main, "pause").await;
    adapter.break_at_start(main, pause).await;
    adapter.event().await;
    wait_suspended(&link, 1).await;
    Session { jvm, link, adapter }
}

#[tokio::test]
#[ignore = "needs a JDK: OPENIDEA_TEST_JAVA=<jdk>/bin/java"]
async fn link_releases_exactly_its_own_references() {
    let Session { mut jvm, link, mut adapter } = stopped().await;
    let sizes = adapter.sizes();
    let item = adapter.class("LMain$Item;").await;

    // The adapter holds its own reference to each Item, as java-debug would.
    let own = adapter.ok(2, 16, instances_body(item, &sizes)).await;
    let mut adapter_ids = object_ids(ReplyIds::TaggedObjects, &own, &sizes).unwrap();
    let reply = link
        .command(2, 16, instances_body(item, &sizes), ReplyIds::TaggedObjects, WAIT)
        .await
        .expect("the link's Instances");
    let mut link_ids = object_ids(ReplyIds::TaggedObjects, &reply, &sizes).unwrap();
    assert_eq!(link_ids.len(), 5);
    adapter_ids.sort_unstable();
    link_ids.sort_unstable();
    assert_eq!(link_ids, adapter_ids, "both sides got the same ids");
    for &id in &link_ids {
        assert_eq!(adapter.reference_type_error(id).await, 0);
    }

    // The link releases its references once this resume is written.
    adapter.ok(1, 9, Vec::new()).await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    jvm.assert_alive();

    adapter.event().await;
    wait_suspended(&link, 2).await;
    for &id in &link_ids {
        assert_eq!(adapter.reference_type_error(id).await, 0, "the adapter's reference survived");
    }
    // Releasing the adapter's one reference frees each id, so the link left none behind.
    let mut w = Writer::new();
    w.i32(link_ids.len() as i32);
    for &id in &link_ids {
        w.id(id, sizes.object);
        w.i32(1);
    }
    adapter.ok(1, 14, w.into_vec()).await;
    for &id in &link_ids {
        assert_eq!(adapter.reference_type_error(id).await, INVALID_OBJECT);
    }
    adapter.ok(1, 9, Vec::new()).await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    jvm.assert_alive();
}

fn object_type(value: &JvmValue) -> &str {
    match value {
        JvmValue::Object { type_name, .. } => type_name,
        other => panic!("not a plain object: {other:?}"),
    }
}

#[tokio::test]
#[ignore = "needs a JDK: OPENIDEA_TEST_JAVA=<jdk>/bin/java"]
async fn link_inspector_reads_instances_fields_and_referrers() {
    let Session { mut jvm, link, mut adapter } = stopped().await;
    let inspector = LinkInspector::new(link.clone());
    let target = VmTarget { pid: None, attach_host: None, attach_port: None, generation: 1 };

    let started = Instant::now();
    let items = inspector.instances(&target, "Main$Item", 1000).await.expect("instances of Main$Item");
    eprintln!("timing: instances(Main$Item, 1000) = {} objects in {:?}", items.len(), started.elapsed());
    assert_eq!(items.len(), 5);
    assert!(items.iter().all(|item| object_type(item) == "Main$Item"), "{items:?}");

    // `Instances` does not promise allocation order, so find the item by its field.
    let mut first = None;
    for item in &items {
        let id = item.object_id().unwrap();
        let fields = inspector.fields(&target, id).await.expect("fields of an item");
        let names: Vec<_> = fields.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["n", "name"]);
        let JvmValue::Primitive { type_name, text: n } = &fields[0].value else {
            panic!("n is {:?}", fields[0].value);
        };
        assert_eq!(type_name, "int");
        let JvmValue::Str { text, length, .. } = &fields[1].value else {
            panic!("name is {:?}", fields[1].value);
        };
        let expected = format!("item-{n}");
        assert_eq!(text.as_deref(), Some(expected.as_str()));
        assert_eq!(*length as usize, expected.len());
        if n == "0" {
            first = Some(id);
        }
    }
    let first = first.expect("the item with n == 0");

    let started = Instant::now();
    let referrers = inspector.referrers(&target, first, 50).await.expect("referrers of the first item");
    eprintln!("timing: referrers(first item) = {} in {:?}", referrers.len(), started.elapsed());
    assert_eq!(referrers.len(), 1, "{referrers:?}");
    let JvmValue::Array { type_name, .. } = &referrers[0].value else {
        panic!("referrer is {:?}", referrers[0].value);
    };
    assert_eq!(type_name, "java.lang.Object[]");
    assert_eq!(referrers[0].via, ["[0]"]);

    let started = Instant::now();
    let counts = inspector.class_counts(&target).await.expect("class counts");
    eprintln!("timing: class_counts = {} classes in {:?}", counts.len(), started.elapsed());
    let count = |name: &str| counts.iter().find(|c| c.name == name).map(|c| c.instances);
    assert_eq!(count("Main$Item"), Some(5));
    assert_eq!(count("Main$Row"), Some(1000));
    assert!(counts.iter().all(|c| c.instances > 0));

    // Previews cost a few commands each; record what 1000 of them take.
    let started = Instant::now();
    let rows = inspector.instances(&target, "Main$Row", 1000).await.expect("instances of Main$Row");
    eprintln!("timing: instances(Main$Row, 1000) = {} objects in {:?}", rows.len(), started.elapsed());
    assert_eq!(rows.len(), 1000);
    let started = Instant::now();
    let strings = inspector.instances(&target, "java.lang.String", 1000).await.expect("instances of String");
    eprintln!("timing: instances(java.lang.String, 1000) = {} strings in {:?}", strings.len(), started.elapsed());
    assert!(strings.iter().all(|s| matches!(s, JvmValue::Str { .. })));
    assert!(strings.len() > 900, "only {} strings", strings.len());

    // The link counted every id above; releasing them must leave the JVM running.
    adapter.ok(1, 9, Vec::new()).await;
    tokio::time::sleep(Duration::from_secs(1)).await;
    jvm.assert_alive();
}
