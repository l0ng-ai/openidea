use crate::LanguageConfig;
use ide_core::settings::{FileSettings, FileTypeAssociation};
use ide_core::{IdeError, IdeResult, LanguageId};
use parking_lot::RwLock;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Built-in definitions, embedded at compile time. Add new languages here.
const BUILTIN: &[(&str, &str)] = &[
    ("c", include_str!("../../../languages/c.toml")),
    ("clojure", include_str!("../../../languages/clojure.toml")),
    ("cmake", include_str!("../../../languages/cmake.toml")),
    ("cpp", include_str!("../../../languages/cpp.toml")),
    ("csharp", include_str!("../../../languages/csharp.toml")),
    ("css", include_str!("../../../languages/css.toml")),
    ("dart", include_str!("../../../languages/dart.toml")),
    ("diff", include_str!("../../../languages/diff.toml")),
    ("dockerfile", include_str!("../../../languages/dockerfile.toml")),
    ("dotenv", include_str!("../../../languages/dotenv.toml")),
    ("elixir", include_str!("../../../languages/elixir.toml")),
    ("erlang", include_str!("../../../languages/erlang.toml")),
    ("fsharp", include_str!("../../../languages/fsharp.toml")),
    ("gitattributes", include_str!("../../../languages/gitattributes.toml")),
    ("gdscript", include_str!("../../../languages/gdscript.toml")),
    ("gdshader", include_str!("../../../languages/gdshader.toml")),
    ("go", include_str!("../../../languages/go.toml")),
    ("gomod", include_str!("../../../languages/gomod.toml")),
    ("gowork", include_str!("../../../languages/gowork.toml")),
    ("godot-resource", include_str!("../../../languages/godot-resource.toml")),
    ("graphql", include_str!("../../../languages/graphql.toml")),
    ("groovy", include_str!("../../../languages/groovy.toml")),
    ("haskell", include_str!("../../../languages/haskell.toml")),
    ("hcl", include_str!("../../../languages/hcl.toml")),
    ("html", include_str!("../../../languages/html.toml")),
    ("http", include_str!("../../../languages/http.toml")),
    ("ignore", include_str!("../../../languages/ignore.toml")),
    ("ini", include_str!("../../../languages/ini.toml")),
    ("java", include_str!("../../../languages/java.toml")),
    ("javascript", include_str!("../../../languages/javascript.toml")),
    ("javascriptreact", include_str!("../../../languages/javascriptreact.toml")),
    ("json", include_str!("../../../languages/json.toml")),
    ("jsonc", include_str!("../../../languages/jsonc.toml")),
    ("julia", include_str!("../../../languages/julia.toml")),
    ("kotlin", include_str!("../../../languages/kotlin.toml")),
    ("latex", include_str!("../../../languages/latex.toml")),
    ("less", include_str!("../../../languages/less.toml")),
    ("log", include_str!("../../../languages/log.toml")),
    ("lua", include_str!("../../../languages/lua.toml")),
    ("makefile", include_str!("../../../languages/makefile.toml")),
    ("markdown", include_str!("../../../languages/markdown.toml")),
    ("nix", include_str!("../../../languages/nix.toml")),
    ("objective-c", include_str!("../../../languages/objective-c.toml")),
    ("objective-cpp", include_str!("../../../languages/objective-cpp.toml")),
    ("ocaml", include_str!("../../../languages/ocaml.toml")),
    ("ocaml-interface", include_str!("../../../languages/ocaml-interface.toml")),
    ("perl", include_str!("../../../languages/perl.toml")),
    ("php", include_str!("../../../languages/php.toml")),
    ("plaintext", include_str!("../../../languages/plaintext.toml")),
    ("powershell", include_str!("../../../languages/powershell.toml")),
    ("properties", include_str!("../../../languages/properties.toml")),
    ("proto", include_str!("../../../languages/proto.toml")),
    ("python", include_str!("../../../languages/python.toml")),
    ("r", include_str!("../../../languages/r.toml")),
    ("ruby", include_str!("../../../languages/ruby.toml")),
    ("rust", include_str!("../../../languages/rust.toml")),
    ("sass", include_str!("../../../languages/sass.toml")),
    ("scala", include_str!("../../../languages/scala.toml")),
    ("scss", include_str!("../../../languages/scss.toml")),
    ("shellscript", include_str!("../../../languages/shellscript.toml")),
    ("sql", include_str!("../../../languages/sql.toml")),
    ("svelte", include_str!("../../../languages/svelte.toml")),
    ("swift", include_str!("../../../languages/swift.toml")),
    ("terraform", include_str!("../../../languages/terraform.toml")),
    ("terraform-vars", include_str!("../../../languages/terraform-vars.toml")),
    ("toml", include_str!("../../../languages/toml.toml")),
    ("typescript", include_str!("../../../languages/typescript.toml")),
    ("typescriptreact", include_str!("../../../languages/typescriptreact.toml")),
    ("vue", include_str!("../../../languages/vue.toml")),
    ("xml", include_str!("../../../languages/xml.toml")),
    ("yaml", include_str!("../../../languages/yaml.toml")),
    ("zig", include_str!("../../../languages/zig.toml")),
];

