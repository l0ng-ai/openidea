use openidea_plugin::search::{SearchItem, SearchPage, SearchProvider, SearchTarget};
use openidea_plugin::{Error, Invocation, Location, Plugin, Position, Range, register_plugin};

#[derive(Default)]
struct Fixture;
impl Plugin for Fixture {
    fn run_command(&mut self, id: &str, _: &Invocation, arg: Option<&str>) -> Result<Option<String>, Error> {
        if id == "open" {
            return Ok(arg.map(str::to_owned));
        }
        Err(Error::NotFound(id.into()))
    }
}
impl SearchProvider for Fixture {
    fn search(&mut self, category: &str, query: &str, limit: u32, ctx: &Invocation) -> Result<SearchPage, Error> {
        if query == "spin" {
            loop {
                std::hint::spin_loop();
            }
        }
        if query == "prompt" {
            openidea_plugin::host::input("Search must not prompt", None)?;
        }
        let target = if category == "routes" {
            let project = ctx.project().ok_or("no project")?;
            SearchTarget::Location(Location {
                path: format!("{}/routes.txt", project.root()?),
                range: Range { start: Position::new(0, 0), end: Position::new(0, 0) },
            })
        } else {
            SearchTarget::Command { id: "open".into(), arg: Some(query.into()) }
        };
        Ok(SearchPage {
            items: (0..limit.min(2))
                .map(|n| SearchItem {
                    id: n.to_string(),
                    title: format!("{category}: {query}"),
                    description: Some("Search fixture".into()),
                    target: target.clone(),
                })
                .collect(),
            has_more: limit < 2,
        })
    }
}
register_plugin!(Fixture, search);
