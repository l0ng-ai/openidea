use openidea_plugin::endpoints::{Endpoint, EndpointsProvider};
use openidea_plugin::{Error, Invocation, Location, Plugin, Position, Range, register_plugin};
#[derive(Default)]
struct Fixture;
impl Plugin for Fixture {
    fn run_command(&mut self, id: &str, _: &Invocation, _: Option<&str>) -> Result<Option<String>, Error> {
        if id == "crash" {
            panic!("endpoint fixture crash");
        }
        Err(Error::NotFound(id.into()))
    }
}
impl EndpointsProvider for Fixture {
    fn endpoints(&mut self, ctx: &Invocation) -> Result<Vec<Endpoint>, Error> {
        let project = ctx.project().ok_or("no project invocation")?;
        let text = project.read_file("routes.txt")?;
        if text.is_empty() {
            return Ok(vec![]);
        }
        Ok(vec![Endpoint {
            method: None,
            path: text.lines().next().unwrap().into(),
            framework: "Fixture".into(),
            handler: Some("Routes#show".into()),
            location: Location {
                path: format!("{}/routes.txt", project.root()?),
                range: Range { start: Position::new(0, 0), end: Position::new(0, 0) },
            },
        }])
    }
}
register_plugin!(Fixture, endpoints);
