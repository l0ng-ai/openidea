//! Builders for `.hprof` fixtures. They panic on misuse (unknown class name, text that does not
//! fit the requested encoding): they are test helpers, not input handling.

use std::collections::HashMap;
use std::path::Path;

use crate::hprof::{BasicType, HeapRootKind};

const TAG_UTF8: u8 = 0x01;
const TAG_LOAD_CLASS: u8 = 0x02;
const TAG_HEAP_SEGMENT: u8 = 0x1C;
const TAG_HEAP_DUMP_END: u8 = 0x2C;
const TIMESTAMP_MS: u64 = 1_700_000_000_000;

fn put_id(out: &mut Vec<u8>, id_size: u8, id: u64) {
    if id_size == 4 {
        out.extend_from_slice(&(id as u32).to_be_bytes());
    } else {
        out.extend_from_slice(&id.to_be_bytes());
    }
}

/// Writes records one by one; heap sub-records are collected into a single heap-dump segment that
/// `finish` places after the UTF8 / LOAD CLASS records, followed by HEAP DUMP END.
pub struct HprofWriter {
    id_size: u8,
    top: Vec<u8>,
    heap: Vec<u8>,
    class_serial: u32,
}

impl Default for HprofWriter {
    fn default() -> Self {
        Self::new()
    }
}

impl HprofWriter {
    pub fn new() -> Self {
        Self::with_id_size(8)
    }

    /// `id_size` is 4 or 8; ids are truncated to the width.
    pub fn with_id_size(id_size: u8) -> Self {
        assert!(id_size == 4 || id_size == 8, "hprof ids are 4 or 8 bytes");
        let mut top = b"JAVA PROFILE 1.0.2\0".to_vec();
        top.extend_from_slice(&u32::from(id_size).to_be_bytes());
        top.extend_from_slice(&TIMESTAMP_MS.to_be_bytes());
        Self { id_size, top, heap: Vec::new(), class_serial: 0 }
    }

    fn top_record(&mut self, tag: u8, body: &[u8]) {
        self.top.push(tag);
        self.top.extend_from_slice(&0u32.to_be_bytes());
        self.top.extend_from_slice(&(body.len() as u32).to_be_bytes());
        self.top.extend_from_slice(body);
    }

    fn heap_id(&mut self, id: u64) {
        put_id(&mut self.heap, self.id_size, id);
    }

    fn heap_u4(&mut self, v: u32) {
        self.heap.extend_from_slice(&v.to_be_bytes());
    }

    pub fn string(&mut self, id: u64, s: &str) -> &mut Self {
        let mut body = Vec::new();
        put_id(&mut body, self.id_size, id);
        body.extend_from_slice(s.as_bytes());
        self.top_record(TAG_UTF8, &body);
        self
    }

    pub fn load_class(&mut self, class_id: u64, name_id: u64) -> &mut Self {
        self.class_serial += 1;
        let mut body = self.class_serial.to_be_bytes().to_vec();
        put_id(&mut body, self.id_size, class_id);
        body.extend_from_slice(&0u32.to_be_bytes());
        put_id(&mut body, self.id_size, name_id);
        self.top_record(TAG_LOAD_CLASS, &body);
        self
    }

    /// `statics` are `(name id, object id)` reference statics.
    pub fn class(&mut self, id: u64, super_id: u64, fields: &[(u64, BasicType)], statics: &[(u64, u64)]) -> &mut Self {
        self.heap.push(0x20);
        self.heap_id(id);
        self.heap_u4(0);
        self.heap_id(super_id);
        for _ in 0..5 {
            self.heap_id(0); // loader, signers, protection domain, 2 reserved
        }
        let instance_size: usize = fields.iter().map(|(_, ty)| ty.hprof_size(self.id_size)).sum();
        self.heap_u4(instance_size as u32);
        self.heap.extend_from_slice(&0u16.to_be_bytes()); // constant pool
        self.heap.extend_from_slice(&(statics.len() as u16).to_be_bytes());
        for &(name, object) in statics {
            self.heap_id(name);
            self.heap.push(BasicType::Object as u8);
            self.heap_id(object);
        }
        self.heap.extend_from_slice(&(fields.len() as u16).to_be_bytes());
        for &(name, ty) in fields {
            self.heap_id(name);
            self.heap.push(ty as u8);
        }
        self
    }

    pub fn instance(&mut self, id: u64, class_id: u64, data: &[u8]) -> &mut Self {
        self.heap.push(0x21);
        self.heap_id(id);
        self.heap_u4(0);
        self.heap_id(class_id);
        self.heap_u4(data.len() as u32);
        self.heap.extend_from_slice(data);
        self
    }

