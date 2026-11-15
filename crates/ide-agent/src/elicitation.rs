//! ACP elicitation in form mode: the agent's restricted JSON Schema as form fields, and the
//! user's answer as the `elicitation/create` response.

use crate::model::{AgentForm, AgentFormField, AgentFormFieldKind, AgentFormOption, AgentPermissionOption};
use serde::Deserialize;
use serde::de::{Deserializer, IgnoredAny, MapAccess, Visitor};
use serde_json::{Map, Value, json};

/// The reply that declines the form; a JSON object of field name to values accepts it, and
/// anything else cancels it.
const DECLINE: &str = "decline";

/// The form `elicitation/create` asks for; `Err` when it asks for something else.
pub(crate) fn form_of(params: &Value) -> Result<AgentForm, String> {
    if params.get("mode").and_then(Value::as_str) != Some("form") {
        return Err("only form elicitation is supported".to_owned());
    }
    let schema = params.get("requestedSchema").ok_or("requestedSchema is missing")?;
    let required: Vec<&str> = schema
        .get("required")
        .and_then(Value::as_array)
        .map(|names| names.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let properties = schema.get("properties").and_then(Value::as_object).ok_or("requestedSchema has no properties")?;
    let fields = properties
        .iter()
        .map(|(name, property)| field(name, property, required.contains(&name.as_str())))
        .collect::<Result<_, _>>()?;
    Ok(AgentForm { fields })
}

/// Orders the fields as the request's schema lists them: `Value` keeps object keys sorted, and
/// the agent's order is the one its form reads in.
pub(crate) fn in_schema_order(form: &mut AgentForm, raw: &[u8]) {
    #[derive(Deserialize)]
    struct Request {
        params: Params,
    }
    #[derive(Deserialize)]
    struct Params {
        #[serde(rename = "requestedSchema")]
        schema: Schema,
    }
    #[derive(Deserialize)]
    struct Schema {
        properties: Keys,
    }
    struct Keys(Vec<String>);
    impl<'de> Deserialize<'de> for Keys {
        fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            struct Visit;
            impl<'de> Visitor<'de> for Visit {
                type Value = Keys;
                fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                    f.write_str("an object")
                }
                fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Keys, A::Error> {
                    let mut keys = Vec::new();
                    while let Some((key, IgnoredAny)) = map.next_entry::<String, IgnoredAny>()? {
                        keys.push(key);
                    }
                    Ok(Keys(keys))
                }
            }
            deserializer.deserialize_map(Visit)
        }
    }
    let Ok(request) = serde_json::from_slice::<Request>(raw) else { return };
    let order = request.params.schema.properties.0;
    form.fields.sort_by_key(|field| order.iter().position(|name| *name == field.name).unwrap_or(usize::MAX));
}

fn field(name: &str, property: &Value, required: bool) -> Result<AgentFormField, String> {
    let text = |key: &str| property.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_owned();
    let number = |key: &str| property.get(key).and_then(Value::as_f64);
    let unsupported = || format!("field {name} has an unsupported schema");
    let (kind, options, min, max) = match property.get("type").and_then(Value::as_str) {
        Some("string") => match choices(property) {
            Some(options) => (AgentFormFieldKind::Choice, options, None, None),
            None => (AgentFormFieldKind::Text, Vec::new(), number("minLength"), number("maxLength")),
        },
        Some("number") => (AgentFormFieldKind::Number, Vec::new(), number("minimum"), number("maximum")),
        Some("integer") => (AgentFormFieldKind::Integer, Vec::new(), number("minimum"), number("maximum")),
        Some("boolean") => (AgentFormFieldKind::Boolean, Vec::new(), None, None),
        Some("array") => {
            let options = property.get("items").and_then(choices).ok_or_else(unsupported)?;
            (AgentFormFieldKind::Choices, options, number("minItems"), number("maxItems"))
        }
        _ => return Err(unsupported()),
    };
    let default = match property.get("default") {
        Some(Value::Array(values)) => values.iter().filter_map(scalar).collect(),
        Some(value) => scalar(value).into_iter().collect(),
        None => Vec::new(),
    };
    let title = text("title");
    Ok(AgentFormField {
        name: name.to_owned(),
        title: if title.is_empty() { name.to_owned() } else { title },
        description: text("description"),
        required,
        kind,
        options,
        default,
        min,
        max,
    })
}

