//! A fake JVM for the inspector tests: a small heap model that answers the JDWP commands the
//! inspector sends (ids are 8 bytes wide) and records every one of them. The link's
//! `SuspendCount` checks are answered with 1 and not recorded.

use super::LinkInspector;
use crate::codec::{FLAG_REPLY, HEADER_LEN, Header, Reader, Writer};
use crate::link::{JdwpLink, LinkOptions, LinkState};
use ide_jvm_inspect::VmTarget;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt, DuplexStream, ReadHalf, WriteHalf};
use tokio::sync::Notify;
use tokio::task::JoinHandle;

const HANDSHAKE: &[u8; 14] = b"JDWP-Handshake";
const WAIT: Duration = Duration::from_secs(5);
const THREAD: u64 = 9;
const UNHANDLED: u16 = 0x7fff;
const STATIC: i32 = 0x0008;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Val {
    Null,
    Int(i32),
    Byte(u8),
    Obj(u64),
}

struct Field {
    id: u64,
    name: String,
    signature: String,
    mod_bits: i32,
}

struct Class {
    id: u64,
    signature: String,
    superclass: u64,
    fields: Vec<Field>,
}

enum Object {
    Instance { class: u64, values: HashMap<u64, Val> },
    Array { class: u64, length: u32, elements: Vec<Val> },
}

impl Object {
    fn class(&self) -> u64 {
        match self {
            Object::Instance { class, .. } | Object::Array { class, .. } => *class,
        }
    }
}

pub(super) struct Heap {
    next: u64,
    classes: Vec<Class>,
    objects: BTreeMap<u64, Object>,
    texts: HashMap<u64, String>,
    instances: HashMap<u64, Vec<u64>>,
    errors: HashMap<(u8, u8, u64), u16>,
    holds: HashSet<(u8, u8, u64)>,
    pub(super) object_class: u64,
}

impl Heap {
    pub(super) fn new() -> Heap {
        let mut heap = Heap {
            next: 0x100,
            classes: Vec::new(),
            objects: BTreeMap::new(),
            texts: HashMap::new(),
            instances: HashMap::new(),
            errors: HashMap::new(),
            holds: HashSet::new(),
            object_class: 0,
        };
        heap.object_class = heap.class("Ljava/lang/Object;", 0, &[]);
        let object = heap.object_class;
        heap.class(
            "Ljava/lang/String;",
            object,
            &[("value", "[B", false), ("coder", "B", false), ("hash", "I", false), ("COMPACT_STRINGS", "Z", true)],
        );
        heap.class("Ljava/lang/Integer;", object, &[("value", "I", false), ("MAX_VALUE", "I", true)]);
        heap
    }

    fn fresh(&mut self) -> u64 {
        self.next += 1;
        self.next
    }

    pub(super) fn class_count(&self) -> usize {
        self.classes.len()
    }

    pub(super) fn class_id(&self, signature: &str) -> u64 {
        self.classes.iter().find(|c| c.signature == signature).map_or(0, |c| c.id)
    }

    /// `fields` is `(name, signature, is_static)`.
    pub(super) fn class(&mut self, signature: &str, superclass: u64, fields: &[(&str, &str, bool)]) -> u64 {
        let id = self.fresh();
        let fields = fields
            .iter()
            .map(|&(name, signature, is_static)| Field {
                id: self.fresh(),
                name: name.into(),
                signature: signature.into(),
                mod_bits: if is_static { STATIC } else { 0 },
            })
            .collect();
        self.classes.push(Class { id, signature: signature.into(), superclass, fields });
        id
    }

    fn array_class(&mut self, signature: &str) -> u64 {
        match self.class_id(signature) {
            0 => self.class(signature, self.object_class, &[]),
            id => id,
        }
    }

    fn field_id(&self, class: u64, name: &str) -> u64 {
        let mut current = class;
        while let Some(c) = self.classes.iter().find(|c| c.id == current) {
            if let Some(f) = c.fields.iter().find(|f| f.name == name && f.mod_bits & STATIC == 0) {
                return f.id;
            }
            current = c.superclass;
        }
        panic!("no instance field {name}");
    }

    pub(super) fn object(&mut self, class: u64, values: &[(&str, Val)]) -> u64 {
        let values = values.iter().map(|&(name, v)| (self.field_id(class, name), v)).collect();
        let id = self.fresh();
        self.objects.insert(id, Object::Instance { class, values });
        id
    }

    pub(super) fn array(&mut self, signature: &str, length: u32, elements: Vec<Val>) -> u64 {
        let class = self.array_class(signature);
        let id = self.fresh();
        self.objects.insert(id, Object::Array { class, length, elements });
        id
    }

