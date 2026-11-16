//! A project trusted by the IDE may still be untrusted by Codex. Ask before changing
//! Codex's own decision; only its config API writes the current project's trust entry.

use super::*;

fn disabled_project<'a>(config: &'a Value, cwd: &str) -> Option<&'a Value> {
    let folder = Path::new(cwd).join(".codex");
    config.get("layers")?.as_array()?.iter().find(|layer| {
        layer.pointer("/name/type").and_then(Value::as_str) == Some("project")
            && layer
                .pointer("/name/dotCodexFolder")
                .and_then(Value::as_str)
                .is_some_and(|path| Path::new(path) == folder)
            && layer.get("disabledReason").and_then(Value::as_str).is_some_and(|reason| !reason.trim().is_empty())
    })
}

impl CodexShim {
    pub(super) async fn prepare_project_trust(&self, params: &Value) {
        let Some(cwd) = params.get("cwd").and_then(Value::as_str) else { return };
        if !self.state.lock().trust_checked.insert(cwd.to_owned()) {
            return;
        }
        // Old app-servers may not expose config layers. Their warnings still reach the UI.
        let Ok(Ok(config)) = tokio::time::timeout(
            Duration::from_secs(5),
            self.call("config/read", json!({ "cwd": cwd, "includeLayers": true })),
        )
        .await
        else {
            return;
        };
        let Some(layer) = disabled_project(&config, cwd) else { return };
        let Some(client) = self.client.get() else { return };
        let title = format!(
            "Trust project in Codex: {cwd}? This saves trust in your Codex user configuration and allows \
             this project's MCP servers, hooks and exec policies to load."
        );
        let permission = json!({
            "sessionId": params.get("sessionId").and_then(Value::as_str).unwrap_or_default(),
            "toolCall": {
                "toolCallId": format!("codex-project-trust:{cwd}"),
                "title": title, "kind": "edit",
                "rawInput": { "project": cwd },
            },
            "options": [
                // Permanent trust must never be auto-approved by the task's allow-once bypass.
                { "optionId": "codex-trust-project", "name": "Trust Project in Codex", "kind": "allow_always" },
                { "optionId": "codex-keep-untrusted", "name": "Keep Untrusted", "kind": "reject_once" },
            ],
        });
        let answer: Result<Value, RpcError> = client.request("session/request_permission", permission, None).await;
        let approved = answer.as_ref().is_ok_and(|answer| {
            answer.pointer("/outcome/outcome").and_then(Value::as_str) == Some("selected")
                && answer.pointer("/outcome/optionId").and_then(Value::as_str) == Some("codex-trust-project")
        });
        if !approved {
            if let Some(reason) = layer.get("disabledReason").and_then(Value::as_str) {
                self.warning(reason);
            }
            return;
        }
        // Quote the path as one key segment: dots and Windows backslashes are literal.
        let mut write = json!({
            "keyPath": format!("projects.{}.trust_level", json!(cwd)),
            "value": "trusted", "mergeStrategy": "replace",
        });
        if let Some(version) = config["layers"]
            .as_array()
            .and_then(|layers| {
                layers.iter().find(|layer| {
                    layer.pointer("/name/type").and_then(Value::as_str) == Some("user")
                        && layer.pointer("/name/profile").is_none_or(Value::is_null)
                })
            })
            .and_then(|layer| layer.get("version"))
            .filter(|version| version.is_string())
        {
            write["expectedVersion"] = version.clone();
        }
        match self.call("config/value/write", write).await {
            Err(error) => self.warning(format!("Codex could not save trust for {cwd}: {}", error.message)),
            Ok(reply) if reply["status"] == "okOverridden" => {
                self.warning(format!(
                    "Codex saved trust for {cwd}, but a higher-priority configuration overrides it. \
                     Project configuration may remain disabled; check the Codex configuration or contact your administrator."
                ));
            }
            _ => {}
        }
        // start/resume/fork now load the updated config before creating the thread.
    }
}
