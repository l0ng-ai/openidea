use openidea_plugin::{Error, Invocation, Plugin, host, register_plugin};

#[derive(Default)]
struct WebContent;

impl Plugin for WebContent {
    fn run_command(&mut self, id: &str, _ctx: &Invocation, _arg: Option<&str>) -> Result<Option<String>, Error> {
        match id {
            "open" => {
                host::post_view_message("inspector", "open")?;
                Ok(None)
            }
            "ping" => Ok(Some("Web content ready".into())),
            _ => Err(Error::NotFound(id.into())),
        }
    }
}

register_plugin!(WebContent);
