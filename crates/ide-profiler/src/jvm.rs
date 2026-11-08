//! JVM frames (`com/x/App$Inner.work`, `com.x.App.work`) → source files of the project.

use crate::{Profile, ProfileFrameKind};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const MAX_DEPTH: usize = 8;
const LANGS: &[&str] = &["java", "kt", "scala", "groovy"];

/// Source files below `root` by their path relative to a source root
/// (`src/<set>/<lang>/`): `com/x/App` → `/proj/src/main/java/com/x/App.java`.
fn source_index(root: &Path) -> HashMap<String, PathBuf> {
    let mut roots = Vec::new();
    find_source_roots(root, 0, &mut roots);
    let mut index = HashMap::new();
    for r in roots {
        index_dir(&r, &r, &mut index);
    }
    index
}

fn find_source_roots(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        if !e.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || matches!(name.as_str(), "node_modules" | "target" | "build" | "out") {
            continue;
        }
        let path = e.path();
        if name == "src" {
            // src/<set>/<lang>
            for set in std::fs::read_dir(&path).into_iter().flatten().flatten() {
                for lang in ["java", "kotlin", "scala", "groovy"] {
                    let r = set.path().join(lang);
                    if r.is_dir() {
                        out.push(r);
                    }
                }
            }
        } else if depth < MAX_DEPTH {
            find_source_roots(&path, depth + 1, out);
        }
    }
}

fn index_dir(root: &Path, dir: &Path, index: &mut HashMap<String, PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let path = e.path();
        if path.is_dir() {
            index_dir(root, &path, index);
        } else if path.extension().and_then(|x| x.to_str()).is_some_and(|x| LANGS.contains(&x))
            && let Ok(rel) = path.with_extension("").strip_prefix(root)
        {
            let key = rel.to_string_lossy().replace('\\', "/");
            index.entry(key).or_insert(path);
        }
    }
}

/// `com/x/App$Inner.work` / `com.x.App.work` → `com/x/App` (outer class, slash form).
fn class_key(frame: &str) -> Option<String> {
    let method_dot = frame.rfind('.')?;
    let class = &frame[..method_dot];
    let class = class.split('$').next().unwrap_or(class);
    if class.is_empty() || class.contains(['(', ' ', ':']) {
        return None;
    }
    Some(class.replace('.', "/"))
}

/// `com.x.App$Inner[]` → `com/x/App`; primitive arrays (`byte[]` → `byte`) match no source.
fn type_key(name: &str) -> Option<String> {
    let mut class = name;
    while let Some(inner) = class.strip_suffix("[]") {
        class = inner;
    }
    let class = class.split('$').next().unwrap_or(class);
    if class.is_empty() || class.contains(['(', ' ', ':']) {
        return None;
    }
    Some(class.replace('.', "/"))
}

pub(crate) fn resolve_sources(profile: &mut Profile, root: &Path) {
    if profile.frames.iter().all(|f| f.file.is_some()) {
        return;
    }
    let index = source_index(root);
    if index.is_empty() {
        return;
    }
    for f in profile.frames.iter_mut().filter(|f| f.file.is_none()) {
        let key = match f.kind {
            ProfileFrameKind::Code => class_key(&f.name),
            ProfileFrameKind::AllocatedType => type_key(&f.name),
        };
        if let Some(path) = key.and_then(|k| index.get(&k)) {
            f.file = Some(path.clone().into());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ProfileMode;
    use crate::tree::{FrameKey, TreeBuilder};

    #[test]
    fn maps_class_frames_to_sources() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("app/src/main/java/com/x");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("App.java"), "").unwrap();
        let mut b = TreeBuilder::new();
        b.add_stack([FrameKey::named("java/lang/Thread.run"), FrameKey::named("com/x/App$Worker.work")], 1.0);
        b.add_stack([FrameKey::named("com.x.App.main")], 1.0);
        let mut p = b.finish("async-profiler", "samples", ProfileMode::Cpu);
        resolve_sources(&mut p, dir.path());
        let file = |name: &str| p.frames.iter().find(|f| f.name == name).unwrap().file.clone();
        assert_eq!(file("com/x/App$Worker.work").as_deref(), Some(src.join("App.java").as_path()));
        assert_eq!(file("com.x.App.main").as_deref(), Some(src.join("App.java").as_path()));
        assert_eq!(file("java/lang/Thread.run"), None);
    }

    #[test]
    fn allocated_types_map_to_outer_class_source() {
        let dir = tempfile::tempdir().unwrap();
        let pkg = dir.path().join("app/src/main/java/com/x");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(pkg.join("App.java"), "").unwrap();
        let default_pkg = dir.path().join("app/src/main/java");
        std::fs::write(default_pkg.join("Alloc.java"), "").unwrap();
        let mut b = TreeBuilder::new();
        b.add_stack([FrameKey::named("com.x.App.work"), FrameKey::allocated("com.x.App$Inner[]")], 1.0);
        b.add_stack([FrameKey::named("com.x.App.work"), FrameKey::allocated("com.x.App")], 1.0);
        b.add_stack([FrameKey::allocated("Alloc")], 1.0);
        b.add_stack([FrameKey::allocated("byte[]")], 1.0);
        b.add_stack([FrameKey::allocated("java.lang.String")], 1.0);
        let mut p = b.finish("async-profiler", "bytes", ProfileMode::Allocations);
        resolve_sources(&mut p, dir.path());
        let file = |name: &str| p.frames.iter().find(|f| f.name == name).unwrap().file.clone();
        let app = pkg.join("App.java");
        assert_eq!(file("com.x.App$Inner[]").as_deref(), Some(app.as_path()));
        assert_eq!(file("com.x.App").as_deref(), Some(app.as_path()));
        assert_eq!(file("Alloc").as_deref(), Some(default_pkg.join("Alloc.java").as_path()));
        assert_eq!(file("byte[]"), None);
        assert_eq!(file("java.lang.String"), None);
        assert_eq!(file("com.x.App.work").as_deref(), Some(app.as_path()), "code frames map as before");
    }
}
