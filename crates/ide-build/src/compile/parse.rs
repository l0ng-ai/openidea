//! Compiler output → messages. One [`OutputParser`] per build step consumes the
//! output line by line; multi-line messages (javac's source / caret lines,
//! `symbol:` / `location:` details, tsc message chains) are completed by the
//! following lines, so callers must call [`OutputParser::finish`] at the end.
//!
//! Positions are kept as printed (1-based, in the unit of the producing tool);
//! [`super::resolve`] turns them into IDE coordinates.

use ide_core::Severity;
pub(crate) use ide_core::output_encoding::strip_ansi;
use serde_json::Value;

/// Output dialect of a build step.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Format {
    /// Maven: `[ERROR] /p/A.java:[12,5] msg`, plus Kotlin and javac forms.
    Maven,
    /// Gradle: javac's `A.java:12: error: msg` and Kotlin's `e: file:///p/A.kt:12:5 msg`.
    Gradle,
    /// `cargo --message-format=json`.
    Cargo,
    /// `tsc`: `a.ts(12,5): error TS2322: msg` or the pretty `a.ts:12:5 - error TS2322: msg`.
    Tsc,
    /// `go build`: `./a.go:12:5: msg`.
    Go,
    /// GCC / Clang (through `cmake --build`): `src/a.cpp:12:5: error: msg`.
    Gcc,
}

/// What a printed column counts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ColUnit {
    /// Unicode scalar values (javac, kotlinc, rustc).
    Char,
    /// UTF-16 code units (tsc).
    Utf16,
    /// Bytes (go).
    Byte,
}

/// A message as printed: path as written, 1-based line / column.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RawMessage {
    pub severity: Severity,
    pub text: String,
    pub path: Option<String>,
    pub line: Option<u32>,
    pub col: Option<u32>,
    pub end_line: Option<u32>,
    pub end_col: Option<u32>,
    pub unit: ColUnit,
    pub code: Option<String>,
    /// Directory relative paths resolve against first (cargo: the package of the message).
    pub base: Option<String>,
}

impl RawMessage {
    fn new(severity: Severity, text: impl Into<String>, unit: ColUnit) -> Self {
        RawMessage {
            severity,
            text: text.into(),
            path: None,
            line: None,
            col: None,
            end_line: None,
            end_col: None,
            unit,
            code: None,
            base: None,
        }
    }

    fn at(mut self, path: &str, line: u32, col: Option<u32>) -> Self {
        self.path = Some(path.to_owned());
        self.line = Some(line);
        self.col = col;
        self
    }
}

/// What a line contributes: messages completed by it and the console text to
/// show instead of the raw line (cargo's JSON becomes the rendered diagnostic).
#[derive(Debug, Default)]
pub(crate) struct Parsed {
    pub messages: Vec<RawMessage>,
    /// `None` = show the line as is; `Some("")` = hide it.
    pub console: Option<String>,
}

/// A message waiting for its detail lines.
struct Pending {
    msg: RawMessage,
    /// javac (Gradle) prints the source line and a caret line after the header: lines still expected.
    source_lines: u8,
}

pub(crate) struct OutputParser {
    format: Format,
    pending: Option<Pending>,
}

fn num(s: &str) -> Option<u32> {
    s.trim().parse().ok().filter(|n| *n > 0)
}

/// `path:12:5` / `path:12` at the start of `s` (path may contain `:` on Windows) → (path, line, col, rest).
fn path_line_col(s: &str) -> Option<(&str, u32, Option<u32>, &str)> {
    // Scan `:` positions; the first one followed by digits and `:` / end is the line.
    let bytes = s.as_bytes();
    let mut i = 0;
    while let Some(off) = s[i..].find(':') {
        let colon = i + off;
        let digits = s[colon + 1..].bytes().take_while(u8::is_ascii_digit).count();
        let after = colon + 1 + digits;
        if colon > 0 && digits > 0 && (after == s.len() || bytes[after] == b':' || bytes[after] == b' ') {
            let path = &s[..colon];
            let line = num(&s[colon + 1..after])?;
            if after < s.len() && bytes[after] == b':' {
                let cdigits = s[after + 1..].bytes().take_while(u8::is_ascii_digit).count();
                if cdigits > 0 {
                    let end = after + 1 + cdigits;
                    return Some((path, line, num(&s[after + 1..end]), &s[end..]));
                }
            }
            return Some((path, line, None, &s[after..]));
        }
        i = colon + 1;
    }
    None
}

