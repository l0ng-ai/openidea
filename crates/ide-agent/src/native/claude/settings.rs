//! A session's settings as ACP config options: model, permission mode and effort, from
//! what Claude Code reports in its `initialize` and `get_settings` responses.

use serde_json::{Value, json};

#[derive(Clone, Debug, Default)]
pub(super) struct Model {
    pub value: String,
    pub name: String,
    pub description: Option<String>,
    pub resolved: Option<String>,
    pub efforts: Vec<String>,
    pub auto_mode: bool,
}

#[derive(Clone, Debug, Default)]
pub(super) struct Settings {
    pub models: Vec<Model>,
    /// The model option's value.
    pub model: String,
    /// `default`, or an effort level.
    pub effort: String,
    pub mode: String,
    /// ACP `availableCommands`.
    pub commands: Vec<Value>,
}

pub(super) const MODEL: &str = "model";
pub(super) const MODE: &str = "mode";
pub(super) const EFFORT: &str = "effort";

const MODES: [(&str, &str, &str); 5] = [
    ("default", "Default", "Ask before edits and commands"),
    ("acceptEdits", "Accept edits", "Edit files without asking"),
    ("plan", "Plan", "Plan before making changes"),
    ("auto", "Auto", "Claude decides what needs asking"),
    ("bypassPermissions", "Bypass permissions", "Never ask"),
];

impl Settings {
    /// From the `initialize` response and `get_settings`' `applied` and `effective`.
    pub fn from_cli(init: &Value, settings: &Value) -> Self {
        let models: Vec<Model> = init
            .get("models")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|m| {
                let s = |k: &str| m.get(k).and_then(Value::as_str).map(str::to_owned);
                let value = s("value")?;
                Some(Model {
                    name: s("displayName").unwrap_or_else(|| value.clone()),
                    description: s("description"),
                    resolved: s("resolvedModel"),
                    efforts: if m.get("supportsEffort").and_then(Value::as_bool) == Some(true) {
                        m.get("supportedEffortLevels")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                            .filter_map(|l| l.as_str().map(str::to_owned))
                            .collect()
                    } else {
                        Vec::new()
                    },
                    auto_mode: m.get("supportsAutoMode").and_then(Value::as_bool) == Some(true),
                    value,
                })
            })
            .collect();
        let applied = settings.pointer("/applied/model").and_then(Value::as_str);
        let configured = settings.pointer("/effective/model").and_then(Value::as_str);
        let mut out = Self {
            models,
            model: String::new(),
            effort: settings.pointer("/applied/effort").and_then(Value::as_str).unwrap_or("default").to_owned(),
            mode: init.get("current_permission_mode").and_then(Value::as_str).unwrap_or("default").to_owned(),
            commands: commands(init.get("commands"), &[]),
        };
        out.model = out.model_value(configured, applied);
        out
    }

    /// The model option's value for the configured alias and the model it runs.
    fn model_value(&mut self, configured: Option<&str>, applied: Option<&str>) -> String {
        let runs = |m: &Model| applied.is_none_or(|a| m.value == a || m.resolved.as_deref() == Some(a));
        // The configured alias, unless the session runs another model (`--model`).
        if let Some(c) = configured.filter(|c| self.models.iter().any(|m| m.value == *c && runs(m))) {
            return c.to_owned();
        }
        let Some(applied) = applied else { return self.models.first().map(|m| m.value.clone()).unwrap_or_default() };
        if configured.is_none() && self.models.iter().find(|m| m.value == "default").is_some_and(runs) {
            return "default".into();
        }
        if let Some(m) = self.models.iter().find(|m| runs(m)) {
            return m.value.clone();
        }
        self.models.push(Model { value: applied.to_owned(), name: applied.to_owned(), ..Model::default() });
        applied.to_owned()
    }

    fn current_model(&self) -> Option<&Model> {
        self.models.iter().find(|m| m.value == self.model)
    }

    /// After a model change: an effort it doesn't offer goes back to the default.
    pub fn set_model(&mut self, value: &str) {
        self.model = value.to_owned();
        let efforts = self.current_model().map(|m| m.efforts.clone()).unwrap_or_default();
        if self.effort != "default" && !efforts.contains(&self.effort) {
            self.effort = "default".into();
        }
    }

    pub fn modes(&self) -> Vec<&'static str> {
        let auto = self.current_model().is_some_and(|m| m.auto_mode);
        MODES.iter().map(|m| m.0).filter(|m| *m != "auto" || auto).collect()
    }

    pub fn options(&self) -> Value {
        let mut out = vec![json!({
            "id": MODE, "name": "Mode", "category": "mode", "type": "select", "currentValue": self.mode,
            "options": MODES.iter().filter(|m| self.modes().contains(&m.0))
                .map(|(v, n, d)| json!({ "value": v, "name": n, "description": d })).collect::<Vec<_>>(),
        })];
        if !self.models.is_empty() {
            out.push(json!({
                "id": MODEL, "name": "Model", "category": "model", "type": "select", "currentValue": self.model,
                "options": self.models.iter().map(|m| {
                    let mut o = json!({ "value": m.value, "name": m.name });
                    if let Some(d) = &m.description { o["description"] = json!(d); }
                    o
                }).collect::<Vec<_>>(),
            }));
        }
        if let Some(effort) = self.current_model().and_then(|m| effort_option(m, &self.effort)) {
            out.push(effort);
        }
        Value::Array(out)
    }

    /// Each model's effort option by model value (`None`: it has no effort levels): what a new
    /// task offers once that model is picked, before any session has run it.
    pub fn efforts_by_model(&self) -> Vec<(String, Option<Value>)> {
        self.models.iter().map(|m| (m.value.clone(), effort_option(m, &self.effort))).collect()
    }

    pub fn valid(&self, option: &str, value: &str) -> bool {
        self.options()
            .as_array()
            .into_iter()
            .flatten()
            .find(|o| o["id"] == option)
            .and_then(|o| o["options"].as_array())
            .is_some_and(|vs| vs.iter().any(|v| v["value"] == value))
    }
}

