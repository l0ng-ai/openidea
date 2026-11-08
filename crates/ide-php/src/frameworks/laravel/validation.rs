//! Laravel validation rules: the built-in rules ([`RULES`], from the list
//! of available rules in Laravel's validation documentation, MIT), what
//! their parameters name ([`Params`]), the parts of a pipe-separated rule
//! string ([`segments`]), the rules a project registers itself
//! (`Validator::extend('name', …)`, [`custom_rule_names`]) and the
//! rewrite of a rule string as an array ([`rule_array`]).
//!
//! [`rule_type`] gives a validated field's type as a request property.
//!
//! The `validationRule` and `requestField` string references
//! ([`super::refs::validation_rule`]) build on these.

use crate::types::Type;

/// What a rule's parameters name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Params {
    /// No parameters.
    None,
    /// Values (sizes, formats, lists): nothing to complete.
    Values,
    /// The first parameter is another field, the rest are values
    /// (`required_if:anotherfield,value`).
    FirstField,
    /// Every parameter is another field (`required_with:foo,bar`).
    Fields,
    /// A table, then one of its columns (`exists:table,column`).
    Table,
}

/// A built-in rule.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RuleSpec {
    pub name: &'static str,
    /// The parameters as the documentation writes them (`min,max`); empty
    /// without any.
    pub signature: &'static str,
    /// The parameters must be given (a `:` follows the name).
    pub required: bool,
    pub params: Params,
}

const fn rule(name: &'static str) -> RuleSpec {
    RuleSpec { name, signature: "", required: false, params: Params::None }
}

const fn with(name: &'static str, signature: &'static str, params: Params) -> RuleSpec {
    RuleSpec { name, signature, required: true, params }
}

const fn optional(name: &'static str, signature: &'static str, params: Params) -> RuleSpec {
    RuleSpec { name, signature, required: false, params }
}

use Params::{Fields, FirstField, Table, Values};

/// Laravel's built-in rules, by name.
pub const RULES: &[RuleSpec] = &[
    rule("accepted"),
    with("accepted_if", "anotherfield,value", FirstField),
    rule("active_url"),
    with("after", "date", FirstField),
    with("after_or_equal", "date", FirstField),
    rule("alpha"),
    rule("alpha_dash"),
    rule("alpha_num"),
    optional("array", "keys", Values),
    rule("ascii"),
    rule("bail"),
    with("before", "date", FirstField),
    with("before_or_equal", "date", FirstField),
    with("between", "min,max", Values),
    rule("boolean"),
    optional("confirmed", "field", Fields),
    with("contains", "foo,bar", Values),
    optional("current_password", "guard", Values),
    rule("date"),
    with("date_equals", "date", FirstField),
    with("date_format", "format", Values),
    with("decimal", "min,max", Values),
    rule("declined"),
    with("declined_if", "anotherfield,value", FirstField),
    with("different", "field", Fields),
    with("digits", "value", Values),
    with("digits_between", "min,max", Values),
    optional("dimensions", "min_width=100,ratio=3/2", Values),
    optional("distinct", "strict", Values),
    with("doesnt_end_with", "foo,bar", Values),
    with("doesnt_start_with", "foo,bar", Values),
    optional("email", "rfc,dns", Values),
    with("ends_with", "foo,bar", Values),
    rule("exclude"),
    with("exclude_if", "anotherfield,value", FirstField),
    with("exclude_unless", "anotherfield,value", FirstField),
    with("exclude_with", "anotherfield", Fields),
    with("exclude_without", "anotherfield", Fields),
    with("exists", "table,column", Table),
    with("extensions", "foo,bar", Values),
    rule("file"),
    rule("filled"),
    with("gt", "field", Fields),
    with("gte", "field", Fields),
    rule("hex_color"),
    rule("image"),
    with("in", "foo,bar", Values),
    with("in_array", "anotherfield.*", Fields),
    rule("integer"),
    rule("ip"),
    rule("ipv4"),
    rule("ipv6"),
    rule("json"),
    rule("list"),
    rule("lowercase"),
    with("lt", "field", Fields),
    with("lte", "field", Fields),
    rule("mac_address"),
    with("max", "value", Values),
    with("max_digits", "value", Values),
    with("mimes", "foo,bar", Values),
    with("mimetypes", "text/plain,…", Values),
    with("min", "value", Values),
    with("min_digits", "value", Values),
    rule("missing"),
    with("missing_if", "anotherfield,value", FirstField),
    with("missing_unless", "anotherfield,value", FirstField),
    with("missing_with", "foo,bar", Fields),
    with("missing_with_all", "foo,bar", Fields),
    with("multiple_of", "value", Values),
    with("not_in", "foo,bar", Values),
    with("not_regex", "pattern", Values),
    rule("nullable"),
    rule("numeric"),
    rule("present"),
    with("present_if", "anotherfield,value", FirstField),
    with("present_unless", "anotherfield,value", FirstField),
    with("present_with", "foo,bar", Fields),
    with("present_with_all", "foo,bar", Fields),
    rule("prohibited"),
    with("prohibited_if", "anotherfield,value", FirstField),
    with("prohibited_unless", "anotherfield,value", FirstField),
    with("prohibits", "anotherfield", Fields),
    with("regex", "pattern", Values),
    rule("required"),
    with("required_array_keys", "foo,bar", Values),
    with("required_if", "anotherfield,value", FirstField),
    with("required_if_accepted", "anotherfield", Fields),
    with("required_if_declined", "anotherfield", Fields),
    with("required_unless", "anotherfield,value", FirstField),
    with("required_with", "foo,bar", Fields),
    with("required_with_all", "foo,bar", Fields),
    with("required_without", "foo,bar", Fields),
    with("required_without_all", "foo,bar", Fields),
    with("same", "field", Fields),
    with("size", "value", Values),
    rule("sometimes"),
    with("starts_with", "foo,bar", Values),
    rule("string"),
    optional("timezone", "all", Values),
    rule("ulid"),
    with("unique", "table,column", Table),
    rule("uppercase"),
    optional("url", "http,https", Values),
    optional("uuid", "4", Values),
];

