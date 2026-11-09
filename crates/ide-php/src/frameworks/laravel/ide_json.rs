//! `ide.json` files ([`IdeJson`]): settings a project or a package ships for
//! Laravel tooling, in the open format whose public description (the JSON
//! Schema `laravel-ide-v2.json` and its documentation) is the only design
//! input.
//!
//! The project's own `ide.json` is read first, then the ones of the
//! installed packages (`vendor/*/*/ide.json`), so the project's rules win.
//! Paths in a file are relative to the folder holding it.
//!
//! - **`completions`:** rules saying which strings complete what. Each rule
//!   names a `complete` type, mapped onto a reference kind of [`super::refs`]
//!   ([`completion_kind`]), and `condition`s (any of them) saying where the
//!   string sits, matched against the same string sites as the built-in
//!   place patterns ([`Condition::matches`]). `options.prefix` is put before
//!   the string; `staticStrings` and `directoryFiles` are kinds of their own
//!   ([`super::refs::rules`]).
//! - **`view.paths`:** more view folders, with an optional namespace.
//! - **`blade`:** component folders (`components.viewPaths`) and components
//!   (`components.list`), directives (`directives`, `ifDirectives`).
//! - **`codeGenerations`:** kept as written for the generators.
//! - **`packages`:** package settings (enabled and disabled packages,
//!   Livewire namespaces, Inertia page folders, Passport scopes).
//!
//! Keys the engine doesn't use are ignored with a log line (and listed in
//! [`IdeJson::ignored`]).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::project::normalize;

#[cfg(test)]
#[path = "ide_json_unit_tests.rs"]
mod tests;

/// The JSON Schema of `ide.json` files this engine reads, written from the
/// public description of the format (the keys it uses).
pub const IDE_JSON_SCHEMA: &str = include_str!("ide-json.schema.json");

/// The file name.
pub const FILE_NAME: &str = "ide.json";

/// What the `ide.json` files of a project say; see the module documentation.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct IdeJson {
    /// The files read, the project's first.
    pub files: Vec<PathBuf>,
    pub completions: Vec<CompletionRule>,
    pub view_paths: Vec<ViewPath>,
    pub component_paths: Vec<ComponentPath>,
    pub components: Vec<ComponentDecl>,
    pub directives: Vec<DirectiveDecl>,
    /// The `codeGenerations` entries as written, with their file.
    pub code_generations: Vec<(PathBuf, Value)>,
    pub packages: PackageSettings,
    /// What was ignored, one line each (`ide.json: completions[0].transformers`).
    pub ignored: Vec<String>,
}

/// A completion rule.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompletionRule {
    /// The `complete` type as written (`routeName`).
    pub complete: String,
    /// The reference kind's id it maps onto ([`completion_kind`]).
    pub kind: String,
    /// Any of them.
    pub conditions: Vec<Condition>,
    pub options: RuleOptions,
    /// The `ide.json` declaring it.
    pub file: PathBuf,
}

/// The `options` of a rule the engine uses.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuleOptions {
    /// Put before the string (`configKey`: `options.prefix` `app.`).
    pub prefix: String,
    /// `staticStrings`: the strings, with the place each names (as written:
    /// a path relative to the `ide.json`, optionally `:line`).
    pub strings: Vec<(String, Option<String>)>,
    /// `directoryFiles`: the folders (absolute, normalized).
    pub directories: Vec<PathBuf>,
    pub recursive: bool,
    /// `directoryFiles`: cut from the end of a file's name (`.blade.php`).
    pub suffix_to_clear: String,
}

/// Where a rule's strings sit: every list given must hold.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Condition {
    pub place: Place,
    /// `keys`: the array keys of the `…WithKey` places.
    pub keys: Vec<String>,
    /// `functionNames` (any namespace) and `functionFqn` (without `\`).
    pub function_names: Vec<String>,
    pub function_fqns: Vec<String>,
    /// `methodNames`.
    pub method_names: Vec<String>,
    /// `classNames` (short), `classFqn` (that class), `classParentFqn` (it
    /// or a subclass): the receiver's class, or the class declaring a
    /// method whose return value is the place.
    pub class_names: Vec<String>,
    pub class_fqns: Vec<String>,
    pub class_parents: Vec<String>,
    /// The same for `new` (`newClassNames`, `newClassFqn`, `newClassParentFqn`).
    pub new_class_names: Vec<String>,
    pub new_class_fqns: Vec<String>,
    pub new_class_parents: Vec<String>,
    /// `parameters`, 0-based (the file's are 1-based).
    pub parameters: Vec<usize>,
    /// `parameterNames`.
    pub parameter_names: Vec<String>,
}

