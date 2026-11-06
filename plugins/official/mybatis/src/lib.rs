//! MyBatis Navigator for OpenIDEA: a mapper interface (`com.acme.UserMapper`)
//! and the XML with `<mapper namespace="com.acme.UserMapper">` point at each
//! other: gutter arrows and Go to Definition on methods and statement ids,
//! completion of statement ids and `#{parameters}`.

use openidea_plugin::providers::{CompletionItem, CompletionKind, Document, LineMarker, Providers};
use openidea_plugin::text::{offset, position};
use openidea_plugin::{Error, Invocation, Location, Plugin, Position, Project, Range, host, register_plugin};
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

/// How long the namespace → XML file index is trusted.
const INDEX_TTL: Duration = Duration::from_secs(30);
const MAX_XML: u32 = 5000;
const STATEMENTS: [&str; 4] = ["select", "insert", "update", "delete"];

/// A named thing and where its name is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Named {
    pub name: String,
    pub range: Range,
}

/// A mapper XML file.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MapperXml {
    pub namespace: Option<String>,
    /// `<select|insert|update|delete id="…">` (the id value's range).
    pub statements: Vec<Named>,
}

/// A Java interface.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MapperJava {
    /// Fully qualified name.
    pub name: Option<String>,
    pub methods: Vec<(Named, Vec<String>)>,
}

fn range_of(text: &str, start: usize, end: usize) -> Range {
    Range::new(position(text, start), position(text, end))
}

pub fn parse_xml(text: &str) -> MapperXml {
    let mut out = MapperXml::default();
    let attr = |tag_start: usize, name: &str| -> Option<(String, usize, usize)> {
        let tag_end = text[tag_start..].find('>').map_or(text.len(), |i| tag_start + i);
        let tag = &text[tag_start..tag_end];
        let i = tag.find(&format!("{name}=\""))? + name.len() + 2;
        let j = tag[i..].find('"')? + i;
        Some((tag[i..j].to_owned(), tag_start + i, tag_start + j))
    };
    let mut at = 0;
    while let Some(i) = text[at..].find('<') {
        let start = at + i + 1;
        at = start;
        let name: String = text[start..].chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
        if name == "mapper" {
            out.namespace = attr(start, "namespace").map(|(v, ..)| v);
        } else if STATEMENTS.contains(&name.as_str())
            && let Some((id, s, e)) = attr(start, "id")
        {
            out.statements.push(Named { name: id, range: range_of(text, s, e) });
        }
    }
    out
}

fn ident(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '$'
}

/// The index just past the string or char literal opening at `bytes[i]`.
fn skip_string(bytes: &[u8], mut i: usize) -> usize {
    let quote = bytes[i];
    i += 1;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            b if b == quote => return i + 1,
            _ => i += 1,
        }
    }
    i
}

/// The index just past the `//…` or `/*…*/` comment opening at `bytes[i]`.
fn skip_comment(bytes: &[u8], mut i: usize) -> usize {
    if bytes.get(i + 1) == Some(&b'/') {
        bytes[i + 2..].iter().position(|&b| b == b'\n').map_or(bytes.len(), |n| i + 2 + n)
    } else {
        i += 2;
        while i + 1 < bytes.len() && (bytes[i] != b'*' || bytes[i + 1] != b'/') {
            i += 1;
        }
        (i + 2).min(bytes.len())
    }
}

/// A method declaration in a fragment of an interface's body: the name's byte
/// range and its parameter list's `(` and `)` (offsets in the fragment).
#[derive(Debug, PartialEq, Eq)]
struct Declaration {
    name: (usize, usize),
    parens: (usize, usize),
}

