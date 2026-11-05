//! Reading `composer.json` and `vendor/composer/installed.json`.
//!
//! Only the parts the engine needs are read: the `autoload` (and, for the root
//! package, `autoload-dev`) sections, `config.vendor-dir`, and each installed
//! package's name and install path. Anything malformed is skipped rather than
//! failing the whole file, the way Composer itself tolerates odd manifests.

use serde_json::Value;
use std::path::{Path, PathBuf};

/// One `autoload` or `autoload-dev` section. Paths are as written, relative
/// to the package directory.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Autoload {
    /// Namespace prefix (`App\`, or empty for the fallback) → directories.
    pub psr4: Vec<(String, Vec<String>)>,
    /// PSR-0 prefix (a namespace or a class-name prefix) → directories.
    pub psr0: Vec<(String, Vec<String>)>,
    pub classmap: Vec<String>,
    pub files: Vec<String>,
    pub exclude_from_classmap: Vec<String>,
}

impl Autoload {
    pub fn from_json(section: Option<&Value>) -> Self {
        let Some(section) = section.and_then(Value::as_object) else {
            return Self::default();
        };
        Self {
            psr4: prefixes(section.get("psr-4")),
            psr0: prefixes(section.get("psr-0")),
            classmap: strings(section.get("classmap")),
            files: strings(section.get("files")),
            exclude_from_classmap: strings(section.get("exclude-from-classmap")),
        }
    }
}

/// `{"App\\": "src/"}` or `{"App\\": ["src/", "lib/"]}`. A prefix is stored
/// without a leading `\`, as Composer requires one at its end anyway.
fn prefixes(value: Option<&Value>) -> Vec<(String, Vec<String>)> {
    let Some(map) = value.and_then(Value::as_object) else {
        return Vec::new();
    };
    map.iter()
        .map(|(prefix, dirs)| (prefix.trim_start_matches('\\').to_owned(), strings(Some(dirs))))
        .filter(|(_, dirs)| !dirs.is_empty())
        .collect()
}

/// A string or an array of strings; an empty string means the package directory itself.
fn strings(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::String(s)) => vec![s.clone()],
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).map(str::to_owned).collect(),
        _ => Vec::new(),
    }
}

/// The root `composer.json`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct RootManifest {
    pub autoload: Autoload,
    pub autoload_dev: Autoload,
    /// `config.vendor-dir`, else `vendor`.
    pub vendor_dir: String,
}

impl RootManifest {
    /// `None` when there is no `composer.json` or it isn't a JSON object.
    pub fn read(root: &Path) -> Option<Self> {
        let path = root.join("composer.json");
        let text = std::fs::read_to_string(&path).ok()?;
        let json: Value = match serde_json::from_str(&text) {
            Ok(Value::Object(map)) => Value::Object(map),
            Ok(_) => {
                tracing::warn!("{}: not a JSON object", path.display());
                return None;
            }
            Err(e) => {
                tracing::warn!("{}: {e}", path.display());
                return None;
            }
        };
        let vendor_dir = json
            .pointer("/config/vendor-dir")
            .and_then(Value::as_str)
            .map(|d| d.trim().trim_end_matches(['/', '\\']))
            .filter(|d| !d.is_empty())
            .unwrap_or("vendor")
            .to_owned();
        Some(Self {
            autoload: Autoload::from_json(json.get("autoload")),
            autoload_dev: Autoload::from_json(json.get("autoload-dev")),
            vendor_dir,
        })
    }
}

/// A package from `installed.json`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct InstalledPackage {
    pub name: String,
    /// Where the package is installed (not normalized).
    pub dir: PathBuf,
    pub autoload: Autoload,
    pub dev: bool,
}

/// The packages in `<vendor>/composer/installed.json`, in either format:
/// Composer 2 (`{"packages": [...], "dev-package-names": [...]}`, with an
/// `install-path` relative to `vendor/composer`) or Composer 1 (a bare array,
/// every package in `vendor/<name>`). Empty when the file is missing or broken.
pub(crate) fn installed_packages(vendor: &Path) -> Vec<InstalledPackage> {
    let path = vendor.join("composer").join("installed.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let json: Value = match serde_json::from_str(&text) {
        Ok(json) => json,
        Err(e) => {
            tracing::warn!("{}: {e}", path.display());
            return Vec::new();
        }
    };
    let (packages, dev_names) = match &json {
        Value::Array(packages) => (packages.as_slice(), Vec::new()),
        Value::Object(map) => (
            map.get("packages").and_then(Value::as_array).map_or(&[][..], Vec::as_slice),
            strings(map.get("dev-package-names")),
        ),
        _ => (&[][..], Vec::new()),
    };
    packages
        .iter()
        .filter_map(|package| {
            let name = package.get("name")?.as_str()?.to_owned();
            let dir = match package.get("install-path") {
                Some(Value::String(install)) => vendor.join("composer").join(install),
                // A metapackage has no files.
                Some(Value::Null) => return None,
                _ => vendor.join(&name),
            };
            let autoload = Autoload::from_json(package.get("autoload"));
            let dev = dev_names.contains(&name);
            Some(InstalledPackage { name, dir, autoload, dev })
        })
        .collect()
}
