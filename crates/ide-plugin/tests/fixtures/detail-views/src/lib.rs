//! A tree/list detail-provider fixture for host and native UI verification.
use std::collections::BTreeMap;

use openidea_plugin::details::{Details, Pane, Tab};
use openidea_plugin::views::{Body, Button, ListItem, TreeItem, View, ViewEvent, Viewport, Views};
use openidea_plugin::{Error, Invocation, Plugin, host, register_plugin};

#[derive(Default)]
struct DetailViews {
    selected: BTreeMap<String, String>,
    removed: bool,
    revision: u32,
}

impl Plugin for DetailViews {
    fn run_command(&mut self, id: &str, _ctx: &Invocation, _arg: Option<&str>) -> Result<Option<String>, Error> {
        Err(Error::NotFound(id.into()))
    }
}

impl Views for DetailViews {
    fn render(&mut self, view: &str, _viewport: Option<Viewport>, _ctx: &Invocation) -> Result<View, Error> {
        let keys: &[&str] = if self.removed { &["beta"] } else { &["alpha", "beta"] };
        let body = if view == "list" {
            Body::List(keys.iter().map(|key| ListItem::new(key, key)).collect())
        } else {
            Body::Tree(keys.iter().map(|key| TreeItem::new(key, key)).collect())
        };
        Ok(View::new(body)
            .button(Button::new("refresh", "Refresh details"))
            .button(Button::new("remove", "Remove alpha")))
    }

    fn handle(&mut self, view: &str, event: ViewEvent, _ctx: &Invocation) -> Result<(), Error> {
        match event {
            ViewEvent::Select(key) => {
                self.selected.insert(view.to_owned(), key);
            }
            ViewEvent::Button(id) => {
                if id == "remove" {
                    self.removed = true;
                }
                self.revision += 1;
                host::refresh_view(view);
            }
            _ => {}
        }
        Ok(())
    }
}

impl Details for DetailViews {
    fn detail(&mut self, view: &str, key: &str, _ctx: &Invocation) -> Result<Vec<Tab>, Error> {
        if self.selected.get(view).map(String::as_str) != Some(key) {
            return Err(Error::Failed("select must finish before detail".into()));
        }
        Ok(vec![
            Tab::new("info", "Info", Pane::Text(format!("{view}: {key}\nRevision {}", self.revision))),
            Tab::new("message", "Summary", Pane::Message(format!("Selected {key}"))),
        ])
    }
}

register_plugin!(DetailViews, views, details);