/// The method declaration in `stmt`, skipping comments, strings and annotations
/// on the way: an annotation's arguments nest parentheses and may hold strings
/// and comments, so the name is the identifier before the first `(` left over —
/// `@Select("…") User find(…)` names `find`, not `Select`. Anything past that
/// `(` (where `@Param(…)` lives) only matters for its matching `)`, so it never
/// confuses the scan.
fn scan_declaration(stmt: &str) -> Option<Declaration> {
    let bytes = stmt.as_bytes();
    let mut i = 0;
    let mut nested = 0usize; // paren depth inside an annotation's arguments
    while i < bytes.len() {
        match bytes[i] {
            b' ' | b'\t' | b'\r' | b'\n' => i += 1,
            b'/' if matches!(bytes.get(i + 1), Some(b'/' | b'*')) => i = skip_comment(bytes, i),
            b'"' | b'\'' => i = skip_string(bytes, i),
            b'@' if nested == 0 => {
                // The annotation's qualified name, then (optionally) its arguments.
                i += 1;
                while i < bytes.len() && (ident(bytes[i] as char) || bytes[i] == b'.') {
                    i += 1;
                }
                let mut j = i;
                while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                    j += 1;
                }
                if bytes.get(j) == Some(&b'(') {
                    nested = 1;
                    i = j + 1;
                }
            }
            b'(' if nested > 0 => {
                nested += 1;
                i += 1;
            }
            b')' if nested > 0 => {
                nested -= 1;
                i += 1;
            }
            b'(' => {
                let before = stmt[..i].trim_end();
                let start = before.rfind(|c: char| !ident(c)).map_or(0, |p| p + 1);
                if start == before.len() {
                    return None;
                }
                // The matching `)`, minding strings and nested parens.
                let (mut close, mut depth) = (i + 1, 1usize);
                while close < bytes.len() {
                    match bytes[close] {
                        b'"' | b'\'' => close = skip_string(bytes, close),
                        b'/' if matches!(bytes.get(close + 1), Some(b'/' | b'*')) => close = skip_comment(bytes, close),
                        b'(' => {
                            depth += 1;
                            close += 1;
                        }
                        b')' => {
                            depth -= 1;
                            if depth == 0 {
                                return Some(Declaration { name: (start, before.len()), parens: (i, close) });
                            }
                            close += 1;
                        }
                        _ => close += 1,
                    }
                }
                return None; // an unterminated parameter list is no declaration
            }
            _ => i += 1,
        }
    }
    None
}

/// The parameter names in a declaration's parameter list: `@Param("…")` wins,
/// otherwise the parameter's last identifier. Split at commas outside nested
/// parens, braces, brackets and strings, so `@Size(min = 1, max = 5) String n`
/// stays one parameter and a `@Param("a,b")` keeps its whole name.
fn params_of(list: &str) -> Vec<String> {
    let bytes = list.as_bytes();
    let mut parts = Vec::new();
    let (mut depth, mut start) = (0usize, 0usize);
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'"' | b'\'' => i = skip_string(bytes, i),
            b'/' if matches!(bytes.get(i + 1), Some(b'/' | b'*')) => i = skip_comment(bytes, i),
            b'(' | b'{' | b'[' => {
                depth += 1;
                i += 1;
            }
            b')' | b'}' | b']' => {
                depth = depth.saturating_sub(1);
                i += 1;
            }
            b',' if depth == 0 => {
                parts.push(&list[start..i]);
                start = i + 1;
                i += 1;
            }
            _ => i += 1,
        }
    }
    parts.push(&list[start..]);
    parts
        .into_iter()
        .filter_map(|p| {
            // `@Param("id") long id` → the @Param name wins.
            if let Some(q) = p.find("@Param(\"") {
                return p[q + 8..].split('"').next().map(str::to_owned);
            }
            p.split_whitespace().last().map(|n| n.trim_matches(|c: char| !ident(c)).to_owned())
        })
        .filter(|n| !n.is_empty())
        .collect()
}