/// The values of a choice: `enum` (titled by the legacy `enumNames`), or `oneOf` / `anyOf`
/// of `{ const, title }`.
fn choices(schema: &Value) -> Option<Vec<AgentFormOption>> {
    let option = |value: &str, label: Option<&str>, description: Option<&str>| AgentFormOption {
        value: value.to_owned(),
        label: label.filter(|l| !l.trim().is_empty()).unwrap_or(value).to_owned(),
        description: description.unwrap_or_default().trim().to_owned(),
    };
    if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        let names = schema.get("enumNames").and_then(Value::as_array);
        return Some(
            values
                .iter()
                .enumerate()
                .filter_map(|(i, value)| {
                    Some(option(value.as_str()?, names.and_then(|n| n.get(i)).and_then(Value::as_str), None))
                })
                .collect(),
        );
    }
    let listed = schema.get("oneOf").or_else(|| schema.get("anyOf"))?.as_array()?;
    Some(
        listed
            .iter()
            .filter_map(|o| {
                let text = |key: &str| o.get(key).and_then(Value::as_str);
                Some(option(text("const")?, text("title"), text("description")))
            })
            .collect(),
    )
}

fn scalar(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

/// A form is submitted from its own card; this option only names a declined form.
pub(crate) fn options() -> Vec<AgentPermissionOption> {
    vec![AgentPermissionOption { id: DECLINE.to_owned(), name: "Decline".to_owned(), kind: "reject_once".to_owned() }]
}

/// The `elicitation/create` response to the user's `reply`, and what the conversation
/// records as chosen.
pub(crate) fn answer(form: &AgentForm, reply: Option<&str>) -> (Value, String) {
    let values = match reply {
        Some(DECLINE) => return (json!({ "action": "decline" }), "Decline".to_owned()),
        Some(reply) => serde_json::from_str::<Map<String, Value>>(reply).ok(),
        None => None,
    };
    let Some(values) = values else { return (json!({ "action": "cancel" }), "Cancelled".to_owned()) };
    let mut content = Map::new();
    let mut shown = Vec::new();
    for field in &form.fields {
        let given: Vec<&str> = match values.get(&field.name) {
            Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).collect(),
            Some(Value::String(item)) => vec![item.as_str()],
            _ => Vec::new(),
        };
        let given: Vec<&str> = given.into_iter().map(str::trim).filter(|v| !v.is_empty()).collect();
        let Some(&first) = given.first() else { continue };
        let value = match field.kind {
            AgentFormFieldKind::Text | AgentFormFieldKind::Choice => json!(first),
            AgentFormFieldKind::Number => match first.parse::<f64>() {
                Ok(number) => json!(number),
                Err(_) => continue,
            },
            AgentFormFieldKind::Integer => match first.parse::<i64>() {
                Ok(number) => json!(number),
                Err(_) => continue,
            },
            AgentFormFieldKind::Boolean => json!(first == "true"),
            AgentFormFieldKind::Choices => json!(given),
        };
        let label = |value: &str| {
            field.options.iter().find(|o| o.value == value).map_or_else(|| value.to_owned(), |o| o.label.clone())
        };
        let text = match field.kind {
            AgentFormFieldKind::Boolean => (if first == "true" { "yes" } else { "no" }).to_owned(),
            AgentFormFieldKind::Choices => given.iter().map(|v| label(v)).collect::<Vec<_>>().join(", "),
            _ => label(first),
        };
        shown.push(format!("{}: {text}", field.title));
        content.insert(field.name.clone(), value);
    }
    let chosen = if shown.is_empty() { "Submitted".to_owned() } else { shown.join("; ") };
    (json!({ "action": "accept", "content": content }), chosen)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The form OMP's `ask` tool sends: a choice with a recommended default, then an
    /// optional typed answer beside it.
    fn ask() -> Value {
        json!({
            "sessionId": "s", "mode": "form", "message": "Which database?",
            "requestedSchema": { "type": "object", "properties": {
                "q0": { "type": "string", "title": "Which database?", "description": "Storage",
                        "oneOf": [{ "const": "pg", "title": "Postgres", "description": "Relational" },
                                  { "const": "sqlite", "title": "SQLite" }],
                        "default": "pg" },
                "q0__other": { "type": "string", "title": "Other (type your own)" }
            } }
        })
    }

    #[test]
    fn fields_follow_the_schema_order() {
        let raw = br#"{ "jsonrpc": "2.0", "id": 3, "method": "elicitation/create", "params": { "mode": "form",
            "requestedSchema": { "type": "object", "properties": {
                "strategy": { "type": "string" }, "tests": { "type": "boolean" }, "note": { "type": "string" }
            } } } }"#;
        let params = serde_json::from_slice::<Value>(raw).unwrap()["params"].take();
        let mut form = form_of(&params).unwrap();
        in_schema_order(&mut form, raw);
        assert_eq!(form.fields.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), ["strategy", "tests", "note"]);
    }

    #[test]
    fn reads_choices_and_text_fields() {
        let form = form_of(&ask()).unwrap();
        let [choice, other] = form.fields.as_slice() else { panic!("{form:?}") };
        assert_eq!((choice.name.as_str(), choice.kind, choice.required), ("q0", AgentFormFieldKind::Choice, false));
        assert_eq!(choice.options[0].label, "Postgres");
        assert_eq!(choice.options[0].description, "Relational");
        assert_eq!(choice.default, ["pg"]);
        assert_eq!((other.kind, other.title.as_str()), (AgentFormFieldKind::Text, "Other (type your own)"));
    }

    #[test]
    fn reads_every_restricted_schema_kind() {
        let form = form_of(&json!({ "mode": "form", "requestedSchema": {
            "type": "object", "required": ["count"],
            "properties": {
                "count": { "type": "integer", "minimum": 1, "maximum": 5 },
                "ratio": { "type": "number" },
                "ok": { "type": "boolean", "default": true },
                "size": { "type": "string", "enum": ["s", "l"], "enumNames": ["Small", "Large"] },
                "tags": { "type": "array", "items": { "anyOf": [{ "const": "a" }, { "const": "b" }] },
                          "default": ["b"], "maxItems": 2 }
            }
        } }))
        .unwrap();
        let field = |name: &str| form.fields.iter().find(|f| f.name == name).unwrap();
        use AgentFormFieldKind::*;
        let kinds: Vec<_> = ["count", "ratio", "ok", "size", "tags"].map(|name| field(name).kind).into();
        assert_eq!(kinds, [Integer, Number, Boolean, Choice, Choices]);
        assert!(field("count").required && !field("ratio").required);
        assert_eq!((field("count").min, field("count").max), (Some(1.0), Some(5.0)));
        assert_eq!(field("ok").default, ["true"]);
        assert_eq!(field("size").options[1].label, "Large");
        assert_eq!((field("tags").default.as_slice(), field("tags").max), (["b".to_owned()].as_slice(), Some(2.0)));
    }

    #[test]
    fn url_mode_and_unsupported_fields_are_refused() {
        assert!(form_of(&json!({ "mode": "url", "url": "https://example.com" })).is_err());
        let nested = json!({ "mode": "form", "requestedSchema": { "type": "object", "properties": {
            "address": { "type": "object" }
        } } });
        assert!(form_of(&nested).is_err());
    }

    #[test]
    fn an_answer_is_typed_by_its_field() {
        let form = form_of(&json!({ "mode": "form", "requestedSchema": { "type": "object", "properties": {
            "count": { "type": "integer" },
            "ok": { "type": "boolean" },
            "size": { "type": "string", "oneOf": [{ "const": "s", "title": "Small" }] },
            "tags": { "type": "array", "items": { "enum": ["a", "b"] } },
            "note": { "type": "string" }
        } } }))
        .unwrap();
        let reply = json!({ "count": ["3"], "ok": ["false"], "size": ["s"], "tags": ["a", "b"], "note": ["  "] });
        let (response, chosen) = answer(&form, Some(&reply.to_string()));
        assert_eq!(
            response,
            json!({ "action": "accept", "content": { "count": 3, "ok": false, "size": "s", "tags": ["a", "b"] } })
        );
        assert_eq!(chosen, "count: 3; ok: no; size: Small; tags: a, b");
    }

    #[test]
    fn declining_and_dismissing_send_no_content() {
        let form = form_of(&ask()).unwrap();
        assert_eq!(answer(&form, Some(DECLINE)), (json!({ "action": "decline" }), "Decline".to_owned()));
        assert_eq!(answer(&form, None).0, json!({ "action": "cancel" }));
        assert_eq!(answer(&form, Some("cancel")).0, json!({ "action": "cancel" }));
    }
}
