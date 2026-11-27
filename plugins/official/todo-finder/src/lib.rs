//! A view searches its invoking project afresh, so instance state never mixes windows.
use openidea_plugin::views::{Body, ListItem, View, ViewEvent, Viewport, Views};
use openidea_plugin::{Error, Invocation, Location, Plugin, StatusItem, TextQuery, host, register_plugin};
#[derive(Default)]
pub struct TodoFinder;
fn query() -> TextQuery {
    TextQuery { pattern: "TODO".into(), case_sensitive: true, ..Default::default() }
}
impl Plugin for TodoFinder {
    fn run_command(&mut self, _id: &str, ctx: &Invocation, _arg: Option<&str>) -> Result<Option<String>, Error> {
        let found = ctx.project().ok_or("Open a project first")?.search_text(&query(), 500)?;
        let problems: usize = host::problems(None)?.iter().map(|p| p.diagnostics.len()).sum();
        host::set_window_status_item(
            "todos",
            &StatusItem {
                text: format!("{} TODOs · {problems} problems", found.matches.len()),
                tooltip: None,
                command: Some("find".into()),
            },
        )?;
        host::refresh_view("todos");
        host::reveal_view("todos")?;
        Ok(None)
    }
}
impl Views for TodoFinder {
    fn render(&mut self, _view: &str, _viewport: Option<Viewport>, ctx: &Invocation) -> Result<View, Error> {
        let found = ctx.project().ok_or("Open a project first")?.search_text(&query(), 500)?;
        let items = found
            .matches
            .into_iter()
            .map(|m| {
                ListItem::new(&serde_json::to_string(&m.location).unwrap(), &m.line).detail(&format!(
                    "{}:{}",
                    m.location.path,
                    m.location.range.start.line + 1
                ))
            })
            .collect();
        Ok(View {
            toolbar: vec![],
            body: Body::List(items),
            status: found.limit_hit.then(|| "Showing the first 500 matches".into()),
        })
    }
    fn handle(&mut self, _view: &str, event: ViewEvent, _ctx: &Invocation) -> Result<(), Error> {
        if let ViewEvent::Activate(key) = event {
            let location: Location = serde_json::from_str(&key).map_err(|e| Error::Invalid(e.to_string()))?;
            host::open_location(&location.path, location.range.start.line, location.range.start.character)?;
        }
        Ok(())
    }
}
register_plugin!(TodoFinder, views);
#[cfg(test)]
mod tests {
    use super::*;
    use openidea_plugin::{Range, TextMatch, TextSearch, mock::MockHost};
    #[test]
    fn search_results_open_their_location_and_count_problems() {
        let mock = MockHost::install();
        mock.on_search(|q, _| {
            assert_eq!(q.pattern, "TODO");
            Ok(TextSearch {
                matches: vec![TextMatch {
                    location: Location { path: "/project/a.txt".into(), range: Range::default() },
                    line: "TODO fix".into(),
                }],
                limit_hit: false,
            })
        });
        TodoFinder.run_command("find", &mock.invocation(), None).unwrap();
        assert_eq!(mock.status_items()["todos"].text, "1 TODOs · 0 problems");
        let view = TodoFinder.render("todos", None, &mock.invocation()).unwrap();
        let Body::List(items) = view.body else { panic!() };
        TodoFinder.handle("todos", ViewEvent::Activate(items[0].key.clone()), &mock.invocation()).unwrap();
        assert_eq!(mock.opened_locations()[0], ("/project/a.txt".into(), 0, 0));
    }
}
