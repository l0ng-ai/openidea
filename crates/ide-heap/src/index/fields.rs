//! Named field values of an instance record.

use super::HeapIndex;
use crate::hprof::BasicType;

pub(crate) struct FieldValue<'a> {
    pub(crate) name: &'a str,
    pub(crate) ty: BasicType,
    /// Big-endian, as in the dump.
    pub(crate) bytes: &'a [u8],
    /// `java.lang.ref.Reference.referent`, which the graph leaves out.
    pub(crate) weak: bool,
}

/// The fields of an instance of class slot `class` whose record holds `data`: the class's own,
/// then each superclass's, as HotSpot lays them out. Stops where `data` ends.
pub(crate) fn instance_fields<'a>(index: &'a HeapIndex, class: u32, data: &'a [u8]) -> Vec<FieldValue<'a>> {
    let mut out = Vec::new();
    let mut base = 0usize;
    let mut cursor = Some(class);
    // Super chains end (their cycles are cut), so this is only a bound on corrupt input.
    for _ in 0..index.class_info.len() {
        let Some(info) = cursor.and_then(|c| index.class_info.get(c as usize)) else { break };
        for (k, (name, ty)) in info.fields.iter().enumerate() {
            let size = ty.hprof_size(index.id_size);
            let Some(bytes) = base.checked_add(size).and_then(|end| data.get(base..end)) else { return out };
            out.push(FieldValue { name, ty: *ty, bytes, weak: info.weak_field == Some(k) });
            base += size;
        }
        cursor = info.super_index;
    }
    out
}

/// A 4- or 8-byte big-endian id.
pub(crate) fn id_value(bytes: &[u8]) -> Option<u64> {
    match *bytes {
        [a, b, c, d] => Some(u64::from(u32::from_be_bytes([a, b, c, d]))),
        _ => Some(u64::from_be_bytes(bytes.try_into().ok()?)),
    }
}
