//! Environments (`http-client.env.json`, `http-client.private.env.json`) and
//! `{{variable}}` substitution.
//!
//! ```json
//! { "$shared": { "version": "v1" }, "dev": { "host": "localhost:8080" } }
//! ```
//!
//! Lookup order for `{{name}}`: file variables (`@name = …`), the private
//! environment, the public environment, private `$shared`, public `$shared`.
//! Dynamic variables: `$uuid` / `$random.uuid`, `$timestamp`, `$isoTimestamp`,
//! `$randomInt` / `$random.integer`.

use ide_core::{IdeError, IdeResult};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};

pub const PUBLIC_FILE: &str = "http-client.env.json";
pub const PRIVATE_FILE: &str = "http-client.private.env.json";
const SHARED: &str = "$shared";

type EnvMap = BTreeMap<String, BTreeMap<String, String>>;

/// The environment files that apply to a request file.
#[derive(Debug, Default, Clone)]
pub struct Environments {
    public: EnvMap,
    private: EnvMap,
}

/// Folders searched for env files: the request file's folder and its
/// ancestors up to (and including) `root`; `root` itself when the file is outside it.
fn search_dirs(file: Option<&Path>, root: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(mut dir) = file.and_then(Path::parent) {
        loop {
            dirs.push(dir.to_path_buf());
            if root.is_none_or(|r| dir == r || !dir.starts_with(r)) {
                break;
            }
            match dir.parent() {
                Some(p) => dir = p,
                None => break,
            }
        }
    }
    if let Some(r) = root
        && !dirs.iter().any(|d| d == r)
    {
        dirs.push(r.to_path_buf());
    }
    dirs
}

fn parse_env(text: &str) -> IdeResult<EnvMap> {
    // Editors on Windows (Notepad) save UTF-8 with a byte order mark, which serde_json rejects.
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|e| IdeError::invalid(format!("invalid environment file: {e}")))?;
    let mut out = EnvMap::new();
    let Some(envs) = value.as_object() else { return Ok(out) };
    for (env, vars) in envs {
        let Some(vars) = vars.as_object() else { continue };
        let mut map = BTreeMap::new();
        for (k, v) in vars {
            let s = match v {
                serde_json::Value::String(s) => s.clone(),
                serde_json::Value::Number(n) => n.to_string(),
                serde_json::Value::Bool(b) => b.to_string(),
                // Objects configure SSL / auth in IDEA; not variables.
                _ => continue,
            };
            map.insert(k.clone(), s);
        }
        out.insert(env.clone(), map);
    }
    Ok(out)
}

/// The nearest `name` in `dirs`, decoded like the editor opens it (a BOM, UTF-16, or a
/// legacy encoding such as GBK from Notepad's ANSI), so a file that shows fine in the editor
/// is never skipped as unreadable.
fn read_first(dirs: &[PathBuf], name: &str) -> IdeResult<EnvMap> {
    for d in dirs {
        let p = d.join(name);
        if !p.is_file() {
            continue;
        }
        let text = ide_vfs::load_text(&p).map_err(|e| IdeError::invalid(format!("{}: {}", p.display(), e.message)))?;
        return parse_env(&text.text).map_err(|e| IdeError::invalid(format!("{}: {}", p.display(), e.message)));
    }
    Ok(EnvMap::new())
}

/// The public (or private) environment file that applies to `file`: the nearest existing one,
/// else a new one next to `file` holding a sample environment to fill in.
pub fn environment_file(file: &Path, root: Option<&Path>, private: bool) -> IdeResult<PathBuf> {
    let name = if private { PRIVATE_FILE } else { PUBLIC_FILE };
    if let Some(found) = search_dirs(Some(file), root).into_iter().map(|d| d.join(name)).find(|p| p.is_file()) {
        return Ok(found);
    }
    let dir = file.parent().ok_or_else(|| IdeError::invalid("the request file has no folder"))?;
    let path = dir.join(name);
    std::fs::write(&path, "{\n  \"dev\": {\n    \"name\": \"value\"\n  }\n}\n")
        .map_err(|e| IdeError::internal(format!("cannot create {}: {e}", path.display())))?;
    Ok(path)
}

