//! Test fixture: a table of file-type counts the plugin sorts itself. The
//! headers are clickable ([`Body::sortable_table`], the plugin API's `other`
//! body, kind `table`), the clicks arrive as `other` view-events (kind
//! `sort`), and the rows render in the order the plugin was asked for.

use openidea_plugin::host;
use openidea_plugin::views::{Body, Table, TableSort, View, ViewEvent, Viewport, Views};
use openidea_plugin::{Error, Invocation, Plugin, register_plugin};

pub const VIEW: &str = "tables";

/// (extension, files) in no particular order, so sorting shows.
const ROWS: [(&str, &str); 4] = [("rs", "20"), ("md", "3"), ("java", "9"), ("toml", "12")];

#[derive(Default)]
pub struct Tables {
    sort: Option<TableSort>,
}

impl Tables {
    /// The rows in the order `sort` asks for (a real plugin would sort its
    /// whole table and page it; the fixture is small enough to sort inline).
    fn rows(&self) -> Vec<Vec<String>> {
        let mut rows: Vec<Vec<String>> = ROWS.iter().map(|(a, b)| vec![a.to_string(), b.to_string()]).collect();
        if let Some(sort) = self.sort {
            let by_number = |r: &Vec<String>| r[1].parse::<u32>().unwrap_or(0);
            rows.sort_by(|a, b| {
                let (x, y) = (by_number(a), by_number(b));
                if sort.descending { y.cmp(&x) } else { x.cmp(&y) }
            });
        }
        rows
    }
}

impl Plugin for Tables {
    fn run_command(&mut self, id: &str, _ctx: &Invocation, _arg: Option<&str>) -> Result<Option<String>, Error> {
        Err(Error::NotFound(format!("command {id}")))
    }
}

impl Views for Tables {
    fn render(&mut self, view: &str, _viewport: Option<Viewport>, _ctx: &Invocation) -> Result<View, Error> {
        if view != VIEW {
            return Err(Error::NotFound(view.into()));
        }
        let table = Table {
            columns: vec!["ext".into(), "files".into()],
            total_rows: ROWS.len() as u32,
            first_row: 0,
            rows: self.rows(),
            editable: false,
        };
        Ok(View::new(Body::sortable_table(&table, self.sort)))
    }

    fn handle(&mut self, view: &str, event: ViewEvent, _ctx: &Invocation) -> Result<(), Error> {
        if view != VIEW {
            return Err(Error::NotFound(view.into()));
        }
        // The host may have encoded the click for a newer SDK: the typed
        // helper reads the `other` kind `sort` this SDK knows.
        if let Some(sort) = event.sort() {
            self.sort = Some(sort);
            host::refresh_view(VIEW);
        }
        Ok(())
    }
}

register_plugin!(Tables, views);
