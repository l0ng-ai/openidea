//! External static analysers: PHPStan and Psalm from the project's
//! `vendor/bin`.
//!
//! The host runs one on a saved file (`ide-host` `php_analyzers`) when
//! Settings › PHP › External Analyzers asks for it; this module knows what is
//! installed ([`detect`]), how to start it ([`Analyzer::args`]), how to read
//! its JSON report ([`Analyzer::parse`]) and which of its problems the engine
//! already reports ([`remove_duplicates`]).
//!
//! The report formats are the tools' documented JSON outputs:
//! `phpstan analyse --error-format=json` (`files` → path → `messages` with
//! `message`, `line`, `identifier`, `tip`) and `psalm --output-format=json`
//! (an array of issues with `severity`, `type`, `message`, `file_path`,
//! `line_from`/`column_from`, `line_to`/`column_to`; columns are 1-based
//! byte columns).

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use ide_core::{Diagnostic, Pos, Range, Severity};
use serde_json::Value;

/// A static analyser the project can install with Composer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Analyzer {
    PhpStan,
    Psalm,
}

impl Analyzer {
    pub const ALL: [Analyzer; 2] = [Analyzer::PhpStan, Analyzer::Psalm];

    /// The diagnostics source its problems are published under.
    pub fn source(self) -> &'static str {
        match self {
            Analyzer::PhpStan => "phpstan",
            Analyzer::Psalm => "psalm",
        }
    }

    /// `vendor/bin/<tool>`: Composer's proxy, a PHP script on every platform.
    pub fn script(self, root: &Path) -> PathBuf {
        root.join("vendor").join("bin").join(self.source())
    }

    /// Installed in the project and ready to run: PHPStan reads its
    /// `phpstan.neon` itself (or runs at its default level without one);
    /// Psalm refuses to run without a `psalm.xml`, so it also needs one.
    pub fn available(self, root: &Path) -> bool {
        self.script(root).is_file()
            && match self {
                Analyzer::PhpStan => true,
                Analyzer::Psalm => root.join("psalm.xml").is_file() || root.join("psalm.xml.dist").is_file(),
            }
    }

    /// The arguments after `php <script>` that analyse `file` alone and print
    /// the JSON report on stdout.
    pub fn args(self, file: &Path) -> Vec<OsString> {
        let flags: &[&str] = match self {
            Analyzer::PhpStan => &["analyse", "--error-format=json", "--no-progress", "--no-interaction", "--no-ansi"],
            Analyzer::Psalm => &["--output-format=json", "--no-progress", "--monochrome"],
        };
        let mut args: Vec<OsString> = flags.iter().map(OsString::from).collect();
        args.push(file.as_os_str().to_owned());
        args
    }

    /// The problems the report `stdout` lists for `file` (whose saved text is
    /// `text`), as diagnostics with UTF-16 ranges. Relative paths in the
    /// report are relative to `root`. An error when `stdout` holds no report.
    pub fn parse(self, stdout: &str, file: &Path, root: &Path, text: &str) -> Result<Vec<Diagnostic>, String> {
        let report = json_report(stdout, if self == Analyzer::PhpStan { '{' } else { '[' })
            .ok_or_else(|| format!("{} printed no JSON report", self.source()))?;
        let lines = Lines::new(text);
        let same = |reported: &str| same_file(reported, file, root);
        let mut out = match self {
            Analyzer::PhpStan => phpstan(&report, &same, &lines, self.source()),
            Analyzer::Psalm => psalm(&report, &same, &lines, self.source()),
        };
        out.sort_by_key(|d| (d.range.start.line, d.range.start.col));
        Ok(out)
    }
}

/// The analysers installed in the project at `root` ([`Analyzer::available`]).
pub fn detect(root: &Path) -> Vec<Analyzer> {
    Analyzer::ALL.into_iter().filter(|a| a.available(root)).collect()
}

/// The JSON value of `stdout`: all of it, or (when PHP printed notices
/// before it) from the first line that starts with `open`.
fn json_report(stdout: &str, open: char) -> Option<Value> {
    if let Ok(value) = serde_json::from_str::<Value>(stdout.trim()) {
        return Some(value);
    }
    let mut offset = 0;
    for line in stdout.split_inclusive('\n') {
        if line.trim_start().starts_with(open)
            && let Ok(value) = serde_json::from_str::<Value>(stdout[offset..].trim())
        {
            return Some(value);
        }
        offset += line.len();
    }
    None
}

