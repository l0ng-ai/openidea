//! AI Completion for OpenIDEA: inline suggestions from an OpenAI-compatible
//! `/v1/completions` endpoint (fill-in-the-middle with `prompt` + `suffix`).
//! The IDE cancels a request as soon as the user types on (the fetch returns
//! `Cancelled`); the API key is filled in by the IDE (`{{secret:api-key}}`)
//! and never seen here.

use openidea_plugin::host::{self, storage};
use openidea_plugin::providers::{Document, InlineSuggestion, Providers};
use openidea_plugin::text::offset;
use openidea_plugin::{Error, HttpRequest, Invocation, LogLevel, NotificationLevel, Plugin, Position, register_plugin};
use serde_json::{Value, json};

const LOCAL: &str = "http://localhost:11434";
const OPENAI: &str = "https://api.openai.com";
const LOCAL_MODEL: &str = "qwen2.5-coder:1.5b";
const OPENAI_MODEL: &str = "gpt-3.5-turbo-instruct";
/// Context sent around the caret.
const PREFIX_CHARS: usize = 3000;
const SUFFIX_CHARS: usize = 1000;

#[derive(Default)]
pub struct AiCompletion {
    /// Why the last request failed, so it is logged once rather than per keystroke.
    last_error: Option<String>,
}

struct Config {
    endpoint: String,
    model: String,
    openai: bool,
    enabled: bool,
}

fn config() -> Config {
    let get = |k: &str| storage::get(k).ok().flatten();
    let endpoint = get("endpoint").unwrap_or_else(|| LOCAL.into());
    let openai = endpoint.starts_with(OPENAI);
    let model = get("model").unwrap_or_else(|| (if openai { OPENAI_MODEL } else { LOCAL_MODEL }).into());
    Config { endpoint, model, openai, enabled: get("enabled").as_deref() != Some("false") }
}

/// The last `max` characters of `s` (on a char boundary).
fn tail(s: &str, max: usize) -> &str {
    match s.char_indices().rev().nth(max.saturating_sub(1)) {
        Some((i, _)) if s.chars().count() > max => &s[i..],
        _ => s,
    }
}

fn head(s: &str, max: usize) -> &str {
    s.char_indices().nth(max).map_or(s, |(i, _)| &s[..i])
}

/// The request body for the text around `at`, or `None` when there is
/// nothing to complete (in the middle of a word).
pub fn request_body(doc: &Document, at: Position, model: &str) -> Option<String> {
    let at = offset(&doc.text, at)?;
    let (before, after) = doc.text.split_at(at);
    // Only at the end of a line or before closing punctuation.
    let rest_of_line = after.split('\n').next().unwrap_or("");
    if !rest_of_line.trim().chars().all(|c| ")]}>;,'\"`".contains(c)) {
        return None;
    }
    let body = json!({
        "model": model,
        "prompt": tail(before, PREFIX_CHARS),
        "suffix": head(after, SUFFIX_CHARS),
        "max_tokens": 64,
        "temperature": 0,
        "stop": ["\n\n"],
    });
    Some(body.to_string())
}

/// The suggestion in a `/v1/completions` response.
pub fn suggestion(response: &str) -> Option<String> {
    let v: Value = serde_json::from_str(response).ok()?;
    let text = v["choices"][0]["text"].as_str()?.trim_end().to_owned();
    (!text.trim().is_empty()).then_some(text)
}

impl Providers for AiCompletion {
    fn inline_completion(&mut self, doc: &Document, at: Position) -> Option<InlineSuggestion> {
        let c = config();
        if !c.enabled {
            return None;
        }
        let body = request_body(doc, at, &c.model)?;
        let mut req = HttpRequest::post(&format!("{}/v1/completions", c.endpoint.trim_end_matches('/')), body)
            .header("Content-Type", "application/json");
        if c.openai {
            if !host::secret_is_set("api-key") {
                return None;
            }
            req = req.header("Authorization", "Bearer {{secret:api-key}}");
        }
        req.timeout_ms = Some(10_000);
        match host::fetch(&req) {
            Ok(r) if r.status == 200 => {
                self.last_error = None;
                suggestion(&r.text()).map(|insert_text| InlineSuggestion { insert_text, replace: None })
            }
            // Superseded by the next keystroke: nothing to report.
            Err(Error::Cancelled) => None,
            other => {
                let msg = match other {
                    Ok(r) => format!("HTTP {}: {}", r.status, head(&r.text(), 200)),
                    Err(e) => e.to_string(),
                };
                if self.last_error.as_ref() != Some(&msg) {
                    host::log(LogLevel::Warn, &format!("{}: {msg}", c.endpoint));
                    self.last_error = Some(msg);
                }
                None
            }
        }
    }
}