pub struct LanguageRegistry {
    languages: Vec<LanguageConfig>,
    /// Lookup tables of the definitions with the user's file types applied.
    tables: RwLock<Arc<Tables>>,
    file_types: RwLock<FileTypes>,
}

/// The user's file type associations (Settings › Editor › File Types) and
/// per-file overrides (Override File Type), resolved for one project.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FileTypes {
    /// Language id → patterns added to / removed from its definition.
    pub associations: BTreeMap<String, FileTypeAssociation>,
    /// Absolute path → language id.
    pub overrides: HashMap<PathBuf, LanguageId>,
}

impl FileTypes {
    /// From `files.fileTypes` / `files.fileTypeOverrides`; relative override paths resolve against `root`.
    pub fn from_settings(files: &FileSettings, root: Option<&Path>) -> Self {
        let overrides = files
            .file_type_overrides
            .iter()
            .filter(|(_, lang)| !lang.trim().is_empty())
            .filter_map(|(path, lang)| {
                let p = Path::new(path.as_str());
                let abs = if p.is_absolute() { p.to_path_buf() } else { root?.join(p) };
                Some((abs, LanguageId::new(lang.trim())))
            })
            .collect();
        Self { associations: files.file_types.clone(), overrides }
    }
}

#[derive(Default)]
struct Tables {
    by_ext: HashMap<String, usize>,
    by_name: HashMap<String, usize>,
    /// File-name patterns with wildcards, e.g. `Dockerfile.*`, `tsconfig.*.json`; the user's first.
    name_globs: Vec<(String, usize)>,
    /// Interpreter names of user hashbang patterns.
    hashbangs: Vec<(String, usize)>,
    first_line: Vec<(regex_lite::Regex, usize)>,
    overrides: HashMap<PathBuf, usize>,
}

/// How a file name pattern is looked up.
enum Pattern<'a> {
    /// `*.ext` (lower-cased).
    Ext(String),
    Name(&'a str),
    Glob(&'a str),
}

fn classify(pattern: &str) -> Pattern<'_> {
    let wild = |s: &str| s.contains(['*', '?']);
    match pattern.strip_prefix("*.") {
        Some(ext) if !ext.is_empty() && !wild(ext) => Pattern::Ext(ext.to_ascii_lowercase()),
        _ if wild(pattern) => Pattern::Glob(pattern),
        _ => Pattern::Name(pattern),
    }
}

