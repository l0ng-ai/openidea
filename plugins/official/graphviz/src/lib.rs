//! Graphviz for OpenIDEA: `.dot` / `.gv` files open in the text editor with a
//! live preview beside them. The preview is a web page (`web-src/`: viz.js,
//! Graphviz compiled to WebAssembly) that renders the document as it changes;
//! what Graphviz reports it sends here, and the plugin publishes it as the
//! file's problems, on the line Graphviz names.

use openidea_plugin::views::{View, ViewEvent, Viewport, Views};
use openidea_plugin::{Diagnostic, Error, Invocation, Plugin, Position, Range, Severity, host, register_plugin};
use serde_json::Value;

pub const VIEW: &str = "preview";
/// Problems published for one file at most.
const MAX_PROBLEMS: usize = 100;

/// One message from Graphviz, as the page reports it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Report {
    /// 1-based, when Graphviz names one.
    pub line: Option<u32>,
    pub message: String,
    pub error: bool,
}

/// The page's `{"op": "problems", "items": [{"line", "message", "level"}]}`.
pub fn parse_reports(message: &str) -> Option<Vec<Report>> {
    let v: Value = serde_json::from_str(message).ok()?;
    if v.get("op").and_then(Value::as_str) != Some("problems") {
        return None;
    }
    let items = v.get("items")?.as_array()?;
    Some(
        items
            .iter()
            .take(MAX_PROBLEMS)
            .filter_map(|i| {
                Some(Report {
                    line: i.get("line").and_then(Value::as_u64).and_then(|l| u32::try_from(l).ok()),
                    message: i.get("message")?.as_str()?.trim().to_owned(),
                    error: i.get("level").and_then(Value::as_str) != Some("warning"),
                })
            })
            .collect(),
    )
}

/// `reports` as diagnostics of `text`: on the named line (clamped to the
/// document), the whole of it; without a line, on the first.
pub fn diagnostics(text: &str, reports: &[Report]) -> Vec<Diagnostic> {
    let lines: Vec<&str> = text.lines().collect();
    reports
        .iter()
        .map(|r| {
            let line = r.line.map_or(0, |l| l.saturating_sub(1)).min(lines.len().saturating_sub(1) as u32);
            let len = lines.get(line as usize).map_or(0, |l| l.encode_utf16().count() as u32);
            Diagnostic {
                range: Range::new(Position::new(line, 0), Position::new(line, len)),
                severity: if r.error { Severity::Error } else { Severity::Warning },
                message: r.message.clone(),
                code: Some("graphviz".into()),
            }
        })
        .collect()
}

#[derive(Default)]
pub struct Graphviz;

impl Plugin for Graphviz {
    fn run_command(&mut self, id: &str, _ctx: &Invocation, _arg: Option<&str>) -> Result<Option<String>, Error> {
        Err(Error::NotFound(format!("command {id}")))
    }
}

impl Views for Graphviz {
    fn render(&mut self, view: &str, _viewport: Option<Viewport>, _ctx: &Invocation) -> Result<View, Error> {
        if view != VIEW {
            return Err(Error::NotFound(view.into()));
        }
        // The preview is the plugin's web page; nothing is rendered here.
        Ok(View::message("The preview is shown by the plugin's page."))
    }

    fn handle(&mut self, view: &str, event: ViewEvent, ctx: &Invocation) -> Result<(), Error> {
        if view != VIEW {
            return Err(Error::NotFound(view.into()));
        }
        let ViewEvent::Message(message) = event else { return Ok(()) };
        let Some(reports) = parse_reports(&message) else { return Ok(()) };
        let editor = ctx.editor().ok_or_else(|| Error::Invalid("the preview needs its document".into()))?;
        let text = editor.document()?.text;
        // A file outside the open projects has no problems to publish to; its
        // preview shows what went wrong anyway.
        match host::publish_diagnostics(&editor.path(), &diagnostics(&text, &reports)) {
            Err(Error::Invalid(_)) => Ok(()),
            other => other,
        }
    }
}

register_plugin!(Graphviz, views);

#[cfg(test)]
mod tests {
    use super::*;
    use openidea_plugin::mock::MockHost;

    #[test]
    fn reports_become_problems_on_their_line() {
        let msg = r#"{"op":"problems","items":[
            {"line":2,"message":"syntax error in line 2 near '}'","level":"error"},
            {"line":null,"message":"Warning: no such engine","level":"warning"},
            {"line":99,"message":"past the end"},
            {"nope":1}
        ]}"#;
        let reports = parse_reports(msg).unwrap();
        assert_eq!(reports.len(), 3);
        let d = diagnostics("digraph {\n  a -> }\n", &reports);
        assert_eq!(
            (d[0].range, d[0].severity),
            (Range::new(Position::new(1, 0), Position::new(1, 8)), Severity::Error)
        );
        assert_eq!((d[1].range.start.line, d[1].severity), (0, Severity::Warning));
        assert_eq!(d[2].range.start.line, 1, "clamped to the last line");
        assert!(parse_reports(r#"{"op":"other"}"#).is_none());
        assert!(parse_reports("garbage").is_none());
        assert!(diagnostics("", &reports).iter().all(|d| d.range.start.line == 0));
    }

    #[test]
    fn publishes_for_the_previewed_file_and_clears() {
        let host = MockHost::install().with_capabilities(&["editor.read", "project.read"]);
        host.open_editor("/project/a.dot", "dot", "digraph {\n a -> \n}\n", &[(0, 0, 0, 0)]);
        let mut p = Graphviz;
        let msg =
            r#"{"op":"problems","items":[{"line":3,"message":"syntax error in line 3 near '}'","level":"error"}]}"#;
        p.handle(VIEW, ViewEvent::Message(msg.into()), &host.invocation()).unwrap();
        assert_eq!(host.diagnostics()["/project/a.dot"][0].range.start.line, 2);
        p.handle(VIEW, ViewEvent::Message(r#"{"op":"problems","items":[]}"#.into()), &host.invocation()).unwrap();
        assert!(host.diagnostics().get("/project/a.dot").is_none_or(Vec::is_empty));
    }
}