/// The interface's name and methods (with their parameter names).
pub fn parse_java(text: &str) -> MapperJava {
    let package =
        text.lines().find_map(|l| l.trim().strip_prefix("package ").map(|p| p.trim_end_matches(';').trim().to_owned()));
    let Some(i) = text.find("interface ") else { return MapperJava::default() };
    let simple: String = text[i + 10..].trim_start().chars().take_while(|c| ident(*c)).collect();
    let name = Some(match package {
        Some(p) => format!("{p}.{simple}"),
        None => simple,
    });
    let body_start = text[i..].find('{').map_or(text.len(), |b| i + b + 1);
    let mut methods = Vec::new();
    let mut depth = 0;
    let mut stmt_start = body_start;
    let bytes: Vec<(usize, char)> = text[body_start..].char_indices().map(|(k, c)| (body_start + k, c)).collect();
    for (k, c) in bytes {
        match c {
            '{' => depth += 1,
            '}' if depth == 0 => break,
            '}' => {
                depth -= 1;
                stmt_start = k + 1;
            }
            ';' if depth == 0 => {
                let stmt = &text[stmt_start..k];
                if let Some(decl) = scan_declaration(stmt)
                    && !stmt[..decl.parens.0].contains(" default ")
                {
                    let (s, e) = (stmt_start + decl.name.0, stmt_start + decl.name.1);
                    methods.push((
                        Named { name: stmt[decl.name.0..decl.name.1].to_owned(), range: range_of(text, s, e) },
                        params_of(&stmt[decl.parens.0 + 1..decl.parens.1]),
                    ));
                }
                stmt_start = k + 1;
            }
            _ => {}
        }
    }
    MapperJava { name, methods }
}

fn project_of(path: &str) -> Option<Project> {
    host::projects()
        .ok()?
        .into_iter()
        .filter(|p| p.root().is_ok_and(|r| path.starts_with(&r)))
        .max_by_key(|p| p.root().map(|r| r.len()).unwrap_or(0))
}

#[derive(Default)]
pub struct Navigator {
    /// project root → (namespace → XML path), with when it was built.
    xml_index: BTreeMap<String, (Instant, BTreeMap<String, String>)>,
}

impl Navigator {
    /// The XML mapping `namespace`, (re)indexing the project when needed.
    fn xml_for(&mut self, project: &Project, namespace: &str) -> Option<(String, MapperXml)> {
        let root = project.root().ok()?;
        for attempt in 0..2 {
            let fresh = self.xml_index.get(&root).is_some_and(|(at, _)| at.elapsed() < INDEX_TTL);
            if !fresh || attempt == 1 {
                let mut map = BTreeMap::new();
                for path in project.find_files("**/*.xml", MAX_XML).ok()? {
                    let Ok(text) = project.read_file(&path) else { continue };
                    if !text.contains("<mapper") {
                        continue;
                    }
                    if let Some(ns) = parse_xml(&text).namespace {
                        map.insert(ns, path);
                    }
                }
                self.xml_index.insert(root.clone(), (Instant::now(), map));
            }
            let path = self.xml_index.get(&root).and_then(|(_, m)| m.get(namespace)).cloned();
            if let Some(path) = path
                && let Ok(text) = project.read_file(&path)
            {
                let xml = parse_xml(&text);
                if xml.namespace.as_deref() == Some(namespace) {
                    return Some((path, xml));
                }
            }
            if !fresh {
                break; // just rebuilt
            }
        }
        None
    }

    /// The interface `namespace` names (`com.acme.UserMapper` → `**/com/acme/UserMapper.java`).
    fn java_for(project: &Project, namespace: &str) -> Option<(String, MapperJava)> {
        let rel = format!("**/{}.java", namespace.replace('.', "/"));
        let path = project.find_files(&rel, 1).ok()?.into_iter().next()?;
        let java = parse_java(&project.read_file(&path).ok()?);
        (java.name.as_deref() == Some(namespace)).then_some((path, java))
    }

    /// Pairs of (name in this document, target location) for `doc`.
    fn links(&mut self, doc: &Document) -> Vec<(Named, Location, String)> {
        let Some(project) = project_of(&doc.path) else { return Vec::new() };
        if doc.language == "xml" {
            let xml = parse_xml(&doc.text);
            let Some(ns) = xml.namespace else { return Vec::new() };
            let Some((path, java)) = Self::java_for(&project, &ns) else { return Vec::new() };
            let simple = ns.rsplit('.').next().unwrap_or(&ns).to_owned();
            xml.statements
                .into_iter()
                .filter_map(|s| {
                    let (m, _) = java.methods.iter().find(|(m, _)| m.name == s.name)?;
                    let tip = format!("{simple}.{}()", m.name);
                    Some((s, Location { path: path.clone(), range: m.range }, tip))
                })
                .collect()
        } else {
            let java = parse_java(&doc.text);
            let Some(name) = java.name else { return Vec::new() };
            let Some((path, xml)) = self.xml_for(&project, &name) else { return Vec::new() };
            let file = path.rsplit(['/', '\\']).next().unwrap_or(&path).to_owned();
            java.methods
                .into_iter()
                .filter_map(|(m, _)| {
                    let s = xml.statements.iter().find(|s| s.name == m.name)?;
                    Some((m, Location { path: path.clone(), range: s.range }, format!("{file}: {}", s.name)))
                })
                .collect()
        }
    }
}

