//! Enhanced class redefinition for Java debug sessions: on JetBrains Runtime,
//! `-XX:+AllowEnhancedClassRedefinition` lets HotSwap (Reload Changed Classes) apply
//! structural changes such as added or removed methods and fields. Other JVMs refuse to
//! start with the flag, so it is added only when the launched JDK is JetBrains Runtime.

use std::path::Path;

/// The JVM flag JetBrains Runtime takes.
pub const OPTION: &str = "-XX:+AllowEnhancedClassRedefinition";

/// The flag when `java` (the launched `bin/java`; `None` when unknown) is JetBrains Runtime,
/// else the console line saying why the session runs without it.
pub fn enhanced_redefinition(java: Option<&Path>) -> Result<&'static str, String> {
    let java = java.filter(|java| java.components().count() > 1);
    match java {
        Some(java) if crate::java_agent::jdk_allows(Some(java), Some("jetbrains")) => Ok(OPTION),
        Some(java) => Err(format!(
            "Enhanced class redefinition is off for this session: {} is not a JetBrains Runtime. \
             Choose a JetBrains Runtime as the configuration's JRE.",
            java.display()
        )),
        None => Err("Enhanced class redefinition is off for this session: the JDK it runs on is unknown. \
             Choose a JetBrains Runtime as the configuration's JRE."
            .to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jdk(dir: &Path, implementor: &str) -> std::path::PathBuf {
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(dir.join("release"), format!("JAVA_VERSION=\"21\"\nIMPLEMENTOR=\"{implementor}\"\n")).unwrap();
        let java = bin.join("java");
        std::fs::write(&java, "").unwrap();
        java
    }

    #[test]
    fn jetbrains_runtime_gets_the_flag() {
        let tmp = tempfile::tempdir().unwrap();
        let java = jdk(tmp.path(), "JetBrains s.r.o.");
        assert_eq!(enhanced_redefinition(Some(&java)), Ok(OPTION));
    }

    #[test]
    fn other_jdks_get_a_note_instead() {
        let tmp = tempfile::tempdir().unwrap();
        let java = jdk(tmp.path(), "Eclipse Adoptium");
        let note = enhanced_redefinition(Some(&java)).unwrap_err();
        assert!(note.contains("is not a JetBrains Runtime"), "{note}");
        assert!(note.contains(&java.display().to_string()), "{note}");
    }

    #[test]
    fn an_unknown_jdk_gets_a_note() {
        assert!(enhanced_redefinition(None).unwrap_err().contains("is unknown"));
        // A bare `java` names no JDK.
        assert!(enhanced_redefinition(Some(Path::new("java"))).unwrap_err().contains("is unknown"));
    }
}
