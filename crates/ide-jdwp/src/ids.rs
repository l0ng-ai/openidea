use crate::codec::{CodecError, Reader, Value, Writer, is_object_tag, primitive_size};

/// `VirtualMachine.IDSizes` (1/7) reply: byte widths of the ids in every later packet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IdSizes {
    pub field: u8,
    pub method: u8,
    pub object: u8,
    pub reference_type: u8,
    pub frame: u8,
}

impl IdSizes {
    pub fn parse(reply_body: &[u8]) -> Result<IdSizes, CodecError> {
        let mut r = Reader::new(reply_body);
        let mut next = || -> Result<u8, CodecError> {
            let n = r.i32()?;
            match u8::try_from(n) {
                Ok(size @ 1..=8) => Ok(size),
                _ => Err(CodecError::BadLength(n as u32)),
            }
        };
        Ok(IdSizes { field: next()?, method: next()?, object: next()?, reference_type: next()?, frame: next()? })
    }
}

/// Where a reply carries ObjectIDs. Each one is a reference the VM counted for the receiver,
/// so [`object_ids`] reports every occurrence, not every distinct id.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplyIds {
    /// No ObjectID. Also right for replies that carry only ReferenceTypeIDs, which are never disposed.
    None,
    /// `int n; (tag, objectID)*` — `ReferenceType.Instances` (2/16), `ObjectReference.ReferringObjects` (9/10).
    TaggedObjects,
    /// `int n; value*` (tagged) — `ReferenceType.GetValues` (2/6), `ObjectReference.GetValues` (9/2).
    Values,
    /// `byte tag; int n;` then untagged values for a primitive tag, tagged values for an object tag
    /// — `ArrayReference.GetValues` (13/2).
    ArrayRegion,
}

/// ObjectIDs of `body` in encounter order, one element per occurrence; null (0) is skipped.
///
/// Strict on purpose: these ids feed `DisposeObjects`, so a body that does not match `layout`
/// exactly (trailing bytes, a tag that cannot occur there) is an `Err`, which only leaks.
pub fn object_ids(layout: ReplyIds, body: &[u8], sizes: &IdSizes) -> Result<Vec<u64>, CodecError> {
    let mut out = Vec::new();
    let mut r = Reader::new(body);
    match layout {
        ReplyIds::None => return Ok(out),
        ReplyIds::TaggedObjects => {
            for _ in 0..r.count()? {
                let tag = r.u8()?;
                if !is_object_tag(tag) {
                    return Err(CodecError::BadTag(tag));
                }
                push_id(&mut out, r.id(sizes.object)?);
            }
        }
        ReplyIds::Values => {
            for _ in 0..r.count()? {
                push_value(&mut out, tagged_value(&mut r, sizes, |tag| tag != b'V')?);
            }
        }
        ReplyIds::ArrayRegion => {
            let tag = r.u8()?;
            let n = r.count()?;
            if is_object_tag(tag) {
                for _ in 0..n {
                    push_value(&mut out, tagged_value(&mut r, sizes, is_object_tag)?);
                }
            } else {
                let size = primitive_size(tag).ok_or(CodecError::BadTag(tag))?;
                r.skip(n.checked_mul(usize::from(size)).ok_or(CodecError::Truncated)?)?;
            }
        }
    }
    match r.remaining() {
        0 => Ok(out),
        extra => Err(CodecError::BadLength(u32::try_from(extra).unwrap_or(u32::MAX))),
    }
}

fn tagged_value(r: &mut Reader<'_>, sizes: &IdSizes, allowed: fn(u8) -> bool) -> Result<Value, CodecError> {
    let tag = r.u8()?;
    if !allowed(tag) {
        return Err(CodecError::BadTag(tag));
    }
    r.value(tag, sizes)
}

fn push_id(out: &mut Vec<u64>, id: u64) {
    if id != 0 {
        out.push(id);
    }
}

fn push_value(out: &mut Vec<u64>, value: Value) {
    if let Value::Object { id, .. } = value {
        push_id(out, id);
    }
}