fn looks_like_source_path(p: &str) -> bool {
    !p.is_empty() && !p.contains(' ') && p.rsplit(['/', '\\']).next().is_some_and(|name| name.contains('.'))
}

/// `[12,5] msg` (Maven) → (12, 5, msg).
fn bracket_pos(s: &str) -> Option<(u32, Option<u32>, &str)> {
    let inner = s.strip_prefix('[')?;
    let (pos, rest) = inner.split_once(']')?;
    let (line, col) = match pos.split_once(',') {
        Some((l, c)) => (num(l)?, num(c)),
        None => (num(pos)?, None),
    };
    Some((line, col, rest.trim_start()))
}

/// `file:///p/A.kt` → `/p/A.kt` (percent-decoded).
fn from_file_uri(s: &str) -> String {
    let Some(rest) = s.strip_prefix("file://") else { return s.to_owned() };
    let hex = |b: u8| (b as char).to_digit(16).and_then(|d| u8::try_from(d).ok());
    let bytes = rest.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let (Some(h), Some(l)) = (bytes.get(i + 1).and_then(|b| hex(*b)), bytes.get(i + 2).and_then(|b| hex(*b)))
        {
            out.push(h * 16 + l);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    let path = String::from_utf8_lossy(&out).into_owned();
    // `file:///C:/x` on Windows.
    if path.len() > 2 && path.as_bytes()[0] == b'/' && path.as_bytes()[2] == b':' { path[1..].to_owned() } else { path }
}

/// Kotlin: `file:///p/A.kt:12:5 msg` or `/p/A.kt: (12, 5): msg`, after the `e: ` / `w: ` prefix.
fn kotlin_location(s: &str, severity: Severity) -> Option<RawMessage> {
    if let Some((path, rest)) = s.split_once(": (") {
        let (pos, msg) = rest.split_once(')')?;
        let (l, c) = pos.split_once(',')?;
        let msg = msg.trim_start_matches(':').trim();
        return Some(RawMessage::new(severity, msg, ColUnit::Char).at(&from_file_uri(path), num(l)?, num(c)));
    }
    let (path, line, col, rest) = path_line_col(s)?;
    let msg = rest.trim_start_matches(':').trim();
    if !looks_like_source_path(path) || msg.is_empty() {
        return None;
    }
    Some(RawMessage::new(severity, msg, ColUnit::Char).at(&from_file_uri(path), line, col))
}

fn kotlin_line(line: &str) -> Option<RawMessage> {
    let (severity, rest) = if let Some(r) = line.strip_prefix("e: ") {
        (Severity::Error, r)
    } else {
        let r = line.strip_prefix("w: ")?;
        (Severity::Warning, r)
    };
    kotlin_location(rest, severity)
}

/// javac: `A.java:12: error: msg` / `A.java:12: warning: [deprecation] msg`.
fn javac_header(line: &str) -> Option<RawMessage> {
    let (path, ln, col, rest) = path_line_col(line)?;
    if !looks_like_source_path(path) {
        return None;
    }
    let rest = rest.trim_start_matches(':').trim_start();
    let (severity, msg) = if let Some(m) = rest.strip_prefix("error:") {
        (Severity::Error, m)
    } else {
        let m = rest.strip_prefix("warning:")?;
        (Severity::Warning, m)
    };
    Some(RawMessage::new(severity, msg.trim(), ColUnit::Char).at(path, ln, col))
}

/// Maven: `[ERROR] /p/A.java:[12,5] msg`, `[WARNING] …`, and Kotlin / javac forms after the level.
fn maven_line(line: &str) -> Option<RawMessage> {
    let (severity, rest) = if let Some(r) = line.strip_prefix("[ERROR] ") {
        (Severity::Error, r)
    } else {
        let r = line.strip_prefix("[WARNING] ")?;
        (Severity::Warning, r)
    };
    let rest = rest.trim_start();
    if let Some((path, pos)) = rest.split_once(":[")
        && looks_like_source_path(path)
        && let Some((ln, col, msg)) = bracket_pos(&format!("[{pos}"))
    {
        return Some(RawMessage::new(severity, msg, ColUnit::Char).at(path, ln, col));
    }
    if let Some(m) = kotlin_line(rest) {
        return Some(m);
    }
    if rest.starts_with("file://") || rest.contains(": (") {
        return kotlin_location(rest, severity);
    }
    None
}

/// tsc: `a.ts(12,5): error TS2322: msg` or `a.ts:12:5 - error TS2322: msg`.
fn tsc_line(line: &str) -> Option<RawMessage> {
    let (path, ln, col, rest) = if let Some(open) = line.find('(')
        && let Some(close) = line[open..].find("):")
    {
        let (l, c) = line[open + 1..open + close].split_once(',')?;
        (&line[..open], num(l)?, num(c), &line[open + close + 2..])
    } else {
        let (path, ln, col, rest) = path_line_col(line)?;
        (path, ln, col, rest.strip_prefix(" -")?)
    };
    if !looks_like_source_path(path) {
        return None;
    }
    let rest = rest.trim_start();
    let (severity, rest) = if let Some(r) = rest.strip_prefix("error") {
        (Severity::Error, r)
    } else {
        let r = rest.strip_prefix("warning")?;
        (Severity::Warning, r)
    };
    let (code, msg) = match rest.trim_start().split_once(':') {
        Some((code, msg)) if code.starts_with("TS") => (Some(code.to_owned()), msg.trim()),
        _ => (None, rest.trim_start_matches(':').trim()),
    };
    let mut m = RawMessage::new(severity, msg, ColUnit::Utf16).at(path.trim(), ln, col);
    m.code = code;
    Some(m)
}

/// go: `./a.go:12:5: msg` (errors only; `go vet` style `a.go:12: msg` too).
fn go_line(line: &str) -> Option<RawMessage> {
    let (path, ln, col, rest) = path_line_col(line)?;
    if !path.ends_with(".go") && !path.ends_with(".s") {
        return None;
    }
    let msg = rest.strip_prefix(':')?.trim();
    (!msg.is_empty()).then(|| RawMessage::new(Severity::Error, msg, ColUnit::Byte).at(path, ln, col))
}

/// A GCC / Clang diagnostic line; notes and the context lines after it are left as output.
fn gcc_line(line: &str) -> Option<RawMessage> {
    let (path, ln, col, rest) = path_line_col(line)?;
    let rest = rest.strip_prefix(':')?.trim_start();
    let (severity, msg) =
        [("fatal error:", Severity::Error), ("error:", Severity::Error), ("warning:", Severity::Warning)]
            .into_iter()
            .find_map(|(prefix, severity)| rest.strip_prefix(prefix).map(|m| (severity, m.trim())))?;
    (!msg.is_empty()).then(|| RawMessage::new(severity, msg, ColUnit::Byte).at(path, ln, col))
}

/// rustc's JSON diagnostic (`reason: compiler-message`) → message and its rendered text.
fn cargo_json(v: &Value) -> Option<(Option<RawMessage>, String)> {
    if v.get("reason")?.as_str()? != "compiler-message" {
        return Some((None, String::new()));
    }
    let msg = v.get("message")?;
    let rendered = msg.get("rendered").and_then(Value::as_str).unwrap_or_default().trim_end().to_owned();
    let severity = match msg.get("level")?.as_str()? {
        "error" | "error: internal compiler error" => Severity::Error,
        "warning" => Severity::Warning,
        "note" | "help" => Severity::Info,
        _ => return Some((None, rendered)),
    };
    let text = msg.get("message")?.as_str()?.to_owned();
    let span = msg
        .get("spans")
        .and_then(Value::as_array)
        .and_then(|s| s.iter().find(|s| s.get("is_primary").and_then(Value::as_bool) == Some(true)));
    let Some(span) = span else {
        // Span-less summaries ("2 warnings emitted", "aborting due to…") repeat the real messages.
        let summary = text.starts_with("aborting due to")
            || text.ends_with("emitted")
            || text.contains("generated") && text.contains("warning");
        let keep = severity == Severity::Error && !summary;
        return Some((keep.then(|| RawMessage::new(severity, text, ColUnit::Char)), rendered));
    };
    let u = |k: &str| span.get(k).and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok());
    let mut m = RawMessage::new(severity, text, ColUnit::Char).at(
        span.get("file_name")?.as_str()?,
        u("line_start")?,
        u("column_start"),
    );
    m.end_line = u("line_end");
    m.end_col = u("column_end");
    m.code = msg.get("code").and_then(|c| c.get("code")).and_then(Value::as_str).map(str::to_owned);
    m.base = v
        .get("manifest_path")
        .and_then(Value::as_str)
        .and_then(|p| std::path::Path::new(p).parent())
        .map(|p| p.to_string_lossy().into_owned());
    Some((Some(m), rendered))
}

