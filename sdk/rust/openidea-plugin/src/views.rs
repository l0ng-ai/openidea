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

impl FieldValue {
    /// A plain read-only value, carried by `other` kind `label` (API 1.3).
    pub fn label(text: &str) -> Self {
        Self::Other { kind: "label".into(), data: format!("\"{}\"", crate::text::escape_json(text)) }
    }

    /// Selectable text with no field-change events (API 1.3).
    pub fn readonly_text(text: &str, multiline: bool) -> Self {
        Self::Other {
            kind: "readonly-text".into(),
            data: format!(r#"{{"text":"{}","multiline":{multiline}}}"#, crate::text::escape_json(text)),
        }
    }
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

/// The column a table's rows are ordered by, and the direction: what
/// [`Body::sortable_table`] reports and a header click asks for
/// ([`ViewEvent::sort`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TableSort {
    pub column: u32,
    pub descending: bool,
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
    /// A table whose column headers the IDE makes clickable: the usual
    /// [`Table`] fields plus the sort the plugin orders by (none: no arrow
    /// yet), carried by the `other` body case (plugins/README.md §10), so
    /// IDEs and plugins of any API version keep working. The plugin sorts its
    /// own rows; a click asks for a column and direction with
    /// [`ViewEvent::sort`], and [`crate::host::refresh_view`] shows the new
    /// order.
    pub fn sortable_table(table: &Table, sort: Option<TableSort>) -> Self {
        let mut data = String::from(r#"{"columns":"#);
        json_list(&mut data, table.columns.iter().map(String::as_str));
        data.push_str(&format!(",\"totalRows\":{},\"firstRow\":{},\"rows\":[", table.total_rows, table.first_row));
        for (i, row) in table.rows.iter().enumerate() {
            if i > 0 {
                data.push(',');
            }
            json_list(&mut data, row.iter().map(String::as_str));
        }
        data.push_str(&format!("],\"editable\":{},\"sort\":", table.editable));
        match sort {
            Some(s) => data.push_str(&format!(r#"{{"column":{},"descending":{}}}"#, s.column, s.descending)),
            None => data.push_str("null"),
        }
        data.push('}');
        Self::Other { kind: "table".into(), data }
    }
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

impl ViewEvent {
    /// The absolute zero-based row selected in a table (API 1.3).
    pub fn table_select(&self) -> Option<u32> {
        self.table_row("table-select")
    }

    /// The absolute zero-based row activated in a table (API 1.3).
    pub fn table_activate(&self) -> Option<u32> {
        self.table_row("table-activate")
    }

    fn table_row(&self, expected: &str) -> Option<u32> {
        let Self::Other { kind, data } = self else { return None };
        (kind == expected).then(|| json_number(data, "row")).flatten()
    }

    /// The click on a sortable table's header ([`Body::sortable_table`]): the
    /// column and the direction to order it by (`other` view-event, kind
    /// `sort`; the first click asks ascending, a second on the same column
    /// reverses). `None` for any other event, or one whose data this SDK
    /// doesn't read.
    pub fn sort(&self) -> Option<TableSort> {
        let Self::Other { kind, data } = self else { return None };
        if kind != "sort" {
            return None;
        }
        Some(TableSort { column: json_number(data, "column")?, descending: json_bool(data, "descending")? })
    }
}

/// The value of `"key":` in the host's flat JSON, up to the next `,` or `}`.
fn json_value<'a>(data: &'a str, key: &str) -> Option<&'a str> {
    let needle = format!(r#""{key}""#);
    let mut from = 0;
    while let Some(i) = data[from..].find(&needle) {
        let after = data[from + i + needle.len()..].trim_start();
        if let Some(rest) = after.strip_prefix(':') {
            let rest = rest.trim_start();
            let end = rest.find([',', '}']).unwrap_or(rest.len());
            return Some(rest[..end].trim());
        }
        from += i + needle.len();
    }
    None
}

fn json_number(data: &str, key: &str) -> Option<u32> {
    json_value(data, key)?.parse().ok()
}

fn json_bool(data: &str, key: &str) -> Option<bool> {
    match json_value(data, key)? {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

/// A JSON string array.
fn json_list<'a>(out: &mut String, items: impl Iterator<Item = &'a str>) {
    out.push('[');
    for (i, item) in items.enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push('"');
        out.push_str(&crate::text::escape_json(item));
        out.push('"');
    }
    out.push(']');
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
    fn readonly_fields_escape_text_without_changing_released_variants() {
        assert_eq!(FieldValue::label("a\"\n"), FieldValue::Other { kind: "label".into(), data: r#""a\"\n""#.into() });
        assert_eq!(
            FieldValue::readonly_text("a\nβ", true),
            FieldValue::Other { kind: "readonly-text".into(), data: r#"{"text":"a\nβ","multiline":true}"#.into() }
        );
    }

    #[test]
    fn table_row_events_only_decode_their_own_valid_payloads() {
        let event = |kind: &str, data: &str| ViewEvent::Other { kind: kind.into(), data: data.into() };
        assert_eq!(event("table-select", r#"{"row":51}"#).table_select(), Some(51));
        assert_eq!(event("table-activate", r#"{"row":0}"#).table_activate(), Some(0));
        for data in ["{}", r#"{"row":-1}"#, r#"{"row":4294967296}"#, r#"{"row":"1"}"#] {
            assert_eq!(event("table-select", data).table_select(), None);
        }
        assert_eq!(event("select", r#"{"row":1}"#).table_select(), None);
        assert_eq!(event("table-select", r#"{"row":1}"#).table_activate(), None);
    }

    #[test]
    fn a_sortable_table_becomes_the_other_table_body() {
        let table = Table {
            columns: vec!["ext".into(), "files".into()],
            total_rows: 2,
            rows: vec![vec!["rs".into(), "2".into()], vec!["say \"hi\"".into(), "1".into()]],
            ..Table::default()
        };
        let body = Body::sortable_table(&table, Some(TableSort { column: 1, descending: true }));
        let Body::Other { kind, data } = body else { panic!("{body:?}") };
        assert_eq!(kind, "table");
        assert_eq!(
            data,
            concat!(
                r#"{"columns":["ext","files"],"totalRows":2,"firstRow":0,"rows":[["rs","2"],["say \"hi\"","1"]],"#,
                r#""editable":false,"sort":{"column":1,"descending":true}}"#
            )
        );

        // No sort yet: the headers are still clickable.
        let body = Body::sortable_table(&table, None);
        let Body::Other { data, .. } = body else { panic!("{body:?}") };
        assert!(data.ends_with(r#""editable":false,"sort":null}"#), "{data}");
    }

    #[test]
    fn a_sort_click_decodes_from_the_other_event() {
        let sort = |kind: &str, data: &str| ViewEvent::Other { kind: kind.into(), data: data.into() }.sort();
        assert_eq!(sort("sort", r#"{"column":3,"descending":true}"#), Some(TableSort { column: 3, descending: true }));
        assert_eq!(
            sort("sort", r#"{"descending":false,"column": 0 }"#),
            Some(TableSort { column: 0, descending: false })
        );
        assert_eq!(sort("sort", r#"{"column":1}"#), None, "no direction: not a sort");
        assert_eq!(sort("sort", "{not json"), None);
        assert_eq!(sort("other-thing", r#"{"column":1,"descending":false}"#), None, "another kind");
        assert_eq!(ViewEvent::Button("x".into()).sort(), None);
    }
}
