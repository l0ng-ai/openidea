//! CSV Editor for OpenIDEA: a custom editor showing `.csv` / `.tsv` files as
//! a table. It never keeps its own copy of the data: every render parses the
//! document, and every edit is a versioned text edit of the document, so the
//! text view of the same file follows at once and Undo is one history.
//!
//! Large files: the IDE asks only for the rows it shows; the parse of the
//! last document version is kept, so scrolling doesn't parse again.

use openidea_plugin::host;
use openidea_plugin::text::position;
use openidea_plugin::views::{Body, Button, Table, View, ViewEvent, Viewport, Views};
use openidea_plugin::{Error, Invocation, Plugin, Range, TextEdit, register_plugin};
use std::ops::Range as Span;

/// One record: the byte spans of its fields and of the whole record (without
/// the line break).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Record {
    pub fields: Vec<Span<usize>>,
    pub span: Span<usize>,
    /// Where the next record starts (after the line break), or the text's end.
    pub next: usize,
}

/// A parsed document.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Csv {
    pub delimiter: char,
    pub records: Vec<Record>,
}

/// The field's text: quotes removed, `""` unescaped.
pub fn field_text(text: &str, span: &Span<usize>) -> String {
    let raw = &text[span.clone()];
    match raw.strip_prefix('"').and_then(|r| r.strip_suffix('"')) {
        Some(inner) if raw.len() >= 2 => inner.replace("\"\"", "\""),
        _ => raw.to_owned(),
    }
}

/// `value` as a field: quoted when it contains the delimiter, a quote or a line break.
pub fn quote(value: &str, delimiter: char) -> String {
    if value.contains([delimiter, '"', '\n', '\r']) || value.starts_with(' ') || value.ends_with(' ') {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_owned()
    }
}

/// The delimiter: `tab` for .tsv, else the most frequent of `,;|\t` in the first line.
pub fn detect_delimiter(path: &str, text: &str, setting: &str) -> char {
    match setting {
        "," | ";" | "|" => return setting.chars().next().expect("non-empty"),
        "tab" => return '\t',
        _ => {}
    }
    if path.to_ascii_lowercase().ends_with(".tsv") {
        return '\t';
    }
    let first = text.lines().next().unwrap_or("");
    [',', ';', '\t', '|']
        .into_iter()
        .max_by_key(|d| first.matches(*d).count())
        .filter(|d| first.contains(*d))
        .unwrap_or(',')
}

/// RFC 4180 records (quoted fields may span lines); a trailing line break
/// doesn't start an empty record.
pub fn parse(text: &str, delimiter: char) -> Csv {
    let bytes = text.as_bytes();
    let d = delimiter as u8;
    let mut records = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let start = i;
        let mut fields = Vec::new();
        loop {
            let field_start = i;
            if bytes.get(i) == Some(&b'"') {
                i += 1;
                while i < bytes.len() {
                    if bytes[i] == b'"' {
                        if bytes.get(i + 1) == Some(&b'"') {
                            i += 2;
                            continue;
                        }
                        i += 1;
                        break;
                    }
                    i += 1;
                }
            }
            while i < bytes.len() && bytes[i] != d && bytes[i] != b'\n' && bytes[i] != b'\r' {
                i += 1;
            }
            fields.push(field_start..i);
            if i < bytes.len() && bytes[i] == d {
                i += 1;
                continue;
            }
            break;
        }
        let end = i;
        if bytes.get(i) == Some(&b'\r') {
            i += 1;
        }
        if bytes.get(i) == Some(&b'\n') {
            i += 1;
        }
        records.push(Record { fields, span: start..end, next: i });
    }
    Csv { delimiter, records }
}

#[derive(Default)]
pub struct CsvEditor {
    /// (path, version) of the last parse, and the parse.
    cache: Option<((String, u64), Csv)>,
}

/// Rows the IDE gets when it asks for no viewport.
const DEFAULT_ROWS: u32 = 200;

fn edit(text: &str, span: Span<usize>, new_text: String) -> TextEdit {
    TextEdit { range: Range::new(position(text, span.start), position(text, span.end)), text: new_text }
}

impl CsvEditor {
    fn parsed(&mut self, path: &str, version: u64, text: &str) -> &Csv {
        let key = (path.to_owned(), version);
        if self.cache.as_ref().is_none_or(|(k, _)| *k != key) {
            let setting = host::setting_string("delimiter").unwrap_or_else(|| "auto".into());
            let csv = parse(text, detect_delimiter(path, text, &setting));
            self.cache = Some((key, csv));
        }
        &self.cache.as_ref().expect("just set").1
    }