impl OutputParser {
    pub(crate) fn new(format: Format) -> Self {
        OutputParser { format, pending: None }
    }

    fn flush(&mut self, out: &mut Vec<RawMessage>) {
        if let Some(p) = self.pending.take() {
            out.push(p.msg);
        }
    }

    /// Source, caret and detail lines that belong to the pending message; `true` when consumed.
    fn continue_pending(&mut self, line: &str) -> bool {
        let format = self.format;
        let Some(p) = &mut self.pending else { return false };
        if p.source_lines > 0 {
            let t = line.trim_end();
            if t.trim_start() == "^" {
                if p.msg.col.is_none() {
                    p.msg.col = u32::try_from(t.chars().count()).ok();
                }
                p.source_lines = 0;
                return true;
            }
            if p.source_lines == 2 {
                p.source_lines = 1;
                return true;
            }
            p.source_lines = 0;
        }
        // Maven repeats compiler messages in its failure summary with every line prefixed.
        let body = match format {
            Format::Maven => line
                .strip_prefix("[ERROR]")
                .or_else(|| line.strip_prefix("[WARNING]"))
                .map_or(line, |r| r.strip_prefix(' ').unwrap_or(r)),
            _ => line,
        };
        if matches!(format, Format::Maven | Format::Gradle | Format::Tsc)
            && body.starts_with("  ")
            && !body.trim().is_empty()
        {
            p.msg.text.push('\n');
            p.msg.text.push_str(body.trim());
            return true;
        }
        false
    }