/// Where `{{name}}` is defined in the environment files that apply to `file`: the key `name`
/// in each environment (and `$shared`) of the nearest private file, then of the nearest public
/// file — the lookup order. Positions are 0-based lines and UTF-16 columns of the key, quotes
/// included.
pub fn variable_definitions(file: &Path, root: Option<&Path>, name: &str) -> Vec<ide_core::Location> {
    let dirs = search_dirs(Some(file), root);
    let mut out = Vec::new();
    for file_name in [PRIVATE_FILE, PUBLIC_FILE] {
        let Some(path) = dirs.iter().map(|d| d.join(file_name)).find(|p| p.is_file()) else { continue };
        let Ok(text) = ide_vfs::load_text(&path) else { continue };
        for range in environment_keys(&text.text, name) {
            out.push(ide_core::Location { path: path.clone().into(), range, uri: None });
        }
    }
    out
}

/// The ranges of keys equal to `name` one level inside the top-level object (an
/// environment's variables), found by scanning the JSON text without building a value.
fn environment_keys(text: &str, name: &str) -> Vec<ide_core::Range> {
    use ide_core::{Pos, Range};
    let mut found = Vec::new();
    let (mut line, mut col) = (0u32, 0u32);
    let mut depth = 0usize;
    let mut chars = text.char_indices().peekable();
    // Whether the last string closed at depth 2 may be a key: set after `{` or `,`.
    let mut expect_key = false;
    while let Some((_, c)) = chars.next() {
        match c {
            '"' => {
                let start = Pos::new(line, col);
                col += 1;
                let mut value = String::new();
                let mut escaped = false;
                for (_, c) in chars.by_ref() {
                    col += c.len_utf16() as u32;
                    if escaped {
                        value.push(match c {
                            'n' => '\n',
                            't' => '\t',
                            other => other,
                        });
                        escaped = false;
                    } else if c == '\\' {
                        escaped = true;
                    } else if c == '"' {
                        break;
                    } else {
                        value.push(c);
                    }
                }
                let end = Pos::new(line, col);
                if depth == 2 && expect_key && value == name {
                    let mut rest = chars.clone();
                    while rest.peek().is_some_and(|(_, c)| c.is_whitespace()) {
                        rest.next();
                    }
                    if rest.peek().is_some_and(|(_, c)| *c == ':') {
                        found.push(Range { start, end });
                    }
                }
                expect_key = false;
                continue;
            }
            '{' | '[' => {
                depth += 1;
                expect_key = c == '{';
            }
            '}' | ']' => depth = depth.saturating_sub(1),
            ',' => expect_key = true,
            ':' => expect_key = false,
            '\n' => {
                line += 1;
                col = 0;
                continue;
            }
            _ => {}
        }
        col += c.len_utf16() as u32;
    }
    found
}

impl Environments {
    pub fn load(file: Option<&Path>, root: Option<&Path>) -> IdeResult<Self> {
        let dirs = search_dirs(file, root);
        Ok(Self { public: read_first(&dirs, PUBLIC_FILE)?, private: read_first(&dirs, PRIVATE_FILE)? })
    }

    pub fn from_json(public: &str, private: &str) -> IdeResult<Self> {
        let p = |s: &str| if s.trim().is_empty() { Ok(EnvMap::new()) } else { parse_env(s) };
        Ok(Self { public: p(public)?, private: p(private)? })
    }

    /// Environment names (excluding `$shared`), sorted.
    pub fn names(&self) -> Vec<String> {
        let set: BTreeSet<&String> = self.public.keys().chain(self.private.keys()).filter(|k| *k != SHARED).collect();
        set.into_iter().cloned().collect()
    }

    /// Variables of `env` merged in lookup order (first wins).
    pub fn variables(&self, env: Option<&str>) -> HashMap<String, String> {
        let mut out = HashMap::new();
        let mut layer = |m: Option<&BTreeMap<String, String>>| {
            for (k, v) in m.into_iter().flatten() {
                out.entry(k.clone()).or_insert_with(|| v.clone());
            }
        };
        if let Some(env) = env {
            layer(self.private.get(env));
            layer(self.public.get(env));
        }
        layer(self.private.get(SHARED));
        layer(self.public.get(SHARED));
        out
    }
}

fn dynamic(name: &str) -> Option<String> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    match name {
        "$uuid" | "$random.uuid" => Some(uuid::Uuid::new_v4().to_string()),
        "$timestamp" => Some(now.as_secs().to_string()),
        "$isoTimestamp" => Some(iso8601(now.as_secs())),
        "$randomInt" | "$random.integer" | "$random.integer()" => {
            Some((uuid::Uuid::new_v4().as_u128() % 1000).to_string())
        }
        _ => None,
    }
}

