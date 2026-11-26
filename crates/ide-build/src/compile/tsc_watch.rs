//! Problems › TypeScript project errors: the project's own `tsc --watch` on each root
//! `tsconfig.json`, its output parsed like Build's tsc step, one compilation at a time.

use super::parse::{Format, OutputParser, RawMessage};
use super::{BuildMessage, Lines, PathMap, resolve};
use crate::process;
use ide_core::{CancellationToken, IdeError, IdeResult};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// How deep below the project the walk looks for `tsconfig.json`.
const MAX_DEPTH: usize = 6;
// ponytail: one `tsc` per root; past this the shallowest roots win. Raise it, or watch
// on demand, if monorepos without a solution tsconfig need more.
const MAX_ROOTS: usize = 16;

/// The `tsconfig.json` files below `dir` that no other one references: the configurations a
/// watcher runs on. Referenced projects are built by their solution's `tsc -b`.
pub fn tsc_watch_roots(dir: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    walk(dir, 0, &mut found);
    let referenced: BTreeSet<PathBuf> = found.iter().flat_map(|c| references(c)).collect();
    let mut roots: Vec<PathBuf> = found.into_iter().filter(|c| !referenced.contains(c)).collect();
    roots.sort_by_key(|c| (c.components().count(), c.clone()));
    roots.truncate(MAX_ROOTS);
    roots
}

fn walk(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    let config = dir.join("tsconfig.json");
    if config.is_file() {
        out.push(config);
    }
    if depth == MAX_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter(|e| {
            let name = e.file_name();
            let name = name.to_string_lossy();
            !name.starts_with('.') && name != "node_modules"
        })
        .map(|e| e.path())
        .collect();
    dirs.sort();
    for d in dirs {
        walk(&d, depth + 1, out);
    }
}

/// The configurations `config` lists in `references` (a folder means its `tsconfig.json`).
fn references(config: &Path) -> Vec<PathBuf> {
    let Ok(text) = std::fs::read_to_string(config) else { return Vec::new() };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&ide_core::jsonc::strip(&text)) else {
        return Vec::new();
    };
    let dir = config.parent().unwrap_or(Path::new(""));
    let refs = json.get("references").and_then(|r| r.as_array()).into_iter().flatten();
    refs.filter_map(|r| r.get("path")?.as_str())
        .map(|p| {
            let p = super::normalize(&dir.join(p));
            if p.extension().is_some_and(|e| e == "json") { p } else { p.join("tsconfig.json") }
        })
        .collect()
}

/// The project's own `tsc` (`node_modules/.bin` from the configuration's folder up to `root`).
fn local_tsc(root: &Path, dir: &Path) -> Option<PathBuf> {
    dir.ancestors()
        .take_while(|d| d.starts_with(root))
        .find_map(|d| ide_core::tool_path::find_command("tsc", d.join("node_modules/.bin").as_os_str(), dir))
}

/// `tsc --noEmit --watch` of `config`, or `tsc -b --watch` when it has project references.
fn watch_args(config: &Path) -> Vec<String> {
    let name = config.file_name().map_or_else(|| "tsconfig.json".into(), |n| n.to_string_lossy().into_owned());
    let mut args: Vec<String> = if references(config).is_empty() {
        vec!["--noEmit".into(), "-p".into(), name]
    } else {
        // `--noEmit` cannot be combined with `-b`: a solution builds its references' outputs.
        vec!["-b".into(), name]
    };
    args.extend(["--watch", "--pretty", "false", "--preserveWatchOutput"].map(String::from));
    args
}

/// The messages of one compilation at a time: tsc ends each with
/// `… - Found 2 errors. Watching for file changes.`
#[derive(Default)]
struct Compilations {
    parser: Option<OutputParser>,
    raws: Vec<RawMessage>,
}

impl Compilations {
    fn feed(&mut self, line: &str) -> Option<Vec<RawMessage>> {
        let parser = self.parser.get_or_insert_with(|| OutputParser::new(Format::Tsc));
        if line.contains("Watching for file changes.") {
            self.raws.extend(parser.finish());
            return Some(std::mem::take(&mut self.raws));
        }
        self.raws.extend(parser.feed(line).messages);
        None
    }
}

