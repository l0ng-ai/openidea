//! [`decode_text`](crate::decode_text) for files too large to hold: the same
//! decisions, taken while reading a chunk at a time.

use crate::encoding::{SNIFF_LEN, sniff_utf16};
use encoding_rs::{Decoder, Encoding, UTF_8, UTF_16BE, UTF_16LE};
use std::io::{self, Read};

/// Raw bytes read per step; a step holds this plus its UTF-8 expansion (at most 3x).
const CHUNK: usize = 64 * 1024;

/// The text of a file as UTF-8 bytes, decoded as it is read.
pub struct DecodedReader<R> {
    reader: R,
    decoder: Decoder,
    raw: Vec<u8>,
    /// Decoded bytes of the last step; `out[pos..len]` is unread.
    out: Vec<u8>,
    pos: usize,
    len: usize,
    done: bool,
}

/// Decodes the file `open` reads like [`decode_text`](crate::decode_text) does (BOM, UTF-8 and
/// UTF-16 as detected, other text as `fallback` or else the detected encoding) without holding
/// it: `None` for binary content, else a reader of the text as UTF-8.
///
/// Deciding the encoding of text that is neither BOM-marked nor UTF-8 needs a pass over the whole
/// file before the decoding pass, so `open` gives a fresh reader of the file up to twice.
pub fn decode_stream<R: Read>(
    open: impl FnMut() -> io::Result<R>,
    fallback: Option<&str>,
) -> io::Result<Option<DecodedReader<R>>> {
    decode_stream_in(open, fallback, CHUNK)
}

fn decode_stream_in<R: Read>(
    mut open: impl FnMut() -> io::Result<R>,
    fallback: Option<&str>,
    chunk: usize,
) -> io::Result<Option<DecodedReader<R>>> {
    let Some((detected, bom_len, has_bom)) = detect(&mut open, chunk)? else { return Ok(None) };
    let fallback = fallback.and_then(|label| Encoding::for_label(label.trim().as_bytes()));
    let encoding = match fallback {
        Some(enc)
            if !has_bom && enc != detected && detected != UTF_8 && detected != UTF_16LE && detected != UTF_16BE =>
        {
            enc
        }
        _ => detected,
    };
    let mut reader = open()?;
    io::copy(&mut (&mut reader).take(bom_len as u64), &mut io::sink())?;
    let decoder = encoding.new_decoder_without_bom_handling();
    let out = vec![0; decoder.max_utf8_buffer_length(chunk).unwrap_or(chunk * 3)];
    Ok(Some(DecodedReader { reader, decoder, raw: vec![0; chunk], out, pos: 0, len: 0, done: false }))
}

/// The encoding [`decode`](crate::encoding::decode) finds for the file, its BOM length and
/// whether it has a BOM; `None` for binary content.
fn detect<R: Read>(
    open: &mut impl FnMut() -> io::Result<R>,
    chunk: usize,
) -> io::Result<Option<(&'static Encoding, usize, bool)>> {
    let mut reader = open()?;
    let mut head = vec![0; SNIFF_LEN];
    let n = read_full(&mut reader, &mut head)?;
    head.truncate(n);
    if let Some((enc, bom_len)) = Encoding::for_bom(&head) {
        return Ok(Some((enc, bom_len, true)));
    }
    if head.contains(&0) {
        return Ok(sniff_utf16(&head).map(|enc| (enc, 0, false)));
    }
    let mut detector = chardetng::EncodingDetector::new();
    let mut utf8 = Utf8Check::default();
    detector.feed(&head, false);
    utf8.feed(&head);
    if n == SNIFF_LEN {
        let mut buf = vec![0; chunk];
        loop {
            let n = read_retry(&mut reader, &mut buf)?;
            if n == 0 {
                break;
            }
            detector.feed(&buf[..n], false);
            utf8.feed(&buf[..n]);
        }
    }
    detector.feed(&[], true);
    let encoding = if utf8.is_valid() { UTF_8 } else { detector.guess(None, true) };
    Ok(Some((encoding, 0, false)))
}

/// Reads until `buf` is full or the reader ends.
fn read_full(reader: &mut impl Read, buf: &mut [u8]) -> io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match read_retry(reader, &mut buf[filled..])? {
            0 => break,
            n => filled += n,
        }
    }
    Ok(filled)
}

fn read_retry(reader: &mut impl Read, buf: &mut [u8]) -> io::Result<usize> {
    loop {
        match reader.read(buf) {
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            result => return result,
        }
    }
}

/// Checks that bytes fed in pieces form valid UTF-8, as `std::str::from_utf8` does for the whole.
#[derive(Default)]
struct Utf8Check {
    /// The start of a character cut by the end of the previous piece.
    tail: Vec<u8>,
    invalid: bool,
}