impl Tables {
    fn build(languages: &[LanguageConfig], file_types: &FileTypes) -> Self {
        let mut t = Tables::default();
        let index_of = |id: &str| languages.iter().position(|l| l.id.as_str() == id);
        let removed = |l: &LanguageConfig, pattern: &str| {
            file_types.associations.get(l.id.as_str()).is_some_and(|a| {
                a.removed_patterns.iter().any(|r| r.trim() == pattern || r.trim().eq_ignore_ascii_case(pattern))
            })
        };
        let mut builtin_globs = Vec::new();
        for (i, l) in languages.iter().enumerate() {
            for ext in &l.extensions {
                if !removed(l, &format!("*.{ext}")) {
                    t.by_ext.insert(ext.to_ascii_lowercase(), i);
                }
            }
            for name in l.filenames.iter().filter(|n| !removed(l, n)) {
                if name.contains(['*', '?']) {
                    builtin_globs.push((name.clone(), i));
                } else {
                    t.by_name.insert(name.clone(), i);
                }
            }
            if let Some(pattern) = l.first_line.as_deref() {
                match regex_lite::Regex::new(pattern) {
                    Ok(re) => t.first_line.push((re, i)),
                    Err(e) => tracing::warn!("language {}: invalid first-line pattern: {e}", l.id),
                }
            }
        }
        // The user's patterns win over the definitions'.
        let mut user_globs = Vec::new();
        for (id, assoc) in &file_types.associations {
            let Some(i) = index_of(id) else { continue };
            for pattern in assoc.patterns.iter().map(|p| p.trim()).filter(|p| !p.is_empty()) {
                match classify(pattern) {
                    Pattern::Ext(ext) => {
                        t.by_ext.insert(ext, i);
                    }
                    Pattern::Name(name) => {
                        t.by_name.insert(name.to_owned(), i);
                    }
                    Pattern::Glob(glob) => user_globs.push((glob.to_owned(), i)),
                }
            }
            for h in assoc.hashbangs.iter().map(|h| h.trim()).filter(|h| !h.is_empty()) {
                t.hashbangs.push((h.to_owned(), i));
            }
        }
        // More specific (longer) patterns first: `tsconfig.*.json` before `*.json`-like ones.
        user_globs.sort_by_key(|(p, _): &(String, usize)| std::cmp::Reverse(p.len()));
        builtin_globs.sort_by_key(|(p, _): &(String, usize)| std::cmp::Reverse(p.len()));
        t.name_globs = user_globs.into_iter().chain(builtin_globs).collect();
        t.overrides =
            file_types.overrides.iter().filter_map(|(p, id)| Some((p.clone(), index_of(id.as_str())?))).collect();
        t
    }
}

/// Whether the `#!` line runs `interpreter` (`#!/usr/bin/env node`, `#!/bin/node -x` for `node`).
fn hashbang_runs(line: &str, interpreter: &str) -> bool {
    let Some(rest) = line.strip_prefix("#!") else { return false };
    rest.split(|c: char| c.is_whitespace() || c == '/').any(|token| token == interpreter)
}

impl LanguageRegistry {
    /// Loads the built-in definitions plus `*.toml` overrides from `user_dir`
    /// (a user file with the same `id` replaces the built-in one).
    pub fn load(user_dir: Option<&Path>) -> IdeResult<Self> {
        let mut configs = Vec::new();
        for (name, src) in BUILTIN {
            configs.push(parse(src).map_err(|e| IdeError::internal(format!("languages/{name}.toml: {e}")))?);
        }
        if let Some(dir) = user_dir.filter(|d| d.is_dir()) {
            for entry in std::fs::read_dir(dir)?.flatten() {
                let path = entry.path();
                if path.extension().is_some_and(|e| e == "toml") {
                    match std::fs::read_to_string(&path).map_err(|e| e.to_string()).and_then(|s| parse(&s)) {
                        Ok(cfg) => configs.push(cfg),
                        Err(e) => tracing::warn!("ignoring {}: {e}", path.display()),
                    }
                }
            }
        }
        Ok(Self::from_configs(configs))
    }

    /// Builds a registry from explicit configs; later entries override earlier ones by id.
    pub fn from_configs(configs: Vec<LanguageConfig>) -> Self {
        let mut languages: Vec<LanguageConfig> = Vec::new();
        for cfg in configs {
            match languages.iter_mut().find(|l| l.id == cfg.id) {
                Some(existing) => *existing = cfg,
                None => languages.push(cfg),
            }
        }
        let tables = Tables::build(&languages, &FileTypes::default());
        Self { languages, tables: RwLock::new(Arc::new(tables)), file_types: RwLock::default() }
    }

    /// A registry with the same definitions and no user file types (one per project).
    pub fn fork(&self) -> Self {
        Self::from_configs(self.languages.clone())
    }

    /// A copy with the same definitions and file types (to compare detection before / after a change).
    pub fn snapshot(&self) -> Self {
        let copy = self.fork();
        copy.set_file_types(self.file_types.read().clone());
        copy
    }

    /// Applies the user's file types; returns whether they changed.
    pub fn set_file_types(&self, file_types: FileTypes) -> bool {
        let mut current = self.file_types.write();
        if *current == file_types {
            return false;
        }
        *self.tables.write() = Arc::new(Tables::build(&self.languages, &file_types));
        *current = file_types;
        true
    }

    pub fn all(&self) -> Vec<LanguageConfig> {
        self.languages.clone()
    }

