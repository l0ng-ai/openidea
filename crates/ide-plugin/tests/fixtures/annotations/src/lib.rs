//! Minimal `editorAnnotations` fixture: answers the snapshot and conversation
//! requests the editor sends, with Markdown in the hover card.

use openidea_plugin::{Error, Invocation, Plugin, register_plugin};
use serde_json::{Value, json};

#[derive(Default)]
struct Annotations;

impl Plugin for Annotations {
    fn run_command(&mut self, id: &str, _ctx: &Invocation, arg: Option<&str>) -> Result<Option<String>, Error> {
        if id != "snapshot" {
            return Err(Error::NotFound(id.into()));
        }
        let arg = arg.ok_or_else(|| Error::Invalid("missing annotation request".into()))?;
        let request: Value = serde_json::from_str(arg).map_err(|e| Error::Invalid(e.to_string()))?;
        let text = |key: &str| {
            request[key].as_str().map(str::to_owned).ok_or_else(|| Error::Invalid(format!("missing {key}")))
        };
        let request_id = text("requestId")?;
        let path = text("path")?;
        let document = request["documentText"].as_str().unwrap_or_default();
        let conversation = request["operation"].as_str() == Some("conversation");
        let prompt_id = if conversation { text("promptId")? } else { "line".to_owned() };
        let lines: Vec<Value> =
            (0..document.lines().count().max(1)).map(|line| json!({ "line": line, "promptId": prompt_id })).collect();
        let markdown = if conversation {
            format!("**Conversation {prompt_id}**\n\nLoaded on demand.")
        } else {
            "**Fixture annotations**\n\nHover to load the conversation.".to_owned()
        };
        Ok(Some(
            json!({
                "schemaVersion": 1,
                "requestId": request_id,
                "path": path,
                "documentVersion": 1,
                "state": "ready",
                "mode": "line",
                "lines": lines,
                "prompts": [{
                    "id": prompt_id,
                    "label": "fixture",
                    "markdown": markdown,
                    "hasMessages": conversation,
                }],
            })
            .to_string(),
        ))
    }
}

register_plugin!(Annotations);
