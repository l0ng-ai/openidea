//! Python imports see the same content/source roots as the IDE.
use ide_core::{IdeError, IdeResult};
use std::collections::BTreeMap;
use std::path::PathBuf;

pub fn extend(env: &mut BTreeMap<String, String>, roots: &[PathBuf], inherit: bool) -> IdeResult<()> {
    if roots.is_empty() {
        return Ok(());
    }
    let inherited = if inherit { crate::system_env().remove("PYTHONPATH") } else { None };
    let existing = env.get("PYTHONPATH").or(inherited.as_ref());
    let mut paths = Vec::new();
    for root in roots {
        if !paths.contains(root) {
            paths.push(root.clone());
        }
    }
    if let Some(existing) = existing {
        for path in std::env::split_paths(existing) {
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
    }
    let joined =
        std::env::join_paths(paths).map_err(|e| IdeError::invalid(format!("invalid Python import path: {e}")))?;
    env.insert("PYTHONPATH".into(), joined.to_string_lossy().into_owned());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_configured_paths_without_duplicates_or_system_leaks() {
        let root = std::env::temp_dir().join("python project");
        let other = root.join("vendor");
        let value = std::env::join_paths([&other, &root]).unwrap().to_string_lossy().into_owned();
        let mut env = BTreeMap::from([("PYTHONPATH".into(), value)]);
        extend(&mut env, std::slice::from_ref(&root), false).unwrap();
        assert_eq!(std::env::split_paths(&env["PYTHONPATH"]).collect::<Vec<_>>(), [root, other]);
    }
}