    pub(crate) fn feed(&mut self, raw: &str) -> Parsed {
        let line = strip_ansi(raw);
        let mut out = Parsed::default();
        if self.format == Format::Cargo {
            if line.starts_with('{')
                && let Ok(v) = serde_json::from_str::<Value>(&line)
            {
                let (msg, rendered) = cargo_json(&v).unwrap_or_default();
                out.messages.extend(msg);
                out.console = Some(if rendered.is_empty() { String::new() } else { format!("{rendered}\n") });
            }
            return out;
        }
        if self.continue_pending(&line) {
            return out;
        }
        self.flush(&mut out.messages);
        let parsed = match self.format {
            Format::Maven => maven_line(&line),
            Format::Gradle => javac_header(&line).or_else(|| kotlin_line(&line)),
            Format::Tsc => tsc_line(&line),
            Format::Go => go_line(&line),
            Format::Gcc => gcc_line(&line),
            Format::Cargo => None,
        };
        if let Some(msg) = parsed {
            let javac = self.format == Format::Gradle
                && msg.unit == ColUnit::Char
                && !line.starts_with("e: ")
                && !line.starts_with("w: ");
            self.pending = Some(Pending { msg, source_lines: if javac { 2 } else { 0 } });
        }
        out
    }

    pub(crate) fn finish(&mut self) -> Vec<RawMessage> {
        let mut out = Vec::new();
        self.flush(&mut out);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(format: Format, text: &str) -> Vec<RawMessage> {
        let mut p = OutputParser::new(format);
        let mut out = Vec::new();
        for line in text.lines() {
            out.extend(p.feed(line).messages);
        }
        out.extend(p.finish());
        out
    }

    fn pos(m: &RawMessage) -> (Severity, &str, u32, Option<u32>) {
        (m.severity, m.path.as_deref().unwrap(), m.line.unwrap(), m.col)
    }

    #[test]
    fn maven_javac() {
        let out = parse(
            Format::Maven,
            "[INFO] --- compiler:3.13.0:compile (default-compile) @ demo ---\n\
             [ERROR] COMPILATION ERROR : \n\
             [ERROR] /p/src/main/java/a/A.java:[12,5] cannot find symbol\n\
             \x20 symbol:   class Foo\n\
             \x20 location: class a.A\n\
             [WARNING] /p/src/main/java/a/B.java:[3,8] [deprecation] old() in a.C has been deprecated\n\
             [INFO] 1 error\n\
             [ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin:3.13.0:compile\n",
        );
        assert_eq!(out.len(), 2, "{out:?}");
        assert_eq!(pos(&out[0]), (Severity::Error, "/p/src/main/java/a/A.java", 12, Some(5)));
        assert_eq!(out[0].text, "cannot find symbol\nsymbol:   class Foo\nlocation: class a.A");
        assert_eq!(pos(&out[1]), (Severity::Warning, "/p/src/main/java/a/B.java", 3, Some(8)));
        assert_eq!(out[1].unit, ColUnit::Char);
    }

    #[test]
    fn maven_detail_lines_with_level_prefix_and_kotlin() {
        let out = parse(
            Format::Maven,
            "[ERROR] /p/A.java:[7,20] incompatible types: String cannot be converted to int\n\
             [ERROR] -> [Help 1]\n\
             [ERROR] file:///p/src/K%20t.kt:4:9 Unresolved reference 'x'.\n\
             [WARNING] /p/src/K.kt: (2, 3): Variable 'y' is never used\n",
        );
        assert_eq!(out.len(), 3, "{out:?}");
        assert_eq!(out[0].text, "incompatible types: String cannot be converted to int");
        assert_eq!(pos(&out[1]), (Severity::Error, "/p/src/K t.kt", 4, Some(9)));
        assert_eq!(pos(&out[2]), (Severity::Warning, "/p/src/K.kt", 2, Some(3)));
        assert_eq!(out[2].text, "Variable 'y' is never used");
    }

    #[test]
    fn gradle_javac_with_caret_column() {
        let out = parse(
            Format::Gradle,
            "> Task :compileJava\n\
             /p/src/main/java/a/A.java:12: error: cannot find symbol\n\
             \x20       Foo foo = new Foo();\n\
             \x20       ^\n\
             \x20 symbol:   class Foo\n\
             \x20 location: class A\n\
             /p/src/main/java/a/A.java:20: warning: [removal] finalize() has been deprecated\n\
             \x20   protected void finalize() {}\n\
             \x20                  ^\n\
             1 error\n\
             1 warning\n\
             > Task :compileJava FAILED\n",
        );
        assert_eq!(out.len(), 2, "{out:?}");
        assert_eq!(pos(&out[0]), (Severity::Error, "/p/src/main/java/a/A.java", 12, Some(9)));
        assert_eq!(out[0].text, "cannot find symbol\nsymbol:   class Foo\nlocation: class A");
        assert_eq!(pos(&out[1]), (Severity::Warning, "/p/src/main/java/a/A.java", 20, Some(20)));
        assert_eq!(out[1].text, "[removal] finalize() has been deprecated");
    }

    #[test]
    fn gradle_kotlin() {
        let out = parse(
            Format::Gradle,
            "> Task :app:compileKotlin FAILED\n\
             e: file:///p/app/src/main/kotlin/Main.kt:12:5 Unresolved reference: foo\n\
             w: file:///p/app/src/main/kotlin/Main.kt:3:9 Parameter 'args' is never used\n\
             e: Compilation error. See log for more details\n",
        );
        assert_eq!(out.len(), 2, "{out:?}");
        assert_eq!(pos(&out[0]), (Severity::Error, "/p/app/src/main/kotlin/Main.kt", 12, Some(5)));
        assert_eq!(out[0].text, "Unresolved reference: foo");
        assert_eq!(pos(&out[1]), (Severity::Warning, "/p/app/src/main/kotlin/Main.kt", 3, Some(9)));
    }

    #[test]
    fn cargo_json_messages() {
        let err = r#"{"reason":"compiler-message","package_id":"p 0.1.0","manifest_path":"/w/crates/p/Cargo.toml","target":{},"message":{"rendered":"error[E0425]: cannot find value `x`\n --> src/main.rs:2:5\n","$message_type":"diagnostic","children":[],"code":{"code":"E0425","explanation":null},"level":"error","message":"cannot find value `x` in this scope","spans":[{"byte_end":20,"byte_start":19,"column_end":6,"column_start":5,"expansion":null,"file_name":"src/main.rs","is_primary":true,"label":null,"line_end":2,"line_start":2,"suggested_replacement":null,"suggestion_applicability":null,"text":[]}]}}"#;
        let summary = r#"{"reason":"compiler-message","manifest_path":"/w/Cargo.toml","message":{"rendered":"error: aborting due to 1 previous error\n","children":[],"code":null,"level":"error","message":"aborting due to 1 previous error","spans":[]}}"#;
        let artifact = r#"{"reason":"compiler-artifact","package_id":"p"}"#;
        let mut p = OutputParser::new(Format::Cargo);
        let a = p.feed(err);
        assert_eq!(a.console.as_deref(), Some("error[E0425]: cannot find value `x`\n --> src/main.rs:2:5\n"));
        let m = &a.messages[0];
        assert_eq!(pos(m), (Severity::Error, "src/main.rs", 2, Some(5)));
        assert_eq!((m.end_line, m.end_col, m.code.as_deref()), (Some(2), Some(6), Some("E0425")));
        assert_eq!(m.base.as_deref(), Some("/w/crates/p"));
        let s = p.feed(summary);
        assert!(s.messages.is_empty());
        assert_eq!(s.console.as_deref(), Some("error: aborting due to 1 previous error\n"));
        let a = p.feed(artifact);
        assert!(a.messages.is_empty() && a.console.as_deref() == Some(""));
        let plain = p.feed("   Compiling p v0.1.0 (/w/crates/p)");
        assert!(plain.messages.is_empty() && plain.console.is_none());
    }

    #[test]
    fn tsc_plain_and_pretty() {
        let out = parse(
            Format::Tsc,
            "src/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.\n\
             src/b.ts(3,1): error TS2345: Argument of type 'A' is not assignable to parameter of type 'B'.\n\
             \x20 Property 'x' is missing in type 'A'.\n\
             \x1b[96msrc/c.tsx\x1b[0m:\x1b[93m7\x1b[0m:\x1b[93m10\x1b[0m - \x1b[91merror\x1b[0m\x1b[90m TS2304: \x1b[0mCannot find name 'foo'.\n\
             \n\
             Found 3 errors in 3 files.\n",
        );
        assert_eq!(out.len(), 3, "{out:?}");
        assert_eq!(pos(&out[0]), (Severity::Error, "src/a.ts", 12, Some(5)));
        assert_eq!(out[0].code.as_deref(), Some("TS2322"));
        assert_eq!(out[0].unit, ColUnit::Utf16);
        assert!(out[1].text.ends_with("\nProperty 'x' is missing in type 'A'."));
        assert_eq!(pos(&out[2]), (Severity::Error, "src/c.tsx", 7, Some(10)));
        assert_eq!(out[2].text, "Cannot find name 'foo'.");
    }

    #[test]
    fn gcc_errors_and_warnings() {
        let out = parse(
            Format::Gcc,
            "[1/2] Building CXX object CMakeFiles/app.dir/main.cpp.o\n\
             /p/src/main.cpp:12:5: error: use of undeclared identifier 'foo'\n\
             \x20  12 |     foo();\n\
             /p/src/util.h:3:10: warning: unused variable 'x' [-Wunused-variable]\n\
             /p/src/main.cpp:4:10: fatal error: 'missing.h' file not found\n\
             /p/src/main.cpp:2:1: note: in file included from here\n",
        );
        assert_eq!(out.len(), 3, "{out:?}");
        assert_eq!(out[0].severity, Severity::Error);
        assert_eq!(out[0].text, "use of undeclared identifier 'foo'");
        assert_eq!(out[1].severity, Severity::Warning);
        assert_eq!(out[2].text, "'missing.h' file not found");
    }

    #[test]
    fn go_errors() {
        let out = parse(
            Format::Go,
            "# example.com/demo\n\
             ./main.go:12:5: undefined: foo\n\
             pkg/util.go:3:2: \"fmt\" imported and not used\n\
             note: module requires Go 1.22\n",
        );
        assert_eq!(out.len(), 2, "{out:?}");
        assert_eq!(pos(&out[0]), (Severity::Error, "./main.go", 12, Some(5)));
        assert_eq!(out[0].text, "undefined: foo");
        assert_eq!(out[1].unit, ColUnit::Byte);
        assert_eq!(pos(&out[1]), (Severity::Error, "pkg/util.go", 3, Some(2)));
    }

    #[test]
    fn helpers() {
        assert_eq!(strip_ansi("\x1b[1;31merror\x1b[0m: x"), "error: x");
        assert_eq!(from_file_uri("file:///a/b%20c.kt"), "/a/b c.kt");
        assert_eq!(from_file_uri("file:///C:/a.kt"), "C:/a.kt");
        assert_eq!(path_line_col("C:\\a\\b.go:3:4: x"), Some(("C:\\a\\b.go", 3, Some(4), ": x")));
        assert_eq!(path_line_col("no position here"), None);
    }
}
