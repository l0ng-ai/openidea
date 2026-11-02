//! Code navigation contributed by plugins (`[[contributes.code-navigation]]`).
//!
//! For a file an editor opens or saves that matches the declaration's `files`
//! globs, the IDE runs the declared command with `{"file": "<absolute path>"}`
//! and parses the returned string as a JSON [`PluginNavigation`]:
//!
//! ```json
//! {
//!   "links": [{ "line": 6, "from": 17, "to": 34, "title": "Rails::HealthController#show",
//!               "targets": [{ "file": "app/controllers/rails/health_controller.rb", "line": 3 }] }],
//!   "markers": [{ "line": 12, "icon": "file-html", "tooltip": "Views of show", "title": "Choose View",
//!                 "targets": [{ "file": "app/views/photos/show.html.erb" }] },
//!               { "line": 3, "icon": "db-table", "tooltip": "Table photos",
//!                 "targets": [{ "table": "photos", "title": "photos in Database" }] }],
//!   "diagnostics": [{ "line": 40, "message": "`draw :x`: not found" }],
//!   "files": ["config/routes.rb", "app/views/photos"]
//! }
//! ```
//!
//! `line` is 1-based, `from` / `to` are 0-based UTF-16 columns; a target names
//! either a `file` (project-relative or absolute, kept inside the project root)
//! or a database `table`. `files` are the paths whose change re-runs the command
//! for the file; diagnostics without a `file` are about the file asked.

use crate::manifest::CodeNavigationDecl;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Component, Path, PathBuf};

/// Where a link or marker leads: a position in a file, or a table of the
/// project's database (opened in the Database tool window).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginNavTarget {
    /// Target file (absolute after parsing); exclusive with `table`.
    #[serde(default)]
    #[specta(optional)]
    pub file: Option<String>,
    /// 1-based line in `file` (default: the first).
    #[serde(default)]
    #[specta(optional)]
    pub line: Option<u32>,
    /// 0-based UTF-16 column in `line` (default: the line start).
    #[serde(default)]
    #[specta(optional)]
    pub col: Option<u32>,
    /// Database table; exclusive with `file`.
    #[serde(default)]
    #[specta(optional)]
    pub table: Option<String>,
    /// Schema of `table` (default: the data source's default schema).
    #[serde(default)]
    #[specta(optional)]
    pub schema: Option<String>,
    /// Label in the targets chooser (default: the file or table name).
    #[serde(default)]
    #[specta(optional)]
    pub title: Option<String>,
}

/// A text range that navigates (Go to Declaration, ⌘-click, middle click).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginNavLink {
    /// 1-based line.
    pub line: u32,
    /// 0-based UTF-16 columns, `from` inclusive, `to` exclusive.
    pub from: u32,
    pub to: u32,
    /// Title of the chooser when there are several targets.
    #[serde(default)]
    #[specta(optional)]
    pub title: Option<String>,
    pub targets: Vec<PluginNavTarget>,
}

/// A gutter icon on a line, opening its targets.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginNavMarker {
    /// 1-based line.
    pub line: u32,
    /// `ui/icons` name (`file-html`, `db-table`, `web`…); unknown names get the default icon.
    #[serde(default)]
    #[specta(optional)]
    pub icon: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub tooltip: Option<String>,
    /// Title of the chooser when there are several targets.
    #[serde(default)]
    #[specta(optional)]
    pub title: Option<String>,
    /// May be empty: an informational icon (the tooltip says what is missing).
    #[serde(default)]
    pub targets: Vec<PluginNavTarget>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginNavDiagnostic {
    /// Absolute after parsing; default: the file the command was asked about.
    #[serde(default)]
    pub file: String,
    pub line: u32,
    pub message: String,
}

/// What a plugin knows about one file.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginNavigation {
    #[serde(default)]
    pub links: Vec<PluginNavLink>,
    #[serde(default)]
    pub markers: Vec<PluginNavMarker>,
    #[serde(default)]
    pub diagnostics: Vec<PluginNavDiagnostic>,
    /// Files (or directories) read; a change to one re-runs the command for the file.
    #[serde(default)]
    pub files: Vec<String>,
}