/// The `place` of a condition: the string is the argument itself or sits
/// in its array (or in the array a method returns).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum Place {
    #[default]
    Parameter,
    /// A key of the array (`['here' => …]`).
    ArrayKey,
    /// An item without a key, which stands for one (`only(['here'])`).
    ArrayOnlyKey,
    ArrayValue,
    /// The value under one of `keys`.
    ArrayValueWithKey,
    /// An item of the list under one of `keys` (`['k' => ['here']]`).
    ArrayValueWithKeyArray,
    /// The same one array down (`[['here' => …]]`).
    ArrayInArrayKey,
    ArrayInArrayOnlyKey,
    ArrayInArrayValue,
    /// What a method returns (`return 'here';`), or its array's.
    ReturnString,
    ReturnArrayValue,
    ReturnArrayKey,
    ReturnArrayOnlyKey,
    ReturnArrayValueWithKey,
    /// A value under one of `keys` in an array of the returned array.
    ReturnInArrayValueWithKey,
}

impl Place {
    fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "parameter" => Self::Parameter,
            "arrayKey" => Self::ArrayKey,
            "arrayOnlyKey" => Self::ArrayOnlyKey,
            "arrayValue" => Self::ArrayValue,
            "arrayValueWithKey" => Self::ArrayValueWithKey,
            "arrayValueWithKeyArray" => Self::ArrayValueWithKeyArray,
            "arrayInArrayKey" => Self::ArrayInArrayKey,
            "arrayInArrayOnlyKey" => Self::ArrayInArrayOnlyKey,
            "arrayInArrayValue" => Self::ArrayInArrayValue,
            "returnString" => Self::ReturnString,
            "returnArrayValue" => Self::ReturnArrayValue,
            "returnArrayKey" => Self::ReturnArrayKey,
            "returnArrayOnlyKey" => Self::ReturnArrayOnlyKey,
            "returnArrayValueWithKey" => Self::ReturnArrayValueWithKey,
            "returnInArrayValueWithKey" => Self::ReturnInArrayValueWithKey,
            _ => return None,
        })
    }

    /// The value a method returns, not an argument.
    pub fn is_return(self) -> bool {
        matches!(
            self,
            Self::ReturnString
                | Self::ReturnArrayValue
                | Self::ReturnArrayKey
                | Self::ReturnArrayOnlyKey
                | Self::ReturnArrayValueWithKey
                | Self::ReturnInArrayValueWithKey
        )
    }
}

/// A step from the argument (or the returned value) down to the string:
/// a key, or a value with its string key when it has one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step<'a> {
    Key,
    Value(Option<&'a str>),
}