    pub fn obj_array(&mut self, id: u64, class_id: u64, items: &[u64]) -> &mut Self {
        self.heap.push(0x22);
        self.heap_id(id);
        self.heap_u4(0);
        self.heap_u4(items.len() as u32);
        self.heap_id(class_id);
        for &item in items {
            self.heap_id(item);
        }
        self
    }

    /// An array of `len` zeroed elements.
    pub fn prim_array(&mut self, id: u64, ty: BasicType, len: u32) -> &mut Self {
        let bytes = vec![0u8; len as usize * ty.hprof_size(self.id_size)];
        self.prim_bytes(id, ty, &bytes)
    }

    /// An array whose elements are `bytes` (big-endian, as stored in the dump).
    pub fn prim_bytes(&mut self, id: u64, ty: BasicType, bytes: &[u8]) -> &mut Self {
        let size = ty.hprof_size(self.id_size);
        assert!(ty != BasicType::Object && bytes.len().is_multiple_of(size), "{ty:?} array needs whole elements");
        self.heap.push(0x23);
        self.heap_id(id);
        self.heap_u4(0);
        self.heap_u4((bytes.len() / size) as u32);
        self.heap.push(ty as u8);
        self.heap.extend_from_slice(bytes);
        self
    }

    /// Kinds that carry a thread serial get serial 1; see [`Self::root_in_thread`].
    pub fn root(&mut self, kind: HeapRootKind, id: u64) -> &mut Self {
        self.root_in_thread(kind, id, 1)
    }

    /// `serial` is ignored for kinds that do not carry one.
    pub fn root_in_thread(&mut self, kind: HeapRootKind, id: u64, serial: u32) -> &mut Self {
        let (tag, has_serial, trailing) = match kind {
            HeapRootKind::Unknown => (0xFF, false, Trailing::None),
            HeapRootKind::JniGlobal => (0x01, false, Trailing::Id),
            HeapRootKind::JniLocal => (0x02, true, Trailing::U4),
            HeapRootKind::JavaFrame => (0x03, true, Trailing::U4),
            HeapRootKind::NativeStack => (0x04, true, Trailing::None),
            HeapRootKind::StickyClass => (0x05, false, Trailing::None),
            HeapRootKind::ThreadBlock => (0x06, true, Trailing::None),
            HeapRootKind::MonitorUsed => (0x07, false, Trailing::None),
            HeapRootKind::ThreadObject => (0x08, true, Trailing::U4),
        };
        self.heap.push(tag);
        self.heap_id(id);
        if has_serial {
            self.heap_u4(serial);
        }
        match trailing {
            Trailing::None => {}
            Trailing::U4 => self.heap_u4(0),
            Trailing::Id => self.heap_id(0),
        }
        self
    }

    pub fn finish(&self) -> Vec<u8> {
        let mut out = self.top.clone();
        out.push(TAG_HEAP_SEGMENT);
        out.extend_from_slice(&0u32.to_be_bytes());
        let heap_len = u32::try_from(self.heap.len()).expect("fixture heap segment exceeds 4 GiB");
        out.extend_from_slice(&heap_len.to_be_bytes());
        out.extend_from_slice(&self.heap);
        out.push(TAG_HEAP_DUMP_END);
        out.extend_from_slice(&0u32.to_be_bytes());
        out.extend_from_slice(&0u32.to_be_bytes());
        out
    }
}

enum Trailing {
    None,
    U4,
    Id,
}

struct MiniClass {
    id: u64,
    super_name: Option<String>,
    fields: Vec<(String, BasicType)>,
}

/// Ids for classes, names and string backing arrays come from here, above any address a test
/// would pick by hand.
const GENERATED_ID_BASE: u64 = 1 << 32;

/// Heap fixtures by class and field name on top of [`HprofWriter`] (id size 8).
///
/// Class names are written in the HotSpot form (`.` becomes `/`); look-ups use the name as given.
pub struct MiniHeap {
    w: HprofWriter,
    next_id: u64,
    classes: HashMap<String, MiniClass>,
}

impl Default for MiniHeap {
    fn default() -> Self {
        Self::new()
    }
}

impl MiniHeap {
    /// Starts with `java.lang.Object` and `java.lang.Class` already defined.
    pub fn new() -> Self {
        let mut heap = Self { w: HprofWriter::new(), next_id: GENERATED_ID_BASE, classes: HashMap::new() };
        heap.class("java.lang.Object", None, &[]);
        heap.class("java.lang.Class", Some("java.lang.Object"), &[]);
        heap
    }

