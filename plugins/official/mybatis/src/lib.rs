//! MyBatis Navigator for OpenIDEA: a mapper interface (`com.acme.UserMapper`)
//! and the XML with `<mapper namespace="com.acme.UserMapper">` point at each
//! other: gutter arrows and Go to Definition on the namespace, methods and
//! statement ids, plus `resultMap` / `extends` / `<include refid>` targets,
//! completion of statement ids, `<sql>` ids and `#{parameters}`.

use openidea_plugin::providers::{CompletionItem, CompletionKind, Document, LineMarker, Providers};
use openidea_plugin::text::{offset, position};
use openidea_plugin::{
    Error, Invocation, Location, Plugin, Position, Project, Range, TextQuery, host, register_plugin,
};
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

/// How long a namespace → XML file lookup is trusted.
const INDEX_TTL: Duration = Duration::from_secs(30);
/// Files declaring one namespace that are tried (normally one).
const MAX_MAPPERS: u32 = 64;
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
    /// `<mapper namespace="…">` (the value's range).
    pub namespace: Option<Named>,
    /// `<select|insert|update|delete id="…">` (the id value's range).
    pub statements: Vec<Named>,
    /// `<resultMap id="…">` (the id value's range).
    pub result_maps: Vec<Named>,
    /// `<sql id="…">` (the id value's range).
    pub sql_fragments: Vec<Named>,
    /// `resultMap="…"` values (on statements, associations, collections…).
    pub result_map_refs: Vec<Named>,
    /// `extends="…"` values on `<resultMap>`.
    pub extends_refs: Vec<Named>,
    /// `<include refid="…">` values.
    pub include_refs: Vec<Named>,
}

/// A method parameter: its effective name (`@Param("…")` wins) and where that
/// name is written (the `@Param("…")` string, or the parameter itself).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Param {
    pub name: String,
    pub range: Range,
}

/// `#{…}` / `${…}` inside one method's `@Select`/`@Insert`/`@Update`/`@Delete`
/// SQL strings: `method` indexes `MapperJava::methods`, `strings` covers the
/// SQL string literals, each `Named` in `params` covers one whole `#{…}` /
/// `${…}` match.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AnnotationSql {
    pub method: usize,
    pub strings: Vec<Range>,
    pub params: Vec<Named>,
}

/// `@ResultMap("…")` on one method: `method` indexes `MapperJava::methods`,
/// `name` covers the id string (quotes excluded).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResultMapRef {
    pub method: usize,
    pub name: Named,
}

/// A Java interface.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MapperJava {
    /// Fully qualified name.
    pub name: Option<String>,
    /// The interface's own name (for `<mapper namespace>` targets).
    pub decl: Option<Named>,
    pub methods: Vec<(Named, Vec<Param>)>,
    pub annotation_sql: Vec<AnnotationSql>,
    pub result_refs: Vec<ResultMapRef>,
    /// `@Results(id = "…")` definitions: method index and the id string.
    pub result_ids: Vec<(usize, Named)>,
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
        let named = |attr_name: &str| -> Option<Named> {
            let (v, s, e) = attr(start, attr_name)?;
            Some(Named { name: v, range: range_of(text, s, e) })
        };
        if name == "mapper" {
            out.namespace = named("namespace");
        } else if STATEMENTS.contains(&name.as_str()) {
            if let Some(id) = named("id") {
                out.statements.push(id);
            }
            if let Some(r) = named("resultMap") {
                out.result_map_refs.push(r);
            }
        } else if name == "resultMap" {
            if let Some(id) = named("id") {
                out.result_maps.push(id);
            }
            if let Some(r) = named("extends") {
                out.extends_refs.push(r);
            }
            if let Some(r) = named("resultMap") {
                // `<association resultMap="…">` and friends nest inside resultMaps.
                out.result_map_refs.push(r);
            }
        } else if name == "association" || name == "collection" || name == "case" {
            if let Some(r) = named("resultMap") {
                out.result_map_refs.push(r);
            }
        } else if name == "sql" {
            if let Some(id) = named("id") {
                out.sql_fragments.push(id);
            }
        } else if name == "include"
            && let Some(r) = named("refid")
        {
            out.include_refs.push(r);
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
            // Java string/char literals cannot span lines; an unterminated
            // quote ends at the newline so one broken line cannot swallow
            // the rest of the file (e.g. `@ResultMap("` while typing).
            b'\n' | b'\r' => return i,
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

/// The trailing identifier in `part` (byte offsets in `part`), or `None`.
/// Char-based so a multibyte identifier never splits a code point.
fn last_ident(part: &str) -> Option<(String, usize, usize)> {
    let chars: Vec<(usize, char)> = part.char_indices().collect();
    let mut end = chars.len();
    while end > 0 && !ident(chars[end - 1].1) {
        end -= 1;
    }
    if end == 0 {
        return None;
    }
    let mut start = end;
    while start > 0 && ident(chars[start - 1].1) {
        start -= 1;
    }
    let (s, _) = chars[start];
    let (e, c) = chars[end - 1];
    Some((part[s..e + c.len_utf8()].to_owned(), s, e + c.len_utf8()))
}

/// The parameter names in a declaration's parameter list, with byte offsets in
/// `list`: `@Param("…")` wins (its string, quotes excluded), otherwise the
/// parameter's last identifier. Split at commas outside nested parens, braces,
/// brackets and strings, so `@Size(min = 1, max = 5) String n` stays one
/// parameter and a `@Param("a,b")` keeps its whole name.
fn params_of(list: &str) -> Vec<(String, usize, usize)> {
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
                parts.push((start, i));
                start = i + 1;
                i += 1;
            }
            _ => i += 1,
        }
    }
    parts.push((start, list.len()));
    parts
        .into_iter()
        .filter_map(|(s, e)| {
            let p = &list[s..e];
            // `@Param("id") long id` → the @Param name wins.
            if let Some(q) = p.find("@Param(\"") {
                let name_start = q + 8;
                let name: String = p[name_start..].chars().take_while(|&c| c != '"').collect();
                if !name.is_empty() {
                    return Some((name.clone(), s + name_start, s + name_start + name.len()));
                }
                return None;
            }
            last_ident(p).map(|(name, ps, pe)| (name, s + ps, s + pe))
        })
        .collect()
}

