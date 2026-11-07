//! The pane beside the Services tree for the nodes of the plugin's
//! `location = "services"` views (world `plugin-services`). The nodes, the
//! toolbar and their events come from [`crate::views::Views`] as in any view;
//! register both: `register_plugin!(MyPlugin, views, services)`.

use crate::{Error, Invocation};

/// A switch above a log: when on, `args` are appended and the program starts again.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LogToggle {
    pub id: String,
    pub label: String,
    pub args: Vec<String>,
}

/// A program the IDE runs (with the plugin's `process:<program>` grant, in the
/// project root), its output followed in a log until it exits or the pane closes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessLog {
    pub program: String,
    pub args: Vec<String>,
    pub toggles: Vec<LogToggle>,
}

impl ProcessLog {
    pub fn new(program: &str, args: &[&str]) -> Self {
        Self { program: program.to_owned(), args: strings(args), toggles: Vec::new() }
    }

    /// Adds a switch above the log that appends `args` when on.
    pub fn toggle(mut self, id: &str, label: &str, args: &[&str]) -> Self {
        self.toggles.push(LogToggle { id: id.to_owned(), label: label.to_owned(), args: strings(args) });
        self
    }
}

/// The body of a [`Tab`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Pane {
    /// A centred message: an empty state or why there is nothing to show.
    Message(String),
    /// Read-only text the user can select and copy (at most 1 MiB).
    Text(String),
    Log(ProcessLog),
}

impl From<ProcessLog> for Pane {
    fn from(log: ProcessLog) -> Self {
        Self::Log(log)
    }
}

/// A tab of a node's pane; the IDE switches tabs without calling the plugin.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tab {
    pub id: String,
    pub label: String,
    pub body: Pane,
}

impl Tab {
    pub fn new(id: &str, label: &str, body: impl Into<Pane>) -> Self {
        Self { id: id.to_owned(), label: label.to_owned(), body: body.into() }
    }
}

/// The detail pane of the nodes of the plugin's services views.
pub trait Services {
    /// The tabs of node `key` of view `view` (at most 8), asked when the node is
    /// selected and again after [`crate::host::refresh_view`] of the view.
    fn detail(&mut self, view: &str, key: &str, ctx: &Invocation) -> Result<Vec<Tab>, Error>;
}

fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|a| (*a).to_owned()).collect()
}
