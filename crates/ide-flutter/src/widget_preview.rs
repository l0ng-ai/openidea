//! One `flutter widget-preview` server per project window: the `@Preview` widgets of the project,
//! served as a web page that reloads as they change. Like the Flutter plugins of Android Studio
//! and VS Code it runs on the `web-server` device, in `--machine` mode, where it reports events
//! as bracketed JSON lines and the page's address with `widget_preview.started`. Without
//! `--dtd-url` it starts its own analysis server and Dart Tooling Daemon to find the previews.

use crate::devtools::HOST;
use crate::flutter_executable;
use crate::server::{Line, Spec, ToolServer};
use serde_json::Value;
use std::path::PathBuf;
use std::time::Duration;

/// The release whose `widget-preview start` has the options used here.
const MIN_FLUTTER: &str = "3.38";

static WIDGET_PREVIEW: Spec = Spec {
    name: "Flutter Widget Preview",
    args: &["widget-preview", "start", "--machine", "--web-server"],
    // The first start runs `pub get` and compiles the preview environment.
    timeout: Duration::from_secs(300),
    executable: flutter_executable,
    not_found: "Flutter SDK not found: install Flutter or add it to PATH",
    line,
    failed,
};

impl ToolServer {
    /// `flutter` is the configured one, else the one on the search path.
    pub fn widget_preview(root: PathBuf, flutter: crate::Configured) -> Self {
        Self::new(root, &WIDGET_PREVIEW, flutter)
    }
}

fn line(line: &str) -> Line {
    let Ok(Value::Array(messages)) = serde_json::from_str(line.trim()) else {
        return Line::Output(line.to_owned());
    };
    let Some(message) = messages.first() else { return Line::Skip };
    let params = &message["params"];
    match message["event"].as_str() {
        // The server listens on every interface; embedded pages may only come from `HOST`.
        Some("widget_preview.started") => params["url"]
            .as_str()
            .map_or(Line::Skip, |url| Line::Url(url.replacen("//localhost:", &format!("//{HOST}:"), 1))),
        Some("widget_preview.logMessage") if matches!(params["level"].as_str(), Some("error" | "warning")) => {
            params["message"].as_str().map_or(Line::Skip, |text| Line::Output(text.to_owned()))
        }
        _ => Line::Skip,
    }
}

fn failed(message: String) -> String {
    // What an older `flutter` says of a command or an option it doesn't know.
    if message.contains("Could not find a") && message.contains(" named \"") {
        format!(
            "Flutter Widget Preview needs Flutter {MIN_FLUTTER} or later. Upgrade Flutter, then refresh the window."
        )
    } else if message.is_empty() {
        "flutter widget-preview exited".into()
    } else {
        message
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(line: &str) -> Option<String> {
        match super::line(line) {
            Line::Url(url) => Some(url),
            _ => None,
        }
    }

    fn output(line: &str) -> Option<String> {
        match super::line(line) {
            Line::Output(text) => Some(text),
            _ => None,
        }
    }

    #[test]
    fn started_gives_the_address_on_the_embeddable_host() {
        let line = r#"[{"event":"widget_preview.started","params":{"url":"http://localhost:56207"}}]"#;
        assert_eq!(url(line).as_deref(), Some("http://127.0.0.1:56207"));
        let launch =
            r#"[{"event":"widget_preview.app.webLaunchUrl","params":{"url":"http://localhost:1","launched":false}}]"#;
        assert_eq!(url(launch), None);
    }

    #[test]
    fn only_errors_warnings_and_plain_text_are_kept() {
        let log = |level: &str| {
            format!(r#"[{{"event":"widget_preview.logMessage","params":{{"level":"{level}","message":"m"}}}}]"#)
        };
        assert_eq!(output(&log("error")).as_deref(), Some("m"));
        assert_eq!(output(&log("warning")).as_deref(), Some("m"));
        assert_eq!(output(&log("status")), None);
        assert_eq!(output(r#"[{"event":"widget_preview.initializing","params":{"pid":1}}]"#), None);
        assert_eq!(
            output("Could not find a command named \"widget-preview\".").as_deref(),
            Some("Could not find a command named \"widget-preview\".")
        );
    }

    #[test]
    fn an_older_flutter_is_named_as_the_cause() {
        for message in
            [r#"Could not find a command named "widget-preview"."#, r#"Could not find an option named "--web-server"."#]
        {
            assert!(failed(message.into()).starts_with("Flutter Widget Preview needs Flutter 3.38"));
        }
        assert_eq!(failed("pub get failed".into()), "pub get failed");
        assert_eq!(failed(String::new()), "flutter widget-preview exited");
    }
}