    pub fn get(&self, id: &LanguageId) -> Option<LanguageConfig> {
        self.languages.iter().find(|l| &l.id == id).cloned()
    }

    /// Detects by Override File Type, exact file name, then file-name pattern
    /// (`Dockerfile.*`), then extension (longest compound first, e.g. `d.ts`),
    /// then hashbang / first line; falls back to plaintext. The user's patterns
    /// win over the definitions'.
    pub fn detect(&self, path: &Path, first_line: Option<&str>) -> LanguageId {
        let t = self.tables.read().clone();
        if !t.overrides.is_empty()
            && let Some(&i) = t.overrides.get(path)
        {
            return self.languages[i].id.clone();
        }
        let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
        if let Some(&i) = t.by_name.get(file_name) {
            return self.languages[i].id.clone();
        }
        if let Some((_, i)) = t.name_globs.iter().find(|(p, _)| wildcard_match(p, file_name)) {
            return self.languages[*i].id.clone();
        }
        let lower = file_name.to_ascii_lowercase();
        let mut rest = lower.as_str();
        while let Some(dot) = rest.find('.') {
            rest = &rest[dot + 1..];
            if let Some(&i) = t.by_ext.get(rest) {
                return self.languages[i].id.clone();
            }
        }
        if let Some(line) = first_line {
            if let Some((_, i)) = t.hashbangs.iter().find(|(h, _)| hashbang_runs(line, h)) {
                return self.languages[*i].id.clone();
            }
            if let Some((_, i)) = t.first_line.iter().find(|(re, _)| re.is_match(line)) {
                return self.languages[*i].id.clone();
            }
        }
        LanguageId::plain_text()
    }
}

/// `*` matches any (possibly empty) run of characters, `?` exactly one; everything else is literal.
fn wildcard_match(pattern: &str, name: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let n: Vec<char> = name.chars().collect();
    let (mut pi, mut ni) = (0, 0);
    // Position after the last `*` and the name position it is matched up to.
    let mut star: Option<(usize, usize)> = None;
    while ni < n.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == n[ni]) {
            pi += 1;
            ni += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some((pi + 1, ni));
            pi += 1;
        } else if let Some((sp, sn)) = star {
            pi = sp;
            ni = sn + 1;
            star = Some((sp, sn + 1));
        } else {
            return false;
        }
    }
    p[pi..].iter().all(|&c| c == '*')
}