    pub(super) fn string(&mut self, text: &str) -> u64 {
        let bytes = text.bytes().map(Val::Byte).collect();
        let value = self.array("[B", text.len() as u32, bytes);
        let id = self.string_object(value, 0);
        self.texts.insert(id, text.into());
        id
    }

    /// A `String` whose backing array has `array_length` elements, none of them readable.
    pub(super) fn long_string(&mut self, array_length: u32, coder: u8) -> u64 {
        let value = self.array("[B", array_length, Vec::new());
        self.string_object(value, coder)
    }

    fn string_object(&mut self, value: u64, coder: u8) -> u64 {
        let class = self.class_id("Ljava/lang/String;");
        self.object(class, &[("value", Val::Obj(value)), ("coder", Val::Byte(coder))])
    }

    pub(super) fn integer(&mut self, v: i32) -> u64 {
        let class = self.class_id("Ljava/lang/Integer;");
        self.object(class, &[("value", Val::Int(v))])
    }

    /// What `ReferenceType.Instances` returns for `class`, instead of the objects of that class.
    pub(super) fn list_instances(&mut self, class: u64, ids: &[u64]) {
        self.instances.insert(class, ids.to_vec());
    }

    /// The command answers `code` when its body starts with the id `first`.
    pub(super) fn fail(&mut self, set: u8, cmd: u8, first: u64, code: u16) {
        self.errors.insert((set, cmd, first), code);
    }

    /// The command is never answered when its body starts with the id `first`.
    pub(super) fn hold(&mut self, set: u8, cmd: u8, first: u64) {
        self.holds.insert((set, cmd, first));
    }

    fn class_of(&self, id: u64) -> &Class {
        self.classes.iter().find(|c| c.id == id).unwrap_or_else(|| panic!("no class {id:#x}"))
    }

    fn instances_of(&self, class: u64) -> Vec<u64> {
        self.instances
            .get(&class)
            .cloned()
            .unwrap_or_else(|| self.objects.iter().filter(|(_, o)| o.class() == class).map(|(&id, _)| id).collect())
    }

    fn put_tagged(&self, w: &mut Writer, v: Val) {
        match v {
            Val::Null => {
                w.u8(b'L');
                w.id(0, 8);
            }
            Val::Int(i) => {
                w.u8(b'I');
                w.i32(i);
            }
            Val::Byte(b) => {
                w.u8(b'B');
                w.u8(b);
            }
            Val::Obj(id) => {
                w.u8(self.object_tag(id));
                w.id(id, 8);
            }
        }
    }

    fn object_tag(&self, id: u64) -> u8 {
        match self.objects.get(&id) {
            Some(Object::Array { .. }) => b'[',
            _ => b'L',
        }
    }

    fn lookup(&self, id: u64) -> Result<&Object, u16> {
        self.objects.get(&id).ok_or(20)
    }

