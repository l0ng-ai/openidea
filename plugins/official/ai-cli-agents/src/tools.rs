//! The MCP tools. Output is plain text an agent reads well, paths relative to
//! the project root, lines and columns 1-based (as editors show them), and
//! bounded: a long result says how to ask for the rest.

use openidea_plugin::{Error, Invocation, Project, SearchOptions, Severity, host};
use serde_json::Value;

/// Most characters a tool returns.
const MAX_OUTPUT: usize = 100_000;
/// Most lines `read_file` returns per call.
const MAX_READ_LINES: usize = 2000;
/// Longest line shown (search matches, file lines).
const MAX_LINE: usize = 2000;
const MAX_MATCH_LINE: usize = 300;

pub fn call(name: &str, arguments: &str, ctx: &Invocation) -> Result<String, Error> {
    let args: Value = if arguments.trim().is_empty() {
        Value::Object(Default::default())
    } else {
        serde_json::from_str(arguments).map_err(|e| Error::Invalid(format!("arguments: {e}")))?
    };
    let project = ctx.project().ok_or_else(|| Error::Failed("no project is open in OpenIDEA here".into()))?;
    let root = project.root()?;
    let out = match name {
        "get_open_files" => open_files(&project, &root, ctx)?,
        "get_current_selection" => selection(&root, ctx)?,
        "read_file" => read_file(&project, &root, &args)?,
        "find_files" => find_files(&project, &root, &args)?,
        "search_text" => search_text(&project, &root, &args)?,
        "get_problems" => problems(&project, &root, &args)?,
        "open_file" => open_file(&root, &args)?,
        "git_status" => git_status(&project)?,
        _ => return Err(Error::NotFound(format!("tool {name}"))),
    };
    Ok(clip_output(out))
}

fn string<'a>(args: &'a Value, key: &str) -> Result<Option<&'a str>, Error> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s)),
        Some(_) => Err(Error::Invalid(format!("{key}: expected a string"))),
    }
}

fn required<'a>(args: &'a Value, key: &str) -> Result<&'a str, Error> {
    string(args, key)?.filter(|s| !s.is_empty()).ok_or_else(|| Error::Invalid(format!("{key} is required")))
}

fn number(args: &Value, key: &str, default: u64, max: u64) -> Result<u64, Error> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(v) => v
            .as_u64()
            .filter(|n| *n >= 1)
            .map(|n| n.min(max))
            .ok_or_else(|| Error::Invalid(format!("{key}: expected a positive integer"))),
    }
}

fn flag(args: &Value, key: &str) -> Result<bool, Error> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(b)) => Ok(*b),
        Some(_) => Err(Error::Invalid(format!("{key}: expected true or false"))),
    }
}

/// `path` relative to `root` when inside it.
fn relative(root: &str, path: &str) -> String {
    let root = root.trim_end_matches('/');
    match path.strip_prefix(root).and_then(|r| r.strip_prefix('/')) {
        Some(rel) if !rel.is_empty() => rel.to_owned(),
        _ => path.to_owned(),
    }
}

/// An argument path as the host takes it: absolute, or relative to `root`.
fn absolute(root: &str, path: &str) -> String {
    if path.starts_with('/') || path.get(1..3) == Some(":/") || path.get(1..3) == Some(":\\") {
        path.to_owned()
    } else {
        format!("{}/{}", root.trim_end_matches('/'), path.trim_start_matches("./"))
    }
}

fn clip_line(line: &str, max: usize) -> String {
    match line.char_indices().nth(max) {
        Some((at, _)) => format!("{}…", &line[..at]),
        None => line.to_owned(),
    }
}

fn clip_output(mut out: String) -> String {
    if out.len() > MAX_OUTPUT {
        let mut at = MAX_OUTPUT;
        while !out.is_char_boundary(at) {
            at -= 1;
        }
        out.truncate(at);
        out.push_str("\n… (output cut at 100 000 characters: narrow the request)");
    }
    out
}