/// The first event of a `Composite` (64/100) event packet, whatever its suspend policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stop {
    pub suspend_policy: u8,
    /// `None` for events that carry no thread (`CLASS_UNLOAD`, `VM_DEATH`) or the null thread.
    pub thread: Option<u64>,
}

pub(crate) const EVENT_CLASS_PREPARE: u8 = 8;
const EVENT_CLASS_UNLOAD: u8 = 9;
const EVENT_VM_DEATH: u8 = 99;

/// The kind of a `Composite` event's first event; `None` when it holds none or is malformed.
pub(crate) fn event_kind(event_body: &[u8]) -> Option<u8> {
    let mut r = Reader::new(event_body);
    r.u8().ok()?;
    if r.count().ok()? == 0 {
        return None;
    }
    r.u8().ok()
}

/// `None` when the packet holds no event or is malformed.
pub fn stop_of(event_body: &[u8], sizes: &IdSizes) -> Option<Stop> {
    let mut r = Reader::new(event_body);
    let suspend_policy = r.u8().ok()?;
    if r.count().ok()? == 0 {
        return None;
    }
    let kind = r.u8().ok()?;
    r.i32().ok()?;
    let thread = match kind {
        EVENT_CLASS_UNLOAD | EVENT_VM_DEATH => None,
        _ => Some(r.id(sizes.object).ok()?).filter(|&thread| thread != 0),
    };
    Some(Stop { suspend_policy, thread })
}