/// The built-in rule `name` (any case, as Laravel studly-cases it).
pub fn rule_spec(name: &str) -> Option<&'static RuleSpec> {
    let wanted = snake_name(name);
    RULES.iter().find(|spec| spec.name == wanted)
}

/// `RequiredIf` and `required_if` are the same rule.
fn snake_name(name: &str) -> String {
    let mut out = String::new();
    for (i, c) in name.trim().chars().enumerate() {
        if c.is_ascii_uppercase() {
            if i > 0 && !out.ends_with('_') {
                out.push('_');
            }
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// One rule of a rule string: `max:255` in `required|max:255`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Segment<'v> {
    /// Its byte range in the string.
    pub start: usize,
    pub end: usize,
    /// The rule's name and where it ends.
    pub name: &'v str,
    pub name_end: usize,
    /// The parameters after the `:`, when there is one.
    pub params: Option<&'v str>,
}

impl Segment<'_> {
    /// The parameter at byte `at` of the string: its index, start and end.
    pub fn param_at(&self, at: usize) -> Option<(usize, usize, usize)> {
        let params = self.params?;
        let base = self.name_end + 1;
        if at < base {
            return None;
        }
        let mut start = base;
        for (index, part) in params.split(',').enumerate() {
            let end = start + part.len();
            if at <= end {
                return Some((index, start, end));
            }
            start = end + 1;
        }
        None
    }

    /// The parameter `index`.
    pub fn param(&self, index: usize) -> Option<&str> {
        self.params?.split(',').nth(index).map(str::trim)
    }
}

/// The rules of a rule string, split at `|` (a `regex:` rule keeps the
/// rest of the string, as it may hold `|` itself).
pub fn segments(value: &str) -> Vec<Segment<'_>> {
    let mut out = Vec::new();
    let mut start = 0;
    while start <= value.len() {
        let rest = &value[start..];
        let is_regex = rest.starts_with("regex:") || rest.starts_with("not_regex:");
        let end = if is_regex { value.len() } else { rest.find('|').map_or(value.len(), |at| start + at) };
        let text = &value[start..end];
        let (name, params) = match text.split_once(':') {
            Some((name, params)) => (name, Some(params)),
            None => (text, None),
        };
        out.push(Segment { start, end, name, name_end: start + name.len(), params });
        start = end + 1;
    }
    out
}

/// The segment holding byte `at` of `value`.
pub fn segment_at(value: &str, at: usize) -> Option<Segment<'_>> {
    segments(value).into_iter().find(|segment| segment.start <= at && at <= segment.end)
}

/// The names of the rules a project registers with `Validator::extend`,
/// `extendImplicit` or `extendDependent` in `text`.
pub fn custom_rule_names(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for method in ["extend(", "extendImplicit(", "extendDependent("] {
        let mut from = 0;
        while let Some(found) = text[from..].find(method) {
            let at = from + found + method.len();
            from = at;
            if !text[..at - method.len()].trim_end().ends_with("::") && !text[..at - method.len()].ends_with("->") {
                continue;
            }
            let rest = text[at..].trim_start();
            let Some(quote) = rest.chars().next().filter(|c| *c == '\'' || *c == '"') else { continue };
            let Some(end) = rest[1..].find(quote) else { continue };
            let name = &rest[1..1 + end];
            if !name.is_empty() && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
                out.push(snake_name(name));
            }
        }
    }
    out
}

