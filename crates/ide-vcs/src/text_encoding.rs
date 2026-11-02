//! File content uses the document's encoding; Git metadata remains UTF-8.
use encoding_rs::{Encoding, UTF_8, UTF_16BE, UTF_16LE};
use ide_core::{IdeError, IdeResult};
use std::borrow::Cow;

/// File charset plus an optional ASCII representation (for properties).
/// The host supplies conversion functions so Git and documents share one codec.
#[derive(Clone, Copy)]
pub struct TextEncoding {
    pub charset: &'static Encoding,
    ascii_conversion: Option<AsciiConversion>,
}

#[derive(Clone, Copy)]
struct AsciiConversion {
    decode: fn(&str) -> String,
    encode: fn(&str) -> String,
}

impl From<&'static Encoding> for TextEncoding {
    fn from(charset: &'static Encoding) -> Self {
        Self { charset, ascii_conversion: None }
    }
}

impl TextEncoding {
    pub(crate) fn display_text(self, text: &str) -> String {
        match self.ascii_conversion {
            Some(conversion) => (conversion.decode)(text),
            None => text.to_owned(),
        }
    }

    pub(crate) fn has_ascii_conversion(self) -> bool {
        self.ascii_conversion.is_some()
    }

    pub fn with_ascii_conversion(mut self, decode: fn(&str) -> String, encode: fn(&str) -> String) -> Self {
        self.ascii_conversion = Some(AsciiConversion { decode, encode });
        self
    }
}

pub(crate) fn has_bom(bytes: &[u8], encoding: TextEncoding) -> bool {
    Encoding::for_bom(bytes).is_some_and(|(enc, _)| enc == encoding.charset)
}

pub(crate) fn decode_raw<'a>(bytes: &'a [u8], encoding: TextEncoding) -> Cow<'a, str> {
    let body = match Encoding::for_bom(bytes) {
        Some((enc, len)) if enc == encoding.charset => &bytes[len..],
        _ => bytes,
    };
    if encoding.ascii_conversion.is_some() && body.is_ascii() {
        Cow::Borrowed(std::str::from_utf8(body).expect("ASCII"))
    } else {
        encoding.charset.decode_without_bom_handling(body).0
    }
}

pub(crate) fn decode<'a>(bytes: &'a [u8], encoding: TextEncoding) -> Cow<'a, str> {
    let text = decode_raw(bytes, encoding);
    match encoding.ascii_conversion {
        Some(conversion) => Cow::Owned((conversion.decode)(&text)),
        None => text,
    }
}

pub(crate) fn is_binary(bytes: &[u8], encoding: TextEncoding) -> bool {
    encoding.charset != UTF_16LE && encoding.charset != UTF_16BE && bytes.contains(&0)
}

pub(crate) fn encode(text: &str, encoding: TextEncoding, bom: bool) -> IdeResult<Vec<u8>> {
    if let Some(conversion) = encoding.ascii_conversion {
        return Ok((conversion.encode)(text).into_bytes());
    }
    let encoding = encoding.charset;
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
