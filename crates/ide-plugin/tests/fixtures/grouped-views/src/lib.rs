use openidea_plugin::views::{Body, View, ViewEvent, Viewport, Views};
use openidea_plugin::{Error, Invocation, Plugin, host, register_plugin};

#[derive(Default)]
struct GroupedViews;

impl Plugin for GroupedViews {
    fn run_command(&mut self, id: &str, _ctx: &Invocation, arg: Option<&str>) -> Result<Option<String>, Error> {
        match id {
            "show" => host::set_context("ready", true)?,
            "hide" => host::set_context("ready", false)?,
            "reveal" => host::reveal_view(arg.unwrap_or("overview"))?,
            _ => return Err(Error::NotFound(id.into())),
        }
        Ok(None)
    }
}

impl Views for GroupedViews {
    fn render(&mut self, view: &str, _viewport: Option<Viewport>, _ctx: &Invocation) -> Result<View, Error> {
        match view {
            "overview" => Ok(View::new(Body::Message("Context condition is true".into()))),
            "files" => Ok(View::new(Body::Message("Project contains grouped-views.txt".into()))),
            "legacy" => Ok(View::new(Body::Message("Ungrouped view keeps its original window id".into()))),
            _ => Err(Error::NotFound(view.into())),
        }
    }

    fn handle(&mut self, _view: &str, _event: ViewEvent, _ctx: &Invocation) -> Result<(), Error> {
        Ok(())
    }
}

register_plugin!(GroupedViews, views);
