//! File content uses the document's encoding; Git metadata remains UTF-8.
use encoding_rs::{Encoding, UTF_8, UTF_16BE, UTF_16LE};
use ide_core::{IdeError, IdeResult};
use std::borrow::Cow;

pub(crate) fn has_bom(bytes: &[u8], encoding: &'static Encoding) -> bool {
    Encoding::for_bom(bytes).is_some_and(|(enc, _)| enc == encoding)
}

pub(crate) fn decode<'a>(bytes: &'a [u8], encoding: &'static Encoding) -> Cow<'a, str> {
    let body = match Encoding::for_bom(bytes) {
        Some((enc, len)) if enc == encoding => &bytes[len..],
        _ => bytes,
    };
    encoding.decode_without_bom_handling(body).0
}

pub(crate) fn is_binary(bytes: &[u8], encoding: &'static Encoding) -> bool {
    encoding != UTF_16LE && encoding != UTF_16BE && bytes.contains(&0)
}

pub(crate) fn encode(text: &str, encoding: &'static Encoding, bom: bool) -> IdeResult<Vec<u8>> {
    let mut out = Vec::new();
    if encoding == UTF_16LE || encoding == UTF_16BE {
        let le = encoding == UTF_16LE;
        if bom {
            out.extend_from_slice(if le { &[0xff, 0xfe] } else { &[0xfe, 0xff] });
        }
        for unit in text.encode_utf16() {
            out.extend_from_slice(&if le { unit.to_le_bytes() } else { unit.to_be_bytes() });
        }
    } else {
        let (bytes, _, errors) = encoding.encode(text);
        if errors {
            return Err(IdeError::invalid(format!(
                "text contains characters not representable in {}",
                encoding.name()
            )));
        }
        if bom && encoding == UTF_8 {
            out.extend_from_slice(&[0xef, 0xbb, 0xbf]);
        }
        out.extend_from_slice(&bytes);
    }
    Ok(out)
}
