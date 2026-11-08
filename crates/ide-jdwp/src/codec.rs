use crate::ids::IdSizes;

pub const HEADER_LEN: usize = 11;
pub const FLAG_REPLY: u8 = 0x80;
/// Largest packet the debugger accepts from the adapter side.
pub const MAX_ADAPTER_PACKET: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CodecError {
    #[error("packet is shorter than its contents require")]
    Truncated,
    #[error("unknown value tag {0:#04x}")]
    BadTag(u8),
    #[error("invalid length or size {0}")]
    BadLength(u32),
}

/// JDWP packet header. `a`/`b` are (command set, command) in a command and the big-endian
/// error code in a reply.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    pub length: u32,
    pub id: u32,
    pub flags: u8,
    pub a: u8,
    pub b: u8,
}

impl Header {
    pub fn parse(bytes: &[u8; HEADER_LEN]) -> Header {
        Header {
            length: u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
            id: u32::from_be_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]),
            flags: bytes[8],
            a: bytes[9],
            b: bytes[10],
        }
    }

    pub fn is_reply(&self) -> bool {
        self.flags & FLAG_REPLY != 0
    }

    pub fn command(&self) -> (u8, u8) {
        (self.a, self.b)
    }

    pub fn error(&self) -> u16 {
        u16::from_be_bytes([self.a, self.b])
    }

    pub fn command_bytes(id: u32, set: u8, cmd: u8, body_len: usize) -> [u8; HEADER_LEN] {
        let length = (HEADER_LEN + body_len) as u32;
        let mut out = [0u8; HEADER_LEN];
        out[0..4].copy_from_slice(&length.to_be_bytes());
        out[4..8].copy_from_slice(&id.to_be_bytes());
        out[9] = set;
        out[10] = cmd;
        out
    }
}

/// A decoded JDWP value. A null object reference is `Null` whatever its tag was.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Value {
    Null,
    Primitive { tag: u8, raw: u64 },
    Object { tag: u8, id: u64 },
}

pub fn is_object_tag(tag: u8) -> bool {
    matches!(tag, b'L' | b's' | b't' | b'g' | b'l' | b'c' | b'[')
}

/// Byte width of a primitive value, `None` for an object or unknown tag.
pub(crate) fn primitive_size(tag: u8) -> Option<u8> {
    match tag {
        b'B' | b'Z' => Some(1),
        b'C' | b'S' => Some(2),
        b'F' | b'I' => Some(4),
        b'J' | b'D' => Some(8),
        _ => None,
    }
}

/// Text of a primitive the way Java prints it.
pub fn primitive_text(tag: u8, raw: u64) -> String {
    match tag {
        b'Z' => (raw != 0).to_string(),
        b'B' => (raw as u8 as i8).to_string(),
        b'C' => char::from_u32(u32::from(raw as u16)).unwrap_or('\u{FFFD}').to_string(),
        b'S' => (raw as u16 as i16).to_string(),
        b'I' => (raw as u32 as i32).to_string(),
        b'J' => (raw as i64).to_string(),
        b'F' => java_float(f32::from_bits(raw as u32).into(), format!("{:?}", f32::from_bits(raw as u32))),
        b'D' => java_float(f64::from_bits(raw), format!("{:?}", f64::from_bits(raw))),
        b'V' => "void".to_string(),
        _ => String::new(),
    }
}

/// `rust_debug` is Rust's `{:?}` of the same number, which already keeps a `.0` on integral
/// values; only NaN/infinity spelling and the exponent form differ from Java.
fn java_float(value: f64, rust_debug: String) -> String {
    if value.is_nan() {
        return "NaN".to_string();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }
    match rust_debug.split_once('e') {
        Some((mantissa, exp)) if mantissa.contains('.') => format!("{mantissa}E{exp}"),
        Some((mantissa, exp)) => format!("{mantissa}.0E{exp}"),
        None => rust_debug,
    }
}

/// Bounds-checked cursor over a packet body.
pub struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Reader { bytes, pos: 0 }
    }

    pub fn remaining(&self) -> usize {
        self.bytes.len() - self.pos
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], CodecError> {
        if n > self.remaining() {
            return Err(CodecError::Truncated);
        }
        let out = &self.bytes[self.pos..self.pos + n];
        self.pos += n;
        Ok(out)
    }

    pub fn skip(&mut self, n: usize) -> Result<(), CodecError> {
        self.take(n).map(|_| ())
    }

    pub fn u8(&mut self) -> Result<u8, CodecError> {
        Ok(self.take(1)?[0])
    }

    pub fn i32(&mut self) -> Result<i32, CodecError> {
        let b = self.take(4)?;
        Ok(i32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }

    pub fn i64(&mut self) -> Result<i64, CodecError> {
        let b = self.take(8)?;
        Ok(i64::from_be_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]))
    }

    /// An `int` element count; a negative one is malformed.
    pub fn count(&mut self) -> Result<usize, CodecError> {
        let n = self.i32()?;
        usize::try_from(n).map_err(|_| CodecError::BadLength(n as u32))
    }

    /// A big-endian unsigned id of `size` bytes (1..=8).
    pub fn id(&mut self, size: u8) -> Result<u64, CodecError> {
        if !(1..=8).contains(&size) {
            return Err(CodecError::BadLength(u32::from(size)));
        }
        Ok(self.take(usize::from(size))?.iter().fold(0u64, |acc, &b| (acc << 8) | u64::from(b)))
    }

    pub fn string(&mut self) -> Result<String, CodecError> {
        let n = self.i32()? as u32 as usize;
        Ok(String::from_utf8_lossy(self.take(n)?).into_owned())
    }

    /// The untagged value of type `tag`.
    pub fn value(&mut self, tag: u8, sizes: &IdSizes) -> Result<Value, CodecError> {
        if let Some(size) = primitive_size(tag) {
            return Ok(Value::Primitive { tag, raw: self.id(size)? });
        }
        if tag == b'V' {
            return Ok(Value::Primitive { tag, raw: 0 });
        }
        if is_object_tag(tag) {
            return Ok(match self.id(sizes.object)? {
                0 => Value::Null,
                id => Value::Object { tag, id },
            });
        }
        Err(CodecError::BadTag(tag))
    }

    /// A tag byte followed by the value it names.
    pub fn tagged_value(&mut self, sizes: &IdSizes) -> Result<Value, CodecError> {
        let tag = self.u8()?;
        self.value(tag, sizes)
    }
}

