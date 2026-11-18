//! Capabilities needed by the JVM hosting Java language-server bundles.

use std::path::Path;

/// jdtls' javac bundle, java-debug / hot code replace, and Lombok / Gradle tooling.
const BUNDLE_MODULES: &[&str] = &["jdk.compiler", "jdk.jdi", "jdk.unsupported"];

/// Require a full JDK, including the modules used by jdtls and its bundles.
/// Temurin JREs can list the build JDK's modules in `release` even when the runtime
/// image omits them, so module metadata alone does not establish suitability.
pub fn supports_java_bundles(home: &Path) -> bool {
    let Ok(release) = std::fs::read_to_string(home.join("release")) else { return false };
    let property =
        |key: &str| release.lines().find_map(|line| line.trim().strip_prefix(key)).map(|v| v.trim().trim_matches('"'));
    let javac = if cfg!(windows) { "javac.exe" } else { "javac" };
    if property("IMAGE_TYPE=").is_some_and(|image| image.eq_ignore_ascii_case("jre"))
        || !home.join("bin").join(javac).is_file()
    {
        return false;
    }
    match property("MODULES=") {
        Some(modules) => BUNDLE_MODULES.iter().all(|required| modules.split_whitespace().any(|m| m == *required)),
        None => BUNDLE_MODULES.iter().all(|m| home.join("jmods").join(format!("{m}.jmod")).is_file()),
    }
}
