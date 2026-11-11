//! Request bodies and reply parsers for the JDWP commands the inspector uses. A reply that does
//! not parse exactly is an error, never a guess.

use crate::codec::{CodecError, Reader, Value, Writer, is_object_tag};
use crate::ids::IdSizes;
use ide_jvm_inspect::InspectError;

/// `FieldModifier.STATIC`.
const STATIC: i32 = 0x0008;

pub(super) struct FieldInfo {
    pub(super) id: u64,
    pub(super) name: String,
    pub(super) is_static: bool,
}

pub(super) fn malformed(e: CodecError) -> InspectError {
    InspectError::Failed(format!("malformed JDWP reply: {e}"))
}

/// Runs `read` over `body` and requires that it consumes all of it.
fn parse<T>(body: &[u8], read: impl FnOnce(&mut Reader<'_>) -> Result<T, CodecError>) -> Result<T, InspectError> {
    let mut r = Reader::new(body);
    let out = read(&mut r).map_err(malformed)?;
    match r.remaining() {
        0 => Ok(out),
        extra => Err(InspectError::Failed(format!("malformed JDWP reply: {extra} bytes too many"))),
    }
}

pub(super) fn id_body(id: u64, size: u8) -> Vec<u8> {
    let mut w = Writer::new();
    w.id(id, size);
    w.into_vec()
}

/// An id followed by `int`s: `Instances`, `ReferringObjects`, `ArrayReference.GetValues`.
pub(super) fn id_ints_body(id: u64, size: u8, ints: &[u32]) -> Vec<u8> {
    let mut w = Writer::new();
    w.id(id, size);
    for &n in ints {
        w.i32(n as i32);
    }
    w.into_vec()
}

pub(super) fn signature_body(signature: &str) -> Vec<u8> {
    let mut w = Writer::new();
    w.string(signature);
    w.into_vec()
}

/// `ObjectReference.GetValues`: the object, then the fields to read.
pub(super) fn get_values_body(object: u64, fields: &[u64], sizes: &IdSizes) -> Vec<u8> {
    let mut w = Writer::new();
    w.id(object, sizes.object);
    w.i32(fields.len() as i32);
    for &field in fields {
        w.id(field, sizes.field);
    }
    w.into_vec()
}

pub(super) fn instance_counts_body(classes: &[u64], sizes: &IdSizes) -> Vec<u8> {
    let mut w = Writer::new();
    w.i32(classes.len() as i32);
    for &class in classes {
        w.id(class, sizes.reference_type);
    }
    w.into_vec()
}

/// `ObjectReference.ReferenceType`: the class of the object.
pub(super) fn reference_type(body: &[u8], sizes: &IdSizes) -> Result<u64, InspectError> {
    parse(body, |r| {
        r.u8()?;
        r.id(sizes.reference_type)
    })
}

pub(super) fn string(body: &[u8]) -> Result<String, InspectError> {
    parse(body, |r| r.string())
}

pub(super) fn length(body: &[u8]) -> Result<u32, InspectError> {
    parse(body, |r| {
        let n = r.i32()?;
        u32::try_from(n).map_err(|_| CodecError::BadLength(n as u32))
    })
}

/// `ClassType.Superclass`; 0 when there is none.
pub(super) fn superclass(body: &[u8], sizes: &IdSizes) -> Result<u64, InspectError> {
    parse(body, |r| r.id(sizes.reference_type))
}

pub(super) fn fields(body: &[u8], sizes: &IdSizes) -> Result<Vec<FieldInfo>, InspectError> {
    parse(body, |r| {
        let mut out = Vec::new();
        for _ in 0..r.count()? {
            let id = r.id(sizes.field)?;
            let name = r.string()?;
            r.string()?;
            out.push(FieldInfo { id, name, is_static: r.i32()? & STATIC != 0 });
        }
        Ok(out)
    })
}

/// `GetValues`: `int n; (tag, value)*`.
pub(super) fn values(body: &[u8], sizes: &IdSizes) -> Result<Vec<Value>, InspectError> {
    parse(body, |r| {
        let mut out = Vec::new();
        for _ in 0..r.count()? {
            out.push(r.tagged_value(sizes)?);
        }
        Ok(out)
    })
}

/// `ArrayReference.GetValues`: the element tag, a count, then untagged primitives or tagged objects.
pub(super) fn array_region(body: &[u8], sizes: &IdSizes) -> Result<Vec<Value>, InspectError> {
    parse(body, |r| {
        let tag = r.u8()?;
        let mut out = Vec::new();
        for _ in 0..r.count()? {
            out.push(if is_object_tag(tag) { r.tagged_value(sizes)? } else { r.value(tag, sizes)? });
        }
        Ok(out)
    })
}

/// `ClassesBySignature`: the class ids.
pub(super) fn classes_by_signature(body: &[u8], sizes: &IdSizes) -> Result<Vec<u64>, InspectError> {
    parse(body, |r| {
        let mut out = Vec::new();
        for _ in 0..r.count()? {
            r.u8()?;
            out.push(r.id(sizes.reference_type)?);
            r.i32()?;
        }
        Ok(out)
    })
}

/// `AllClasses`: class id and signature.
pub(super) fn all_classes(body: &[u8], sizes: &IdSizes) -> Result<Vec<(u64, String)>, InspectError> {
    parse(body, |r| {
        let mut out = Vec::new();
        for _ in 0..r.count()? {
            r.u8()?;
            let id = r.id(sizes.reference_type)?;
            let signature = r.string()?;
            r.i32()?;
            out.push((id, signature));
        }
        Ok(out)
    })
}

/// `Instances` and `ReferringObjects`: `int n; (tag, objectID)*`.
pub(super) fn tagged_objects(body: &[u8], sizes: &IdSizes) -> Result<Vec<u64>, InspectError> {
    parse(body, |r| {
        let mut out = Vec::new();
        for _ in 0..r.count()? {
            r.u8()?;
            out.push(r.id(sizes.object)?);
        }
        Ok(out)
    })
}

pub(super) fn instance_counts(body: &[u8]) -> Result<Vec<u64>, InspectError> {
    parse(body, |r| {
        let mut out = Vec::new();
        for _ in 0..r.count()? {
            let n = r.i64()?;
            out.push(u64::try_from(n).map_err(|_| CodecError::BadLength(n as u32))?);
        }
        Ok(out)
    })
}
