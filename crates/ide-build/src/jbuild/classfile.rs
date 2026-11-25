//! What the incremental build needs from a class file (JVMS §4): its name, supertypes, the
//! classes its constant pool refers to, and fingerprints of its API and of its compile-time
//! constants. Bounds-checked: a malformed file is `None`, never a panic.
use std::collections::BTreeSet;

/// A class file, as the dependency graph and the API diff see it.
#[derive(Clone, Debug, PartialEq)]
pub struct ClassFile {
    /// Internal name (`com/acme/Order$Line`).
    pub name: String,
    pub super_name: Option<String>,
    pub interfaces: Vec<String>,
    /// Classes named in the constant pool: references, descriptors, signatures, annotation types.
    pub refs: BTreeSet<String>,
    /// What other classes compile against: non-private, non-synthetic members and their
    /// signatures, supertypes, nested classes, permitted subclasses, record components.
    pub api: u64,
    /// The compile-time constants (`static final` fields with a `ConstantValue`), which javac
    /// copies into the classes that use them: a change can't be traced through references.
    pub constants: u64,
}

const ACC_PRIVATE: u16 = 0x0002;
const ACC_SYNTHETIC: u16 = 0x1000;

struct Bytes<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Bytes<'a> {
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let end = self.pos.checked_add(n)?;
        let slice = self.data.get(self.pos..end)?;
        self.pos = end;
        Some(slice)
    }
    fn u1(&mut self) -> Option<u8> {
        Some(self.take(1)?[0])
    }
    fn u2(&mut self) -> Option<u16> {
        let b = self.take(2)?;
        Some(u16::from_be_bytes([b[0], b[1]]))
    }
    fn u4(&mut self) -> Option<u32> {
        let b = self.take(4)?;
        Some(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }
}

#[derive(Clone, Debug)]
enum Entry {
    Empty,
    Utf8(String),
    Class(u16),
    String(u16),
    /// Integer, float, long, double: the raw bytes.
    Number(Vec<u8>),
    NameAndType(u16),
    MethodType(u16),
    Other,
}

struct Pool(Vec<Entry>);

impl Pool {
    fn utf8(&self, index: u16) -> Option<&str> {
        match self.0.get(index as usize)? {
            Entry::Utf8(s) => Some(s),
            _ => None,
        }
    }
    fn class(&self, index: u16) -> Option<&str> {
        match self.0.get(index as usize)? {
            Entry::Class(name) => self.utf8(*name),
            _ => None,
        }
    }
    /// A `ConstantValue`'s value, as bytes.
    fn constant(&self, index: u16) -> Option<Vec<u8>> {
        match self.0.get(index as usize)? {
            Entry::Number(bytes) => Some(bytes.clone()),
            Entry::String(utf8) => Some(self.utf8(*utf8)?.as_bytes().to_vec()),
            _ => None,
        }
    }
}

/// FNV-1a: stable across Rust versions, so recorded fingerprints stay comparable.
#[derive(Clone, Copy)]
struct Fnv(u64);

impl Fnv {
    fn new() -> Self {
        Fnv(0xcbf2_9ce4_8422_2325)
    }
    fn bytes(&mut self, bytes: &[u8]) {
        for b in bytes {
            self.0 = (self.0 ^ u64::from(*b)).wrapping_mul(0x100_0000_01b3);
        }
        // A separator, so `ab`+`c` and `a`+`bc` differ.
        self.0 = (self.0 ^ 0xff).wrapping_mul(0x100_0000_01b3);
    }
    fn str(&mut self, s: &str) {
        self.bytes(s.as_bytes());
    }
    fn u16(&mut self, v: u16) {
        self.bytes(&v.to_be_bytes());
    }
}

