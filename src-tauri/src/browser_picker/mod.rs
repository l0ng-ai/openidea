//! The dev page runs in a separate process containing one raw Wry WebView. It never boots
//! Tauri or registers an IDE protocol. The caller owns the process and its private pipes.
mod guest;
mod snapshot;
pub use snapshot::InspectedElement;
use snapshot::Selection;

use ide_core::{IdeError, IdeResult};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, Read, Write};
use std::process::Stdio;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::platform::run_return::EventLoopExtRunReturn;
use tao::window::WindowBuilder;
use tauri::Url;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const LIMIT: usize = 8192;
const HELPER: &str = "--openidea-pick-element";

#[derive(Deserialize, Serialize)]
struct Input {
    url: String,
    title: String,
}

fn local_url(value: &str) -> IdeResult<Url> {
    let url = Url::parse(value).ok().filter(|u| {
        value.len() <= 4096
            && matches!(u.scheme(), "http" | "https")
            && u.username().is_empty()
            && u.password().is_none()
            && ide_host::ops::web::is_loopback(u)
    });
    url.ok_or_else(|| IdeError::invalid("Enter a loopback HTTP or HTTPS URL without credentials"))
}

fn same_origin(origin: &Url, value: &str) -> bool {
    local_url(value).is_ok_and(|next| next.origin() == origin.origin())
}

pub(crate) async fn inspect(url: String, title: String) -> IdeResult<Option<InspectedElement>> {
    local_url(&url)?;
    if title.len() > 240 || title.chars().any(char::is_control) {
        return Err(IdeError::invalid("Invalid inspector window title"));
    }
    let mut input = serde_json::to_vec(&Input { url, title }).map_err(|e| IdeError::internal(e.to_string()))?;
    input.push(b'\n');
    let mut child = tokio::process::Command::new(std::env::current_exe()?)
        .arg(HELPER)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    // Keep stdin alive until completion. If the owner quits, EOF dismisses the picker.
    let mut stdin = child.stdin.take().ok_or_else(|| IdeError::internal("Missing picker input"))?;
    stdin.write_all(&input).await?;
    let stdout = child.stdout.take().ok_or_else(|| IdeError::internal("Missing picker output"))?;
    let mut output = Vec::new();
    stdout.take(LIMIT as u64 + 1).read_to_end(&mut output).await?;
    if output.len() > LIMIT || !child.wait().await?.success() {
        return Err(IdeError::unavailable("Could not inspect the local page"));
    }
    let selection: Option<Selection> =
        serde_json::from_slice(&output).map_err(|_| IdeError::invalid("Invalid picker result"))?;
    selection.map(|s| s.preview()).transpose()
}

/// Entry point for the single-purpose child, before any of the IDE's plugins or IPC are installed.
pub fn run_helper() -> Option<i32> {
    if std::env::args_os().nth(1).as_deref() != Some(std::ffi::OsStr::new(HELPER)) {
        return None;
    }
    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        let mut line = String::new();
        std::io::stdin().lock().take(LIMIT as u64).read_line(&mut line)?;
        if !line.ends_with('\n') {
            return Err("Incomplete picker request".into());
        }
        let input: Input = serde_json::from_str(&line)?;
        let selection = pick(local_url(&input.url)?, &input.title)?;
        serde_json::to_writer(std::io::stdout().lock(), &selection)?;
        std::io::stdout().flush()?;
        Ok(())
    })();
    Some(i32::from(result.is_err()))
}

enum PickerEvent {
    Picked,
    Result(String),
    Close,
}

fn pick(url: Url, title: &str) -> Result<Option<Selection>, Box<dyn std::error::Error>> {
    let mut events = EventLoopBuilder::<PickerEvent>::with_user_event().build();
    #[cfg(target_os = "macos")]
    {
        use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};
        events.set_activation_policy(ActivationPolicy::Accessory);
        events.set_activate_ignoring_other_apps(false);
    }
    let title = format!("{title} · {}", url.origin().ascii_serialization());
    let window =
        WindowBuilder::new().with_title(title).with_inner_size(tao::dpi::LogicalSize::new(960, 680)).build(&events)?;
    let proxy = events.create_proxy();
    let wake = proxy.clone();
    let origin = url.clone();
    let builder = guest::builder(
        url.as_str(),
        move |target| same_origin(&origin, &target),
        move |signal| {
            let event = match signal {
                guest::Signal::Picked => PickerEvent::Picked,
                guest::Signal::Cancel => PickerEvent::Close,
            };
            let _ = wake.send_event(event);
        },
    );
    #[cfg(not(target_os = "linux"))]
    let view = builder.build(&window)?;
    #[cfg(target_os = "linux")]
    let view = {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        builder.build_gtk(window.default_vbox().ok_or("Missing native picker container")?)?
    };
    let owner = proxy.clone();
    std::thread::spawn(move || {
        let _ = std::io::stdin().read(&mut [0]);
        let _ = owner.send_event(PickerEvent::Close);
    });
    let mut result: Result<Option<Selection>, Box<dyn std::error::Error>> = Ok(None);
    let mut reading = false;
    events.run_return(|event, _, flow| {
        *flow = ControlFlow::Wait;
        match event {
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } | Event::UserEvent(PickerEvent::Close) => {
                *flow = ControlFlow::Exit;
            }
            Event::UserEvent(PickerEvent::Picked) if !reading && view.url().is_ok_and(|u| same_origin(&url, &u)) => {
                reading = true;
                let reply = proxy.clone();
                // Evaluate only this fixed expression in the main frame. A subframe or a
                // synthetic click has no selection. The guest's data remains untrusted.
                let script = "typeof window.__openideaPickedElement === 'string' ? window.__openideaPickedElement.slice(0, 8193) : null";
                if let Err(err) = view.evaluate_script_with_callback(script, move |value| {
                    let _ = reply.send_event(PickerEvent::Result(value));
                }) {
                    result = Err(err.into());
                    *flow = ControlFlow::Exit;
                }
            }
            Event::UserEvent(PickerEvent::Result(value)) => {
                reading = false;
                if let Ok(Some(json)) = serde_json::from_str::<Option<String>>(&value)
                    && view.url().is_ok_and(|u| same_origin(&url, &u)) {
                    result = if json.len() <= LIMIT {
                        serde_json::from_str::<Selection>(&json).map(Some).map_err(Into::into)
                    } else { Err("Element selection too large".into()) };
                    *flow = ControlFlow::Exit;
                }
            }
            _ => {}
        }
    });
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pins_scheme_host_and_port_and_rejects_credentials() {
        let origin = local_url("http://127.0.0.1:3000/a?key=private").unwrap();
        assert!(same_origin(&origin, "http://127.0.0.1:3000/b#x"));
        assert!(local_url("http://localhost/").is_ok());
        assert!(local_url("https://[::1]/").is_ok());
        for remote in [
            "http://localhost.example.org",
            "http://0.0.0.0",
            "file:///tmp/test",
            "tauri://localhost",
            "http://user@localhost",
            "https://example.org",
        ] {
            assert!(local_url(remote).is_err(), "{remote}");
        }
        for target in
            ["http://127.0.0.1:3001", "http://localhost:3000", "https://127.0.0.1:3000", "http://u:p@127.0.0.1:3000"]
        {
            assert!(!same_origin(&origin, target), "{target}");
        }
    }
}
