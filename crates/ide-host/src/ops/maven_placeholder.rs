//! ⌘B on a Maven resource-filtering placeholder: `@property@` in a YAML or properties
//! resource (Spring's `application.yml` / `application.properties`) jumps to the `<properties>` entry that defines it,
//! in the nearest `pom.xml` above the file, up through the project root. Parent
//! poms the nearest pom declares itself are followed from there; a parent outside
//! that walk that no pom declares is not.

use super::doc::blocking;
use crate::Host;
use ide_build::maven;
use ide_core::{DocId, Location, Pos};
use std::path::Path;

/// The definition location of the placeholder under `pos` in `doc`, when `doc` is a
/// YAML or properties file holding a `@token@` there and a pom above it defines that property.
pub(crate) async fn definition(host: &Host, window: &str, doc: DocId, pos: Pos) -> Option<Location> {
    let project = host.project(window).ok()?;
    blocking(move || {
        let snap = project.documents.text_snapshot(doc)?;
        if snap.large || !matches!(snap.language.as_str(), "yaml" | "properties") {
            return Ok(None);
        }
        let path = project.documents.identity(doc)?.0;
        let Some((name, _token_at)) = placeholder_at(&snap.text, pos) else { return Ok(None) };
        Ok(pom_defining(&project.root, &path, &name))
    })
    .await
    .ok()
    .flatten()
}

/// The `@token@` enclosing `pos` on its line, with the token's range (UTF-16 columns).
fn placeholder_at(text: &str, pos: Pos) -> Option<(String, ide_core::Range)> {
    let line = text.split_inclusive('\n').nth(pos.line as usize)?;
    let line = line.trim_end_matches(['\n', '\r']);
    let cursor = utf16_to_byte(line, pos.col)?;
    let mut opener: Option<usize> = None;
    for (i, b) in line.as_bytes().iter().enumerate() {
        if *b != b'@' {
            continue;
        }
        if let Some(start) = opener.replace(i) {
            let token = &line[start + 1..i];
            let valid =
                !token.is_empty() && token.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
            if valid && start <= cursor && cursor <= i {
                let col = |byte: usize| line[..byte].encode_utf16().count() as u32;
                return Some((
                    token.to_owned(),
                    ide_core::Range::new(Pos::new(pos.line, col(start)), Pos::new(pos.line, col(i + 1))),
                ));
            }
            opener = None;
        }
    }
    None
}

/// The nearest `pom.xml` above `from` (up to and including `root`) defining `name`.
fn pom_defining(root: &Path, from: &Path, name: &str) -> Option<Location> {
    let mut dir = from.parent()?.to_path_buf();
    loop {
        let pom = dir.join("pom.xml");
        if pom.is_file()
            && let Some(found) = maven::property_declaration(&pom, name, maven::default_local_repo())
        {
            return Some(Location::file(found.path, found.range));
        }
        if dir == root || !dir.starts_with(root) {
            return None;
        }
        dir = dir.parent()?.to_path_buf();
    }
}

/// UTF-16 column → byte offset within one line.
fn utf16_to_byte(line: &str, col: u32) -> Option<usize> {
    let col = col as usize;
    let mut units = 0usize;
    for (byte, c) in line.char_indices() {
        if units == col {
            return Some(byte);
        }
        units += c.len_utf16();
        if units > col {
            return None;
        }
    }
    (units == col).then_some(line.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_core::Pos;

    fn at(line: u32, col: u32) -> Pos {
        Pos::new(line, col)
    }

    #[test]
    fn finds_the_placeholder_under_the_cursor_and_its_range() {
        let text = "spring:\n  profiles:\n    active: @profileActive@\n";
        let (name, range) = placeholder_at(text, at(2, 20)).unwrap();
        assert_eq!(name, "profileActive");
        assert_eq!(range.start, at(2, 12));
        assert_eq!(range.end, at(2, 27));
        // The `@`s themselves and inside the token navigate; just past the token does not.
        for col in [12u32, 13, 26] {
            assert_eq!(placeholder_at(text, at(2, col)).unwrap().0, "profileActive");
        }
        // A second pair on the line and unrelated cursors stay unresolved.
        let multi = "a: @one@ @two@\n";
        assert_eq!(placeholder_at(multi, at(0, 4)).unwrap().0, "one");
        assert_eq!(placeholder_at(multi, at(0, 10)).unwrap().0, "two");
        assert!(placeholder_at(multi, at(0, 8)).is_none(), "between the pairs");
        assert!(placeholder_at(multi, at(0, 9)).is_some(), "the opening @ of the next pair");
        assert!(placeholder_at(multi, at(0, 14)).is_none(), "just past the last pair");
        assert!(placeholder_at("value: plain\n", at(0, 7)).is_none());
    }

    #[test]
    fn the_nearest_pom_wins_and_the_walk_stops_at_the_project_root() {
        let tmp = tempfile::tempdir().unwrap();
        let base = dunce::canonicalize(tmp.path()).unwrap();
        let root = base.join("project");
        let deep = root.join("core/src/main/resources");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(
            root.join("pom.xml"),
            "<project>\n  <properties>\n    <parentName>parent</parentName>\n  </properties>\n</project>\n",
        )
        .unwrap();
        std::fs::create_dir_all(root.join("core")).unwrap();
        std::fs::write(
            root.join("core/pom.xml"),
            "<project>\n  <properties>\n    <name>module</name>\n  </properties>\n</project>\n",
        )
        .unwrap();
        let from = deep.join("application.yml");
        // The module pom defines `name` first: its file wins, pointing at its `<name>` entry.
        let found = pom_defining(&root, &from, "name").unwrap();
        assert_eq!(found.path, root.join("core/pom.xml"));
        assert_eq!(found.range.start.line, 2);
        // A property only the parent defines resolves there; unknown ones resolve nowhere.
        let parent = pom_defining(&root, &from, "parentName").unwrap();
        assert_eq!(parent.path, root.join("pom.xml"));
        assert_eq!(parent.range.start.line, 2);
        assert!(pom_defining(&root, &from, "missing").is_none());
        // A file outside the project root has no pom walk.
        let outside = tmp.path().join("elsewhere/application.yml");
        std::fs::create_dir_all(tmp.path().join("elsewhere")).unwrap();
        assert!(pom_defining(&root, &outside, "name").is_none());
    }
}