fn phpstan(report: &Value, same: &dyn Fn(&str) -> bool, lines: &Lines, source: &str) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    let Some(files) = report.get("files").and_then(Value::as_object) else { return out };
    for (reported, entry) in files {
        // Problems found in a trait are listed per using class:
        // `Trait.php (in context of class App\Foo)`.
        let path = reported.split(" (in context of ").next().unwrap_or(reported);
        if !same(path) {
            continue;
        }
        for message in entry.get("messages").and_then(Value::as_array).into_iter().flatten() {
            let Some(text) = message.get("message").and_then(Value::as_str) else { continue };
            let line = message.get("line").and_then(Value::as_u64).map_or(0, |l| l.saturating_sub(1) as u32);
            let mut text = text.to_owned();
            if let Some(tip) = message.get("tip").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                text.push('\n');
                text.push_str(&strip_console_tags(tip));
            }
            let code = message.get("identifier").and_then(Value::as_str).map(str::to_owned);
            out.push(diagnostic(lines.whole_line(line), Severity::Error, text, code, source));
        }
    }
    out
}

fn psalm(report: &Value, same: &dyn Fn(&str) -> bool, lines: &Lines, source: &str) -> Vec<Diagnostic> {
    let mut out = Vec::new();
    for issue in report.as_array().into_iter().flatten() {
        let path = issue.get("file_path").or_else(|| issue.get("file_name")).and_then(Value::as_str);
        if !path.is_some_and(same) {
            continue;
        }
        let Some(text) = issue.get("message").and_then(Value::as_str) else { continue };
        let number = |key: &str| issue.get(key).and_then(Value::as_u64).map(|n| n.saturating_sub(1) as u32);
        let range = match (number("line_from"), number("column_from")) {
            (Some(line), Some(col)) => {
                let start = lines.pos(line, col);
                let end = match (number("line_to"), number("column_to")) {
                    (Some(l), Some(c)) => lines.pos(l, c),
                    _ => start,
                };
                Range { start, end: if end < start { start } else { end } }
            }
            (Some(line), None) => lines.whole_line(line),
            _ => lines.whole_line(0),
        };
        let severity = match issue.get("severity").and_then(Value::as_str) {
            Some("info") => Severity::Warning,
            _ => Severity::Error,
        };
        let code = issue.get("type").and_then(Value::as_str).map(str::to_owned);
        out.push(diagnostic(range, severity, text.to_owned(), code, source));
    }
    out
}

fn diagnostic(range: Range, severity: Severity, message: String, code: Option<String>, source: &str) -> Diagnostic {
    Diagnostic {
        range,
        severity,
        message,
        source: Some(source.to_owned()),
        code,
        unnecessary: false,
        deprecated: false,
        server: Some(source.to_owned()),
    }
}

