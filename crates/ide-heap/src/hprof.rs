//! Reader for HotSpot `.hprof` heap dumps (format 1.0.1 / 1.0.2, 4- or 8-byte ids).

use std::ops::Range;

use serde::{Deserialize, Serialize};

use crate::error::HeapError;
use crate::reader::Reader;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum BasicType {
    Object = 2,
    Boolean = 4,
    Char = 5,
    Float = 6,
    Double = 7,
    Byte = 8,
    Short = 9,
    Int = 10,
    Long = 11,
}

impl BasicType {
    pub fn from_u8(v: u8) -> Option<Self> {
        Some(match v {
            2 => Self::Object,
            4 => Self::Boolean,
            5 => Self::Char,
            6 => Self::Float,
            7 => Self::Double,
            8 => Self::Byte,
            9 => Self::Short,
            10 => Self::Int,
            11 => Self::Long,
            _ => return None,
        })
    }

    /// Bytes one value takes in the dump; `id_size` is the dump's identifier size.
    pub fn hprof_size(self, id_size: u8) -> usize {
        match self {
            Self::Object => usize::from(id_size),
            Self::Boolean | Self::Byte => 1,
            Self::Char | Self::Short => 2,
            Self::Float | Self::Int => 4,
            Self::Double | Self::Long => 8,
        }
    }

    /// Bytes one value takes in the JVM heap; `ref_size` is 4 with compressed oops, else 8.
    pub fn heap_size(self, ref_size: u8) -> u64 {
        match self {
            Self::Object => u64::from(ref_size),
            other => other.hprof_size(ref_size) as u64,
        }
    }