/// Whether the provider applies to the project at `root`: one of its markers exists (none: always).
pub fn applies(decl: &CodeNavigationDecl, root: &Path) -> bool {
    decl.markers.is_empty() || decl.markers.iter().any(|m| root.join(m).exists())
}

/// The argument the command receives for `file`.
pub fn command_arg(file: &Path) -> String {
    serde_json::json!({ "file": file.to_string_lossy() }).to_string()
}

/// `p` made absolute under `root`, when it stays inside it (lexically: `..`
/// components are resolved without touching the file system).
fn absolute_in_root(root: &Path, p: &str) -> Option<String> {
    let path = Path::new(p);
    let joined = if path.is_absolute() { path.to_path_buf() } else { root.join(path) };
    let mut normal = PathBuf::new();
    for c in joined.components() {
        match c {
            Component::ParentDir => {
                normal.pop();
            }
            Component::CurDir => {}
            c => normal.push(c.as_os_str()),
        }
    }
    normal.starts_with(root).then(|| normal.to_string_lossy().into_owned())
}

fn check_target(t: &mut PluginNavTarget, root: &Path) -> Result<(), String> {
    match (t.file.take(), &t.table) {
        (Some(file), None) => {
            if t.line == Some(0) {
                return Err(format!("target {file:?}: lines are 1-based"));
            }
            t.file =
                Some(absolute_in_root(root, &file).ok_or_else(|| format!("target {file:?} is outside the project"))?);
        }
        (None, Some(table)) if !table.is_empty() => {}
        _ => return Err("a target names either a `file` or a `table`".to_owned()),
    }
    Ok(())
}

