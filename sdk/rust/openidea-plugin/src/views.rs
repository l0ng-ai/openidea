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
