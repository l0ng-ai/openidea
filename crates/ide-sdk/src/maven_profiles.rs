//! Maven profiles for the Java language server. jdtls (m2e) has no setting for the
//! profiles a project is imported with; it takes them from `<activeProfiles>` of the
//! user `settings.xml`. The profiles chosen in the Maven tool window are therefore
//! passed as a copy of the user's settings with those profiles activated.

use crate::apply::setting_path;
use ide_core::settings::Settings;
use ide_language::LanguageServerConfig;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

const PREFIX: &str = "jdtls-maven-settings-";

/// Points jdtls at a user `settings.xml` activating `profiles` (`-P` entries of the
/// last Maven sync), written to `dir`. Through `settings`, so a running server
/// re-imports its Maven projects instead of restarting. `!id` entries can't be
/// expressed in `settings.xml` and are left to the POMs' own activation.
pub fn configure_jdtls(cfg: &mut LanguageServerConfig, root: &Path, s: &Settings, profiles: &[String], dir: &Path) {
    if cfg.name != "jdtls" {
        return;
    }
    let active: Vec<&str> =
        profiles.iter().map(|p| p.trim()).filter(|p| !p.is_empty() && !p.starts_with('!')).collect();
    let Some(file) = (!active.is_empty()).then(|| write_settings(root, s, &active, dir)).flatten() else {
        remove_generated(dir, None);
        return;
    };
    let layer = json!({ "java": { "configuration": { "maven": { "userSettings": file.to_string_lossy() } } } });
    match &mut cfg.settings {
        Some(settings) => merge(settings, layer),
        None => cfg.settings = Some(layer),
    }
}

/// The user's settings (Settings › Maven, else `~/.m2/settings.xml`) with `active`
/// added to `<activeProfiles>`. Named after its content: m2e reloads a settings file
/// only when the configured path changes.
fn write_settings(root: &Path, s: &Settings, active: &[&str], dir: &Path) -> Option<PathBuf> {
    let user = setting_path(root, &s.languages.java.maven.user_settings)
        .or_else(|| crate::home_dir().map(|h| h.join(".m2").join("settings.xml")));
    let base = user.and_then(|f| std::fs::read_to_string(f).ok()).unwrap_or_else(|| "<settings>\n</settings>\n".into());
    let Some(text) = with_active_profiles(&base, active) else {
        tracing::warn!("Maven profiles not passed to jdtls: the user settings.xml has no <settings> element");
        return None;
    };
    let mut hash = 0xcbf29ce484222325u64;
    for byte in text.bytes() {
        hash = (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3);
    }
    let file = dir.join(format!("{PREFIX}{hash:016x}.xml"));
    if !file.is_file() {
        let written = std::fs::create_dir_all(dir).and_then(|()| std::fs::write(&file, &text));
        if let Err(e) = written {
            tracing::warn!("Maven profiles not passed to jdtls: {}: {e}", file.display());
            return None;
        }
    }
    remove_generated(dir, Some(&file));
    Some(file)
}

