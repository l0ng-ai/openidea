//! `file://` URI ⇄ path conversion (RFC 8089, VS Code-compatible encoding).

use percent_encoding::{AsciiSet, CONTROLS, percent_decode_str, utf8_percent_encode};
use serde_json::Value;
use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::str::FromStr;

/// Characters escaped in a path; `/` and `:` (drive letters) stay literal.
const PATH: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'<')
    .add(b'>')
    .add(b'?')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}');

/// What RFC 3986 doesn't allow in a URI and a server may still leave unencoded in a `file:`
/// URI (non-ASCII is always encoded); `%` stays, it starts the escapes already there.
const LOOSE: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'<')
    .add(b'>')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}');

/// Fields of LSP messages whose value is a URI.
const URI_FIELDS: [&str; 9] =
    ["uri", "targetUri", "newUri", "oldUri", "baseUri", "scopeUri", "rootUri", "target", "href"];

/// Percent-encodes the characters URIs don't allow in the `file:` URIs of `value`: the URI
/// fields and the keys of a workspace edit's `changes`. Eclipse's jdtls sends a path as is
/// (`file:///H:/项目/…`), which `lsp_types::Uri` rejects, failing the whole response. Other
/// strings stay as sent: an edit's `newText` may well start with `file:` (YAML, `.env`).
pub fn encode_loose_file_uris(value: &mut Value) {
    match value {
        Value::Array(items) => items.iter_mut().for_each(encode_loose_file_uris),
        Value::Object(map) => {
            for (key, value) in map.iter_mut() {
                match value {
                    Value::String(s) if URI_FIELDS.contains(&key.as_str()) => {
                        if let Some(encoded) = encode_loose(s) {
                            *s = encoded;
                        }
                    }
                    Value::Object(changes) if key == "changes" => {
                        if changes.keys().any(|k| encode_loose(k).is_some()) {
                            *changes = std::mem::take(changes)
                                .into_iter()
                                .map(|(k, v)| (encode_loose(&k).unwrap_or(k), v))
                                .collect();
                        }
                        changes.values_mut().for_each(encode_loose_file_uris);
                    }
                    _ => encode_loose_file_uris(value),
                }
            }
        }
        _ => {}
    }
}

fn encode_loose(s: &str) -> Option<String> {
    if !s.get(..5).is_some_and(|scheme| scheme.eq_ignore_ascii_case("file:")) {
        return None;
    }
    match Cow::from(utf8_percent_encode(s, LOOSE)) {
        Cow::Owned(encoded) => Some(encoded),
        Cow::Borrowed(_) => None,
    }
}

pub fn path_to_uri_string(path: &Path) -> String {
    let s = if cfg!(windows) {
        dunce::simplified(path).to_string_lossy().replace('\\', "/")
    } else {
        path.to_string_lossy().into_owned()
    };
    let mut out = String::from("file://");
    // `\\server\share\p` → `file://server/share/p` (RFC 8089 Appendix E.3).
    let unc = s.strip_prefix("//?/UNC/").or_else(|| s.strip_prefix("//")).filter(|_| cfg!(windows));
    if let Some(unc) = unc {
        let (host, rest) = unc.split_at(unc.find('/').unwrap_or(unc.len()));
        out.extend(utf8_percent_encode(host, PATH));
        out.extend(utf8_percent_encode(rest, PATH));
        return out;
    }
    if !s.starts_with('/') {
        out.push('/');
    }
    out.extend(utf8_percent_encode(&s, PATH));
    out
}

pub fn path_to_uri(path: &Path) -> lsp_types::Uri {
    let s = path_to_uri_string(path);
    lsp_types::Uri::from_str(&s).unwrap_or_else(|_| {
        // Unreachable for encoded paths; keep a syntactically valid fallback.
        lsp_types::Uri::from_str("file:///").expect("static URI parses")
    })
}

