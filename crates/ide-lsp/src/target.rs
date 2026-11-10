//! Protocol mapping for a stdio server inside a plugin target.
use ide_core::path_mapping::{Direction, file_path, file_uri, rewrite_strings};
use ide_jsonrpc::MessageTransform;
use ide_language::ServerTarget;
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use serde_json::Value;

pub(crate) fn virtual_prefix(target: &ServerTarget) -> String {
    format!(
        "openidea-target://{}/{}/",
        utf8_percent_encode(&target.id, NON_ALPHANUMERIC),
        target.origin.map_or(0, |id| id.0)
    )
}

pub(crate) fn external_path(target: &ServerTarget, uri: &str) -> Option<String> {
    let path = file_path(&format!("file:///{}", uri.strip_prefix(&virtual_prefix(target))?))?;
    (path.starts_with('/')
        && !path.split('/').any(|s| s == ".." || s == ".")
        && target.mapping.map(&file_uri(&path), Direction::ToHost).is_none())
    .then_some(path)
}

fn suffix(uri: &str) -> &str {
    uri.find(['?', '#']).map(|i| &uri[i..]).unwrap_or("")
}

pub(crate) struct TargetTransform(pub ServerTarget);

impl MessageTransform for TargetTransform {
    fn outgoing(&self, value: &mut Value) {
        rewrite_strings(value, &|s| {
            // A container library path may happen to have the host root's spelling.
            external_path(&self.0, s)
                .map(|p| format!("{}{}", file_uri(&p), suffix(s)))
                .or_else(|| self.0.mapping.map(s, Direction::ToTarget))
        });
    }

    fn incoming(&self, value: &mut Value) {
        rewrite_strings(value, &|s| {
            if let Some(mapped) = self.0.mapping.map(s, Direction::ToHost) {
                return Some(mapped);
            }
            let path = file_path(s)?;
            if !path.starts_with('/') || path.split('/').any(|p| p == ".." || p == ".") {
                return None;
            }
            let uri = file_uri(&path);
            Some(format!("{}{}{}", virtual_prefix(&self.0), uri.strip_prefix("file:///")?, suffix(s)))
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ide_core::path_mapping::PathMapping;
    use serde_json::json;

    #[test]
    fn external_uris_are_virtual_but_plain_outside_paths_and_opaque_values_stay_intact() {
        let target = ServerTarget {
            id: "plugin-target:example".into(),
            origin: Some(ide_core::ServerId(7)),
            project_root: "/host/project".into(),
            container_root: "/container".into(),
            mapping: PathMapping::new("/host/project", "/container"),
        };
        let mapper = TargetTransform(target.clone());
        let mut value = json!({"uri":"file:///container/a%20b.php", "relatedInformation":[{"location":{"uri":"file:///usr/lib/a%20b.php"}}],
            "data":{"uri":"file:///container/a.php"}, "command":{"arguments":["/container/a.php"]}, "path":"/usr/lib/a.php", "link":"file:///usr/lib/a.php#L12", "alias":"file:///host/project/std.php"});
        mapper.incoming(&mut value);
        assert_eq!(value["uri"], "file:///host/project/a%20b.php");
        let external = value["relatedInformation"][0]["location"]["uri"].as_str().unwrap();
        assert!(external.starts_with("openidea-target:"));
        assert_eq!(external_path(&target, external).unwrap(), "/usr/lib/a b.php");
        let other = ServerTarget { origin: Some(ide_core::ServerId(8)), ..target.clone() };
        assert!(external_path(&other, external).is_none());
        assert!(value["link"].as_str().unwrap().ends_with("#L12"));
        assert_eq!(value["path"], "/usr/lib/a.php");
        assert_eq!(value["data"]["uri"], "file:///container/a.php");
        assert_eq!(value["command"]["arguments"][0], "/container/a.php");
        mapper.outgoing(&mut value);
        assert_eq!(value["uri"], "file:///container/a%20b.php");
        assert_eq!(value["relatedInformation"][0]["location"]["uri"], "file:///usr/lib/a%20b.php");
        assert_eq!(value["link"], "file:///usr/lib/a.php#L12");
        assert_eq!(value["alias"], "file:///host/project/std.php");
        let mut configuration =
            json!({"result":[{"path":"/host/project/vendor","uris":["file:///host/project/vendor/a.php"]}]});
        mapper.outgoing(&mut configuration);
        assert_eq!(configuration["result"][0]["path"], "/container/vendor");
        assert_eq!(configuration["result"][0]["uris"][0], "file:///container/vendor/a.php");
    }
}