/// `VirtualMachine.DisposeObjects` (1/14) body: `int n; (objectID, int refCnt)*`.
pub fn dispose_body(entries: &[(u64, u32)], sizes: &IdSizes) -> Vec<u8> {
    let mut w = Writer::new();
    w.i32(entries.len() as i32);
    for &(id, count) in entries {
        w.id(id, sizes.object);
        w.i32(count as i32);
    }
    w.into_vec()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::{Value, Writer};
    use proptest::collection::vec;
    use proptest::prelude::*;

    const S8: IdSizes = IdSizes { field: 8, method: 8, object: 8, reference_type: 8, frame: 8 };

    fn values_body(values: &[(u8, u64)], sizes: &IdSizes) -> Vec<u8> {
        let mut w = Writer::new();
        w.i32(values.len() as i32);
        for &(tag, raw) in values {
            w.u8(tag);
            w.id(raw, value_size(tag, sizes));
        }
        w.into_vec()
    }

    fn value_size(tag: u8, sizes: &IdSizes) -> u8 {
        match tag {
            b'B' | b'Z' => 1,
            b'C' | b'S' => 2,
            b'F' | b'I' => 4,
            b'J' | b'D' => 8,
            _ => sizes.object,
        }
    }

    #[test]
    fn id_sizes_from_reply() {
        let mut w = Writer::new();
        for _ in 0..5 {
            w.i32(8);
        }
        assert_eq!(IdSizes::parse(&w.into_vec()), Ok(S8));
    }

    #[test]
    fn id_sizes_reject_bad_input() {
        let mut short = [0, 0, 0, 8].repeat(4);
        short.extend([0, 0, 0]);
        assert_eq!(IdSizes::parse(&short), Err(CodecError::Truncated));
        let mut w = Writer::new();
        for n in [8, 8, 0, 8, 8] {
            w.i32(n);
        }
        assert_eq!(IdSizes::parse(&w.into_vec()), Err(CodecError::BadLength(0)));
    }

    #[test]
    fn counts_every_occurrence() {
        let body = values_body(&[(b'L', 0x11), (b'L', 0x11), (b'I', 5), (b's', 0x22), (b'L', 0)], &S8);
        assert_eq!(object_ids(ReplyIds::Values, &body, &S8), Ok(vec![0x11, 0x11, 0x22]));
    }

    #[test]
    fn tagged_objects_counts_each_entry_and_skips_null() {
        let mut w = Writer::new();
        w.i32(3);
        for id in [9u64, 9, 0] {
            w.u8(b'L');
            w.id(id, 8);
        }
        assert_eq!(object_ids(ReplyIds::TaggedObjects, &w.into_vec(), &S8), Ok(vec![9, 9]));
    }

    #[test]
    fn layouts_reject_trailing_bytes() {
        let mut body = values_body(&[(b'L', 0x11)], &S8);
        body.push(0);
        assert_eq!(object_ids(ReplyIds::Values, &body, &S8), Err(CodecError::BadLength(1)));

        let mut w = Writer::new();
        w.i32(1);
        w.u8(b'L');
        w.id(9, 8);
        w.u8(0);
        assert_eq!(object_ids(ReplyIds::TaggedObjects, &w.into_vec(), &S8), Err(CodecError::BadLength(1)));

        let mut w = Writer::new();
        w.u8(b'I');
        w.i32(1);
        w.id(1, 4);
        w.i32(0);
        assert_eq!(object_ids(ReplyIds::ArrayRegion, &w.into_vec(), &S8), Err(CodecError::BadLength(4)));
    }

    #[test]
    fn tagged_objects_reject_a_primitive_tag() {
        let mut w = Writer::new();
        w.i32(1);
        w.u8(b'I');
        w.id(9, 8);
        assert_eq!(object_ids(ReplyIds::TaggedObjects, &w.into_vec(), &S8), Err(CodecError::BadTag(b'I')));
    }

    #[test]
    fn values_reject_void() {
        let mut w = Writer::new();
        w.i32(1);
        w.u8(b'V');
        assert_eq!(object_ids(ReplyIds::Values, &w.into_vec(), &S8), Err(CodecError::BadTag(b'V')));
    }

    #[test]
    fn object_array_region_rejects_void_and_primitive_elements() {
        for inner in *b"VI" {
            let mut w = Writer::new();
            w.u8(b'[');
            w.i32(1);
            w.u8(inner);
            w.id(1, 4);
            assert_eq!(object_ids(ReplyIds::ArrayRegion, &w.into_vec(), &S8), Err(CodecError::BadTag(inner)));
        }
        let mut w = Writer::new();
        w.u8(b'V');
        w.i32(0);
        assert_eq!(object_ids(ReplyIds::ArrayRegion, &w.into_vec(), &S8), Err(CodecError::BadTag(b'V')));
    }

    #[test]
    fn none_layout_counts_nothing() {
        assert_eq!(object_ids(ReplyIds::None, &[1, 2, 3], &S8), Ok(vec![]));
    }

    #[test]
    fn array_region_of_objects_and_primitives() {
        let mut w = Writer::new();
        w.u8(b'I');
        w.i32(3);
        w.id(1, 4);
        w.id(2, 4);
        w.id(3, 4);
        assert_eq!(object_ids(ReplyIds::ArrayRegion, &w.into_vec(), &S8), Ok(vec![]));

        let mut w = Writer::new();
        w.u8(b'L');
        w.i32(2);
        for _ in 0..2 {
            w.u8(b'L');
            w.id(0xA, 8);
        }
        assert_eq!(object_ids(ReplyIds::ArrayRegion, &w.into_vec(), &S8), Ok(vec![0xA, 0xA]));
    }

    #[test]
    fn array_region_primitive_count_larger_than_body_is_truncated() {
        let mut w = Writer::new();
        w.u8(b'J');
        w.i32(i32::MAX);
        w.id(1, 8);
        assert_eq!(object_ids(ReplyIds::ArrayRegion, &w.into_vec(), &S8), Err(CodecError::Truncated));
    }

    #[test]
    fn truncated_body_is_an_error() {
        let body = values_body(&[(b'L', 0x11), (b'I', 5), (b'L', 0x22)], &S8);
        assert_eq!(object_ids(ReplyIds::Values, &body, &S8), Ok(vec![0x11, 0x22]));
        for cut in 0..body.len() {
            assert_eq!(object_ids(ReplyIds::Values, &body[..cut], &S8), Err(CodecError::Truncated), "cut {cut}");
        }
        let bad = values_body(&[(b'Q', 1)], &S8);
        assert_eq!(object_ids(ReplyIds::Values, &bad, &S8), Err(CodecError::BadTag(b'Q')));
        let negative = (-1i32).to_be_bytes();
        assert_eq!(object_ids(ReplyIds::Values, &negative, &S8), Err(CodecError::BadLength(u32::MAX)));
    }

    #[test]
    fn stop_of_breakpoint_and_vm_death() {
        let event = |policy: u8, kind: u8, thread: Option<u64>| {
            let mut w = Writer::new();
            w.u8(policy);
            w.i32(1);
            w.u8(kind);
            w.i32(42);
            if let Some(t) = thread {
                w.id(t, 8);
            }
            w.into_vec()
        };
        assert_eq!(stop_of(&event(2, 2, Some(0x77)), &S8), Some(Stop { suspend_policy: 2, thread: Some(0x77) }));
        assert_eq!(stop_of(&event(2, 99, None), &S8), Some(Stop { suspend_policy: 2, thread: None }));
        assert_eq!(stop_of(&event(1, 9, None), &S8), Some(Stop { suspend_policy: 1, thread: None }));
        assert_eq!(stop_of(&event(0, 2, Some(0x77)), &S8), Some(Stop { suspend_policy: 0, thread: Some(0x77) }));
        // CLASS_PREPARE from a thread the VM does not expose carries the null thread
        assert_eq!(stop_of(&event(1, 8, Some(0)), &S8), Some(Stop { suspend_policy: 1, thread: None }));
        assert_eq!(stop_of(&event(2, 2, None), &S8), None);
        assert_eq!(stop_of(&[], &S8), None);
    }

    #[test]
    fn stop_of_without_events_is_none() {
        assert_eq!(stop_of(&[2, 0, 0, 0, 0], &S8), None);
    }

    #[test]
    fn dispose_body_layout() {
        let body = dispose_body(&[(5, 2)], &S8);
        assert_eq!(body, [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 2]);
        assert_eq!(dispose_body(&[], &S8), [0, 0, 0, 0]);
    }

    fn any_value() -> impl Strategy<Value = Value> {
        prop_oneof![
            Just(Value::Null),
            (prop::sample::select(b"Lstglc[".to_vec()), 1..=u64::MAX).prop_map(|(tag, id)| Value::Object { tag, id }),
            (prop::sample::select(b"BCFIJSZD".to_vec()), any::<u64>())
                .prop_map(|(tag, raw)| Value::Primitive { tag, raw }),
        ]
    }

    proptest! {
        #[test]
        fn object_ids_match_encoded(values in vec(any_value(), 0..64), object_size in 1u8..=8) {
            let sizes = IdSizes { object: object_size, ..S8 };
            let mask = if object_size == 8 { u64::MAX } else { (1u64 << (object_size * 8)) - 1 };
            let mut w = Writer::new();
            w.i32(values.len() as i32);
            let mut expected = Vec::new();
            for v in &values {
                match *v {
                    Value::Null => {
                        w.u8(b'L');
                        w.id(0, object_size);
                    }
                    Value::Object { tag, id } => {
                        // an id that does not survive the size mask would change identity (or become null)
                        let id = id & mask;
                        w.u8(tag);
                        w.id(id, object_size);
                        if id != 0 {
                            expected.push(id);
                        }
                    }
                    Value::Primitive { tag, raw } => {
                        w.u8(tag);
                        w.id(raw, value_size(tag, &sizes));
                    }
                }
            }
            prop_assert_eq!(object_ids(ReplyIds::Values, &w.into_vec(), &sizes), Ok(expected));
        }

        #[test]
        fn arbitrary_bytes_never_panic(body in vec(any::<u8>(), 0..128), object_size in 0u8..=12) {
            let sizes = IdSizes { object: object_size, ..S8 };
            for layout in [ReplyIds::None, ReplyIds::TaggedObjects, ReplyIds::Values, ReplyIds::ArrayRegion] {
                let _ = object_ids(layout, &body, &sizes);
            }
            let _ = stop_of(&body, &sizes);
            let _ = IdSizes::parse(&body);
        }
    }
}