/// Converts a `file:` URI to a path; `None` for other schemes. On Windows a
/// host names a share (`file://server/share/p` → `\\server\share\p`) and the
/// drive letter is upper-cased, as the rest of the IDE spells it.
pub fn uri_to_path(uri: &str) -> Option<PathBuf> {
    let rest = uri.strip_prefix("file://").or_else(|| uri.strip_prefix("FILE://"))?;
    let (host, path) = rest.split_at(rest.find('/')?);
    let local = host.is_empty() || host.eq_ignore_ascii_case("localhost");
    let path = path.split(['?', '#']).next().unwrap_or(path);
    let decoded = percent_decode_str(path).decode_utf8().ok()?;
    if cfg!(windows) {
        if !local {
            let host = percent_decode_str(host).decode_utf8().ok()?;
            return Some(PathBuf::from(format!(r"\\{host}{}", decoded.replace('/', "\\"))));
        }
        // `/C:/x` → `C:\x`
        let trimmed = decoded.strip_prefix('/').filter(|s| s.as_bytes().get(1) == Some(&b':')).unwrap_or(&decoded);
        let mut path = trimmed.replace('/', "\\");
        if path.as_bytes().get(1) == Some(&b':') {
            path[..1].make_ascii_uppercase();
        }
        return Some(PathBuf::from(path));
    }
    if !local {
        return None;
    }
    Some(PathBuf::from(decoded.into_owned()))
}

/// The IDE identity of a document URI: its path for `file:` URIs, else the
/// URI itself (a virtual document such as `jdt://contents/…`) plus the URI.
pub fn uri_target(uri: &str) -> (PathBuf, Option<String>) {
    match uri_to_path(uri) {
        Some(p) => (p, None),
        None => (PathBuf::from(uri), Some(uri.to_owned())),
    }
}

