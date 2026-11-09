//! Session settings (model, mode, thinking effort…), slash commands and context use, as
//! the agent reports them over ACP.

use crate::model::{
    AgentCommand, AgentCommandSource, AgentConfigOption, AgentConfigValue, AgentConfigVia, AgentCost, AgentLimit,
    AgentUsage,
};
use serde_json::{Value, json};

/// Cursor exposes execution modes over ACP, but leaves approval policy to its client.
pub(crate) const CURSOR_APPROVAL: &str = "openidea.cursor.approval";

pub(crate) fn add_client_options(provider: &str, config: &mut Vec<AgentConfigOption>) {
    if provider != "cursor" || config.iter().any(|o| o.id == CURSOR_APPROVAL) {
        return;
    }
    config.push(AgentConfigOption {
        id: CURSOR_APPROVAL.into(),
        name: "Approvals".into(),
        description: Some("Tool approvals for this Cursor conversation".into()),
        category: Some("approval".into()),
        current: Some("ask".into()),
        via: AgentConfigVia::Option,
        values: vec![
            AgentConfigValue {
                value: "ask".into(),
                name: "Ask for approval".into(),
                description: Some("Show permission requests from Cursor".into()),
            },
            AgentConfigValue {
                value: "bypass".into(),
                name: "Bypass approvals".into(),
                description: Some("Automatically approve tool requests in this conversation".into()),
            },
        ],
    });
}

/// Whether the current settings approve tool requests without asking: a bypass mode,
/// an allow-all permissions option, or a bypass approval policy.
pub(crate) fn bypass_approvals(config: &[AgentConfigOption]) -> bool {
    let selected = |category: &str| {
        config.iter().find(|o| o.category.as_deref() == Some(category)).and_then(|o| o.current.as_deref())
    };
    selected("mode").is_some_and(is_bypass_mode)
        || selected("permissions").is_some_and(|v| matches!(v.to_ascii_lowercase().as_str(), "on" | "true"))
        || selected("approval").is_some_and(|v| v.eq_ignore_ascii_case("bypass"))
}

/// The mode that approves everything without asking (`bypassPermissions`, `yolo`, `full-access`…), if the agent has one.
pub(crate) fn bypass_mode(options: &[AgentConfigOption]) -> Option<(&AgentConfigOption, &AgentConfigValue)> {
    let option = options.iter().find(|o| o.category.as_deref() == Some("mode"))?;
    let value = option.values.iter().find(|v| is_bypass_mode(&v.value))?;
    Some((option, value))
}

fn is_bypass_mode(mode: &str) -> bool {
    // Mode ids can be URL-like (`…/session-modes#yolo`), as the composer's mode icon also assumes.
    let lower = mode.to_lowercase();
    let m: String =
        lower.rsplit(['#', '/']).next().unwrap_or_default().chars().filter(char::is_ascii_lowercase).collect();
    m.contains("bypass") || m == "yolo" || m.contains("fullaccess") || m == "dangerous"
}

/// The settings in a `session/new` or `session/load` result: its select `configOptions`,
/// plus the older `modes` / `models` fields for what those don't cover.
pub(crate) fn options_of(result: &Value) -> Vec<AgentConfigOption> {
    let mut out = result.get("configOptions").map(parse_options).unwrap_or_default();
    let has = |out: &[AgentConfigOption], category: &str| out.iter().any(|o| o.category.as_deref() == Some(category));
    if !has(&out, "mode")
        && let Some(modes) = result.get("modes")
    {
        out.push(legacy(modes, "mode", "Mode", "availableModes", "id", "currentModeId", AgentConfigVia::Mode));
    }
    if !has(&out, "model")
        && let Some(models) = result.get("models")
    {
        out.push(legacy(
            models,
            "model",
            "Model",
            "availableModels",
            "modelId",
            "currentModelId",
            AgentConfigVia::Model,
        ));
    }
    out.retain(|o| !o.values.is_empty());
    out
}

