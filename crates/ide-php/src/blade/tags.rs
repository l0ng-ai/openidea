//! Blade component tags (`<x-alert type="info" :message="$m" />`): their
//! names and attributes, as Laravel's `ComponentTagCompiler` (MIT) reads
//! them. An attribute whose name starts with one `:` is bound: its value
//! is a PHP expression (`:$message` is short for `:message="$message"`);
//! `::name` is passed on as written.

use std::ops::Range as Span;

/// One attribute of a component tag.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Attribute {
    /// The name as written, `:` included.
    pub name: Span<u32>,
    /// Inside the quotes (or the unquoted value); `None` without `=`.
    pub value: Option<Span<u32>>,
}

/// An opening (or self-closing) component tag.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComponentTag {
    /// The `<`.
    pub start: u32,
    /// The component's name, after `x-` (`alert`, `forms.input`, `billing::alert`).
    pub name: Span<u32>,
    pub attributes: Vec<Attribute>,
    /// After the `>`, or the end of the text when the tag isn't closed.
    pub end: u32,
    /// The `>` was found.
    pub closed: bool,
}

impl Attribute {
    /// The PHP of a bound attribute (`:name="…"`, `:$name`).
    pub fn bound_code(&self, text: &str) -> Option<Span<u32>> {
        let name = &text[self.name.start as usize..self.name.end as usize];
        let bare = name.strip_prefix(':').filter(|bare| !bare.starts_with(':'))?;
        match &self.value {
            Some(value) => Some(value.clone()),
            None => bare.starts_with('$').then(|| self.name.start + 1..self.name.end),
        }
    }

    /// The attribute's name without a leading `:` (or `:$`).
    pub fn bare_name<'t>(&self, text: &'t str) -> &'t str {
        let name = &text[self.name.start as usize..self.name.end as usize];
        name.strip_prefix(':').map_or(name, |bare| bare.strip_prefix('$').unwrap_or(bare))
    }
}

fn is_name(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':')
}

/// The component tag whose `<` is at `start`, if one starts there.
pub fn tag_at(text: &str, start: usize) -> Option<ComponentTag> {
    let b = text.as_bytes();
    let n = b.len();
    if b.get(start) != Some(&b'<') || !(b[start + 1..].starts_with(b"x-") || b[start + 1..].starts_with(b"x:")) {
        return None;
    }
    let name_start = start + 3;
    let name_end = (name_start..n).find(|&at| !is_name(b[at])).unwrap_or(n);
    let mut tag = ComponentTag {
        start: start as u32,
        name: name_start as u32..name_end as u32,
        attributes: Vec::new(),
        end: n as u32,
        closed: false,
    };
    let mut i = name_end;
    while i < n {
        match b[i] {
            b'>' => {
                tag.end = i as u32 + 1;
                tag.closed = true;
                return Some(tag);
            }
            b'/' if b.get(i + 1) == Some(&b'>') => {
                tag.end = i as u32 + 2;
                tag.closed = true;
                return Some(tag);
            }
            b'<' => {
                // Another tag starts: this one was never closed.
                tag.end = i as u32;
                return Some(tag);
            }
            c if c.is_ascii_whitespace() || c == b'/' => i += 1,
            b'{' if b.get(i + 1) == Some(&b'{') => {
                // `{{ $attributes }}` among the attributes.
                i = text[i..].find("}}").map_or(n, |at| i + at + 2);
            }
            _ => {
                let attr_start = i;
                while i < n && !b[i].is_ascii_whitespace() && !matches!(b[i], b'=' | b'>' | b'<' | b'"' | b'\'') {
                    if b[i] == b'/' && b.get(i + 1) == Some(&b'>') {
                        break;
                    }
                    i += 1;
                }
                if i == attr_start {
                    i += 1;
                    continue;
                }
                let name = attr_start as u32..i as u32;
                let mut value = None;
                if b.get(i) == Some(&b'=') {
                    i += 1;
                    match b.get(i) {
                        Some(&quote) if quote == b'"' || quote == b'\'' => {
                            let open = i + 1;
                            let close = (open..n).find(|&at| b[at] == quote).unwrap_or(n);
                            value = Some(open as u32..close as u32);
                            i = (close + 1).min(n);
                        }
                        _ => {
                            let open = i;
                            while i < n && !b[i].is_ascii_whitespace() && b[i] != b'>' {
                                i += 1;
                            }
                            value = Some(open as u32..i as u32);
                        }
                    }
                }
                tag.attributes.push(Attribute { name, value });
            }
        }
    }
    Some(tag)
}

/// The component tags of `text`, in order.
pub fn component_tags(text: &str) -> Vec<ComponentTag> {
    let mut tags = Vec::new();
    let mut from = 0;
    while let Some(at) = text[from..].find("<x") {
        let start = from + at;
        match tag_at(text, start) {
            Some(tag) => {
                from = (tag.end as usize).max(start + 1);
                tags.push(tag);
            }
            None => from = start + 2,
        }
    }
    tags
}

/// Where the caret is in a component tag.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TagPlace {
    /// In the name: `<x-al|`. The span is the name after `x-`.
    Name(Span<u32>),
    /// On an attribute name (or where one starts): the tag's component and
    /// the span of the name, a leading `:` excluded.
    Attribute { component: String, name: Span<u32>, bound: bool },
}

/// What the caret at `offset` is on in a component tag, if it is in one
/// (and not in an attribute's value).
pub fn tag_place(text: &str, offset: u32) -> Option<TagPlace> {
    let b = text.as_bytes();
    let offset = (offset as usize).min(b.len());
    // The nearest `<x` before the caret, not closed before it.
    let start = text[..offset].rfind("<x")?;
    let tag = tag_at(text, start)?;
    if tag.closed && offset >= tag.end as usize {
        return None;
    }
    if tag.name.start as usize <= offset && offset <= tag.name.end as usize {
        return Some(TagPlace::Name(tag.name.clone()));
    }
    let component = text[tag.name.start as usize..tag.name.end as usize].to_owned();
    for attribute in &tag.attributes {
        if let Some(value) = &attribute.value
            && value.start as usize <= offset
            && offset <= value.end as usize
            && offset > attribute.name.end as usize
        {
            return None;
        }
        if attribute.name.start as usize <= offset && offset <= attribute.name.end as usize {
            let bound = b[attribute.name.start as usize] == b':';
            let name_start = attribute.name.start + u32::from(bound);
            let name_start =
                if bound && b.get(name_start as usize) == Some(&b'$') { name_start + 1 } else { name_start };
            return Some(TagPlace::Attribute { component, name: name_start..attribute.name.end, bound });
        }
    }
    // Between attributes: a new one starts here.
    let previous = b.get(offset.wrapping_sub(1)).copied().unwrap_or(b' ');
    previous.is_ascii_whitespace().then_some(TagPlace::Attribute {
        component,
        name: offset as u32..offset as u32,
        bound: false,
    })
}
