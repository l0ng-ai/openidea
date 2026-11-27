use openidea_plugin::{Error, Invocation, Plugin, host, register_plugin};

#[derive(Default)]
struct Storage;

impl Plugin for Storage {
    fn run_command(&mut self, id: &str, _: &Invocation, _: Option<&str>) -> Result<Option<String>, Error> {
        match id {
            "save" => {
                host::storage::set("index", &"é".repeat(2 << 20))?;
                Ok(None)
            }
            "load" => {
                let value = host::storage::get("index")?.ok_or("missing index")?;
                if value != "é".repeat(2 << 20) {
                    return Err("index changed".into());
                }
                Ok(Some(value.len().to_string()))
            }
            _ => Err(Error::NotFound(id.into())),
        }
    }
}

register_plugin!(Storage);
