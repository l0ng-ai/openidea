//! Lossless nbformat 4 documents. Runtime identities and execution bookkeeping
//! never leak into existing notebook JSON. Only explicit mutations alter bytes.
mod raw;

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use ide_core::{IdeError, IdeResult, error::ErrorKind};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use specta::Type;
use uuid::Uuid;

use self::raw::{Layout, Member, Node};
use crate::kernel::KernelOutput;

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NotebookSnapshot {
    pub id: String,
    pub path: String,
    pub version: u32,
    pub dirty: bool,
    pub can_undo: bool,
    pub can_redo: bool,
    pub nbformat: u32,
    pub nbformat_minor: u32,
    #[specta(type = specta_typescript::Unknown)]
    pub metadata: Value,
    pub cells: Vec<NotebookCell>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NotebookCell {
    pub id: String,
    pub cell_type: String,
    pub source: String,
    #[specta(type = specta_typescript::Unknown)]
    pub metadata: Value,
    #[specta(type = Vec<specta_typescript::Unknown>)]
    pub outputs: Vec<Value>,
    pub execution_count: Option<u32>,
    #[specta(type = specta_typescript::Unknown)]
    pub attachments: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum NotebookEdit {
    SetSource {
        cell: String,
        source: String,
    },
    InsertCell {
        after: Option<String>,
        cell_type: String,
    },
    DeleteCell {
        cell: String,
    },
    MoveCell {
        cell: String,
        before: Option<String>,
    },
    SetCellType {
        cell: String,
        cell_type: String,
    },
    SetOutputs {
        cell: String,
        #[specta(type = Vec<specta_typescript::Unknown>)]
        outputs: Vec<Value>,
        execution_count: Option<u32>,
    },
}

#[derive(Clone)]
struct CellState {
    id: String,
    display_ids: Vec<Option<String>>,
    pending_clear: bool,
}

#[derive(Clone)]
struct Fields {
    values: Vec<(String, Option<Member>)>,
    order: Vec<String>,
    layout: Layout,
}

impl Fields {
    fn capture(node: &Node, keys: &[&str]) -> Self {
        let members = node.members().expect("validated cell object");
        Self {
            values: keys.iter().map(|key| ((*key).into(), members.iter().find(|m| m.key == *key).cloned())).collect(),
            order: members.iter().map(|m| m.key.clone()).collect(),
            layout: node.layout(),
        }
    }

    fn restore(&self, node: &mut Node) {
        node.restore_fields(&self.values, &self.order, &self.layout);
    }
}

enum Change {
    Fields { cell: String, before: Fields, after: Fields },
    Insert { index: usize, node: Node, state: CellState, before: Layout, after: Layout },
    Delete { index: usize, node: Node, state: CellState, before: Layout, after: Layout },
    Move { from: usize, to: usize, before: Layout, after: Layout },
}

struct History {
    change: Change,
    typing_cell: Option<String>,
    time: Instant,
}

/// The caller serializes short document operations, not kernel awaits. Batch
/// admission belongs to the host; set_execution_active protects backend history.
pub struct NotebookDocument {
    id: String,
    path: PathBuf,
    root: Node,
    prefix: String,
    suffix: String,
    baseline: Node,
    baseline_text: Arc<str>,
    cells: Vec<CellState>,
    version: u32,
    last_user_revision: u32,
    undo: Vec<History>,
    redo: Vec<History>,
    execution_active: bool,
}

impl NotebookDocument {
    pub fn load(path: &Path) -> IdeResult<Self> {
        let text = std::fs::read_to_string(path)?;
        Self::from_text(path.to_path_buf(), text)
    }

    pub fn from_text(path: PathBuf, text: String) -> IdeResult<Self> {
        let text: Arc<str> = text.into();
        let (root, prefix, suffix) = Node::parse(text.clone())?;
        validate_notebook(&root)?;
        let nodes = root.get("cells").and_then(Node::array).expect("validated cells");
        let mut persisted = HashMap::<String, usize>::new();
        for node in nodes {
            if let Some(id) = string_field(node, "id").filter(|id| valid_id(id)) {
                *persisted.entry(id.to_owned()).or_default() += 1;
            }
        }
        let mut used: HashSet<String> = persisted.keys().cloned().collect();
        let cells = nodes
            .iter()
            .map(|node| {
                let id = string_field(node, "id")
                    .filter(|id| valid_id(id) && persisted.get(*id) == Some(&1))
                    .map(str::to_owned)
                    .unwrap_or_else(|| unique_id(&mut used));
                let outputs = node.get("outputs").and_then(Node::array).map_or(0, <[Node]>::len);
                CellState { id, display_ids: vec![None; outputs], pending_clear: false }
            })
            .collect();
        Ok(Self {
            id: Uuid::new_v4().to_string(),
            path,
            baseline: root.clone(),
            root,
            prefix,
            suffix,
            baseline_text: text,
            cells,
            version: 1,
            last_user_revision: 1,
            undo: Vec::new(),
            redo: Vec::new(),
            execution_active: false,
        })
    }

    pub fn snapshot(&self) -> NotebookSnapshot {
        NotebookSnapshot {
            id: self.id.clone(),
            path: self.path.to_string_lossy().into_owned(),
            version: self.version,
            dirty: self.is_dirty(),
            can_undo: !self.execution_active && !self.undo.is_empty(),
            can_redo: !self.execution_active && !self.redo.is_empty(),
            nbformat: uint_field(&self.root, "nbformat").expect("validated format"),
            nbformat_minor: uint_field(&self.root, "nbformat_minor").expect("validated minor"),
            metadata: self.root.get("metadata").expect("validated metadata").value(),
            cells: self
                .nodes()
                .iter()
                .zip(&self.cells)
                .map(|(node, state)| NotebookCell {
                    id: state.id.clone(),
                    cell_type: string_field(node, "cell_type").expect("validated type").into(),
                    source: source(node).expect("validated source"),
                    metadata: node.get("metadata").map_or_else(|| json!({}), Node::value),
                    outputs: node
                        .get("outputs")
                        .and_then(Node::array)
                        .map_or_else(Vec::new, |items| items.iter().map(Node::value).collect()),
                    execution_count: uint_field(node, "execution_count"),
                    attachments: node.get("attachments").map_or_else(|| json!({}), Node::value),
                })
                .collect(),
        }
    }

    /// Byte equality, not a sticky flag. Unchanged raw siblings short-circuit
    /// without serializing the notebook on each source edit or output chunk.
    pub fn is_dirty(&self) -> bool {
        !self.root.same_bytes(&self.baseline)
    }

    /// The host uses these cheap fields for high-volume output events.
    pub fn version(&self) -> u32 {
        self.version
    }
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Intended for save/export and behavioral tests, not per-chunk IPC.
    pub fn to_text(&self) -> String {
        let mut text = String::with_capacity(self.baseline_text.len());
        text.push_str(&self.prefix);
        self.root.write(&mut text);
        text.push_str(&self.suffix);
        text
    }

    pub fn save(&mut self) -> IdeResult<NotebookSnapshot> {
        let disk = std::fs::read(&self.path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                out_of_sync("Notebook file was removed; reload or save a separate copy before overwriting")
            } else {
                error.into()
            }
        })?;
        if disk != self.baseline_text.as_bytes() {
            return Err(out_of_sync("Notebook changed on disk; reload or save a separate copy before overwriting"));
        }
        if self.is_dirty() {
            let text = self.to_text();
            ide_vfs::write_atomic_strict(&self.path, text.as_bytes())?;
            self.baseline_text = text.into();
            self.baseline = self.root.clone();
        }
        // A save is a typing-group boundary; undo after it must become dirty.
        self.break_typing_group();
        Ok(self.snapshot())
    }

    pub fn reload(&mut self) -> IdeResult<NotebookSnapshot> {
        self.require_inactive()?;
        self.ensure_revision()?;
        let mut replacement = Self::load(&self.path)?;
        replacement.id.clone_from(&self.id);
        replacement.version = self.version + 1;
        replacement.last_user_revision = replacement.version;
        *self = replacement;
        Ok(self.snapshot())
    }

    pub fn set_execution_active(&mut self, active: bool) -> IdeResult<()> {
        if active && self.execution_active {
            return Err(IdeError::invalid("Notebook already has an active execution batch"));
        }
        self.execution_active = active;
        self.break_typing_group();
        Ok(())
    }

    fn nodes(&self) -> &[Node] {
        self.root.get("cells").and_then(Node::array).expect("validated cells")
    }
    fn array_mut(&mut self) -> &mut Node {
        self.root.get_mut("cells").expect("validated cells")
    }
    fn cell_mut(&mut self, index: usize) -> &mut Node {
        self.array_mut().item_mut(index)
    }
    fn index(&self, id: &str) -> IdeResult<usize> {
        self.cells
            .iter()
            .position(|cell| cell.id == id)
            .ok_or_else(|| IdeError::not_found(format!("Notebook cell {id} no longer exists")))
    }
    fn ensure_revision(&self) -> IdeResult<()> {
        if self.version == u32::MAX {
            Err(IdeError::unavailable("Notebook revision limit reached; save and reopen the document"))
        } else {
            Ok(())
        }
    }
    fn require_inactive(&self) -> IdeResult<()> {
        if self.execution_active {
            Err(IdeError::invalid("Stop and drain notebook execution before undo, redo, or reload"))
        } else {
            Ok(())
        }
    }
    fn break_typing_group(&mut self) {
        if let Some(last) = self.undo.last_mut() {
            last.typing_cell = None;
        }
    }
}