/// `model`'s effort option, with `effort` selected when the model offers it; `None` without efforts.
fn effort_option(model: &Model, effort: &str) -> Option<Value> {
    if model.efforts.is_empty() {
        return None;
    }
    let mut values = vec![json!({ "value": "default", "name": "Default" })];
    values.extend(model.efforts.iter().map(|e| json!({ "value": e, "name": capitalize(e) })));
    let current = if model.efforts.iter().any(|e| e == effort) { effort } else { "default" };
    Some(json!({
        "id": EFFORT, "name": "Effort", "category": "thought_level", "type": "select",
        "currentValue": current, "options": values,
    }))
}

/// Slash commands as ACP `availableCommands`, without those that need Claude Code's terminal.
pub(super) fn commands(list: Option<&Value>, terminal_only: &[String]) -> Vec<Value> {
    list.and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|c| {
            let name = c.get("name")?.as_str()?;
            if terminal_only.iter().any(|t| t == name) {
                return None;
            }
            let hint = c.get("argumentHint").and_then(Value::as_str).filter(|h| !h.is_empty());
            Some(json!({
                "name": name,
                "description": c.get("description").and_then(Value::as_str).unwrap_or_default(),
                "input": hint.map(|h| json!({ "hint": h })),
            }))
        })
        .collect()
}

fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn init() -> Value {
        json!({
            "current_permission_mode": "default",
            "commands": [{"name": "review", "description": "Review", "argumentHint": "[pr]"}, {"name": "doctor", "description": "", "argumentHint": ""}],
            "models": [
                {"value": "default", "resolvedModel": "claude-sonnet-5-5", "displayName": "Default (recommended)",
                 "supportsEffort": true, "supportedEffortLevels": ["low", "high"], "supportsAutoMode": true},
                {"value": "opus", "resolvedModel": "claude-opus-5-5", "displayName": "Opus", "supportsEffort": true, "supportedEffortLevels": ["low", "max"]},
                {"value": "claude-haiku-4-5", "displayName": "Haiku 4.5"}
            ]
        })
    }

    #[test]
    fn current_model_from_settings() {
        let s = Settings::from_cli(&init(), &json!({"applied": {"model": "claude-sonnet-5-5", "effort": "high"}}));
        assert_eq!((s.model.as_str(), s.effort.as_str()), ("default", "high"));
        let s = Settings::from_cli(
            &init(),
            &json!({"effective": {"model": "opus"}, "applied": {"model": "claude-opus-5-5"}}),
        );
        assert_eq!(s.model, "opus");
        assert_eq!(s.modes(), ["default", "acceptEdits", "plan", "bypassPermissions"]);
        let flag = Settings::from_cli(
            &init(),
            &json!({"effective": {"model": "opus"}, "applied": {"model": "claude-sonnet-5-5"}}),
        );
        assert_eq!(flag.model, "default", "`--model` wins over the settings file");
        let s = Settings::from_cli(&init(), &json!({"applied": {"model": "claude-x-1"}}));
        assert_eq!(s.model, "claude-x-1");
    }

    #[test]
    fn options_follow_the_model() {
        let mut s = Settings::from_cli(&init(), &json!({"applied": {"model": "claude-sonnet-5-5", "effort": "high"}}));
        let o = s.options();
        assert_eq!(o[0]["options"].as_array().unwrap().len(), 5);
        assert_eq!(o[2]["currentValue"], "high");
        assert!(s.valid("effort", "low") && !s.valid("effort", "max"));
        s.set_model("opus");
        assert_eq!(s.effort, "default");
        s.set_model("claude-haiku-4-5");
        assert_eq!(s.options().as_array().unwrap().len(), 2, "no effort option without levels");
        let cmds = commands(init().get("commands"), &["doctor".into()]);
        assert_eq!(cmds, vec![json!({"name": "review", "description": "Review", "input": {"hint": "[pr]"}})]);
    }

    #[test]
    fn every_model_offers_its_own_efforts() {
        let s = Settings::from_cli(&init(), &json!({"applied": {"model": "claude-sonnet-5-5", "effort": "high"}}));
        let efforts = s.efforts_by_model();
        let values = |model: &str| {
            let (_, o) = efforts.iter().find(|(m, _)| m == model).unwrap();
            let o = o.as_ref().unwrap();
            let values: Vec<_> = o["options"].as_array().unwrap().iter().map(|v| v["value"].clone()).collect();
            (values, o["currentValue"].clone())
        };
        assert_eq!(values("default"), (vec![json!("default"), json!("low"), json!("high")], json!("high")));
        // The configured effort only where the model offers it.
        assert_eq!(values("opus"), (vec![json!("default"), json!("low"), json!("max")], json!("default")));
        assert!(efforts.contains(&("claude-haiku-4-5".into(), None)), "no effort option without levels");
    }
}
