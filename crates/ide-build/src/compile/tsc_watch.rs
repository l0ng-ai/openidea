//! Problems › TypeScript project errors: the project's own `tsc --watch` on each root
//! `tsconfig.json`, its output parsed like Build's tsc step, one compilation at a time.
//!
//! A background check never writes into the project. A plain project runs `tsc --noEmit -p`
//! with its `.tsbuildinfo` (written by `composite` / `incremental` even without emit) moved to a
//! scratch folder. `tsc -b` cannot check without emitting (`--noEmit` fails with TS6310 on
//! composite references), and plain `tsc -p` on a project with references needs their built
//! `.d.ts` (TS6305). So a solution runs `tsc -b` on scratch copies of its configurations: each
//! `extends` the real one and only sends the outputs and `.tsbuildinfo` to the scratch folder,
//! keeping every option, file list and source position of the project.

use super::parse::{Format, OutputParser, RawMessage};
use super::{BuildMessage, Lines, PathMap, resolve};
use crate::process;
use ide_core::{CancellationToken, IdeError, IdeResult};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

// ponytail: one `tsc` per root; past this the shallowest roots win. Raise it, or watch
// on demand, if monorepos without a solution tsconfig need more.
const MAX_ROOTS: usize = 8;

/// The configurations among `found` (the `tsconfig.json` files of the project) that no other
/// one references: the ones a watcher runs on. Referenced projects are checked by their solution.
pub fn tsc_watch_roots(found: Vec<PathBuf>) -> Vec<PathBuf> {
    let referenced: BTreeSet<PathBuf> = found.iter().flat_map(|c| references(c)).collect();
    let mut roots: Vec<PathBuf> = found.into_iter().filter(|c| !referenced.contains(c)).collect();
    roots.sort_by_key(|c| (c.components().count(), c.clone()));
    roots.truncate(MAX_ROOTS);
    roots
}

fn read_json(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&ide_core::jsonc::strip(&text)).ok()
}

/// The configurations `config` lists in `references` (a folder means its `tsconfig.json`).
fn references(config: &Path) -> Vec<PathBuf> {
    let Some(json) = read_json(config) else { return Vec::new() };
    let dir = config.parent().unwrap_or(Path::new(""));
    let refs = json.get("references").and_then(|r| r.as_array()).into_iter().flatten();
    refs.filter_map(|r| r.get("path")?.as_str())
        .map(|p| {
            let p = super::normalize(&dir.join(p));
            if p.extension().is_some_and(|e| e == "json") { p } else { p.join("tsconfig.json") }
        })
        .collect()
}

/// A configuration and the ones it `extends`, most derived first, each with its folder (the
/// base of its relative paths). A package base (`@tsconfig/node20/tsconfig.json`) is looked up
/// in `node_modules` above the configuration.
fn chain(config: &Path) -> Vec<(PathBuf, Value)> {
    let mut out = Vec::new();
    let mut next = vec![config.to_path_buf()];
    // A cycle or a deep chain ends here.
    while let Some(path) = next.pop().filter(|_| out.len() < 16) {
        let Some(json) = read_json(&path) else { continue };
        let dir = path.parent().unwrap_or(Path::new("")).to_path_buf();
        let bases: Vec<String> = match json.get("extends") {
            Some(Value::String(s)) => vec![s.clone()],
            Some(Value::Array(a)) => a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect(),
            _ => Vec::new(),
        };
        // Later bases override earlier ones: visit them first.
        next.extend(bases.iter().filter_map(|b| resolve_base(&dir, b)));
        out.push((dir, json));
    }
    out
}

fn resolve_base(dir: &Path, base: &str) -> Option<PathBuf> {
    let with_json = |p: PathBuf| {
        if p.is_dir() {
            p.join("tsconfig.json")
        } else if p.extension().is_some_and(|e| e == "json") {
            p
        } else {
            let mut s = p.into_os_string();
            s.push(".json");
            PathBuf::from(s)
        }
    };
    if base.starts_with('.') || Path::new(base).is_absolute() {
        return Some(with_json(super::normalize(&dir.join(base))));
    }
    dir.ancestors().map(|a| with_json(a.join("node_modules").join(base))).find(|p| p.is_file())
}

/// The first value of `key` (a top-level key, or `compilerOptions.<key>`) along `chain`, with the
/// folder it is relative to.
fn lookup<'a>(chain: &'a [(PathBuf, Value)], key: &str) -> Option<(&'a Path, &'a Value)> {
    chain.iter().find_map(|(dir, json)| {
        let value = match key.strip_prefix("compilerOptions.") {
            Some(option) => json.get("compilerOptions")?.get(option)?,
            None => json.get(key)?,
        };
        Some((dir.as_path(), value))
    })
}

