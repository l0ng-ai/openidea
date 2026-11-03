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
                if let Some(paren) = stmt.find('(') {
                    let before = stmt[..paren].trim_end();
                    let name_start = before.rfind(|c: char| !ident(c)).map_or(0, |p| p + 1);
                    let method = &before[name_start..];
                    if !method.is_empty() && !before.contains(" default ") {
                        let s = stmt_start + name_start;
                        let params = stmt[paren + 1..stmt.rfind(')').unwrap_or(stmt.len())]
                            .split(',')
                            .filter_map(|p| {
                                // `@Param("id") long id` → the @Param name wins.
                                if let Some(q) = p.find("@Param(\"") {
                                    return p[q + 8..].split('"').next().map(str::to_owned);
                                }
                                p.split_whitespace().last().map(|n| n.trim_matches(|c: char| !ident(c)).to_owned())
                            })
                            .filter(|n| !n.is_empty())
                            .collect();
                        methods.push((
                            Named { name: method.to_owned(), range: range_of(text, s, s + method.len()) },
                            params,
                        ));
                    }
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

    fn setup() -> MockHost {
        let host = MockHost::install();
        host.add_file("src/main/java/com/acme/UserMapper.java", JAVA);
        host.add_file("src/main/resources/mapper/UserMapper.xml", XML);
        host.add_file("pom.xml", "<project/>");
        host
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
