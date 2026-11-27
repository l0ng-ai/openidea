//! Go files a gopls search does not reach.
//!
//! gopls answers a search from the view of the file it is asked about: the
//! modules of a `go.work`, or that file's own module, built for the host's
//! GOOS/GOARCH without extra tags. Opening more files does not widen it (each
//! gets a view of its own), so the generic scope widening is skipped for Go.
//! Usages it leaves out are found as GoLand finds them, by resolving each
//! mention of the name in its own file's view: files of other modules that use
//! the declaration's module through a local `replace` (a multi-module
//! repository without `go.work`), and files whose build constraints exclude
//! them from the default build (`_windows.go`, `//go:build`).

use ide_core::{Pos, Range};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// The files of `candidates` the search at `origin` does not cover and that can refer to
/// `declaration`: those of the covered modules excluded from their default build, and those
/// of the declaration's own module or one replacing it with its directory when not covered.
pub(crate) fn files_beyond_search(origin: &Path, declaration: &Path, candidates: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut modules = ModuleRoots::default();
    let (Some(origin_module), Some(declaring)) = (modules.of(origin), modules.of(declaration)) else {
        return Vec::new();
    };
    let Some(declaring_path) = read_module_path(&declaring) else { return Vec::new() };
    let mut covered: HashSet<PathBuf> = workspace_modules(&origin_module).into_iter().collect();
    covered.insert(origin_module);
    let mut uses: HashMap<PathBuf, bool> = HashMap::new();
    candidates
        .into_iter()
        .filter(|file| {
            let Some(module) = modules.of(file) else { return false };
            // The covered modules share the search's view: only their excluded files are missed.
            if covered.contains(&module) {
                return !in_default_build(file);
            }
            *uses.entry(module.clone()).or_insert_with(|| {
                module == declaring
                    || std::fs::read_to_string(module.join("go.mod")).is_ok_and(|text| {
                        local_replacements(&text, &module)
                            .iter()
                            .any(|(path, dir)| *path == declaring_path && *dir == declaring)
                    })
            })
        })
        .collect()
}

/// Whether gopls' default view builds `file`: no build constraint other than the host's
/// own GOOS/GOARCH file name suffix.
fn in_default_build(file: &Path) -> bool {
    let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let stem = name.strip_suffix(".go").unwrap_or(&name);
    let stem = stem.strip_suffix("_test").unwrap_or(stem);
    let parts: Vec<&str> = stem.split('_').collect();
    // `name_GOOS`, `name_GOARCH`, `name_GOOS_GOARCH`; a file named just `linux.go` has no constraint.
    let host = |part: &&str| *part == host_goos() || *part == host_goarch();
    if parts.len() > 1 {
        let last = parts[parts.len() - 1];
        if (GOOS.contains(&last) || GOARCH.contains(&last)) && !host(&last) {
            return false;
        }
        if parts.len() > 2 && GOARCH.contains(&last) {
            let os = parts[parts.len() - 2];
            if GOOS.contains(&os) && !host(&os) {
                return false;
            }
        }
    }
    std::fs::read_to_string(file).is_ok_and(|text| !constrained_header(&text))
}

/// A `//go:build` or `// +build` line before the package clause.
fn constrained_header(text: &str) -> bool {
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with("package ") {
            return false;
        }
        if line.starts_with("//go:build") || line.starts_with("// +build") {
            return true;
        }
    }
    false
}

fn host_goos() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        os => os,
    }
}

fn host_goarch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        "x86" => "386",
        "powerpc64" => "ppc64",
        arch => arch,
    }
}

const GOOS: &[&str] = &[
    "aix",
    "android",
    "darwin",
    "dragonfly",
    "freebsd",
    "hurd",
    "illumos",
    "ios",
    "js",
    "linux",
    "nacl",
    "netbsd",
    "openbsd",
    "plan9",
    "solaris",
    "wasip1",
    "windows",
    "zos",
];
const GOARCH: &[&str] = &[
    "386",
    "amd64",
    "amd64p32",
    "arm",
    "armbe",
    "arm64",
    "arm64be",
    "loong64",
    "mips",
    "mipsle",
    "mips64",
    "mips64le",
    "mips64p32",
    "mips64p32le",
    "ppc",
    "ppc64",
    "ppc64le",
    "riscv",
    "riscv64",
    "s390",
    "s390x",
    "sparc",
    "sparc64",
    "wasm",
];