impl Utf8Check {
    fn feed(&mut self, mut bytes: &[u8]) {
        if self.invalid {
            return;
        }
        while !self.tail.is_empty() && !bytes.is_empty() {
            self.tail.push(bytes[0]);
            bytes = &bytes[1..];
            match std::str::from_utf8(&self.tail) {
                Ok(_) => self.tail.clear(),
                Err(e) if e.error_len().is_none() => {}
                Err(_) => {
                    self.invalid = true;
                    return;
                }
            }
        }
        if !self.tail.is_empty() {
            return;
        }
        match std::str::from_utf8(bytes) {
            Ok(_) => {}
            Err(e) if e.error_len().is_none() => self.tail.extend_from_slice(&bytes[e.valid_up_to()..]),
            Err(_) => self.invalid = true,
        }
    }

    /// Whether everything fed so far was UTF-8 (a truncated final character is not).
    fn is_valid(&self) -> bool {
        !self.invalid && self.tail.is_empty()
    }
}

impl<R: Read> Read for DecodedReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        while self.pos == self.len {
            if self.done {
                return Ok(0);
            }
            let n = read_retry(&mut self.reader, &mut self.raw)?;
            let last = n == 0;
            let needed = self.decoder.max_utf8_buffer_length(n).unwrap_or(n * 3 + 16);
            if self.out.len() < needed {
                self.out.resize(needed, 0);
            }
            // Malformed input becomes U+FFFD, as in `decode_without_bom_handling`.
            let (_, _, written, _) = self.decoder.decode_to_utf8(&self.raw[..n], &mut self.out, last);
            self.pos = 0;
            self.len = written;
            self.done = last;
        }
        let n = buf.len().min(self.len - self.pos);
        buf[..n].copy_from_slice(&self.out[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decode_text;

    /// Hands out at most `step` bytes per read, so chunk edges fall everywhere.
    struct Trickle<'a> {
        bytes: &'a [u8],
        step: usize,
    }

    impl Read for Trickle<'_> {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let n = buf.len().min(self.step).min(self.bytes.len());
            buf[..n].copy_from_slice(&self.bytes[..n]);
            self.bytes = &self.bytes[n..];
            Ok(n)
        }
    }

    fn streamed(bytes: &[u8], fallback: Option<&str>, chunk: usize, step: usize) -> Option<Vec<u8>> {
        let reader = decode_stream_in(|| Ok(Trickle { bytes, step }), fallback, chunk).unwrap()?;
        let mut out = Vec::new();
        let mut reader = reader;
        // Small reads too: the consumer's buffer is not the chunk either.
        let mut buf = [0; 7];
        loop {
            let n = reader.read(&mut buf).unwrap();
            if n == 0 {
                return Some(out);
            }
            out.extend_from_slice(&buf[..n]);
        }
    }

    fn utf16(text: &str, bom: bool, big: bool) -> Vec<u8> {
        let mut bytes =
            if bom { vec![if big { 0xFE } else { 0xFF }, if big { 0xFF } else { 0xFE }] } else { Vec::new() };
        for unit in text.encode_utf16() {
            bytes.extend(if big { unit.to_be_bytes() } else { unit.to_le_bytes() });
        }
        bytes
    }

    /// Text with multi-byte characters and surrogate pairs at every alignment.
    fn sample(len: usize) -> String {
        let mut text = String::new();
        let pieces = [
            "ascii line\n",
            "caf\u{e9} cr\u{e8}me\n",
            "\u{4e2d}\u{6587}\u{6d4b}\u{8bd5}\n",
            "\u{1f600}\u{1f4a9} x\n",
            "\u{20ac}5\r\n",
        ];
        let mut i = 0;
        while text.len() < len {
            text.push_str(pieces[i * 7 % pieces.len()]);
            i += 1;
        }
        text
    }

    fn inputs() -> Vec<(String, Vec<u8>)> {
        let text = sample(1500);
        let mut inputs = vec![
            ("utf8".to_string(), text.clone().into_bytes()),
            ("utf8 bom".to_string(), [&[0xEF, 0xBB, 0xBF][..], text.as_bytes()].concat()),
            ("utf16le bom".to_string(), utf16(&text, true, false)),
            ("utf16be bom".to_string(), utf16(&text, true, true)),
            ("utf16le".to_string(), utf16(&sample(1500).replace(|c: char| !c.is_ascii(), "e"), false, false)),
            ("utf16be".to_string(), utf16(&sample(1500).replace(|c: char| !c.is_ascii(), "e"), false, true)),
            (
                "gbk".to_string(),
                encoding_rs::GBK
                    .encode(&sample(1500).replace(['\u{1f600}', '\u{1f4a9}', '\u{20ac}'], ""))
                    .0
                    .into_owned(),
            ),
            (
                "latin1".to_string(),
                encoding_rs::WINDOWS_1252
                    .encode(&sample(1500).replace(|c: char| c as u32 > 0xff && c != '\u{20ac}', ""))
                    .0
                    .into_owned(),
            ),
            ("empty".to_string(), Vec::new()),
            ("binary".to_string(), b"\x7FELF\x02\x01\x01\x00\x00\x00 and text".repeat(100)),
            ("late nul".to_string(), [&b"abc caf\xe9 ".repeat(1200)[..], b"\0 tail"].concat()),
            ("truncated utf8".to_string(), text.as_bytes()[..text.len() - 1].to_vec()),
            ("truncated utf16".to_string(), utf16(&text, true, false)[..utf16(&text, true, false).len() - 1].to_vec()),
            (
                "lone surrogate".to_string(),
                [&[0xFF, 0xFE][..], &[0x3D, 0xD8, b'a', 0][..], &utf16(&text, false, false)[..]].concat(),
            ),
            ("invalid in the middle".to_string(), [text.as_bytes(), b"\xff\xfe\xc3", text.as_bytes()].concat()),
            (
                "shift jis".to_string(),
                encoding_rs::SHIFT_JIS
                    .encode(
                        "\u{3053}\u{3093}\u{306b}\u{3061}\u{306f}\u{4e16}\u{754c}\u{ff76}\u{ff85}\n"
                            .repeat(200)
                            .as_str(),
                    )
                    .0
                    .into_owned(),
            ),
        ];
        // The evidence for the encoding comes long after the sniffed head.
        let chinese = "\u{4e2d}\u{6587}\u{6d4b}\u{8bd5}\u{4e00}\u{6bb5}\u{6587}\u{672c}\n".repeat(300);
        let gbk = encoding_rs::GBK.encode(&chinese).0.into_owned();
        let head = "plain ascii line\n".repeat(1500);
        inputs.push(("gbk after a long ascii head".to_string(), [head.as_bytes(), &gbk].concat()));
        // Characters at every alignment against the sniffing head and the chunks.
        for pad in 0..5 {
            let mut bytes = "x".repeat(SNIFF_LEN - 3 + pad).into_bytes();
            bytes.extend("\u{4e2d}\u{1f600}\u{e9}".as_bytes());
            inputs.push((format!("utf8 at the head edge {pad}"), bytes));
            let mut bytes = "y".repeat(SNIFF_LEN - 2 + pad).into_bytes();
            bytes.extend([0xE9, b'z', 0xFF, b'e']);
            inputs.push((format!("latin1 at the head edge {pad}"), bytes));
        }
        inputs
    }

    #[test]
    fn streamed_text_equals_the_whole_file_decode() {
        for (name, bytes) in inputs() {
            for fallback in [None, Some("gbk"), Some("windows-1252"), Some("utf-16le"), Some("nonsense")] {
                let expected = decode_text(&bytes, fallback).map(String::into_bytes);
                for chunk in [1, 2, 3, 4, 5, 16, 255, 4096, CHUNK] {
                    for step in [1, 3, 8192, usize::MAX] {
                        assert_eq!(
                            streamed(&bytes, fallback, chunk, step),
                            expected,
                            "{name}, fallback {fallback:?}, chunk {chunk}, step {step}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn utf8_check_matches_from_utf8_for_any_split() {
        let samples: [&[u8]; 6] = [
            "a\u{e9}\u{4e2d}\u{1f600}z".as_bytes(),
            b"ab\xe4\xb8",
            b"\xe4\xb8a",
            b"\xf0\x9f\x98",
            b"ok\xc3(",
            b"\xed\xa0\x80",
        ];
        for bytes in samples {
            for first in 0..=bytes.len() {
                for second in first..=bytes.len() {
                    let mut check = Utf8Check::default();
                    check.feed(&bytes[..first]);
                    check.feed(&bytes[first..second]);
                    check.feed(&bytes[second..]);
                    assert_eq!(check.is_valid(), std::str::from_utf8(bytes).is_ok(), "{bytes:?} {first} {second}");
                }
            }
        }
    }

    #[test]
    fn reads_at_most_a_bounded_number_of_bytes_per_step() {
        // A reader that fails if asked for more than one chunk shows nothing is read whole.
        struct Capped<'a>(&'a [u8]);
        impl Read for Capped<'_> {
            fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
                assert!(buf.len() <= SNIFF_LEN.max(1024), "asked for {} bytes", buf.len());
                let n = buf.len().min(self.0.len());
                buf[..n].copy_from_slice(&self.0[..n]);
                self.0 = &self.0[n..];
                Ok(n)
            }
        }
        let bytes = encoding_rs::WINDOWS_1252.encode(&"caf\u{e9}\n".repeat(50_000)).0.into_owned();
        let mut reader = decode_stream_in(|| Ok(Capped(&bytes)), None, 1024).unwrap().unwrap();
        let mut text = String::new();
        reader.read_to_string(&mut text).unwrap();
        assert_eq!(text, "caf\u{e9}\n".repeat(50_000));
        assert!(reader.out.len() <= 4 * 1024 + 16 && reader.raw.len() == 1024);
    }
}
