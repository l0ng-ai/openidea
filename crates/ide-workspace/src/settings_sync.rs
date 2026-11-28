//! Settings Sync's data: the global settings and the frontend's IDE state as one JSON file per
//! category, without what must not leave this machine, and the three-way merge of those files.

use ide_core::settings::SettingsSyncSettings;
use serde_json::{Map, Value as Json};
use std::collections::BTreeMap;

pub const CATEGORIES: [&str; 7] = ["appearance", "editor", "keymaps", "other", "templates", "macros", "ui"];
/// Categories of the frontend's own storage (`key → text`); the others are global settings.
pub const STORAGE_CATEGORIES: [&str; 3] = ["templates", "macros", "ui"];

/// Global settings that never sync: Settings Sync's own, what this machine serves or reaches
/// (MCP server, remote development, proxy, SSH hosts, deployment servers, run targets), the
/// tools it runs (external tools, diff tools, language servers and tools at a chosen location),
/// what agents may do here, this machine's own state (the version it last ran, Power Save Mode)
/// and per-project or plugin-defined values.
const NEVER: &[&[&str]] = &[
    &["settingsSync"],
    &["general", "lastRunVersion"],
    &["general", "powerSaveMode"],
    &["general", "projectName"],
    &["mcpServer"],
    &["remoteDevelopment"],
    &["proxy"],
    &["ssh"],
    &["deployment"],
    &["runTargets"],
    &["externalTools"],
    &["externalDiff"],
    &["tools"],
    &["languageServers"],
    &["agentSecurity"],
    &["agents", "defaults"],
    &["agents", "newTaskApprovals"],
    &["agents", "mcpServers"],
    &["notifications", "systemNotifications"],
    &["projectStructure"],
    &["plugins"],
];

pub fn enabled(config: &SettingsSyncSettings, category: &str) -> bool {
    match category {
        "appearance" => config.appearance,
        "editor" => config.editor,
        "keymaps" => config.keymaps,
        "other" => config.other,
        "templates" => config.templates,
        "macros" => config.macros,
        "ui" => config.ui,
        _ => false,
    }
}

pub fn file_name(category: &str) -> String {
    format!("{category}.json")
}

fn settings_category(top: &str) -> &'static str {
    match top {
        "appearance" | "fileColors" => "appearance",
        "editor" | "inspections" | "spelling" | "actionsOnSave" => "editor",
        "keymap" | "keymapOverrides" | "customKeymaps" => "keymaps",
        _ => "other",
    }
}

/// Keys whose values are credentials (`proxy.password`, an `apiToken`).
fn is_secret_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase().replace(['_', '-'], "");
    ["password", "passphrase", "secret", "token", "apikey", "credential"].iter().any(|word| key.contains(word))
}

/// A path on this machine: absolute, home-relative or a Windows drive or share.
fn is_local_path(text: &str) -> bool {
    let bytes = text.as_bytes();
    text.starts_with('/')
        || text.starts_with("~/")
        || text.starts_with("~\\")
        || text.starts_with("\\\\")
        || (bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'\\' | b'/'))
}

/// Drops credentials and machine paths (interpreters, SDK and tool homes) wherever they are:
/// path strings, arrays holding one, map entries keyed by one, and tables left empty by that.
fn scrub(value: &mut Json) -> bool {
    match value {
        Json::String(text) => !is_local_path(text),
        Json::Array(items) => items.iter_mut().all(scrub),
        Json::Object(map) => {
            let had_entries = !map.is_empty();
            map.retain(|key, item| !is_secret_key(key) && !is_local_path(key) && scrub(item));
            !had_entries || !map.is_empty()
        }
        _ => true,
    }
}