/// A `configOptions` array; only select options are kept (the UI shows them as dropdowns).
pub(crate) fn parse_options(options: &Value) -> Vec<AgentConfigOption> {
    let Some(list) = options.as_array() else { return Vec::new() };
    list.iter()
        .filter(|o| o.get("type").and_then(Value::as_str).is_none_or(|t| t == "select"))
        .filter_map(|o| {
            let id = o.get("id").or_else(|| o.get("configId")).and_then(Value::as_str)?.to_owned();
            let mut values = Vec::new();
            for v in o.get("options").and_then(Value::as_array).into_iter().flatten() {
                // Grouped options: `{ group, name, options: [...] }`.
                match v.get("options").and_then(Value::as_array) {
                    Some(group) => values.extend(group.iter().filter_map(value_of)),
                    None => values.extend(value_of(v)),
                }
            }
            Some(AgentConfigOption {
                name: str_of(o, "name").unwrap_or_else(|| id.clone()),
                description: str_of(o, "description"),
                category: str_of(o, "category").or_else(|| matches!(id.as_str(), "model" | "mode").then(|| id.clone())),
                current: str_of(o, "currentValue"),
                values,
                via: AgentConfigVia::Option,
                id,
            })
        })
        .collect()
}

/// A `config_option_update`: its options replace the config-option ones; `modes` / `models`
/// stand-ins stay.
pub(crate) fn merge_update(config: &mut Vec<AgentConfigOption>, options: &Value) {
    let fresh = parse_options(options);
    let covered = |o: &AgentConfigOption| fresh.iter().any(|f| f.category.is_some() && f.category == o.category);
    config.retain(|o| o.id == CURSOR_APPROVAL || (o.via != AgentConfigVia::Option && !covered(o)));
    let legacy = std::mem::take(config);
    config.extend(fresh);
    config.extend(legacy);
    config.retain(|o| !o.values.is_empty());
}

/// `current_mode_update`.
pub(crate) fn set_mode(config: &mut [AgentConfigOption], mode: &str) {
    if let Some(o) = config.iter_mut().find(|o| o.category.as_deref() == Some("mode")) {
        o.current = Some(mode.to_owned());
    }
}

/// The request (method, params without the session id) that sets `option` to `value`.
pub(crate) fn set_request(option: &AgentConfigOption, value: &str) -> (&'static str, Value) {
    match option.via {
        AgentConfigVia::Option => ("session/set_config_option", json!({ "configId": option.id, "value": value })),
        AgentConfigVia::Mode => ("session/set_mode", json!({ "modeId": value })),
        AgentConfigVia::Model => ("session/set_model", json!({ "modelId": value })),
    }
}

/// `available_commands_update`.
pub(crate) fn commands_of(update: &Value, provider: &str) -> Vec<AgentCommand> {
    update
        .get("availableCommands")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|c| {
            let name = c.get("name")?.as_str()?.trim_start_matches('/');
            let source = if provider == "codex-acp" && name.starts_with('$') {
                AgentCommandSource::Skill
            } else {
                c.get("source").and_then(|s| serde_json::from_value(s.clone()).ok()).unwrap_or_default()
            };
            Some(AgentCommand {
                name: name.to_owned(),
                source,
                description: str_of(c, "description").unwrap_or_default(),
                hint: c.pointer("/input/hint").and_then(Value::as_str).filter(|h| !h.is_empty()).map(str::to_owned),
            })
        })
        .collect()
}

/// `usage_update`: `{ used, size }`.
pub(crate) fn usage_of(update: &Value) -> Option<AgentUsage> {
    let tokens = |key: &str| update.get(key)?.as_f64().map(|n| n.clamp(0.0, f64::from(u32::MAX)) as u32);
    let cost = update.get("cost").and_then(|c| {
        Some(Box::new(AgentCost {
            amount: c.get("amount")?.as_f64().filter(|a| a.is_finite() && *a >= 0.0)?,
            currency: c.get("currency")?.as_str().filter(|c| !c.is_empty())?.to_owned(),
        }))
    });
    Some(AgentUsage { used: tokens("used")?, size: tokens("size").filter(|s| *s > 0)?, cost })
}

