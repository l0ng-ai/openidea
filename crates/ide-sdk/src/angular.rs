//! Angular Language Server (`ngserver`): its package, where TypeScript and
//! `@angular/language-service` come from, and the project's Angular version.

use crate::npm::package_dir;
use std::path::{Path, PathBuf};

pub(crate) const SERVER: &str = "angular-language-server";
const PACKAGE: &str = "@angular/language-server";

/// `@angular/language-server`'s directory for an `ngserver` executable.
pub(crate) fn server_package(bin: &Path) -> Option<PathBuf> {
    package_dir(bin, PACKAGE)
}

/// Why an `ngserver` whose package isn't found can't start: it loads TypeScript
/// and `@angular/language-service` from there.
pub(crate) fn missing_package_message(bin: &Path) -> String {
    format!(
        "Can't find the @angular/language-server package of {}, which brings the TypeScript and Angular \
         language service the server loads. Reinstall it in Settings › Languages & Frameworks › Language \
         Servers or with `npm i -g @angular/language-server`.",
        bin.display()
    )
}

/// Why a server installed in a directory whose path has a comma can't start.
pub(crate) fn comma_message(package: &str) -> String {
    format!(
        "The Angular Language Server can't load from {package}: its path has a comma. Install it in a \
         directory without one."
    )
}

/// The version of the `@angular/core` that `dir` resolves (from its own or an
/// ancestor's `node_modules`, like Node).
pub(crate) fn core_version(dir: &Path) -> Option<String> {
    dir.ancestors().find_map(|a| {
        let text = std::fs::read_to_string(a.join("node_modules/@angular/core/package.json")).ok()?;
        let json: serde_json::Value = serde_json::from_str(&text).ok()?;
        json.get("version")?.as_str().map(str::to_owned)
    })
}

/// Arguments telling the server the project's Angular `version`: templates of
/// projects before 17 have no blocks (`@if`), before 18.1 no `@let`.
pub(crate) fn version_args(version: &str) -> Vec<String> {
    let mut parts = version.split(['.', '-', '+']).map(|p| p.parse::<u32>().ok());
    let (Some(Some(major)), Some(Some(minor))) = (parts.next(), parts.next()) else { return Vec::new() };
    // 0.0.0: a local build of Angular.
    if major == 0 {
        return Vec::new();
    }
    let mut args = vec!["--angularCoreVersion".to_owned(), version.to_owned()];
    if major < 17 {
        args.push("--disableBlockSyntax".into());
    }
    if (major, minor) < (18, 1) {
        args.push("--disableLetSyntax".into());
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn template_syntax_follows_the_angular_version() {
        let args = |v: &str| version_args(v).into_iter().skip(2).collect::<Vec<_>>();
        assert_eq!(version_args("22.2.3")[..2], ["--angularCoreVersion", "22.2.3"]);
        assert_eq!(args("22.0.0-next.1"), Vec::<String>::new());
        assert_eq!(args("18.1.0"), Vec::<String>::new());
        assert_eq!(args("18.0.5"), ["--disableLetSyntax"]);
        assert_eq!(args("17.3.12"), ["--disableLetSyntax"]);
        assert_eq!(args("16.2.0"), ["--disableBlockSyntax", "--disableLetSyntax"]);
        assert!(version_args("0.0.0-PLACEHOLDER").is_empty());
        assert!(version_args("next").is_empty());
    }

    #[test]
    fn core_version_is_found_in_an_ancestor() {
        let tmp = tempfile::tempdir().unwrap();
        let core = tmp.path().join("node_modules/@angular/core");
        std::fs::create_dir_all(&core).unwrap();
        std::fs::write(core.join("package.json"), r#"{"name":"@angular/core","version":"19.2.1"}"#).unwrap();
        let app = tmp.path().join("apps/web");
        std::fs::create_dir_all(&app).unwrap();
        assert_eq!(core_version(&app).as_deref(), Some("19.2.1"));
    }
}