fn open_files(project: &Project, root: &str, ctx: &Invocation) -> Result<String, Error> {
    let focused = ctx.editor().map(|e| e.path());
    let mut paths = project.open_editors()?;
    if let Some(f) = &focused {
        paths.retain(|p| p != f);
        paths.insert(0, f.clone());
    }
    if paths.is_empty() {
        return Ok("No files are open in the editor.".into());
    }
    let lines: Vec<String> = paths
        .iter()
        .map(|p| {
            let rel = relative(root, p);
            if Some(p) == focused.as_ref() { format!("{rel} (focused)") } else { rel }
        })
        .collect();
    Ok(lines.join("\n"))
}

fn selection(root: &str, ctx: &Invocation) -> Result<String, Error> {
    let Some(editor) = ctx.editor() else { return Ok("No file is focused in the editor.".into()) };
    let text = editor.document()?.text;
    let selections: Vec<Value> = editor
        .selections()?
        .into_iter()
        .map(|r| {
            let start = openidea_plugin::text::offset(&text, r.start).unwrap_or(text.len());
            let end = openidea_plugin::text::offset(&text, r.end).unwrap_or(text.len()).max(start);
            let selected = &text[start..end];
            let mut v = serde_json::json!({
                "start": { "line": r.start.line + 1, "column": r.start.character + 1 },
                "end": { "line": r.end.line + 1, "column": r.end.character + 1 },
                "text": clip_line(selected, 20_000),
            });
            if selected.chars().count() > 20_000 {
                v["truncated"] = Value::Bool(true);
            }
            v
        })
        .collect();
    let out = serde_json::json!({
        "path": relative(root, &editor.path()),
        "language": editor.language(),
        "selections": selections,
    });
    Ok(serde_json::to_string_pretty(&out).unwrap_or_default())
}

fn read_file(project: &Project, root: &str, args: &Value) -> Result<String, Error> {
    let path = required(args, "path")?;
    let text = project.read_file(&absolute(root, path))?;
    let total = text.lines().count();
    let start = number(args, "start_line", 1, u64::MAX)? as usize;
    let wanted = (number(args, "end_line", u64::MAX, u64::MAX)? as usize).min(total);
    let end = wanted.min(start.saturating_add(MAX_READ_LINES - 1));
    if total == 0 {
        return Ok(format!("{} is empty.", relative(root, path)));
    }
    if start > total {
        return Err(Error::Invalid(format!("start_line {start}: the file has {total} lines")));
    }
    let mut out = String::new();
    for (i, line) in text.lines().enumerate().skip(start - 1).take(end + 1 - start) {
        out.push_str(&format!("{:>6}\t{}\n", i + 1, clip_line(line, MAX_LINE)));
        if out.len() > MAX_OUTPUT - 200 {
            out.push_str(&format!("… (cut at line {}; continue with start_line={})\n", i + 1, i + 2));
            return Ok(out);
        }
    }
    if end < wanted {
        out.push_str(&format!("… ({total} lines; continue with start_line={})\n", end + 1));
    }
    Ok(out)
}

fn find_files(project: &Project, root: &str, args: &Value) -> Result<String, Error> {
    let pattern = required(args, "pattern")?.trim_start_matches("./");
    let limit = number(args, "limit", 200, 2000)? as u32;
    let glob = if pattern.contains('/') { pattern.to_owned() } else { format!("**/{pattern}") };
    let found = project.find_files(&glob, limit.saturating_add(1))?;
    if found.is_empty() {
        return Ok(format!("No files match {pattern}."));
    }
    let more = found.len() > limit as usize;
    let mut lines: Vec<String> = found.iter().take(limit as usize).map(|p| relative(root, p)).collect();
    if more {
        lines.push(format!("… (more than {limit}: narrow the pattern or raise limit)"));
    }
    Ok(lines.join("\n"))
}