/// PHPStan tips carry Symfony console markup (`<fg=cyan>…</>`).
fn strip_console_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('<') {
        out.push_str(&rest[..at]);
        let tail = &rest[at..];
        let tag = tail.find('>').map(|end| &tail[..=end]);
        match tag {
            Some(tag)
                if tag == "</>"
                    || tag.starts_with("<fg=")
                    || tag.starts_with("<bg=")
                    || tag.starts_with("<options=") =>
            {
                rest = &tail[tag.len()..];
            }
            _ => {
                out.push('<');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Whether the path a report names is `file`.
fn same_file(reported: &str, file: &Path, root: &Path) -> bool {
    let reported = Path::new(reported);
    let reported = if reported.is_absolute() { reported.to_path_buf() } else { root.join(reported) };
    let key = |p: &Path| {
        let p = crate::project::normalize(p);
        let text = p.to_string_lossy().replace('\\', "/");
        if cfg!(windows) { text.to_lowercase() } else { text }
    };
    if key(&reported) == key(file) {
        return true;
    }
    // Symlinked or differently spelled paths (`/private/var` on macOS).
    match (std::fs::canonicalize(&reported), std::fs::canonicalize(file)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// The saved text's lines, for byte columns → UTF-16 columns.
struct Lines<'a> {
    lines: Vec<&'a str>,
}

impl<'a> Lines<'a> {
    fn new(text: &'a str) -> Self {
        Self { lines: text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect() }
    }

    fn line(&self, line: u32) -> &'a str {
        self.lines.get(line as usize).copied().unwrap_or("")
    }

    /// The line from its first non-blank character to its end.
    fn whole_line(&self, line: u32) -> Range {
        let text = self.line(line);
        let indent = text.len() - text.trim_start().len();
        let start = utf16_len(&text[..indent]);
        let end = utf16_len(text.trim_end());
        Range { start: Pos { line, col: start }, end: Pos { line, col: end.max(start) } }
    }

    /// Byte column `col` of `line` in UTF-16, clamped to the line.
    fn pos(&self, line: u32, col: u32) -> Pos {
        let text = self.line(line);
        let mut byte = (col as usize).min(text.len());
        while !text.is_char_boundary(byte) {
            byte -= 1;
        }
        Pos { line, col: utf16_len(&text[..byte]) }
    }
}

fn utf16_len(text: &str) -> u32 {
    text.encode_utf16().count() as u32
}

/// Drops the analyser's problems that the engine already reports: one of the
/// engine's diagnostics starts on a line the problem covers and both name
/// the same thing (a class, member, function or variable name, compared
/// without namespace, `$` or case), or both are syntax errors.
pub fn remove_duplicates(external: &mut Vec<Diagnostic>, engine: &[Diagnostic]) {
    if engine.is_empty() {
        return;
    }
    let engine: Vec<(&Diagnostic, Vec<String>)> = engine.iter().map(|d| (d, quoted_subjects(&d.message))).collect();
    external.retain(|problem| {
        let lines = problem.range.start.line..=problem.range.end.line;
        let names = subjects(&problem.message);
        !engine.iter().any(|(own, own_names)| {
            lines.contains(&own.range.start.line)
                && ((is_syntax_error(own) && is_syntax_error(problem)) || own_names.iter().any(|n| names.contains(n)))
        })
    })
}

fn is_syntax_error(diagnostic: &Diagnostic) -> bool {
    let message = diagnostic.message.to_ascii_lowercase();
    message.contains("syntax error") || message.contains("parse error") || message.starts_with("expected ")
}

/// Words of a problem message too common to identify what it is about.
const COMMON: &[&str] = &[
    "an",
    "and",
    "argument",
    "array",
    "as",
    "at",
    "be",
    "bool",
    "but",
    "by",
    "call",
    "callable",
    "can",
    "cannot",
    "class",
    "constant",
    "does",
    "enum",
    "exist",
    "expects",
    "false",
    "find",
    "float",
    "for",
    "found",
    "function",
    "given",
    "has",
    "if",
    "in",
    "int",
    "interface",
    "invalid",
    "is",
    "it",
    "iterable",
    "method",
    "might",
    "mixed",
    "named",
    "never",
    "no",
    "not",
    "null",
    "object",
    "of",
    "on",
    "or",
    "parameter",
    "property",
    "referenced",
    "return",
    "returns",
    "self",
    "should",
    "static",
    "string",
    "the",
    "this",
    "to",
    "trait",
    "true",
    "type",
    "undefined",
    "unknown",
    "unused",
    "variable",
    "void",
    "with",
];

/// The names the engine's message quotes (`Undefined method 'bar'`), or all
/// its [`subjects`] when it quotes none.
fn quoted_subjects(message: &str) -> Vec<String> {
    let quoted: Vec<&str> = message.split('\'').skip(1).step_by(2).collect();
    if quoted.is_empty() {
        return subjects(message);
    }
    let mut out = Vec::new();
    for name in quoted {
        for subject in words(name) {
            if !out.contains(&subject) {
                out.push(subject);
            }
        }
    }
    out
}

/// The names a message mentions: identifier-like words, without namespace
/// or `$`, lowercased, minus the [`COMMON`] words.
fn subjects(message: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for word in message.split_whitespace() {
        // `$a` names a variable; a lone `a` is an article.
        let variable = word.trim_start_matches(|c: char| !c.is_alphanumeric() && c != '$').starts_with('$');
        for name in words(word) {
            let short = name.chars().count() < 2 && !variable;
            if !short && !COMMON.contains(&name.as_str()) && !out.contains(&name) {
                out.push(name);
            }
        }
    }
    out
}

/// Identifier-like words of `text`, without namespace or `$`, lowercased.
fn words(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for word in text.split(|c: char| !(c.is_alphanumeric() || c == '_' || c == '\\' || c == '$')) {
        let name = word.rsplit('\\').next().unwrap_or(word).trim_start_matches('$').to_lowercase();
        if !name.is_empty() && !name.chars().all(|c| c.is_ascii_digit()) {
            out.push(name);
        }
    }
    out
}

#[cfg(test)]
mod tests;
