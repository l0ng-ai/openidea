//! Fully qualified names for record frames, where the evaluator ignores the
//! file's imports.

use crate::chain::{TYPE_BODIES, TYPE_DECLARATIONS};
use crate::qualify_tables::{JAVA_LANG, JAVA_UTIL, JAVA_UTIL_FUNCTION, JAVA_UTIL_STREAM};
use ide_syntax::SyntaxTree;
use tree_sitter::Node;

pub(crate) struct FileImports {
    package: Option<String>,
    /// `import a.b.C;` as `a.b.C`.
    single: Vec<String>,
    /// `import a.b.*;` as `a.b`.
    wildcard: Vec<String>,
    /// Types the file declares, as their path inside the package (`Outer.Inner`), outermost first.
    local_types: Vec<String>,
}

impl FileImports {
    pub(crate) fn of(t: &SyntaxTree) -> Self {
        let root = t.tree.root_node();
        let mut file = FileImports { package: None, single: vec![], wildcard: vec![], local_types: vec![] };
        let mut cursor = root.walk();
        for n in root.named_children(&mut cursor) {
            let mut cursor = n.walk();
            let children: Vec<_> = n.children(&mut cursor).collect();
            let name = children.iter().find(|c| matches!(c.kind(), "scoped_identifier" | "identifier"));
            let name = name.map(|c| t.text[c.byte_range()].to_string());
            match n.kind() {
                "package_declaration" => file.package = name,
                // Static imports bring in members, not types.
                "import_declaration" if !children.iter().any(|c| c.kind() == "static") => {
                    let wildcard = children.iter().any(|c| c.kind() == "asterisk");
                    let list = if wildcard { &mut file.wildcard } else { &mut file.single };
                    list.extend(name);
                }
                _ => {}
            }
        }
        local_types(t, root, "", &mut file.local_types);
        file
    }
}

fn local_types(t: &SyntaxTree, parent: Node, prefix: &str, out: &mut Vec<String>) {
    let mut cursor = parent.walk();
    for n in parent.named_children(&mut cursor) {
        if TYPE_DECLARATIONS.contains(&n.kind()) {
            let Some(name) = n.child_by_field_name("name") else { continue };
            let path = format!("{prefix}{}", &t.text[name.byte_range()]);
            if let Some(body) = n.child_by_field_name("body") {
                out.push(path.clone());
                local_types(t, body, &format!("{path}."), out);
            } else {
                out.push(path);
            }
        } else if TYPE_BODIES.contains(&n.kind()) {
            local_types(t, n, prefix, out);
        }
    }
}

/// `None` when nothing the file can see declares `simple`; a `java.lang`
/// type comes back as it is.
///
/// The order only approximates the JLS: same-package types in other files
/// are unknown here, so they do not shadow the wildcard tables and
/// `java.lang`; member types do not shadow single imports; and a file type
/// matches by its last segment, the first such type winning.
pub(crate) fn qualify_type(simple: &str, file: &FileImports) -> Option<String> {
    if let Some(single) = file.single.iter().find(|s| s.rsplit('.').next() == Some(simple)) {
        return Some(single.clone());
    }
    if let Some(path) = file.local_types.iter().find(|p| p.rsplit('.').next() == Some(simple)) {
        return Some(match &file.package {
            Some(package) => format!("{package}.{path}"),
            None => path.clone(),
        });
    }
    if JAVA_LANG.binary_search(&simple).is_ok() {
        return Some(simple.into());
    }
    file.wildcard
        .iter()
        .find(|package| {
            let table = match package.as_str() {
                "java.util" => JAVA_UTIL,
                "java.util.stream" => JAVA_UTIL_STREAM,
                "java.util.function" => JAVA_UTIL_FUNCTION,
                _ => return false,
            };
            table.binary_search(&simple).is_ok()
        })
        .map(|package| format!("{package}.{simple}"))
}

/// `ty` without its type arguments: `List<Integer>[]` is `List[]`.
pub(crate) fn erasure(ty: &str) -> String {
    let mut depth = 0usize;
    let mut out = String::new();
    for c in ty.chars() {
        match c {
            '<' => depth += 1,
            '>' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out.trim().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn erasure_drops_every_type_argument_list() {
        assert_eq!(erasure("Map<String, List<Integer>>"), "Map");
        assert_eq!(erasure("List<Integer>[]"), "List[]");
        assert_eq!(erasure("java.util.Map.Entry<K, V>"), "java.util.Map.Entry");
        assert_eq!(erasure("ArrayList<>"), "ArrayList");
    }

    #[test]
    fn tables_are_sorted_for_binary_search() {
        for table in [JAVA_LANG, JAVA_UTIL, JAVA_UTIL_STREAM, JAVA_UTIL_FUNCTION] {
            assert!(table.windows(2).all(|w| w[0] < w[1]), "{:?}", table.windows(2).find(|w| w[0] >= w[1]));
        }
    }

    #[test]
    fn single_imports_win_then_local_types_then_java_lang_then_wildcards() {
        let file = FileImports {
            package: Some("demo".into()),
            single: vec!["com.acme.List".into()],
            wildcard: vec!["com.acme".into(), "java.util".into()],
            local_types: vec!["Point".into(), "Point.String".into()],
        };
        assert_eq!(qualify_type("List", &file).as_deref(), Some("com.acme.List"));
        assert_eq!(qualify_type("String", &file).as_deref(), Some("demo.Point.String"));
        assert_eq!(qualify_type("Integer", &file).as_deref(), Some("Integer"));
        assert_eq!(qualify_type("Map", &file).as_deref(), Some("java.util.Map"));
        assert_eq!(qualify_type("Foo", &file), None);
        let unnamed = FileImports { package: None, ..file };
        assert_eq!(qualify_type("Point", &unnamed).as_deref(), Some("Point"));
    }
}