impl Condition {
    /// Whether the steps from the argument to a string fit the place.
    pub fn place_matches(&self, steps: &[Step<'_>]) -> bool {
        let keyed =
            |key: Option<&str>| key.is_some_and(|key| self.keys.is_empty() || self.keys.iter().any(|k| k == key));
        match (self.place, steps) {
            (Place::Parameter | Place::ReturnString, []) => true,
            (Place::ArrayKey | Place::ReturnArrayKey, [Step::Key]) => true,
            (Place::ArrayOnlyKey | Place::ReturnArrayOnlyKey, [Step::Value(None)]) => true,
            (Place::ArrayValue | Place::ReturnArrayValue, [Step::Value(_)]) => true,
            (Place::ArrayValueWithKey | Place::ReturnArrayValueWithKey, [Step::Value(key)]) => keyed(*key),
            (Place::ArrayValueWithKeyArray, [Step::Value(key), Step::Value(None)]) => keyed(*key),
            (Place::ArrayInArrayKey, [Step::Value(_), Step::Key]) => true,
            (Place::ArrayInArrayOnlyKey, [Step::Value(_), Step::Value(None)]) => true,
            (Place::ArrayInArrayValue, [Step::Value(_), Step::Value(_)]) => true,
            (Place::ReturnInArrayValueWithKey, [Step::Value(_), Step::Value(key)]) => keyed(*key),
            _ => false,
        }
    }

    /// Whether the argument (its position, or its name when named) fits.
    /// Without `parameters` or `parameterNames` it is the first one.
    pub fn argument_matches(&self, index: Option<usize>, name: Option<&str>) -> bool {
        if self.place.is_return() {
            return true;
        }
        match name {
            Some(name) => self.parameter_names.iter().any(|wanted| wanted == name),
            None if self.parameters.is_empty() && self.parameter_names.is_empty() => index == Some(0),
            None => index.is_some_and(|index| self.parameters.contains(&index)),
        }
    }

    /// The function and method names a string site's call must have (lower
    /// case), for a quick look at calls before their types are worked out.
    pub fn call_names(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        out.extend(self.function_names.iter().map(|name| short(name).to_ascii_lowercase()));
        out.extend(self.function_fqns.iter().map(|name| short(name).to_ascii_lowercase()));
        out.extend(self.method_names.iter().map(|name| name.to_ascii_lowercase()));
        if self.is_new() {
            out.push("__construct".to_owned());
        }
        out
    }

    /// About `new` calls.
    pub fn is_new(&self) -> bool {
        !(self.new_class_names.is_empty() && self.new_class_fqns.is_empty() && self.new_class_parents.is_empty())
    }

    /// Whether the condition can match anything: it names a function, a
    /// method or a `new` class.
    fn usable(&self) -> bool {
        !self.call_names().is_empty()
    }
}

/// The last segment of a name (`\App\helper` → `helper`).
fn short(name: &str) -> &str {
    name.rsplit('\\').next().unwrap_or(name)
}

/// A view folder of `view.paths`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ViewPath {
    pub path: PathBuf,
    pub namespace: Option<String>,
}

/// A folder of anonymous components (`blade.components.viewPaths`): the
/// views below it are components, named with `prefix::` (`<x-prefix::name>`)
/// when it has a prefix.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ComponentPath {
    pub path: PathBuf,
    pub prefix: Option<String>,
    pub namespace: Option<String>,
}

/// A component of `blade.components.list`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ComponentDecl {
    /// The tag after `x-` (`namespace::name` with a namespace).
    pub tag: String,
    /// Its class (FQN without `\`).
    pub class: Option<String>,
    pub file: PathBuf,
}

/// A directive of `blade.directives` or `blade.ifDirectives`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DirectiveDecl {
    pub name: String,
    pub prefix: String,
    pub suffix: String,
    /// From `ifDirectives` (adds `@else…`, `@end…`, `@unless…`).
    pub condition: bool,
    pub file: PathBuf,
}

/// The `packages` section.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackageSettings {
    /// The keys of `enabledPackages`.
    pub enabled: Vec<String>,
    pub disabled: Vec<String>,
    /// `livewire.namespaces`: `(tag prefix, class namespace, view folder)`.
    pub livewire: Vec<(String, Option<String>, Option<PathBuf>)>,
    /// `inertia.pagePaths`: `(folder, prefix, suffix)`.
    pub inertia_pages: Vec<(PathBuf, String, String)>,
    /// `passport.scopes`: `(scope, description)`.
    pub passport_scopes: Vec<(String, String)>,
}

/// The reference kind a `complete` type maps onto; `None` for the types
/// the engine doesn't complete (yet).
pub fn completion_kind(complete: &str) -> Option<&'static str> {
    Some(match complete {
        "routeName" => "routeName",
        "routeAction" => "controllerAction",
        "routeMiddleware" => "middleware",
        "configKey" => "configKey",
        "viewName" => "viewName",
        "translationKey" => "translationKey",
        "validationRule" | "validationRules" => "validationRule",
        "staticStrings" => "staticStrings",
        "directoryFiles" => "directoryFiles",
        "gate" => "gate",
        "artisanCommandName" => "artisanCommand",
        "environmentVariable" => "envKey",
        "eloquentFields" => "eloquentField",
        "viteAsset" => "viteAsset",
        _ => return None,
    })
}

