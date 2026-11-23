//! Maven's `project.build.sourceEncoding`, handed to the document layer as the encoding
//! of each module's `src` folder.
use ide_build::BuildModel;
use std::path::{Path, PathBuf};

/// `src` folder and WHATWG label of every Maven project of `model` that names a source
/// encoding the editor can apply. The module folder itself is left out: its `pom.xml`
/// declares its own encoding, and `target` is not source.
pub(super) fn pom_encodings(root: &Path, model: &BuildModel) -> Vec<(PathBuf, String)> {
    let projects = model.maven.iter().flat_map(|m| &m.projects);
    projects
        .filter_map(|p| {
            let name = p.source_encoding.as_deref()?;
            let Some(label) = whatwg_label(name) else {
                tracing::info!("{}: project.build.sourceEncoding {name:?} is not applied to its sources", p.pom);
                return None;
            };
            Some((root.join(&p.dir).join("src"), label))
        })
        .collect()
}

/// A POM spells a Java charset name (`ISO-8859-15`, `Cp1252`, `ISO8859_15`). `None` for one
/// without a codec here, or in which ASCII text is not the same bytes (UTF-16).
fn whatwg_label(java_name: &str) -> Option<String> {
    let name = java_name.trim().to_ascii_lowercase();
    let encoding = encoding_rs::Encoding::for_label(name.as_bytes())
        .or_else(|| encoding_rs::Encoding::for_label(name.replace('_', "-").as_bytes()))?;
    encoding.is_ascii_compatible().then(|| encoding.name().to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn java_charset_names_become_whatwg_labels() {
        for (java, label) in [
            ("ISO-8859-15", Some("iso-8859-15")),
            ("ISO8859_15", Some("iso-8859-15")),
            ("iso-8859-15", Some("iso-8859-15")),
            ("Cp1252", Some("windows-1252")),
            ("windows-1252", Some("windows-1252")),
            // WHATWG decodes ISO-8859-1 as its superset.
            ("ISO-8859-1", Some("windows-1252")),
            ("ISO8859_1", Some("windows-1252")),
            ("UTF-8", Some("utf-8")),
            ("UTF8", Some("utf-8")),
            (" GBK ", Some("gbk")),
            ("EUC_JP", Some("euc-jp")),
            ("MS932", Some("shift_jis")),
            ("UTF-16", None),
            ("Cp850", None),
            ("", None),
            ("X-NO-SUCH-CHARSET", None),
        ] {
            assert_eq!(whatwg_label(java).as_deref(), label, "{java}");
        }
    }
}
