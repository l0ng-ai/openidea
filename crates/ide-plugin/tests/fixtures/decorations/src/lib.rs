//! Minimal plugin API 1.17 example: push a line-end label whose hover is Markdown,
//! and ranges painted in the plugin's own colors.

use openidea_plugin::{
    DecorationColors, Error, Invocation, MarkdownDecoration, Plugin, Position, Range, StyledDecoration, host,
    register_plugin,
};

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
                        markdown_hover: Some("**model-x** generated this line\n\n- prompt: add a greeting".into()),
                    }],
                )?;
                Ok(None)
            }
            "styled" => {
                let path = arg.ok_or_else(|| Error::Invalid("a project file path is required".into()))?;
                let todo = |range, foreground: Option<&str>, background: &str| StyledDecoration {
                    range,
                    style: String::new(),
                    hover: Some("TODO".into()),
                    after: None,
                    markdown_hover: None,
                    colors: Some(DecorationColors {
                        foreground: foreground.map(Into::into),
                        background: Some(background.into()),
                    }),
                };
                host::set_styled_decorations(
                    path,
                    "example",
                    &[
                        todo(Range::new(Position::new(0, 0), Position::new(0, 1)), Some("#1A1A1A"), "#FFEB3B"),
                        todo(Range::new(Position::new(0, 1), Position::new(0, 2)), None, "#00e5ff80"),
                    ],
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
