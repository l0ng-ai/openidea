//! Views and custom editors (`[[contributes.views]]`,
//! `[[contributes.customEditors]]`): implement [`Views`] and register with
//! `register_plugin!(MyPlugin, views)`.
//!
//! A view is data — a toolbar, a body (tree, list, form, table, message or
//! sandboxed HTML) and a status line. The IDE renders it and calls
//! [`Views::handle`] with what the user did; call [`crate::host::refresh_view`]
//! when the content changes. For a custom editor, `ctx.editor()` is its
//! document: read it with `document()` and change it with `apply_edits`, so
//! the text editor of the same file follows and undo is shared.

use crate::{Error, Invocation};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Button {
    pub id: String,
    pub label: String,
    /// An IDE icon (`refresh`, `add`, `remove`, `run`, `stop`, `settings`…).
    pub icon: Option<String>,
    pub enabled: bool,
}

impl Button {
    pub fn new(id: &str, label: &str) -> Self {
        Self { id: id.into(), label: label.into(), icon: None, enabled: true }
    }

    pub fn icon(mut self, icon: &str) -> Self {
        self.icon = Some(icon.into());
        self
    }

    pub fn enabled(mut self, enabled: bool) -> Self {
        self.enabled = enabled;
        self
    }
}

/// A tree node; `parent` is the key of an item listed before it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TreeItem {
    pub key: String,
    pub parent: Option<String>,
    pub label: String,
    pub icon: Option<String>,
    pub detail: Option<String>,
    /// Shows an expander before the children are known ([`ViewEvent::Expand`]).
    pub expandable: bool,
    pub expanded: bool,
}

impl TreeItem {
    pub fn new(key: &str, label: &str) -> Self {
        Self {
            key: key.into(),
            parent: None,
            label: label.into(),
            icon: None,
            detail: None,
            expandable: false,
            expanded: false,
        }
    }

    pub fn parent(mut self, parent: &str) -> Self {
        self.parent = Some(parent.into());
        self
    }

    pub fn icon(mut self, icon: &str) -> Self {
        self.icon = Some(icon.into());
        self
    }

    pub fn detail(mut self, detail: &str) -> Self {
        self.detail = Some(detail.into());
        self
    }