/// The usage-limit windows a [`crate::LIMITS_UPDATE`] carries; malformed entries are skipped.
pub(crate) fn limits_of(update: &Value) -> Vec<AgentLimit> {
    let limits = update.get("limits").and_then(Value::as_array).into_iter().flatten();
    limits
        .filter_map(|l| {
            Some(AgentLimit {
                window: l.get("window")?.as_str().filter(|w| !w.is_empty())?.to_owned(),
                used_percent: l.get("usedPercent")?.as_f64().filter(|p| p.is_finite())?.clamp(0.0, 100.0),
                resets_ms: l.get("resetsMs").and_then(Value::as_f64),
            })
        })
        .collect()
}

fn legacy(
    v: &Value,
    id: &str,
    name: &str,
    list: &str,
    key: &str,
    current: &str,
    via: AgentConfigVia,
) -> AgentConfigOption {
    let values = v
        .get(list)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let value = m.get(key)?.as_str()?.to_owned();
            Some(AgentConfigValue {
                name: str_of(m, "name").unwrap_or_else(|| value.clone()),
                description: str_of(m, "description"),
                value,
            })
        })
        .collect();
    AgentConfigOption {
        id: id.to_owned(),
        name: name.to_owned(),
        description: None,
        category: Some(id.to_owned()),
        current: str_of(v, current),
        values,
        via,
    }
}

fn value_of(v: &Value) -> Option<AgentConfigValue> {
    let value = v.get("value")?.as_str()?.to_owned();
    Some(AgentConfigValue {
        name: str_of(v, "name").unwrap_or_else(|| value.clone()),
        description: str_of(v, "description"),
        value,
    })
}

