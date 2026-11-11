//! Project generation services: their metadata becomes form fields, and the
//! project is the zip they build from the field values.

use crate::model::{ChoiceOption, Dependency, DependencyGroup, Field, FieldKind, Provider, Values};
use ide_core::{CancellationToken, IdeError, IdeResult};
use ide_tools::Http;
use serde_json::Value;
use std::collections::BTreeMap;

pub(crate) const SPRING_DEFAULT: &str = "https://start.spring.io";
const QUARKUS: &str = "https://code.quarkus.io";
const MICRONAUT: &str = "https://launch.micronaut.io";

fn http() -> IdeResult<Http> {
    Http::new(&ide_core::process::host_var_os("PATH").unwrap_or_default())
}

fn get_json(url: &str, accept: &'static str, cancel: &CancellationToken) -> IdeResult<Value> {
    let text = http()?.accept(accept).get_text(url, cancel)?;
    serde_json::from_str(&text).map_err(|e| IdeError::new(ide_core::error::ErrorKind::Protocol, format!("{url}: {e}")))
}

/// The Spring Initializr server: the `server` field, `https://` added when it has no scheme.
pub(crate) fn spring_server(values: &Values) -> String {
    let server = values.get("server").map(|s| s.trim().trim_end_matches('/')).unwrap_or_default();
    if server.is_empty() {
        SPRING_DEFAULT.to_owned()
    } else if server.contains("://") {
        server.to_owned()
    } else {
        format!("https://{server}")
    }
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn choice(id: &str, label: &str, options: Vec<ChoiceOption>, default: String, segmented: bool) -> Field {
    Field {
        id: id.into(),
        label: label.into(),
        kind: FieldKind::Choice { options, segmented },
        default,
        visible: BTreeMap::new(),
        hint: String::new(),
    }
}

fn dependencies(id: &str, label: &str, groups: Vec<DependencyGroup>) -> Field {
    Field {
        id: id.into(),
        label: label.into(),
        kind: FieldKind::Dependencies { groups },
        default: String::new(),
        visible: BTreeMap::new(),
        hint: String::new(),
    }
}

/// An initializr single-select (`{ default, values: [{ id, name }] }`) as a choice.
fn spring_select(meta: &Value, key: &str, id: &str, label: &str, segmented: bool) -> Option<Field> {
    let select = meta.get(key)?;
    let options: Vec<ChoiceOption> = select
        .get("values")?
        .as_array()?
        .iter()
        .filter(|v| key != "type" || v.pointer("/tags/format").and_then(Value::as_str) == Some("project"))
        .map(|v| ChoiceOption { value: str_of(v, "id").into(), label: str_of(v, "name").into() })
        .collect();
    let default = str_of(select, "default");
    let default = if options.iter().any(|o| o.value == default) {
        default.to_owned()
    } else {
        options.first().map(|o| o.value.clone()).unwrap_or_default()
    };
    Some(choice(id, label, options, default, segmented))
}

fn spring_fields(meta: &Value) -> Vec<Field> {
    let mut out: Vec<Field> = [
        ("language", "language", "Language:", true),
        ("type", "type", "Type:", true),
        ("bootVersion", "bootVersion", "Spring Boot:", false),
        ("javaVersion", "javaVersion", "Java:", false),
        ("packaging", "packaging", "Packaging:", true),
        ("configurationFileFormat", "configurationFileFormat", "Configuration:", true),
    ]
    .into_iter()
    .filter_map(|(key, id, label, segmented)| spring_select(meta, key, id, label, segmented))
    .collect();
    let groups = meta
        .pointer("/dependencies/values")
        .and_then(Value::as_array)
        .map(|groups| {
            groups
                .iter()
                .map(|g| DependencyGroup {
                    name: str_of(g, "name").into(),
                    items: g
                        .get("values")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .map(|d| Dependency {
                            id: str_of(d, "id").into(),
                            name: str_of(d, "name").into(),
                            description: str_of(d, "description").into(),
                        })
                        .collect(),
                })
                .collect()
        })
        .unwrap_or_default();
    out.push(dependencies("dependencies", "Dependencies:", groups));
    out
}

fn quarkus_fields(streams: &Value, extensions: &Value) -> Vec<Field> {
    let streams = streams.as_array().cloned().unwrap_or_default();
    let recommended = streams.iter().find(|s| s.get("recommended") == Some(&Value::Bool(true))).or(streams.first());
    let options = streams
        .iter()
        .map(|s| {
            let key = str_of(s, "key");
            let version = key.rsplit(':').next().unwrap_or(key);
            let label = if s.get("recommended") == Some(&Value::Bool(true)) {
                format!("{version} (recommended)")
            } else {
                version.to_owned()
            };
            ChoiceOption { value: key.into(), label }
        })
        .collect();
    let mut out = vec![choice(
        "stream",
        "Quarkus:",
        options,
        recommended.map(|s| str_of(s, "key").to_owned()).unwrap_or_default(),
        false,
    )];
    if let Some(java) = recommended.and_then(|s| s.get("javaCompatibility")) {
        let versions = java.get("versions").and_then(Value::as_array).cloned().unwrap_or_default();
        let options: Vec<ChoiceOption> =
            versions.iter().rev().map(|v| ChoiceOption { value: v.to_string(), label: v.to_string() }).collect();
        let default = java.get("recommended").map(Value::to_string).unwrap_or_default();
        out.push(choice("javaVersion", "Java:", options, default, false));
    }
    let mut groups: Vec<DependencyGroup> = Vec::new();
    let mut items: Vec<&Value> = extensions.as_array().map(|a| a.iter().collect()).unwrap_or_default();
    items.sort_by_key(|e| e.get("order").and_then(Value::as_i64).unwrap_or(i64::MAX));
    for e in items {
        let category = match e.get("category") {
            Some(Value::Object(c)) => c.get("name").and_then(Value::as_str).unwrap_or_default().to_owned(),
            Some(Value::String(c)) => c.clone(),
            _ => String::new(),
        };
        let dep = Dependency {
            id: str_of(e, "id").into(),
            name: str_of(e, "name").into(),
            description: str_of(e, "description").into(),
        };
        match groups.iter_mut().find(|g| g.name == category) {
            Some(g) => g.items.push(dep),
            None => groups.push(DependencyGroup { name: category, items: vec![dep] }),
        }
    }
    out.push(dependencies("dependencies", "Extensions:", groups));
    out
}

fn micronaut_select(
    options: &Value,
    key: &str,
    id: &str,
    label: &str,
    skip: &[&str],
    segmented: bool,
) -> Option<Field> {
    let select = options.get(key)?;
    let opts: Vec<ChoiceOption> = select
        .get("options")?
        .as_array()?
        .iter()
        .filter(|o| !skip.contains(&str_of(o, "value")))
        .map(|o| ChoiceOption { value: str_of(o, "value").into(), label: str_of(o, "label").into() })
        .collect();
    let default = select.pointer("/defaultOption/value").and_then(Value::as_str).unwrap_or_default();
    let default = if opts.iter().any(|o| o.value == default) {
        default.to_owned()
    } else {
        opts.first().map(|o| o.value.clone()).unwrap_or_default()
    };
    Some(choice(id, label, opts, default, segmented))
}

fn micronaut_fields(options: &Value, features: &Value) -> Vec<Field> {
    let mut out: Vec<Field> = [
        ("type", "type", "Application type:", &[][..], false),
        ("lang", "lang", "Language:", &["PYTHON"][..], true),
        ("build", "build", "Build system:", &["PYRONAUT"][..], true),
        ("test", "test", "Test framework:", &["PYTEST"][..], true),
        ("jdkVersion", "javaVersion", "Java:", &[][..], false),
    ]
    .into_iter()
    .filter_map(|(key, id, label, skip, segmented)| micronaut_select(options, key, id, label, skip, segmented))
    .collect();
    let mut groups: Vec<DependencyGroup> = Vec::new();
    for f in features.get("features").and_then(Value::as_array).into_iter().flatten() {
        if f.get("preview") == Some(&Value::Bool(true)) {
            continue;
        }
        let category = str_of(f, "category").to_owned();
        let dep = Dependency {
            id: str_of(f, "name").into(),
            name: str_of(f, "title").into(),
            description: str_of(f, "description").into(),
        };
        match groups.iter_mut().find(|g| g.name == category) {
            Some(g) => g.items.push(dep),
            None => groups.push(DependencyGroup { name: category, items: vec![dep] }),
        }
    }
    groups.sort_by(|a, b| a.name.cmp(&b.name));
    out.push(dependencies("dependencies", "Features:", groups));
    out
}

/// The fields `provider`'s metadata adds to the form.
pub(crate) fn fields(provider: Provider, values: &Values, cancel: &CancellationToken) -> IdeResult<Vec<Field>> {
    match provider {
        Provider::SpringInitializr => {
            let meta = get_json(&spring_server(values), "application/vnd.initializr.v2.2+json", cancel)?;
            Ok(spring_fields(&meta))
        }
        Provider::Quarkus => {
            let streams = get_json(&format!("{QUARKUS}/api/streams"), "application/json", cancel)?;
            let extensions =
                get_json(&format!("{QUARKUS}/api/extensions?platformOnly=true"), "application/json", cancel)?;
            Ok(quarkus_fields(&streams, &extensions))
        }
        Provider::Micronaut => {
            let options = get_json(&format!("{MICRONAUT}/select-options"), "application/json", cancel)?;
            let features =
                get_json(&format!("{MICRONAUT}/application-types/default/features"), "application/json", cancel)?;
            Ok(micronaut_fields(&options, &features))
        }
    }
}

/// `s` percent-encoded for a URL query or path segment.
pub(crate) fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn query(pairs: &[(&str, &str)]) -> String {
    pairs.iter().filter(|(_, v)| !v.is_empty()).map(|(k, v)| format!("{k}={}", encode(v))).collect::<Vec<_>>().join("&")
}

fn selected(values: &Values) -> Vec<&str> {
    values
        .get("dependencies")
        .map(|d| d.split(',').map(str::trim).filter(|s| !s.is_empty()).collect())
        .unwrap_or_default()
}

/// Where `provider` builds the project zip for `values`.
pub(crate) fn download_url(provider: Provider, values: &Values) -> String {
    let v = |k: &str| values.get(k).map(String::as_str).unwrap_or_default();
    match provider {
        Provider::SpringInitializr => {
            let deps = selected(values).join(",");
            format!(
                "{}/starter.zip?{}",
                spring_server(values),
                query(&[
                    ("type", v("type")),
                    ("language", v("language")),
                    ("bootVersion", v("bootVersion")),
                    ("groupId", v("group")),
                    ("artifactId", v("artifact")),
                    ("name", v("name")),
                    ("packageName", v("package")),
                    ("packaging", v("packaging")),
                    ("javaVersion", v("javaVersion")),
                    ("configurationFileFormat", v("configurationFileFormat")),
                    ("dependencies", &deps),
                ])
            )
        }
        Provider::Quarkus => {
            let mut q = query(&[
                ("g", v("group")),
                ("a", v("artifact")),
                ("v", v("version")),
                ("b", v("build")),
                ("j", v("javaVersion")),
                ("S", v("stream")),
                ("cn", "openidea"),
            ]);
            for e in selected(values) {
                q.push_str(&format!("&e={}", encode(e)));
            }
            format!("{QUARKUS}/api/download?{q}")
        }
        Provider::Micronaut => {
            let app_type = v("type").to_lowercase();
            let mut q = query(&[
                ("lang", v("lang")),
                ("build", v("build")),
                ("test", v("test")),
                ("javaVersion", v("javaVersion")),
            ]);
            for f in selected(values) {
                q.push_str(&format!("&features={}", encode(f)));
            }
            let app = format!("{}.{}", v("group"), v("artifact"));
            format!(
                "{MICRONAUT}/create/{}/{}?{q}",
                encode(if app_type.is_empty() { "default" } else { &app_type }),
                encode(&app)
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn values(pairs: &[(&str, &str)]) -> Values {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn spring_server_defaults_and_adds_a_scheme() {
        assert_eq!(spring_server(&values(&[])), SPRING_DEFAULT);
        assert_eq!(spring_server(&values(&[("server", "start.aliyun.com/")])), "https://start.aliyun.com");
        assert_eq!(spring_server(&values(&[("server", "http://intranet:8080")])), "http://intranet:8080");
    }

    #[test]
    fn spring_metadata_becomes_fields() {
        let meta = json!({
            "type": { "default": "gradle-project", "values": [
                { "id": "gradle-project", "name": "Gradle - Groovy", "tags": { "format": "project" } },
                { "id": "gradle-build", "name": "Gradle Config", "tags": { "format": "build" } },
                { "id": "maven-project", "name": "Maven", "tags": { "format": "project" } }
            ]},
            "language": { "default": "java", "values": [{ "id": "java", "name": "Java" }, { "id": "kotlin", "name": "Kotlin" }] },
            "bootVersion": { "default": "9.9.9", "values": [{ "id": "4.1.2", "name": "4.1.2" }] },
            "dependencies": { "values": [{ "name": "Web", "values": [{ "id": "web", "name": "Spring Web", "description": "Build web apps" }] }] }
        });
        let fields = spring_fields(&meta);
        let ids: Vec<&str> = fields.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(ids, ["language", "type", "bootVersion", "dependencies"]);
        let FieldKind::Choice { options, .. } = &fields[1].kind else { panic!() };
        assert_eq!(options.iter().map(|o| o.value.as_str()).collect::<Vec<_>>(), ["gradle-project", "maven-project"]);
        // A default the values don't list falls back to the first value.
        assert_eq!(fields[2].default, "4.1.2");
        let FieldKind::Dependencies { groups } = &fields[3].kind else { panic!() };
        assert_eq!(groups[0].items[0].id, "web");
    }

    #[test]
    fn download_urls_encode_the_values() {
        let v = values(&[
            ("type", "maven-project"),
            ("language", "java"),
            ("group", "com.example"),
            ("artifact", "demo"),
            ("name", "My Demo"),
            ("package", "com.example.demo"),
            ("dependencies", "web, data-jpa"),
        ]);
        assert_eq!(
            download_url(Provider::SpringInitializr, &v),
            "https://start.spring.io/starter.zip?type=maven-project&language=java&groupId=com.example&artifactId=demo&name=My%20Demo&packageName=com.example.demo&dependencies=web%2Cdata-jpa"
        );
        let v = values(&[
            ("group", "org.acme"),
            ("artifact", "app"),
            ("build", "MAVEN"),
            ("dependencies", "io.quarkus:quarkus-rest"),
        ]);
        assert_eq!(
            download_url(Provider::Quarkus, &v),
            "https://code.quarkus.io/api/download?g=org.acme&a=app&b=MAVEN&cn=openidea&e=io.quarkus%3Aquarkus-rest"
        );
        let v = values(&[
            ("type", "DEFAULT"),
            ("group", "com.example"),
            ("artifact", "demo"),
            ("lang", "JAVA"),
            ("dependencies", "data-jdbc"),
        ]);
        assert_eq!(
            download_url(Provider::Micronaut, &v),
            "https://launch.micronaut.io/create/default/com.example.demo?lang=JAVA&features=data-jdbc"
        );
    }

    #[test]
    fn quarkus_and_micronaut_metadata_become_fields() {
        let streams = json!([
            { "key": "io.quarkus.platform:3.40", "recommended": true, "javaCompatibility": { "versions": [17, 21, 25], "recommended": 25 } },
            { "key": "io.quarkus.platform:3.33", "recommended": false }
        ]);
        let extensions = json!([
            { "id": "io.quarkus:quarkus-rest", "name": "REST", "description": "d", "category": { "name": "Web" }, "order": 0 }
        ]);
        let fields = quarkus_fields(&streams, &extensions);
        assert_eq!(fields[0].default, "io.quarkus.platform:3.40");
        assert_eq!(fields[1].default, "25");
        let FieldKind::Dependencies { groups } = &fields[2].kind else { panic!() };
        assert_eq!(groups[0].name, "Web");

        let options = json!({
            "lang": { "options": [{ "value": "JAVA", "label": "Java" }, { "value": "PYTHON", "label": "Python" }], "defaultOption": { "value": "JAVA" } }
        });
        let features = json!({ "features": [
            { "name": "data-jdbc", "title": "Micronaut Data JDBC", "description": "d", "category": "Database" },
            { "name": "x", "title": "X", "category": "Database", "preview": true }
        ]});
        let fields = micronaut_fields(&options, &features);
        let FieldKind::Choice { options, .. } = &fields[0].kind else { panic!() };
        assert_eq!(options.len(), 1);
        let FieldKind::Dependencies { groups } = &fields[1].kind else { panic!() };
        assert_eq!(groups[0].items.len(), 1);
    }
}