    fn fresh_id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }

    fn class_id(&self, name: &str) -> u64 {
        self.classes.get(name).unwrap_or_else(|| panic!("MiniHeap: class {name} is not defined")).id
    }

    /// `super_name: None` writes super id 0.
    pub fn class(&mut self, name: &str, super_name: Option<&str>, fields: &[(&str, BasicType)]) -> &mut Self {
        let super_id = super_name.map_or(0, |sup| self.class_id(sup));
        let id = self.fresh_id();
        let name_id = self.fresh_id();
        let mut field_ids = Vec::with_capacity(fields.len());
        for &(field, ty) in fields {
            let field_id = self.fresh_id();
            self.w.string(field_id, field);
            field_ids.push((field_id, ty));
        }
        self.w.string(name_id, &name.replace('.', "/"));
        self.w.load_class(id, name_id);
        self.w.class(id, super_id, &field_ids, &[]);
        self.w.root(HeapRootKind::StickyClass, id);
        let fields = fields.iter().map(|&(field, ty)| (field.to_owned(), ty)).collect();
        self.classes.insert(name.to_owned(), MiniClass { id, super_name: super_name.map(str::to_owned), fields });
        self
    }

    /// Fields are laid out class first, then superclass, as HotSpot does. A field missing from
    /// `values` is 0; narrower types keep the low bytes of the value.
    pub fn object(&mut self, addr: u64, class: &str, values: &[(&str, u64)]) -> &mut Self {
        let class_id = self.class_id(class);
        let mut data = Vec::new();
        let mut cursor = Some(class);
        while let Some(name) = cursor {
            let c = &self.classes[name];
            for (field, ty) in &c.fields {
                let value = values.iter().find(|(n, _)| *n == field.as_str()).map_or(0, |&(_, v)| v);
                let width = ty.hprof_size(8);
                data.extend_from_slice(&value.to_be_bytes()[8 - width..]);
            }
            cursor = c.super_name.as_deref();
        }
        self.w.instance(addr, class_id, &data);
        self
    }

    pub fn array_of(&mut self, addr: u64, class: &str, items: &[u64]) -> &mut Self {
        let class_id = self.class_id(class);
        self.w.obj_array(addr, class_id, items);
        self
    }

    /// A primitive array of `len` zeroed elements.
    pub fn prim(&mut self, addr: u64, ty: BasicType, len: u32) -> &mut Self {
        self.w.prim_array(addr, ty, len);
        self
    }

    /// A primitive array holding `bytes` (big-endian elements).
    pub fn prim_bytes(&mut self, addr: u64, ty: BasicType, bytes: &[u8]) -> &mut Self {
        self.w.prim_bytes(addr, ty, bytes);
        self
    }

    /// A `java.lang.String` (JDK 9+ layout: `value` byte[] + `coder`) at `addr`. `latin1` stores
    /// one byte per char (coder 0, every char must be ≤ U+00FF); otherwise UTF-16LE (coder 1).
    pub fn string(&mut self, addr: u64, text: &str, latin1: bool) -> &mut Self {
        if !self.classes.contains_key("java.lang.String") {
            let fields = [("value", BasicType::Object), ("coder", BasicType::Byte)];
            self.class("java.lang.String", Some("java.lang.Object"), &fields);
        }
        let bytes: Vec<u8> = if latin1 {
            text.chars()
                .map(|c| u8::try_from(u32::from(c)).unwrap_or_else(|_| panic!("{c:?} is not Latin-1")))
                .collect()
        } else {
            text.encode_utf16().flat_map(u16::to_le_bytes).collect()
        };
        let array = self.fresh_id();
        self.w.prim_bytes(array, BasicType::Byte, &bytes);
        self.object(addr, "java.lang.String", &[("value", array), ("coder", u64::from(!latin1))])
    }

    /// Kinds that carry a thread serial get serial 1.
    pub fn root(&mut self, kind: HeapRootKind, addr: u64) -> &mut Self {
        self.w.root(kind, addr);
        self
    }

    pub fn root_in_thread(&mut self, kind: HeapRootKind, addr: u64, serial: u32) -> &mut Self {
        self.w.root_in_thread(kind, addr, serial);
        self
    }

    pub fn bytes(&self) -> Vec<u8> {
        self.w.finish()
    }

    pub fn write_to(&self, path: &Path) {
        std::fs::write(path, self.bytes()).unwrap_or_else(|e| panic!("MiniHeap: writing {}: {e}", path.display()));
    }
}