/// The scratch copy of `config` for `tsc -b`: the real configuration with its outputs and
/// `.tsbuildinfo` in `scratch` (file `<n>`), referencing the scratch copies `refs`. Settings that
/// default relative to the configuration's own folder are spelled out, since the copy lives
/// elsewhere: the files (`**/*`), their exclusions (`node_modules`, the output folder) and the
/// `rootDir` of a composite project.
fn scratch_config(config: &Path, scratch: &Path, n: usize, refs: &[PathBuf]) -> Value {
    let chain = chain(config);
    let dir = config.parent().unwrap_or(Path::new(""));
    let out = scratch.join(n.to_string());
    let mut options = json!({ "outDir": out, "tsBuildInfoFile": scratch.join(format!("{n}.tsbuildinfo")) });
    if lookup(&chain, "compilerOptions.declarationDir").is_some() {
        options["declarationDir"] = json!(out);
    }
    if lookup(&chain, "compilerOptions.outFile").is_some() {
        options["outFile"] = json!(out.join("out.js"));
    }
    if lookup(&chain, "compilerOptions.composite").is_some_and(|(_, v)| v == &json!(true))
        && lookup(&chain, "compilerOptions.rootDir").is_none()
    {
        options["rootDir"] = json!(dir);
    }
    let mut copy = json!({
        "extends": config,
        "compilerOptions": options,
        "references": refs.iter().map(|r| json!({ "path": r })).collect::<Vec<_>>(),
    });
    if lookup(&chain, "include").is_none() && lookup(&chain, "files").is_none() {
        copy["include"] = json!([dir.join("**/*")]);
    }
    if lookup(&chain, "exclude").is_none() {
        let mut exclude = vec![dir.join("node_modules")];
        if let Some((base, Value::String(out_dir))) = lookup(&chain, "compilerOptions.outDir") {
            exclude.push(super::normalize(&base.join(out_dir)));
        }
        copy["exclude"] = json!(exclude);
    }
    copy
}

/// The `tsc` arguments that watch `config` without writing into the project, writing the
/// scratch configurations a solution needs into `scratch`.
fn watch_args(config: &Path, scratch: &Path) -> std::io::Result<Vec<String>> {
    let path = |p: &Path| p.to_string_lossy().into_owned();
    let mut args: Vec<String> = if references(config).is_empty() {
        let name = config.file_name().map_or_else(|| "tsconfig.json".into(), |n| n.to_string_lossy().into_owned());
        let info = path(&scratch.join("tsconfig.tsbuildinfo"));
        ["--noEmit", "-p", &name, "--incremental", "--tsBuildInfoFile", &info].map(String::from).to_vec()
    } else {
        // Every configuration the solution reaches gets a number: the solution 0, then in order.
        let mut numbers: BTreeMap<PathBuf, usize> = BTreeMap::from([(config.to_path_buf(), 0)]);
        let mut queue = vec![config.to_path_buf()];
        let mut i = 0;
        while i < queue.len() {
            let current = queue[i].clone();
            let refs: Vec<PathBuf> = references(&current)
                .into_iter()
                .map(|r| {
                    let next = numbers.len();
                    let n = *numbers.entry(r.clone()).or_insert_with(|| {
                        queue.push(r);
                        next
                    });
                    scratch.join(format!("{n}.json"))
                })
                .collect();
            let copy = scratch_config(&current, scratch, numbers[&current], &refs);
            std::fs::write(scratch.join(format!("{}.json", numbers[&current])), copy.to_string())?;
            i += 1;
        }
        vec!["-b".into(), path(&scratch.join("0.json"))]
    };
    args.extend(["--watch", "--pretty", "false", "--preserveWatchOutput"].map(String::from));
    Ok(args)
}

/// The project's own `tsc` (`node_modules/.bin` from the configuration's folder up to `root`).
fn local_tsc(root: &Path, dir: &Path) -> Option<PathBuf> {
    dir.ancestors()
        .take_while(|d| d.starts_with(root))
        .find_map(|d| ide_core::tool_path::find_command("tsc", d.join("node_modules/.bin").as_os_str(), dir))
}

/// The messages of one compilation at a time: tsc ends each with
/// `… - Found 2 errors. Watching for file changes.` `tsc -b` reports the errors of every
/// project of the solution that has some, rebuilt this time or not ("out of date because it had
/// errors"), so each compilation's list replaces the last.
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

/// A scratch folder of this process for `config`, removed when dropped.
struct Scratch(PathBuf);