/// `(name, match start, match end)` of each `#{…}` / `${…}` in SQL text
/// (offsets in `sql`); the name stops at `,`, `}` or whitespace, so
/// `#{id, jdbcType=INTEGER}` names `id`. The match covers the closing `}`
/// when present.
fn sql_params(sql: &str) -> Vec<(String, usize, usize)> {
    let bytes = sql.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if (bytes[i] == b'#' || bytes[i] == b'$') && bytes[i + 1] == b'{' {
            let mut j = i + 2;
            while j < bytes.len() && bytes[j] != b'}' && bytes[j] != b',' && !bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            if j > i + 2 {
                let end = if bytes.get(j) == Some(&b'}') { j + 1 } else { j };
                out.push((sql[i + 2..j].to_owned(), i, end));
            }
            i = j.max(i + 2);
        } else {
            i += 1;
        }
    }
    out
}

const SQL_ANNOTATIONS: [&str; 4] = ["Select", "Insert", "Update", "Delete"];

/// A string literal's value with its byte offsets (quotes excluded).
type LitSpan = (String, usize, usize);

/// Each `@Name(…)` in `head`: the simple annotation name and its arguments'
/// byte range (offsets in `head`), minding nesting, strings and comments.
/// Annotations nested inside another annotation's arguments are only reported
/// when the outer one has no argument list scanned here.
fn annotations_of(head: &str) -> Vec<(String, usize, usize)> {
    let bytes = head.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'"' | b'\'' => i = skip_string(bytes, i),
            b'/' if matches!(bytes.get(i + 1), Some(b'/' | b'*')) => i = skip_comment(bytes, i),
            b'@' => {
                let mut j = i + 1;
                while j < bytes.len() && (ident(bytes[j] as char) || bytes[j] == b'.') {
                    j += 1;
                }
                while !head.is_char_boundary(j) {
                    j -= 1;
                }
                let simple = head[i + 1..j].rsplit('.').next().unwrap_or("").to_owned();
                let mut k = j;
                while k < bytes.len() && bytes[k].is_ascii_whitespace() {
                    k += 1;
                }
                if bytes.get(k) == Some(&b'(') {
                    // The annotation's arguments, minding nesting and strings.
                    let (mut close, mut depth) = (k + 1, 1usize);
                    while close < bytes.len() {
                        match bytes[close] {
                            b'"' | b'\'' => close = skip_string(bytes, close),
                            b'/' if matches!(bytes.get(close + 1), Some(b'/' | b'*')) => {
                                close = skip_comment(bytes, close)
                            }
                            b'(' | b'{' | b'[' => {
                                depth += 1;
                                close += 1;
                            }
                            b')' | b'}' | b']' => {
                                depth -= 1;
                                if depth == 0 {
                                    break;
                                }
                                close += 1;
                            }
                            _ => close += 1,
                        }
                    }
                    if depth == 0 {
                        out.push((simple, k + 1, close));
                    }
                    i = close + 1;
                } else {
                    i = j;
                }
            }
            _ => i += 1,
        }
    }
    out
}

/// The string literals in annotation `args`: `(value, value start, value end)`
/// with offsets in `args` (quotes excluded). Unterminated strings are skipped.
fn string_literals(args: &str) -> Vec<(String, usize, usize)> {
    let bytes = args.as_bytes();
    let mut out = Vec::new();
    let mut s = 0;
    while s < bytes.len() {
        if bytes[s] == b'"' {
            let e = skip_string(bytes, s);
            // Without the quotes; skip_string stops just past `"`.
            if e > s + 1 && bytes[e - 1] == b'"' {
                out.push((args[s + 1..e - 1].to_owned(), s + 1, e - 1));
                s = e;
            } else {
                s += 1; // unterminated: not a string
            }
        } else {
            s += 1;
        }
    }
    out
}

/// The value of `key = "…"`: the first string-valued `key` at nesting depth 0
/// in annotation `args`, with offsets in `args`. Strings are skipped while
/// looking, so `property="id"` never matches `key = "id"`.
fn annotation_string_arg(args: &str, key: &str) -> Option<(String, usize, usize)> {
    let bytes = args.as_bytes();
    let mut depth = 0usize;
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
            _ if depth == 0 && ident(bytes[i] as char) => {
                let mut j = i + 1;
                while j < bytes.len() && ident(bytes[j] as char) {
                    j += 1;
                }
                if &args[i..j] == key {
                    let mut k = j;
                    while k < bytes.len() && bytes[k].is_ascii_whitespace() {
                        k += 1;
                    }
                    if bytes.get(k) == Some(&b'=') {
                        k += 1;
                        while k < bytes.len() && bytes[k].is_ascii_whitespace() {
                            k += 1;
                        }
                        if bytes.get(k) == Some(&b'"') {
                            let e = skip_string(bytes, k);
                            if e > k + 1 && bytes[e - 1] == b'"' {
                                return Some((args[k + 1..e - 1].to_owned(), k + 1, e - 1));
                            }
                        }
                        i = k;
                        continue;
                    }
                }
                i = j;
            }
            _ => i += 1,
        }
    }
    None
}

/// The `#{…}` / `${…}` matches in one method's `@Select`/`@Insert`/`@Update`/
/// `@Delete` SQL string literals: `(string start, string end, params)` with
/// offsets in `head` (the declaration's annotations and signature). Array
/// values (`@Select({…})`) and nested annotations in other arguments are
/// skipped over, never read as SQL.
fn annotation_sql_of(head: &str) -> Vec<(usize, usize, Vec<LitSpan>)> {
    let mut out = Vec::new();
    for (simple, a, b) in annotations_of(head) {
        if !SQL_ANNOTATIONS.contains(&simple.as_str()) {
            continue;
        }
        let args = &head[a..b];
        for (value, cs, ce) in string_literals(args) {
            let params = sql_params(&value).into_iter().map(|(n, ps, pe)| (n, a + cs + ps, a + cs + pe)).collect();
            out.push((a + cs, a + ce, params));
        }
    }
    out
}