#[derive(Debug, Default)]
pub struct Writer {
    bytes: Vec<u8>,
}

impl Writer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn u8(&mut self, v: u8) {
        self.bytes.push(v);
    }

    pub fn i32(&mut self, v: i32) {
        self.bytes.extend_from_slice(&v.to_be_bytes());
    }

    pub fn i64(&mut self, v: i64) {
        self.bytes.extend_from_slice(&v.to_be_bytes());
    }

    /// The low `size` bytes of `v`, big-endian.
    pub fn id(&mut self, v: u64, size: u8) {
        for i in (0..u32::from(size)).rev() {
            self.bytes.push(v.checked_shr(8 * i).unwrap_or(0) as u8);
        }
    }

    pub fn string(&mut self, s: &str) {
        self.bytes.extend_from_slice(&(s.len() as u32).to_be_bytes());
        self.bytes.extend_from_slice(s.as_bytes());
    }

    pub fn into_vec(self) -> Vec<u8> {
        self.bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_round_trip() {
        let bytes = Header::command_bytes(0x7000_0001, 1, 21, 4);
        let h = Header::parse(&bytes);
        assert_eq!(h.id, 0x7000_0001);
        assert_eq!(h.command(), (1, 21));
        assert_eq!(h.length, 15);
        assert!(!h.is_reply());
    }

    #[test]
    fn reply_header_carries_error_code() {
        let h = Header::parse(&[0, 0, 0, 11, 0, 0, 0, 7, FLAG_REPLY, 0, 20]);
        assert!(h.is_reply());
        assert_eq!(h.error(), 20);
    }

    #[test]
    fn primitive_texts() {
        assert_eq!(primitive_text(b'Z', 1), "true");
        assert_eq!(primitive_text(b'Z', 0), "false");
        assert_eq!(primitive_text(b'C', 'a' as u64), "a");
        assert_eq!(primitive_text(b'I', u64::from(u32::MAX)), "-1");
        assert_eq!(primitive_text(b'B', 0xff), "-1");
        assert_eq!(primitive_text(b'S', 0xfffe), "-2");
        assert_eq!(primitive_text(b'J', u64::MAX - 4), "-5");
        assert_eq!(primitive_text(b'D', 1.5f64.to_bits()), "1.5");
        assert_eq!(primitive_text(b'D', 2.0f64.to_bits()), "2.0");
        assert_eq!(primitive_text(b'F', 1.5f32.to_bits().into()), "1.5");
        assert_eq!(primitive_text(b'D', f64::NAN.to_bits()), "NaN");
        assert_eq!(primitive_text(b'D', f64::NEG_INFINITY.to_bits()), "-Infinity");
        assert_eq!(primitive_text(b'F', f32::INFINITY.to_bits().into()), "Infinity");
    }

    #[test]
    fn object_tags() {
        for t in *b"Lstglc[" {
            assert!(is_object_tag(t));
        }
        for t in *b"BCFIJSZDV" {
            assert!(!is_object_tag(t));
        }
    }

    #[test]
    fn reader_rejects_truncation_and_bad_lengths() {
        assert_eq!(Reader::new(&[]).u8(), Err(CodecError::Truncated));
        assert_eq!(Reader::new(&[0, 0, 1]).i32(), Err(CodecError::Truncated));
        assert_eq!(Reader::new(&[0; 7]).i64(), Err(CodecError::Truncated));
        assert_eq!(Reader::new(&[0; 8]).id(0), Err(CodecError::BadLength(0)));
        assert_eq!(Reader::new(&[0; 16]).id(9), Err(CodecError::BadLength(9)));
        assert_eq!(Reader::new(&[0; 3]).id(4), Err(CodecError::Truncated));
        // length prefix larger than the bytes that follow
        assert_eq!(Reader::new(&[0, 0, 0, 9, b'a']).string(), Err(CodecError::Truncated));
        assert_eq!(Reader::new(&[0xff, 0xff, 0xff, 0xff]).string(), Err(CodecError::Truncated));
    }

    #[test]
    fn writer_reader_round_trip() {
        let mut w = Writer::new();
        w.u8(7);
        w.i32(-3);
        w.i64(1 << 40);
        w.id(0xABCD, 2);
        w.string("héllo");
        let bytes = w.into_vec();
        let mut r = Reader::new(&bytes);
        assert_eq!(r.u8(), Ok(7));
        assert_eq!(r.i32(), Ok(-3));
        assert_eq!(r.i64(), Ok(1 << 40));
        assert_eq!(r.id(2), Ok(0xABCD));
        assert_eq!(r.string().as_deref(), Ok("héllo"));
        assert_eq!(r.remaining(), 0);
    }
}
