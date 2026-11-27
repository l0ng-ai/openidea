//! Settings › Editor › File Encodings / Code Style defaults applied by the
//! document layer: encoding, BOM and line separator of new (empty) files, the
//! encoding of files that are not valid UTF-8 or are plain ASCII, and EditorConfig support.

use ide_core::settings::Settings;
use ide_text::LineEnding;
use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

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
    /// File Encodings mappings: a file's or a folder's path with its encoding. An entry
    /// naming the file itself is the user's choice for it; one naming a folder above it
    /// covers the files inside.
    pub mappings: Vec<(PathBuf, String)>,
}

/// Where the encoding configured for a file comes from, strongest first.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EncodingSource {
    File,
    Properties,
    Folder,
    Project,
    Global,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConfiguredEncoding<'a> {
    pub label: &'a str,
    pub source: EncodingSource,
}

impl<'a> ConfiguredEncoding<'a> {
    /// The label for files that are not valid UTF-8 or are plain ASCII (`None`: detect).
    pub fn fallback(self) -> Option<ide_vfs::Fallback<'a>> {
        (self.label != "utf-8")
            .then_some(ide_vfs::Fallback { encoding: self.label, ascii: self.source != EncodingSource::Properties })
    }
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
            mappings: root.map(|root| mappings(root, &enc.mappings)).unwrap_or_default(),
        }
    }

    /// The encoding the settings give `path`: the one chosen for the file itself, else the
    /// one it [inherits](Self::inherited_encoding_for).
    pub fn configured_encoding_for(&self, path: &Path) -> ConfiguredEncoding<'_> {
        match self.mappings.iter().find(|(mapped, _)| path == mapped) {
            Some((_, label)) => ConfiguredEncoding { label, source: EncodingSource::File },
            None => self.inherited_encoding_for(path),
        }
    }

    /// The encoding of `path` without a choice for the file itself: the `.properties`
    /// default, the nearest mapped folder above it, then the project's or the global one.
    pub fn inherited_encoding_for(&self, path: &Path) -> ConfiguredEncoding<'_> {
        let folder = || {
            let above = self.mappings.iter().filter(|(mapped, _)| path != mapped && path.starts_with(mapped));
            above.max_by_key(|(mapped, _)| mapped.components().count())
        };
        if path.extension().is_some_and(|e| e == "properties") {
            ConfiguredEncoding { label: &self.properties_fallback, source: EncodingSource::Properties }
        } else if let Some((_, label)) = folder() {
            ConfiguredEncoding { label, source: EncodingSource::Folder }
        } else {
            self.project_encoding_for(path)
        }
    }

    /// The project's encoding for a file inside it, the global one for any other.
    pub fn project_encoding_for(&self, path: &Path) -> ConfiguredEncoding<'_> {
        if self.root.as_ref().is_none_or(|r| path.starts_with(r)) {
            ConfiguredEncoding { label: &self.project_fallback, source: EncodingSource::Project }
        } else {
            ConfiguredEncoding { label: &self.global_fallback, source: EncodingSource::Global }
        }
    }

    /// Encoding for `path` when it is not valid UTF-8 or is plain ASCII (`None`: detect).
    pub fn fallback_for(&self, path: &Path) -> Option<ide_vfs::Fallback<'_>> {
        self.configured_encoding_for(path).fallback()
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

/// The `[editor.encodings.mappings]` key of `path`: its path inside the project `root`,
/// with `/` separators. `None` for anything else.
pub fn mapping_key(root: &Path, path: &Path) -> Option<String> {
    let segments: Option<Vec<&str>> = path
        .strip_prefix(root)
        .ok()?
        .components()
        .map(|c| match c {
            Component::Normal(name) => name.to_str(),
            _ => None,
        })
        .collect();
    segments.filter(|s| !s.is_empty()).map(|s| s.join("/"))
}

