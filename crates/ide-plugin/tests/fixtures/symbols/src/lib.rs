use openidea_plugin::host::{self, Project};
use openidea_plugin::providers::{Document, Providers};
use openidea_plugin::{Error, Invocation, Location, Plugin, Position, register_plugin};

#[derive(Default)]
struct Fixture {
    project: Option<Project>,
}

impl Plugin for Fixture {
    fn run_command(&mut self, id: &str, ctx: &Invocation, arg: Option<&str>) -> Result<Option<String>, Error> {
        if id == "remember" {
            self.project = ctx.project();
            return Ok(None);
        }
        let current = ctx.project();
        let project = if id == "remembered" { self.project.as_ref() } else { current.as_ref() }
            .ok_or_else(|| Error::NotFound("no project".into()))?;
        let (query, limit) = arg.unwrap_or("Order|10").rsplit_once('|').ok_or("expected query|limit")?;
        let limit = limit.parse().map_err(|_| Error::Invalid("invalid limit".into()))?;
        let symbols = project.symbols(query, limit)?;
        Ok(Some(
            symbols
                .into_iter()
                .map(|s| {
                    format!(
                        "{}\t{}\t{}\t{}\t{}:{}-{}:{}",
                        s.name,
                        s.kind,
                        s.container.unwrap_or_default(),
                        s.location.path,
                        s.location.range.start.line,
                        s.location.range.start.character,
                        s.location.range.end.line,
                        s.location.range.end.character
                    )
                })
                .collect::<Vec<_>>()
                .join("\n"),
        ))
    }
}

impl Providers for Fixture {
    fn definition(&mut self, doc: &Document, _: Position) -> Vec<Location> {
        host::project_of(&doc.path)
            .and_then(|project| project.symbols(doc.text.trim(), 10).ok())
            .unwrap_or_default()
            .into_iter()
            .map(|s| s.location)
            .collect()
    }
}

register_plugin!(Fixture, providers);
