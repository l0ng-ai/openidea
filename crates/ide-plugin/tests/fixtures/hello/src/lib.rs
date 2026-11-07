//! Sample OpenIDEA plugin, written with the `openidea-plugin` SDK.
//! Build with `openidea-plugin build crates/ide-plugin/tests/fixtures/hello` (see plugins/README.md).

use openidea_plugin::details::{Details, Pane, ProcessLog, Tab};
use openidea_plugin::views::{Body, Button, TreeItem, View, ViewEvent, Viewport, Views};
use openidea_plugin::{Context, Error, Invocation, LogLevel, NotificationLevel, Plugin, host, register_plugin};
use std::collections::BTreeSet;

#[derive(Default)]
struct Hello {
    /// Expanded languages of the Greetings tree.
    expanded: BTreeSet<String>,
}

/// The Greetings tree: languages, then their greetings (loaded when expanded).
const GREETINGS: &[(&str, &[&str])] = &[
    ("English", &["Hello", "Good morning", "Hi"]),
    ("Deutsch", &["Hallo", "Guten Morgen", "Servus"]),
    ("日本語", &["こんにちは", "おはよう"]),
];

impl Plugin for Hello {
    fn activate(&mut self, ctx: &Context) -> Result<(), Error> {
        host::log(LogLevel::Info, &format!("hello {} activated", ctx.plugin_version));
        Ok(())
    }

    fn deactivate(&mut self) {
        host::log(LogLevel::Info, "hello deactivated");
    }

    fn run_command(&mut self, id: &str, ctx: &Invocation, _arg: Option<&str>) -> Result<Option<String>, Error> {
        let editor = ctx.editor().ok_or("no file is open in the editor")?;
        match id {
            "insert-date" => {
                // Replaces every selection (inserts at every cursor), as one undo step.
                let date = today();
                editor.transform_selections(|_| date.clone())?;
                Ok(Some(date))
            }
            "word-count" => {
                let text = editor.document()?.text;
                let path = editor.path();
                let words = text.split_whitespace().count();
                let lines = text.lines().count();
                let name = path.rsplit(['/', '\\']).next().unwrap_or(&path);
                let body = format!("{words} words, {lines} lines, {} characters", text.chars().count());
                host::notify(NotificationLevel::Info, &format!("Word count: {name}"), &body);
                Ok(Some(body))
            }
            other => Err(Error::NotFound(format!("command {other}"))),
        }
    }
}

impl Views for Hello {
    fn render(&mut self, view: &str, _viewport: Option<Viewport>, _ctx: &Invocation) -> Result<View, Error> {
        if view != "greetings" {
            return Err(Error::NotFound(view.into()));
        }
        let mut items = Vec::new();
        for (language, words) in GREETINGS {
            let open = self.expanded.contains(*language);
            items.push(
                TreeItem::new(language, language).icon("folder").detail(&words.len().to_string()).expandable(open),
            );
            if open {
                for w in *words {
                    items.push(TreeItem::new(&format!("{language}/{w}"), w).parent(language).icon("text"));
                }
            }
        }
        Ok(View::new(Body::Tree(items))
            .button(Button::new("collapse", "Collapse All").icon("collapse-all").enabled(!self.expanded.is_empty()))
            .status(&format!("{} languages", GREETINGS.len())))
    }

    fn handle(&mut self, view: &str, event: ViewEvent, _ctx: &Invocation) -> Result<(), Error> {
        match event {
            ViewEvent::Expand(key) => {
                self.expanded.insert(key);
            }
            ViewEvent::Collapse(key) => {
                self.expanded.remove(&key);
            }
            ViewEvent::Button(b) if b == "collapse" => self.expanded.clear(),
            ViewEvent::Activate(key) => {
                if let Some((language, word)) = key.split_once('/') {
                    host::notify(NotificationLevel::Info, word, &format!("A greeting in {language}"));
                }
                return Ok(());
            }
            _ => return Ok(()),
        }
        host::refresh_view(view);
        Ok(())
    }
}

/// As a services view (tests): a node's key is the `sh -c` script its Log tab runs.
impl Details for Hello {
    fn detail(&mut self, view: &str, key: &str, _ctx: &Invocation) -> Result<Vec<Tab>, Error> {
        let log = ProcessLog::new("sh", &["-c", key]).toggle("named", "Named", &["named"]);
        Ok(vec![Tab::new("log", "Log", log), Tab::new("info", "Info", Pane::Text(format!("{view}: {key}")))])
    }
}

register_plugin!(Hello, views, details);

/// Today's UTC date as `YYYY-MM-DD` (WASI wall clock).
fn today() -> String {
    let secs =
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    format!("{y:04}-{m:02}-{d:02}")
}

/// Howard Hinnant's days-to-civil algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use openidea_plugin::mock::MockHost;

    #[test]
    fn civil_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_782), (2024, 2, 29));
    }

    #[test]
    fn word_count_reads_the_focused_editor() {
        let host = MockHost::install();
        host.open_editor("/project/notes.txt", "text", "one two\nthree\n", &[]);
        let out = Hello::default().run_command("word-count", &host.invocation(), None).unwrap();
        assert_eq!(out.as_deref(), Some("3 words, 2 lines, 14 characters"));
        assert_eq!(host.notifications()[0].title, "Word count: notes.txt");
    }

    #[test]
    fn insert_date_replaces_every_selection_at_once() {
        let host = MockHost::install();
        host.open_editor("/project/a.txt", "text", "a\nXX b", &[(0, 1, 0, 1), (1, 0, 1, 2)]);
        let date = Hello::default().run_command("insert-date", &host.invocation(), None).unwrap().unwrap();
        assert_eq!(host.editor_text(), format!("a{date}\n{date} b"));
        assert_eq!(host.editor_version(), 2, "one change");
    }

    #[test]
    fn the_greetings_tree_loads_children_when_expanded() {
        let host = MockHost::install();
        let mut p = Hello::default();
        let tree = |p: &mut Hello| match p.render("greetings", None, &host.invocation()).unwrap().body {
            Body::Tree(items) => items,
            other => panic!("{other:?}"),
        };
        assert_eq!(tree(&mut p).len(), 3);
        p.handle("greetings", ViewEvent::Expand("Deutsch".into()), &host.invocation()).unwrap();
        let items = tree(&mut p);
        assert_eq!(items.len(), 6);
        assert_eq!((items[2].label.as_str(), items[2].parent.as_deref()), ("Hallo", Some("Deutsch")));
        assert_eq!(host.refreshed_views(), ["greetings"]);
        p.handle("greetings", ViewEvent::Activate("Deutsch/Servus".into()), &host.invocation()).unwrap();
        assert_eq!(host.notifications()[0].title, "Servus");
        p.handle("greetings", ViewEvent::Button("collapse".into()), &host.invocation()).unwrap();
        assert_eq!(tree(&mut p).len(), 3);
    }

    #[test]
    fn without_editor_write_the_command_fails_cleanly() {
        let host = MockHost::install().with_capabilities(&["editor.read"]);
        host.open_editor("/project/a.txt", "text", "", &[(0, 0, 0, 0)]);
        let err = Hello::default().run_command("insert-date", &host.invocation(), None).unwrap_err();
        assert_eq!(err, Error::Denied("editor.write".into()));
        assert_eq!(host.editor_text(), "");
    }
}