impl Plugin for AiCompletion {
    fn run_command(&mut self, id: &str, _ctx: &Invocation, arg: Option<&str>) -> Result<Option<String>, String> {
        let msg = match id {
            "use-local" => {
                storage::set("endpoint", LOCAL)?;
                storage::delete("model")?;
                format!("Using the local model {LOCAL_MODEL} (Ollama at {LOCAL}).")
            }
            "use-openai" => {
                storage::set("endpoint", OPENAI)?;
                storage::delete("model")?;
                if host::secret_is_set("api-key") {
                    format!("Using OpenAI ({OPENAI_MODEL}).")
                } else {
                    "Using OpenAI: store your API key in Settings › Plugins › AI Completion.".into()
                }
            }
            "set-endpoint" => {
                let url = arg.map(str::trim).filter(|u| u.starts_with("http://") || u.starts_with("https://"));
                let url = url.ok_or("give the endpoint URL, e.g. http://localhost:11434")?;
                storage::set("endpoint", url)?;
                format!("Using {url}.")
            }
            "toggle" => {
                let enabled = !config().enabled;
                storage::set("enabled", if enabled { "true" } else { "false" })?;
                (if enabled { "AI Completion is on." } else { "AI Completion is off." }).into()
            }
            _ => return Err(format!("unknown command {id}")),
        };
        host::notify(NotificationLevel::Info, "AI Completion", &msg);
        Ok(Some(msg))
    }
}

register_plugin!(AiCompletion, providers);

#[cfg(test)]
mod tests {
    use super::*;
    use openidea_plugin::HttpResponse;
    use openidea_plugin::mock::MockHost;

    fn doc(text: &str) -> Document {
        Document { path: "/p/a.rs".into(), language: "rust".into(), version: 1, text: text.into() }
    }

    #[test]
    fn asks_with_prefix_and_suffix_and_returns_the_text() {
        let host = MockHost::install().with_capabilities(&["storage", "net:localhost"]);
        host.on_fetch(|r| {
            let body: Value = serde_json::from_slice(r.body.as_ref().unwrap()).unwrap();
            assert_eq!(body["prompt"], "fn add(a: i32, b: i32) -> i32 {\n    ");
            assert_eq!(body["suffix"], "\n}\n");
            Ok(HttpResponse { status: 200, headers: vec![], body: br#"{"choices":[{"text":"a + b\n"}]}"#.to_vec() })
        });
        let s = AiCompletion::default()
            .inline_completion(&doc("fn add(a: i32, b: i32) -> i32 {\n    \n}\n"), Position::new(1, 4))
            .unwrap();
        assert_eq!(s.insert_text, "a + b");
        assert_eq!(host.requests()[0].url, "http://localhost:11434/v1/completions");
    }

    #[test]
    fn openai_uses_the_secret_and_only_when_set() {
        let host = MockHost::install().with_capabilities(&["storage", "net:api.openai.com", "secrets"]);
        host.on_fetch(|_| {
            Ok(HttpResponse { status: 200, headers: vec![], body: br#"{"choices":[{"text":"x"}]}"#.to_vec() })
        });
        let mut p = AiCompletion::default();
        p.run_command("use-openai", &host.invocation(), None).unwrap();
        assert!(p.inline_completion(&doc("let x = "), Position::new(0, 8)).is_none(), "no key yet");
        host.set_secret("api-key", "sk-test");
        assert!(p.inline_completion(&doc("let x = "), Position::new(0, 8)).is_some());
        let sent = &host.requests()[0];
        assert!(sent.headers.contains(&("Authorization".into(), "Bearer sk-test".into())));
    }

    #[test]
    fn quiet_when_cancelled_denied_or_mid_word() {
        let host = MockHost::install().with_capabilities(&["storage"]);
        let mut p = AiCompletion::default();
        assert!(p.inline_completion(&doc("let x = "), Position::new(0, 8)).is_none(), "net denied");
        assert!(request_body(&doc("let abc = d;"), Position::new(0, 5), "m").is_none(), "mid-word");
        assert!(request_body(&doc("call(x)"), Position::new(0, 6), "m").is_some(), "before `)`");
        let host2 = MockHost::install().with_capabilities(&["storage", "net:localhost"]);
        host2.on_fetch(|_| Err(Error::Cancelled));
        assert!(p.inline_completion(&doc("x"), Position::new(0, 1)).is_none());
        assert!(host2.logs().is_empty(), "a cancelled request is not an error");
        drop(host);
        p.run_command("toggle", &host2.invocation(), None).unwrap();
        assert!(p.inline_completion(&doc("x"), Position::new(0, 1)).is_none());
        assert_eq!(host2.requests().len(), 1, "disabled: no request");
    }
}