/// Adds the class names a descriptor or signature mentions (`Lcom/acme/Order<Lx/Y;>;`).
fn descriptor_refs(text: &str, out: &mut BTreeSet<String>) {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'L'
            && (i == 0
                || matches!(
                    bytes[i - 1],
                    b'(' | b')'
                        | b'['
                        | b';'
                        | b'<'
                        | b'>'
                        | b'+'
                        | b'-'
                        | b':'
                        | b'*'
                        | b'I'
                        | b'J'
                        | b'Z'
                        | b'B'
                        | b'C'
                        | b'S'
                        | b'F'
                        | b'D'
                        | b'V'
                        | b'^'
                ))
        {
            let start = i + 1;
            let mut end = start;
            while end < bytes.len() && !matches!(bytes[end], b';' | b'<' | b'.') {
                end += 1;
            }
            if end < bytes.len() && end > start {
                let name = &text[start..end];
                if name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'$' | b'_') || b >= 0x80) {
                    out.insert(name.to_owned());
                }
            }
            i = end;
        } else {
            i += 1;
        }
    }
}

fn class_ref(name: &str, out: &mut BTreeSet<String>) {
    if name.starts_with('[') {
        descriptor_refs(name, out);
    } else {
        out.insert(name.to_owned());
    }
}

struct Member {
    access: u16,
    name: String,
    descriptor: String,
    /// Fingerprint of the attributes that are part of the API.
    extra: u64,
    constant: Option<Vec<u8>>,
}

fn attributes(r: &mut Bytes, pool: &Pool, mut on: impl FnMut(&str, &[u8])) -> Option<()> {
    let count = r.u2()?;
    for _ in 0..count {
        let name = pool.utf8(r.u2()?)?.to_owned();
        let len = r.u4()? as usize;
        let body = r.take(len)?;
        on(&name, body);
    }
    Some(())
}

fn members(r: &mut Bytes, pool: &Pool, refs: &mut BTreeSet<String>) -> Option<Vec<Member>> {
    let count = r.u2()?;
    let mut out = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let access = r.u2()?;
        let name = pool.utf8(r.u2()?)?.to_owned();
        let descriptor = pool.utf8(r.u2()?)?.to_owned();
        descriptor_refs(&descriptor, refs);
        let mut extra = Fnv::new();
        let mut constant = None;
        attributes(r, pool, |attr, body| {
            let mut b = Bytes { data: body, pos: 0 };
            match attr {
                "Signature" => {
                    if let Some(sig) = b.u2().and_then(|i| pool.utf8(i)) {
                        descriptor_refs(sig, refs);
                        extra.str("S");
                        extra.str(sig);
                    }
                }
                "ConstantValue" => constant = b.u2().and_then(|i| pool.constant(i)),
                "Exceptions" => {
                    let mut names: Vec<&str> = Vec::new();
                    if let Some(n) = b.u2() {
                        for _ in 0..n {
                            if let Some(c) = b.u2().and_then(|i| pool.class(i)) {
                                names.push(c);
                            }
                        }
                    }
                    names.sort_unstable();
                    extra.str("E");
                    for n in names {
                        extra.str(n);
                    }
                }
                // An annotation element's default value is compiled into its uses.
                "AnnotationDefault" => {
                    extra.str("D");
                    element_value(&mut b, pool, refs, &mut extra);
                }
                _ => {}
            }
        })?;
        out.push(Member { access, name, descriptor, extra: extra.0, constant });
    }
    Some(out)
}