fn out_of_sync(message: &str) -> IdeError {
    IdeError::new(ErrorKind::OutOfSync, message)
}
fn string_field<'a>(node: &'a Node, key: &str) -> Option<&'a str> {
    node.get(key)?.string()
}
fn uint_field(node: &Node, key: &str) -> Option<u32> {
    node.get(key)?.uint()
}
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
fn unique_id(used: &mut HashSet<String>) -> String {
    loop {
        let id = Uuid::new_v4().to_string();
        if used.insert(id.clone()) {
            return id;
        }
    }
}

fn text_value(value: &Value) -> IdeResult<String> {
    match value {
        Value::String(text) => Ok(text.clone()),
        Value::Array(parts) => {
            let mut text = String::new();
            for part in parts {
                text.push_str(
                    part.as_str().ok_or_else(|| IdeError::invalid("Notebook text arrays must contain only strings"))?,
                );
            }
            Ok(text)
        }
        _ => Err(IdeError::invalid("Notebook source/text must be a string or string array")),
    }
}

fn source(node: &Node) -> IdeResult<String> {
    match node.get("source") {
        Some(value) => node_text(value),
        None if !matches!(string_field(node, "cell_type"), Some("code" | "markdown" | "raw")) => Ok(String::new()),
        None => Err(IdeError::invalid("Notebook cell source is missing")),
    }
}

