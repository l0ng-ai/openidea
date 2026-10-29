//! JSON syntax retained as shared original spans. Mutating one value never
//! normalizes its siblings, property spelling, whitespace, or container order.
use std::{ops::Range, sync::Arc};

use ide_core::{IdeError, IdeResult};
use serde_json::Value;

#[derive(Clone, Debug)]
struct Raw {
    text: Arc<str>,
    span: Range<usize>,
}

impl Raw {
    fn text(&self) -> &str {
        &self.text[self.span.clone()]
    }
}

#[derive(Clone, Debug)]
pub(super) struct Node {
    raw: Option<Raw>,
    kind: Kind,
}

#[derive(Clone, Debug)]
enum Kind {
    Scalar(Arc<Value>),
    Object(Vec<Member>, Layout),
    Array(Vec<Node>, Layout),
}

#[derive(Clone, Debug)]
pub(super) struct Member {
    pub key: String,
    head: String,
    pub value: Node,
}

#[derive(Clone, Debug)]
pub(super) struct Layout {
    prefix: String,
    separators: Vec<String>,
    suffix: String,
}

impl Layout {
    fn compact() -> Self {
        Self { prefix: String::new(), separators: Vec::new(), suffix: String::new() }
    }

    fn separator(&self, index: usize) -> &str {
        self.separators.get(index).map(String::as_str).unwrap_or(",")
    }

    fn remove(&mut self, index: usize) {
        if !self.separators.is_empty() {
            self.separators.remove(index.saturating_sub(1).min(self.separators.len() - 1));
        }
    }

    fn insert(&mut self, index: usize, previous_len: usize) {
        if previous_len > 0 {
            let separator = self.separators.first().cloned().unwrap_or_else(|| ",".into());
            self.separators.insert(index.saturating_sub(1).min(self.separators.len()), separator);
        }
    }
}

impl Node {
    pub fn parse(text: Arc<str>) -> IdeResult<(Self, String, String)> {
        // serde supplies strict JSON/UTF-8 string and numeric validation. The
        // scanner below only locates the already validated syntax spans.
        let start = usize::from(text.starts_with('\u{feff}')) * 3;
        serde_json::from_str::<serde::de::IgnoredAny>(&text[start..])
            .map_err(|e| IdeError::invalid(format!("Invalid notebook JSON: {e}")))?;
        let mut parser = Parser { text: text.clone(), pos: start };
        parser.space();
        let begin = parser.pos;
        let root = parser.node()?;
        Ok((root, text[..begin].into(), text[parser.pos..].into()))
    }

    pub fn new(value: Value) -> Self {
        match value {
            Value::Object(map) => Self {
                raw: None,
                kind: Kind::Object(
                    map.into_iter()
                        .map(|(key, value)| Member {
                            head: format!("{}:", serde_json::to_string(&key).expect("JSON key")),
                            key,
                            value: Self::new(value),
                        })
                        .collect(),
                    Layout::compact(),
                ),
            },
            Value::Array(values) => {
                Self { raw: None, kind: Kind::Array(values.into_iter().map(Self::new).collect(), Layout::compact()) }
            }
            value => Self { raw: None, kind: Kind::Scalar(Arc::new(value)) },
        }
    }

    pub fn value(&self) -> Value {
        match &self.kind {
            Kind::Scalar(value) => value.as_ref().clone(),
            Kind::Array(items, _) => Value::Array(items.iter().map(Self::value).collect()),
            Kind::Object(items, _) => Value::Object(items.iter().map(|m| (m.key.clone(), m.value.value())).collect()),
        }
    }

    pub fn get(&self, key: &str) -> Option<&Self> {
        match &self.kind {
            Kind::Object(items, _) => items.iter().find(|m| m.key == key).map(|m| &m.value),
            _ => None,
        }
    }

    pub fn string(&self) -> Option<&str> {
        match &self.kind {
            Kind::Scalar(value) => value.as_str(),
            _ => None,
        }
    }

    pub fn uint(&self) -> Option<u32> {
        match &self.kind {
            Kind::Scalar(value) => value.as_u64().and_then(|n| u32::try_from(n).ok()),
            _ => None,
        }
    }

    pub fn is_null(&self) -> bool {
        matches!(&self.kind, Kind::Scalar(value) if value.is_null())
    }

