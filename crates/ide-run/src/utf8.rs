//! Incremental UTF-8 decoding for byte streams that may split code points
//! across reads.

/// Mirrors `ide-terminal`'s decoder; kept local so the crates stay independent.
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

/// Output decoder for the console's configured encoding (Settings › Console).
pub enum OutputDecoder {
    Utf8(Utf8Decoder),
    Other(Box<encoding_rs::Decoder>),
    Mixed(Box<MixedDecoder>),
}

impl OutputDecoder {
    /// Unknown labels fall back to UTF-8.
    pub fn for_label(label: Option<&str>) -> Self {
        match label.and_then(|l| encoding_rs::Encoding::for_label(l.trim().as_bytes())) {
            Some(enc) if enc != encoding_rs::UTF_8 => Self::Other(Box::new(enc.new_decoder())),
            _ => Self::Utf8(Utf8Decoder::new()),
        }
    }

    /// [`Self::for_label`] for output read from pipes. On Windows a UTF-8 console also decodes
    /// what Windows' own programs write: the lines that are not UTF-8 in the system's console
    /// code page (`ping`, `dir`, `cmd`'s messages), whatever the system's language, and UTF-16
    /// (`wsl.exe`, `cmd /u`).
    pub fn for_pipes(label: Option<&str>) -> Self {
        match Self::for_label(label) {
            Self::Utf8(_) if cfg!(windows) => Self::Mixed(Box::new(MixedDecoder::new(
                ide_core::output_encoding::console_code_page().and_then(NativeDecoder::for_code_page),
            ))),
            other => other,
        }
    }

    pub fn decode_into(&mut self, bytes: &[u8], out: &mut String) {
        match self {
            Self::Utf8(d) => d.decode_into(bytes, out),
            Self::Other(d) => decode_with(d, bytes, out, false),
            Self::Mixed(d) => d.decode_into(bytes, out),
        }
    }

    /// Whether part of a line is held back until it shows its encoding.
    pub fn holds(&self) -> bool {
        matches!(self, Self::Mixed(d) if d.holds())
    }

    /// Decodes the held part of a line now (no more output came for a while).
    pub fn release(&mut self, out: &mut String) {
        if let Self::Mixed(d) = self {
            d.release(out);
        }
    }

    pub fn finish(&mut self) -> String {
        match self {
            Self::Utf8(d) => d.finish(),
            Self::Other(d) => {
                let mut out = String::new();
                decode_with(d, &[], &mut out, true);
                out
            }
            Self::Mixed(d) => d.finish(),
        }
    }
}

/// Decoder for a Windows code page: `encoding_rs`'s, or Windows' own for the single-byte
/// pages `encoding_rs` lacks (the OEM pages 437, 850, 852…).
pub enum NativeDecoder {
    Encoding(Box<encoding_rs::Decoder>),
    #[cfg(windows)]
    SingleByte(u32),
}

impl NativeDecoder {
    /// `None` for UTF-8 and for code pages neither can decode piece by piece.
    pub fn for_code_page(cp: u32) -> Option<Self> {
        if let Some(enc) = ide_core::output_encoding::encoding_for_code_page(cp) {
            return (enc != encoding_rs::UTF_8)
                .then(|| Self::Encoding(Box::new(enc.new_decoder_without_bom_handling())));
        }
        #[cfg(windows)]
        if ide_core::output_encoding::is_single_byte_code_page(cp) {
            return Some(Self::SingleByte(cp));
        }
        None
    }