fn contains(r: Range, p: Position) -> bool {
    r.start <= p && p <= r.end
}

impl Providers for Navigator {
    fn line_markers(&mut self, doc: &Document) -> Vec<LineMarker> {
        let icon = if doc.language == "xml" { "implementing" } else { "implemented" };
        self.links(doc)
            .into_iter()
            .map(|(n, target, tip)| LineMarker {
                line: n.range.start.line,
                icon: Some(icon.into()),
                tooltip: format!("Go to {tip}"),
                target: Some(target),
            })
            .collect()
    }

    fn definition(&mut self, doc: &Document, at: Position) -> Vec<Location> {
        self.links(doc).into_iter().filter(|(n, ..)| contains(n.range, at)).map(|(_, l, _)| l).collect()
    }

    fn completion(&mut self, doc: &Document, at: Position, _trigger: Option<&str>) -> Vec<CompletionItem> {
        if doc.language != "xml" {
            return Vec::new();
        }
        let Some(cursor) = offset(&doc.text, at) else { return Vec::new() };
        let before = &doc.text[..cursor];
        let xml = parse_xml(&doc.text);
        let Some(ns) = xml.namespace.clone() else { return Vec::new() };
        let Some(project) = project_of(&doc.path) else { return Vec::new() };
        let Some((_, java)) = Self::java_for(&project, &ns) else { return Vec::new() };
        let line_start = before.rfind('\n').map_or(0, |i| i + 1);
        let line = &before[line_start..];
        // Inside `id="…` of a statement tag: the interface's unmapped methods.
        if let Some(i) = line.rfind("id=\"")
            && !line[i + 4..].contains('"')
            && STATEMENTS.iter().any(|t| line.contains(&format!("<{t}")))
        {
            let typed = &line[i + 4..];
            let start = Position::new(at.line, at.character - typed.encode_utf16().count() as u32);
            return java
                .methods
                .iter()
                .filter(|(m, _)| m.name.starts_with(typed) && !xml.statements.iter().any(|s| s.name == m.name))
                .map(|(m, _)| CompletionItem {
                    replace: Some(Range::new(start, at)),
                    detail: Some(ns.rsplit('.').next().unwrap_or(&ns).into()),
                    ..CompletionItem::new(&m.name, CompletionKind::Method)
                })
                .collect();
        }
        // After `#{`: the enclosing statement's parameters.
        if let Some(i) = before.rfind("#{")
            && !before[i..].contains('}')
        {
            let typed = &before[i + 2..];
            let statement =
                xml.statements.iter().rev().find(|s| offset(&doc.text, s.range.start).is_some_and(|o| o < cursor));
            let Some((_, params)) = statement.and_then(|s| java.methods.iter().find(|(m, _)| m.name == s.name)) else {
                return Vec::new();
            };
            let start = Position::new(at.line, at.character - typed.encode_utf16().count() as u32);
            return params
                .iter()
                .filter(|p| p.starts_with(typed))
                .map(|p| CompletionItem {
                    replace: Some(Range::new(start, at)),
                    ..CompletionItem::new(p, CompletionKind::Variable)
                })
                .collect();
        }
        Vec::new()
    }
}

impl Plugin for Navigator {
    fn run_command(&mut self, id: &str, _ctx: &Invocation, _arg: Option<&str>) -> Result<Option<String>, Error> {
        Err(Error::NotFound(format!("command {id}")))
    }
}

register_plugin!(Navigator, providers);

#[cfg(test)]
mod tests {
    use super::*;
    use openidea_plugin::mock::MockHost;