    pub fn append_string(&mut self, text: &str) {
        self.raw = None;
        let Kind::Scalar(value) = &mut self.kind else { unreachable!("validated string") };
        let Value::String(current) = Arc::make_mut(value) else { unreachable!("validated string") };
        current.push_str(text);
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut Self> {
        self.raw = None;
        match &mut self.kind {
            Kind::Object(items, _) => items.iter_mut().find(|m| m.key == key).map(|m| &mut m.value),
            _ => None,
        }
    }

    pub fn members(&self) -> Option<&[Member]> {
        match &self.kind {
            Kind::Object(items, _) => Some(items),
            _ => None,
        }
    }

    pub fn array(&self) -> Option<&[Self]> {
        match &self.kind {
            Kind::Array(items, _) => Some(items),
            _ => None,
        }
    }

    pub fn item_mut(&mut self, index: usize) -> &mut Self {
        self.raw = None;
        match &mut self.kind {
            Kind::Array(items, _) => &mut items[index],
            _ => unreachable!("validated array"),
        }
    }

    pub fn layout(&self) -> Layout {
        match &self.kind {
            Kind::Array(_, layout) | Kind::Object(_, layout) => layout.clone(),
            _ => unreachable!("container layout"),
        }
    }

    pub fn restore_layout(&mut self, layout: Layout) {
        self.raw = None;
        match &mut self.kind {
            Kind::Array(_, old) | Kind::Object(_, old) => *old = layout,
            _ => unreachable!("container layout"),
        }
    }

    pub fn set(&mut self, key: &str, value: Option<Self>) {
        self.raw = None;
        let Kind::Object(items, layout) = &mut self.kind else { unreachable!("validated object") };
        match (items.iter().position(|m| m.key == key), value) {
            (Some(index), Some(value)) => items[index].value = value,
            (Some(index), None) => {
                items.remove(index);
                layout.remove(index);
            }
            (None, Some(value)) => {
                layout.insert(items.len(), items.len());
                items.push(Member {
                    key: key.into(),
                    head: format!("{}:", serde_json::to_string(key).expect("JSON key")),
                    value,
                });
            }
            (None, None) => {}
        }
    }

    pub fn restore_fields(&mut self, fields: &[(String, Option<Member>)], order: &[String], layout: &Layout) {
        for (key, field) in fields {
            self.set(key, field.as_ref().map(|m| m.value.clone()));
        }
        let Kind::Object(items, old_layout) = &mut self.kind else { unreachable!("validated object") };
        for (key, field) in fields {
            if let (Some(saved), Some(current)) = (field, items.iter_mut().find(|m| &m.key == key)) {
                current.head.clone_from(&saved.head);
            }
        }
        items.sort_by_key(|m| order.iter().position(|key| key == &m.key).unwrap_or(usize::MAX));
        if items.len() == order.len() {
            *old_layout = layout.clone();
        }
    }

    pub fn insert(&mut self, index: usize, node: Self) {
        self.raw = None;
        let Kind::Array(items, layout) = &mut self.kind else { unreachable!("validated array") };
        layout.insert(index, items.len());
        items.insert(index, node);
    }

    pub fn remove(&mut self, index: usize) -> Self {
        self.raw = None;
        let Kind::Array(items, layout) = &mut self.kind else { unreachable!("validated array") };
        layout.remove(index);
        items.remove(index)
    }

    pub fn same_bytes(&self, other: &Self) -> bool {
        if let (Some(a), Some(b)) = (&self.raw, &other.raw) {
            return (Arc::ptr_eq(&a.text, &b.text) && a.span == b.span) || a.text() == b.text();
        }
        match (&self.kind, &other.kind) {
            (Kind::Scalar(a), Kind::Scalar(b)) => {
                if a != b {
                    return false;
                }
                match (&self.raw, &other.raw) {
                    (Some(raw), None) | (None, Some(raw)) => {
                        raw.text() == serde_json::to_string(a.as_ref()).expect("JSON value")
                    }
                    _ => true,
                }
            }
            (Kind::Object(a, al), Kind::Object(b, bl)) => {
                a.len() == b.len()
                    && same_layout(al, bl, a.len())
                    && a.iter().zip(b).all(|(a, b)| a.key == b.key && a.head == b.head && a.value.same_bytes(&b.value))
            }
            (Kind::Array(a, al), Kind::Array(b, bl)) => {
                a.len() == b.len() && same_layout(al, bl, a.len()) && a.iter().zip(b).all(|(a, b)| a.same_bytes(b))
            }
            _ => false,
        }
    }

    pub fn write(&self, output: &mut String) {
        if let Some(raw) = &self.raw {
            output.push_str(raw.text());
            return;
        }
        match &self.kind {
            Kind::Scalar(value) => output.push_str(&serde_json::to_string(value.as_ref()).expect("JSON value")),
            Kind::Object(items, layout) => {
                output.push('{');
                output.push_str(&layout.prefix);
                for (index, member) in items.iter().enumerate() {
                    if index > 0 {
                        output.push_str(layout.separator(index - 1));
                    }
                    output.push_str(&member.head);
                    member.value.write(output);
                }
                output.push_str(&layout.suffix);
                output.push('}');
            }
            Kind::Array(items, layout) => {
                output.push('[');
                output.push_str(&layout.prefix);
                for (index, item) in items.iter().enumerate() {
                    if index > 0 {
                        output.push_str(layout.separator(index - 1));
                    }
                    item.write(output);
                }
                output.push_str(&layout.suffix);
                output.push(']');
            }
        }
    }
}

fn same_layout(a: &Layout, b: &Layout, count: usize) -> bool {
    a.prefix == b.prefix
        && a.suffix == b.suffix
        && (0..count.saturating_sub(1)).all(|index| a.separator(index) == b.separator(index))
}

struct Parser {
    text: Arc<str>,
    pos: usize,
}

impl Parser {
    fn space(&mut self) {
        while self.text.as_bytes().get(self.pos).is_some_and(u8::is_ascii_whitespace) {
            self.pos += 1;
        }
    }