pub use ide_core::text::is_virtual_uri;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_uris_a_server_leaves_unencoded_are_encoded() {
        // jdtls on a project under a Chinese folder (`java.usages` / references response).
        let mut v = serde_json::json!({ "result": [{
            "location": { "uri": "file:///H:/项目/online disk/A.java", "range": { "start": { "line": 1, "character": 2 }, "end": { "line": 1, "character": 3 } } },
            "kind": "unknown"
        }], "edit": { "changes": { "file:///tmp/目录/b.java": [] } }, "text": "项目" });
        let raw = v["result"][0]["location"].clone();
        assert!(serde_json::from_value::<lsp_types::Location>(raw).is_err(), "lsp-types rejects it as sent");
        encode_loose_file_uris(&mut v);
        let uri = v["result"][0]["location"]["uri"].as_str().unwrap();
        assert_eq!(uri, "file:///H:/%E9%A1%B9%E7%9B%AE/online%20disk/A.java");
        let location: lsp_types::Location = serde_json::from_value(v["result"][0]["location"].clone()).unwrap();
        assert!(uri_to_path(location.uri.as_str()).unwrap().ends_with("项目/online disk/A.java"));
        assert!(v["edit"]["changes"].get("file:///tmp/%E7%9B%AE%E5%BD%95/b.java").is_some());
        assert_eq!(v["text"], "项目", "only file: URIs change");
        // Already encoded: untouched.
        let mut encoded = serde_json::json!({ "uri": "file:///a%20b/%E9%A1%B9.java" });
        encode_loose_file_uris(&mut encoded);
        assert_eq!(encoded["uri"], "file:///a%20b/%E9%A1%B9.java");
    }

    #[test]
    fn text_that_starts_with_file_is_not_a_uri() {
        // A YAML formatting edit and a completion whose text begins with `file:`.
        let mut v = serde_json::json!({ "result": [
            { "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 1, "character": 0 } }, "newText": "file: a b\n  - c\n" },
            { "label": "file:", "insertText": "file: ${1:path}", "documentation": "file: the input" }
        ], "edit": { "changes": { "file:///tmp/a b.yaml": [{ "newText": "file: x y" }] } } });
        encode_loose_file_uris(&mut v);
        assert_eq!(v["result"][0]["newText"], "file: a b\n  - c\n");
        assert_eq!(v["result"][1]["insertText"], "file: ${1:path}");
        assert_eq!(v["result"][1]["documentation"], "file: the input");
        let changes = &v["edit"]["changes"]["file:///tmp/a%20b.yaml"];
        assert_eq!(changes[0]["newText"], "file: x y");
        // A diagnostic's help link is a URI too.
        let mut d = serde_json::json!({ "codeDescription": { "href": "file:///tmp/help files/rule.html" } });
        encode_loose_file_uris(&mut d);
        assert_eq!(d["codeDescription"]["href"], "file:///tmp/help%20files/rule.html");
    }

    #[cfg(unix)]
    #[test]
    fn round_trip() {
        for p in ["/tmp/a b/c#d%e.rs", "/home/ü/x[1].ts", "/plain/path.rs"] {
            let uri = path_to_uri(Path::new(p));
            assert!(uri.as_str().starts_with("file:///"), "{}", uri.as_str());
            assert_eq!(uri_to_path(uri.as_str()).unwrap(), PathBuf::from(p));
        }
        assert_eq!(path_to_uri_string(Path::new("/a b")), "file:///a%20b");
        assert_eq!(uri_to_path("file://localhost/x/y"), Some(PathBuf::from("/x/y")));
        assert_eq!(uri_to_path("file:///x/%C3%BC"), Some(PathBuf::from("/x/ü")));
        assert_eq!(uri_to_path("jdt://contents/x"), None);
    }

    #[cfg(unix)]
    #[test]
    fn remote_hosts_are_not_local_paths() {
        assert_eq!(uri_to_path("file://server/share/a.ts"), None);
    }

    #[cfg(windows)]
    #[test]
    fn windows_uris() {
        for (uri, path) in [
            ("file:///C:/a%20b/c.rs", r"C:\a b\c.rs"),
            ("file:///c:/x/y.ts", r"C:\x\y.ts"),
            ("file:///c%3A/x/y.ts", r"C:\x\y.ts"),
            ("file:///C%3a/x", r"C:\x"),
            ("file://localhost/d:/x", r"D:\x"),
            ("file://server/share/a.ts", r"\\server\share\a.ts"),
            ("file://server/share/a%20b/c.ts", r"\\server\share\a b\c.ts"),
            ("file:////server/share/a.ts", r"\\server\share\a.ts"),
        ] {
            let got = uri_to_path(uri).unwrap();
            assert_eq!(got.as_os_str(), path, "{uri}");
        }
        assert_eq!(uri_to_path("file://server"), None);
        for (path, uri, back) in [
            (r"C:\a b\c.rs", "file:///C:/a%20b/c.rs", r"C:\a b\c.rs"),
            (r"\\?\C:\x\y.ts", "file:///C:/x/y.ts", r"C:\x\y.ts"),
            (r"\\server\share\a b.ts", "file://server/share/a%20b.ts", r"\\server\share\a b.ts"),
            (r"\\?\UNC\server\share\a.ts", "file://server/share/a.ts", r"\\server\share\a.ts"),
        ] {
            assert_eq!(path_to_uri(Path::new(path)).as_str(), uri, "{path}");
            assert_eq!(uri_to_path(uri).unwrap().as_os_str(), back, "{path}");
        }
    }

    #[test]
    fn virtual_targets() {
        let jdt = "jdt://contents/rt.jar/java.lang/String.class?=p/%5C/x.jar%3Cjava.lang(String.class";
        assert_eq!(uri_target(jdt), (PathBuf::from(jdt), Some(jdt.to_owned())));
        #[cfg(unix)]
        assert_eq!(uri_target("file:///a/b.rs"), (PathBuf::from("/a/b.rs"), None));
        assert!(is_virtual_uri(jdt));
        assert!(is_virtual_uri("untitled:Untitled-1"));
        assert!(!is_virtual_uri("file:///a"));
        assert!(!is_virtual_uri("/a/b:c"));
        assert!(!is_virtual_uri("C:\\x\\y"));
    }
}