/// `secs` since the epoch as `YYYY-MM-DDTHH:MM:SSZ` (UTC).
fn iso8601(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// Resolves `{{name}}` references. File variables may reference other
/// variables; unresolved names are collected in `missing` and left as written.
pub struct Resolver<'a> {
    pub file_vars: &'a [(String, String)],
    pub env: HashMap<String, String>,
}

impl Resolver<'_> {
    fn lookup(&self, name: &str, depth: u32, missing: &mut BTreeSet<String>) -> Option<String> {
        if let Some((_, v)) = self.file_vars.iter().rev().find(|(k, _)| k == name) {
            return Some(if depth < 8 { self.substitute_inner(v, depth + 1, missing) } else { v.clone() });
        }
        if let Some(v) = self.env.get(name) {
            return Some(if depth < 8 { self.substitute_inner(v, depth + 1, missing) } else { v.clone() });
        }
        dynamic(name)
    }

    fn substitute_inner(&self, text: &str, depth: u32, missing: &mut BTreeSet<String>) -> String {
        let mut out = String::with_capacity(text.len());
        let mut rest = text;
        while let Some(start) = rest.find("{{") {
            out.push_str(&rest[..start]);
            let after = &rest[start + 2..];
            let Some(end) = after.find("}}") else {
                out.push_str(&rest[start..]);
                return out;
            };
            let name = after[..end].trim();
            match self.lookup(name, depth, missing) {
                Some(v) => out.push_str(&v),
                None => {
                    missing.insert(name.to_owned());
                    out.push_str(&rest[start..start + 2 + end + 2]);
                }
            }
            rest = &after[end + 2..];
        }
        out.push_str(rest);
        out
    }

    pub fn substitute(&self, text: &str, missing: &mut BTreeSet<String>) -> String {
        self.substitute_inner(text, 0, missing)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_variable_keys_in_every_environment_private_first() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("api")).unwrap();
        std::fs::write(
            root.join(PUBLIC_FILE),
            "{\n  \"$shared\": { \"host\": \"shared\" },\n  \"dev\": {\n    \"name\": \"host\",\n    \"host\": \"localhost\",\n    \"ssl\": { \"host\": \"nested\" }\n  },\n  \"prod\": { \"hostname\": \"x\", \"host\": \"example.com\" }\n}\n",
        )
        .unwrap();
        std::fs::write(root.join("api").join(PRIVATE_FILE), "{ \"dev\": { \"😀\": 1, \"host\": \"secret\" } }")
            .unwrap();
        let file = root.join("api").join("requests.http");
        let found = variable_definitions(&file, Some(root), "host");
        let at: Vec<_> = found
            .iter()
            .map(|l| {
                (
                    l.path.0.file_name().unwrap().to_string_lossy().into_owned(),
                    l.range.start.line,
                    l.range.start.col,
                    l.range.end.col,
                )
            })
            .collect();
        assert_eq!(
            at,
            vec![
                (PRIVATE_FILE.to_owned(), 0, 20, 26),
                (PUBLIC_FILE.to_owned(), 1, 15, 21),
                (PUBLIC_FILE.to_owned(), 4, 4, 10),
                (PUBLIC_FILE.to_owned(), 7, 29, 35),
            ],
            "values and nested objects are not definitions"
        );
        assert!(variable_definitions(&file, Some(root), "missing").is_empty());
    }

    #[test]
    fn merges_private_public_and_shared() {
        let envs = Environments::from_json(
            r#"{"$shared":{"v":"1","host":"shared"},"dev":{"host":"localhost","port":8080,"ssl":{"x":1}},"prod":{}}"#,
            r#"{"dev":{"token":"secret"},"$shared":{"v":"2"}}"#,
        )
        .unwrap();
        assert_eq!(envs.names(), vec!["dev", "prod"]);
        let vars = envs.variables(Some("dev"));
        assert_eq!(vars["host"], "localhost");
        assert_eq!(vars["port"], "8080");
        assert_eq!(vars["token"], "secret");
        assert_eq!(vars["v"], "2");
        assert!(!vars.contains_key("ssl"));
        assert_eq!(envs.variables(None)["host"], "shared");
    }

    #[test]
    fn substitutes_file_env_and_dynamic_variables() {
        let file_vars = vec![("base".to_owned(), "https://{{host}}".to_owned())];
        let env = HashMap::from([("host".to_owned(), "example.com".to_owned())]);
        let r = Resolver { file_vars: &file_vars, env };
        let mut missing = BTreeSet::new();
        assert_eq!(r.substitute("{{ base }}/a?x={{nope}}", &mut missing), "https://example.com/a?x={{nope}}");
        assert_eq!(missing.into_iter().collect::<Vec<_>>(), vec!["nope"]);
        let mut missing = BTreeSet::new();
        let id = r.substitute("{{$uuid}}", &mut missing);
        assert_eq!(id.len(), 36);
        assert!(missing.is_empty());
        assert_eq!(r.substitute("{{unterminated", &mut missing), "{{unterminated");
    }

    #[test]
    fn self_reference_terminates() {
        let file_vars = vec![("a".to_owned(), "{{a}}".to_owned())];
        let r = Resolver { file_vars: &file_vars, env: HashMap::new() };
        let mut missing = BTreeSet::new();
        assert_eq!(r.substitute("{{a}}", &mut missing), "{{a}}");
    }

    #[test]
    fn iso_timestamps() {
        assert_eq!(iso8601(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601(1_700_000_000), "2023-11-14T22:13:20Z");
    }

    #[test]
    fn finds_env_files_in_ancestors_up_to_root() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("api/v1")).unwrap();
        std::fs::write(root.join(PUBLIC_FILE), r#"{"dev":{"host":"root"}}"#).unwrap();
        std::fs::write(root.join("api").join(PRIVATE_FILE), r#"{"dev":{"token":"t"}}"#).unwrap();
        let envs = Environments::load(Some(&root.join("api/v1/a.http")), Some(root)).unwrap();
        let vars = envs.variables(Some("dev"));
        assert_eq!(vars["host"], "root");
        assert_eq!(vars["token"], "t");
        // A scratch file outside the project still sees the project's environments.
        let other = tempfile::tempdir().unwrap();
        let envs = Environments::load(Some(&other.path().join("s.http")), Some(root)).unwrap();
        assert_eq!(envs.names(), vec!["dev"]);
    }

    #[test]
    fn reads_env_files_in_the_encodings_windows_editors_save() {
        let utf16: Vec<u8> = [0xFF, 0xFE]
            .into_iter()
            .chain("{\"dev\":{\"name\":\"测试环境\"}}".encode_utf16().flat_map(u16::to_le_bytes))
            .collect();
        // Notepad's "ANSI" on a Chinese system: GBK.
        let gbk: Vec<u8> =
            [&b"{\"dev\":{\"name\":\""[..], &[0xB2, 0xE2, 0xCA, 0xD4, 0xBB, 0xB7, 0xBE, 0xB3], b"\"}}"].concat();
        for bytes in ["\u{feff}{\"dev\":{\"name\":\"测试环境\"}}".as_bytes().to_vec(), utf16, gbk] {
            let tmp = tempfile::tempdir().unwrap();
            std::fs::write(tmp.path().join(PUBLIC_FILE), &bytes).unwrap();
            let envs = Environments::load(Some(&tmp.path().join("a.http")), Some(tmp.path())).unwrap();
            assert_eq!(envs.names(), vec!["dev"]);
            assert_eq!(envs.variables(Some("dev"))["name"], "测试环境");
        }
    }

    #[test]
    fn an_environment_file_is_found_up_the_tree_or_created_next_to_the_request() {
        let tmp = tempfile::tempdir().unwrap();
        let api = tmp.path().join("api");
        std::fs::create_dir_all(&api).unwrap();
        let request = api.join("a.http");
        std::fs::write(tmp.path().join(PUBLIC_FILE), "{}").unwrap();
        assert_eq!(environment_file(&request, Some(tmp.path()), false).unwrap(), tmp.path().join(PUBLIC_FILE));
        let private = environment_file(&request, Some(tmp.path()), true).unwrap();
        assert_eq!(private, api.join(PRIVATE_FILE));
        let envs = Environments::load(Some(&request), Some(tmp.path())).unwrap();
        assert_eq!(envs.names(), vec!["dev"], "the new file is a valid environment file");
    }
}
