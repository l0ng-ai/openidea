use openidea_plugin::{Error, Invocation, Plugin, register_plugin};

#[derive(Default)]
struct FileTemplates;

impl Plugin for FileTemplates {
    fn run_command(&mut self, id: &str, _ctx: &Invocation, _arg: Option<&str>) -> Result<Option<String>, Error> {
        match id {
            "ping" => Ok(Some("File templates ready".into())),
            _ => Err(Error::NotFound(id.into())),
        }
    }
}

register_plugin!(FileTemplates);
