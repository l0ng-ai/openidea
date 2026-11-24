//! Bounded UTF-8 scrollback and OSC state tracker so a reattached terminal
//! restores recent output, alternate-screen state, working directory, title
//! and command-running state without gaps.

/// Maximum scrollback retained per live PTY session (256 KiB).
const MAX_SCROLLBACK_BYTES: usize = 256 * 1024;
/// Maximum incomplete OSC sequence buffered across chunks.
const MAX_OSC_TAIL: usize = 2048;
/// PowerShell / OpenIDEA clear-scrollback OSC marker.
const CLEAR_MARKER: &str = "\x1b]133;OpenIDEA;ClearScrollback\x07";
const CLEAR_CSI: &str = "\x1b[3J";

const ALT_ON: [&str; 3] = ["\x1b[?1049h", "\x1b[?1047h", "\x1b[?47h"];
const ALT_OFF: [&str; 3] = ["\x1b[?1049l", "\x1b[?1047l", "\x1b[?47l"];

pub(crate) struct Scrollback {
    buf: String,
    /// Whether text evicted before `buf` left the terminal on the alternate screen.
    evicted_alt_screen: bool,
    /// Whether the current terminal state (evicted + `buf`) is on the alternate screen.
    alt_screen: bool,
    osc_tail: String,
    pub cwd: String,
    pub app_title: Option<String>,
    pub command_running: bool,
}

impl Scrollback {
    pub fn new(initial_cwd: String) -> Self {
        Self {
            buf: String::new(),
            evicted_alt_screen: false,
            alt_screen: false,
            osc_tail: String::new(),
            cwd: initial_cwd,
            app_title: None,
            command_running: false,
        }
    }

    pub fn is_alt_screen(&self) -> bool {
        self.alt_screen
    }

    pub fn push(&mut self, chunk: &str) {
        if chunk.is_empty() {
            return;
        }
        self.scan_osc(chunk);
        self.alt_screen = scan_alt_screen(self.alt_screen, chunk);

        // Honour explicit scrollback clears so `clear` / Cmd+K doesn't replay cleared history.
        let mut slice = chunk;
        if let Some(idx) = last_clear_end(slice) {
            self.buf.clear();
            self.evicted_alt_screen = false;
            slice = &slice[idx..];
        } else if !self.buf.is_empty() {
            // Handle a clear marker split across the boundary between `self.buf` and `chunk`.
            let tail_start = floor_char_boundary(&self.buf, self.buf.len().saturating_sub(CLEAR_MARKER.len()));
            let combined = format!("{}{}", &self.buf[tail_start..], slice);
            if let Some(idx) = last_clear_end(&combined) {
                let tail_len = self.buf.len() - tail_start;
                self.buf.clear();
                self.evicted_alt_screen = false;
                if idx > tail_len {
                    slice = &slice[idx - tail_len..];
                } else {
                    slice = "";
                }
            }
        }

        self.buf.push_str(slice);
        if self.buf.len() > MAX_SCROLLBACK_BYTES {
            let mut cut = self.buf.len() - MAX_SCROLLBACK_BYTES;
            while cut < self.buf.len() && !self.buf.is_char_boundary(cut) {
                cut += 1;
            }
            // Avoid slicing inside a short CSI/ESC sequence near `cut`.
            cut = avoid_mid_escape(&self.buf, cut);
            if cut > 0 {
                self.evicted_alt_screen = scan_alt_screen(self.evicted_alt_screen, &self.buf[..cut]);
                self.buf.drain(..cut);
            }
        }
    }

    /// Buffered output to replay into a freshly attached xterm.js instance.
    pub fn snapshot(&self) -> String {
        if self.evicted_alt_screen {
            let mut out = String::with_capacity("\x1b[?1049h".len() + self.buf.len());
            out.push_str("\x1b[?1049h");
            out.push_str(&self.buf);
            out
        } else {
            self.buf.clone()
        }
    }

    fn scan_osc(&mut self, chunk: &str) {
        if self.osc_tail.is_empty() && !chunk.contains("\x1b]") {
            return;
        }
        let mut combined = std::mem::take(&mut self.osc_tail);
        combined.push_str(chunk);
        let bytes = combined.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            let Some(rel) = find_osc_start(&bytes[i..]) else {
                // Keep a trailinglone ESC in case `]` arrives in the next chunk.
                if bytes.last() == Some(&0x1b) {
                    self.osc_tail.push('\x1b');
                }
                return;
            };
            let start = i + rel;
            let body_start = start + 2;
            if let Some((body_end, next_i)) = find_osc_end(bytes, body_start) {
                if let Ok(body) = std::str::from_utf8(&bytes[body_start..body_end]) {
                    self.apply_osc(body);
                }
                i = next_i;
            } else {
                let rem = &combined[start..];
                if rem.len() <= MAX_OSC_TAIL {
                    self.osc_tail.push_str(rem);
                }
                return;
            }
        }
    }

    fn apply_osc(&mut self, body: &str) {
        if let Some(title) = body.strip_prefix("0;").or_else(|| body.strip_prefix("2;")) {
            let trimmed = title.trim();
            self.app_title = (!trimmed.is_empty()).then(|| trimmed.to_owned());
        } else if let Some(url) = body.strip_prefix("7;") {
            if let Some(path) = parse_file_url_path(url) {
                self.cwd = path;
            }
        } else if let Some(rest) = body.strip_prefix("133;") {
            if rest == "C" {
                self.command_running = true;
            } else if rest == "D" || rest.starts_with("D;") {
                self.command_running = false;
            }
        }
    }
}