    /// Has (or may have) children; `expanded` shows them.
    pub fn expandable(mut self, expanded: bool) -> Self {
        self.expandable = true;
        self.expanded = expanded;
        self
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListItem {
    pub key: String,
    pub label: String,
    pub icon: Option<String>,
    pub detail: Option<String>,
}

impl ListItem {
    pub fn new(key: &str, label: &str) -> Self {
        Self { key: key.into(), label: label.into(), icon: None, detail: None }
    }

    pub fn icon(mut self, icon: &str) -> Self {
        self.icon = Some(icon.into());
        self
    }

    pub fn detail(mut self, detail: &str) -> Self {
        self.detail = Some(detail.into());
        self
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum FieldValue {
    Text(String),
    Multiline(String),
    Checkbox(bool),
    /// Options and the chosen one.
    Choice(Vec<String>, String),
    /// A field type of a newer plugin API: its kind and JSON data (IDEs that
    /// don't know it leave the field out).
    Other {
        kind: String,
        data: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Field {
    pub key: String,
    pub label: String,
    pub value: FieldValue,
}

impl Field {
    pub fn new(key: &str, label: &str, value: FieldValue) -> Self {
        Self { key: key.into(), label: label.into(), value }
    }
}

/// Rows `first_row..first_row + rows.len()` of `total_rows`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Table {
    pub columns: Vec<String>,
    pub total_rows: u32,
    pub first_row: u32,
    pub rows: Vec<Vec<String>>,
    pub editable: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum Body {
    Message(String),
    Tree(Vec<TreeItem>),
    List(Vec<ListItem>),
    Form(Vec<Field>),
    Table(Table),
    /// Shown in a sandboxed frame; its script talks to the plugin with
    /// `openidea.postMessage(text)` and `openidea.onMessage(fn)`.
    Html(String),
    /// A body of a newer plugin API: its kind and JSON data (IDEs that don't
    /// know it say they need updating).
    Other {
        kind: String,
        data: String,
    },
}

impl Body {
    /// Read-only text the user can select and copy (`describe` output, a manifest).
    pub fn text(text: &str) -> Self {
        Self::Other { kind: "text".into(), data: format!(r#"{{"text":{}}}"#, json_string(text)) }
    }

    /// A program the IDE runs (with the plugin's `process:<program>` grant, in
    /// the project root), its output streamed into a log; add switches with
    /// [`ProcessBody::toggle`].
    pub fn process(program: &str, args: &[&str]) -> ProcessBody {
        ProcessBody { program: program.into(), args: strings(args), toggles: Vec::new() }
    }

    /// Tabs switched by the IDE: `(id, label, body)`, where a body is a
    /// message, [`Body::text`] or [`Body::process`].
    pub fn tabs(tabs: Vec<(&str, &str, Body)>) -> Self {
        let tabs: Vec<String> = tabs
            .into_iter()
            .map(|(id, label, body)| {
                let body = match body {
                    Body::Message(text) => format!(r#"{{"kind":"message","text":{}}}"#, json_string(&text)),
                    Body::Other { kind, data } => {
                        let fields = data.strip_prefix('{').unwrap_or(&data);
                        format!(r#"{{"kind":{},{fields}"#, json_string(&kind))
                    }
                    // Not allowed in a tab: the IDE shows why.
                    _ => r#"{"kind":"unsupported"}"#.into(),
                };
                format!(r#"{{"id":{},"label":{},"body":{body}}}"#, json_string(id), json_string(label))
            })
            .collect();
        Self::Other { kind: "tabs".into(), data: format!(r#"{{"tabs":[{}]}}"#, tabs.join(",")) }
    }
}

/// A [`Body::process`] being built.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessBody {
    program: String,
    args: Vec<String>,
    toggles: Vec<(String, String, Vec<String>)>,
}

impl ProcessBody {
    /// A switch above the log; when on, `args` are appended and the program restarts.
    pub fn toggle(mut self, id: &str, label: &str, args: &[&str]) -> Self {
        self.toggles.push((id.into(), label.into(), strings(args)));
        self
    }
}

impl From<ProcessBody> for Body {
    fn from(p: ProcessBody) -> Self {
        let toggles: Vec<String> = p
            .toggles
            .iter()
            .map(|(id, label, args)| {
                format!(r#"{{"id":{},"label":{},"args":{}}}"#, json_string(id), json_string(label), json_strings(args))
            })
            .collect();
        let data = format!(
            r#"{{"program":{},"args":{},"toggles":[{}]}}"#,
            json_string(&p.program),
            json_strings(&p.args),
            toggles.join(",")
        );
        Body::Other { kind: "process".into(), data }
    }
}

/// The view and item key of a Services detail pane (`"<view>/<item key>"`),
/// `None` for a view's own id.
pub fn split_detail(view: &str) -> Option<(&str, &str)> {
    view.split_once('/')
}

fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|a| (*a).to_owned()).collect()
}

fn json_strings(items: &[String]) -> String {
    format!("[{}]", items.iter().map(|s| json_string(s)).collect::<Vec<_>>().join(","))
}

fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct View {
    pub toolbar: Vec<Button>,
    pub body: Body,
    pub status: Option<String>,
}

impl View {
    pub fn new(body: Body) -> Self {
        Self { toolbar: Vec::new(), body, status: None }
    }

    pub fn message(text: &str) -> Self {
        Self::new(Body::Message(text.into()))
    }

    pub fn button(mut self, b: Button) -> Self {
        self.toolbar.push(b);
        self
    }

    pub fn status(mut self, status: &str) -> Self {
        self.status = Some(status.into());
        self
    }
}

/// The table rows the IDE shows (ask for no more than these).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Viewport {
    pub first_row: u32,
    pub rows: u32,
}

impl Viewport {
    /// `first_row..end` clamped to `total`.
    pub fn range(viewport: Option<Viewport>, total: u32, default_rows: u32) -> std::ops::Range<u32> {
        let v = viewport.unwrap_or(Viewport { first_row: 0, rows: default_rows });
        let start = v.first_row.min(total);
        start..start.saturating_add(v.rows).min(total)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum ViewEvent {
    Button(String),
    Activate(String),
    Select(String),
    Expand(String),
    Collapse(String),
    /// A form field: key and new value (`true`/`false` for checkboxes).
    Field(String, String),
    Cell {
        row: u32,
        column: u32,
        value: String,
    },
    InsertRow(u32),
    DeleteRows(Vec<u32>),
    Message(String),
    /// An event this SDK doesn't know: its kind and JSON data.
    Other {
        kind: String,
        data: String,
    },
}

/// Content of the plugin's declared views and custom editors.
pub trait Views {
    fn render(&mut self, view: &str, viewport: Option<Viewport>, ctx: &Invocation) -> Result<View, Error>;

    fn handle(&mut self, _view: &str, _event: ViewEvent, _ctx: &Invocation) -> Result<(), Error> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_builders_encode_other_kinds() {
        let log = Body::process("kubectl", &["logs", "x"]).toggle("ts", "Timestamps", &["--timestamps"]);
        let tabs = Body::tabs(vec![("log", "Log", log.into()), ("inspect", "Inspect", Body::text("a: 1"))]);
        assert_eq!(
            tabs,
            Body::Other {
                kind: "tabs".into(),
                data: r#"{"tabs":[{"id":"log","label":"Log","body":{"kind":"process","program":"kubectl","args":["logs","x"],"toggles":[{"id":"ts","label":"Timestamps","args":["--timestamps"]}]}},{"id":"inspect","label":"Inspect","body":{"kind":"text","text":"a: 1"}}]}"#.into(),
            }
        );
        assert_eq!(
            Body::text("a \"b\"\n\\"),
            Body::Other { kind: "text".into(), data: r#"{"text":"a \"b\"\n\\"}"#.into() }
        );
        let message = Body::tabs(vec![("m", "M", Body::Message("\u{1}".into()))]);
        assert_eq!(
            message,
            Body::Other {
                kind: "tabs".into(),
                data: r#"{"tabs":[{"id":"m","label":"M","body":{"kind":"message","text":"\u0001"}}]}"#.into()
            }
        );
    }

    #[test]
    fn detail_ids_split_on_the_first_slash() {
        assert_eq!(split_detail("kube/pod:default/nginx"), Some(("kube", "pod:default/nginx")));
        assert_eq!(split_detail("kube"), None);
    }
}