/// The rules of a rule string that are neither built in nor in `custom`.
pub fn unknown_rules<'v>(value: &'v str, custom: &[String]) -> Vec<&'v str> {
    segments(value)
        .into_iter()
        .map(|segment| segment.name.trim())
        .filter(|name| !name.is_empty() && rule_spec(name).is_none() && !custom.contains(&snake_name(name)))
        .collect()
}

/// Laravel's uploaded file class.
pub const UPLOADED_FILE: &str = "Illuminate\\Http\\UploadedFile";

/// The type a field validated by `rules` (rule names) has when read as a
/// request property: the first rule naming a type decides it (`integer`
/// is `int`, `file` an uploaded file, `string`/`email`/`date` a string),
/// `mixed` without any; nullable unless the field is `required` (an absent
/// field reads as `null`) or when `nullable`.
pub fn rule_type<S: AsRef<str>>(rules: &[S]) -> Type {
    let names: Vec<String> = rules.iter().map(|rule| snake_name(rule.as_ref())).collect();
    let has = |wanted: &[&str]| names.iter().any(|name| wanted.contains(&name.as_str()));
    let ty = names.iter().find_map(|name| {
        Some(match name.as_str() {
            "integer" | "digits" | "digits_between" => Type::Int,
            "numeric" | "decimal" => Type::union(vec![Type::Int, Type::Float]),
            "boolean" | "accepted" | "declined" => Type::Bool,
            "array" | "list" => Type::array(),
            "file" | "image" | "mimes" | "mimetypes" | "extensions" | "dimensions" => Type::named(UPLOADED_FILE),
            "string" | "email" | "url" | "active_url" | "uuid" | "ulid" | "alpha" | "alpha_dash" | "alpha_num"
            | "ascii" | "ip" | "ipv4" | "ipv6" | "mac_address" | "json" | "date" | "date_format" | "timezone"
            | "hex_color" | "lowercase" | "uppercase" | "regex" | "not_regex" | "starts_with" | "ends_with" => {
                Type::string()
            }
            _ => return None,
        })
    });
    let Some(ty) = ty else { return Type::Mixed };
    if has(&["required"]) && !has(&["nullable"]) { ty } else { ty.nullable() }
}

/// The rule string `value` written as an array with `quote` around each
/// rule (`['required', 'max:255']`); `None` when it can't be (a regular
/// expression may hold `|` or `,`).
pub fn rule_array(value: &str, quote: char) -> Option<String> {
    if value.contains("regex:") || value.contains(['\\', '$', '{', quote]) {
        return None;
    }
    let items: Vec<String> = segments(value)
        .into_iter()
        .map(|segment| value[segment.start..segment.end].trim())
        .filter(|rule| !rule.is_empty())
        .map(|rule| format!("{quote}{rule}{quote}"))
        .collect();
    Some(format!("[{}]", items.join(", ")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_rule_strings() {
        let found: Vec<(&str, Option<&str>)> =
            segments("required|max:255||regex:/a|b/").into_iter().map(|s| (s.name, s.params)).collect();
        assert_eq!(found, [("required", None), ("max", Some("255")), ("", None), ("regex", Some("/a|b/"))]);
        let segment = segment_at("required|exists:posts,slug", 22).unwrap();
        assert_eq!(segment.name, "exists");
        assert_eq!(segment.param_at(22), Some((1, 22, 26)));
        assert_eq!(segment.param_at(16), Some((0, 16, 21)));
        assert_eq!(segment.param_at(10), None);
        assert_eq!(segment.param(0), Some("posts"));
        assert_eq!(segments("").len(), 1);
    }

    #[test]
    fn knows_rules_and_custom_ones() {
        assert!(rule_spec("required_if").is_some());
        assert!(rule_spec("RequiredIf").is_some());
        assert!(rule_spec("requird").is_none());
        let custom = custom_rule_names(
            "Validator::extend('phone_number', fn () => true);\n$v->extendImplicit(\"Foo\", $c);\nextend('nope');",
        );
        assert_eq!(custom, ["phone_number", "foo"]);
        assert_eq!(unknown_rules("required|requird|phone_number|max:3", &custom), ["requird"]);
    }

    #[test]
    fn writes_rule_strings_as_arrays() {
        assert_eq!(rule_array("required|max:255", '\'').as_deref(), Some("['required', 'max:255']"));
        assert_eq!(rule_array("nullable", '"').as_deref(), Some("[\"nullable\"]"));
        assert_eq!(rule_array("regex:/a|b/", '\''), None);
    }
}