    fn string_end(&mut self) {
        self.pos += 1;
        loop {
            match self.text.as_bytes()[self.pos] {
                b'\\' => self.pos += 2,
                b'"' => {
                    self.pos += 1;
                    break;
                }
                _ => self.pos += 1,
            }
        }
    }

    fn node(&mut self) -> IdeResult<Node> {
        let start = self.pos;
        let kind = match self.text.as_bytes()[self.pos] {
            b'{' | b'[' => {
                let object = self.text.as_bytes()[self.pos] == b'{';
                let close = if object { b'}' } else { b']' };
                self.pos += 1;
                let gap = self.pos;
                self.space();
                let mut layout =
                    Layout { prefix: self.text[gap..self.pos].into(), separators: Vec::new(), suffix: String::new() };
                let mut members = Vec::new();
                let mut values = Vec::new();
                if self.text.as_bytes()[self.pos] != close {
                    loop {
                        if object {
                            let key_start = self.pos;
                            self.string_end();
                            let key: String = serde_json::from_str(&self.text[key_start..self.pos])
                                .map_err(|e| IdeError::invalid(e.to_string()))?;
                            if members.iter().any(|m: &Member| m.key == key) {
                                return Err(IdeError::invalid(
                                    "Duplicate JSON object keys are ambiguous; notebook was not opened",
                                ));
                            }
                            self.space();
                            self.pos += 1;
                            self.space();
                            let head = self.text[key_start..self.pos].into();
                            let value = self.node()?;
                            members.push(Member { key, head, value });
                        } else {
                            values.push(self.node()?);
                        }
                        let end = self.pos;
                        self.space();
                        if self.text.as_bytes()[self.pos] == close {
                            layout.suffix = self.text[end..self.pos].into();
                            break;
                        }
                        self.pos += 1;
                        self.space();
                        layout.separators.push(self.text[end..self.pos].into());
                    }
                }
                self.pos += 1;
                if object { Kind::Object(members, layout) } else { Kind::Array(values, layout) }
            }
            b'"' => {
                self.string_end();
                Kind::Scalar(Arc::new(
                    serde_json::from_str(&self.text[start..self.pos]).map_err(|e| IdeError::invalid(e.to_string()))?,
                ))
            }
            _ => {
                while self
                    .text
                    .as_bytes()
                    .get(self.pos)
                    .is_some_and(|b| !b.is_ascii_whitespace() && !b",]}".contains(b))
                {
                    self.pos += 1;
                }
                Kind::Scalar(Arc::new(
                    serde_json::from_str(&self.text[start..self.pos]).map_err(|e| IdeError::invalid(e.to_string()))?,
                ))
            }
        };
        Ok(Node { raw: Some(Raw { text: self.text.clone(), span: start..self.pos }), kind })
    }
}
