//! Text of `java.lang.String` objects.

use crate::hprof::{BasicType, HeapRecord};
use crate::index::{HeapIndex, id_value, instance_fields};

const STRING: &str = "java.lang.String";
const LATIN1: u8 = 0;
const UTF16: u8 = 1;

/// The text of String `object`, cut to `max_chars` chars plus `…`. `None` for anything that is
/// not a String, or one whose `value` / `coder` the dump does not hold as expected.
///
/// JDK 9+ keeps a `byte[]` and a `coder`; UTF-16 bytes are in the JVM's native order, which
/// hprof copies as is, read here as little-endian (x86-64, AArch64; a big-endian JVM's text would
/// come out garbled). JDK 8 keeps a `char[]`, whose elements hprof writes big-endian.
pub(crate) fn string_preview(index: &HeapIndex, object: u32, max_chars: usize) -> Option<String> {
    let slot = *index.types.get(object as usize)?;
    if index.class_info.get(slot as usize)?.name != STRING {
        return None;
    }
    let Some(HeapRecord::Instance { data, .. }) = index.record(object) else { return None };
    let fields = instance_fields(index, slot, data);
    let value = fields.iter().find(|f| f.name == "value" && f.ty == BasicType::Object)?;
    let array = index.ids.rank(id_value(value.bytes).filter(|&id| id != 0)?)?;
    let coder = fields.iter().find(|f| f.name == "coder" && f.ty == BasicType::Byte).and_then(|f| f.bytes.first());
    let Some(HeapRecord::PrimitiveArray { ty, data, .. }) = index.record(array) else { return None };
    match (ty, coder) {
        (BasicType::Byte, Some(&LATIN1)) => Some(cut(data.iter().map(|&b| char::from(b)), max_chars)),
        (BasicType::Byte, Some(&UTF16)) => utf16(data, u16::from_le_bytes, max_chars),
        (BasicType::Char, _) => utf16(data, u16::from_be_bytes, max_chars),
        _ => None,
    }
}

/// The text of `char[]` `object`, as [`string_preview`] cuts it.
pub(crate) fn char_array_text(index: &HeapIndex, object: u32, max_chars: usize) -> Option<String> {
    match index.record(object)? {
        HeapRecord::PrimitiveArray { ty: BasicType::Char, data, .. } => utf16(data, u16::from_be_bytes, max_chars),
        _ => None,
    }
}

/// An odd byte count is `None`; a lone surrogate becomes U+FFFD.
fn utf16(bytes: &[u8], unit: fn([u8; 2]) -> u16, max_chars: usize) -> Option<String> {
    if !bytes.len().is_multiple_of(2) {
        return None;
    }
    let units = bytes.chunks_exact(2).map(|pair| unit([pair[0], pair[1]]));
    Some(cut(char::decode_utf16(units).map(|c| c.unwrap_or(char::REPLACEMENT_CHARACTER)), max_chars))
}

/// Chars are whole code points, so a cut never splits a surrogate pair.
fn cut(chars: impl Iterator<Item = char>, max_chars: usize) -> String {
    let mut out = String::new();
    for (i, c) in chars.enumerate() {
        if i == max_chars {
            out.push('…');
            break;
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests;