impl IdeJson {
    /// The `ide.json` of the project at `root` and of its packages in
    /// `vendor` (sorted by package).
    pub fn load(root: &Path, vendor: &Path) -> Self {
        let mut files = Vec::new();
        let own = root.join(FILE_NAME);
        if own.is_file() {
            files.push(normalize(&own));
        }
        let mut packages: Vec<PathBuf> = Vec::new();
        for vendor_dir in sorted_dirs(vendor) {
            for package in sorted_dirs(&vendor_dir) {
                let file = package.join(FILE_NAME);
                if file.is_file() {
                    packages.push(normalize(&file));
                }
            }
        }
        files.extend(packages);
        let mut out = Self::default();
        for file in files {
            match std::fs::read_to_string(&file)
                .map_err(|e| e.to_string())
                .and_then(|text| serde_json::from_str::<Value>(&text).map_err(|e| e.to_string()))
            {
                Ok(json) => out.add(&file, &json),
                Err(error) => {
                    tracing::info!("{}: not read: {error}", file.display());
                    out.ignored.push(format!("{}: {error}", file.display()));
                }
            }
        }
        out
    }

    /// Adds what the file `file` (parsed: `json`) says.
    pub fn add(&mut self, file: &Path, json: &Value) {
        self.files.push(file.to_path_buf());
        let dir = file.parent().unwrap_or(Path::new("")).to_path_buf();
        let mut cx = Reader { file: file.to_path_buf(), dir, ignored: Vec::new() };
        let Some(object) = json.as_object() else {
            cx.ignore("", "not an object");
            self.ignored.extend(cx.ignored);
            return;
        };
        for (key, value) in object {
            match key.as_str() {
                "$schema" => {}
                "completions" => {
                    for (i, rule) in array(value).iter().enumerate() {
                        if let Some(rule) = cx.completion(&format!("completions[{i}]"), rule) {
                            self.completions.push(rule);
                        }
                    }
                }
                "view" => cx.view(value, &mut self.view_paths),
                "blade" => cx.blade(value, self),
                "codeGenerations" => {
                    for generation in array(value) {
                        self.code_generations.push((file.to_path_buf(), generation.clone()));
                    }
                }
                "packages" => cx.packages(value, &mut self.packages),
                other => cx.ignore(other, "not supported"),
            }
        }
        self.ignored.extend(cx.ignored);
    }
}

fn sorted_dirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.path())
        .collect();
    out.sort();
    out
}

fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or_default()
}

fn string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_owned)
}

/// A list of strings, or one string.
fn strings(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::String(one)) => vec![one.clone()],
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).map(str::to_owned).collect(),
        _ => Vec::new(),
    }
}

/// A class or function name without its leading `\`.
fn names(value: Option<&Value>) -> Vec<String> {
    strings(value).into_iter().map(|name| name.trim_start_matches('\\').to_owned()).collect()
}

/// Reads one file, collecting what it ignores.
struct Reader {
    file: PathBuf,
    dir: PathBuf,
    ignored: Vec<String>,
}

impl Reader {
    fn ignore(&mut self, at: &str, why: &str) {
        let line = format!("{}: {at}: {why}", self.file.display());
        tracing::info!("ide.json ignored: {line}");
        self.ignored.push(line);
    }

    /// The keys of `object` not in `known`, ignored.
    fn ignore_unknown(&mut self, at: &str, object: &Map<String, Value>, known: &[&str]) {
        for key in object.keys().filter(|key| !known.contains(&key.as_str())) {
            self.ignore(&format!("{at}.{key}"), "unknown key");
        }
    }

    fn path(&self, rel: &str) -> PathBuf {
        normalize(&self.dir.join(rel.trim_start_matches(['/', '\\'])))
    }

