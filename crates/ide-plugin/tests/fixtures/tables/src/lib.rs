//! Test fixture: a table of file-type counts the plugin sorts itself. The
//! headers are clickable ([`Body::sortable_table`], the plugin API's `other`
//! body, kind `table`), the clicks arrive as `other` view-events (kind
//! `sort`), and the rows render in the order the plugin was asked for.

use openidea_plugin::host;
use openidea_plugin::views::{Body, Field, FieldValue, Table, TableSort, View, ViewEvent, Viewport, Views};
use openidea_plugin::{Error, Invocation, Plugin, register_plugin};

pub const VIEW: &str = "tables";

/// (extension, files) in no particular order, so sorting shows.
const ROWS: [(&str, &str); 4] = [("rs", "20"), ("md", "3"), ("java", "9"), ("toml", "12")];

#[derive(Default)]
pub struct Tables {
    sort: Option<TableSort>,
    status: Option<String>,
    note: Option<String>,
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
    fn run_command(&mut self, id: &str, _ctx: &Invocation, arg: Option<&str>) -> Result<Option<String>, Error> {
        if id == "inspect" {
            self.status = Some(format!("context:{}", arg.unwrap_or("")));
            host::refresh_view(VIEW);
            return Ok(self.status.clone());
        }
        Err(Error::NotFound(format!("command {id}")))
    }
}

impl Views for Tables {
    fn render(&mut self, view: &str, _viewport: Option<Viewport>, _ctx: &Invocation) -> Result<View, Error> {
        if view == "fields" {
            return Ok(View::new(Body::Form(vec![
                Field::new("title", "Title", FieldValue::label("Merge request #42")),
                Field::new("author", "Author", FieldValue::readonly_text("Ada Lovelace", false)),
                Field::new(
                    "description",
                    "Description",
                    FieldValue::readonly_text("Ready for review\nAll checks passed", true),
                ),
                Field::new(
                    "editable",
                    "Editable note",
                    FieldValue::Text(self.note.clone().unwrap_or_else(|| "Edit me".into())),
                ),
            ])));
        }
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
        let mut view = View::new(Body::sortable_table(&table, self.sort));
        view.status = self.status.clone();
        Ok(view)
    }

    fn handle(&mut self, view: &str, event: ViewEvent, _ctx: &Invocation) -> Result<(), Error> {
        if view == "fields" {
            if let ViewEvent::Field(key, value) = event {
                if key == "editable" {
                    self.note = Some(value);
                    host::refresh_view("fields");
                }
            }
            return Ok(());
        }
        if view != VIEW {
            return Err(Error::NotFound(view.into()));
        }
        if let Some(row) = event.table_select() {
            self.status = Some(format!("select:{row}"));
            host::refresh_view(VIEW);
        }
        if let Some(row) = event.table_activate() {
            self.status = Some(format!("activate:{row}"));
            host::refresh_view(VIEW);
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