    const JAVA: &str = "package com.acme;\n\nimport org.apache.ibatis.annotations.Param;\n\npublic interface UserMapper {\n    User findById(@Param(\"id\") long id);\n\n    int insert(User user);\n\n    default void helper() {}\n\n    List<User> search(String name, int limit);\n}\n";
    const XML: &str = "<?xml version=\"1.0\"?>\n<mapper namespace=\"com.acme.UserMapper\">\n  <select id=\"findById\" resultType=\"User\">\n    select * from users where id = #{id}\n  </select>\n  <insert id=\"insert\">\n    insert into users values (#{user})\n  </insert>\n  <select id=\"\">\n  </select>\n</mapper>\n";

    #[test]
    fn parses_both_sides() {
        let java = parse_java(JAVA);
        assert_eq!(java.name.as_deref(), Some("com.acme.UserMapper"));
        let names: Vec<_> = java.methods.iter().map(|(m, p)| (m.name.as_str(), p.clone())).collect();
        assert_eq!(
            names,
            [
                ("findById", vec!["id".to_owned()]),
                ("insert", vec!["user".into()]),
                ("search", vec!["name".into(), "limit".into()])
            ]
        );
        assert_eq!(java.methods[0].0.range, Range::new(Position::new(5, 9), Position::new(5, 17)));
        let xml = parse_xml(XML);
        assert_eq!(xml.namespace.as_deref(), Some("com.acme.UserMapper"));
        assert_eq!(xml.statements.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["findById", "insert", ""]);
        assert_eq!(xml.statements[0].range, Range::new(Position::new(2, 14), Position::new(2, 22)));
    }

    const ANNOTATED: &str = concat!(
        "package com.acme;\n\n",
        "import org.apache.ibatis.annotations.Param;\n\n",
        "public interface UserMapper {\n",
        "    @Select(\"SELECT (a, b) FROM users WHERE c = ')' OR d = 'x, y'\")\n",
        "    List<User> selectAnnotated(Long id);\n\n",
        "    @Cacheable(key = @Key(value = \"x(y)\", of = {@Part(\"a)b\"), @Part(\"c,d\")}))\n",
        "    @Override\n",
        "    // a comment (with parens) before the name\n",
        "    User findAnnotated(@Param(\"id\") Long id, @Size(min = 1, max = 5) String name);\n\n",
        "    List<User> selectPlain(Long id);\n",
        "}\n"
    );

    const ANNOTATED_XML: &str = "<?xml version=\"1.0\"?>\n<mapper namespace=\"com.acme.UserMapper\">\n  <select id=\"selectAnnotated\" resultType=\"User\">SELECT (a, b) FROM users</select>\n  <select id=\"findAnnotated\">SELECT 1</select>\n</mapper>\n";

    fn setup() -> MockHost {
        let host = MockHost::install();
        host.add_file("src/main/java/com/acme/UserMapper.java", JAVA);
        host.add_file("src/main/resources/mapper/UserMapper.xml", XML);
        host.add_file("pom.xml", "<project/>");
        host
    }

    fn annotated_setup() -> MockHost {
        let host = MockHost::install();
        host.add_file("src/main/java/com/acme/UserMapper.java", ANNOTATED);
        host.add_file("src/main/resources/mapper/UserMapper.xml", ANNOTATED_XML);
        host.add_file("pom.xml", "<project/>");
        host
    }

    /// Methods behind method-level annotations keep their names, parameters and
    /// positions: the scanner skips comments, strings and annotation arguments
    /// (nested annotations, `(` `)` `{` `}` `,` in strings) before the name.
    #[test]
    fn parses_methods_with_annotations() {
        let java = parse_java(ANNOTATED);
        let names: Vec<_> = java.methods.iter().map(|(m, p)| (m.name.as_str(), p.clone())).collect();
        assert_eq!(
            names,
            [
                ("selectAnnotated", vec!["id".to_owned()]),
                ("findAnnotated", vec!["id".to_owned(), "name".to_owned()],),
                ("selectPlain", vec!["id".to_owned()])
            ],
            "annotation names must not become method names, @Param wins, argument commas must not split a parameter"
        );
        // `    List<User> ` before the name on its line (UTF-16 columns).
        assert_eq!(java.methods[0].0.range, Range::new(Position::new(6, 15), Position::new(6, 30)));
        assert_eq!(java.methods[1].0.range, Range::new(Position::new(11, 9), Position::new(11, 22)));
    }