/// Parses a class file; `None` when it isn't a well-formed one.
pub fn parse(data: &[u8]) -> Option<ClassFile> {
    let mut r = Bytes { data, pos: 0 };
    if r.u4()? != 0xCAFE_BABE {
        return None;
    }
    r.u2()?;
    r.u2()?;
    let count = r.u2()?;
    let mut entries = vec![Entry::Empty];
    let mut i = 1;
    while i < count {
        let tag = r.u1()?;
        let entry = match tag {
            1 => {
                let len = r.u2()? as usize;
                Entry::Utf8(String::from_utf8_lossy(r.take(len)?).into_owned())
            }
            3 | 4 => Entry::Number(r.take(4)?.to_vec()),
            5 | 6 => Entry::Number(r.take(8)?.to_vec()),
            7 => Entry::Class(r.u2()?),
            8 => Entry::String(r.u2()?),
            9..=11 => {
                r.take(4)?;
                Entry::Other
            }
            12 => {
                r.u2()?;
                Entry::NameAndType(r.u2()?)
            }
            15 => {
                r.take(3)?;
                Entry::Other
            }
            16 => Entry::MethodType(r.u2()?),
            17 | 18 => {
                r.take(4)?;
                Entry::Other
            }
            19 | 20 => {
                r.take(2)?;
                Entry::Other
            }
            _ => return None,
        };
        let wide = matches!(tag, 5 | 6);
        entries.push(entry);
        i += 1;
        if wide {
            entries.push(Entry::Empty);
            i += 1;
        }
    }
    let pool = Pool(entries);
    let mut refs = BTreeSet::new();
    for entry in &pool.0 {
        match entry {
            Entry::Class(name) => class_ref(pool.utf8(*name)?, &mut refs),
            Entry::NameAndType(descriptor) | Entry::MethodType(descriptor) => {
                descriptor_refs(pool.utf8(*descriptor)?, &mut refs)
            }
            _ => {}
        }
    }
    let access = r.u2()?;
    let name = pool.class(r.u2()?)?.to_owned();
    let super_index = r.u2()?;
    let super_name = if super_index == 0 { None } else { Some(pool.class(super_index)?.to_owned()) };
    let mut interfaces = Vec::new();
    for _ in 0..r.u2()? {
        interfaces.push(pool.class(r.u2()?)?.to_owned());
    }
    let fields = members(&mut r, &pool, &mut refs)?;
    let methods = members(&mut r, &pool, &mut refs)?;

    let mut api = Fnv::new();
    // ACC_SUPER and ACC_SYNTHETIC say nothing about what compiles against the class.
    api.u16(access & !(0x0020 | ACC_SYNTHETIC));
    api.str(&name);
    api.str(super_name.as_deref().unwrap_or(""));
    let mut sorted = interfaces.clone();
    sorted.sort();
    for i in &sorted {
        api.str(i);
    }
    let mut class_attrs: Vec<(String, u64)> = Vec::new();
    attributes(&mut r, &pool, |attr, body| {
        let mut b = Bytes { data: body, pos: 0 };
        let mut h = Fnv::new();
        match attr {
            "Signature" => {
                if let Some(sig) = b.u2().and_then(|i| pool.utf8(i)) {
                    descriptor_refs(sig, &mut refs);
                    h.str(sig);
                }
            }
            "PermittedSubclasses" => {
                let mut names = Vec::new();
                for _ in 0..b.u2().unwrap_or(0) {
                    if let Some(c) = b.u2().and_then(|i| pool.class(i)) {
                        names.push(c.to_owned());
                    }
                }
                names.sort();
                names.iter().for_each(|n| h.str(n));
            }
            "Record" => {
                for _ in 0..b.u2().unwrap_or(0) {
                    let (Some(n), Some(d)) = (b.u2().and_then(|i| pool.utf8(i)), b.u2().and_then(|i| pool.utf8(i)))
                    else {
                        break;
                    };
                    h.str(n);
                    h.str(d);
                    let mut component = |attr: &str, body: &[u8]| {
                        if attr == "Signature"
                            && let Some(sig) = (Bytes { data: body, pos: 0 }).u2().and_then(|i| pool.utf8(i))
                        {
                            h.str(sig);
                        }
                    };
                    if attributes(&mut b, &pool, &mut component).is_none() {
                        break;
                    }
                }
            }
            // Nested classes this class declares, and their access.
            "InnerClasses" => {
                let mut nested = Vec::new();
                for _ in 0..b.u2().unwrap_or(0) {
                    let (Some(inner), Some(outer), Some(_), Some(flags)) = (b.u2(), b.u2(), b.u2(), b.u2()) else {
                        break;
                    };
                    let inner = pool.class(inner).unwrap_or("");
                    if outer != 0 && pool.class(outer) == Some(name.as_str()) && flags & ACC_PRIVATE == 0 {
                        nested.push(format!("{inner}:{flags}"));
                    }
                }
                nested.sort();
                nested.iter().for_each(|n| h.str(n));
            }
            "RuntimeVisibleAnnotations" | "RuntimeInvisibleAnnotations" => {
                // Annotation types are dependencies; their values aren't API.
                annotation_types(body, &pool, &mut refs);
                return;
            }
            _ => return,
        }
        class_attrs.push((attr.to_owned(), h.0));
    })?;
    class_attrs.sort();
    for (attr, h) in &class_attrs {
        api.str(attr);
        api.bytes(&h.to_be_bytes());
    }
    let mut constants = Fnv::new();
    let mut api_members: Vec<(u8, &str, &str, u16, u64)> = Vec::new();
    for (kind, list) in [(0u8, &fields), (1u8, &methods)] {
        for m in list.iter() {
            if kind == 0
                && let Some(value) = &m.constant
            {
                // Private constants are inlined too, but only in their own class.
                if m.access & ACC_PRIVATE == 0 {
                    constants.str(&m.name);
                    constants.str(&m.descriptor);
                    constants.bytes(value);
                }
            }
            if m.access & (ACC_PRIVATE | ACC_SYNTHETIC) != 0 || m.name == "<clinit>" {
                continue;
            }
            api_members.push((kind, &m.name, &m.descriptor, m.access & !ACC_SYNTHETIC, m.extra));
        }
    }
    api_members.sort();
    for (kind, name, descriptor, access, extra) in api_members {
        api.bytes(&[kind]);
        api.str(name);
        api.str(descriptor);
        api.u16(access);
        api.bytes(&extra.to_be_bytes());
    }
    refs.remove(&name);
    refs.retain(|r| !r.starts_with("java/"));
    Some(ClassFile { name, super_name, interfaces, refs, api: api.0, constants: constants.0 })
}