/// Whole-word occurrences of `word` in `text`, as ranges in UTF-16 columns.
pub(crate) fn word_ranges(text: &str, word: &str) -> Vec<Range> {
    let ident = |c: char| c.is_alphanumeric() || c == '_';
    let mut out = Vec::new();
    for (line_no, line) in text.lines().enumerate() {
        let code = line.split("//").next().unwrap_or(line);
        for (at, _) in code.match_indices(word) {
            let before = code[..at].chars().next_back();
            let after = code[at + word.len()..].chars().next();
            if before.is_some_and(ident) || after.is_some_and(ident) {
                continue;
            }
            let col = code[..at].encode_utf16().count() as u32;
            let len = word.encode_utf16().count() as u32;
            out.push(Range::new(Pos::new(line_no as u32, col), Pos::new(line_no as u32, col + len)));
        }
    }
    out
}

/// Nearest enclosing `go.mod` directory, cached per directory.
#[derive(Default)]
struct ModuleRoots(HashMap<PathBuf, Option<PathBuf>>);

impl ModuleRoots {
    fn of(&mut self, file: &Path) -> Option<PathBuf> {
        let dir = file.parent()?.to_path_buf();
        self.dir(&dir)
    }

    fn dir(&mut self, dir: &Path) -> Option<PathBuf> {
        if let Some(found) = self.0.get(dir) {
            return found.clone();
        }
        let found =
            if dir.join("go.mod").is_file() { Some(dir.to_path_buf()) } else { dir.parent().and_then(|p| self.dir(p)) };
        self.0.insert(dir.to_path_buf(), found.clone());
        found
    }
}

fn read_module_path(module: &Path) -> Option<String> {
    let text = std::fs::read_to_string(module.join("go.mod")).ok()?;
    text.lines().find_map(|line| Some(unquote(line.trim().strip_prefix("module ")?.trim())))
}

/// The modules a `go.work` above `module` uses, as gopls loads them together.
fn workspace_modules(module: &Path) -> Vec<PathBuf> {
    let Some(work) = module.ancestors().map(|d| d.join("go.work")).find(|p| p.is_file()) else { return Vec::new() };
    let Ok(text) = std::fs::read_to_string(&work) else { return Vec::new() };
    let base = work.parent().unwrap_or(Path::new(""));
    directives(&text, "use").into_iter().map(|dir| normalize(&base.join(dir))).collect()
}

/// `replace <module> [version] => <local directory>` entries, directories resolved against `base`.
fn local_replacements(go_mod: &str, base: &Path) -> Vec<(String, PathBuf)> {
    directives(go_mod, "replace")
        .into_iter()
        .filter_map(|entry| {
            let (from, to) = entry.split_once("=>")?;
            let from = unquote(from.split_whitespace().next()?);
            let to = unquote(to.split_whitespace().next()?);
            let local = to.starts_with("./")
                || to.starts_with("../")
                || Path::new(&to).is_absolute()
                || to == "."
                || to == "..";
            local.then(|| (from, normalize(&base.join(to))))
        })
        .collect()
}

/// The arguments of `keyword` directives, single-line and block form.
fn directives(text: &str, keyword: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut in_block = false;
    for line in text.lines() {
        let line = line.split("//").next().unwrap_or("").trim();
        if in_block {
            if line == ")" {
                in_block = false;
            } else if !line.is_empty() {
                out.push(line.to_owned());
            }
        } else if let Some(rest) = line.strip_prefix(keyword)
            && rest.starts_with([' ', '\t', '('])
        {
            let rest = rest.trim();
            if rest == "(" {
                in_block = true;
            } else if !rest.is_empty() {
                out.push(rest.to_owned());
            }
        }
    }
    out
}