    /// The edits for `event` on `text` (`header`: the first record is not a row).
    pub fn edits_for(csv: &Csv, text: &str, header: bool, event: &ViewEvent) -> Result<Vec<TextEdit>, Error> {
        let skip = usize::from(header && !csv.records.is_empty());
        let d = csv.delimiter;
        let width = csv.records.iter().map(|r| r.fields.len()).max().unwrap_or(1).max(1);
        let empty_record = d.to_string().repeat(width - 1);
        let record = |row: u32| csv.records.get(row as usize + skip);
        let insert = |before: u32| match record(before) {
            Some(r) => vec![edit(text, r.span.start..r.span.start, format!("{empty_record}\n"))],
            None => {
                // Append; the last record may lack its line break.
                let end = text.len();
                let sep = if text.is_empty() || text.ends_with('\n') { "" } else { "\n" };
                vec![edit(text, end..end, format!("{sep}{empty_record}\n"))]
            }
        };
        Ok(match event {
            ViewEvent::Cell { row, column, value } => {
                let r = record(*row).ok_or_else(|| Error::Invalid(format!("no row {row}")))?;
                let column = *column as usize;
                match r.fields.get(column) {
                    Some(span) => vec![edit(text, span.clone(), quote(value, d))],
                    // A short record: pad it with empty fields.
                    None => {
                        let pad = d.to_string().repeat(column + 1 - r.fields.len());
                        vec![edit(text, r.span.end..r.span.end, format!("{pad}{}", quote(value, d)))]
                    }
                }
            }
            ViewEvent::InsertRow(before) => insert(*before),
            ViewEvent::Button(b) if b == "add-row" => insert(u32::MAX),
            ViewEvent::DeleteRows(rows) => {
                let mut rows: Vec<u32> = rows.clone();
                rows.sort_unstable();
                rows.dedup();
                rows.iter()
                    .filter_map(|row| record(*row))
                    .map(|r| edit(text, r.span.start..r.next, String::new()))
                    .collect()
            }
            _ => Vec::new(),
        })
    }
}

impl Plugin for CsvEditor {
    fn run_command(&mut self, id: &str, _ctx: &Invocation, _arg: Option<&str>) -> Result<Option<String>, Error> {
        Err(Error::NotFound(format!("command {id}")))
    }
}

impl Views for CsvEditor {
    fn render(&mut self, view: &str, viewport: Option<Viewport>, ctx: &Invocation) -> Result<View, Error> {
        if view != "table" {
            return Err(Error::NotFound(view.into()));
        }
        let editor = ctx.editor().ok_or_else(|| Error::Invalid("the table editor needs a document".into()))?;
        let doc = editor.document()?;
        let path = editor.path();
        let header = host::setting_bool("firstRowIsHeader").unwrap_or(true);
        let csv = self.parsed(&path, doc.version, &doc.text).clone();
        let skip = usize::from(header && !csv.records.is_empty());
        let width = csv.records.iter().map(|r| r.fields.len()).max().unwrap_or(0);
        let columns: Vec<String> = (0..width)
            .map(|c| match (header, csv.records.first().and_then(|r| r.fields.get(c))) {
                (true, Some(span)) => field_text(&doc.text, span),
                _ => format!("Column {}", c + 1),
            })
            .collect();
        let total = (csv.records.len() - skip) as u32;
        let range = Viewport::range(viewport, total, DEFAULT_ROWS);
        let rows = range
            .clone()
            .map(|row| {
                let r = &csv.records[row as usize + skip];
                (0..width).map(|c| r.fields.get(c).map(|s| field_text(&doc.text, s)).unwrap_or_default()).collect()
            })
            .collect();
        let delimiter = match csv.delimiter {
            '\t' => "tab".to_owned(),
            d => format!("'{d}'"),
        };
        Ok(View::new(Body::Table(Table { columns, total_rows: total, first_row: range.start, rows, editable: true }))
            .button(Button::new("add-row", "Add Row").icon("plus"))
            .status(&format!("{total} rows × {width} columns, delimiter {delimiter}")))
    }

    fn handle(&mut self, view: &str, event: ViewEvent, ctx: &Invocation) -> Result<(), Error> {
        if view != "table" {
            return Err(Error::NotFound(view.into()));
        }
        let editor = ctx.editor().ok_or_else(|| Error::Invalid("the table editor needs a document".into()))?;
        let doc = editor.document()?;
        let path = editor.path();
        let header = host::setting_bool("firstRowIsHeader").unwrap_or(true);
        let csv = self.parsed(&path, doc.version, &doc.text).clone();
        let edits = Self::edits_for(&csv, &doc.text, header, &event)?;
        if !edits.is_empty() {
            // Stale: the user typed in the text view meanwhile; the table renders again.
            editor.apply_edits(doc.version, &edits)?;
        }
        Ok(())
    }
}