/// Adds the types of the annotations in a `Runtime*Annotations` attribute.
fn annotation_types(body: &[u8], pool: &Pool, refs: &mut BTreeSet<String>) {
    let mut b = Bytes { data: body, pos: 0 };
    let Some(count) = b.u2() else { return };
    let mut ignored = Fnv::new();
    for _ in 0..count {
        if annotation(&mut b, pool, refs, &mut ignored).is_none() {
            return;
        }
    }
}

fn annotation(b: &mut Bytes, pool: &Pool, refs: &mut BTreeSet<String>, h: &mut Fnv) -> Option<()> {
    let ty = pool.utf8(b.u2()?)?;
    descriptor_refs(ty, refs);
    h.str(ty);
    for _ in 0..b.u2()? {
        h.str(pool.utf8(b.u2()?)?);
        element_value(b, pool, refs, h)?;
    }
    Some(())
}

/// An annotation element value: its class names go to `refs`, its value (resolved, not the
/// constant pool indices) to `h`.
fn element_value(b: &mut Bytes, pool: &Pool, refs: &mut BTreeSet<String>, h: &mut Fnv) -> Option<()> {
    let tag = b.u1()?;
    h.bytes(&[tag]);
    match tag {
        b'B' | b'C' | b'D' | b'F' | b'I' | b'J' | b'S' | b'Z' => h.bytes(&pool.constant(b.u2()?)?),
        b's' => h.str(pool.utf8(b.u2()?)?),
        b'e' => {
            let ty = pool.utf8(b.u2()?)?;
            descriptor_refs(ty, refs);
            h.str(ty);
            h.str(pool.utf8(b.u2()?)?);
        }
        b'c' => {
            let ty = pool.utf8(b.u2()?)?;
            descriptor_refs(ty, refs);
            h.str(ty);
        }
        b'@' => annotation(b, pool, refs, h)?,
        b'[' => {
            for _ in 0..b.u2()? {
                element_value(b, pool, refs, h)?;
            }
        }
        _ => return None,
    }
    Some(())
}

/// The simple name of a class (`com/acme/Order$Line` → `Line`), which a new class can shadow.
pub fn simple_name(name: &str) -> &str {
    let tail = name.rsplit('/').next().unwrap_or(name);
    tail.rsplit('$').next().unwrap_or(tail)
}