/// Runs the project's `tsc --watch` on `config` until `cancel` fires or tsc exits, handing the
/// messages of every finished compilation (all of them, an empty list when it passes) to
/// `on_compilation`. Not found when the project has no TypeScript of its own.
pub fn tsc_watch(
    root: &Path,
    config: &Path,
    cancel: &CancellationToken,
    mut on_compilation: impl FnMut(Vec<BuildMessage>),
) -> IdeResult<()> {
    let dir = config.parent().ok_or_else(|| IdeError::invalid("no tsconfig folder"))?;
    let tsc = local_tsc(root, dir).ok_or_else(|| IdeError::not_found("no local typescript"))?;
    let paths = PathMap::new(root);
    let mut compilations = Compilations::default();
    let program = tsc.to_string_lossy();
    process::run_bounded(&program, &watch_args(config), dir, &BTreeMap::new(), cancel, |_, line| {
        if let Some(raws) = compilations.feed(line) {
            // Fresh file texts each time: the files changed since the last compilation.
            let mut lines = Lines::default();
            on_compilation(raws.into_iter().map(|r| resolve(r, dir, &paths, &mut lines)).collect());
        }
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, rel: &str, text: &str) {
        let p = dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    #[test]
    fn roots_are_the_configurations_no_other_one_references() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // A solution with references (one by folder, one by file), plus an unrelated package.
        write(
            root,
            "tsconfig.json",
            r#"{ "files": [], // solution
                "references": [{ "path": "./packages/a" }, { "path": "packages/b/tsconfig.json" },] }"#,
        );
        write(root, "packages/a/tsconfig.json", r#"{"compilerOptions": {"composite": true}}"#);
        write(root, "packages/b/tsconfig.json", r#"{"compilerOptions": {"composite": true}}"#);
        write(root, "tools/cli/tsconfig.json", "{}");
        write(root, "node_modules/dep/tsconfig.json", "{}");
        write(root, ".cache/tsconfig.json", "{}");
        assert_eq!(tsc_watch_roots(root), [root.join("tsconfig.json"), root.join("tools/cli/tsconfig.json")]);
        assert_eq!(watch_args(&root.join("tsconfig.json"))[..2], ["-b", "tsconfig.json"]);
        assert_eq!(watch_args(&root.join("tools/cli/tsconfig.json"))[..3], ["--noEmit", "-p", "tsconfig.json"]);
    }

    #[test]
    fn each_compilation_reports_its_own_messages() {
        // `tsc --noEmit --watch --pretty false --preserveWatchOutput`, as printed.
        let output = "\
2:14:08 PM - Starting compilation in watch mode...

2:14:09 PM - Found 0 errors. Watching for file changes.
2:14:12 PM - File change detected. Starting incremental compilation...

src/b.ts(1,37): error TS2322: Type 'string' is not assignable to type 'number'.
src/c.ts(2,1): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
  Type 'string' is not assignable to type 'number'.

2:14:12 PM - Found 2 errors. Watching for file changes.
2:14:15 PM - File change detected. Starting incremental compilation...

2:14:15 PM - Found 0 errors. Watching for file changes.";
        let mut compilations = Compilations::default();
        let found: Vec<Vec<(String, Option<String>)>> = output
            .lines()
            .filter_map(|l| compilations.feed(l))
            .map(|raws| raws.into_iter().map(|r| (r.path.unwrap_or_default(), r.code)).collect())
            .collect();
        assert_eq!(
            found,
            [
                vec![],
                vec![("src/b.ts".into(), Some("TS2322".into())), ("src/c.ts".into(), Some("TS2345".into()))],
                vec![]
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_projects_tsc_reports_until_cancelled() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, "app/tsconfig.json", "{}");
        write(root, "app/src/b.ts", "export const b: number = a;\n");
        // A watcher that prints one compilation and keeps running, like `tsc --watch`.
        write(
            root,
            "node_modules/.bin/tsc",
            "#!/bin/sh\necho \"$@\" > args.txt\n\
             echo 'src/b.ts(1,26): error TS2322: Type string is not assignable to type number.'\n\
             echo '1:00:00 PM - Found 1 error. Watching for file changes.'\nexec sleep 30\n",
        );
        let bin = root.join("node_modules/.bin/tsc");
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let cancel = CancellationToken::new();
        let mut compilations = Vec::new();
        let started = std::time::Instant::now();
        let result = tsc_watch(root, &root.join("app/tsconfig.json"), &cancel, |messages| {
            compilations.push(messages);
            cancel.cancel();
        });
        assert_eq!(result.unwrap_err().kind, ide_core::error::ErrorKind::Cancelled);
        assert!(started.elapsed().as_secs() < 10, "cancelling stops the watcher");
        let [messages] = &compilations[..] else { panic!("{compilations:?}") };
        let paths: Vec<_> = messages.iter().map(|m| (m.path.clone().map(PathBuf::from), m.range)).collect();
        let at = |l, c| ide_core::Pos::new(l, c);
        assert_eq!(paths, [(Some(root.join("app/src/b.ts")), Some(ide_core::Range::new(at(0, 25), at(0, 26))))]);
        let args = std::fs::read_to_string(root.join("app/args.txt")).unwrap();
        assert_eq!(args.trim(), "--noEmit -p tsconfig.json --watch --pretty false --preserveWatchOutput");
    }

    #[test]
    fn no_local_typescript_runs_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        write(tmp.path(), "tsconfig.json", "{}");
        let err = tsc_watch(tmp.path(), &tmp.path().join("tsconfig.json"), &CancellationToken::new(), |_| {
            panic!("no compilation without typescript")
        })
        .unwrap_err();
        assert_eq!(err.kind, ide_core::error::ErrorKind::NotFound);
    }
}