fn unquote(s: &str) -> String {
    s.trim_matches(|c| c == '"' || c == '`').to_owned()
}

fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, rel: &str, text: &str) -> PathBuf {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, text).unwrap();
        path
    }

    fn names(root: &Path, files: Vec<PathBuf>) -> Vec<String> {
        files.iter().map(|f| f.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/")).collect()
    }

    #[test]
    fn modules_replacing_the_declarations_module_are_searched() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, "go.mod", "module example.com/app\n");
        let origin = write(root, "app.go", "package app\nfunc New() {}\n");
        write(root, "example/a/go.mod", "module a\n\nreplace example.com/app => ../..\n");
        write(root, "example/b/go.mod", "module b\n\nreplace (\n\texample.com/app v1.0.0 => \"../../\"\n)\n");
        write(root, "example/c/go.mod", "module c\n\nrequire example.com/app v1.0.0\n");
        write(root, "example/d/go.mod", "module d\n\nreplace example.com/app => github.com/fork/app v1.0.0\n");
        let candidates = vec![
            write(root, "same.go", "package app\n"),
            write(root, "same_plan9.go", "package app\n"),
            write(root, &format!("same_{}.go", host_goos()), "package app\n"),
            write(root, "same_plan9_test.go", "package app\n"),
            write(root, "tagged.go", "// Copyright\n\n//go:build integration\n\npackage app\n"),
            write(root, "plan9.go", "package app\n"),
            write(root, "example/a/main.go", "package main\n"),
            write(root, "example/b/main.go", "package main\n"),
            write(root, "example/c/main.go", "package main\n"),
            write(root, "example/d/main.go", "package main\n"),
        ];
        assert_eq!(
            names(root, files_beyond_search(&origin, &origin, candidates)),
            ["same_plan9.go", "same_plan9_test.go", "tagged.go", "example/a/main.go", "example/b/main.go"]
        );
    }

    #[test]
    fn go_work_modules_are_covered_by_the_first_search() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, "go.work", "go 1.22\n\nuse (\n\t./lib // shared\n\t./app\n)\n");
        write(root, "lib/go.mod", "module example.com/lib\n");
        write(root, "app/go.mod", "module example.com/app\n\nreplace example.com/lib => ../lib\n");
        write(root, "tool/go.mod", "module example.com/tool\n\nreplace example.com/lib => ../lib\n");
        let declaration = write(root, "lib/lib.go", "package lib\n");
        let candidates = vec![
            write(root, "app/main.go", "package main\n"),
            write(root, "app/main_plan9.go", "package main\n"),
            write(root, "tool/main.go", "package main\n"),
        ];
        assert_eq!(
            names(root, files_beyond_search(&declaration, &declaration, candidates)),
            ["app/main_plan9.go", "tool/main.go"]
        );
    }

    #[test]
    fn a_usage_site_in_another_module_searches_the_declaring_module() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write(root, "go.mod", "module example.com/app\n");
        let declaration = write(root, "app.go", "package app\n");
        write(root, "cmd/go.mod", "module cmd\n\nreplace example.com/app => ../\n");
        let origin = write(root, "cmd/main.go", "package main\n");
        let candidates = vec![write(root, "other.go", "package app\n"), write(root, "cmd/util.go", "package main\n")];
        assert_eq!(names(root, files_beyond_search(&origin, &declaration, candidates)), ["other.go"]);
    }

    #[test]
    fn word_ranges_are_whole_words_outside_line_comments() {
        let text = "x := app.New() // New here\nNewer := New\n\tvar é = New()\n";
        assert_eq!(
            word_ranges(text, "New"),
            [
                Range::new(Pos::new(0, 9), Pos::new(0, 12)),
                Range::new(Pos::new(1, 9), Pos::new(1, 12)),
                Range::new(Pos::new(2, 9), Pos::new(2, 12)),
            ]
        );
    }
}
