//! `{{field}}` / `{{field|filter|…}}` substitution and `when` conditions. The UI renders
//! field defaults with the same rules (`src/features/new-project/template.ts`).

use crate::model::{Values, When};

/// `template` with each `{{…}}` replaced; unknown fields render empty.
pub fn render(template: &str, values: &Values) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        let Some(len) = rest[start + 2..].find("}}") else { break };
        out.push_str(&rest[..start]);
        out.push_str(&expand(&rest[start + 2..start + 2 + len], values));
        rest = &rest[start + 2 + len + 2..];
    }
    out.push_str(rest);
    out
}

/// The field ids `template` refers to.
#[cfg(test)]
pub fn references(template: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        let Some(len) = rest[start + 2..].find("}}") else { break };
        let expr = &rest[start + 2..start + 2 + len];
        out.push(expr.split('|').next().unwrap_or_default().trim().to_owned());
        rest = &rest[start + 2 + len + 2..];
    }
    out
}

/// The filter names `template` uses.
#[cfg(test)]
pub fn filters(template: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        let Some(len) = rest[start + 2..].find("}}") else { break };
        out.extend(rest[start + 2..start + 2 + len].split('|').skip(1).map(|f| f.trim().to_owned()));
        rest = &rest[start + 2 + len + 2..];
    }
    out
}

#[cfg(test)]
pub const FILTERS: &[&str] = &["path", "ident", "kebab", "snake", "pascal", "lower", "json"];

fn expand(expr: &str, values: &Values) -> String {
    let mut parts = expr.split('|').map(str::trim);
    let name = parts.next().unwrap_or_default();
    let mut value = values.get(name).cloned().unwrap_or_default();
    for filter in parts {
        value = apply(filter, &value);
    }
    value
}

fn words(s: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut prev_lower = false;
    for c in s.chars() {
        if !c.is_alphanumeric() {
            if !word.is_empty() {
                words.push(std::mem::take(&mut word));
            }
            prev_lower = false;
            continue;
        }
        // `myApp` → `my`, `App`.
        if c.is_uppercase() && prev_lower && !word.is_empty() {
            words.push(std::mem::take(&mut word));
        }
        prev_lower = c.is_lowercase() || c.is_ascii_digit();
        word.push(c);
    }
    if !word.is_empty() {
        words.push(word);
    }
    words
}

fn apply(filter: &str, value: &str) -> String {
    match filter {
        // `com.example.app` → `com/example/app`
        "path" => value.replace('.', "/"),
        // A Java package segment: `My-App` → `myapp`, `1app` → `_1app`.
        "ident" => {
            let s: String = value.to_lowercase().chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
            if s.starts_with(|c: char| c.is_ascii_digit()) { format!("_{s}") } else { s }
        }
        "kebab" => words(value).iter().map(|w| w.to_lowercase()).collect::<Vec<_>>().join("-"),
        "snake" => words(value).iter().map(|w| w.to_lowercase()).collect::<Vec<_>>().join("_"),
        "pascal" => words(value)
            .iter()
            .map(|w| {
                let mut c = w.chars();
                match c.next() {
                    Some(first) => first.to_uppercase().chain(c.flat_map(char::to_lowercase)).collect(),
                    None => String::new(),
                }
            })
            .collect(),
        "lower" => value.to_lowercase(),
        // The inside of a JSON string.
        "json" => {
            let quoted = serde_json::to_string(value).unwrap_or_default();
            quoted[1..quoted.len() - 1].to_owned()
        }
        _ => value.to_owned(),
    }
}

/// Whether every field `when` lists has one of its values.
pub fn matches(when: &When, values: &Values) -> bool {
    when.iter().all(|(field, allowed)| {
        let value = values.get(field).map(String::as_str).unwrap_or_default();
        allowed.values().iter().any(|v| v == value)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::OneOrMany;

    fn values(pairs: &[(&str, &str)]) -> Values {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn renders_fields_and_filters() {
        let v = values(&[("group", "com.example"), ("name", "My Cool-App")]);
        assert_eq!(render("{{group}}.{{name|ident}}", &v), "com.example.mycoolapp");
        assert_eq!(render("src/{{group|path}}/{{ name | pascal }}.java", &v), "src/com/example/MyCoolApp.java");
        assert_eq!(render("{{name|kebab}} {{name|snake}}", &v), "my-cool-app my_cool_app");
        assert_eq!(render("{{missing}}x", &v), "x");
        assert_eq!(render("a {{ unclosed", &v), "a {{ unclosed");
        assert_eq!(render("{{name|ident}}", &values(&[("name", "1app")])), "_1app");
        assert_eq!(render("{{name|kebab}}", &values(&[("name", "myApp2")])), "my-app2");
    }

    #[test]
    fn lists_references_and_filters() {
        assert_eq!(references("{{a}}-{{ b | path }}"), ["a", "b"]);
        assert_eq!(filters("{{a}}-{{ b | path | lower }}"), ["path", "lower"]);
    }

    #[test]
    fn when_needs_every_field_to_match() {
        let v = values(&[("build", "gradle"), ("lang", "kotlin")]);
        let mut when = When::new();
        assert!(matches(&when, &v));
        when.insert("build".into(), OneOrMany::Many(vec!["maven".into(), "gradle".into()]));
        assert!(matches(&when, &v));
        when.insert("lang".into(), OneOrMany::One("java".into()));
        assert!(!matches(&when, &v));
    }
}