    /// JVM class name of an array of this type (`[I`); `Object` arrays have no single name, so
    /// they report the most general one.
    pub fn array_name(self) -> &'static str {
        match self {
            Self::Object => "[Ljava.lang.Object;",
            Self::Boolean => "[Z",
            Self::Char => "[C",
            Self::Float => "[F",
            Self::Double => "[D",
            Self::Byte => "[B",
            Self::Short => "[S",
            Self::Int => "[I",
            Self::Long => "[J",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum HeapRootKind {
    Unknown,
    JniGlobal,
    JniLocal,
    JavaFrame,
    NativeStack,
    StickyClass,
    ThreadBlock,
    MonitorUsed,
    ThreadObject,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HprofHeader {
    pub version: String,
    pub id_size: u8,
    pub timestamp_ms: u64,
    /// Offset of the first record.
    pub body_start: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClassDump {
    pub id: u64,
    pub super_id: u64,
    pub loader_id: u64,
    /// `(name id, object id)` of reference statics; a null static has object id 0.
    pub statics: Vec<(u64, u64)>,
    /// Heap bytes taken by the primitive statics.
    pub static_bytes: u64,
    /// Instance fields in dump order, `(name id, type)`.
    pub fields: Vec<(u64, BasicType)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HeapRecord<'a> {
    /// `thread_serial` is present for the kinds that carry one.
    Root {
        kind: HeapRootKind,
        id: u64,
        thread_serial: Option<u32>,
    },
    Class(ClassDump),
    /// `data` is the field values, class first, then each superclass.
    Instance {
        id: u64,
        class_id: u64,
        data: &'a [u8],
    },
    /// `data` is `len` ids.
    ObjectArray {
        id: u64,
        class_id: u64,
        len: u32,
        data: &'a [u8],
    },
    /// `data` is `len` big-endian elements.
    PrimitiveArray {
        id: u64,
        ty: BasicType,
        len: u32,
        data: &'a [u8],
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Record<'a> {
    Utf8 {
        id: u64,
        text: &'a [u8],
    },
    LoadClass {
        class_id: u64,
        name_id: u64,
    },
    /// Byte range of a heap-dump segment's sub-records; its contents follow as `Heap` records.
    Segment(Range<usize>),
    /// `at` is the offset of the sub-record's tag, for [`record_at`].
    Heap {
        at: usize,
        record: HeapRecord<'a>,
    },
}

const MAGIC_1_0_2: &[u8] = b"JAVA PROFILE 1.0.2\0";
const MAGIC_1_0_1: &[u8] = b"JAVA PROFILE 1.0.1\0";

const TAG_UTF8: u8 = 0x01;
const TAG_LOAD_CLASS: u8 = 0x02;
const TAG_HEAP_DUMP: u8 = 0x0C;
const TAG_HEAP_DUMP_SEGMENT: u8 = 0x1C;
const TAG_HEAP_DUMP_END: u8 = 0x2C;
/// Tag (u1), timestamp (u4) and body length (u4).
const RECORD_HEADER_LEN: usize = 9;

fn check_id_size(id_size: u8) -> Result<(), HeapError> {
    match id_size {
        4 | 8 => Ok(()),
        other => Err(HeapError::UnsupportedIdSize(u32::from(other))),
    }
}

fn truncated(buf: &[u8]) -> HeapError {
    HeapError::Truncated { at: buf.len() as u64 }
}

pub fn parse_header(buf: &[u8]) -> Result<HprofHeader, HeapError> {
    let magic =
        [MAGIC_1_0_2, MAGIC_1_0_1].into_iter().find(|magic| buf.starts_with(magic)).ok_or(HeapError::NotHprof)?;
    let mut r = Reader::new(buf, magic.len(), 8);
    let id_size = r.u4()?;
    let id_size = u8::try_from(id_size).map_err(|_| HeapError::UnsupportedIdSize(id_size))?;
    check_id_size(id_size)?;
    let timestamp_ms = r.u8()?;
    let version = String::from_utf8_lossy(&magic[..magic.len() - 1]).into_owned();
    Ok(HprofHeader { version, id_size, timestamp_ms, body_start: r.pos() })
}

/// Walks every top-level record and, for heap-dump segments, the sub-records inside them.
/// A record whose length runs past the end of `buf` is `Truncated`, and so are segments that no
/// HEAP DUMP END follows: HotSpot writes whole segments, so a dump it did not finish ends after one.
pub fn scan<'a>(
    buf: &'a [u8],
    header: &HprofHeader,
    visit: &mut dyn FnMut(Record<'a>) -> Result<(), HeapError>,
) -> Result<(), HeapError> {
    let id_size = header.id_size;
    check_id_size(id_size)?;
    if header.body_start > buf.len() {
        return Err(truncated(buf));
    }
    let mut pos = header.body_start;
    let mut unended_segments = false;
    while pos < buf.len() {
        let mut head = Reader::new(buf, pos, id_size);
        let tag = head.u1()?;
        head.skip(4)?; // timestamp
        let len = head.u4()? as usize;
        let start = pos + RECORD_HEADER_LEN;
        let end = start.checked_add(len).filter(|&end| end <= buf.len()).ok_or_else(|| truncated(buf))?;
        let body = &buf[..end];
        let mut r = Reader::new(body, start, id_size);
        match tag {
            TAG_UTF8 => {
                let id = r.id()?;
                let text = r.bytes(end - r.pos())?;
                visit(Record::Utf8 { id, text })?;
            }
            TAG_LOAD_CLASS => {
                r.skip(4)?; // class serial
                let class_id = r.id()?;
                r.skip(4)?; // stack trace serial
                let name_id = r.id()?;
                visit(Record::LoadClass { class_id, name_id })?;
            }
            TAG_HEAP_DUMP | TAG_HEAP_DUMP_SEGMENT => {
                // A single HEAP DUMP (JDK 8, under 2 GB) has no end record.
                unended_segments |= tag == TAG_HEAP_DUMP_SEGMENT;
                visit(Record::Segment(start..end))?;
                walk_segment(buf, start..end, id_size, &mut |at, record| visit(Record::Heap { at, record }))?;
            }
            TAG_HEAP_DUMP_END => unended_segments = false,
            _ => {}
        }
        pos = end;
    }
    if unended_segments {
        return Err(truncated(buf));
    }
    Ok(())
}

/// Visits the sub-records of one segment (the range from [`Record::Segment`]) with their offsets.
/// The last sub-record must end exactly at the segment's end.
pub fn scan_segment<'a>(
    buf: &'a [u8],
    segment: Range<usize>,
    id_size: u8,
    visit: &mut dyn FnMut(usize, HeapRecord<'a>) -> Result<(), HeapError>,
) -> Result<(), HeapError> {
    check_id_size(id_size)?;
    walk_segment(buf, segment, id_size, visit)
}

fn walk_segment<'a>(
    buf: &'a [u8],
    segment: Range<usize>,
    id_size: u8,
    visit: &mut dyn FnMut(usize, HeapRecord<'a>) -> Result<(), HeapError>,
) -> Result<(), HeapError> {
    if segment.start > segment.end || segment.end > buf.len() {
        return Err(truncated(buf));
    }
    let mut r = Reader::new(&buf[..segment.end], segment.start, id_size);
    while r.pos() < segment.end {
        let at = r.pos();
        let record = read_sub_record(&mut r)?;
        visit(at, record)?;
    }
    Ok(())
}

/// Reads the sub-record whose tag is at `at`, as given by [`Record::Heap`].
pub fn record_at(buf: &[u8], at: usize, id_size: u8) -> Result<HeapRecord<'_>, HeapError> {
    check_id_size(id_size)?;
    read_sub_record(&mut Reader::new(buf, at, id_size))
}

fn read_sub_record<'a>(r: &mut Reader<'a>) -> Result<HeapRecord<'a>, HeapError> {
    let at = r.pos();
    let tag = r.u1()?;
    // (kind, carries a thread serial, bytes after it)
    let root = match tag {
        0xFF => Some((HeapRootKind::Unknown, false, 0)),
        0x01 => Some((HeapRootKind::JniGlobal, false, usize::from(r.id_size()))),
        0x02 => Some((HeapRootKind::JniLocal, true, 4)),
        0x03 => Some((HeapRootKind::JavaFrame, true, 4)),
        0x04 => Some((HeapRootKind::NativeStack, true, 0)),
        0x05 => Some((HeapRootKind::StickyClass, false, 0)),
        0x06 => Some((HeapRootKind::ThreadBlock, true, 0)),
        0x07 => Some((HeapRootKind::MonitorUsed, false, 0)),
        0x08 => Some((HeapRootKind::ThreadObject, true, 4)),
        _ => None,
    };
    if let Some((kind, has_serial, trailing)) = root {
        let id = r.id()?;
        let thread_serial = if has_serial { Some(r.u4()?) } else { None };
        r.skip(trailing)?;
        return Ok(HeapRecord::Root { kind, id, thread_serial });
    }
    match tag {
        0x20 => read_class_dump(r).map(HeapRecord::Class),
        0x21 => {
            let id = r.id()?;
            r.skip(4)?; // stack trace serial
            let class_id = r.id()?;
            let len = r.u4()? as usize;
            Ok(HeapRecord::Instance { id, class_id, data: r.bytes(len)? })
        }
        0x22 => {
            let id = r.id()?;
            r.skip(4)?;
            let len = r.u4()?;
            let class_id = r.id()?;
            let size = (len as usize).checked_mul(usize::from(r.id_size())).ok_or_else(|| truncated(r.buf()))?;
            Ok(HeapRecord::ObjectArray { id, class_id, len, data: r.bytes(size)? })
        }
        0x23 => {
            let id = r.id()?;
            r.skip(4)?;
            let len = r.u4()?;
            let ty = read_type(r)?;
            if ty == BasicType::Object {
                return Err(HeapError::UnknownType { ty: ty as u8, at: (r.pos() - 1) as u64 });
            }
            let size = (len as usize).checked_mul(ty.hprof_size(r.id_size())).ok_or_else(|| truncated(r.buf()))?;
            Ok(HeapRecord::PrimitiveArray { id, ty, len, data: r.bytes(size)? })
        }
        tag => Err(HeapError::UnknownSubRecord { tag, at: at as u64 }),
    }
}

fn read_type(r: &mut Reader<'_>) -> Result<BasicType, HeapError> {
    let at = r.pos();
    let ty = r.u1()?;
    BasicType::from_u8(ty).ok_or(HeapError::UnknownType { ty, at: at as u64 })
}

fn read_class_dump(r: &mut Reader<'_>) -> Result<ClassDump, HeapError> {
    let id_size = r.id_size();
    let id = r.id()?;
    r.skip(4)?; // stack trace serial
    let super_id = r.id()?;
    let loader_id = r.id()?;
    r.skip(4 * usize::from(id_size))?; // signers, protection domain, 2 reserved
    r.skip(4)?; // instance size

    for _ in 0..r.u2()? {
        r.skip(2)?; // constant pool index
        let ty = read_type(r)?;
        r.skip(ty.hprof_size(id_size))?;
    }

    let mut statics = Vec::new();
    let mut static_bytes = 0;
    for _ in 0..r.u2()? {
        let name = r.id()?;
        let ty = read_type(r)?;
        if ty == BasicType::Object {
            statics.push((name, r.id()?));
        } else {
            r.skip(ty.hprof_size(id_size))?;
            static_bytes += ty.heap_size(id_size);
        }
    }

    let mut fields = Vec::new();
    for _ in 0..r.u2()? {
        let name = r.id()?;
        fields.push((name, read_type(r)?));
    }
    Ok(ClassDump { id, super_id, loader_id, statics, static_bytes, fields })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{HprofWriter, MiniHeap};
    use proptest::prelude::*;

    fn collect(bytes: &[u8]) -> Result<Vec<Record<'_>>, HeapError> {
        let header = parse_header(bytes)?;
        let mut out = Vec::new();
        scan(bytes, &header, &mut |r| {
            out.push(r);
            Ok(())
        })?;
        Ok(out)
    }

    fn segment_of(bytes: &[u8]) -> Range<usize> {
        collect(bytes)
            .unwrap()
            .into_iter()
            .find_map(|r| if let Record::Segment(s) = r { Some(s) } else { None })
            .expect("a segment")
    }

    fn all_kinds(w: &mut HprofWriter) {
        w.string(1, "Node")
            .string(2, "next")
            .load_class(0x100, 1)
            .class(0x100, 0, &[(2, BasicType::Object), (3, BasicType::Long)], &[(2, 0x10)])
            .instance(0x10, 0x100, &[0u8; 16])
            .obj_array(0x20, 0x100, &[0x10, 0])
            .prim_array(0x30, BasicType::Int, 3)
            .root(HeapRootKind::JavaFrame, 0x10)
            .root(HeapRootKind::StickyClass, 0x100);
    }

    #[test]
    fn parses_header() {
        let header = parse_header(&MiniHeap::new().bytes()).unwrap();
        assert_eq!((header.version.as_str(), header.id_size, header.body_start), ("JAVA PROFILE 1.0.2", 8, 31));

        let mut old = b"JAVA PROFILE 1.0.1\0".to_vec();
        old.extend_from_slice(&[0, 0, 0, 4, 0, 0, 0, 1, 0, 0, 0, 2]);
        let header = parse_header(&old).unwrap();
        assert_eq!(
            (header.version.as_str(), header.id_size, header.timestamp_ms),
            ("JAVA PROFILE 1.0.1", 4, (1 << 32) + 2)
        );

        let bad_size = b"JAVA PROFILE 1.0.2\0\0\0\0\x03\0\0\0\0\0\0\0\0";
        assert!(matches!(parse_header(bad_size), Err(HeapError::UnsupportedIdSize(3))));
        assert!(matches!(parse_header(b"GIF89a"), Err(HeapError::NotHprof)));
        assert!(matches!(parse_header(b""), Err(HeapError::NotHprof)));
        assert!(matches!(parse_header(b"JAVA PROFILE 1.0.3\0\0\0\0\x08"), Err(HeapError::NotHprof)));
        assert!(matches!(parse_header(b"JAVA PROFILE 1.0.2\0\0\0"), Err(HeapError::Truncated { at: 21 })));
    }

    #[test]
    fn scans_every_record_kind() {
        let mut w = HprofWriter::new();
        all_kinds(&mut w);
        let bytes = w.finish();
        let records = collect(&bytes).unwrap();

        let (mut utf8, mut loads, mut segments) = (0, 0, 0);
        let (mut classes, mut instances, mut obj_arrays, mut prim_arrays, mut roots) = (0, 0, 0, 0, 0);
        for record in &records {
            match record {
                Record::Utf8 { .. } => utf8 += 1,
                Record::LoadClass { class_id, name_id } => {
                    loads += 1;
                    assert_eq!((*class_id, *name_id), (0x100, 1));
                }
                Record::Segment(_) => segments += 1,
                Record::Heap { record, .. } => match record {
                    HeapRecord::Class(c) => {
                        classes += 1;
                        assert_eq!((c.id, c.super_id, c.loader_id), (0x100, 0, 0));
                        assert_eq!(c.statics, [(2, 0x10)]);
                        assert_eq!(c.fields, [(2, BasicType::Object), (3, BasicType::Long)]);
                    }
                    HeapRecord::Instance { id, class_id, data } => {
                        instances += 1;
                        assert_eq!((*id, *class_id, data.len()), (0x10, 0x100, 16));
                    }
                    HeapRecord::ObjectArray { id, class_id, len, data } => {
                        obj_arrays += 1;
                        assert_eq!((*id, *class_id, *len, data.len()), (0x20, 0x100, 2, 16));
                    }
                    HeapRecord::PrimitiveArray { id, ty, len, data } => {
                        prim_arrays += 1;
                        assert_eq!((*id, *ty, *len, data.len()), (0x30, BasicType::Int, 3, 12));
                    }
                    HeapRecord::Root { kind, id, thread_serial } => {
                        roots += 1;
                        match kind {
                            HeapRootKind::JavaFrame => assert_eq!((*id, *thread_serial), (0x10, Some(1))),
                            HeapRootKind::StickyClass => assert_eq!((*id, *thread_serial), (0x100, None)),
                            other => panic!("unexpected root {other:?}"),
                        }
                    }
                },
            }
        }
        assert_eq!((utf8, loads, segments), (2, 1, 1));
        assert_eq!((classes, instances, obj_arrays, prim_arrays, roots), (1, 1, 1, 1, 2));
        assert!(matches!(&records[3], Record::Segment(s) if s.end <= bytes.len()), "segment precedes its contents");
    }

    #[test]
    fn root_kinds_carry_the_thread_serial_they_have() {
        let kinds = [
            (HeapRootKind::Unknown, false),
            (HeapRootKind::JniGlobal, false),
            (HeapRootKind::JniLocal, true),
            (HeapRootKind::JavaFrame, true),
            (HeapRootKind::NativeStack, true),
            (HeapRootKind::StickyClass, false),
            (HeapRootKind::ThreadBlock, true),
            (HeapRootKind::MonitorUsed, false),
            (HeapRootKind::ThreadObject, true),
        ];
        let mut w = HprofWriter::new();
        for (i, (kind, _)) in kinds.iter().enumerate() {
            w.root_in_thread(*kind, 0x40 + i as u64, 7);
            w.root(*kind, 0x80 + i as u64);
        }
        let bytes = w.finish();
        let mut seen = Vec::new();
        for r in collect(&bytes).unwrap() {
            if let Record::Heap { record: HeapRecord::Root { kind, id, thread_serial }, .. } = r {
                seen.push((kind, id, thread_serial));
            }
        }
        assert_eq!(seen.len(), kinds.len() * 2);
        for (i, (kind, carries)) in kinds.iter().enumerate() {
            let explicit = seen[2 * i];
            let default = seen[2 * i + 1];
            assert_eq!(explicit, (*kind, 0x40 + i as u64, carries.then_some(7)));
            assert_eq!(default, (*kind, 0x80 + i as u64, carries.then_some(1)));
        }
    }

    #[test]
    fn primitive_arrays_expose_their_contents() {
        let mut w = HprofWriter::new();
        w.prim_bytes(0x1, BasicType::Char, &[0, b'h', 0, 0xE9]).prim_bytes(0x2, BasicType::Byte, b"v42");
        let bytes = w.finish();
        let arrays: Vec<_> = collect(&bytes)
            .unwrap()
            .into_iter()
            .filter_map(|r| match r {
                Record::Heap { record: HeapRecord::PrimitiveArray { ty, len, data, .. }, .. } => {
                    Some((ty, len, data.to_vec()))
                }
                _ => None,
            })
            .collect();
        assert_eq!(arrays, [(BasicType::Char, 2, vec![0, b'h', 0, 0xE9]), (BasicType::Byte, 3, b"v42".to_vec())]);
    }

    #[test]
    fn mini_heap_builds_strings_and_defines_object_and_class() {
        let mut heap = MiniHeap::new();
        heap.string(0x10, "v42", true).string(0x20, "hé", false);
        let bytes = heap.bytes();
        let records = collect(&bytes).unwrap();
        let names: Vec<_> = records
            .iter()
            .filter_map(|r| {
                if let Record::Utf8 { text, .. } = r { Some(String::from_utf8_lossy(text).into_owned()) } else { None }
            })
            .collect();
        assert!(names.iter().any(|n| n == "java/lang/Object") && names.iter().any(|n| n == "java/lang/Class"));
        let arrays: Vec<_> = records
            .iter()
            .filter_map(|r| match r {
                Record::Heap { record: HeapRecord::PrimitiveArray { data, .. }, .. } => Some(data.to_vec()),
                _ => None,
            })
            .collect();
        assert_eq!(arrays, [b"v42".to_vec(), vec![b'h', 0, 0xE9, 0]]);
        let coders: Vec<_> = records
            .iter()
            .filter_map(|r| match r {
                Record::Heap { record: HeapRecord::Instance { id, data, .. }, .. } => Some((*id, data[8])),
                _ => None,
            })
            .collect();
        assert_eq!(coders, [(0x10, 0), (0x20, 1)]);
    }

    #[test]
    fn mini_heap_lays_out_fields_class_first_then_super() {
        let mut heap = MiniHeap::new();
        heap.class("A", Some("java.lang.Object"), &[("a", BasicType::Int)])
            .class("B", Some("A"), &[("b", BasicType::Object), ("c", BasicType::Byte)])
            .object(0x10, "B", &[("a", 7), ("b", 0x99), ("c", 0x1FF)]);
        let bytes = heap.bytes();
        let data = collect(&bytes)
            .unwrap()
            .into_iter()
            .find_map(|r| match r {
                Record::Heap { record: HeapRecord::Instance { data, .. }, .. } => Some(data.to_vec()),
                _ => None,
            })
            .unwrap();
        assert_eq!(data, [0, 0, 0, 0, 0, 0, 0, 0x99, 0xFF, 0, 0, 0, 7]);
    }

    #[test]
    fn record_at_reads_back_an_instance() {
        let mut w = HprofWriter::new();
        all_kinds(&mut w);
        let bytes = w.finish();
        let at = collect(&bytes)
            .unwrap()
            .into_iter()
            .find_map(|r| match r {
                Record::Heap { at, record: HeapRecord::Instance { .. } } => Some(at),
                _ => None,
            })
            .unwrap();
        match record_at(&bytes, at, 8).unwrap() {
            HeapRecord::Instance { id, class_id, data } => assert_eq!((id, class_id, data.len()), (0x10, 0x100, 16)),
            other => panic!("expected an instance, got {other:?}"),
        }
        assert!(matches!(record_at(&bytes, bytes.len(), 8), Err(HeapError::Truncated { .. })));
        assert!(matches!(record_at(&bytes, at, 3), Err(HeapError::UnsupportedIdSize(3))));
    }

    #[test]
    fn scan_segment_visits_the_same_records_scan_does() {
        let mut w = HprofWriter::new();
        all_kinds(&mut w);
        let bytes = w.finish();
        let from_scan: Vec<_> = collect(&bytes)
            .unwrap()
            .into_iter()
            .filter_map(|r| if let Record::Heap { at, record } = r { Some((at, record)) } else { None })
            .collect();
        let mut from_segment = Vec::new();
        scan_segment(&bytes, segment_of(&bytes), 8, &mut |at, record| {
            from_segment.push((at, record));
            Ok(())
        })
        .unwrap();
        assert_eq!(from_scan.len(), 6);
        assert_eq!(from_scan, from_segment);
    }

    #[test]
    fn visitor_errors_stop_the_scan() {
        let bytes = MiniHeap::new().bytes();
        let header = parse_header(&bytes).unwrap();
        let mut calls = 0;
        let result = scan(&bytes, &header, &mut |_| {
            calls += 1;
            Err(HeapError::Cancelled)
        });
        assert!(matches!(result, Err(HeapError::Cancelled)));
        assert_eq!(calls, 1);
    }

    #[test]
    fn both_heap_dump_tags_are_segments() {
        let bytes = MiniHeap::new().bytes();
        let segment = segment_of(&bytes);
        let mut old_style = bytes.clone();
        old_style[segment.start - 9] = 0x0C;
        assert_eq!(segment_of(&old_style), segment);
    }

    #[test]
    fn id_size_4_dump_parses() {
        let mut w = HprofWriter::with_id_size(4);
        w.string(1, "Node")
            .load_class(0x100, 1)
            .class(0x100, 0, &[(2, BasicType::Object), (3, BasicType::Long)], &[(2, 0x10)])
            .instance(0x10, 0x100, &[0u8; 12])
            .obj_array(0x20, 0x100, &[0x10, 0, 0xFFFF_FFFF])
            .prim_array(0x30, BasicType::Short, 5)
            .root(HeapRootKind::ThreadObject, 0x10);
        let bytes = w.finish();
        let header = parse_header(&bytes).unwrap();
        assert_eq!((header.id_size, header.body_start), (4, 31));
        let records: Vec<_> = collect(&bytes)
            .unwrap()
            .into_iter()
            .filter_map(|r| if let Record::Heap { record, .. } = r { Some(record) } else { None })
            .collect();
        assert_eq!(records.len(), 5);
        match &records[0] {
            HeapRecord::Class(c) => {
                assert_eq!((c.id, c.statics.as_slice(), c.fields.len()), (0x100, &[(2, 0x10)][..], 2));
            }
            other => panic!("expected the class, got {other:?}"),
        }
        assert!(matches!(&records[1], HeapRecord::Instance { id: 0x10, class_id: 0x100, data } if data.len() == 12));
        assert!(
            matches!(&records[2], HeapRecord::ObjectArray { len: 3, data, .. } if data.len() == 12 && data[8..] == [0xFF; 4])
        );
        assert!(
            matches!(&records[3], HeapRecord::PrimitiveArray { ty: BasicType::Short, len: 5, data, .. } if data.len() == 10)
        );
        assert!(matches!(
            &records[4],
            HeapRecord::Root { kind: HeapRootKind::ThreadObject, id: 0x10, thread_serial: Some(1) }
        ));
    }

    fn push_id(out: &mut Vec<u8>, v: u64) {
        out.extend_from_slice(&v.to_be_bytes());
    }

    /// A class dump written by hand: loader, a constant-pool entry, and statics of each shape.
    fn class_dump_bytes(last_field_type: u8) -> Vec<u8> {
        let mut b = vec![0x20];
        push_id(&mut b, 0x500);
        b.extend_from_slice(&0u32.to_be_bytes());
        for id in [0x400, 0x77, 0, 0, 0, 0] {
            push_id(&mut b, id); // super, loader, signers, domain, 2 reserved
        }
        b.extend_from_slice(&24u32.to_be_bytes());
        b.extend_from_slice(&[0, 1, 0, 7, 10, 0, 0, 0, 99]); // constant pool: one int
        b.extend_from_slice(&[0, 3]);
        push_id(&mut b, 0xA);
        b.push(2);
        push_id(&mut b, 0xBEEF); // object static
        push_id(&mut b, 0xB);
        b.push(10);
        b.extend_from_slice(&5u32.to_be_bytes()); // int static
        push_id(&mut b, 0xC);
        b.push(11);
        b.extend_from_slice(&6u64.to_be_bytes()); // long static
        b.extend_from_slice(&[0, 2]);
        push_id(&mut b, 0xD);
        b.push(2);
        push_id(&mut b, 0xE);
        b.push(last_field_type);
        b
    }

    #[test]
    fn class_dump_reads_loader_statics_and_skips_the_constant_pool() {
        let bytes = class_dump_bytes(11);
        let HeapRecord::Class(c) = record_at(&bytes, 0, 8).unwrap() else { panic!("expected a class") };
        assert_eq!((c.id, c.super_id, c.loader_id), (0x500, 0x400, 0x77));
        assert_eq!(c.statics, [(0xA, 0xBEEF)]);
        assert_eq!(c.static_bytes, 12);
        assert_eq!(c.fields, [(0xD, BasicType::Object), (0xE, BasicType::Long)]);
    }

    #[test]
    fn unknown_value_type_reports_its_offset() {
        let bytes = class_dump_bytes(0x63);
        let err = record_at(&bytes, 0, 8).unwrap_err();
        assert!(matches!(err, HeapError::UnknownType { ty: 0x63, at } if at == bytes.len() as u64 - 1), "{err:?}");
    }

    #[test]
    fn truncated_dump_reports_offset() {
        let mut bytes = MiniHeap::new().bytes();
        let body_start = parse_header(&bytes).unwrap().body_start as u64;
        bytes.truncate(bytes.len() - 5);
        let err = collect(&bytes).unwrap_err();
        assert!(matches!(err, HeapError::Truncated { at } if at > body_start && at == bytes.len() as u64), "{err:?}");
        assert!(err.to_string().contains(&bytes.len().to_string()));
    }

    /// HotSpot flushes whole segments, so a JVM killed while dumping leaves a file that ends
    /// right after one, without HEAP DUMP END.
    #[test]
    fn a_dump_the_jvm_did_not_finish_ends_early() {
        let mut bytes = MiniHeap::new().bytes();
        bytes.truncate(bytes.len() - RECORD_HEADER_LEN);
        let err = collect(&bytes).unwrap_err();
        assert!(matches!(err, HeapError::Truncated { at } if at == bytes.len() as u64), "{err:?}");
        assert!(err.to_string().starts_with("the dump ends early"), "{err}");
    }

    #[test]
    fn every_prefix_is_ok_or_truncated_at_its_length() {
        let mut heap = MiniHeap::new();
        heap.class("N", Some("java.lang.Object"), &[("next", BasicType::Object)])
            .object(0x10, "N", &[("next", 0x20)])
            .string(0x20, "x", true)
            .root(HeapRootKind::ThreadObject, 0x10);
        let bytes = heap.bytes();
        let header = parse_header(&bytes).unwrap();
        let segment = segment_of(&bytes);
        for cut in header.body_start..bytes.len() {
            let prefix = &bytes[..cut];
            match scan(prefix, &header, &mut |_| Ok(())) {
                // Only a prefix without heap data is a complete (empty) dump.
                Ok(()) => assert!(cut < segment.start, "cut at {cut} has heap data but no end"),
                Err(HeapError::Truncated { at }) => assert_eq!(at, cut as u64, "cut at {cut}"),
                Err(other) => panic!("cut at {cut}: {other:?}"),
            }
        }
        let past_end = HprofHeader { body_start: bytes.len() + 1, ..header };
        assert!(matches!(scan(&bytes, &past_end, &mut |_| Ok(())), Err(HeapError::Truncated { .. })));
    }

    #[test]
    fn sub_record_overrunning_its_segment_is_truncated() {
        let mut bytes = MiniHeap::new().bytes();
        let segment = segment_of(&bytes);
        let len_at = segment.start - 4;
        let shrunk = (segment.len() as u32 - 3).to_be_bytes();
        bytes[len_at..segment.start].copy_from_slice(&shrunk);
        let err = collect(&bytes).unwrap_err();
        assert!(matches!(err, HeapError::Truncated { at } if at == segment.end as u64 - 3), "{err:?}");
    }

    #[test]
    fn unknown_sub_record_is_an_error() {
        let mut bytes = MiniHeap::new().bytes();
        let segment = segment_of(&bytes);
        bytes[segment.start] = 0x99;
        let err = collect(&bytes).unwrap_err();
        assert!(matches!(err, HeapError::UnknownSubRecord { tag: 0x99, at } if at == segment.start as u64), "{err:?}");
        assert!(err.to_string().contains("0x99"));
    }

    #[test]
    fn array_lengths_larger_than_the_dump_do_not_allocate_or_panic() {
        let mut b = vec![0x23];
        push_id(&mut b, 1);
        b.extend_from_slice(&0u32.to_be_bytes());
        b.extend_from_slice(&u32::MAX.to_be_bytes());
        b.push(11);
        assert!(matches!(record_at(&b, 0, 8), Err(HeapError::Truncated { .. })));
        b[0] = 0x22;
        assert!(matches!(record_at(&b, 0, 8), Err(HeapError::Truncated { .. })));
    }

    #[test]
    fn primitive_array_of_objects_is_an_unknown_type() {
        let mut b = vec![0x23];
        push_id(&mut b, 1);
        b.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0]);
        b.push(2);
        assert!(matches!(record_at(&b, 0, 8), Err(HeapError::UnknownType { ty: 2, .. })));
    }

    #[test]
    fn basic_type_sizes_and_names() {
        assert_eq!(BasicType::from_u8(10), Some(BasicType::Int));
        assert_eq!([0, 1, 3, 12, 255].map(BasicType::from_u8), [None; 5]);
        assert_eq!((BasicType::Object.hprof_size(4), BasicType::Object.hprof_size(8)), (4, 8));
        assert_eq!((BasicType::Object.heap_size(4), BasicType::Long.heap_size(4)), (4, 8));
        assert_eq!((BasicType::Char.hprof_size(8), BasicType::Boolean.heap_size(8)), (2, 1));
        assert_eq!(
            (BasicType::Int.array_name(), BasicType::Boolean.array_name(), BasicType::Long.array_name()),
            ("[I", "[Z", "[J")
        );
    }

    fn sample() -> Vec<u8> {
        let mut heap = MiniHeap::new();
        heap.class("Node", Some("java.lang.Object"), &[("next", BasicType::Object), ("v", BasicType::Long)])
            .class("[LNode;", Some("java.lang.Object"), &[])
            .object(0x10, "Node", &[("next", 0x20), ("v", 5)])
            .object(0x20, "Node", &[])
            .array_of(0x30, "[LNode;", &[0x10, 0x20, 0])
            .prim(0x40, BasicType::Int, 3)
            .string(0x50, "hello", true)
            .root(HeapRootKind::ThreadObject, 0x10)
            .root(HeapRootKind::JniGlobal, 0x30);
        heap.bytes()
    }

    fn with_header(id_size: u8, body: &[u8]) -> Vec<u8> {
        let mut bytes = MAGIC_1_0_2.to_vec();
        bytes.extend_from_slice(&u32::from(id_size).to_be_bytes());
        bytes.extend_from_slice(&1_700_000_000_000u64.to_be_bytes());
        bytes.extend_from_slice(body);
        bytes
    }

    proptest! {
        #[test]
        fn parser_never_panics(bytes in proptest::collection::vec(any::<u8>(), 0..4096)) {
            let _ = parse_header(&bytes).and_then(|h| scan(&bytes, &h, &mut |_| Ok(())));
        }

        /// Random bytes alone fail the magic check, so this puts a valid header in front to make
        /// `scan` and `scan_segment` run on arbitrary record streams.
        #[test]
        fn random_bytes_after_a_valid_header_never_panic(
            id_size in prop_oneof![Just(4u8), Just(8u8)],
            body in proptest::collection::vec(any::<u8>(), 0..4096),
        ) {
            let bytes = with_header(id_size, &body);
            let header = parse_header(&bytes).unwrap();
            prop_assert_eq!(header.id_size, id_size);
            let _ = scan(&bytes, &header, &mut |_| Ok(()));
            let _ = scan_segment(&bytes, header.body_start..bytes.len(), id_size, &mut |_, _| Ok(()));
            for at in header.body_start..bytes.len() {
                let _ = record_at(&bytes, at, id_size);
            }
        }

        /// Same, but every record has a correct length so the random bytes reach the heap-dump
        /// segments and the sub-record parsers instead of stopping at the first bad length.
        #[test]
        fn random_records_after_a_valid_header_never_panic(
            id_size in prop_oneof![Just(4u8), Just(8u8)],
            records in proptest::collection::vec(
                (
                    prop_oneof![Just(0x01u8), Just(0x02), Just(0x0C), Just(0x1C), Just(0x2C), any::<u8>()],
                    prop_oneof![
                        Just(0x20u8), Just(0x21), Just(0x22), Just(0x23), Just(0x01), Just(0x02), Just(0x03),
                        Just(0x04), Just(0x05), Just(0x06), Just(0x07), Just(0x08), Just(0xFF), any::<u8>()
                    ],
                    proptest::collection::vec(any::<u8>(), 0..96),
                ),
                0..12,
            ),
        ) {
            let mut body = Vec::new();
            for (tag, first, rest) in records {
                let mut record_body = vec![first];
                record_body.extend_from_slice(&rest);
                body.push(tag);
                body.extend_from_slice(&0u32.to_be_bytes());
                body.extend_from_slice(&(record_body.len() as u32).to_be_bytes());
                body.extend_from_slice(&record_body);
            }
            let bytes = with_header(id_size, &body);
            let header = parse_header(&bytes).unwrap();
            let mut segments = Vec::new();
            let _ = scan(&bytes, &header, &mut |r| {
                if let Record::Segment(s) = r {
                    segments.push(s);
                }
                Ok(())
            });
            for s in segments {
                let _ = scan_segment(&bytes, s, id_size, &mut |_, _| Ok(()));
            }
        }

        #[test]
        fn mutated_dump_never_panics(flips in proptest::collection::vec((0usize..2048, any::<u8>()), 1..16)) {
            let pristine = sample();
            let header = parse_header(&pristine).unwrap();
            let segment = segment_of(&pristine);
            let mut bytes = pristine.clone();
            for (pos, value) in flips {
                let at = pos % bytes.len();
                bytes[at] = value;
            }
            let _ = scan(&bytes, &header, &mut |_| Ok(()));
            for id_size in [4, 8] {
                let _ = scan_segment(&bytes, segment.clone(), id_size, &mut |_, _| Ok(()));
            }
            for at in 0..bytes.len() {
                let _ = record_at(&bytes, at, 8);
            }
        }
    }
}