    fn answer(&self, set: u8, cmd: u8, body: &[u8]) -> Result<Vec<u8>, u16> {
        let mut r = Reader::new(body);
        let mut w = Writer::new();
        match (set, cmd) {
            (1, 2) => {
                let signature = r.string().unwrap();
                let found: Vec<_> = self.classes.iter().filter(|c| c.signature == signature).collect();
                w.i32(found.len() as i32);
                for c in found {
                    w.u8(class_tag(&c.signature));
                    w.id(c.id, 8);
                    w.i32(7);
                }
            }
            (1, 3) => {
                w.i32(self.classes.len() as i32);
                for c in &self.classes {
                    w.u8(class_tag(&c.signature));
                    w.id(c.id, 8);
                    w.string(&c.signature);
                    w.i32(7);
                }
            }
            (1, 21) => {
                let n = r.count().unwrap();
                w.i32(n as i32);
                for _ in 0..n {
                    w.i64(self.instances_of(r.id(8).unwrap()).len() as i64);
                }
            }
            (1, 9 | 14) => {}
            (2, 1) => w.string(&self.class_of(r.id(8).unwrap()).signature),
            (2, 4) => {
                let class = self.class_of(r.id(8).unwrap());
                w.i32(class.fields.len() as i32);
                for f in &class.fields {
                    w.id(f.id, 8);
                    w.string(&f.name);
                    w.string(&f.signature);
                    w.i32(f.mod_bits);
                }
            }
            (2, 16) => {
                let ids = self.instances_of(r.id(8).unwrap());
                let max = r.i32().unwrap();
                assert!(max > 0, "maxInstances 0 would mean all");
                let ids = &ids[..ids.len().min(max as usize)];
                w.i32(ids.len() as i32);
                for &id in ids {
                    w.u8(self.object_tag(id));
                    w.id(id, 8);
                }
            }
            (3, 1) => w.id(self.class_of(r.id(8).unwrap()).superclass, 8),
            (9, 1) => {
                let object = self.lookup(r.id(8).unwrap())?;
                w.u8(class_tag(&self.class_of(object.class()).signature));
                w.id(object.class(), 8);
            }
            (9, 2) => {
                let Object::Instance { values, .. } = self.lookup(r.id(8).unwrap())? else {
                    return Err(UNHANDLED);
                };
                let n = r.count().unwrap();
                w.i32(n as i32);
                for _ in 0..n {
                    self.put_tagged(&mut w, values.get(&r.id(8).unwrap()).copied().ok_or(UNHANDLED)?);
                }
            }
            (9, 10) => {
                let target = r.id(8).unwrap();
                self.lookup(target)?;
                let max = r.i32().unwrap();
                assert!(max > 0, "maxReferrers 0 would mean all");
                let referrers: Vec<u64> = self
                    .objects
                    .iter()
                    .filter(|(_, o)| match o {
                        Object::Instance { values, .. } => values.values().any(|v| *v == Val::Obj(target)),
                        Object::Array { elements, .. } => elements.contains(&Val::Obj(target)),
                    })
                    .map(|(&id, _)| id)
                    .take(max as usize)
                    .collect();
                w.i32(referrers.len() as i32);
                for id in referrers {
                    w.u8(self.object_tag(id));
                    w.id(id, 8);
                }
            }
            (10, 1) => w.string(self.texts.get(&r.id(8).unwrap()).ok_or(UNHANDLED)?),
            (13, 1) => {
                let Object::Array { length, .. } = self.lookup(r.id(8).unwrap())? else {
                    return Err(UNHANDLED);
                };
                w.i32(*length as i32);
            }
            (13, 2) => {
                let Object::Array { class, elements, .. } = self.lookup(r.id(8).unwrap())? else {
                    return Err(UNHANDLED);
                };
                let first = r.i32().unwrap() as usize;
                let length = r.i32().unwrap() as usize;
                let region = elements.get(first..first + length).ok_or(UNHANDLED)?;
                let tag = match self.class_of(*class).signature.as_str() {
                    "[I" => b'I',
                    "[B" => b'B',
                    _ => b'L',
                };
                w.u8(tag);
                w.i32(length as i32);
                for &v in region {
                    match (tag, v) {
                        (b'L', v) => self.put_tagged(&mut w, v),
                        (_, Val::Int(i)) => w.i32(i),
                        (_, Val::Byte(b)) => w.u8(b),
                        _ => return Err(UNHANDLED),
                    }
                }
            }
            _ => return Err(UNHANDLED),
        }
        Ok(w.into_vec())
    }
}

fn class_tag(signature: &str) -> u8 {
    if signature.starts_with('[') { 3 } else { 1 }
}

pub(super) fn packet(id: u32, set: u8, cmd: u8, body: &[u8]) -> Vec<u8> {
    let mut out = Header::command_bytes(id, set, cmd, body.len()).to_vec();
    out.extend_from_slice(body);
    out
}

fn reply(id: u32, error: u16, body: &[u8]) -> Vec<u8> {
    let mut out = packet(id, 0, 0, body);
    out[8] = FLAG_REPLY;
    out[9..11].copy_from_slice(&error.to_be_bytes());
    out
}

async fn read_packet(stream: &mut (impl AsyncRead + Unpin)) -> std::io::Result<Vec<u8>> {
    let mut header = [0; HEADER_LEN];
    stream.read_exact(&mut header).await?;
    let mut out = vec![0; Header::parse(&header).length as usize];
    out[..HEADER_LEN].copy_from_slice(&header);
    stream.read_exact(&mut out[HEADER_LEN..]).await?;
    Ok(out)
}

async fn within<T>(what: &str, f: impl Future<Output = T>) -> T {
    tokio::time::timeout(WAIT, f).await.unwrap_or_else(|_| panic!("timed out: {what}"))
}

fn breakpoint() -> Vec<u8> {
    let mut w = Writer::new();
    w.u8(2);
    w.i32(1);
    w.u8(2);
    w.i32(3);
    w.id(THREAD, 8);
    packet(0x100, 64, 100, &w.into_vec())
}

/// `(command set, command, body)` of each request the JVM received.
type Log = Arc<Mutex<Vec<(u8, u8, Vec<u8>)>>>;

pub(super) struct Fake {
    pub(super) inspector: LinkInspector,
    pub(super) link: JdwpLink,
    pub(super) adapter: DuplexStream,
    /// Signalled when a request in `Heap::hold` arrives.
    pub(super) held: Arc<Notify>,
    log: Log,
    jvm: Arc<tokio::sync::Mutex<WriteHalf<DuplexStream>>>,
    task: JoinHandle<()>,
}