    /// A multibyte annotation string on the name's line keeps UTF-16 columns:
    /// `中文` is one unit each and `😀` two, while bytes would run ahead.
    #[test]
    fn keeps_utf16_columns_around_multibyte_annotations() {
        let text = "package com.acme;\n\npublic interface UserMapper {\n    @Select(\"中文 😀 注释\") List<User> find(Long id);\n}\n";
        let java = parse_java(text);
        assert_eq!(java.methods.len(), 1);
        assert_eq!(java.methods[0].0.name, "find");
        // `"中文 😀 注释"` costs 10 UTF-16 units (😀 two); `find` starts at 4 + 8 + 1 + 10 + 1 + 11 = 35.
        assert_eq!(java.methods[0].0.range, Range::new(Position::new(3, 35), Position::new(3, 39)));
        assert_eq!(java.methods[0].1, ["id".to_owned()]);
    }

    /// Annotated methods still get both directions of navigation.
    #[test]
    fn navigates_annotated_methods() {
        let _host = annotated_setup();
        let mut n = Navigator::default();
        let java = doc("/project/src/main/java/com/acme/UserMapper.java", "java", ANNOTATED);
        let markers = n.line_markers(&java);
        assert_eq!(markers.iter().map(|m| m.line).collect::<Vec<_>>(), [6, 11], "selectPlain has no statement");
        assert_eq!(markers[1].tooltip, "Go to UserMapper.xml: findAnnotated");

        let xml = doc("/project/src/main/resources/mapper/UserMapper.xml", "xml", ANNOTATED_XML);
        let to_java = n.definition(&xml, Position::new(2, 20));
        assert_eq!(to_java.len(), 1);
        assert_eq!(
            (to_java[0].path.ends_with("UserMapper.java"), to_java[0].range.start),
            (true, Position::new(6, 15)),
            "the XML statement jumps back to the annotated method"
        );
    }

    fn doc(path: &str, language: &str, text: &str) -> Document {
        Document { path: path.into(), language: language.into(), version: 1, text: text.into() }
    }

    #[test]
    fn navigates_both_ways() {
        let _host = setup();
        let mut n = Navigator::default();
        let java = doc("/project/src/main/java/com/acme/UserMapper.java", "java", JAVA);
        let markers = n.line_markers(&java);
        assert_eq!(markers.iter().map(|m| m.line).collect::<Vec<_>>(), [5, 7], "search has no statement");
        assert_eq!(markers[0].tooltip, "Go to UserMapper.xml: findById");
        let target = markers[0].target.as_ref().unwrap();
        assert_eq!(
            (target.path.as_str(), target.range.start),
            ("/project/src/main/resources/mapper/UserMapper.xml", Position::new(2, 14))
        );

        let xml = doc("/project/src/main/resources/mapper/UserMapper.xml", "xml", XML);
        let to_java = n.definition(&xml, Position::new(5, 15));
        assert_eq!(to_java.len(), 1);
        assert_eq!((to_java[0].path.ends_with("UserMapper.java"), to_java[0].range.start), (true, Position::new(7, 8)));
        assert!(n.definition(&xml, Position::new(3, 5)).is_empty(), "not on an id");
        assert_eq!(n.line_markers(&xml)[0].tooltip, "Go to UserMapper.findById()");
    }

    #[test]
    fn completes_ids_and_parameters() {
        let _host = setup();
        let mut n = Navigator::default();
        let xml = doc("/project/src/main/resources/mapper/UserMapper.xml", "xml", XML);
        let ids = n.completion(&xml, Position::new(8, 14), None);
        assert_eq!(ids.iter().map(|c| c.label.as_str()).collect::<Vec<_>>(), ["search"], "unmapped methods only");
        let text = XML.replace("#{id}", "#{");
        let xml = doc("/project/src/main/resources/mapper/UserMapper.xml", "xml", &text);
        let params = n.completion(&xml, Position::new(3, 38), None);
        assert_eq!(params.iter().map(|c| c.label.as_str()).collect::<Vec<_>>(), ["id"]);
    }
}