fn validate_notebook(root: &Node) -> IdeResult<()> {
    if root.members().is_none()
        || uint_field(root, "nbformat") != Some(4)
        || uint_field(root, "nbformat_minor").is_none()
    {
        return Err(IdeError::invalid(
            "Only nbformat 4 notebooks with a nonnegative integer minor version are supported; the file has not been modified",
        ));
    }
    if root.get("metadata").is_none_or(|n| n.members().is_none()) {
        return Err(IdeError::invalid("Notebook metadata must be an object"));
    }
    let cells =
        root.get("cells").and_then(Node::array).ok_or_else(|| IdeError::invalid("Notebook cells must be an array"))?;
    for node in cells {
        if node.members().is_none() || string_field(node, "cell_type").is_none() {
            return Err(IdeError::invalid("Notebook cells must be objects with a string cell_type"));
        }
        let known = matches!(string_field(node, "cell_type"), Some("code" | "markdown" | "raw"));
        match node.get("source") {
            Some(value) => validate_text_node(value)?,
            None if known => return Err(IdeError::invalid("Notebook cell source is missing")),
            None => {}
        }
        if known && node.get("metadata").is_none() {
            return Err(IdeError::invalid("Notebook cell metadata is missing"));
        }
        if let Some(metadata) = node.get("metadata")
            && metadata.members().is_none()
        {
            return Err(IdeError::invalid("Cell metadata must be an object"));
        }
        if let Some(attachments) = node.get("attachments")
            && attachments.members().is_none()
        {
            return Err(IdeError::invalid("Cell attachments must be an object"));
        }
        if let Some(outputs) = node.get("outputs") {
            let outputs = outputs.array().ok_or_else(|| IdeError::invalid("Cell outputs must be an array"))?;
            for output in outputs {
                validate_output_node(output)?;
            }
        }
        if let Some(count) = node.get("execution_count")
            && !count.is_null()
            && uint_field(node, "execution_count").is_none()
        {
            return Err(IdeError::invalid("Cell execution_count must be null or a nonnegative 32-bit integer"));
        }
        if string_field(node, "cell_type") == Some("code")
            && (node.get("outputs").is_none() || node.get("execution_count").is_none())
        {
            return Err(IdeError::invalid("Code cells require outputs and execution_count"));
        }
    }
    Ok(())
}