register_plugin!(CsvEditor, views);

#[cfg(test)]
mod tests {
    use super::*;
    use openidea_plugin::mock::MockHost;

    const DATA: &str = "name,age,city\nAda,36,London\n\"Lovelace, A.\",\"say \"\"hi\"\"\",\"multi\nline\"\nBob,40\n";

    #[test]
    fn parses_quotes_line_breaks_and_short_records() {
        let csv = parse(DATA, ',');
        assert_eq!(csv.records.len(), 4);
        let texts: Vec<String> = csv.records[2].fields.iter().map(|s| field_text(DATA, s)).collect();
        assert_eq!(texts, ["Lovelace, A.", "say \"hi\"", "multi\nline"]);
        assert_eq!(csv.records[3].fields.len(), 2);
        assert_eq!(parse("a,b\r\nc,d", ',').records.len(), 2);
        assert_eq!(detect_delimiter("x.csv", "a;b;c\n", "auto"), ';');
        assert_eq!(detect_delimiter("x.tsv", "a,b\n", "auto"), '\t');
        assert_eq!(quote("a,b", ','), "\"a,b\"");
        assert_eq!(quote("plain", ','), "plain");
    }

    #[test]
    fn renders_the_visible_rows_with_the_header() {
        let host = MockHost::install();
        host.open_editor("/project/people.csv", "csv", DATA, &[]);
        let mut p = CsvEditor::default();
        let view = p.render("table", Some(Viewport { first_row: 1, rows: 1 }), &host.invocation()).unwrap();
        let Body::Table(t) = view.body else { panic!("a table") };
        assert_eq!(t.columns, ["name", "age", "city"]);
        assert_eq!((t.total_rows, t.first_row), (3, 1));
        assert_eq!(t.rows, [vec!["Lovelace, A.", "say \"hi\"", "multi\nline"]]);

        host.set_setting("firstRowIsHeader", "false");
        let view = p.render("table", None, &host.invocation()).unwrap();
        let Body::Table(t) = view.body else { panic!("a table") };
        assert_eq!((t.columns[0].as_str(), t.total_rows), ("Column 1", 4));
    }

    #[test]
    fn edits_cells_and_rows_through_the_document() {
        let host = MockHost::install();
        host.open_editor("/project/people.csv", "csv", DATA, &[]);
        let mut p = CsvEditor::default();
        let cell = |row, column, value: &str| ViewEvent::Cell { row, column, value: value.into() };
        p.handle("table", cell(0, 2, "Paris, FR"), &host.invocation()).unwrap();
        assert_eq!(host.editor_text().lines().nth(1), Some("Ada,36,\"Paris, FR\""));
        // A short record is padded.
        p.handle("table", cell(2, 2, "Oslo"), &host.invocation()).unwrap();
        assert!(host.editor_text().ends_with("Bob,40,Oslo\n"), "{}", host.editor_text());
        p.handle("table", ViewEvent::InsertRow(0), &host.invocation()).unwrap();
        assert_eq!(host.editor_text().lines().nth(1), Some(",,"));
        p.handle("table", ViewEvent::DeleteRows(vec![0, 1]), &host.invocation()).unwrap();
        assert!(host.editor_text().starts_with("name,age,city\n\"Lovelace"), "{}", host.editor_text());
        p.handle("table", ViewEvent::Button("add-row".into()), &host.invocation()).unwrap();
        assert!(host.editor_text().ends_with("Bob,40,Oslo\n,,\n"), "{}", host.editor_text());
    }

    #[test]
    fn a_changed_document_is_not_overwritten() {
        let host = MockHost::install();
        host.open_editor("/project/a.csv", "csv", "a,b\n1,2\n", &[]);
        let mut p = CsvEditor::default();
        let csv = parse("a,b\n1,2\n", ',');
        let edits =
            CsvEditor::edits_for(&csv, "a,b\n1,2\n", true, &ViewEvent::Cell { row: 0, column: 0, value: "9".into() });
        let editor = host.invocation().editor().unwrap();
        host.type_in_editor("x");
        assert_eq!(editor.apply_edits(0, &edits.unwrap()), Err(Error::Stale));
        // The next event works on the current version.
        p.handle("table", ViewEvent::Cell { row: 0, column: 1, value: "8".into() }, &host.invocation()).unwrap();
        assert!(host.editor_text().contains(",8"), "{}", host.editor_text());
    }
}