/// The mapped paths under `root`. An entry whose key is not such a path, or whose value is
/// not an encoding label, is left out.
fn mappings(root: &Path, entries: &BTreeMap<String, String>) -> Vec<(PathBuf, String)> {
    let path_of = |key: &str| {
        let mut path = root.to_path_buf();
        for segment in key.strip_suffix('/').unwrap_or(key).split('/') {
            let mut components = Path::new(segment).components();
            let plain = matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none();
            if !plain || segment.contains('\\') {
                return None;
            }
            path.push(segment);
        }
        Some(path)
    };
    let mapping = |(key, label): (&String, &String)| {
        let label = normalize(label);
        match (path_of(key), ide_vfs::encode("", &label, false)) {
            (Some(path), Ok(_)) => Some((path, label)),
            _ => {
                tracing::warn!("ignoring the encoding mapping {key:?} = {label:?}");
                None
            }
        }
    };
    entries.iter().filter_map(mapping).collect()
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
        let fallback = |encoding, ascii| Some(ide_vfs::Fallback { encoding, ascii });
        assert_eq!(d.fallback_for(Path::new("/p/a.txt")), fallback("gbk", true));
        assert_eq!(d.fallback_for(Path::new("/elsewhere/a.txt")), None);
        assert_eq!(d.fallback_for(Path::new("/p/a.properties")), fallback("iso-8859-1", false));
        assert!(d.new_file_bytes().is_empty(), "BOM only for UTF-8 new files");
    }

    fn mapped(entries: &[(&str, &str)], root: &Path) -> FileDefaults {
        let mut s = Settings::default();
        s.editor.encodings.project = "gbk".into();
        s.editor.encodings.mappings = entries.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect();
        FileDefaults::from_settings(&s, Some(root))
    }

    #[test]
    fn encoding_mappings_resolve_a_file_before_its_folders_and_the_project() {
        let root = Path::new("/p");
        let d = mapped(
            &[
                ("src", "ISO-8859-15"),
                ("src/legacy", "koi8-r"),
                ("src/legacy/A.java", "windows-1252"),
                ("src/utf", "utf-8"),
                ("src/app.properties", "big5"),
            ],
            root,
        );
        let fallback = |rel: &str| d.fallback_for(&root.join(rel));
        assert_eq!(fallback("src/legacy/A.java"), Some(ide_vfs::Fallback { encoding: "windows-1252", ascii: true }));
        assert_eq!(
            fallback("src/legacy/B.java"),
            Some(ide_vfs::Fallback { encoding: "koi8-r", ascii: true }),
            "the longest folder wins"
        );
        assert_eq!(fallback("src/main/C.java"), Some(ide_vfs::Fallback { encoding: "iso-8859-15", ascii: true }));
        assert_eq!(
            fallback("srcs/C.java"),
            Some(ide_vfs::Fallback { encoding: "gbk", ascii: true }),
            "a folder is matched by whole path segments"
        );
        assert_eq!(fallback("other/C.java"), Some(ide_vfs::Fallback { encoding: "gbk", ascii: true }));
        assert_eq!(fallback("src/utf/D.java"), None, "a UTF-8 mapping does not fall through to the project");
        // `.properties` keep their own default inside a mapped folder; only their own entry overrides it.
        assert_eq!(
            fallback("src/legacy/b.properties"),
            Some(ide_vfs::Fallback { encoding: "iso-8859-1", ascii: false })
        );
        assert_eq!(fallback("src/app.properties"), Some(ide_vfs::Fallback { encoding: "big5", ascii: true }));
        assert_eq!(d.fallback_for(Path::new("/elsewhere/src/C.java")), None);

        let source = |rel: &str| d.configured_encoding_for(&root.join(rel)).source;
        assert_eq!(source("src/legacy/A.java"), EncodingSource::File);
        assert_eq!(source("src/legacy/B.java"), EncodingSource::Folder);
        assert_eq!(source("src/legacy/b.properties"), EncodingSource::Properties);
        assert_eq!(source("other/C.java"), EncodingSource::Project);
        assert_eq!(d.configured_encoding_for(Path::new("/elsewhere/C.java")).source, EncodingSource::Global);
    }

    #[test]
    fn invalid_encoding_mappings_are_dropped() {
        let root = Path::new("/p");
        let d = mapped(
            &[
                ("ok", "iso-8859-15"),
                ("unknown", "klingon-1"),
                ("", "koi8-r"),
                ("/abs", "koi8-r"),
                ("../up", "koi8-r"),
                ("a/./b", "koi8-r"),
                ("a//b", "koi8-r"),
                ("back\\slash", "koi8-r"),
            ],
            root,
        );
        assert_eq!(d.mappings, [(root.join("ok"), "iso-8859-15".to_owned())]);
        assert_eq!(d.fallback_for(&root.join("up/A.java")), Some(ide_vfs::Fallback { encoding: "gbk", ascii: true }));
        assert!(mapped(&[("ok", "iso-8859-15")], root).mappings.len() == 1);
        // Without a project there is nothing the paths are relative to.
        let mut s = Settings::default();
        s.editor.encodings.mappings.insert("ok".into(), "gbk".into());
        assert!(FileDefaults::from_settings(&s, None).mappings.is_empty());
    }

    #[test]
    fn mapping_key_is_the_path_inside_the_project_with_slashes() {
        let root = Path::new("/p");
        assert_eq!(mapping_key(root, &root.join("src").join("a.b").join("A.java")).as_deref(), Some("src/a.b/A.java"));
        assert_eq!(mapping_key(root, Path::new("/elsewhere/A.java")), None);
        assert_eq!(mapping_key(root, root), None);
        assert_eq!(mapping_key(root, Path::new("untitled:Untitled-1")), None);
        let d = mapped(&[("src/a.b/A.java", "koi8-r")], root);
        assert_eq!(
            d.fallback_for(&root.join("src/a.b/A.java")),
            Some(ide_vfs::Fallback { encoding: "koi8-r", ascii: true })
        );
    }

    #[test]
    fn nothing_mapped_resolves_as_before() {
        let d = FileDefaults::from_settings(&Settings::default(), Some(Path::new("/p")));
        assert!(d.mappings.is_empty());
        assert_eq!(d.fallback_for(Path::new("/p/src/A.java")), None);
        assert_eq!(
            d.fallback_for(Path::new("/p/a.properties")),
            Some(ide_vfs::Fallback { encoding: "iso-8859-1", ascii: false })
        );
        assert_eq!(d.configured_encoding_for(Path::new("/p/src/A.java")).label, "utf-8");
    }
}