fn str_of(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(c: &[AgentConfigOption]) -> Vec<(&str, Option<&str>)> {
        c.iter().map(|o| (o.id.as_str(), o.current.as_deref())).collect()
    }

    #[test]
    fn config_options_win_over_the_older_fields() {
        let r = json!({
            "modes": {"currentModeId": "default", "availableModes": [{"id": "default", "name": "Manual"}]},
            "configOptions": [
                {"id": "mode", "category": "mode", "type": "select", "currentValue": "plan",
                 "options": [{"value": "default", "name": "Manual"}, {"value": "plan", "name": "Plan"}]},
                {"id": "effort", "category": "thought_level", "type": "select", "currentValue": "medium",
                 "options": [{"group": "g", "name": "G", "options": [{"value": "low"}, {"value": "medium", "name": "Medium"}]}]},
                {"id": "fast", "type": "boolean", "currentValue": false}
            ],
            "models": {"currentModelId": "m1", "availableModels": [{"modelId": "m1", "name": "One"}]}
        });
        let c = options_of(&r);
        assert_eq!(ids(&c), [("mode", Some("plan")), ("effort", Some("medium")), ("model", Some("m1"))]);
        assert_eq!(c[1].values.iter().map(|v| v.name.as_str()).collect::<Vec<_>>(), ["low", "Medium"]);
        assert_eq!(set_request(&c[0], "default").0, "session/set_config_option");
        assert_eq!(set_request(&c[2], "m1"), ("session/set_model", json!({"modelId": "m1"})));
    }

    #[test]
    fn updates_replace_options_and_track_the_mode() {
        let mut c = options_of(&json!({
            "modes": {"currentModeId": "ask", "availableModes": [{"id": "ask"}, {"id": "code"}]},
            "configOptions": [{"id": "model", "type": "select", "currentValue": "a", "options": [{"value": "a"}]}]
        }));
        assert_eq!(c[0].category.as_deref(), Some("model"), "the category defaults from the id");
        set_mode(&mut c, "code");
        assert_eq!(c[1].current.as_deref(), Some("code"));
        assert_eq!(set_request(&c[1], "ask").0, "session/set_mode");
        merge_update(
            &mut c,
            &json!([{"id": "model", "type": "select", "currentValue": "b", "options": [{"value": "b"}]}]),
        );
        assert_eq!(ids(&c), [("model", Some("b")), ("mode", Some("code"))]);
    }

    #[test]
    fn selected_bypass_settings_approve_without_asking() {
        let full_access = options_of(&json!({
            "modes": {"currentModeId": "full-access", "availableModes": [
                {"id": "ask", "name": "Ask"}, {"id": "full-access", "name": "Full Access"}
            ]}
        }));
        assert!(bypass_approvals(&full_access));
        assert_eq!(bypass_mode(&full_access).map(|(_, v)| v.value.as_str()), Some("full-access"));

        let asking = options_of(&json!({
            "modes": {"currentModeId": "ask", "availableModes": [
                {"id": "ask", "name": "Ask"}, {"id": "full-access", "name": "Full Access"}
            ]}
        }));
        assert!(!bypass_approvals(&asking));
        assert_eq!(
            bypass_mode(&asking).map(|(_, v)| v.value.as_str()),
            Some("full-access"),
            "the offered bypass mode stays available"
        );

        let permissions = |current: &str| {
            options_of(&json!({"configOptions": [{
                "id": "allow_all", "name": "Allow All", "category": "permissions", "type": "select",
                "currentValue": current, "options": [{"value": "off"}, {"value": "on"}]
            }]}))
        };
        assert!(bypass_approvals(&permissions("on")));
        assert!(bypass_approvals(&permissions("TRUE")));
        assert!(!bypass_approvals(&permissions("off")));

        let approval = options_of(&json!({"configOptions": [{
            "id": "approval", "name": "Approvals", "category": "approval", "type": "select",
            "currentValue": "bypass", "options": [{"value": "ask"}, {"value": "bypass"}]
        }]}));
        assert!(bypass_approvals(&approval));

        // The composer's mode icon splits URL-like ids on `#` / `/`; the backend must agree.
        let url_mode = options_of(&json!({
            "modes": {"currentModeId": "https://agentclientprotocol.com/protocol/session-modes#yolo",
                      "availableModes": [{"id": "https://agentclientprotocol.com/protocol/session-modes#yolo"}]}
        }));
        assert!(bypass_approvals(&url_mode));
    }

    #[test]
    fn command_sources_in_updates_and_stored_tasks() {
        let update = json!({"availableCommands": [
            {"name": "review", "source": "skill"},
            {"name": "$lint"},
            {"name": "compact"}
        ]});
        let sources = |provider| commands_of(&update, provider).into_iter().map(|c| c.source).collect::<Vec<_>>();
        assert_eq!(
            sources("codex-acp"),
            [AgentCommandSource::Skill, AgentCommandSource::Skill, AgentCommandSource::Command]
        );
        assert_eq!(
            sources("custom"),
            [AgentCommandSource::Skill, AgentCommandSource::Command, AgentCommandSource::Command]
        );
        let old: AgentCommand =
            serde_json::from_value(json!({"name": "review", "description": "Review", "hint": null})).unwrap();
        assert_eq!(old.source, AgentCommandSource::Command);
        let skill = AgentCommand { source: AgentCommandSource::Skill, ..old };
        assert_eq!(serde_json::from_value::<AgentCommand>(serde_json::to_value(&skill).unwrap()).unwrap(), skill);
    }

    #[test]
    fn commands_and_usage() {
        let cmds = commands_of(
            &json!({"availableCommands": [
                {"name": "review", "description": "Review changes", "input": {"hint": "what to review"}},
                {"name": "/init", "description": "Write CLAUDE.md", "input": null}
            ]}),
            "claude",
        );
        assert_eq!(cmds[0].source, AgentCommandSource::Command);
        assert_eq!(cmds[0].hint.as_deref(), Some("what to review"));
        assert_eq!((cmds[1].name.as_str(), cmds[1].hint.as_ref()), ("init", None));
        let u = usage_of(&json!({"used": 1200, "size": 200000, "cost": {"amount": 0.42, "currency": "USD"}})).unwrap();
        assert_eq!((u.used, u.size), (1200, 200000));
        assert!(usage_of(&json!({"used": 1, "size": 0})).is_none());
    }
}