    fn decode_into(&mut self, bytes: &[u8], out: &mut String, last: bool) {
        match self {
            Self::Encoding(d) => decode_with(d, bytes, out, last),
            #[cfg(windows)]
            Self::SingleByte(cp) => out.push_str(&ide_core::output_encoding::decode_code_page(bytes, *cp)),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Line {
    /// Only ASCII so far, which reads the same in both.
    Open,
    Utf8,
    Native,
}

/// UTF-8, the system code page for the lines that are not UTF-8, and UTF-16: on pipes, cargo,
/// git or node write UTF-8, Windows' own programs the console code page (GBK, Shift_JIS,
/// EUC-KR, 866…) and a few of them (`wsl.exe`, `cmd /u`) UTF-16LE, even within one command.
///
/// Each line is decoded as UTF-8 or the code page (UTF-8 with replacement characters without
/// one). The part of a line after its first non-ASCII byte is held until the line ends or
/// turns out not to be UTF-8; [`Self::release`] decodes a held prompt when no more output comes.
///
/// A read with NUL bytes, which text in the others never has, is UTF-16LE (ASCII characters
/// and line ends in it have them); UTF-16 goes on until one of its lines has ended and a read
/// without NUL bytes comes.
pub struct MixedDecoder {
    utf8: Utf8Decoder,
    native: Option<NativeDecoder>,
    line: Line,
    held: Vec<u8>,
    utf16: Option<Utf16>,
}

impl MixedDecoder {
    pub fn new(native: Option<NativeDecoder>) -> Self {
        Self { utf8: Utf8Decoder::new(), native, line: Line::Open, held: Vec::new(), utf16: None }
    }

    pub fn decode_into(&mut self, bytes: &[u8], out: &mut String) {
        if bytes.is_empty() {
            return;
        }
        let nul = bytes.contains(&0);
        match self.utf16.as_ref().map(|u| u.open || nul) {
            Some(true) => {
                if let Some(u) = &mut self.utf16 {
                    u.decode(bytes, out);
                }
                return;
            }
            Some(false) => self.utf16 = None,
            None if nul => {
                self.end_line(out);
                let mut u = Utf16::new();
                u.decode(utf16_aligned(bytes), out);
                self.utf16 = Some(u);
                return;
            }
            None => {}
        }
        for piece in bytes.split_inclusive(|b| *b == b'\n') {
            let ends = piece.last() == Some(&b'\n');
            match self.line {
                Line::Utf8 => self.utf8.decode_into(piece, out),
                Line::Native => self.decode_native(piece, out),
                Line::Open => {
                    let mut rest = piece;
                    if self.held.is_empty() {
                        let ascii = piece.iter().take_while(|b| b.is_ascii()).count();
                        out.push_str(std::str::from_utf8(&piece[..ascii]).unwrap_or_default());
                        rest = &piece[ascii..];
                    }
                    self.held.extend_from_slice(rest);
                    let decided = match std::str::from_utf8(&self.held) {
                        Err(e) if e.error_len().is_some() => Some(Line::Native),
                        Ok(_) if ends => Some(Line::Utf8),
                        _ => None,
                    };
                    if let Some(line) = decided {
                        self.line = line;
                        self.flush_held(out);
                    }
                }
            }
            if ends {
                self.line = Line::Open;
            }
        }
    }

    fn flush_held(&mut self, out: &mut String) {
        let held = std::mem::take(&mut self.held);
        match self.line {
            Line::Native => self.decode_native(&held, out),
            Line::Open | Line::Utf8 => self.utf8.decode_into(&held, out),
        }
    }

    fn decode_native(&mut self, bytes: &[u8], out: &mut String) {
        match &mut self.native {
            Some(native) => native.decode_into(bytes, out, false),
            None => self.utf8.decode_into(bytes, out),
        }
    }

    /// Decodes the rest of the current line as it is.
    fn end_line(&mut self, out: &mut String) {
        if self.holds() {
            self.line = if std::str::from_utf8(&self.held).is_ok() { Line::Utf8 } else { Line::Native };
            self.flush_held(out);
        }
        out.push_str(&self.utf8.finish());
        self.line = Line::Open;
    }

    pub fn holds(&self) -> bool {
        !self.held.is_empty()
    }

    /// Decodes the held part of the line as UTF-8: held text has been UTF-8 so far.
    pub fn release(&mut self, out: &mut String) {
        if self.holds() {
            self.line = Line::Utf8;
            self.flush_held(out);
        }
    }

    pub fn finish(&mut self) -> String {
        let mut out = String::new();
        if let Some(mut u) = self.utf16.take() {
            decode_with(&mut u.decoder, &[], &mut out, true);
        }
        self.end_line(&mut out);
        if let Some(native) = &mut self.native {
            native.decode_into(&[], &mut out, true);
        }
        out
    }
}

struct Utf16 {
    decoder: encoding_rs::Decoder,
    /// Inside a line or a code unit: the next read goes on in UTF-16 whatever it holds.
    open: bool,
    /// An odd number of bytes so far.
    odd: bool,
}

impl Utf16 {
    fn new() -> Self {
        Self { decoder: encoding_rs::UTF_16LE.new_decoder_with_bom_removal(), open: false, odd: false }
    }

    fn decode(&mut self, bytes: &[u8], out: &mut String) {
        let start = out.len();
        decode_with(&mut self.decoder, bytes, out, false);
        self.odd ^= bytes.len() % 2 == 1;
        if self.odd {
            self.open = true;
        } else if out.len() > start {
            self.open = !out.ends_with('\n');
        }
    }
}

/// `bytes` from the first byte of a UTF-16LE code unit. NUL bytes are mostly the high bytes of
/// ASCII characters, at odd offsets from it; at even ones, the first byte is the high byte of a
/// character whose low byte came before (and was shown as ASCII).
fn utf16_aligned(bytes: &[u8]) -> &[u8] {
    let (mut even, mut odd) = (0usize, 0usize);
    for (i, b) in bytes.iter().enumerate() {
        if *b == 0 {
            if i % 2 == 0 {
                even += 1;
            } else {
                odd += 1;
            }
        }
    }
    if even > odd { &bytes[1..] } else { bytes }
}

fn decode_with(d: &mut encoding_rs::Decoder, bytes: &[u8], out: &mut String, last: bool) {
    let mut src = bytes;
    loop {
        out.reserve(d.max_utf8_buffer_length(src.len()).unwrap_or(src.len() * 3 + 16));
        let (result, read, _) = d.decode_to_string(src, out, last);
        src = &src[read..];
        if result == encoding_rs::CoderResult::InputEmpty {
            break;
        }
    }
}

#[cfg(test)]
mod encoding_tests {
    use super::{MixedDecoder, NativeDecoder, OutputDecoder};
    use ide_core::output_encoding::encoding_for_code_page;

    #[test]
    fn gbk_split_across_chunks() {
        // "中文" in GBK: D6 D0 CE C4
        let mut d = OutputDecoder::for_label(Some("GBK"));
        let mut out = String::new();
        d.decode_into(&[0xD6], &mut out);
        d.decode_into(&[0xD0, 0xCE], &mut out);
        d.decode_into(&[0xC4], &mut out);
        out.push_str(&d.finish());
        assert_eq!(out, "中文");
    }

    #[test]
    fn unknown_label_is_utf8() {
        let mut d = OutputDecoder::for_label(Some("no-such-encoding"));
        let mut out = String::new();
        d.decode_into("héllo".as_bytes(), &mut out);
        assert_eq!(out, "héllo");
        assert!(matches!(d, OutputDecoder::Utf8(_)));
    }

    fn mixed(cp: u32) -> MixedDecoder {
        MixedDecoder::new(Some(NativeDecoder::for_code_page(cp).expect("code page")))
    }

    fn encode(cp: u32, text: &str) -> Vec<u8> {
        let (bytes, _, unmappable) = encoding_for_code_page(cp).expect("code page").encode(text);
        assert!(!unmappable, "{text} in {cp}");
        bytes.into_owned()
    }

    /// Simplified and Traditional Chinese, Korean, Japanese, Cyrillic (OEM and ANSI), Western.
    const SAMPLES: &[(u32, &str)] = &[
        (936, "正在 Ping 127.0.0.1 具有 32 字节的数据:"),
        (950, "系統找不到指定的路徑。"),
        (949, "지정된 경로를 찾을 수 없습니다."),
        (932, "指定されたパスが見つかりません。"),
        (866, "Системе не удается найти указанный путь."),
        (1251, "Системе не удается найти указанный путь."),
        (1252, "Le chemin d'accès spécifié est introuvable."),
    ];

    #[test]
    fn utf8_and_code_page_lines_mix_whatever_the_chunks() {
        for &(cp, native) in SAMPLES {
            let mut bytes = "   Compiling 编译 ü\n".as_bytes().to_vec();
            bytes.extend(encode(cp, native));
            bytes.extend_from_slice(b"\r\n");
            bytes.extend_from_slice("ok ✓\n".as_bytes());
            bytes.extend(encode(cp, native));
            let expected = format!("   Compiling 编译 ü\n{native}\r\nok ✓\n{native}");
            for split in 0..=bytes.len() {
                let mut d = mixed(cp);
                let mut out = String::new();
                d.decode_into(&bytes[..split], &mut out);
                d.decode_into(&bytes[split..], &mut out);
                out.push_str(&d.finish());
                assert_eq!(out, expected, "code page {cp}, split at {split}");
            }
        }
    }

    #[test]
    fn byte_by_byte_code_page_output() {
        for &(cp, native) in SAMPLES {
            let bytes = [encode(cp, native), b"\n".to_vec()].concat();
            let mut d = mixed(cp);
            let mut out = String::new();
            for b in &bytes {
                d.decode_into(std::slice::from_ref(b), &mut out);
            }
            assert!(!d.holds());
            assert_eq!(out, format!("{native}\n"), "code page {cp}");
        }
    }

    #[test]
    fn ascii_and_code_page_prompts_show_at_once_and_utf8_ones_on_release() {
        let mut d = mixed(936);
        let mut out = String::new();
        d.decode_into(b"Password: ", &mut out);
        assert_eq!(out, "Password: ");
        assert!(!d.holds());

        out.clear();
        d.decode_into(&encode(936, "请按任意键继续. . ."), &mut out);
        assert_eq!(out, "请按任意键继续. . .");
        assert!(!d.holds());

        let mut d = mixed(936);
        out.clear();
        d.decode_into("Continue? 继续 ".as_bytes(), &mut out);
        assert_eq!(out, "Continue? ");
        assert!(d.holds());
        d.release(&mut out);
        assert_eq!(out, "Continue? 继续 ");
        d.decode_into("[y/N]\n".as_bytes(), &mut out);
        assert_eq!(out, "Continue? 继续 [y/N]\n");
    }

    #[test]
    fn a_released_line_split_inside_a_character_completes() {
        let mut d = mixed(949);
        let mut out = String::new();
        let bytes = "é中".as_bytes();
        d.decode_into(&bytes[..3], &mut out);
        d.release(&mut out);
        d.decode_into(&bytes[3..], &mut out);
        out.push_str(&d.finish());
        assert_eq!(out, "é中");
    }

    #[test]
    fn utf8_code_page_has_no_mixed_decoder() {
        assert!(NativeDecoder::for_code_page(65001).is_none());
    }

    fn utf16(text: &str) -> Vec<u8> {
        text.encode_utf16().flat_map(u16::to_le_bytes).collect()
    }

    /// What `wsl.exe -l -v` writes, on a Chinese system.
    const WSL: &str = "  NAME            STATE           VERSION\r\n* Ubuntu-22.04    Running         2\r\n\
                       适用于 Linux 的 Windows 子系统: 默认\r\n";

    #[test]
    fn utf16_output_between_utf8_and_code_page_lines_whatever_the_chunks() {
        let before = "   Compiling 编译\n".as_bytes();
        let wsl = utf16(WSL);
        let after = [encode(936, "系统找不到指定的路径。"), "\r\ndone ✓\n".as_bytes().to_vec()].concat();
        let expected = format!("   Compiling 编译\n{WSL}系统找不到指定的路径。\r\ndone ✓\n");
        for split in 0..=wsl.len() {
            let mut d = mixed(936);
            let mut out = String::new();
            for chunk in [before, &wsl[..split], &wsl[split..], &after] {
                d.decode_into(chunk, &mut out);
            }
            out.push_str(&d.finish());
            assert_eq!(out, expected, "split at {split}");
        }
    }

    #[test]
    fn utf16_with_a_byte_order_mark_or_starting_with_cjk() {
        let mut d = mixed(949);
        let mut out = String::new();
        d.decode_into(&[&[0xFF, 0xFE][..], &utf16("한국어 OK\r\n")].concat(), &mut out);
        d.decode_into(&utf16("中文 OK\r\n"), &mut out);
        out.push_str(&d.finish());
        assert_eq!(out, "한국어 OK\r\n中文 OK\r\n");
    }

    #[test]
    fn without_a_code_page_other_lines_are_lossy_utf8_and_utf16_still_reads() {
        let mut d = MixedDecoder::new(None);
        let mut out = String::new();
        d.decode_into(b"caf\xe9\n", &mut out);
        d.decode_into(&utf16("wsl 子系统\r\n"), &mut out);
        d.decode_into("ok ✓\n".as_bytes(), &mut out);
        out.push_str(&d.finish());
        assert_eq!(out, "caf\u{FFFD}\nwsl 子系统\r\nok ✓\n");
    }

    #[cfg(windows)]
    #[test]
    fn oem_code_pages_without_an_encoding_rs_table_decode_through_windows() {
        for cp in [437, 850, 852] {
            let mut d = mixed(cp);
            let mut out = String::new();
            d.decode_into(b"caf\x82\r\n", &mut out);
            assert_eq!(out, "caf\u{e9}\r\n", "code page {cp}");
        }
    }
}