impl NotebookDocument {
    pub fn edit(&mut self, base_version: u32, edit: NotebookEdit) -> IdeResult<NotebookSnapshot> {
        if base_version < self.last_user_revision || base_version > self.version {
            return Err(out_of_sync("Notebook was edited elsewhere; refresh and rebase pending edits"));
        }
        self.ensure_revision()?;
        if let NotebookEdit::SetOutputs { cell, outputs, execution_count } = edit {
            let index = self.code_index(&cell)?;
            let outputs = outputs.into_iter().map(persisted_output).collect::<IdeResult<Vec<_>>>()?;
            let node = Node::new(Value::Array(outputs));
            for output in node.array().expect("outputs array") {
                validate_output_node(output)?;
            }
            let count = Node::new(json!(execution_count));
            let changed = !self.nodes()[index].get("outputs").expect("code outputs").same_bytes(&node)
                || !self.nodes()[index].get("execution_count").expect("code count").same_bytes(&count);
            if changed {
                let len = node.array().expect("outputs array").len();
                self.cell_mut(index).set("outputs", Some(node));
                self.cell_mut(index).set("execution_count", Some(count));
                self.cells[index].display_ids = vec![None; len];
                self.cells[index].pending_clear = false;
                self.version += 1;
            }
            return Ok(self.snapshot());
        }
        let typing_cell = match &edit {
            NotebookEdit::SetSource { cell, .. } => Some(cell.clone()),
            _ => None,
        };
        let change = match edit {
            NotebookEdit::SetSource { cell, source: text } => {
                let index = self.index(&cell)?;
                if self.nodes()[index].get("source").is_some_and(|old| text_matches(old, &text)) {
                    return Ok(self.snapshot());
                }
                let before = Fields::capture(&self.nodes()[index], &["source"]);
                let value = rewritten_source(self.nodes()[index].get("source"), text);
                self.cell_mut(index).set("source", Some(value));
                let after = Fields::capture(&self.nodes()[index], &["source"]);
                Change::Fields { cell, before, after }
            }
            NotebookEdit::InsertCell { after, cell_type } => {
                validate_cell_type(&cell_type)?;
                let index = after.map_or(Ok(0), |id| self.index(&id).map(|index| index + 1))?;
                let id = unique_id(&mut self.cells.iter().map(|state| state.id.clone()).collect());
                let mut value = json!({ "cell_type": cell_type, "metadata": {}, "source": [] });
                if uint_field(&self.root, "nbformat_minor").expect("minor") >= 5 {
                    value["id"] = json!(id);
                }
                if value["cell_type"] == "code" {
                    value["outputs"] = json!([]);
                    value["execution_count"] = Value::Null;
                }
                let node = Node::new(value);
                let state = CellState { id, display_ids: Vec::new(), pending_clear: false };
                let before = self.root.get("cells").expect("cells").layout();
                self.array_mut().insert(index, node.clone());
                self.cells.insert(index, state.clone());
                let after = self.root.get("cells").expect("cells").layout();
                Change::Insert { index, node, state, before, after }
            }
            NotebookEdit::DeleteCell { cell } => {
                let index = self.index(&cell)?;
                let before = self.root.get("cells").expect("cells").layout();
                let node = self.array_mut().remove(index);
                let state = self.cells.remove(index);
                let after = self.root.get("cells").expect("cells").layout();
                Change::Delete { index, node, state, before, after }
            }
            NotebookEdit::MoveCell { cell, before: target } => {
                let from = self.index(&cell)?;
                let target = target.map_or(Ok(self.cells.len()), |id| self.index(&id))?;
                let to = if target > from { target - 1 } else { target };
                if from == to {
                    return Ok(self.snapshot());
                }
                let before = self.root.get("cells").expect("cells").layout();
                self.move_cell(from, to);
                let after = self.root.get("cells").expect("cells").layout();
                Change::Move { from, to, before, after }
            }
            NotebookEdit::SetCellType { cell, cell_type } => {
                validate_cell_type(&cell_type)?;
                let index = self.index(&cell)?;
                if string_field(&self.nodes()[index], "cell_type") == Some(cell_type.as_str()) {
                    return Ok(self.snapshot());
                }
                let keys = ["cell_type", "outputs", "execution_count"];
                let before = Fields::capture(&self.nodes()[index], &keys);
                let node = self.cell_mut(index);
                node.set("cell_type", Some(Node::new(json!(cell_type))));
                if cell_type == "code" {
                    node.set("outputs", Some(Node::new(json!([]))));
                    node.set("execution_count", Some(Node::new(Value::Null)));
                } else {
                    node.set("outputs", None);
                    node.set("execution_count", None);
                }
                self.cells[index].display_ids.clear();
                self.cells[index].pending_clear = false;
                let after = Fields::capture(&self.nodes()[index], &keys);
                Change::Fields { cell, before, after }
            }
            NotebookEdit::SetOutputs { .. } => unreachable!("output edits handled above"),
        };
        self.version += 1;
        self.last_user_revision = self.version;
        self.redo.clear();
        let now = Instant::now();
        let grouped = typing_cell.as_ref().is_some_and(|cell| {
            self.undo.last().is_some_and(|last| {
                last.typing_cell.as_ref() == Some(cell) && now.duration_since(last.time) < Duration::from_millis(750)
            })
        });
        if grouped {
            if let (
                Some(History { change: Change::Fields { after: previous, .. }, time, .. }),
                Change::Fields { after, .. },
            ) = (self.undo.last_mut(), change)
            {
                *previous = after;
                *time = now;
            }
        } else {
            self.undo.push(History { change, typing_cell, time: now });
            // Bounded operation count; streaming outputs never enter history.
            if self.undo.len() > 200 {
                self.undo.remove(0);
            }
        }
        Ok(self.snapshot())
    }

