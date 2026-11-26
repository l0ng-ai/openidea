use openidea_plugin::{Error, Event, FilesChanged, Invocation, Plugin, host, register_plugin};

#[derive(Default)]
struct WatchPaths;

impl Plugin for WatchPaths {
    fn run_command(&mut self, id: &str, _ctx: &Invocation, arg: Option<&str>) -> Result<Option<String>, Error> {
        match id {
            "watch" => {
                let paths: Vec<&str> = arg.unwrap_or_default().lines().filter(|l| !l.is_empty()).collect();
                host::watch_paths(&paths)?;
                Ok(None)
            }
            "events" => host::storage::get("events"),
            _ => Err(Error::NotFound(id.into())),
        }
    }

    fn handle_events(&mut self, events: &[Event], _ctx: &Invocation) {
        let mut received: Vec<FilesChanged> =
            host::storage::get("events").unwrap().map(|s| serde_json::from_str(&s).unwrap()).unwrap_or_default();
        for event in events {
            if let Event::WatchedFilesChanged(batch) = event {
                received.push(batch.clone());
            }
        }
        host::storage::set("events", &serde_json::to_string(&received).unwrap()).unwrap();
    }
}

register_plugin!(WatchPaths);
