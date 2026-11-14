//! Vue Options API `this.$refs`: the Vue 2.7 types declare `$refs` as an index signature,
//! so the TypeScript service sends `this.$refs.child` to that signature and finds nothing
//! for `this.$refs.child.focusIt`. The template says which element each ref is on:
//! `this.$refs.child` goes to its `ref="child"`, and a member read from a component's ref
//! goes to that member in the component's options.

use crate::jdtls::configuration::syntax;
use crate::types::GotoKind;
use crate::{DocSnap, LspManager, goto_method};
use ide_core::{DocId, LanguageId, Location, Pos};
use std::path::{Component, Path, PathBuf};

impl LspManager {
    pub(crate) async fn vue_ref_navigation(&self, doc: DocId, snap: &DocSnap, pos: Pos) -> Option<Vec<Location>> {
        if snap.language.as_str() != "vue" || !snap.text.as_str().contains("$refs") {
            return None;
        }
        let text = snap.text.clone();
        let (member, element, import) = tokio::task::spawn_blocking(move || {
            let s = syntax();
            let access = s.vue_ref_access(text.as_str(), pos)?;
            let element = s.vue_ref_element(text.as_str(), &access.name)?;
            let import = access.member.as_ref().and_then(|_| s.vue_component_import(text.as_str(), &element.tag));
            Some((access.member, element, import))
        })
        .await
        .ok()
        .flatten()?;
        let Some(member) = member else {
            return Some(vec![Location { path: snap.path.clone().into(), range: element.value, uri: None }]);
        };
        let import = import?;
        let file = match relative_module(&snap.path, &import.specifier) {
            Some(file) => file,
            // An alias (`@/components/…`): the language service knows the project's paths;
            // without them configured, `@` is the Vue CLI / Vite templates' `src`.
            None => match self.definition_file(doc, import.binding.start).await {
                Some(file) => file,
                None => src_alias(&self.project_root_for(&snap.path), &import.specifier)?,
            },
        };
        let lang = script_language(&file)?;
        let open = self.docs.lock().values().find(|d| d.path == file).map(|d| d.text.clone());
        let range = tokio::task::spawn_blocking({
            let file = file.clone();
            move || {
                let text = match open {
                    Some(text) => text.as_str().to_owned(),
                    None => std::fs::read_to_string(&file).ok()?,
                };
                syntax().vue_component_member(&lang, &text, &member)
            }
        })
        .await
        .ok()
        .flatten()?;
        Some(vec![Location { path: file.into(), range, uri: None }])
    }

    async fn definition_file(&self, doc: DocId, pos: Pos) -> Option<PathBuf> {
        let (method, cap, feature) = goto_method(GotoKind::Definition);
        let (snap, targets) = self.doc_targets(doc, feature, |c| c.has(cap)).await.ok()?;
        let found = self.goto_in(&snap, &targets, method, pos, None, None).await.ok()?;
        // The import binding itself is no answer.
        found.into_iter().find(|l| l.uri.is_none() && *l.path != snap.path).map(|l| l.path.into_path_buf())
    }
}

/// The file a relative import names, with the extensions a bundler tries.
fn relative_module(from: &Path, specifier: &str) -> Option<PathBuf> {
    if !specifier.starts_with("./") && !specifier.starts_with("../") {
        return None;
    }
    let mut base = from.parent()?.to_path_buf();
    for part in Path::new(specifier).components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                base.pop();
            }
            part => base.push(part),
        }
    }
    let candidates = [String::new(), ".vue".into(), ".ts".into(), ".js".into()]
        .into_iter()
        .map(|ext| PathBuf::from(format!("{}{ext}", base.display())))
        .chain(["index.vue", "index.ts", "index.js"].into_iter().map(|index| base.join(index)));
    candidates.into_iter().find(|p| p.is_file())
}

fn src_alias(root: &Path, specifier: &str) -> Option<PathBuf> {
    let rest = specifier.strip_prefix("@/")?;
    relative_module(&root.join("src").join("_"), &format!("./{rest}"))
}

fn script_language(file: &Path) -> Option<LanguageId> {
    let id = match file.extension()?.to_str()? {
        "vue" => "vue",
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "tsx",
        "js" | "mjs" | "cjs" | "jsx" => "javascript",
        _ => return None,
    };
    Some(LanguageId::new(id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_relative_component_imports() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        std::fs::create_dir_all(src.join("components/Panel")).unwrap();
        std::fs::write(src.join("components/ChildButton.vue"), "").unwrap();
        std::fs::write(src.join("components/Panel/index.vue"), "").unwrap();
        let app = src.join("App.vue");
        assert_eq!(relative_module(&app, "./components/ChildButton.vue"), Some(src.join("components/ChildButton.vue")));
        assert_eq!(relative_module(&app, "./components/ChildButton"), Some(src.join("components/ChildButton.vue")));
        assert_eq!(relative_module(&app, "./components/Panel"), Some(src.join("components/Panel/index.vue")));
        assert_eq!(
            relative_module(&src.join("components/Panel/index.vue"), "../ChildButton.vue"),
            Some(src.join("components/ChildButton.vue"))
        );
        assert_eq!(relative_module(&app, "@/components/ChildButton.vue"), None);
        assert_eq!(relative_module(&app, "./components/Missing.vue"), None);
        assert_eq!(src_alias(dir.path(), "@/components/ChildButton"), Some(src.join("components/ChildButton.vue")));
        assert_eq!(src_alias(dir.path(), "~/components/ChildButton"), None);
    }
}