    pub fn undo(&mut self) -> IdeResult<NotebookSnapshot> {
        self.require_inactive()?;
        self.ensure_revision()?;
        if let Some(mut history) = self.undo.pop() {
            if let Err(error) = self.apply_history(&mut history.change, false) {
                self.undo.push(history);
                return Err(error);
            }
            history.typing_cell = None;
            self.redo.push(history);
            self.version += 1;
            self.last_user_revision = self.version;
        }
        self.break_typing_group();
        Ok(self.snapshot())
    }

    pub fn redo(&mut self) -> IdeResult<NotebookSnapshot> {
        self.require_inactive()?;
        self.ensure_revision()?;
        if let Some(mut history) = self.redo.pop() {
            if let Err(error) = self.apply_history(&mut history.change, true) {
                self.redo.push(history);
                return Err(error);
            }
            history.typing_cell = None;
            self.undo.push(history);
            self.version += 1;
            self.last_user_revision = self.version;
        }
        Ok(self.snapshot())
    }

    fn apply_history(&mut self, change: &mut Change, forward: bool) -> IdeResult<()> {
        let insertion_change = matches!(change, Change::Insert { .. });
        match change {
            Change::Fields { cell, before, after } => {
                let index = self.index(cell)?;
                let keys: Vec<&str> = before.values.iter().map(|(key, _)| key.as_str()).collect();
                let current = Fields::capture(&self.nodes()[index], &keys);
                if forward {
                    *before = current;
                } else {
                    *after = current;
                }
                let fields = if forward { after } else { before };
                fields.restore(self.cell_mut(index));
                if fields.values.iter().any(|(key, _)| key == "outputs") {
                    let len = self.nodes()[index].get("outputs").and_then(Node::array).map_or(0, <[Node]>::len);
                    self.cells[index].display_ids = vec![None; len];
                    self.cells[index].pending_clear = false;
                }
            }
            Change::Insert { index, node, state, before, after }
            | Change::Delete { index, node, state, before, after } => {
                let insert = insertion_change == forward;
                if insert {
                    self.array_mut().insert(*index, node.clone());
                    self.cells.insert(*index, state.clone());
                } else {
                    *node = self.array_mut().remove(*index);
                    *state = self.cells.remove(*index);
                }
                self.array_mut().restore_layout(if forward { after } else { before }.clone());
            }
            Change::Move { from, to, before, after } => {
                if forward {
                    self.move_cell(*from, *to);
                } else {
                    self.move_cell(*to, *from);
                }
                self.array_mut().restore_layout(if forward { after } else { before }.clone());
            }
        }
        Ok(())
    }