/// `@ResultMap("…")` references and `@Results(id = "…")` definitions in one
/// method's head: `(id, id start, id end)` with offsets in `head` (quotes
/// excluded). Every `@ResultMap` string counts, so `@ResultMap({"a", "b"})`
/// yields both.
fn result_map_of(head: &str) -> (Vec<LitSpan>, Vec<LitSpan>) {
    let mut refs = Vec::new();
    let mut defs = Vec::new();
    for (simple, a, b) in annotations_of(head) {
        let args = &head[a..b];
        if simple == "ResultMap" {
            refs.extend(string_literals(args).into_iter().map(|(v, s, e)| (v, a + s, a + e)));
        } else if simple == "Results"
            && let Some((v, s, e)) = annotation_string_arg(args, "id")
        {
            defs.push((v, a + s, a + e));
        }
    }
    (refs, defs)
}

/// The interface's name and methods (with their parameter names).
pub fn parse_java(text: &str) -> MapperJava {
    let package =
        text.lines().find_map(|l| l.trim().strip_prefix("package ").map(|p| p.trim_end_matches(';').trim().to_owned()));
    let Some(i) = text.find("interface ") else { return MapperJava::default() };
    let rest = &text[i + 10..];
    let indent = rest.len() - rest.trim_start().len();
    let simple: String = rest[indent..].chars().take_while(|c| ident(*c)).collect();
    let name = Some(match package {
        Some(p) => format!("{p}.{simple}"),
        None => simple.clone(),
    });
    let decl =
        Some(Named { name: simple.clone(), range: range_of(text, i + 10 + indent, i + 10 + indent + simple.len()) });
    let body_start = text[i..].find('{').map_or(text.len(), |b| i + b + 1);
    let mut methods = Vec::new();
    let mut annotation_sql = Vec::new();
    let mut result_refs = Vec::new();
    let mut result_ids = Vec::new();
    let mut depth = 0;
    let mut paren = 0usize;
    let mut stmt_start = body_start;
    // Strings and comments may hold `{`, `}`, `(`, `)` or `;` (notably the
    // `#{…}` braces in annotation SQL), so skip them: braces inside
    // parentheses (annotation arguments) are not structural, and only
    // structural braces and semicolons split statements.
    let body = &text[body_start..];
    let body_bytes = body.as_bytes();
    let mut i = 0;
    while i < body.len() {
        let k = body_start + i;
        match body_bytes[i] {
            b'"' | b'\'' => i = skip_string(body_bytes, i),
            b'/' if matches!(body_bytes.get(i + 1), Some(b'/' | b'*')) => i = skip_comment(body_bytes, i),
            b'(' => {
                paren += 1;
                i += 1;
            }
            b')' => {
                paren = paren.saturating_sub(1);
                i += 1;
            }
            b'{' if paren == 0 => {
                depth += 1;
                i += 1;
            }
            b'}' if depth == 0 && paren == 0 => break,
            b'}' if paren == 0 => {
                depth -= 1;
                stmt_start = k + 1;
                i += 1;
            }
            // At interface level `;` always ends the statement: field and
            // method declarations cannot hold one inside parentheses, so an
            // unbalanced `(` from a broken line (e.g. `@ResultMap("` while
            // typing) resyncs here instead of swallowing the rest of the file.
            b';' if depth == 0 => {
                let stmt = &text[stmt_start..k];
                if let Some(decl) = scan_declaration(stmt)
                    && !stmt[..decl.parens.0].contains(" default ")
                {
                    let (s, e) = (stmt_start + decl.name.0, stmt_start + decl.name.1);
                    let list_base = stmt_start + decl.parens.0 + 1;
                    let params = params_of(&stmt[decl.parens.0 + 1..decl.parens.1])
                        .into_iter()
                        .map(|(name, ps, pe)| Param { name, range: range_of(text, list_base + ps, list_base + pe) })
                        .collect();
                    let method = methods.len();
                    methods.push((
                        Named { name: stmt[decl.name.0..decl.name.1].to_owned(), range: range_of(text, s, e) },
                        params,
                    ));
                    let mut strings = Vec::new();
                    let mut sql_params = Vec::new();
                    for (ss, se, ps) in annotation_sql_of(&stmt[..decl.parens.0]) {
                        strings.push(range_of(text, stmt_start + ss, stmt_start + se));
                        sql_params.extend(ps.into_iter().map(|(n, ms, me)| Named {
                            name: n,
                            range: range_of(text, stmt_start + ms, stmt_start + me),
                        }));
                    }
                    if !strings.is_empty() {
                        annotation_sql.push(AnnotationSql { method, strings, params: sql_params });
                    }
                    let (refs, defs) = result_map_of(&stmt[..decl.parens.0]);
                    result_refs.extend(refs.into_iter().map(|(v, rs, re)| ResultMapRef {
                        method,
                        name: Named { name: v, range: range_of(text, stmt_start + rs, stmt_start + re) },
                    }));
                    result_ids.extend(defs.into_iter().map(|(v, ds, de)| {
                        (method, Named { name: v, range: range_of(text, stmt_start + ds, stmt_start + de) })
                    }));
                }
                stmt_start = k + 1;
                paren = 0;
                i += 1;
            }
            _ => i += 1,
        }
    }
    MapperJava { name, decl, methods, annotation_sql, result_refs, result_ids }
}

