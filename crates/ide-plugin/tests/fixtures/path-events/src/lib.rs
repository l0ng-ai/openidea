use openidea_plugin::hover::{Document, Hover, HoverProvider};
use openidea_plugin::{Context, Error, Event, EventKind, Invocation, Plugin, Position, host, register_plugin};

#[derive(Default)]
struct Fixture;

impl Plugin for Fixture {
    fn activate(&mut self, _: &Context) -> Result<(), Error> {
        // Persist the chosen filter so reactivation does not overwrite it.
        let glob = host::storage::get("filter")?.unwrap_or_else(|| "config/*.yaml".into());
        let globs: Vec<_> = glob.lines().collect();
        let _ = host::subscribe_paths("file-opened", &globs);
        let _ = host::subscribe_paths("file-saved", &["config/*.yaml"]);
        Ok(())
    }
    fn run_command(&mut self, id: &str, _: &Invocation, arg: Option<&str>) -> Result<Option<String>, Error> {
        match id {
            "project" => host::project_of(arg.unwrap_or_default()).map(|p| p.root()).transpose(),
            "filter" => {
                let glob = arg.unwrap_or_default();
                host::subscribe_paths("file-opened", &glob.lines().collect::<Vec<_>>())?;
                host::storage::set("filter", glob)?;
                Ok(None)
            }
            "all" => {
                host::subscribe(EventKind::FileOpened)?;
                Ok(None)
            }
            "off" => {
                host::unsubscribe(EventKind::FileOpened);
                Ok(None)
            }
            "count" => Ok(host::storage::get("count")?),
            _ => Err(Error::NotFound(id.into())),
        }
    }
    fn handle_events(&mut self, events: &[Event], _: &Invocation) {
        let count = host::storage::get("count").ok().flatten().and_then(|n| n.parse::<usize>().ok()).unwrap_or(0);
        host::storage::set("count", &(count + events.len()).to_string()).unwrap();
    }
}
impl HoverProvider for Fixture {
    fn hover(&mut self, doc: &Document, _: Position) -> Option<Hover> {
        Some(Hover::new(host::project_of(&doc.path)?.root().ok()?))
    }
}
register_plugin!(Fixture, hover);