    fn completion(&mut self, at: &str, rule: &Value) -> Option<CompletionRule> {
        let Some(object) = rule.as_object() else {
            self.ignore(at, "not an object");
            return None;
        };
        self.ignore_unknown(at, object, &["complete", "condition", "options", "transformers"]);
        let complete = string(object.get("complete")).unwrap_or_default();
        let Some(kind) = completion_kind(&complete) else {
            self.ignore(&format!("{at}.complete"), &format!("'{complete}' is not supported"));
            return None;
        };
        if object.get("transformers").is_some_and(|value| !array(value).is_empty()) {
            self.ignore(&format!("{at}.transformers"), "not supported");
        }
        let mut conditions = Vec::new();
        let list = match object.get("condition") {
            Some(Value::Object(_)) => std::slice::from_ref(object.get("condition").unwrap()),
            Some(value) => array(value),
            None => &[],
        };
        for (i, condition) in list.iter().enumerate() {
            if let Some(condition) = self.condition(&format!("{at}.condition[{i}]"), condition) {
                conditions.push(condition);
            }
        }
        if conditions.is_empty() {
            self.ignore(at, "no usable condition");
            return None;
        }
        let options = self.options(&format!("{at}.options"), kind, object.get("options"));
        Some(CompletionRule { complete, kind: kind.to_owned(), conditions, options, file: self.file.clone() })
    }

    fn condition(&mut self, at: &str, value: &Value) -> Option<Condition> {
        let Some(object) = value.as_object() else {
            self.ignore(at, "not an object");
            return None;
        };
        self.ignore_unknown(
            at,
            object,
            &[
                "place",
                "keys",
                "functionNames",
                "functionFqn",
                "methodNames",
                "classNames",
                "classFqn",
                "classParentFqn",
                "newClassNames",
                "newClassFqn",
                "newClassParentFqn",
                "parameters",
                "parameterNames",
            ],
        );
        let place = match string(object.get("place")) {
            None => Place::Parameter,
            Some(name) => match Place::parse(&name) {
                Some(place) => place,
                None => {
                    self.ignore(&format!("{at}.place"), &format!("'{name}' is not a place"));
                    return None;
                }
            },
        };
        let parameters = match object.get("parameters") {
            Some(Value::Array(items)) => items.iter().filter_map(Value::as_u64).collect(),
            Some(Value::Number(one)) => one.as_u64().into_iter().collect(),
            _ => Vec::new(),
        };
        let condition = Condition {
            place,
            keys: strings(object.get("keys")),
            function_names: names(object.get("functionNames")),
            function_fqns: names(object.get("functionFqn")),
            method_names: strings(object.get("methodNames")),
            class_names: names(object.get("classNames")),
            class_fqns: names(object.get("classFqn")),
            class_parents: names(object.get("classParentFqn")),
            new_class_names: names(object.get("newClassNames")),
            new_class_fqns: names(object.get("newClassFqn")),
            new_class_parents: names(object.get("newClassParentFqn")),
            // 1-based in the file.
            parameters: parameters.into_iter().filter(|n| *n >= 1).map(|n| n as usize - 1).collect(),
            parameter_names: strings(object.get("parameterNames")),
        };
        if !condition.usable() {
            self.ignore(at, "names no function, method or class to create");
            return None;
        }
        Some(condition)
    }

    fn options(&mut self, at: &str, kind: &str, value: Option<&Value>) -> RuleOptions {
        let mut options = RuleOptions::default();
        let Some(object) = value.and_then(Value::as_object) else { return options };
        for (key, value) in object {
            match key.as_str() {
                "prefix" => options.prefix = value.as_str().unwrap_or_default().to_owned(),
                "strings" if kind == "staticStrings" => {
                    options.strings.extend(strings(Some(value)).into_iter().map(|s| (s, None)));
                }
                "stringsWithLocation" if kind == "staticStrings" => {
                    if let Some(map) = value.as_object() {
                        for (string, location) in map {
                            options.strings.push((string.clone(), location.as_str().map(str::to_owned)));
                        }
                    }
                }
                "directory" | "directories" if kind == "directoryFiles" => {
                    options.directories.extend(strings(Some(value)).iter().map(|dir| self.path(dir)));
                }
                "recursive" if kind == "directoryFiles" => options.recursive = value.as_bool().unwrap_or(false),
                "suffixToClear" if kind == "directoryFiles" => {
                    options.suffix_to_clear = value.as_str().unwrap_or_default().to_owned();
                }
                other => self.ignore(&format!("{at}.{other}"), "not supported"),
            }
        }
        options
    }

