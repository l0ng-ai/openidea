//! Cucumber sources: the project's `.feature` files and the JavaScript / TypeScript files
//! (`@cucumber/cucumber`, `playwright-bdd`) and Java / Kotlin files (cucumber-jvm's
//! `@Given("…")` annotations and Java 8 lambdas) and Python files (behave and pytest-bdd's
//! `@given('…')` decorators) that could define steps, with their text. The UI
//! owns the Gherkin and step-expression parsing and the index it feeds (as for `routes`),
//! so this side stays a cheap scan.

use crate::Host;
use ide_core::IdeResult;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

/// Files handed out at most, and bytes in total: a test suite's features and step
/// files fit well inside these, and the UI indexes them once.
const MAX_FILES: usize = 4096;
const MAX_BYTES: usize = 64 << 20;
/// A single source bigger than this is a bundle, not a step file.
const MAX_FILE_BYTES: u64 = 2 << 20;

/// What a step definition call starts with (`Given('…'`, `defineStep(/…/`).
const STEP_CALLS: [&str; 5] = ["Given(", "When(", "Then(", "Step(", "defineStep("];
/** What a Python step decorator starts with (behave also takes the capitalized names). */
const PYTHON_STEP_CALLS: [&str; 8] = ["@given(", "@when(", "@then(", "@step(", "@Given(", "@When(", "@Then(", "@Step("];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StepSource {
    pub path: ide_core::IpcPath,
    pub text: String,
    /// A Gherkin `.feature` file; otherwise a script defining steps.
    pub feature: bool,
}

fn is_feature(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("feature"))
}

fn is_script(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("js" | "jsx" | "mjs" | "cjs" | "ts" | "tsx" | "mts" | "cts" | "java" | "kt" | "py")
    )
}

fn is_python(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()) == Some("py")
}

/// The feature files and step definition files under `root`.
pub(crate) fn sources_in(root: &Path, excludes: &[String]) -> Vec<StepSource> {
    let found: Mutex<Vec<StepSource>> = Mutex::new(Vec::new());
    let bytes = AtomicUsize::new(0);
    ide_vfs::walk_files(root, excludes, |path| {
        let feature = is_feature(path);
        if !(feature || is_script(path)) || bytes.load(Ordering::Relaxed) >= MAX_BYTES {
            return;
        }
        if std::fs::metadata(path).map_or(true, |m| m.len() > MAX_FILE_BYTES) {
            return;
        }
        let Ok(text) = std::fs::read_to_string(path) else { return };
        let calls: &[&str] = if is_python(path) { &PYTHON_STEP_CALLS } else { &STEP_CALLS };
        if !feature && !calls.iter().any(|call| text.contains(call)) {
            return;
        }
        let Ok(mut found) = found.lock() else { return };
        if found.len() >= MAX_FILES {
            return;
        }
        bytes.fetch_add(text.len(), Ordering::Relaxed);
        found.push(StepSource { path: path.to_path_buf().into(), text, feature });
    });
    let mut files = found.into_inner().unwrap_or_default();
    files.sort_by(|a, b| a.path.cmp(&b.path));
    files
}

/// Every Cucumber source of the project (its folder and the content roots outside it).
pub fn cucumber_sources(host: &Host, window: &str) -> IdeResult<Vec<StepSource>> {
    let project = host.project(window)?;
    let mut out = Vec::new();
    for root in std::iter::once(project.root.clone()).chain(project.content_roots()) {
        let mut excludes = project.search_excludes_in(&root);
        // Cucumber's own sources (and every other package's) are not the project's steps.
        excludes.push("node_modules".to_owned());
        excludes.push("site-packages".to_owned());
        out.extend(sources_in(&root, &excludes));
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out.dedup_by(|a, b| a.path == b.path);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn features_and_step_files_are_read_and_nothing_else() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        for dir in ["features", "steps", "src", "node_modules/@cucumber/cucumber/lib"] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
        }
        std::fs::write(root.join("features/cart.feature"), "Feature: Cart\n").unwrap();
        std::fs::write(root.join("steps/cart.steps.ts"), "Given('an empty cart', () => {});").unwrap();
        std::fs::write(root.join("steps/bdd.mjs"), "const { When } = createBdd();\nWhen(/^I add (\\d+)$/, f);")
            .unwrap();
        std::fs::write(root.join("src/app.ts"), "export const app = 1;").unwrap();
        std::fs::write(root.join("src/CartSteps.java"), "@Given(\"an empty cart\")\npublic void empty() {}").unwrap();
        std::fs::write(root.join("src/App.java"), "class App {}").unwrap();
        std::fs::write(root.join("src/notes.md"), "Given('x')").unwrap();
        std::fs::write(root.join("steps/cart_steps.py"), "@given('an empty cart')\ndef step_impl(context): pass")
            .unwrap();
        std::fs::write(root.join("src/util.py"), "def given(x): return x\nWhen = given('x')").unwrap();
        std::fs::write(root.join("node_modules/@cucumber/cucumber/lib/index.js"), "Given('x')").unwrap();
        let files = sources_in(root, &["node_modules".to_owned()]);
        let names: Vec<String> =
            files.iter().map(|f| f.path.0.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/")).collect();
        assert_eq!(
            names,
            [
                "features/cart.feature",
                "src/CartSteps.java",
                "steps/bdd.mjs",
                "steps/cart.steps.ts",
                "steps/cart_steps.py"
            ]
        );
        assert!(files[0].feature && !files[1].feature);
        assert!(files[3].text.contains("an empty cart"));
    }
}
