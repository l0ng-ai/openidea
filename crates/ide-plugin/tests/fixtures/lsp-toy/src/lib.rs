use openidea_plugin::{Error, Invocation, Plugin, register_plugin};

#[derive(Default)]
struct LspToy;

impl Plugin for LspToy {
    fn run_command(&mut self, id: &str, ctx: &Invocation, _arg: Option<&str>) -> Result<Option<String>, Error> {
        let project = ctx.project().ok_or("no project")?;
        match id {
            "model-view" => project
                .language_server_request("phoxite", "phoxite/laravel/modelView", Some(r#"{"model":"User"}"#))
                .map(Some),
            "touched" => {
                project.language_server_notify("phoxite", "phoxite/laravel/touched", Some(r#"{"file":"a.php"}"#))?;
                Ok(None)
            }
            _ => Err(Error::NotFound(id.into())),
        }
    }
}

register_plugin!(LspToy);
