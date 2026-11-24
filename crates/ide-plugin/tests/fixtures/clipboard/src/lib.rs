use openidea_plugin::views::{Body, Button, View, ViewEvent, Viewport, Views};
use openidea_plugin::{ClipboardContent, Error, Event, Invocation, Plugin, host, register_plugin};

/// `text=<text> image=<PNG byte count>`, `-` for what the clipboard doesn't hold.
fn describe(content: Result<ClipboardContent, Error>) -> String {
    match content {
        Ok(c) => format!(
            "text={} image={}",
            c.text.as_deref().unwrap_or("-"),
            c.image.map_or("-".into(), |png| png.len().to_string())
        ),
        Err(e) => format!("error: {e}"),
    }
}

#[derive(Default)]
struct Clipboard {
    /// What the last view action or event handler read.
    last: Option<String>,
}

impl Plugin for Clipboard {
    fn run_command(&mut self, id: &str, _: &Invocation, _: Option<&str>) -> Result<Option<String>, Error> {
        match id {
            "read" => Ok(Some(describe(Ok(host::read_clipboard()?)))),
            "last" => Ok(self.last.take()),
            _ => Err(Error::NotFound(id.into())),
        }
    }

    fn handle_events(&mut self, _: &[Event], _: &Invocation) {
        self.last = Some(describe(host::read_clipboard()));
    }
}

impl Views for Clipboard {
    fn render(&mut self, _: &str, _: Option<Viewport>, _: &Invocation) -> Result<View, Error> {
        Ok(View::new(Body::Message("clipboard".into())).button(Button::new("read", "Read")))
    }

    fn handle(&mut self, _: &str, _: ViewEvent, _: &Invocation) -> Result<(), Error> {
        self.last = Some(describe(host::read_clipboard()));
        Ok(())
    }
}

register_plugin!(Clipboard, views);