/// What `category` may hold of `value` (a category file or the whole global layer).
pub fn clean(category: &str, value: &Json) -> Json {
    let Some(map) = value.as_object() else { return Json::Object(Map::new()) };
    let mut out = Json::Object(if STORAGE_CATEGORIES.contains(&category) {
        // Project-scoped entries are keyed `<name>:<project path>`.
        map.iter()
            .filter(|(key, item)| item.is_string() && !key.contains(':') && !is_secret_key(key))
            .map(|(key, item)| (key.clone(), item.clone()))
            .collect()
    } else {
        map.iter().filter(|(key, _)| settings_category(key) == category).map(|(k, v)| (k.clone(), v.clone())).collect()
    });
    for path in NEVER {
        let (last, parents) = path.split_last().expect("non-empty path");
        if let Some(table) = parents.iter().try_fold(&mut out, |v, seg| v.get_mut(*seg)).and_then(Json::as_object_mut)
            && table.remove(*last).is_some()
            && table.is_empty()
            && let [parent] = parents
        {
            out.as_object_mut().expect("an object").remove(*parent);
        }
    }
    scrub(&mut out);
    out
}

/// Three-way merge, setting by setting: a side's change wins over an unchanged side; when both
/// changed one setting differently `local` wins and its dotted key goes into `overwritten`.
pub fn merge3(
    base: Option<&Json>,
    local: Option<&Json>,
    remote: Option<&Json>,
    path: &mut Vec<String>,
    overwritten: &mut Vec<String>,
) -> Option<Json> {
    if local == remote || remote == base {
        return local.cloned();
    }
    if local == base {
        return remote.cloned();
    }
    if let (Some(Json::Object(l)), Some(Json::Object(r))) = (local, remote) {
        let b = base.and_then(Json::as_object);
        let mut merged = Map::new();
        for key in l.keys().chain(r.keys().filter(|k| !l.contains_key(*k))) {
            path.push(key.clone());
            if let Some(value) = merge3(b.and_then(|b| b.get(key)), l.get(key), r.get(key), path, overwritten) {
                merged.insert(key.clone(), value);
            }
            path.pop();
        }
        return Some(Json::Object(merged));
    }
    overwritten.push(path.join("."));
    local.cloned()
}

/// The settings to set (`Some`) or remove (`None`) to turn `from` into `to`, by key segments.
/// A table is added or removed key by key, never as a whole, so the settings in it that never
/// sync (an interpreter path next to a synced Python option) stay.
pub fn changes(from: &Json, to: &Json) -> Vec<(Vec<String>, Option<Json>)> {
    fn walk(
        from: Option<&Json>,
        to: Option<&Json>,
        path: &mut Vec<String>,
        out: &mut Vec<(Vec<String>, Option<Json>)>,
    ) {
        let empty = Map::new();
        let (a, b) = match (from, to) {
            _ if from == to => return,
            (Some(Json::Object(a)), Some(Json::Object(b))) => (a, b),
            (Some(Json::Object(a)), None) => (a, &empty),
            (None, Some(Json::Object(b))) => (&empty, b),
            _ => return out.push((path.clone(), to.cloned())),
        };
        for key in a.keys().chain(b.keys().filter(|k| !a.contains_key(*k))) {
            path.push(key.clone());
            walk(a.get(key), b.get(key), path, out);
            path.pop();
        }
    }
    let mut out = Vec::new();
    walk(Some(from), Some(to), &mut Vec::new(), &mut out);
    out
}

/// A category file's text: stable, pretty JSON so the repository history reads as a diff.
pub fn to_file(value: &Json) -> String {
    let mut text = serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".into());
    text.push('\n');
    text
}

