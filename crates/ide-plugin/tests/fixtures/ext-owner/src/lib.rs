use openidea_plugin::{Error, Event, Invocation, Plugin, host, register_plugin};

#[derive(Default)]
struct Owner;

impl Plugin for Owner {
    fn run_command(&mut self, id: &str, _ctx: &Invocation, arg: Option<&str>) -> Result<Option<String>, Error> {
        match id {
            "dump" => {
                let list = host::extension_contributions("test.ext-owner.items")?;
                Ok(Some(list.iter().map(|c| format!("{}:{}", c.plugin, c.data)).collect::<Vec<_>>().join("\n")))
            }
            "read" => {
                let list = host::extension_contributions(arg.unwrap_or_default())?;
                Ok(Some(list.len().to_string()))
            }
            "changes" => host::storage::get("changes"),
            _ => Err(Error::NotFound(id.into())),
        }
    }

    fn handle_events(&mut self, events: &[Event], _ctx: &Invocation) {
        let mut seen = host::storage::get("changes").unwrap().unwrap_or_default();
        for event in events {
            if let Event::Other { kind, data } = event
                && kind == "extensions-changed"
            {
                seen.push_str(data);
                seen.push('\n');
            }
        }
        host::storage::set("changes", &seen).unwrap();
    }
}

register_plugin!(Owner);
