use super::{DependencyUpdate, ManifestDependency};
use semver::{Op, Version, VersionReq};
use serde::Deserialize;
use toml_edit::{Document, Item, TableLike};

/// Cargo's sparse-index path, including the special cases for short names.
pub fn index_path(name: &str) -> Option<String> {
    if name.is_empty()
        || name.len() > 64
        || !name.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
        || !name.as_bytes()[0].is_ascii_alphabetic()
    {
        return None;
    }
    let name = name.to_ascii_lowercase();
    Some(match name.len() {
        1 => format!("1/{name}"),
        2 => format!("2/{name}"),
        3 => format!("3/{}/{name}", &name[..1]),
        _ => format!("{}/{}/{name}", &name[..2], &name[2..4]),
    })
}

pub fn parse_index(text: &str) -> Option<Vec<String>> {
    #[derive(Deserialize)]
    struct Entry {
        vers: String,
        #[serde(default)]
        yanked: bool,
    }
    let mut versions = Vec::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let entry: Entry = serde_json::from_str(line).ok()?;
        if !entry.yanked {
            versions.push(Version::parse(&entry.vers).ok()?);
        }
    }
    versions.sort_unstable_by(|a, b| b.cmp(a));
    versions.dedup();
    Some(versions.into_iter().map(|v| v.to_string()).collect())
}

/// A complete TOML parser supplies spans, so strings/comments that resemble tables
/// never become dependencies. Broken documents are silent until they parse again.
pub fn dependencies(text: &str) -> Vec<ManifestDependency> {
    let Ok(doc) = text.parse::<Document<String>>() else { return Vec::new() };
    let mut out = Vec::new();
    sections(doc.as_table(), text, &mut out);
    if let Some(workspace) = doc.get("workspace").and_then(Item::as_table_like)
        && let Some(deps) = workspace.get("dependencies").and_then(Item::as_table_like)
    {
        collect(deps, text, &mut out);
    }
    if let Some(targets) = doc.get("target").and_then(Item::as_table_like) {
        for (_, target) in targets.iter() {
            if let Some(target) = target.as_table_like() {
                sections(target, text, &mut out);
            }
        }
    }
    out.sort_unstable_by_key(|d| d.from);
    out
}

fn sections(table: &dyn TableLike, text: &str, out: &mut Vec<ManifestDependency>) {
    for section in ["dependencies", "dev-dependencies", "build-dependencies"] {
        if let Some(deps) = table.get(section).and_then(Item::as_table_like) {
            collect(deps, text, out);
        }
    }
}

fn collect(table: &dyn TableLike, text: &str, out: &mut Vec<ManifestDependency>) {
    for (name, item) in table.iter() {
        let (package, value) = if let Some(dep) = item.as_table_like() {
            if ["path", "git", "registry", "registry-index"].iter().any(|k| dep.contains_key(k))
                || dep.get("workspace").and_then(Item::as_bool) == Some(true)
            {
                continue;
            }
            let Some(version) = dep.get("version") else { continue };
            (dep.get("package").and_then(Item::as_str).unwrap_or(name), version)
        } else {
            (name, item)
        };
        if index_path(package).is_none() {
            continue;
        }
        let Some(requirement) = value.as_str() else { continue };
        let Some(span) = value.span() else { continue };
        let Some(raw) = text.get(span.clone()) else { continue };
        // Spans cover the encoded TOML string. Replace its entire contents,
        // including escapes, while retaining the original quote delimiters.
        let delimiter = if raw.starts_with("\"\"\"") || raw.starts_with("'''") { 3 } else { 1 };
        out.push(ManifestDependency {
            package: package.to_owned(),
            requirement: requirement.to_owned(),
            from: text[..span.start + delimiter].encode_utf16().count() as u32,
            to: text[..span.end - delimiter].encode_utf16().count() as u32,
        });
    }
}

pub fn update(requirement: &str, versions: &[String]) -> Option<DependencyUpdate> {
    let req = VersionReq::parse(requirement).ok()?;
    let prerelease = req.comparators.iter().any(|c| !c.pre.is_empty());
    let latest =
        versions.iter().filter_map(|v| Version::parse(v).ok()).filter(|v| prerelease || v.pre.is_empty()).max()?;
    if req.matches(&latest) {
        return None;
    }
    // An unavailable future version isn't an invitation to downgrade.
    if req.comparators.iter().any(|c| {
        (c.op == Op::Greater
            && c.patch.is_none()
            && (latest.major < c.major
                || (latest.major == c.major && c.minor.is_none_or(|minor| latest.minor <= minor))))
            || !matches!(c.op, Op::Less | Op::LessEq)
                && latest
                    <= Version {
                        major: c.major,
                        minor: c.minor.unwrap_or(0),
                        patch: c.patch.unwrap_or(0),
                        pre: c.pre.clone(),
                        build: Default::default(),
                    }
    }) {
        return None;
    }
    let trimmed = requirement.trim();
    let digits = trimmed.trim_start_matches(['^', '~', '=']).trim_start();
    let simple = digits.split('.').all(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()));
    let mut replacement = latest.to_string();
    if simple && latest.pre.is_empty() {
        let precision = digits.split('.').count();
        let version = match precision {
            1 => latest.major.to_string(),
            2 => format!("{}.{}", latest.major, latest.minor),
            _ => latest.to_string(),
        };
        let candidate = format!("{}{version}", &trimmed[..trimmed.len() - digits.len()]);
        if VersionReq::parse(&candidate).is_ok_and(|r| r.matches(&latest)) {
            replacement = candidate;
        }
    }
    Some(DependencyUpdate { latest: latest.to_string(), replacement })
}

#[cfg(test)]
mod tests;
