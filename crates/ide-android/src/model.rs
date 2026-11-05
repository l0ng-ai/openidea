//! What the Logcat tool window shows: the devices `adb` reports and the lines
//! `adb logcat` prints, parsed from its `threadtime` format.

use serde::{Deserialize, Serialize};
use specta::Type;

/// One entry of `adb devices -l`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AndroidDevice {
    /// `adb -s` value: a USB serial number, `emulator-5554`, or `host:port`.
    pub serial: String,
    /// `device` (usable), `offline`, `unauthorized` or `no permissions`.
    pub state: String,
    pub model: Option<String>,
    pub product: Option<String>,
    /// The device's own name from the build (`ro.product.device`).
    pub device: Option<String>,
    pub transport_id: Option<String>,
}

impl AndroidDevice {
    /// Ready for `logcat` / `install`.
    pub fn is_online(&self) -> bool {
        self.state == "device"
    }

    /// What the picker calls it: the model when known, the serial otherwise.
    pub fn label(&self) -> &str {
        self.model.as_deref().filter(|m| !m.trim().is_empty()).unwrap_or(&self.serial)
    }
}

/// The single-letter logcat priority, in increasing severity.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LogcatLevel {
    Verbose,
    Debug,
    Info,
    Warn,
    Error,
    Fatal,
    /// A line logcat prints outside the message format (`--------- beginning of main`).
    Unknown,
}

impl LogcatLevel {
    pub fn letter(self) -> char {
        match self {
            Self::Verbose => 'V',
            Self::Debug => 'D',
            Self::Info => 'I',
            Self::Warn => 'W',
            Self::Error => 'E',
            Self::Fatal => 'F',
            Self::Unknown => '?',
        }
    }

    fn parse(c: char) -> Self {
        match c.to_ascii_uppercase() {
            'V' => Self::Verbose,
            'D' => Self::Debug,
            'I' => Self::Info,
            'W' => Self::Warn,
            'E' => Self::Error,
            'F' | 'A' => Self::Fatal,
            _ => Self::Unknown,
        }
    }
}

/// One [`LogcatLevel`]-tagged line of `adb logcat -v threadtime`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogcatLine {
    /// `MM-DD HH:MM:SS.mmm`, as logcat prints it (no year, device time zone).
    pub time: String,
    pub pid: i32,
    pub tid: i32,
    pub level: LogcatLevel,
    pub tag: String,
    pub message: String,
}

impl LogcatLine {
    /// A line logcat printed outside the message format, kept so nothing is lost.
    fn unparsed(text: &str) -> Self {
        Self {
            time: String::new(),
            pid: 0,
            tid: 0,
            level: LogcatLevel::Unknown,
            tag: String::new(),
            message: text.to_owned(),
        }
    }
}

/// Parses `adb devices -l` output; the daemon's chatter on stderr is not included.
pub fn parse_devices(output: &str) -> Vec<AndroidDevice> {
    let mut devices: Vec<AndroidDevice> = Vec::new();
    for line in output.lines() {
        let line = line.trim_end();
        if line.trim().is_empty() || line.starts_with("List of devices") || line.starts_with('*') {
            continue;
        }
        let mut fields = line.split_whitespace();
        let (Some(serial), Some(state)) = (fields.next(), fields.next()) else {
            continue;
        };
        // "no permissions (user in plugdev group; are your udev rules wrong?)"
        // is the one state that carries spaces; the rest is a `key:value` list.
        let mut device = AndroidDevice {
            serial: serial.to_owned(),
            state: state.to_owned(),
            model: None,
            product: None,
            device: None,
            transport_id: None,
        };
        if device.state == "no" {
            device.state = "no permissions".to_owned();
            devices.push(device);
            continue;
        }
        for field in fields {
            let Some((key, value)) = field.split_once(':') else {
                continue;
            };
            match key {
                "model" => device.model = Some(value.to_owned()),
                "product" => device.product = Some(value.to_owned()),
                "device" => device.device = Some(value.to_owned()),
                "transport_id" => device.transport_id = Some(value.to_owned()),
                _ => {}
            }
        }
        devices.push(device);
    }
    // Online first, then by name, so the picker's default is the device in hand.
    devices.sort_by(|a, b| b.is_online().cmp(&a.is_online()).then_with(|| a.serial.cmp(&b.serial)));
    devices
}

/// Parses one `logcat -v threadtime` line:
///
/// ```text
/// 11-04 12:52:39.123  3048  3059 I WindowManager: displayed
/// ```
///
/// Text that does not follow the format still becomes a line, so a device that
/// prints something unexpected does not look like a dead stream.
pub fn parse_line(text: &str) -> LogcatLine {
    let Some(line) = parse_formatted(text) else {
        return LogcatLine::unparsed(text);
    };
    line
}

