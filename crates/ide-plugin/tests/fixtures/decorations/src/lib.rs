//! Minimal plugin API 1.6 example: push a line-end label whose hover is Markdown.

use openidea_plugin::{Error, Invocation, MarkdownDecoration, Plugin, Position, Range, host, register_plugin};

#[derive(Default)]
struct Decorations;

impl Plugin for Decorations {
    fn run_command(&mut self, id: &str, _ctx: &Invocation, arg: Option<&str>) -> Result<Option<String>, Error> {
        match id {
            "publish" => {
                let path = arg.ok_or_else(|| Error::Invalid("a project file path is required".into()))?;
                host::set_markdown_decorations(
                    path,
                    "example",
                    &[MarkdownDecoration {
                        range: Range::new(Position::new(0, 0), Position::new(0, 1)),
                        style: "highlight".into(),
                        hover: Some("model-x generated this line".into()),
                        after: Some(" + model-x".into()),
                        markdown_hover: Some(
                            "**model-x** generated this line\n\n- prompt: add a greeting".into(),
                        ),
                    }],
                )?;
                Ok(None)
            }
            "clear" => {
                host::clear_decorations("example")?;
                Ok(None)
            }
            other => Err(Error::NotFound(format!("command {other}"))),
        }
    }
}

register_plugin!(Decorations);
