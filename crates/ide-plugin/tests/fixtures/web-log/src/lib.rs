use openidea_plugin::{Error, Invocation, Plugin, host, register_plugin};

#[derive(Default)]
struct WebLog;

impl Plugin for WebLog {
    fn run_command(&mut self, id: &str, _ctx: &Invocation, _arg: Option<&str>) -> Result<Option<String>, Error> {
        match id {
            "open" | "denied" => {
                host::post_view_message("logs", id)?;
                Ok(None)
            }
            "ping" => Ok(Some("Web log ready".into())),
            _ => Err(Error::NotFound(id.into())),
        }
    }
}

register_plugin!(WebLog);