fn parse_formatted(text: &str) -> Option<LogcatLine> {
    // "MM-DD HH:MM:SS.mmm" is 18 bytes; logcat pads the rest with spaces.
    let stamp = text.get(..18)?;
    if !looks_like_stamp(stamp) {
        return None;
    }
    let mut rest = text.get(18..)?;
    let pid: i32 = take_field(&mut rest)?.parse().ok()?;
    let tid: i32 = take_field(&mut rest)?.parse().ok()?;
    let level = LogcatLevel::parse(take_field(&mut rest)?.chars().next()?);
    let tail = rest.trim_start();
    // "Tag            : message": logcat pads the tag to 8 columns, and the tag
    // itself never contains a colon followed by a space.
    let (tag, message) = match tail.split_once(": ") {
        Some((tag, message)) => (tag.trim_end(), message),
        None => (tail.trim_end(), ""),
    };
    Some(LogcatLine { time: stamp.to_owned(), pid, tid, level, tag: tag.to_owned(), message: message.to_owned() })
}

/// Consumes the next space-separated field of `rest`, leaving the remainder.
fn take_field<'a>(rest: &mut &'a str) -> Option<&'a str> {
    *rest = rest.trim_start();
    if rest.is_empty() {
        return None;
    }
    let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
    let field = &rest[..end];
    *rest = &rest[end..];
    Some(field)
}

fn looks_like_stamp(s: &str) -> bool {
    let bytes = s.as_bytes();
    bytes.len() == 18
        && bytes[2] == b'-'
        && bytes[5] == b' '
        && bytes[8] == b':'
        && bytes[11] == b':'
        && bytes[14] == b'.'
        && bytes.iter().enumerate().all(|(i, b)| matches!(i, 2 | 5 | 8 | 11 | 14) || b.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_adb_devices_with_attributes() {
        let out = "\
List of devices attached
HT7A1B2C3D4           device product:generic model:Generic_Phone device:generic transport_id:1
emulator-5554          offline transport_id:2
0123456789ABCDEF       unauthorized usb:1-1 transport_id:3

";
        let devices = parse_devices(out);
        assert_eq!(devices.len(), 3);
        // Online first, then by serial.
        assert_eq!(devices[0].serial, "HT7A1B2C3D4");
        assert_eq!(devices[0].state, "device");
        assert_eq!(devices[0].model.as_deref(), Some("Generic_Phone"));
        assert_eq!(devices[0].transport_id.as_deref(), Some("1"));
        assert!(devices[0].is_online());
        assert_eq!(devices[1].serial, "0123456789ABCDEF");
        assert_eq!(devices[1].state, "unauthorized");
        assert_eq!(devices[1].label(), "0123456789ABCDEF");
        assert_eq!(devices[2].serial, "emulator-5554");
        assert!(!devices[2].is_online());
    }

    #[test]
    fn reads_adb_devices_when_the_list_is_empty() {
        assert!(parse_devices("List of devices attached\n\n").is_empty());
    }

    #[test]
    fn reads_no_permissions() {
        let devices = parse_devices("ABC\tno permissions (user in plugdev group; are your udev rules wrong?)\n");
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].state, "no permissions");
    }

    #[test]
    fn parses_a_threadtime_line() {
        let line = parse_line("11-04 12:52:39.123  3048  3059 I WindowManager: Displayed activity");
        assert_eq!(line.time, "11-04 12:52:39.123");
        assert_eq!(line.pid, 3048);
        assert_eq!(line.tid, 3059);
        assert_eq!(line.level, LogcatLevel::Info);
        assert_eq!(line.tag, "WindowManager");
        assert_eq!(line.message, "Displayed activity");
    }

    #[test]
    fn keeps_colons_in_the_message() {
        let line = parse_line("11-04 12:52:39.123  3048  3059 E flutter : java.lang.IllegalStateException: boom");
        assert_eq!(line.tag, "flutter");
        assert_eq!(line.level, LogcatLevel::Error);
        assert_eq!(line.message, "java.lang.IllegalStateException: boom");
    }

    #[test]
    fn keeps_lines_outside_the_format() {
        let line = parse_line("--------- beginning of main");
        assert_eq!(line.level, LogcatLevel::Unknown);
        assert_eq!(line.message, "--------- beginning of main");
    }

    #[test]
    fn levels_order_by_severity() {
        assert!(LogcatLevel::Warn > LogcatLevel::Info);
        assert!(LogcatLevel::Fatal > LogcatLevel::Error);
    }
}
