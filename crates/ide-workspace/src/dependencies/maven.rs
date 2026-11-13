//! Maven Central lookups for POM coordinate completion: the search endpoint's
//! group and artifact suggestions, and the published version metadata of one
//! artifact. The URLs and parsers are pure; the host op fetches and caches.
use serde::Deserialize;

/// The search endpoint's `docs` of one artifact coordinate each.
#[derive(Deserialize)]
struct SearchResponse {
    #[serde(rename = "response")]
    docs: SearchDocs,
}

#[derive(Deserialize)]
struct SearchDocs {
    docs: Vec<SearchDoc>,
}

#[derive(Deserialize)]
struct SearchDoc {
    g: String,
    a: String,
}

/// Percent-encodes a query value; repository coordinates are ASCII words with
/// `.` and `-`, so only a few characters ever get encoded.
fn encoded(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// A coordinate part a Central query may carry: repository ids are ASCII words
/// with `.` and `-`, never whitespace, quotes or control characters.
fn part(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '~'))
}

/// The search endpoint querying the group ids matching a typed prefix
/// (`g:org.apache.ma*`), most recently updated first.
pub fn groups_url(prefix: &str) -> Option<String> {
    part(prefix, 100)
        .then(|| format!("https://search.maven.org/solrsearch/select?q=g:{}*&rows=40&wt=json", encoded(prefix)))
}

/// The search endpoint querying the artifacts of one group matching a typed
/// prefix (`g:"org.apache.maven" AND a:maven-c*`); an empty prefix asks the
/// group's artifacts without a wildcard.
pub fn artifacts_url(group: &str, prefix: &str) -> Option<String> {
    (part(group, 200) && (prefix.is_empty() || part(prefix, 100))).then(|| {
        let tail = if prefix.is_empty() { String::new() } else { format!("%20AND%20a:{}*", encoded(prefix)) };
        format!("https://search.maven.org/solrsearch/select?q=g:%22{}%22{tail}&rows=30&wt=json", encoded(group))
    })
}

/// The published version metadata of one artifact on Central.
pub fn metadata_url(group: &str, artifact: &str) -> Option<String> {
    (part(group, 200) && part(artifact, 100)).then(|| {
        let path = group.split('.').chain(artifact.split('.')).collect::<Vec<_>>().join("/");
        format!("https://repo1.maven.org/maven2/{path}/maven-metadata.xml")
    })
}

/// The distinct `g` values of a search response, in the response's order (score
/// descending); `None` when the document is not the shape the endpoint answers.
pub fn parse_search_groups(text: &str) -> Option<Vec<String>> {
    let docs: SearchResponse = serde_json::from_str(text).ok()?;
    let mut out = Vec::new();
    for doc in docs.docs.docs {
        if doc.g.len() <= 200 && !out.contains(&doc.g) {
            out.push(doc.g);
        }
    }
    Some(out)
}

/// The distinct `a` values of a search response, in the response's order.
pub fn parse_search_artifacts(text: &str) -> Option<Vec<String>> {
    let docs: SearchResponse = serde_json::from_str(text).ok()?;
    let mut out = Vec::new();
    for doc in docs.docs.docs {
        if doc.a.len() <= 100 && !out.contains(&doc.a) {
            out.push(doc.a);
        }
    }
    Some(out)
}

/// The `<versions>` of an artifact's `maven-metadata.xml`, newest first (the
/// document lists them oldest first). A malformed document yields none.
pub fn parse_metadata_versions(text: &str) -> Vec<String> {
    let Some((_, after)) = text.split_once("<versions>") else { return Vec::new() };
    let Some((inner, _)) = after.split_once("</versions>") else { return Vec::new() };
    let mut out = Vec::new();
    let mut rest = inner;
    while let Some((_, after)) = rest.split_once("<version>") {
        let Some((value, tail)) = after.split_once("</version>") else { break };
        let value = value.trim();
        if !value.is_empty() && value.len() <= 100 && out.last().is_none_or(|last| last != value) {
            out.push(value.to_owned());
        }
        rest = tail;
    }
    out.reverse();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_urls_encode_the_query() {
        assert_eq!(
            groups_url("org.apache.ma").as_deref(),
            Some("https://search.maven.org/solrsearch/select?q=g:org.apache.ma*&rows=40&wt=json")
        );
        assert_eq!(
            artifacts_url("org.apache.maven", "maven-c").as_deref(),
            Some(
                "https://search.maven.org/solrsearch/select?q=g:%22org.apache.maven%22%20AND%20a:maven-c*&rows=30&wt=json"
            )
        );
        // An empty prefix asks the group's artifacts without a wildcard.
        assert_eq!(
            artifacts_url("org.example", "").as_deref(),
            Some("https://search.maven.org/solrsearch/select?q=g:%22org.example%22&rows=30&wt=json")
        );
        // A quote, a space or a traversal in the coordinates drops the query.
        assert_eq!(groups_url("org.apache\"ma"), None);
        assert_eq!(groups_url(""), None);
        assert_eq!(artifacts_url("org/../etc", "a"), None);
        assert_eq!(artifacts_url("org.example", "a b"), None);
        assert_eq!(metadata_url("org.example", "lib/../.."), None);
    }

    #[test]
    fn metadata_url_paths_the_group() {
        assert_eq!(
            metadata_url("org.apache.maven", "maven-core").as_deref(),
            Some("https://repo1.maven.org/maven2/org/apache/maven/maven-core/maven-metadata.xml")
        );
    }

    #[test]
    fn search_response_parses_distinct_coordinates() {
        let doc = r#"{"response":{"numFound":2,"docs":[
            {"g":"org.example","a":"lib","latestVersion":"2.0"},
            {"g":"org.example","a":"lib"},
            {"g":"org.example","a":"lib-other"}]}}"#;
        assert_eq!(parse_search_groups(doc).unwrap(), ["org.example"]);
        assert_eq!(parse_search_artifacts(doc).unwrap(), ["lib", "lib-other"]);
        assert_eq!(parse_search_groups("not json"), None);
    }

    #[test]
    fn metadata_versions_read_newest_first() {
        let metadata = r#"<?xml version="1.0"?>
<metadata>
  <groupId>org.example</groupId>
  <artifactId>lib</artifactId>
  <versioning>
    <latest>2.0</latest>
    <versions>
      <version>1.0</version>
      <version>1.9.1</version>
      <version>2.0-beta-1</version>
      <version>2.0</version>
    </versions>
  </versioning>
</metadata>"#;
        assert_eq!(parse_metadata_versions(metadata), ["2.0", "2.0-beta-1", "1.9.1", "1.0"]);
        assert!(parse_metadata_versions("<metadata><groupId>x</groupId></metadata>").is_empty());
        assert!(parse_metadata_versions("").is_empty());
    }
}