/// Deletes the settings files written for earlier profile choices.
fn remove_generated(dir: &Path, keep: Option<&Path>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let generated = path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(PREFIX));
        if generated && Some(path.as_path()) != keep {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// `text` (a `settings.xml`) with `ids` appended to its `<activeProfiles>`, created
/// when missing; `None` when there is no `<settings>` element to add it to.
pub fn with_active_profiles(text: &str, ids: &[&str]) -> Option<String> {
    let entries: String = ids.iter().map(|id| format!("    <activeProfile>{}</activeProfile>\n", escape(id))).collect();
    let masked = mask_comments(text);
    if let Some(start) = find_tag(&masked, "<activeProfiles", 0) {
        let end = start + masked[start..].find('>')?;
        if masked[..end].ends_with('/') {
            let element = format!("<activeProfiles>\n{entries}  </activeProfiles>");
            return Some(format!("{}{element}{}", &text[..start], &text[end + 1..]));
        }
        let close = end + masked[end..].find("</activeProfiles")?;
        return Some(format!("{}\n{entries}  {}", text[..close].trim_end(), &text[close..]));
    }
    let close = masked.rfind("</settings")?;
    let element = format!("  <activeProfiles>\n{entries}  </activeProfiles>\n");
    Some(format!("{}\n{element}{}", text[..close].trim_end(), &text[close..]))
}

/// Start of the element `open` (`<name`), not a longer name sharing its prefix.
fn find_tag(masked: &str, open: &str, from: usize) -> Option<usize> {
    let mut at = from;
    while let Some(i) = masked[at..].find(open) {
        let start = at + i;
        let next = masked[start + open.len()..].chars().next();
        if next.is_some_and(|c| c == '>' || c == '/' || c.is_whitespace()) {
            return Some(start);
        }
        at = start + open.len();
    }
    None
}

/// `text` with comments and CDATA blanked out, byte offsets unchanged.
fn mask_comments(text: &str) -> String {
    let mut out = text.as_bytes().to_vec();
    let mut at = 0;
    while at < text.len() {
        let rest = &text[at..];
        let (open, close) = match (rest.find("<!--"), rest.find("<![CDATA[")) {
            (Some(c), Some(d)) if d < c => (d, "]]>"),
            (Some(c), _) => (c, "-->"),
            (None, Some(d)) => (d, "]]>"),
            (None, None) => break,
        };
        let start = at + open;
        let end = text[start..].find(close).map_or(text.len(), |i| start + i + close.len());
        out[start..end].fill(b' ');
        at = end;
    }
    String::from_utf8(out).unwrap_or_default()
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn merge(base: &mut Value, layer: Value) {
    match (base, layer) {
        (Value::Object(base), Value::Object(layer)) => {
            for (k, v) in layer {
                match base.get_mut(&k) {
                    Some(existing) => merge(existing, v),
                    None => {
                        base.insert(k, v);
                    }
                }
            }
        }
        (base, layer) => *base = layer,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jdtls() -> LanguageServerConfig {
        serde_json::from_value(json!({ "name": "jdtls", "command": "jdtls" })).unwrap()
    }

    fn user_settings(cfg: &LanguageServerConfig) -> Option<String> {
        cfg.settings.as_ref()?.pointer("/java/configuration/maven/userSettings")?.as_str().map(Into::into)
    }

    #[test]
    fn adds_profiles_to_every_shape_of_settings_xml() {
        let ids = ["native", "本地"];
        let added = "<activeProfile>native</activeProfile>\n    <activeProfile>本地</activeProfile>";
        for (text, keeps) in [
            ("<settings>\n</settings>\n", ""),
            ("<settings><mirrors><mirror><id>m</id></mirror></mirrors></settings>", "<mirror><id>m</id></mirror>"),
            (
                "<settings>\n  <activeProfiles>\n    <activeProfile>nexus</activeProfile>\n  </activeProfiles>\n</settings>",
                "<activeProfile>nexus</activeProfile>",
            ),
            ("<settings><activeProfiles/></settings>", ""),
            ("<settings><activeProfiles /></settings>", ""),
            // Commented-out elements are not where the profiles go.
            (
                "<settings>\n<!-- <activeProfiles></activeProfiles> </settings> -->\n</settings>",
                "<!-- <activeProfiles></activeProfiles> </settings> -->",
            ),
            (
                "<?xml version=\"1.0\"?>\n<settings xmlns=\"http://maven.apache.org/SETTINGS/1.0.0\"><activeProfilesX/></settings>",
                "<activeProfilesX/>",
            ),
        ] {
            let out = with_active_profiles(text, &ids).unwrap_or_else(|| panic!("{text}"));
            assert!(out.contains(added), "{text}\n→\n{out}");
            assert!(out.contains(keeps), "{text}\n→\n{out}");
            let out = if keeps.starts_with("<!--") { out.replace(keeps, "") } else { out };
            assert_eq!(out.matches("<activeProfiles>").count(), 1, "{text}\n→\n{out}");
            let close = out.find("</activeProfiles>").unwrap();
            assert!(close < out.rfind("</settings>").unwrap(), "{out}");
            assert!(out.find(added).unwrap() < close, "{out}");
        }
        assert_eq!(with_active_profiles("<settings/>", &ids), None);
        assert!(with_active_profiles("<settings></settings>", &["a&b"]).unwrap().contains("a&amp;b"));
    }

    #[test]
    fn jdtls_imports_with_the_synced_profiles() {
        let tmp = tempfile::tempdir().unwrap();
        let user = tmp.path().join("user-settings.xml");
        std::fs::write(&user, "<settings><localRepository>/repo</localRepository></settings>").unwrap();
        let mut s = Settings::default();
        s.languages.java.maven.user_settings = user.to_string_lossy().into_owned();
        let dir = tmp.path().join("build");
        let profiles = |p: &[&str]| p.iter().map(|s| s.to_string()).collect::<Vec<_>>();

        let mut cfg = jdtls();
        configure_jdtls(&mut cfg, tmp.path(), &s, &profiles(&["native", "!dev", "本地"]), &dir);
        let first = user_settings(&cfg).expect("generated settings");
        let text = std::fs::read_to_string(&first).unwrap();
        assert!(text.contains("<localRepository>/repo</localRepository>"), "{text}");
        assert!(
            text.contains("<activeProfile>native</activeProfile>")
                && text.contains("<activeProfile>本地</activeProfile>")
        );
        assert!(!text.contains("dev"), "deactivations are not activations: {text}");

        // Same choice → same file; another choice → another path (m2e reloads on a new path).
        let mut again = jdtls();
        configure_jdtls(&mut again, tmp.path(), &s, &profiles(&["native", "本地"]), &dir);
        assert_eq!(user_settings(&again).as_deref(), Some(first.as_str()));
        let mut other = jdtls();
        configure_jdtls(&mut other, tmp.path(), &s, &profiles(&["pro"]), &dir);
        let second = user_settings(&other).unwrap();
        assert_ne!(second, first);
        assert!(!Path::new(&first).exists(), "the previous file is removed");

        // No profile (or only deactivations) → the user's settings as configured.
        for none in [&[][..], &["!dev"][..]] {
            let mut plain = jdtls();
            configure_jdtls(&mut plain, tmp.path(), &s, &profiles(none), &dir);
            assert_eq!(user_settings(&plain), None);
        }
        assert!(!Path::new(&second).exists());

        let mut other_server: LanguageServerConfig =
            serde_json::from_value(json!({ "name": "kotlin-lsp", "command": "kotlin-lsp" })).unwrap();
        configure_jdtls(&mut other_server, tmp.path(), &s, &profiles(&["native"]), &dir);
        assert_eq!(other_server.settings, None);
    }
}