pub fn from_files(files: &BTreeMap<String, String>, category: &str) -> Option<Json> {
    let value: Json = serde_json::from_str(files.get(&file_name(category))?).ok()?;
    Some(clean(category, &value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn splits_settings_and_drops_machine_values_and_secrets() {
        let layer = json!({
            "appearance": { "theme": "dark" },
            "editor": { "fontSize": 14 },
            "keymapOverrides": { "editor.action.x": ["Meta+/"] },
            "proxy": { "host": "proxy", "password": "p" },
            "settingsSync": { "repository": "git@example.com:me/settings.git" },
            "agents": { "showCost": true, "mcpServers": { "x": {} } },
            "notifications": { "systemNotifications": true, "balloons": true },
            "general": { "lastRunVersion": "0.1.55", "confirmExit": false },
            "mcpServer": { "enabled": true },
            "languages": { "python": {
                "interpreter": "/usr/bin/python3",
                "interpreters": ["~/venv/bin/python", "/opt/python"],
                "interpreterPaths": { "C:\\Python\\python.exe": ["lib"] },
                "docstringFormat": "google",
            } },
            "build": { "maven": { "home": "/opt/maven", "offline": true } },
            "vcs": { "apiToken": "t", "git": { "autoFetch": true } },
        });
        assert_eq!(clean("appearance", &layer), json!({ "appearance": { "theme": "dark" } }));
        assert_eq!(clean("editor", &layer), json!({ "editor": { "fontSize": 14 } }));
        assert_eq!(clean("keymaps", &layer), json!({ "keymapOverrides": { "editor.action.x": ["Meta+/"] } }));
        assert_eq!(
            clean("other", &layer),
            json!({
                "agents": { "showCost": true },
                "notifications": { "balloons": true },
                "general": { "confirmExit": false },
                "languages": { "python": { "docstringFormat": "google" } },
                "build": { "maven": { "offline": true } },
                "vcs": { "git": { "autoFetch": true } },
            })
        );
        let local_state = json!({ "general": { "lastRunVersion": "0.1.55" }, "agents": { "mcpServers": {} } });
        assert_eq!(clean("other", &local_state), json!({}));
        let storage = json!({ "openidea.macros.v1": "[]", "openidea.fileTemplates.v1.project:/p": "{}", "x": 1 });
        assert_eq!(clean("macros", &storage), json!({ "openidea.macros.v1": "[]" }));
    }

    #[test]
    fn merges_each_setting_three_ways() {
        let base = json!({ "a": 1, "b": 1, "c": 1, "d": { "x": 1 } });
        let local = json!({ "a": 2, "b": 1, "c": 3, "d": { "x": 1, "y": 1 }, "l": true });
        let remote = json!({ "a": 1, "b": 2, "c": 4, "d": { "x": 2 } });
        let mut overwritten = Vec::new();
        let merged = merge3(Some(&base), Some(&local), Some(&remote), &mut Vec::new(), &mut overwritten);
        assert_eq!(merged, Some(json!({ "a": 2, "b": 2, "c": 3, "d": { "x": 2, "y": 1 }, "l": true })));
        assert_eq!(overwritten, ["c"]);

        // A setting removed on one side stays removed.
        let merged = merge3(
            Some(&base),
            Some(&json!({ "b": 1, "c": 1, "d": { "x": 1 } })),
            Some(&base),
            &mut Vec::new(),
            &mut overwritten,
        );
        assert_eq!(merged, Some(json!({ "b": 1, "c": 1, "d": { "x": 1 } })));

        // Without a base, both sides' settings are kept and this machine's wins.
        let mut overwritten = Vec::new();
        let merged = merge3(
            None,
            Some(&json!({ "a": 1, "b": 1 })),
            Some(&json!({ "a": 2, "c": 1 })),
            &mut Vec::new(),
            &mut overwritten,
        );
        assert_eq!(merged, Some(json!({ "a": 1, "b": 1, "c": 1 })));
        assert_eq!(overwritten, ["a"]);
    }

    #[test]
    fn lists_leaf_changes() {
        let from = json!({ "editor": { "fontSize": 13, "tabSize": 4 }, "keymap": "a" });
        let to = json!({ "editor": { "fontSize": 14 }, "appearance": { "theme": "x" }, "keymap": "a" });
        assert_eq!(
            changes(&from, &to),
            vec![
                (vec!["editor".into(), "fontSize".into()], Some(json!(14))),
                (vec!["editor".into(), "tabSize".into()], None),
                (vec!["appearance".into(), "theme".into()], Some(json!("x"))),
            ]
        );
        // Tables are never written or removed whole: their other keys may be machine-local.
        assert_eq!(changes(&json!({}), &json!({ "general": {} })), vec![]);
        assert_eq!(
            changes(&json!({ "languages": { "python": { "docstringFormat": "google" } } }), &json!({})),
            vec![(vec!["languages".into(), "python".into(), "docstringFormat".into()], None)]
        );
    }
}