    fn move_cell(&mut self, from: usize, to: usize) {
        let node = self.array_mut().remove(from);
        self.array_mut().insert(to, node);
        let state = self.cells.remove(from);
        self.cells.insert(to, state);
    }

    fn code_index(&self, cell: &str) -> IdeResult<usize> {
        let index = self.index(cell)?;
        if string_field(&self.nodes()[index], "cell_type") != Some("code") {
            return Err(IdeError::invalid("Only code cells accept execution output"));
        }
        Ok(index)
    }
}

fn validate_cell_type(cell_type: &str) -> IdeResult<()> {
    if matches!(cell_type, "code" | "markdown" | "raw") {
        Ok(())
    } else {
        Err(IdeError::invalid("New/converted cell type must be code, markdown, or raw"))
    }
}

fn persisted_output(mut value: Value) -> IdeResult<Value> {
    let object = value.as_object_mut().ok_or_else(|| IdeError::invalid("Notebook outputs must be objects"))?;
    if !object.get("output_type").is_some_and(Value::is_string) {
        return Err(IdeError::invalid("Notebook outputs require a string output_type"));
    }
    object.remove("transient");
    Ok(value)
}

impl NotebookDocument {
    pub fn begin_execution(&mut self, cell: &str) -> IdeResult<()> {
        let index = self.code_index(cell)?;
        self.ensure_revision()?;
        let changed = self.clear_outputs(index);
        let count_changed = !self.nodes()[index].get("execution_count").expect("code count").is_null();
        if count_changed {
            self.cell_mut(index).set("execution_count", Some(Node::new(Value::Null)));
        }
        if changed || count_changed {
            self.version += 1;
        }
        Ok(())
    }