/// `namespace="com.acme.UserMapper"` in an XML file, either quote.
fn namespace_query(namespace: &str) -> TextQuery {
    let escaped: String =
        namespace.chars().flat_map(|c| matches!(c, '.' | '$').then_some('\\').into_iter().chain([c])).collect();
    TextQuery {
        pattern: format!(r#"namespace\s*=\s*["']{escaped}["']"#),
        regex: true,
        case_sensitive: true,
        include: vec!["**/*.xml".into()],
        ..Default::default()
    }
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
    /// project root → namespace → (when it was looked up, the XML mapping it, if any).
    xml_index: BTreeMap<String, BTreeMap<String, (Instant, Option<String>)>>,
}

impl Navigator {
    /// The XML mapping `namespace`: the cached path while it still maps it, else a
    /// search for its `namespace="…"`, so the cost doesn't grow with the project's XML files.
    fn xml_for(&mut self, project: &Project, namespace: &str) -> Option<(String, MapperXml)> {
        let root = project.root().ok()?;
        let read = |path: &str| {
            let xml = parse_xml(&project.read_file(path).ok()?);
            xml.namespace.as_ref().is_some_and(|n| n.name == namespace).then_some(xml)
        };
        if let Some((at, path)) = self.xml_index.get(&root).and_then(|m| m.get(namespace))
            && at.elapsed() < INDEX_TTL
        {
            let path = path.as_ref()?;
            if let Some(xml) = read(path) {
                return Some((path.clone(), xml));
            }
        }
        let found = project.search_text(&namespace_query(namespace), MAX_MAPPERS).ok()?;
        let mut paths: Vec<&str> = found.matches.iter().map(|m| m.location.path.as_str()).collect();
        paths.dedup();
        let hit = paths.into_iter().find_map(|path| Some((path.to_owned(), read(path)?)));
        self.xml_index
            .entry(root)
            .or_default()
            .insert(namespace.to_owned(), (Instant::now(), hit.as_ref().map(|(path, _)| path.clone())));
        hit
    }

    /// The interface `namespace` names (`com.acme.UserMapper` → `**/com/acme/UserMapper.java`).
    fn java_for(project: &Project, namespace: &str) -> Option<(String, MapperJava)> {
        let rel = format!("**/{}.java", namespace.replace('.', "/"));
        let path = project.find_files(&rel, 1).ok()?.into_iter().next()?;
        let java = parse_java(&project.read_file(&path).ok()?);
        (java.name.as_deref() == Some(namespace)).then_some((path, java))
    }

    /// Where `resultMap="…"` / `<include refid="…">` points: a `<resultMap id>` /
    /// `<sql id>` in this file, or in the mapper a `namespace.id` prefix names
    /// (ids never hold dots, so the last segment is the id).
    fn anchor_target(
        &mut self,
        project: &Project,
        doc: &Document,
        xml: &MapperXml,
        here_ns: &str,
        name: &str,
        sql: bool,
    ) -> Option<Location> {
        let (ns, id) = name.rsplit_once('.').map_or((here_ns, name), |(ns, id)| (ns, id));
        let pick = |xml: &MapperXml, path: String| {
            let ids = if sql { &xml.sql_fragments } else { &xml.result_maps };
            ids.iter().find(|n| n.name == id).map(|n| Location { path, range: n.range })
        };
        if ns == here_ns {
            return pick(xml, doc.path.clone());
        }
        let (path, other) = self.xml_for(project, ns)?;
        pick(&other, path)
    }

    /// Inside `@ResultMap("…")`: the known result-map ids — `@Results(id =
    /// "…")` in this file, plus the XML mapper's `<resultMap>` ids. `None`
    /// when the cursor is not on a `@ResultMap` id.
    fn result_map_completion(&mut self, doc: &Document, at: Position) -> Option<Vec<CompletionItem>> {
        let cursor = offset(&doc.text, at)?;
        let before = &doc.text[..cursor];
        let java = parse_java(&doc.text);
        // A closed string: the recorded id range. Otherwise (still typing) the
        // `@ResultMap("` prefix on the cursor's line.
        let typed: &str = if let Some(hit) = java.result_refs.iter().find(|r| contains(r.name.range, at)) {
            &doc.text[offset(&doc.text, hit.name.range.start)?..cursor]
        } else {
            let line_start = before.rfind('\n').map_or(0, |i| i + 1);
            let line = &before[line_start..];
            let rel = line.rfind("ResultMap(\"")?;
            let prev = line[..rel].chars().next_back()?;
            if prev != '@' && prev != '.' {
                return None;
            }
            let typed = &line[rel + 11..];
            if !typed.chars().all(|c| ident(c) || c == '.' || c == '-') {
                return None;
            }
            typed
        };
        let start = Position::new(at.line, at.character - typed.encode_utf16().count() as u32);
        let mut ids: Vec<String> = java.result_ids.iter().map(|(_, d)| d.name.clone()).collect();
        if let Some(project) = project_of(&doc.path)
            && let Some(name) = &java.name
            && let Some((_, xml)) = self.xml_for(&project, name)
        {
            ids.extend(xml.result_maps.iter().map(|m| m.name.clone()));
        }
        ids.sort();
        ids.dedup();
        Some(
            ids.into_iter()
                .filter(|id| id.starts_with(typed))
                .map(|id| CompletionItem {
                    replace: Some(Range::new(start, at)),
                    ..CompletionItem::new(&id, CompletionKind::Value)
                })
                .collect(),
        )
    }

    /// Pairs of (name in this document, target location) for `doc`.
    fn links(&mut self, doc: &Document) -> Vec<(Named, Location, String)> {
        let Some(project) = project_of(&doc.path) else { return Vec::new() };
        if doc.language == "xml" {
            let xml = parse_xml(&doc.text);
            let Some(ns) = xml.namespace.clone() else { return Vec::new() };
            let mut out = Vec::new();
            // `<mapper namespace>` → the interface; statement ids → methods.
            if let Some((path, java)) = Self::java_for(&project, &ns.name) {
                let simple = ns.name.rsplit('.').next().unwrap_or(&ns.name).to_owned();
                if let Some(decl) = java.decl {
                    out.push((
                        ns.clone(),
                        Location { path: path.clone(), range: decl.range },
                        format!("interface {simple}"),
                    ));
                }
                out.extend(xml.statements.iter().filter_map(|s| {
                    let (m, _) = java.methods.iter().find(|(m, _)| m.name == s.name)?;
                    let tip = format!("{simple}.{}()", m.name);
                    Some((s.clone(), Location { path: path.clone(), range: m.range }, tip))
                }));
            }
            // resultMap / sql references resolve even when the interface is missing.
            for r in xml.result_map_refs.iter().chain(xml.extends_refs.iter()) {
                if let Some(target) = self.anchor_target(&project, doc, &xml, &ns.name, &r.name, false) {
                    out.push((r.clone(), target, format!("resultMap {}", r.name)));
                }
            }
            for r in &xml.include_refs {
                if let Some(target) = self.anchor_target(&project, doc, &xml, &ns.name, &r.name, true) {
                    out.push((r.clone(), target, format!("sql {}", r.name)));
                }
            }
            // Gutter arrows read top-down: the namespace marker precedes the statements'.
            out.sort_by_key(|a| a.0.range.start);
            out
        } else {
            let java = parse_java(&doc.text);
            let Some(name) = java.name.clone() else { return Vec::new() };
            let simple = name.rsplit('.').next().unwrap_or(&name).to_owned();
            // `@ResultMap("…")`: the `@Results(id = "…")` in this file when
            // present, else the XML mapper's `<resultMap>`. Needs no XML for
            // pure-annotation mappers.
            let xml = self.xml_for(&project, &name);
            let mut out: Vec<(Named, Location, String)> = Vec::new();
            for r in &java.result_refs {
                if let Some((method, def)) = java.result_ids.iter().find(|(_, d)| d.name == r.name.name) {
                    let (m, _) = &java.methods[*method];
                    out.push((
                        r.name.clone(),
                        Location { path: doc.path.clone(), range: def.range },
                        format!("{simple}.{}(): {}", m.name, def.name),
                    ));
                } else if let Some((path, xml)) = &xml
                    && let Some(def) = xml.result_maps.iter().find(|m| m.name == r.name.name)
                {
                    let file = path.rsplit(['/', '\\']).next().unwrap_or(path).to_owned();
                    out.push((
                        r.name.clone(),
                        Location { path: path.clone(), range: def.range },
                        format!("{file}: {}", def.name),
                    ));
                }
            }
            if let Some((path, xml)) = xml {
                let file = path.rsplit(['/', '\\']).next().unwrap_or(&path).to_owned();
                out.extend(java.methods.into_iter().filter_map(|(m, _)| {
                    let s = xml.statements.iter().find(|s| s.name == m.name)?;
                    Some((m, Location { path: path.clone(), range: s.range }, format!("{file}: {}", s.name)))
                }));
            }
            out
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
        let mut out: Vec<Location> =
            self.links(doc).into_iter().filter(|(n, ..)| contains(n.range, at)).map(|(_, l, _)| l).collect();
        // `#{…}` / `${…}` in an annotation's SQL: the method's `@Param` or
        // parameter. Needs no XML: pure-annotation mappers work too. A dotted
        // path (`#{user.name}`) resolves by its first segment.
        if doc.language == "java" {
            let java = parse_java(&doc.text);
            for sql in &java.annotation_sql {
                let (_, params) = &java.methods[sql.method];
                for occ in &sql.params {
                    let first = occ.name.split('.').next().unwrap_or("");
                    if let Some(target) = params.iter().find(|p| p.name == first)
                        && contains(occ.range, at)
                    {
                        out.push(Location { path: doc.path.clone(), range: target.range });
                    }
                }
            }
        }
        out
    }

    fn completion(&mut self, doc: &Document, at: Position, _trigger: Option<&str>) -> Vec<CompletionItem> {
        if doc.language == "java" {
            if let Some(items) = self.result_map_completion(doc, at) {
                return items;
            }
            return annotation_param_completion(doc, at);
        }
        if doc.language != "xml" {
            return Vec::new();
        }
        let Some(cursor) = offset(&doc.text, at) else { return Vec::new() };
        let before = &doc.text[..cursor];
        let xml = parse_xml(&doc.text);
        let Some(ns) = xml.namespace.clone().map(|n| n.name) else { return Vec::new() };
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
        // Inside `refid="…` of an `<include>`: this file's `<sql>` ids.
        if let Some(i) = line.rfind("refid=\"")
            && !line[i + 7..].contains('"')
            && line.contains("<include")
        {
            let typed = &line[i + 7..];
            let start = Position::new(at.line, at.character - typed.encode_utf16().count() as u32);
            return xml
                .sql_fragments
                .iter()
                .filter(|s| s.name.starts_with(typed))
                .map(|s| CompletionItem {
                    replace: Some(Range::new(start, at)),
                    detail: Some("sql".into()),
                    ..CompletionItem::new(&s.name, CompletionKind::Variable)
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
                .filter(|p| p.name.starts_with(typed))
                .map(|p| CompletionItem {
                    replace: Some(Range::new(start, at)),
                    ..CompletionItem::new(&p.name, CompletionKind::Variable)
                })
                .collect();
        }
        Vec::new()
    }
}

/// After `#{` / `${` inside an annotation SQL string: the method's parameters.
fn annotation_param_completion(doc: &Document, at: Position) -> Vec<CompletionItem> {
    let Some(cursor) = offset(&doc.text, at) else { return Vec::new() };
    let java = parse_java(&doc.text);
    for sql in &java.annotation_sql {
        let (_, params) = &java.methods[sql.method];
        for s in &sql.strings {
            let (Some(start), Some(end)) = (offset(&doc.text, s.start), offset(&doc.text, s.end)) else {
                continue;
            };
            if !(start <= cursor && cursor <= end) {
                continue;
            }
            let seg = &doc.text[start..cursor];
            let mut token: Option<usize> = None;
            for t in ["#{", "${"] {
                if let Some(i) = seg.rfind(t) {
                    token = Some(token.map_or(i, |prev: usize| prev.max(i)));
                }
            }
            let Some(i) = token else { continue };
            let typed = &seg[i + 2..];
            if typed.contains('}') || !typed.chars().all(|c| ident(c) || c == '.') {
                continue;
            }
            let start = Position::new(at.line, at.character - typed.encode_utf16().count() as u32);
            return params
                .iter()
                .filter(|p| p.name.starts_with(typed))
                .map(|p| CompletionItem {
                    replace: Some(Range::new(start, at)),
                    ..CompletionItem::new(&p.name, CompletionKind::Variable)
                })
                .collect();
        }
    }
    Vec::new()
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
    use openidea_plugin::{TextMatch, TextSearch};

    const JAVA: &str = "package com.acme;\n\nimport org.apache.ibatis.annotations.Param;\n\npublic interface UserMapper {\n    User findById(@Param(\"id\") long id);\n\n    int insert(User user);\n\n    default void helper() {}\n\n    List<User> search(String name, int limit);\n}\n";
    const XML: &str = "<?xml version=\"1.0\"?>\n<mapper namespace=\"com.acme.UserMapper\">\n  <select id=\"findById\" resultType=\"User\">\n    select * from users where id = #{id}\n  </select>\n  <insert id=\"insert\">\n    insert into users values (#{user})\n  </insert>\n  <select id=\"\">\n  </select>\n</mapper>\n";

    #[test]
    fn parses_both_sides() {
        let java = parse_java(JAVA);
        assert_eq!(java.name.as_deref(), Some("com.acme.UserMapper"));
        let names: Vec<_> = java
            .methods
            .iter()
            .map(|(m, p)| (m.name.as_str(), p.iter().map(|x| x.name.clone()).collect::<Vec<_>>()))
            .collect();
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
        assert_eq!(xml.namespace.as_ref().map(|n| n.name.as_str()), Some("com.acme.UserMapper"));
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

    /// A mapper XML, found by the namespace search like the host's Find in Files would.
    fn add_mapper(host: &MockHost, path: &'static str, text: &'static str) {
        host.add_file(path, text);
        host.on_search(move |query, _| {
            assert!(query.regex && query.include == ["**/*.xml"], "{query:?}");
            let namespace = query.pattern.split(r#"["']"#).nth(1).unwrap_or_default().replace('\\', "");
            let line = text.lines().position(|l| l.contains(&format!("namespace=\"{namespace}\"")));
            let matches = line
                .map(|line| TextMatch {
                    location: Location {
                        path: format!("/project/{path}"),
                        range: Range::new(Position::new(line as u32, 0), Position::new(line as u32, 0)),
                    },
                    line: String::new(),
                })
                .into_iter()
                .collect();
            Ok(TextSearch { matches, limit_hit: false })
        });
    }

    fn setup() -> MockHost {
        let host = MockHost::install();
        host.add_file("src/main/java/com/acme/UserMapper.java", JAVA);
        add_mapper(&host, "src/main/resources/mapper/UserMapper.xml", XML);
        host.add_file("pom.xml", "<project/>");
        host
    }

    fn annotated_setup() -> MockHost {
        let host = MockHost::install();
        host.add_file("src/main/java/com/acme/UserMapper.java", ANNOTATED);
        add_mapper(&host, "src/main/resources/mapper/UserMapper.xml", ANNOTATED_XML);
        host.add_file("pom.xml", "<project/>");
        host
    }

    /// Methods behind method-level annotations keep their names, parameters and
    /// positions: the scanner skips comments, strings and annotation arguments
    /// (nested annotations, `(` `)` `{` `}` `,` in strings) before the name.
    #[test]
    fn parses_methods_with_annotations() {
        let java = parse_java(ANNOTATED);
        let names: Vec<_> = java
            .methods
            .iter()
            .map(|(m, p)| (m.name.as_str(), p.iter().map(|x| x.name.clone()).collect::<Vec<_>>()))
            .collect();
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
        assert_eq!(java.methods[0].1.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), ["id"]);
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
        let markers = n.line_markers(&xml);
        assert_eq!(markers[0].tooltip, "Go to interface UserMapper");
        assert_eq!(markers[1].tooltip, "Go to UserMapper.findById()");
    }

    #[test]
    fn method_annotations_do_not_swallow_the_method_name() {
        // A method-level annotation with arguments: `stmt.find('(')` would land
        // inside `@DataPermission(…)` and read `DataPermission` as the name.
        let java = parse_java(
            "package com.acme;\n\npublic interface SecuredMapper {\n    @DataPermission(column = \"id\", scope = (@Scope(\"self\")))\n    List<User> findAll(@Param(\"org\") String org);\n\n    @org.acme.Check(value = \"(nested)\")\n    int count();\n}\n",
        );
        let names: Vec<_> = java
            .methods
            .iter()
            .map(|(m, p)| (m.name.as_str(), p.iter().map(|x| x.name.clone()).collect::<Vec<_>>()))
            .collect();
        assert_eq!(names, [("findAll", vec!["org".to_owned()]), ("count", Vec::<String>::new())]);
    }

    const REFS_XML: &str = concat!(
        "<?xml version=\"1.0\"?>\n",
        "<mapper namespace=\"com.acme.OrderMapper\">\n",
        "  <resultMap id=\"orderMap\" type=\"Order\">\n",
        "    <association property=\"user\" resultMap=\"userMap\"/>\n",
        "  </resultMap>\n",
        "  <resultMap id=\"fullMap\" extends=\"orderMap\"/>\n",
        "  <sql id=\"baseColumns\">id, total</sql>\n",
        "  <select id=\"find\" resultMap=\"com.acme.OrderMapper.fullMap\">\n",
        "    select <include refid=\"baseColumns\"/> from orders\n",
        "  </select>\n",
        "</mapper>\n"
    );

    #[test]
    fn parses_result_maps_sql_and_refs() {
        let xml = parse_xml(REFS_XML);
        assert_eq!(xml.namespace.as_ref().map(|n| n.name.as_str()), Some("com.acme.OrderMapper"));
        fn names(v: &[Named]) -> Vec<&str> {
            v.iter().map(|n| n.name.as_str()).collect()
        }
        assert_eq!(names(&xml.result_maps), ["orderMap", "fullMap"]);
        assert_eq!(names(&xml.sql_fragments), ["baseColumns"]);
        assert_eq!(names(&xml.result_map_refs), ["userMap", "com.acme.OrderMapper.fullMap"]);
        assert_eq!(names(&xml.extends_refs), ["orderMap"]);
        assert_eq!(names(&xml.include_refs), ["baseColumns"]);
        // `resultMap="userMap"` value on line 3 (0-based).
        assert_eq!(xml.result_map_refs[0].range, Range::new(Position::new(3, 44), Position::new(3, 51)));
        let java = parse_java("package com.acme;\npublic interface OrderMapper {\n}\n");
        assert_eq!(java.name.as_deref(), Some("com.acme.OrderMapper"));
        assert_eq!(
            java.decl.map(|d| (d.name, d.range)),
            Some(("OrderMapper".to_owned(), Range::new(Position::new(1, 17), Position::new(1, 28))))
        );
    }

    #[test]
    fn navigates_namespace_result_maps_and_includes() {
        let host = MockHost::install();
        host.add_file(
            "src/main/java/com/acme/OrderMapper.java",
            "package com.acme;\npublic interface OrderMapper {\n}\n",
        );
        add_mapper(&host, "src/main/resources/mapper/OrderMapper.xml", REFS_XML);
        host.add_file("pom.xml", "<project/>");
        let mut n = Navigator::default();
        let xml = doc("/project/src/main/resources/mapper/OrderMapper.xml", "xml", REFS_XML);

        // `<mapper namespace>` → the interface; unresolvable refs link nowhere.
        let to_iface = n.definition(&xml, Position::new(1, 25));
        assert_eq!(to_iface.len(), 1);
        assert_eq!(
            (to_iface[0].path.ends_with("OrderMapper.java"), to_iface[0].range.start),
            (true, Position::new(1, 17))
        );
        assert!(n.definition(&xml, Position::new(3, 40)).is_empty(), "userMap lives in no indexed file");

        // `extends="orderMap"` → the parent resultMap; `refid` → the `<sql>` id.
        let to_parent = n.definition(&xml, Position::new(5, 37));
        assert_eq!(to_parent.len(), 1);
        assert_eq!(to_parent[0].range.start, Position::new(2, 17));
        let to_sql = n.definition(&xml, Position::new(8, 30));
        assert_eq!(to_sql.len(), 1);
        assert_eq!(to_sql[0].range.start, Position::new(6, 11));

        // `namespace.id` form resolves within the same file.
        let to_full = n.definition(&xml, Position::new(7, 45));
        assert_eq!(to_full.len(), 1);
        assert_eq!(to_full[0].range.start, Position::new(5, 17));

        // `<include refid="` completes this file's `<sql>` ids.
        let items = n.completion(&xml, Position::new(8, 29), None);
        assert_eq!(items.iter().map(|c| c.label.as_str()).collect::<Vec<_>>(), ["baseColumns"]);
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

    const ANNOTATED_SQL: &str = concat!(
        "package com.acme;\n",
        "import org.apache.ibatis.annotations.Param;\n",
        "import org.apache.ibatis.annotations.Select;\n",
        "public interface UserMapper {\n",
        "    @Select(\"SELECT * FROM users WHERE id = #{id} AND name = #{name}\")\n",
        "    User find(@Param(\"id\") Long id, String name);\n",
        "}\n"
    );

    fn annotation_setup() -> MockHost {
        let host = MockHost::install();
        host.add_file("src/main/java/com/acme/UserMapper.java", ANNOTATED_SQL);
        add_mapper(&host, "src/main/resources/mapper/UserMapper.xml", ANNOTATED_XML);
        host.add_file("pom.xml", "<project/>");
        host
    }

    /// `#{…}` inside an annotation's SQL jumps to the `@Param`/parameter, with
    /// no XML statement involved (pure-annotation mappers work too).
    #[test]
    fn navigates_annotation_sql_params_to_params() {
        let _host = annotation_setup();
        let java = parse_java(ANNOTATED_SQL);
        assert_eq!(java.annotation_sql.len(), 1);
        assert_eq!(java.annotation_sql[0].params.iter().map(|o| o.name.as_str()).collect::<Vec<_>>(), ["id", "name"]);
        let doc = doc("/project/src/main/java/com/acme/UserMapper.java", "java", ANNOTATED_SQL);
        let mut n = Navigator::default();
        let line = ANNOTATED_SQL.lines().nth(4).unwrap();
        let col = line.find("#{id}").unwrap() + 3;
        let got = n.definition(&doc, Position::new(4, col as u32));
        let want = java.methods[0].1.iter().find(|p| p.name == "id").unwrap().range;
        assert_eq!(got, vec![Location { path: doc.path.clone(), range: want }]);
        // The second parameter resolves too.
        let col = line.find("#{name}").unwrap() + 3;
        let got = n.definition(&doc, Position::new(4, col as u32));
        let want = java.methods[0].1.iter().find(|p| p.name == "name").unwrap().range;
        assert_eq!(got, vec![Location { path: doc.path.clone(), range: want }]);
    }

    /// After `#{` inside an annotation's SQL string: the method's parameters.
    #[test]
    fn completes_annotation_sql_params() {
        let _host = annotation_setup();
        let mut n = Navigator::default();
        let text = ANNOTATED_SQL.replacen("#{id}", "#{", 1);
        let doc = doc("/project/src/main/java/com/acme/UserMapper.java", "java", &text);
        let line = text.lines().nth(4).unwrap();
        let col = line.find("#{").unwrap() + 2;
        let items = n.completion(&doc, Position::new(4, col as u32), None);
        assert_eq!(items.iter().map(|c| c.label.as_str()).collect::<Vec<_>>(), ["id", "name"]);
        // Outside a SQL string there is nothing to complete.
        let plain = n.completion(&doc, Position::new(5, 10), None);
        assert!(plain.is_empty());
    }

    const RESULT_JAVA: &str = concat!(
        "package com.acme;\n",
        "import org.apache.ibatis.annotations.Result;\n",
        "import org.apache.ibatis.annotations.ResultMap;\n",
        "import org.apache.ibatis.annotations.Results;\n",
        "import org.apache.ibatis.annotations.Select;\n",
        "public interface UserMapper {\n",
        "    @Select(\"SELECT * FROM users WHERE id = #{id}\")\n",
        "    @ResultMap(\"userMap\")\n",
        "    User findById(Long id);\n",
        "\n",
        "    @Results(\n",
        "        id = \"orderMap\",\n",
        "        value = {@Result(property = \"userName\", column = \"user_name\")}\n",
        "    )\n",
        "    @ResultMap(\"orderMap\")\n",
        "    Order findOrder(Long id);\n",
        "}\n"
    );

    const RESULT_XML: &str = concat!(
        "<?xml version=\"1.0\"?>\n",
        "<mapper namespace=\"com.acme.UserMapper\">\n",
        "  <resultMap id=\"userMap\" type=\"User\">\n",
        "    <id property=\"id\" column=\"user_id\"/>\n",
        "  </resultMap>\n",
        "  <resultMap id=\"extraMap\" type=\"User\"/>\n",
        "  <select id=\"findById\" resultMap=\"userMap\">\n",
        "    select * from users where id = #{id}\n",
        "  </select>\n",
        "</mapper>\n"
    );

    fn result_setup() -> MockHost {
        let host = MockHost::install();
        host.add_file("src/main/java/com/acme/UserMapper.java", RESULT_JAVA);
        add_mapper(&host, "src/main/resources/mapper/UserMapper.xml", RESULT_XML);
        host.add_file("pom.xml", "<project/>");
        host
    }

    #[test]
    fn parses_result_map_refs_and_ids() {
        let java = parse_java(RESULT_JAVA);
        let refs: Vec<_> =
            java.result_refs.iter().map(|r| (java.methods[r.method].0.name.as_str(), r.name.name.as_str())).collect();
        assert_eq!(refs, [("findById", "userMap"), ("findOrder", "orderMap")]);
        let ids: Vec<_> =
            java.result_ids.iter().map(|(m, d)| (java.methods[*m].0.name.as_str(), d.name.as_str())).collect();
        assert_eq!(ids, [("findOrder", "orderMap")]);
        let xml = parse_xml(RESULT_XML);
        assert_eq!(xml.result_maps.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(), ["userMap", "extraMap"]);
        assert_eq!(xml.result_map_refs.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(), ["userMap"]);
    }

    /// `@ResultMap("…")` jumps to the XML `<resultMap>`, or to the
    /// `@Results(id = "…")` in the same file; `resultMap="…"` in XML jumps to
    /// the `<resultMap>`. All three get gutter markers.
    #[test]
    fn navigates_result_map_refs() {
        let _host = result_setup();
        let mut n = Navigator::default();
        let java = doc("/project/src/main/java/com/acme/UserMapper.java", "java", RESULT_JAVA);
        let xml = doc("/project/src/main/resources/mapper/UserMapper.xml", "xml", RESULT_XML);

        // `@ResultMap("userMap")` → the XML `<resultMap id="userMap">`.
        let line = RESULT_JAVA.lines().nth(7).unwrap();
        let col = line.find("\"userMap\"").unwrap() + 2;
        let got = n.definition(&java, Position::new(7, col as u32));
        let want = parse_xml(RESULT_XML).result_maps[0].range;
        assert_eq!(got, vec![Location { path: xml.path.clone(), range: want }]);

        // `@ResultMap("orderMap")` → the `@Results(id = "orderMap")` above.
        let line = RESULT_JAVA.lines().nth(14).unwrap();
        let col = line.find("\"orderMap\"").unwrap() + 2;
        let got = n.definition(&java, Position::new(14, col as u32));
        let want = parse_java(RESULT_JAVA).result_ids[0].1.range;
        assert_eq!(got, vec![Location { path: java.path.clone(), range: want }]);

        // `resultMap="userMap"` in XML → the `<resultMap>` in the same file.
        let line = RESULT_XML.lines().nth(6).unwrap();
        let col = line.find("resultMap=\"userMap\"").unwrap() + 12;
        let got = n.definition(&xml, Position::new(6, col as u32));
        let want = parse_xml(RESULT_XML).result_maps[0].range;
        assert_eq!(got, vec![Location { path: xml.path.clone(), range: want }]);

        let mut markers: Vec<_> = n.line_markers(&java).into_iter().map(|m| (m.line, m.tooltip)).collect();
        markers.sort();
        assert_eq!(
            markers,
            [
                (7, "Go to UserMapper.xml: userMap".to_owned()),
                (8, "Go to UserMapper.xml: findById".to_owned()),
                (14, "Go to UserMapper.findOrder(): orderMap".to_owned())
            ]
        );
        let markers = n.line_markers(&xml);
        assert_eq!(
            markers.iter().map(|m| (m.line, m.tooltip.as_str())).collect::<Vec<_>>(),
            [(1, "Go to interface UserMapper"), (6, "Go to UserMapper.findById()"), (6, "Go to resultMap userMap")]
        );
    }

    /// Inside `@ResultMap("…")`: annotation `@Results` ids and XML
    /// `<resultMap>` ids, merged and sorted — even while the string is still
    /// unterminated.
    #[test]
    fn completes_result_map_ids() {
        let _host = result_setup();
        let mut n = Navigator::default();
        // Still typing: the string is unterminated.
        let text = RESULT_JAVA.replace("@ResultMap(\"userMap\")", "@ResultMap(\"user");
        let typing = doc("/project/src/main/java/com/acme/UserMapper.java", "java", &text);
        let line = text.lines().nth(7).unwrap();
        let col = line.find("\"user").unwrap() + 1 + 4;
        let items = n.completion(&typing, Position::new(7, col as u32), None);
        assert_eq!(items.iter().map(|c| c.label.as_str()).collect::<Vec<_>>(), ["userMap"]);
        // Just opened the string: every known id.
        let text = RESULT_JAVA.replace("@ResultMap(\"userMap\")", "@ResultMap(\"");
        let opened = doc("/project/src/main/java/com/acme/UserMapper.java", "java", &text);
        let line = text.lines().nth(7).unwrap();
        let col = line.find("ResultMap(\"").unwrap() + 11;
        let items = n.completion(&opened, Position::new(7, col as u32), None);
        assert_eq!(items.iter().map(|c| c.label.as_str()).collect::<Vec<_>>(), ["extraMap", "orderMap", "userMap"]);
        // Closed string, cursor inside: the recorded range.
        let closed = doc("/project/src/main/java/com/acme/UserMapper.java", "java", RESULT_JAVA);
        let line = RESULT_JAVA.lines().nth(7).unwrap();
        let col = line.find("\"userMap\"").unwrap() + 1 + 2;
        let items = n.completion(&closed, Position::new(7, col as u32), None);
        assert_eq!(items.iter().map(|c| c.label.as_str()).collect::<Vec<_>>(), ["userMap"]);
    }
}