fn floor_char_boundary(s: &str, mut index: usize) -> usize {
    if index >= s.len() {
        return s.len();
    }
    while index > 0 && !s.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn last_clear_end(s: &str) -> Option<usize> {
    let a = s.rfind(CLEAR_MARKER).map(|i| i + CLEAR_MARKER.len());
    let b = s.rfind(CLEAR_CSI).map(|i| i + CLEAR_CSI.len());
    match (a, b) {
        (Some(x), Some(y)) => Some(x.max(y)),
        (x, y) => x.or(y),
    }
}

fn scan_alt_screen(mut current: bool, text: &str) -> bool {
    if !text.contains("\x1b[?") {
        return current;
    }
    let bytes = text.as_bytes();
    let mut i = 0;
    while i + 4 < bytes.len() {
        if bytes[i] == 0x1b && bytes[i + 1] == b'[' && bytes[i + 2] == b'?' {
            let tail = &text[i..];
            if ALT_ON.iter().any(|p| tail.starts_with(p)) {
                current = true;
            } else if ALT_OFF.iter().any(|p| tail.starts_with(p)) {
                current = false;
            }
        }
        i += 1;
    }
    current
}

fn avoid_mid_escape(s: &str, cut: usize) -> usize {
    let lookback = floor_char_boundary(s, cut.saturating_sub(16));
    let Some(esc_rel) = s[lookback..cut].rfind('\x1b') else {
        return cut;
    };
    let esc = lookback + esc_rel;
    // Check whether the escape sequence already ended before `cut`.
    let bytes = &s.as_bytes()[esc + 1..cut];
    if bytes.first() == Some(&b'[') {
        if bytes[1..].iter().any(|&b| (0x40..=0x7e).contains(&b)) {
            return cut;
        }
        // Advance to end of CSI sequence (bounded to 32 bytes).
        let max = (cut + 32).min(s.len());
        for idx in cut..max {
            let b = s.as_bytes()[idx];
            if (0x40..=0x7e).contains(&b) {
                return idx + 1;
            }
        }
    }
    cut
}

fn find_osc_start(bytes: &[u8]) -> Option<usize> {
    bytes.windows(2).position(|w| w == b"\x1b]")
}

fn find_osc_end(bytes: &[u8], mut i: usize) -> Option<(usize, usize)> {
    while i < bytes.len() {
        if bytes[i] == 0x07 {
            return Some((i, i + 1));
        }
        if bytes[i] == 0x1b && bytes.get(i + 1) == Some(&b'\\') {
            return Some((i, i + 2));
        }
        i += 1;
    }
    None
}

fn parse_file_url_path(url: &str) -> Option<String> {
    let rest = url.trim().strip_prefix("file://")?;
    let slash = rest.find('/')?;
    let raw_path = &rest[slash..];
    let decoded = percent_decode(raw_path)?;
    (!decoded.is_empty()).then_some(decoded)
}

fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16)?;
            let lo = (bytes[i + 2] as char).to_digit(16)?;
            out.push(((hi << 4) | lo) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracks_osc_cwd_title_and_command_across_split_chunks() {
        let mut sb = Scrollback::new("/initial".into());
        sb.push("\x1b]7;file://host/home/coder/my%20");
        sb.push("repo\x07\x1b]2;watch date\x1b\\\x1b]133;C\x07tick 1\r\n");
        assert_eq!(sb.cwd, "/home/coder/my repo");
        assert_eq!(sb.app_title.as_deref(), Some("watch date"));
        assert!(sb.command_running);

        sb.push("\x1b]133;D;0\x07");
        assert!(!sb.command_running);
    }

    #[test]
    fn preserves_alt_screen_prefix_when_initial_enter_scrolls_off() {
        let mut sb = Scrollback::new("/".into());
        sb.push("\x1b[?1049hframe-0\r\n");
        assert!(sb.is_alt_screen());
        let filler = "x".repeat(MAX_SCROLLBACK_BYTES + 1024);
        sb.push(&filler);
        let snap = sb.snapshot();
        assert!(snap.starts_with("\x1b[?1049h"));
        assert!(sb.is_alt_screen());

        sb.push("\x1b[?1049lprompt$ ");
        assert!(!sb.is_alt_screen());
    }

    #[test]
    fn clear_scrollback_drops_prior_history() {
        let mut sb = Scrollback::new("/".into());
        sb.push("old line 1\r\nold line 2\r\n");
        sb.push("\x1b[2J\x1b[3Jfresh prompt$ ");
        assert_eq!(sb.snapshot(), "fresh prompt$ ");
    }
}