    fn view(&mut self, value: &Value, out: &mut Vec<ViewPath>) {
        let Some(object) = value.as_object() else { return self.ignore("view", "not an object") };
        self.ignore_unknown("view", object, &["paths"]);
        for (i, item) in object.get("paths").map(array).unwrap_or_default().iter().enumerate() {
            match string(item.get("path")) {
                Some(path) => out.push(ViewPath {
                    path: self.path(&path),
                    namespace: string(item.get("namespace")).filter(|n| !n.is_empty()),
                }),
                None => self.ignore(&format!("view.paths[{i}]"), "no path"),
            }
        }
    }

    fn blade(&mut self, value: &Value, out: &mut IdeJson) {
        let Some(object) = value.as_object() else { return self.ignore("blade", "not an object") };
        self.ignore_unknown("blade", object, &["components", "directives", "ifDirectives"]);
        if let Some(components) = object.get("components").and_then(Value::as_object) {
            self.ignore_unknown("blade.components", components, &["viewPaths", "list"]);
            for item in components.get("viewPaths").map(array).unwrap_or_default() {
                let Some(path) = string(item.get("path")) else { continue };
                out.component_paths.push(ComponentPath {
                    path: self.path(&path),
                    prefix: string(item.get("prefix")).filter(|p| !p.is_empty()),
                    namespace: string(item.get("namespace")).filter(|n| !n.is_empty()),
                });
            }
            for item in components.get("list").map(array).unwrap_or_default() {
                let Some(name) = string(item.get("name")) else { continue };
                let tag = match string(item.get("namespace")).filter(|n| !n.is_empty()) {
                    Some(namespace) => format!("{namespace}::{name}"),
                    None => name,
                };
                let class = string(item.get("className")).map(|class| class.trim_start_matches('\\').to_owned());
                out.components.push(ComponentDecl { tag, class, file: self.file.clone() });
            }
        }
        for (key, condition) in [("directives", false), ("ifDirectives", true)] {
            for item in object.get(key).map(array).unwrap_or_default() {
                let Some(name) = string(item.get("name")) else { continue };
                let name = name.trim_start_matches('@').to_owned();
                if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
                    self.ignore(&format!("blade.{key}"), &format!("'{name}' is not a directive name"));
                    continue;
                }
                out.directives.push(DirectiveDecl {
                    name,
                    prefix: string(item.get("prefix")).unwrap_or_default(),
                    suffix: string(item.get("suffix")).unwrap_or_default(),
                    condition,
                    file: self.file.clone(),
                });
            }
        }
    }

    fn packages(&mut self, value: &Value, out: &mut PackageSettings) {
        let Some(object) = value.as_object() else { return self.ignore("packages", "not an object") };
        self.ignore_unknown(
            "packages",
            object,
            &["enabledPackages", "disabledPackages", "livewire", "inertia", "passport"],
        );
        if let Some(enabled) = object.get("enabledPackages").and_then(Value::as_object) {
            out.enabled.extend(enabled.keys().cloned());
        }
        out.disabled.extend(strings(object.get("disabledPackages")));
        for item in object.get("livewire").and_then(|l| l.get("namespaces")).map(array).unwrap_or_default() {
            let class = string(item.get("classNamespace")).map(|ns| ns.trim_matches('\\').to_owned());
            let view = string(item.get("viewPath")).map(|path| self.path(&path));
            if class.is_some() || view.is_some() {
                out.livewire.push((string(item.get("tagPrefix")).unwrap_or_default(), class, view));
            }
        }
        for item in object.get("inertia").and_then(|i| i.get("pagePaths")).map(array).unwrap_or_default() {
            let Some(path) = string(item.get("path")) else { continue };
            out.inertia_pages.push((
                self.path(&path),
                string(item.get("prefix")).unwrap_or_default(),
                string(item.get("suffix")).unwrap_or_default(),
            ));
        }
        if let Some(scopes) = object.get("passport").and_then(|p| p.get("scopes")).and_then(Value::as_object) {
            for (scope, description) in scopes {
                out.passport_scopes.push((scope.clone(), description.as_str().unwrap_or_default().to_owned()));
            }
        }
    }
}