fn parse(src: &str) -> Result<LanguageConfig, String> {
    toml::from_str(src).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    /// `name`s exported by `@codemirror/language-data` (the UI resolves `ui-mode` against these).
    const UI_MODES: &[&str] = &[
        "C",
        "C++",
        "CQL",
        "CSS",
        "Go",
        "HTML",
        "Java",
        "JavaScript",
        "Jinja",
        "JSON",
        "JSX",
        "LESS",
        "Liquid",
        "MariaDB SQL",
        "Markdown",
        "MS SQL",
        "MySQL",
        "PHP",
        "PLSQL",
        "PostgreSQL",
        "Python",
        "Rust",
        "Sass",
        "SCSS",
        "SQL",
        "SQLite",
        "TSX",
        "TypeScript",
        "WebAssembly",
        "XML",
        "YAML",
        "APL",
        "PGP",
        "ASN.1",
        "Asterisk",
        "Brainfuck",
        "Cobol",
        "C#",
        "Clojure",
        "ClojureScript",
        "Closure Stylesheets (GSS)",
        "CMake",
        "CoffeeScript",
        "Common Lisp",
        "Cypher",
        "Cython",
        "Crystal",
        "D",
        "Dart",
        "diff",
        "Dockerfile",
        "DTD",
        "Dylan",
        "EBNF",
        "ECL",
        "edn",
        "Eiffel",
        "Elm",
        "Erlang",
        "Esper",
        "Factor",
        "FCL",
        "Forth",
        "Fortran",
        "F#",
        "Gas",
        "Gherkin",
        "Groovy",
        "Haskell",
        "Haxe",
        "HXML",
        "HTTP",
        "IDL",
        "JSON-LD",
        "Julia",
        "Kotlin",
        "LiveScript",
        "Lua",
        "mIRC",
        "Mathematica",
        "Modelica",
        "MUMPS",
        "Mbox",
        "Nginx",
        "NSIS",
        "NTriples",
        "Objective-C",
        "Objective-C++",
        "OCaml",
        "Octave",
        "Oz",
        "Pascal",
        "Perl",
        "Pig",
        "PowerShell",
        "Properties files",
        "ProtoBuf",
        "Pug",
        "Puppet",
        "Q",
        "R",
        "RPM Changes",
        "RPM Spec",
        "Ruby",
        "SAS",
        "Scala",
        "Scheme",
        "Shell",
        "Sieve",
        "Smalltalk",
        "Solr",
        "SML",
        "SPARQL",
        "Spreadsheet",
        "Squirrel",
        "Stylus",
        "Swift",
        "sTeX",
        "LaTeX",
        "SystemVerilog",
        "Tcl",
        "Textile",
        "TiddlyWiki",
        "Tiki wiki",
        "TOML",
        "Troff",
        "TTCN",
        "TTCN_CFG",
        "Turtle",
        "Web IDL",
        "VB.NET",
        "VBScript",
        "Velocity",
        "Verilog",
        "VHDL",
        "XQuery",
        "Yacas",
        "Z80",
        "MscGen",
        "Xù",
        "MsGenny",
        "Vue",
        "Angular Template",
    ];

    fn reg() -> LanguageRegistry {
        LanguageRegistry::load(None).unwrap()
    }

    fn detect(reg: &LanguageRegistry, path: &str) -> String {
        reg.detect(Path::new(path), None).0
    }

    #[test]
    fn builtins_parse_and_detect() {
        let reg = reg();
        assert_eq!(detect(&reg, "src/main.rs"), "rust");
        assert_eq!(detect(&reg, "a/b.TS"), "typescript");
        assert_eq!(reg.detect(Path::new("script"), Some("#!/usr/bin/env python3")).as_str(), "python");
        assert_eq!(detect(&reg, "README"), "plaintext");
        assert_eq!(detect(&reg, "unknown.zzz"), "plaintext");
        let rust = reg.get(&LanguageId::new("rust")).unwrap();
        assert_eq!(rust.language_servers[0].name, "rust-analyzer");
    }

    #[test]
    fn alternative_servers_are_fallbacks() {
        let reg = reg();
        for (lang, servers) in [
            ("python", vec!["basedpyright", "pyright", "ty"]),
            ("typescript", vec!["vtsls", "typescript-language-server"]),
        ] {
            let cfg = reg.get(&LanguageId::new(lang)).unwrap();
            let got: Vec<(&str, bool)> = cfg
                .language_servers
                .iter()
                .filter(|s| !s.require_root_marker)
                .map(|s| (s.name.as_str(), s.fallback))
                .collect();
            let expected: Vec<(&str, bool)> = servers.iter().enumerate().map(|(i, name)| (*name, i > 0)).collect();
            assert_eq!(got, expected);
        }
    }

    #[test]
    fn angular_server_joins_typescript_and_html_in_angular_projects() {
        let reg = reg();
        let names = |lang: &str| -> Vec<String> {
            reg.get(&LanguageId::new(lang)).unwrap().language_servers.iter().map(|s| s.name.clone()).collect()
        };
        // After the TypeScript fallback (an available server before it would hide
        // it); before the HTML server (hover, rename and symbols take the first).
        assert_eq!(names("typescript"), ["vtsls", "typescript-language-server", "angular-language-server"]);
        assert_eq!(names("html"), ["angular-language-server", "vscode-html-language-server"]);
        for lang in ["typescript", "html"] {
            let cfg = reg.get(&LanguageId::new(lang)).unwrap();
            let angular = cfg.language_servers.iter().find(|s| s.name == "angular-language-server").unwrap();
            assert!(angular.require_root_marker && !angular.fallback, "{lang}");
            assert_eq!(angular.root_markers, ["angular.json", "node_modules/@angular/core"], "{lang}");
        }
    }

    #[test]
    fn every_builtin_file_is_registered_and_parses() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../languages");
        let on_disk: HashSet<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter_map(|e| e.file_name().to_str()?.strip_suffix(".toml").map(str::to_owned))
            .collect();
        let registered: HashSet<String> = BUILTIN.iter().map(|(n, _)| (*n).to_owned()).collect();
        assert_eq!(on_disk, registered, "languages/*.toml and BUILTIN differ");
        for (name, src) in BUILTIN {
            let cfg = parse(src).unwrap_or_else(|e| panic!("languages/{name}.toml: {e}"));
            assert!(!cfg.name.is_empty(), "{name}: empty name");
            if let Some(re) = &cfg.first_line {
                regex_lite::Regex::new(re).unwrap_or_else(|e| panic!("{name}: bad first-line: {e}"));
            }
            for ls in &cfg.language_servers {
                assert!(!ls.command.is_empty() && ls.install_hint.is_some(), "{name}: {} incomplete", ls.name);
                if let Some(addr) = &ls.connect {
                    assert!(addr.parse::<std::net::SocketAddr>().is_ok(), "{name}: bad connect address {addr}");
                }
            }
            if let Some(d) = &cfg.debugger {
                assert!(matches!(d.transport.as_str(), "stdio" | "tcp"), "{name}: bad transport");
                assert!(d.install_hint.is_some(), "{name}: debugger without install hint");
                if let Some(addr) = &d.connect {
                    assert_eq!(d.transport, "tcp", "{name}: `connect` needs the tcp transport");
                    assert!(addr.parse::<std::net::SocketAddr>().is_ok(), "{name}: bad connect address {addr}");
                }
            }
            for ext in &cfg.extensions {
                assert_eq!(ext, &ext.to_ascii_lowercase(), "{name}: extensions must be lower case");
                assert!(!ext.starts_with('.'), "{name}: extension {ext} must not start with a dot");
            }
        }
    }

    #[test]
    fn ids_are_unique() {
        let mut seen = HashSet::new();
        for (name, src) in BUILTIN {
            let cfg = parse(src).unwrap();
            assert!(seen.insert(cfg.id.0.clone()), "duplicate id {} ({name})", cfg.id);
        }
    }

    #[test]
    fn extensions_and_filenames_do_not_collide() {
        let mut exts: HashMap<String, String> = HashMap::new();
        let mut names: HashMap<String, String> = HashMap::new();
        for (_, src) in BUILTIN {
            let cfg = parse(src).unwrap();
            for ext in &cfg.extensions {
                if let Some(other) = exts.insert(ext.clone(), cfg.id.0.clone()) {
                    panic!("extension .{ext} claimed by {other} and {}", cfg.id);
                }
            }
            for n in &cfg.filenames {
                if let Some(other) = names.insert(n.clone(), cfg.id.0.clone()) {
                    panic!("file name {n} claimed by {other} and {}", cfg.id);
                }
            }
        }
    }

    #[test]
    fn ui_modes_exist_in_codemirror_language_data() {
        for (name, src) in BUILTIN {
            let cfg = parse(src).unwrap();
            if let Some(mode) = &cfg.ui_mode {
                assert!(UI_MODES.contains(&mode.as_str()), "{name}: ui-mode {mode:?} is not a language-data name");
            }
        }
    }

    #[test]
    fn tree_sitter_names_are_bundled() {
        let grammars: HashSet<&str> = crate::Syntax::grammar_names().collect();
        for (name, src) in BUILTIN {
            let cfg = parse(src).unwrap();
            if let Some(ts) = &cfg.tree_sitter {
                assert!(grammars.contains(ts.as_str()), "{name}: tree-sitter grammar {ts:?} is not bundled");
            }
        }
    }

    #[test]
    fn detects_the_catalogue() {
        let reg = reg();
        let cases = [
            ("lib.rs", "rust"),
            ("index.d.ts", "typescript"),
            ("App.tsx", "typescriptreact"),
            ("a.mjs", "javascript"),
            ("Button.jsx", "javascriptreact"),
            ("stub.pyi", "python"),
            ("main.go", "go"),
            ("go.mod", "go.mod"),
            ("Main.java", "java"),
            ("Main.kt", "kotlin"),
            ("build.gradle.kts", "kotlin"),
            ("build.gradle", "groovy"),
            ("Jenkinsfile", "groovy"),
            ("App.scala", "scala"),
            ("build.sbt", "scala"),
            ("x.c", "c"),
            ("x.h", "c"),
            ("x.hpp", "cpp"),
            ("x.cc", "cpp"),
            ("P.cs", "csharp"),
            ("V.swift", "swift"),
            ("AppDelegate.m", "objective-c"),
            ("a.rb", "ruby"),
            ("Gemfile", "ruby"),
            ("index.php", "php"),
            ("init.lua", "lua"),
            ("main.dart", "dart"),
            ("build.zig", "zig"),
            ("mix.exs", "elixir"),
            ("Main.hs", "haskell"),
            ("a.ml", "ocaml"),
            ("a.mli", "ocaml.interface"),
            ("analysis.R", "r"),
            ("a.jl", "julia"),
            ("deploy.sh", "shellscript"),
            (".zshrc", "shellscript"),
            ("Build.ps1", "powershell"),
            ("schema.sql", "sql"),
            ("api.http", "http"),
            ("api.rest", "http"),
            ("index.html", "html"),
            ("a.css", "css"),
            ("a.scss", "scss"),
            ("a.less", "less"),
            ("App.vue", "vue"),
            ("App.svelte", "svelte"),
            ("package.json", "json"),
            ("tsconfig.json", "jsonc"),
            ("tsconfig.app.json", "jsonc"),
            ("ci.yml", "yaml"),
            ("Cargo.toml", "toml"),
            ("Cargo.lock", "toml"),
            ("pom.xml", "xml"),
            ("README.md", "markdown"),
            ("Dockerfile", "dockerfile"),
            ("Dockerfile.dev", "dockerfile"),
            ("Makefile", "makefile"),
            ("rules.mk", "makefile"),
            ("CMakeLists.txt", "cmake"),
            ("api.proto", "proto"),
            ("schema.graphql", "graphql"),
            ("main.tf", "terraform"),
            ("prod.tfvars", "terraform-vars"),
            ("job.nomad", "hcl"),
            ("flake.nix", "nix"),
            ("setup.cfg", "ini"),
            ("app.properties", "properties"),
            (".env", "dotenv"),
            (".env.local", "dotenv"),
            (".gitignore", "ignore"),
            (".gitattributes", "gitattributes"),
            ("server.log", "log"),
            ("player.gd", "gdscript"),
            ("main.tscn", "godot-resource"),
            ("theme.tres", "godot-resource"),
            ("project.godot", "godot-resource"),
            ("icon.svg.import", "godot-resource"),
            ("export_presets.cfg", "godot-resource"),
            ("water.gdshader", "gdshader"),
            ("notes.txt", "plaintext"),
        ];
        for (path, id) in cases {
            assert_eq!(detect(&reg, path), id, "{path}");
        }
    }

    #[test]
    fn gdscript_definition() {
        let reg = reg();
        let gd = reg.get(&LanguageId::new("gdscript")).unwrap();
        assert_eq!(gd.line_comment.as_deref(), Some("#"));
        let indent = gd.indent.unwrap();
        assert!(!indent.insert_spaces, "Godot indents with tabs");
        assert_eq!(gd.tree_sitter.as_deref(), Some("gdscript"));
        let ls = &gd.language_servers[0];
        assert_eq!((ls.name.as_str(), ls.command.as_str()), ("godot", "godot"));
        assert_eq!(ls.connect.as_deref(), Some("127.0.0.1:6005"));
        assert_eq!(ls.root_markers, ["project.godot"]);
        assert!(ls.args.iter().any(|a| a == "${port}") && ls.args.iter().any(|a| a == "${root}"));
        let dbg = gd.debugger.as_ref().unwrap();
        assert_eq!((dbg.adapter.as_str(), dbg.transport.as_str()), ("godot", "tcp"));
        assert_eq!(dbg.connect.as_deref(), Some("127.0.0.1:6006"));
        assert!(dbg.args.iter().any(|a| a == "--dap-port"));
        let res = reg.get(&LanguageId::new("godot-resource")).unwrap();
        assert_eq!(res.line_comment.as_deref(), Some(";"));
    }

    #[test]
    fn detects_shebangs() {
        let reg = reg();
        let cases = [
            ("#!/bin/bash", "shellscript"),
            ("#!/usr/bin/env zsh", "shellscript"),
            ("#!/bin/sh -e", "shellscript"),
            ("#!/usr/bin/env node", "javascript"),
            ("#!/usr/bin/env ruby", "ruby"),
            ("#!/usr/bin/perl -w", "perl"),
            ("<?php", "php"),
            ("<?xml version=\"1.0\"?>", "xml"),
            ("<!DOCTYPE html>", "html"),
        ];
        for (line, id) in cases {
            assert_eq!(reg.detect(Path::new("noext"), Some(line)).as_str(), id, "{line}");
        }
    }

    #[test]
    fn wildcard_matching() {
        assert!(wildcard_match("Dockerfile.*", "Dockerfile.dev"));
        assert!(!wildcard_match("Dockerfile.*", "Dockerfile"));
        assert!(wildcard_match("tsconfig.*.json", "tsconfig.base.json"));
        assert!(!wildcard_match("tsconfig.*.json", "tsconfig.json"));
        assert!(wildcard_match("*.Dockerfile", "web.Dockerfile"));
        assert!(wildcard_match("a*b*c", "aXbYc"));
        assert!(!wildcard_match("a*b*c", "aXcYb"));
        assert!(wildcard_match("file?.txt", "file1.txt"));
        assert!(!wildcard_match("file?.txt", "file.txt"));
        assert!(wildcard_match("*", ""));
        assert!(wildcard_match("a**", "abc"));
    }

    fn assoc(patterns: &[&str], removed: &[&str], hashbangs: &[&str]) -> FileTypeAssociation {
        let v = |xs: &[&str]| xs.iter().map(|s| (*s).to_owned()).collect();
        FileTypeAssociation { patterns: v(patterns), removed_patterns: v(removed), hashbangs: v(hashbangs) }
    }

    #[test]
    fn user_file_types_add_remove_and_win() {
        let reg = reg();
        let mut ft = FileTypes::default();
        ft.associations
            .insert("python".into(), assoc(&["*.foo", "Pipfile.lock", "build_*.cfg", "*.LOG"], &[], &["mypy"]));
        ft.associations.insert("groovy".into(), assoc(&[], &["Jenkinsfile"], &[]));
        ft.associations.insert("shellscript".into(), assoc(&["Jenkinsfile"], &[], &[]));
        ft.associations.insert("rust".into(), assoc(&[], &["*.rs"], &[]));
        assert!(reg.set_file_types(ft.clone()));
        assert!(!reg.set_file_types(ft), "unchanged file types report no change");
        assert_eq!(detect(&reg, "a/x.foo"), "python");
        assert_eq!(detect(&reg, "x.FOO"), "python");
        assert_eq!(detect(&reg, "Pipfile.lock"), "python");
        assert_eq!(detect(&reg, "build_dev.cfg"), "python");
        assert_eq!(detect(&reg, "setup.cfg"), "ini");
        assert_eq!(detect(&reg, "server.log"), "python", "a user extension overrides a built-in one");
        assert_eq!(detect(&reg, "Jenkinsfile"), "shellscript");
        assert_eq!(detect(&reg, "main.rs"), "plaintext");
        assert_eq!(reg.detect(Path::new("tool"), Some("#!/usr/bin/env mypy --strict")).as_str(), "python");
        assert_eq!(reg.detect(Path::new("tool"), Some("#!/usr/bin/env mypyc")).as_str(), "plaintext");
        reg.set_file_types(FileTypes::default());
        assert_eq!(detect(&reg, "main.rs"), "rust");
        assert_eq!(detect(&reg, "x.foo"), "plaintext");
    }

    #[test]
    fn override_file_type_per_file() {
        let reg = reg().fork();
        let files = FileSettings {
            file_type_overrides: [
                ("notes.txt".to_owned(), "markdown".to_owned()),
                ("/abs/run".to_owned(), "python".to_owned()),
                ("bad.txt".to_owned(), "no-such-language".to_owned()),
            ]
            .into(),
            ..Default::default()
        };
        reg.set_file_types(FileTypes::from_settings(&files, Some(Path::new("/proj"))));
        assert_eq!(detect(&reg, "/proj/notes.txt"), "markdown");
        assert_eq!(detect(&reg, "/other/notes.txt"), "plaintext");
        assert_eq!(detect(&reg, "/abs/run"), "python");
        assert_eq!(detect(&reg, "/proj/bad.txt"), "plaintext");
    }

    #[test]
    fn user_overrides_replace_builtins() {
        let dir = std::env::temp_dir().join(format!("openidea-lang-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("rust.toml"), "id = \"rust\"\nname = \"My Rust\"\nextensions = [\"rs\", \"rsx\"]\n")
            .unwrap();
        std::fs::write(dir.join("broken.toml"), "id = ").unwrap();
        let reg = LanguageRegistry::load(Some(&dir)).unwrap();
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(reg.get(&LanguageId::new("rust")).unwrap().name, "My Rust");
        assert_eq!(detect(&reg, "x.rsx"), "rust");
        assert_eq!(reg.all().iter().filter(|l| l.id.as_str() == "rust").count(), 1);
    }
}