    /// Commits one IOPub event and returns all cells whose persisted bytes
    /// changed. Display identifiers and deferred clears exist only in memory.
    pub fn record_output(&mut self, cell: &str, event: &KernelOutput) -> IdeResult<Vec<String>> {
        let index = self.code_index(cell)?;
        self.ensure_revision()?;
        let content = &event.content;
        let mut changed = Vec::new();
        match event.kind.as_str() {
            "execute_input" => {
                let count = content
                    .get("execution_count")
                    .and_then(Value::as_u64)
                    .and_then(|n| u32::try_from(n).ok())
                    .ok_or_else(|| IdeError::invalid("Kernel execute_input lacks a valid execution_count"))?;
                if uint_field(&self.nodes()[index], "execution_count") != Some(count) {
                    self.cell_mut(index).set("execution_count", Some(Node::new(json!(count))));
                    changed.push(cell.to_owned());
                }
            }
            "clear_output" => {
                if content.get("wait").and_then(Value::as_bool).unwrap_or(false) {
                    self.cells[index].pending_clear = true;
                } else if self.clear_outputs(index) {
                    changed.push(cell.to_owned());
                }
            }
            "stream" => {
                let name = content
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or_else(|| IdeError::invalid("Kernel stream lacks a name"))?;
                let text =
                    text_value(content.get("text").ok_or_else(|| IdeError::invalid("Kernel stream lacks text"))?)?;
                if self.clear_pending(index) {
                    changed.push(cell.to_owned());
                }
                let outputs = self.nodes()[index].get("outputs").and_then(Node::array).expect("code outputs");
                let last = outputs.len().checked_sub(1).filter(|last| {
                    string_field(&outputs[*last], "output_type") == Some("stream")
                        && string_field(&outputs[*last], "name") == Some(name)
                });
                if let Some(last) = last {
                    if !text.is_empty() {
                        let old = outputs[last]
                            .get("text")
                            .ok_or_else(|| IdeError::invalid("Stored stream output lacks text"))?;
                        let combined = if old.string().is_some() { None } else { Some(node_text(old)?) };
                        let stream = self.cell_mut(index).get_mut("outputs").expect("outputs").item_mut(last);
                        if let Some(mut combined) = combined {
                            combined.push_str(&text);
                            stream.set("text", Some(Node::new(Value::String(combined))));
                        } else {
                            stream.get_mut("text").expect("stream text").append_string(&text);
                        }
                        changed.push(cell.to_owned());
                    }
                } else {
                    let mut value = content
                        .as_object()
                        .cloned()
                        .ok_or_else(|| IdeError::invalid("Kernel stream content must be an object"))?;
                    value.insert("output_type".into(), json!("stream"));
                    value.insert("text".into(), Value::String(text));
                    value.remove("transient");
                    self.append_output(index, Node::new(Value::Object(value)), None);
                    changed.push(cell.to_owned());
                }
            }
            "display_data" | "execute_result" | "error" => {
                // Validate before applying a pending clear: malformed messages
                // must not erase existing output as a side effect of failure.
                let mut value = content
                    .as_object()
                    .cloned()
                    .ok_or_else(|| IdeError::invalid("Kernel output content must be an object"))?;
                if event.kind == "error" {
                    if !value.get("ename").is_some_and(Value::is_string)
                        || !value.get("evalue").is_some_and(Value::is_string)
                        || !value
                            .get("traceback")
                            .and_then(Value::as_array)
                            .is_some_and(|lines| lines.iter().all(Value::is_string))
                    {
                        return Err(IdeError::invalid("Kernel error output is malformed"));
                    }
                } else if !value.get("data").is_some_and(Value::is_object)
                    || !value.get("metadata").is_some_and(Value::is_object)
                {
                    return Err(IdeError::invalid("Kernel display output lacks a MIME bundle or metadata"));
                }
                if event.kind == "execute_result"
                    && value.get("execution_count").and_then(Value::as_u64).is_none_or(|n| u32::try_from(n).is_err())
                {
                    return Err(IdeError::invalid("Kernel execute_result lacks a valid execution_count"));
                }
                let display_id = display_id(content);
                value.remove("transient");
                value.insert("output_type".into(), json!(event.kind));
                if self.clear_pending(index) {
                    changed.push(cell.to_owned());
                }
                self.append_output(index, Node::new(Value::Object(value)), display_id);
                changed.push(cell.to_owned());
            }
            "update_display_data" => {
                let Some(id) = display_id(content) else {
                    return Ok(Vec::new());
                };
                let data = content
                    .get("data")
                    .filter(|v| v.is_object())
                    .ok_or_else(|| IdeError::invalid("Display update lacks a MIME bundle"))?;
                let metadata = content
                    .get("metadata")
                    .filter(|v| v.is_object())
                    .ok_or_else(|| IdeError::invalid("Display update lacks metadata"))?;
                if self.clear_pending(index) {
                    changed.push(cell.to_owned());
                }
                for current in 0..self.cells.len() {
                    let matches: Vec<usize> = self.cells[current]
                        .display_ids
                        .iter()
                        .enumerate()
                        .filter_map(|(output, display)| (display.as_deref() == Some(id.as_str())).then_some(output))
                        .collect();
                    let mut cell_changed = false;
                    for output in matches {
                        let Some(old) = self.nodes()[current]
                            .get("outputs")
                            .and_then(Node::array)
                            .and_then(|outputs| outputs.get(output))
                        else {
                            continue;
                        };
                        let data_node = Node::new(data.clone());
                        let metadata_node = Node::new(metadata.clone());
                        let replace_data = old.get("data").is_none_or(|old| !old.same_bytes(&data_node));
                        let replace_metadata = old.get("metadata").is_none_or(|old| !old.same_bytes(&metadata_node));
                        if replace_data || replace_metadata {
                            let output =
                                self.cell_mut(current).get_mut("outputs").expect("mapped outputs").item_mut(output);
                            if replace_data {
                                output.set("data", Some(data_node));
                            }
                            if replace_metadata {
                                output.set("metadata", Some(metadata_node));
                            }
                            cell_changed = true;
                        }
                    }
                    if cell_changed {
                        changed.push(self.cells[current].id.clone());
                    }
                }
            }
            _ => {}
        }
        let mut seen = HashSet::new();
        changed.retain(|id| seen.insert(id.clone()));
        if !changed.is_empty() {
            self.version += 1;
        }
        Ok(changed)
    }

    fn append_output(&mut self, index: usize, node: Node, display_id: Option<String>) {
        let len = self.nodes()[index].get("outputs").and_then(Node::array).expect("code outputs").len();
        self.cell_mut(index).get_mut("outputs").expect("outputs").insert(len, node);
        self.cells[index].display_ids.push(display_id);
    }