fn search_text(project: &Project, root: &str, args: &Value) -> Result<String, Error> {
    let query = required(args, "query")?;
    let limit = number(args, "limit", 100, 1000)? as u32;
    let globs = match args.get("glob") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::String(s)) => vec![s.clone()],
        Some(Value::Array(items)) => items.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect(),
        Some(_) => return Err(Error::Invalid("glob: expected a list of file masks".into())),
    };
    let options = SearchOptions {
        regex: flag(args, "regex")?,
        case_sensitive: flag(args, "case_sensitive")?,
        whole_word: flag(args, "whole_word")?,
        globs,
        limit: limit + 1,
    };
    let found = project.search_text(query, &options)?;
    if found.is_empty() {
        return Ok(format!("No matches for {query:?}."));
    }
    let more = found.len() > limit as usize;
    let mut lines: Vec<String> = found
        .iter()
        .take(limit as usize)
        .map(|m| {
            let text = clip_line(m.text.trim(), MAX_MATCH_LINE);
            format!("{}:{}:{}: {text}", relative(root, &m.path), m.line + 1, m.start + 1)
        })
        .collect();
    if more {
        lines.push(format!("… (more than {limit} matches: narrow the query or glob, or raise limit)"));
    }
    Ok(lines.join("\n"))
}

fn severity_name(s: Severity) -> &'static str {
    match s {
        Severity::Error => "error",
        Severity::Warning => "warning",
        Severity::Info => "info",
        Severity::Hint => "hint",
    }
}

fn problems(project: &Project, root: &str, args: &Value) -> Result<String, Error> {
    let path = string(args, "path")?.filter(|p| !p.is_empty()).map(|p| absolute(root, p));
    let errors_only = flag(args, "errors_only")?;
    let limit = number(args, "limit", 200, 2000)? as usize;
    let mut found = project.problems(path.as_deref())?;
    if errors_only {
        found.retain(|p| p.severity == Severity::Error);
    }
    found.sort_by_key(|p| (p.severity as u8, p.path.clone(), p.range.start.line, p.range.start.character));
    let count = |s: Severity| found.iter().filter(|p| p.severity == s).count();
    let (errors, warnings) = (count(Severity::Error), count(Severity::Warning));
    let others = found.len() - errors - warnings;
    let scope = path.as_deref().map_or_else(|| "the project".to_owned(), |p| relative(root, p));
    if found.is_empty() {
        return Ok(format!("No problems in {scope}."));
    }
    let mut out = vec![format!("{errors} errors, {warnings} warnings, {others} other problems in {scope}")];
    for p in found.iter().take(limit) {
        let origin = match (&p.source, &p.code) {
            (Some(s), Some(c)) => format!(" [{s} {c}]"),
            (Some(s), None) => format!(" [{s}]"),
            (None, Some(c)) => format!(" [{c}]"),
            (None, None) => String::new(),
        };
        let message = clip_line(&p.message.replace('\n', " "), 500);
        out.push(format!(
            "{}:{}:{}: {}{origin}: {message}",
            relative(root, &p.path),
            p.range.start.line + 1,
            p.range.start.character + 1,
            severity_name(p.severity),
        ));
    }
    if found.len() > limit {
        out.push(format!("… ({} more: ask for one path, errors_only, or a higher limit)", found.len() - limit));
    }
    Ok(out.join("\n"))
}

fn open_file(root: &str, args: &Value) -> Result<String, Error> {
    let path = required(args, "path")?;
    let line = number(args, "line", 1, u32::MAX as u64)? as u32;
    let column = number(args, "column", 1, u32::MAX as u64)? as u32;
    host::open_location(&absolute(root, path), line - 1, column - 1)?;
    Ok(format!("Opened {}:{line}:{column} in the editor.", relative(root, path)))
}

fn git_status(project: &Project) -> Result<String, Error> {
    let Some(s) = project.vcs_status()? else { return Ok("The project is not in a git repository.".into()) };
    let mut out = vec![format!("repository: {}", s.root)];
    out.push(match (&s.branch, &s.commit) {
        (Some(b), _) => format!("branch: {b}"),
        (None, Some(c)) => format!("detached HEAD at {c}"),
        (None, None) => "no commits yet".into(),
    });
    if let (Some(_), Some(c)) = (&s.branch, &s.commit) {
        out.push(format!("commit: {c}"));
    }
    match &s.upstream {
        Some(u) => out.push(format!("upstream: {u} (ahead {}, behind {})", s.ahead, s.behind)),
        None => out.push("upstream: none".into()),
    }
    if let Some(op) = &s.operation {
        out.push(format!("in progress: {op}"));
    }
    out.push(format!("changed files: {}", s.changed_files));
    Ok(out.join("\n"))
}
