//! Settings › Editor › File Encodings / Code Style defaults applied by the
//! document layer: encoding, BOM and line separator of new (empty) files, the
//! fallback decoding of files that are not valid UTF-8, and EditorConfig support.

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
    /// Fallback for project files that are not valid UTF-8.
    pub project_fallback: String,
    /// Fallback for files outside `root`.
    pub global_fallback: String,
    pub properties_fallback: String,
    pub native_to_ascii: bool,
    pub editorconfig: bool,
    pub root: Option<PathBuf>,
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
        }
    }

    /// Encoding to decode `path` with when it is not valid UTF-8 (`None`: detect).
    pub fn fallback_for(&self, path: &Path) -> Option<&str> {
        let label = if path.extension().is_some_and(|e| e == "properties") {
            &self.properties_fallback
        } else if self.root.as_ref().is_none_or(|r| path.starts_with(r)) {
            &self.project_fallback
        } else {
            &self.global_fallback
        };
        (label != "utf-8").then_some(label.as_str())
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
}
