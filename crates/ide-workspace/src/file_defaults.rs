//! Settings › Editor › File Encodings / Code Style defaults applied by the
//! document layer: encoding, BOM and line separator of new (empty) files, the
//! encoding of files that are not valid UTF-8 or are plain ASCII (Maven's
//! `project.build.sourceEncoding` included), and EditorConfig support.

use ide_core::settings::Settings;
use ide_text::LineEnding;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq)]
pub struct FileDefaults {
    /// Encoding of new files (WHATWG label).
    pub encoding: String,
    /// Write a BOM into new UTF-8 files.
    pub utf8_bom: bool,
    pub line_ending: LineEnding,
    /// Encoding of project files that are not valid UTF-8 or are plain ASCII.
    pub project_fallback: String,
    /// Fallback for files outside `root`.
    pub global_fallback: String,
    pub properties_fallback: String,
    pub native_to_ascii: bool,
    pub editorconfig: bool,
    pub root: Option<PathBuf>,
    /// Source folder of a Maven module (absolute) and the `project.build.sourceEncoding` of its
    /// POM as a WHATWG label. Comes from the build model, not from settings.
    pub pom_encodings: Vec<(PathBuf, String)>,
}

impl Default for FileDefaults {
    fn default() -> Self {
        Self::from_settings(&Settings::default(), None)
    }
}

impl FileDefaults {
    pub fn from_settings(s: &Settings, root: Option<&Path>) -> Self {
        let enc = &s.editor.encodings;
        let style = &s.editor.code_style;
        let line_ending = match style.line_separator.as_str() {
            "crlf" => LineEnding::CrLf,
            "cr" => LineEnding::Cr,
            "lf" => LineEnding::Lf,
            _ if cfg!(windows) => LineEnding::CrLf,
            _ => LineEnding::Lf,
        };
        let utf8_bom = enc.utf8_bom == "always" || (cfg!(windows) && enc.utf8_bom == "windows");
        Self {
            encoding: normalize(&enc.project),
            utf8_bom,
            line_ending,
            project_fallback: normalize(&enc.project),
            global_fallback: normalize(&enc.global),
            properties_fallback: normalize(&enc.properties),
            native_to_ascii: enc.native_to_ascii,
            editorconfig: style.editorconfig,
            root: root.map(Path::to_path_buf),
            pom_encodings: Vec::new(),
        }
    }

    /// Encoding for `path` when it is not valid UTF-8 or is plain ASCII (`None`: detect).
    pub fn fallback_for(&self, path: &Path) -> Option<&str> {
        let label = if path.extension().is_some_and(|e| e == "properties") {
            &self.properties_fallback
        } else if let Some(pom) = self.pom_encoding_for(path) {
            pom
        } else if self.root.as_ref().is_none_or(|r| path.starts_with(r)) {
            &self.project_fallback
        } else {
            &self.global_fallback
        };
        (label != "utf-8").then_some(label.as_str())
    }

    /// The encoding of the innermost Maven source folder containing `path`.
    fn pom_encoding_for(&self, path: &Path) -> Option<&String> {
        self.pom_encodings
            .iter()
            .filter(|(dir, _)| path.starts_with(dir))
            .max_by_key(|(dir, _)| dir.components().count())
            .map(|(_, label)| label)
    }

    pub fn native_to_ascii_for(&self, path: &Path) -> bool {
        self.native_to_ascii && path.extension().is_some_and(|e| e == "properties")
    }

    /// Bytes of a new empty file: a BOM when UTF-8 files are created with one.
    pub fn new_file_bytes(&self) -> Vec<u8> {
        if self.encoding == "utf-8" && self.utf8_bom {
            ide_vfs::encode("", "utf-8", true).unwrap_or_default()
        } else {
            Vec::new()
        }
    }
}

fn normalize(label: &str) -> String {
    let l = label.trim().to_ascii_lowercase();
    match l.as_str() {
        "" | "utf8" => "utf-8".into(),
        _ => l,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_settings() {
        let mut s = Settings::default();
        s.editor.encodings.utf8_bom = "always".into();
        s.editor.encodings.project = "GBK".into();
        s.editor.code_style.line_separator = "crlf".into();
        let d = FileDefaults::from_settings(&s, Some(Path::new("/p")));
        assert!(d.utf8_bom);
        assert_eq!(d.line_ending, LineEnding::CrLf);
        assert_eq!(d.fallback_for(Path::new("/p/a.txt")), Some("gbk"));
        assert_eq!(d.fallback_for(Path::new("/elsewhere/a.txt")), None);
        assert_eq!(d.fallback_for(Path::new("/p/a.properties")), Some("iso-8859-1"));
        assert!(d.new_file_bytes().is_empty(), "BOM only for UTF-8 new files");
    }

    #[test]
    fn pom_encoding_of_the_innermost_module_wins_over_the_project_encoding() {
        let mut s = Settings::default();
        s.editor.encodings.project = "gbk".into();
        let mut d = FileDefaults::from_settings(&s, Some(Path::new("/p")));
        d.pom_encodings = vec![
            (PathBuf::from("/p/legacy"), "iso-8859-15".into()),
            (PathBuf::from("/p/legacy/modern"), "utf-8".into()),
            (PathBuf::from("/elsewhere/linked"), "windows-1252".into()),
        ];
        assert_eq!(d.fallback_for(Path::new("/p/legacy/src/main/java/A.java")), Some("iso-8859-15"));
        assert_eq!(d.fallback_for(Path::new("/p/legacy/pom.xml")), Some("iso-8859-15"));
        // UTF-8 in the POM is a choice too: the project encoding does not apply.
        assert_eq!(d.fallback_for(Path::new("/p/legacy/modern/src/A.java")), None);
        assert_eq!(d.fallback_for(Path::new("/p/legacy-notes/A.java")), Some("gbk"), "a sibling, not a child");
        assert_eq!(d.fallback_for(Path::new("/p/other/A.java")), Some("gbk"));
        assert_eq!(d.fallback_for(Path::new("/elsewhere/linked/src/A.java")), Some("windows-1252"));
        assert_eq!(d.fallback_for(Path::new("/elsewhere/A.java")), None);
        assert_eq!(d.fallback_for(Path::new("/p/legacy/src/main/resources/a.properties")), Some("iso-8859-1"));
    }
}
