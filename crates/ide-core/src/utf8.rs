//! Incremental UTF-8 decoding for byte streams that may split code points
//! across reads.

/// Decodes a byte stream chunk by chunk. Incomplete trailing sequences are held
/// back until the next chunk; invalid bytes become U+FFFD.
#[derive(Debug, Default)]
pub struct Utf8Decoder {
    pending: Vec<u8>,
}

impl Utf8Decoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Decodes `bytes`, appending the complete text to `out`.
    pub fn decode_into(&mut self, bytes: &[u8], out: &mut String) {
        let owned;
        let mut input: &[u8] = if self.pending.is_empty() {
            bytes
        } else {
            self.pending.extend_from_slice(bytes);
            owned = std::mem::take(&mut self.pending);
            &owned
        };
        loop {
            match std::str::from_utf8(input) {
                Ok(s) => {
                    out.push_str(s);
                    return;
                }
                Err(e) => {
                    let (valid, rest) = input.split_at(e.valid_up_to());
                    // `valid` is UTF-8 by construction.
                    out.push_str(std::str::from_utf8(valid).unwrap_or_default());
                    match e.error_len() {
                        Some(len) => {
                            out.push(char::REPLACEMENT_CHARACTER);
                            input = &rest[len..];
                        }
                        None => {
                            self.pending.extend_from_slice(rest);
                            return;
                        }
                    }
                }
            }
        }
    }

    #[cfg(test)]
    /// Convenience wrapper around [`Self::decode_into`].
    pub fn decode(&mut self, bytes: &[u8]) -> String {
        let mut out = String::new();
        self.decode_into(bytes, &mut out);
        out
    }

    /// Flushes held-back bytes at end of stream (a truncated sequence → U+FFFD).
    pub fn finish(&mut self) -> String {
        if self.pending.is_empty() {
            String::new()
        } else {
            self.pending.clear();
            char::REPLACEMENT_CHARACTER.to_string()
        }
    }

    #[cfg(test)]
    pub fn has_pending(&self) -> bool {
        !self.pending.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_passthrough() {
        let mut d = Utf8Decoder::new();
        assert_eq!(d.decode(b"hello"), "hello");
        assert_eq!(d.finish(), "");
    }

    #[test]
    fn multibyte_split_at_every_position() {
        let text = "aé中😀z";
        let bytes = text.as_bytes();
        for split in 0..=bytes.len() {
            let mut d = Utf8Decoder::new();
            let mut out = d.decode(&bytes[..split]);
            out.push_str(&d.decode(&bytes[split..]));
            out.push_str(&d.finish());
            assert_eq!(out, text, "split at {split}");
        }
    }

    #[test]
    fn byte_by_byte() {
        let text = "😀中é";
        let mut d = Utf8Decoder::new();
        let mut out = String::new();
        for b in text.as_bytes() {
            d.decode_into(std::slice::from_ref(b), &mut out);
        }
        assert!(!d.has_pending());
        assert_eq!(out, text);
    }

    #[test]
    fn invalid_bytes_are_replaced() {
        let mut d = Utf8Decoder::new();
        assert_eq!(d.decode(b"a\xffb\xc3(c"), "a\u{FFFD}b\u{FFFD}(c");
    }

    #[test]
    fn truncated_sequence_at_end_of_stream() {
        let mut d = Utf8Decoder::new();
        assert_eq!(d.decode(b"ok\xe4\xb8"), "ok");
        assert!(d.has_pending());
        assert_eq!(d.finish(), "\u{FFFD}");
        assert_eq!(d.decode(b"x"), "x");
    }

    #[test]
    fn invalid_continuation_after_pending() {
        let mut d = Utf8Decoder::new();
        assert_eq!(d.decode(b"\xe4"), "");
        assert_eq!(d.decode(b"A"), "\u{FFFD}A");
    }
}
