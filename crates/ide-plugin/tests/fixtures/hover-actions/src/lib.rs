//! Minimal API 1.13 fixture for the optional `hover-actions` export.
use openidea_plugin::language_features::Document;
use openidea_plugin::{Error, HoverAction, HoverActions, Invocation, Plugin, register_plugin};

#[derive(Default)]
struct Fixture;

impl Plugin for Fixture {
    fn run_command(&mut self, id: &str, _: &Invocation, arg: Option<&str>) -> Result<Option<String>, Error> {
        match id {
            "run" => Ok(arg.map(str::to_owned)),
            _ => Err(Error::NotFound(id.into())),
        }
    }
}

impl HoverActions for Fixture {
    fn hover_actions(&mut self, _: &Document) -> Vec<HoverAction> {
        vec![HoverAction {
            line: 0,
            start_line: 0,
            end_line: 2,
            icon: Some("run".into()),
            label: "Run hover action".into(),
            tooltip: Some("Run hover action".into()),
            command: "run".into(),
            argument: Some("hover".into()),
        }]
    }
}

register_plugin!(Fixture, hover_actions);