/// Parses the command's output for `file`, makes every path absolute under
/// `root` and rejects targets that leave it.
pub fn parse_navigation(json: &str, root: &Path, file: &Path) -> Result<PluginNavigation, String> {
    if json.trim().is_empty() {
        return Err("the code navigation command returned nothing".to_owned());
    }
    let mut nav: PluginNavigation =
        serde_json::from_str(json).map_err(|e| format!("invalid code navigation answer: {e}"))?;
    for l in &mut nav.links {
        if l.line == 0 {
            return Err("link lines are 1-based".to_owned());
        }
        if l.to < l.from {
            return Err(format!("link on line {}: `to` is before `from`", l.line));
        }
        if l.targets.is_empty() {
            return Err(format!("link on line {} has no targets", l.line));
        }
        for t in &mut l.targets {
            check_target(t, root)?;
        }
    }
    for m in &mut nav.markers {
        if m.line == 0 {
            return Err("marker lines are 1-based".to_owned());
        }
        for t in &mut m.targets {
            check_target(t, root)?;
        }
    }
    let file = file.to_string_lossy();
    for d in &mut nav.diagnostics {
        if d.file.is_empty() {
            d.file = file.to_string();
        } else if let Some(abs) = absolute_in_root(root, &d.file) {
            d.file = abs;
        }
    }
    nav.files = nav.files.iter().filter_map(|f| absolute_in_root(root, f)).collect();
    Ok(nav)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decl(markers: &[&str]) -> CodeNavigationDecl {
        CodeNavigationDecl {
            command: "navigation".into(),
            markers: markers.iter().map(|m| m.to_string()).collect(),
            files: vec!["config/routes.rb".into()],
        }
    }

    #[test]
    fn applies_when_a_marker_exists() {
        let dir = tempfile::tempdir().unwrap();
        assert!(applies(&decl(&[]), dir.path()));
        assert!(!applies(&decl(&["config/routes.rb"]), dir.path()));
        std::fs::create_dir_all(dir.path().join("config")).unwrap();
        std::fs::write(dir.path().join("config/routes.rb"), "").unwrap();
        assert!(applies(&decl(&["bin/rails", "config/routes.rb"]), dir.path()));
    }

    #[test]
    fn the_command_receives_the_file_as_json() {
        assert_eq!(command_arg(Path::new("/app/config/routes.rb")), r#"{"file":"/app/config/routes.rb"}"#);
    }

    #[test]
    fn parses_links_markers_and_absolutises_paths() {
        let root = Path::new("/app");
        let nav = parse_navigation(
            r#"{"links":[{"line":6,"from":17,"to":34,"title":"HealthController#show",
                          "targets":[{"file":"app/controllers/health_controller.rb","line":3,"col":2}]}],
                "markers":[{"line":3,"icon":"db-table","tooltip":"Table photos",
                            "targets":[{"table":"photos","schema":"public","title":"photos in Database"},
                                       {"file":"/app/db/schema.rb","line":211}]},
                           {"line":9,"tooltip":"No view for edit"}],
                "diagnostics":[{"line":40,"message":"x"},{"file":"config/routes/admin.rb","line":1,"message":"y"}],
                "files":["config/routes.rb","app/views/photos","../outside.rb"]}"#,
            root,
            Path::new("/app/config/routes.rb"),
        )
        .unwrap();
        let link = &nav.links[0];
        assert_eq!((link.line, link.from, link.to), (6, 17, 34));
        assert_eq!(link.targets[0].file.as_deref(), Some("/app/app/controllers/health_controller.rb"));
        assert_eq!((link.targets[0].line, link.targets[0].col), (Some(3), Some(2)));
        let table = &nav.markers[0].targets[0];
        assert_eq!((table.table.as_deref(), table.schema.as_deref()), (Some("photos"), Some("public")));
        assert_eq!(nav.markers[0].targets[1].file.as_deref(), Some("/app/db/schema.rb"));
        assert!(nav.markers[1].targets.is_empty());
        assert_eq!(nav.diagnostics[0].file, "/app/config/routes.rb");
        assert_eq!(nav.diagnostics[1].file, "/app/config/routes/admin.rb");
        assert_eq!(nav.files, ["/app/config/routes.rb", "/app/app/views/photos"]);
    }

    #[test]
    fn rejects_bad_answers() {
        let root = Path::new("/app");
        let file = Path::new("/app/config/routes.rb");
        let err = |json: &str| parse_navigation(json, root, file).unwrap_err();
        assert!(err("").contains("returned nothing"));
        assert!(err("{\"links\": 1}").starts_with("invalid code navigation answer"));
        let link = |targets: &str| format!(r#"{{"links":[{{"line":1,"from":0,"to":3,"targets":[{targets}]}}]}}"#);
        assert!(err(&link(r#"{"file":"../etc/passwd"}"#)).contains("outside the project"));
        assert!(err(&link(r#"{"file":"/etc/passwd"}"#)).contains("outside the project"));
        assert!(err(&link(r#"{"file":"a/../../x.rb"}"#)).contains("outside the project"));
        assert!(err(&link(r#"{"file":"a.rb","table":"t"}"#)).contains("either"));
        assert!(err(&link(r#"{"title":"nothing"}"#)).contains("either"));
        assert!(err(&link(r#"{"file":"a.rb","line":0}"#)).contains("1-based"));
        assert!(err(&link("")).contains("no targets"));
        assert!(err(r#"{"links":[{"line":0,"from":0,"to":3,"targets":[{"file":"a.rb"}]}]}"#).contains("1-based"));
        assert!(err(r#"{"links":[{"line":1,"from":5,"to":3,"targets":[{"file":"a.rb"}]}]}"#).contains("before"));
        assert!(err(r#"{"markers":[{"line":0}]}"#).contains("1-based"));
        // A file target may be resolved lexically through `..` inside the root.
        let ok = parse_navigation(&link(r#"{"file":"app/../db/schema.rb"}"#), root, file).unwrap();
        assert_eq!(ok.links[0].targets[0].file.as_deref(), Some("/app/db/schema.rb"));
    }
}
