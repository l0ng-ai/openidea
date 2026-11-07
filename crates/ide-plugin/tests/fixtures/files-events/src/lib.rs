use openidea_plugin::{Error, Event, FilesChanged, Invocation, Plugin, host, register_plugin};

#[derive(Default)]
struct FilesEvents;

impl Plugin for FilesEvents {
    fn run_command(&mut self, id: &str, _ctx: &Invocation, arg: Option<&str>) -> Result<Option<String>, Error> {
        match id {
            "events" => host::storage::get("events"),
            "filter" => {
                host::subscribe_paths("files-changed", &arg.unwrap_or_default().lines().collect::<Vec<_>>())?;
                Ok(None)
            }
            "unsubscribe" => {
                host::unsubscribe(openidea_plugin::EventKind::FilesChanged);
                Ok(None)
            }
            _ => Err(Error::NotFound(id.into())),
        }
    }

    fn handle_events(&mut self, events: &[Event], ctx: &Invocation) {
        let mut received: Vec<FilesChanged> =
            host::storage::get("events").unwrap().map(|s| serde_json::from_str(&s).unwrap()).unwrap_or_default();
        for event in events {
            if let Event::FilesChanged(batch) = event {
                if batch.created.iter().any(|p| p.ends_with("/__block__.txt")) {
                    let task = host::begin_task("Filesystem delta", false);
                    ctx.project().unwrap().read_file("event-barrier.txt").unwrap();
                    if task.is_cancelled() {
                        return;
                    }
                }
                received.push(batch.clone());
            }
        }
        host::storage::set("events", &serde_json::to_string(&received).unwrap()).unwrap();
    }
}

register_plugin!(FilesEvents);
