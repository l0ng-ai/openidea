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
    tag_at_with(text, start, BLADE_PREFIXES)
}

/// What a Blade component tag's name follows.
const BLADE_PREFIXES: &[&str] = &["x-", "x:"];

/// What a Livewire component tag's name follows (`<livewire:counter />`).
pub const LIVEWIRE_PREFIXES: &[&str] = &["livewire:"];

/// The tag whose `<` is at `start` and whose name follows one of
/// `prefixes`, if one starts there.
pub fn tag_at_with(text: &str, start: usize, prefixes: &[&str]) -> Option<ComponentTag> {
    let b = text.as_bytes();
    let n = b.len();
    if b.get(start) != Some(&b'<') {
        return None;
    }
    let prefix = prefixes.iter().find(|prefix| b[start + 1..].starts_with(prefix.as_bytes()))?;
    let name_start = start + 1 + prefix.len();
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
    tag_place_with(text, offset, BLADE_PREFIXES)
}

/// [`tag_place`] in a tag whose name follows one of `prefixes`
/// ([`LIVEWIRE_PREFIXES`]); the spans are the same.
pub fn tag_place_with(text: &str, offset: u32, prefixes: &[&str]) -> Option<TagPlace> {
    let b = text.as_bytes();
    let offset = (offset as usize).min(b.len());
    // The nearest tag opening before the caret, not closed before it.
    let start = prefixes.iter().filter_map(|prefix| text[..offset].rfind(&format!("<{prefix}"))).max()?;
    let tag = tag_at_with(text, start, prefixes)?;
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

impl ComponentTag {
    /// Written `<x-… />`: it has no body.
    pub fn self_closing(&self, text: &str) -> bool {
        self.closed && text[..self.end as usize].ends_with("/>")
    }

    /// The tag's name after `x-`.
    pub fn name<'t>(&self, text: &'t str) -> &'t str {
        &text[self.name.start as usize..self.name.end as usize]
    }
}

/// Whether `name` (after `x-`) is a slot of the enclosing component
/// (`slot`, `slot:title`) rather than a component.
pub fn is_slot(name: &str) -> bool {
    name == "slot" || name.starts_with("slot:")
}

/// The tag names Blade itself handles: slots and `<x-dynamic-component>`.
pub fn is_builtin(name: &str) -> bool {
    is_slot(name) || name == DYNAMIC_COMPONENT
}

/// `<x-dynamic-component component="alert" />`: the component its
/// `component` attribute names.
pub const DYNAMIC_COMPONENT: &str = "dynamic-component";

/// The component whose body `offset` is in: the nearest component tag
/// before it (neither a slot nor self-closing) that no `</x-…>` closes
/// before it. Its name after `x-`.
pub fn enclosing_component(text: &str, offset: u32) -> Option<String> {
    let offset = (offset as usize).min(text.len());
    // (position, Some(opened name) | None for a closing tag with its name).
    let mut events: Vec<(usize, bool, String)> = Vec::new();
    for tag in component_tags(&text[..offset]) {
        let name = tag.name(text).to_owned();
        if tag.closed && !tag.self_closing(text) && !is_slot(&name) && (tag.end as usize) <= offset {
            events.push((tag.start as usize, true, name));
        }
    }
    let mut from = 0;
    while let Some(at) = text[from..offset].find("</x-") {
        let start = from + at;
        let name_start = start + 4;
        let name_end = (name_start..offset).find(|&i| !is_name(text.as_bytes()[i])).unwrap_or(offset);
        events.push((start, false, text[name_start..name_end].to_owned()));
        from = name_end.max(start + 4);
    }
    events.sort_by_key(|(at, ..)| *at);
    let mut open: Vec<String> = Vec::new();
    for (_, opens, name) in events {
        if opens {
            open.push(name);
        } else if let Some(at) = open.iter().rposition(|known| *known == name) {
            open.truncate(at);
        }
    }
    open.pop()
}

/// The value of attribute `attribute` of the `<x-{tag}` tag the caret at
/// `offset` is in, when the caret is inside that value.
pub fn attribute_value_at(text: &str, offset: u32, tag: &str, attribute: &str) -> Option<Span<u32>> {
    let start = text[..(offset as usize).min(text.len())].rfind(&format!("<x-{tag}"))?;
    let found = tag_at(text, start)?;
    if found.name(text) != tag || found.closed && offset >= found.end {
        return None;
    }
    found
        .attributes
        .iter()
        .find(|known| known.bare_name(text) == attribute && !text[known.name.start as usize..].starts_with(':'))
        .and_then(|known| known.value.clone())
        .filter(|value| value.start <= offset && offset <= value.end)
}
