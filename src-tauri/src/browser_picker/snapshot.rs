use ide_core::{IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use specta::Type;

/// Page text, URLs, classes, attribute values and form contents never enter the snapshot.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Selection {
    path: Vec<Step>,
    disabled: bool,
    hidden: bool,
    aria_disabled: bool,
    display: String,
    position: String,
    visibility: String,
    pointer_events: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Step {
    tag: String,
    index: u16,
}

#[derive(Debug, Serialize, Type)]
pub struct InspectedElement {
    pub selector: String,
    pub html: String,
    pub styles: String,
}

impl Selection {
    pub(super) fn preview(&self) -> IdeResult<InspectedElement> {
        let invalid = || IdeError::invalid("The page returned an unsupported element selection");
        if self.path.is_empty() || self.path.len() > 8 {
            return Err(invalid());
        }
        let mut parts = Vec::with_capacity(self.path.len());
        for step in &self.path {
            if step.index == 0
                || step.tag.len() > 64
                || !step.tag.starts_with(|c: char| c.is_ascii_alphabetic())
                || !step.tag.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
            {
                return Err(invalid());
            }
            parts.push(format!("{}:nth-of-type({})", step.tag, step.index));
        }
        let tag = &self.path.last().ok_or_else(invalid)?.tag;
        let mut html = format!("<{tag}");
        if self.disabled {
            html.push_str(" disabled");
        }
        if self.hidden {
            html.push_str(" hidden");
        }
        if self.aria_disabled {
            html.push_str(" aria-disabled=\"true\"");
        }
        html.push('>');
        let mut styles = Vec::new();
        for (name, value) in [
            ("display", &self.display),
            ("position", &self.position),
            ("visibility", &self.visibility),
            ("pointer-events", &self.pointer_events),
        ] {
            if value.is_empty()
                || value.len() > 48
                || !value.bytes().all(|c| c.is_ascii_alphabetic() || matches!(c, b' ' | b'-'))
            {
                return Err(invalid());
            }
            // CSSOM keywords only. A page can replace its JS getters; arbitrary words must
            // not become agent prompt text. Omit new engine-specific values until recognized.
            let keywords = match name {
                "display" => {
                    "none contents block inline run-in flow flow-root flex grid grid-lanes table list-item inline-block inline-flex inline-grid inline-table table-row-group table-header-group table-footer-group table-row table-cell table-column-group table-column table-caption ruby ruby-base ruby-text ruby-base-container ruby-text-container -webkit-box -webkit-inline-box"
                }
                "position" => "static relative absolute fixed sticky -webkit-sticky",
                "visibility" => "visible hidden collapse",
                _ => "auto none visiblePainted visibleFill visibleStroke visible painted fill stroke all bounding-box",
            };
            let known = |token: &str| keywords.split(' ').any(|word| word.eq_ignore_ascii_case(token));
            let recognized = if name == "display" {
                value.split(' ').take(4).count() <= 3 && value.split(' ').all(known)
            } else {
                known(value)
            };
            if recognized {
                styles.push(format!("{name}: {value};"));
            }
        }
        Ok(InspectedElement { selector: parts.join(" > "), html, styles: styles.join("\n") })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn selection() -> Value {
        json!({"path": [{"tag":"main","index":1},{"tag":"button","index":2}], "disabled":true,
            "hidden":false, "ariaDisabled":true, "display":"inline-flex", "position":"static",
            "visibility":"visible", "pointerEvents":"none"})
    }

    #[test]
    fn builds_the_preview_only_from_structured_fields() {
        let capture: Selection = serde_json::from_value(selection()).unwrap();
        let preview = capture.preview().unwrap();
        assert_eq!(preview.selector, "main:nth-of-type(1) > button:nth-of-type(2)");
        assert_eq!(preview.html, "<button disabled aria-disabled=\"true\">");
        assert_eq!(
            preview.styles,
            "display: inline-flex;\nposition: static;\nvisibility: visible;\npointer-events: none;"
        );
    }

    #[test]
    fn omits_page_supplied_words_in_place_of_a_css_keyword() {
        let mut value = selection();
        value["display"] = json!("private content");
        let preview = serde_json::from_value::<Selection>(value).unwrap().preview().unwrap();
        assert!(!preview.styles.contains("private"));
        assert!(preview.styles.contains("pointer-events: none;"));
    }

    #[test]
    fn rejects_extra_content_invalid_paths_and_unbounded_styles() {
        let mut value = selection();
        value["outerHTML"] = json!("unreviewed text");
        assert!(serde_json::from_value::<Selection>(value).is_err());
        for (field, invalid) in [
            ("path", json!([])),
            ("path", json!(vec![json!({"tag":"div","index":1}); 9])),
            ("path", json!([{"tag":"button><a","index":1}])),
            ("path", json!([{"tag":"div","index":0}])),
            ("display", json!("url(local)")),
            ("position", json!("x".repeat(49))),
        ] {
            let mut value = selection();
            value[field] = invalid;
            assert!(serde_json::from_value::<Selection>(value).unwrap().preview().is_err());
        }
    }
}