    fn clear_pending(&mut self, index: usize) -> bool {
        if self.cells[index].pending_clear { self.clear_outputs(index) } else { false }
    }

    fn clear_outputs(&mut self, index: usize) -> bool {
        self.cells[index].pending_clear = false;
        self.cells[index].display_ids.clear();
        let changed = !self.nodes()[index].get("outputs").and_then(Node::array).expect("code outputs").is_empty();
        if changed {
            self.cell_mut(index).set("outputs", Some(Node::new(json!([]))));
        }
        changed
    }
}

fn display_id(content: &Value) -> Option<String> {
    content.get("transient")?.get("display_id")?.as_str().map(str::to_owned)
}

fn node_text(node: &Node) -> IdeResult<String> {
    if let Some(text) = node.string() {
        return Ok(text.into());
    }
    if let Some(parts) = node.array() {
        let mut text = String::new();
        for part in parts {
            text.push_str(
                part.string().ok_or_else(|| IdeError::invalid("Notebook text arrays must contain only strings"))?,
            );
        }
        return Ok(text);
    }
    Err(IdeError::invalid("Notebook source/text must be a string or string array"))
}

fn rewritten_source(old: Option<&Node>, text: String) -> Node {
    let Some(old) = old.filter(|node| node.array().is_some()) else {
        return Node::new(Value::String(text));
    };
    let parts = old.array().expect("source list");
    let mut first = 0;
    let mut start = 0;
    while first < parts.len() {
        let part = parts[first].string().expect("validated source text");
        if !text[start..].starts_with(part) {
            break;
        }
        start += part.len();
        first += 1;
    }
    let mut last = parts.len();
    let mut end = text.len();
    while last > first {
        let part = parts[last - 1].string().expect("validated source text");
        if end - start < part.len() || !text[start..end].ends_with(part) {
            break;
        }
        end -= part.len();
        last -= 1;
    }
    let mut updated = old.clone();
    for index in (first..last).rev() {
        updated.remove(index);
    }
    for (offset, part) in text[start..end].split_inclusive('\n').enumerate() {
        updated.insert(first + offset, Node::new(Value::String(part.into())));
    }
    updated
}

fn validate_text_node(node: &Node) -> IdeResult<()> {
    if node.string().is_some() || node.array().is_some_and(|items| items.iter().all(|part| part.string().is_some())) {
        Ok(())
    } else {
        Err(IdeError::invalid("Notebook source/text must be a string or string array"))
    }
}

fn text_matches(node: &Node, text: &str) -> bool {
    if let Some(old) = node.string() {
        return old == text;
    }
    let Some(parts) = node.array() else {
        return false;
    };
    let mut remaining = text;
    for part in parts {
        let Some(part) = part.string() else {
            return false;
        };
        let Some(rest) = remaining.strip_prefix(part) else {
            return false;
        };
        remaining = rest;
    }
    remaining.is_empty()
}

fn validate_output_node(node: &Node) -> IdeResult<()> {
    let kind = string_field(node, "output_type")
        .ok_or_else(|| IdeError::invalid("Notebook outputs must be objects with a string output_type"))?;
    match kind {
        "stream" => {
            if string_field(node, "name").is_none() {
                return Err(IdeError::invalid("Stored stream output lacks a name"));
            }
            validate_text_node(node.get("text").ok_or_else(|| IdeError::invalid("Stored stream output lacks text"))?)?;
        }
        "display_data" | "execute_result" => {
            if node.get("data").is_none_or(|n| n.members().is_none())
                || node.get("metadata").is_none_or(|n| n.members().is_none())
            {
                return Err(IdeError::invalid("Stored display output requires data and metadata objects"));
            }
            if kind == "execute_result" && uint_field(node, "execution_count").is_none() {
                return Err(IdeError::invalid("Stored execute_result lacks a valid execution_count"));
            }
        }
        "error"
            if (string_field(node, "ename").is_none()
                || string_field(node, "evalue").is_none()
                || !node
                    .get("traceback")
                    .and_then(Node::array)
                    .is_some_and(|lines| lines.iter().all(|line| line.string().is_some()))) =>
        {
            return Err(IdeError::invalid("Stored error output is malformed"));
        }
        _ => {}
    }
    Ok(())
}