impl Drop for Fake {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub(super) fn target() -> VmTarget {
    VmTarget { pid: None, attach_host: None, attach_port: None, generation: 0 }
}

impl Fake {
    /// A link whose VM stopped at a breakpoint of thread 9 (generation 1).
    pub(super) async fn start(heap: Heap) -> Fake {
        let (mut adapter, link_adapter) = tokio::io::duplex(1 << 20);
        let (link_jvm, mut jvm) = tokio::io::duplex(1 << 20);
        let link = JdwpLink::spawn_over(link_adapter, link_jvm, LinkOptions { hold_resumes: false });
        adapter.write_all(HANDSHAKE).await.unwrap();
        let mut buf = [0; 14];
        within("adapter handshake", jvm.read_exact(&mut buf)).await.unwrap();
        jvm.write_all(HANDSHAKE).await.unwrap();
        within("jvm handshake", adapter.read_exact(&mut buf)).await.unwrap();
        let own = within("IDSizes", read_packet(&mut jvm)).await.unwrap();
        let mut w = Writer::new();
        for _ in 0..5 {
            w.i32(8);
        }
        jvm.write_all(&reply(Header::parse(own[..HEADER_LEN].try_into().unwrap()).id, 0, &w.into_vec())).await.unwrap();
        jvm.write_all(&breakpoint()).await.unwrap();

        let (rd, wr) = tokio::io::split(jvm);
        let jvm = Arc::new(tokio::sync::Mutex::new(wr));
        let log = Arc::new(Mutex::new(Vec::new()));
        let held = Arc::new(Notify::new());
        let task = tokio::spawn(serve(heap, rd, jvm.clone(), log.clone(), held.clone()));
        let fake = Fake { inspector: LinkInspector::new(link.clone()), link, adapter, held, log, jvm, task };
        fake.wait_suspended(1).await;
        fake
    }

    async fn wait_suspended(&self, generation: u64) {
        let want = LinkState::Suspended { generation, thread: Some(THREAD) };
        let mut states = self.link.subscribe();
        let seen = tokio::time::timeout(WAIT, states.wait_for(|s| *s == want)).await;
        assert!(matches!(seen, Ok(Ok(_))), "state {:?}, wanted {want:?}", self.link.state());
    }

    /// The adapter resumes the VM, which then stops again at a breakpoint.
    pub(super) async fn next_stop(&mut self) {
        let generation = self.link.generation() + 1;
        let resumes = self.count(1, 9);
        self.adapter.write_all(&packet(50, 1, 9, &[])).await.unwrap();
        // A JVM stops again only after the resume reaches it; the link reads both directions apart.
        within("the resume", async {
            while self.count(1, 9) == resumes {
                tokio::task::yield_now().await;
            }
        })
        .await;
        let mut event = breakpoint();
        event[4..8].copy_from_slice(&0x101u32.to_be_bytes());
        self.jvm.lock().await.write_all(&event).await.unwrap();
        self.wait_suspended(generation).await;
    }

    /// Bodies of the requests with this command, in order.
    pub(super) fn requests(&self, set: u8, cmd: u8) -> Vec<Vec<u8>> {
        let log = self.log.lock().unwrap();
        log.iter().filter(|(s, c, _)| (*s, *c) == (set, cmd)).map(|(_, _, body)| body.clone()).collect()
    }

    pub(super) fn count(&self, set: u8, cmd: u8) -> usize {
        self.requests(set, cmd).len()
    }

    pub(super) fn commands(&self) -> Vec<(u8, u8)> {
        self.log.lock().unwrap().iter().map(|(s, c, _)| (*s, *c)).collect()
    }
}

async fn serve(
    heap: Heap,
    mut rd: ReadHalf<DuplexStream>,
    wr: Arc<tokio::sync::Mutex<WriteHalf<DuplexStream>>>,
    log: Log,
    held: Arc<Notify>,
) {
    while let Ok(packet) = read_packet(&mut rd).await {
        let h = Header::parse(packet[..HEADER_LEN].try_into().unwrap());
        if h.is_reply() {
            continue;
        }
        let (set, cmd) = h.command();
        let body = &packet[HEADER_LEN..];
        let out = if (set, cmd) == (11, 12) {
            Ok(1i32.to_be_bytes().to_vec())
        } else {
            log.lock().unwrap().push((set, cmd, body.to_vec()));
            let first = Reader::new(body).id(8).unwrap_or(0);
            if heap.holds.contains(&(set, cmd, first)) {
                held.notify_one();
                continue;
            }
            match heap.errors.get(&(set, cmd, first)) {
                Some(&code) => Err(code),
                None => heap.answer(set, cmd, body),
            }
        };
        let bytes = match out {
            Ok(body) => reply(h.id, 0, &body),
            Err(code) => reply(h.id, code, &[]),
        };
        if wr.lock().await.write_all(&bytes).await.is_err() {
            return;
        }
    }
}