impl Scratch {
    fn new(config: &Path) -> std::io::Result<Self> {
        use std::hash::{Hash, Hasher};
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        config.hash(&mut hash);
        let dir = std::env::temp_dir().join("openidea-tsc-watch").join(format!(
            "{}-{:016x}",
            std::process::id(),
            hash.finish()
        ));
        // Fresh: a `.tsbuildinfo` left by an earlier run would make tsc skip unchanged projects.
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir)?;
        Ok(Scratch(dir))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
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
    let scratch = Scratch::new(config)?;
    let args = watch_args(config, &scratch.0)?;
    let paths = PathMap::new(root);
    let mut compilations = Compilations::default();
    let program = tsc.to_string_lossy();
    process::run_bounded(&program, &args, dir, &BTreeMap::new(), cancel, |_, line| {
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
        let found = ["tools/cli", "packages/b", "", "packages/a"].map(|d| root.join(d).join("tsconfig.json"));
        assert_eq!(tsc_watch_roots(found.to_vec()), [root.join("tsconfig.json"), root.join("tools/cli/tsconfig.json")]);
    }

    #[test]
    fn a_solution_is_checked_through_scratch_copies_of_its_configurations() {
        let tmp = tempfile::tempdir().unwrap();
        let (root, scratch) = (tmp.path().join("p"), tmp.path().join("scratch"));
        std::fs::create_dir_all(&scratch).unwrap();
        write(
            &root,
            "tsconfig.json",
            r#"{"files": [], "references": [{"path": "./packages/a"}, {"path": "./packages/b"}]}"#,
        );
        // a: composite, every setting by default.
        write(&root, "packages/a/tsconfig.json", r#"{"compilerOptions": {"composite": true}}"#);
        // b: references a, settles its files, outputs and root in a shared base.
        write(
            &root,
            "packages/b/tsconfig.json",
            r#"{"extends": "../../tsconfig.base", "references": [{"path": "../a"}], "compilerOptions": {"outFile": "b.js"}}"#,
        );
        write(
            &root,
            "tsconfig.base.json",
            r#"{"compilerOptions": {"composite": true, "rootDir": ".", "outDir": "dist", "declarationDir": "types"},
                "include": ["packages/*/src"]}"#,
        );
        let args = watch_args(&root.join("tsconfig.json"), &scratch).unwrap();
        let s = |p: &str| scratch.join(p).to_string_lossy().into_owned();
        assert_eq!(args, ["-b", &s("0.json"), "--watch", "--pretty", "false", "--preserveWatchOutput"]);
        let copy = |n: usize| read_json(&scratch.join(format!("{n}.json"))).unwrap();
        let path = |p: &Path| json!(p);
        assert_eq!(
            copy(0),
            json!({
                "extends": path(&root.join("tsconfig.json")),
                "compilerOptions": {"outDir": path(&scratch.join("0")), "tsBuildInfoFile": s("0.tsbuildinfo")},
                "references": [{"path": s("1.json")}, {"path": s("2.json")}],
                "exclude": [path(&root.join("node_modules"))],
            })
        );
        let a = root.join("packages/a");
        assert_eq!(
            copy(1),
            json!({
                "extends": path(&a.join("tsconfig.json")),
                "compilerOptions": {
                    "outDir": path(&scratch.join("1")), "tsBuildInfoFile": s("1.tsbuildinfo"), "rootDir": path(&a),
                },
                "references": [],
                "include": [path(&a.join("**/*"))],
                "exclude": [path(&a.join("node_modules"))],
            })
        );
        let b = root.join("packages/b");
        assert_eq!(
            copy(2),
            json!({
                "extends": path(&b.join("tsconfig.json")),
                "compilerOptions": {
                    "outDir": path(&scratch.join("2")), "tsBuildInfoFile": s("2.tsbuildinfo"),
                    "declarationDir": path(&scratch.join("2")), "outFile": path(&scratch.join("2/out.js")),
                },
                "references": [{"path": s("1.json")}],
                "exclude": [path(&b.join("node_modules")), path(&root.join("dist"))],
            })
        );
    }

    #[test]
    fn a_composite_package_base_gets_its_root_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let (root, scratch) = (tmp.path().join("p"), tmp.path().join("scratch"));
        write(&root, "node_modules/@acme/tsconfig/base.json", r#"{"compilerOptions": {"composite": true}}"#);
        write(&root, "app/tsconfig.json", r#"{"extends": "@acme/tsconfig/base", "include": ["src"]}"#);
        let copy = scratch_config(&root.join("app/tsconfig.json"), &scratch, 3, &[]);
        assert_eq!(copy["compilerOptions"]["rootDir"], json!(root.join("app")));
        assert_eq!(copy.get("include"), None, "the files come from the real configuration");
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
        let (check, rest) = args.trim().split_once(" --tsBuildInfoFile ").unwrap();
        assert_eq!(check, "--noEmit -p tsconfig.json --incremental");
        let (info, watch) = rest.split_once(' ').unwrap();
        assert_eq!(watch, "--watch --pretty false --preserveWatchOutput");
        // The `.tsbuildinfo` goes to a scratch folder outside the project, gone with the watcher.
        let scratch = Path::new(info).parent().unwrap();
        assert!(scratch.starts_with(std::env::temp_dir()) && !scratch.starts_with(root), "{info}");
        assert!(!scratch.exists());
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
