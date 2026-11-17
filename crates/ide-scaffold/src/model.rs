//! Generator definitions as written in `generators/<id>.toml`, and what the UI sees of them.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;

/// Field values by field id. Every value is a string: checkboxes are `"true"` / `"false"`,
/// dependency selections comma-separated ids.
pub type Values = BTreeMap<String, String>;

// ---- definitions (`generators/<id>.toml`) ----

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub(crate) struct Def {
    pub id: String,
    pub name: String,
    /// Section of the generator list, e.g. `Java` or `JavaScript`.
    pub group: String,
    /// Icon name of the UI icon registry.
    pub icon: String,
    #[serde(default)]
    pub order: i32,
    #[serde(default)]
    pub description: String,
    /// Offer "Create Git repository".
    #[serde(default = "yes")]
    pub git: bool,
    #[serde(default)]
    pub requires: Vec<RequireDef>,
    #[serde(default)]
    pub fields: Vec<FieldDef>,
    #[serde(default)]
    pub service: Option<ServiceDef>,
    /// Generation runs: the service's zip, `steps`, `files`, then `after`.
    #[serde(default)]
    pub files: Vec<FileDef>,
    /// Commands that create the project (an official CLI).
    #[serde(default)]
    pub steps: Vec<StepDef>,
    /// Commands run once the files are written (installing dependencies, a build wrapper).
    #[serde(default)]
    pub after: Vec<StepDef>,
    /// Written to the new project's `.openidea/settings.toml`; string values are
    /// templates and entries that render empty are left out.
    #[serde(default)]
    pub settings: Option<toml::Table>,
}

fn yes() -> bool {
    true
}

fn version_args() -> Vec<String> {
    vec!["--version".into()]
}

/// `field = "value"` or `field = ["a", "b"]`: holds when every listed field has
/// one of its values.
pub(crate) type When = BTreeMap<String, OneOrMany>;

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub(crate) enum OneOrMany {
    One(String),
    Many(Vec<String>),
}

impl OneOrMany {
    pub fn values(&self) -> Vec<String> {
        match self {
            Self::One(v) => vec![v.clone()],
            Self::Many(v) => v.clone(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub(crate) struct RequireDef {
    /// Program looked up on `PATH`; a template (`{{pm}}`).
    pub program: String,
    /// Lowest version `<program> <version-args>` must report.
    #[serde(default)]
    pub min: Option<String>,
    #[serde(default = "version_args")]
    pub version_args: Vec<String>,
    /// How to install it.
    #[serde(default)]
    pub hint: String,
    #[serde(default)]
    pub when: When,
}

// No `deny_unknown_fields`: serde does not support it with `flatten`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) struct FieldDef {
    pub id: String,
    pub label: String,
    #[serde(flatten)]
    pub kind: FieldKindDef,
    /// A template over the fields before it (`{{group}}.{{artifact|ident}}`).
    #[serde(default)]
    pub default: String,
    #[serde(default)]
    pub visible: When,
    #[serde(default)]
    pub hint: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub(crate) enum FieldKindDef {
    Text {
        #[serde(default)]
        pattern: Option<String>,
        #[serde(default)]
        placeholder: String,
    },
    Choice {
        options: Vec<OptionDef>,
        #[serde(default)]
        segmented: bool,
    },
    Checkbox,
    /// An installed SDK of this `ide-sdk` kind (`jdk`); the value is its home.
    Sdk {
        sdk: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub(crate) enum OptionDef {
    Value(String),
    Labeled { value: String, label: String },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub(crate) struct ServiceDef {
    pub provider: Provider,
}

/// A project generation service: its form options come from its metadata and the
/// project from a zip it builds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Provider {
    /// start.spring.io and compatible servers (the `server` field).
    SpringInitializr,
    /// code.quarkus.io.
    Quarkus,
    /// launch.micronaut.io.
    Micronaut,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub(crate) struct FileDef {
    /// Relative to the project; a template.
    pub path: String,
    pub content: String,
    #[serde(default)]
    pub when: When,
    #[serde(default)]
    pub executable: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub(crate) struct StepDef {
    /// Shown while the step runs.
    pub label: String,
    /// The executable (a template), or omitted with `package`.
    #[serde(default)]
    pub program: String,
    /// A package-runner package (`create-vite@latest`), run through the package
    /// manager chosen in the `pm` field: `npx --yes`, `pnpm dlx` or `bunx`.
    #[serde(default)]
    pub package: Option<String>,
    /// Templates; an argument that renders empty is left out.
    #[serde(default)]
    pub args: Vec<ArgDef>,
    #[serde(default)]
    pub cwd: Cwd,
    /// With `cwd = "parent"`: the folder the tool creates (a template), when it is not
    /// named after the project (`dart create` wants a package name). It is renamed.
    #[serde(default)]
    pub creates: Option<String>,
    #[serde(default)]
    pub when: When,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Skipped with a note when the program is not installed.
    #[serde(default)]
    pub optional: bool,
}

/// `"--flag"`, or arguments passed only when `when` holds and the `if-set` field is not
/// empty: `{ if-set = "python", args = ["--python", "{{python}}"] }`.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub(crate) enum ArgDef {
    Plain(String),
    When {
        #[serde(default)]
        when: When,
        #[serde(default, rename = "if-set")]
        if_set: Option<String>,
        args: Vec<String>,
    },
}

impl ArgDef {
    /// The argument templates that apply for `values`.
    pub fn applied(&self, values: &Values) -> Vec<&str> {
        match self {
            Self::Plain(a) => vec![a.as_str()],
            Self::When { when, if_set, args } => {
                let set = if_set.as_ref().is_none_or(|f| values.get(f).is_some_and(|v| !v.trim().is_empty()));
                if set && crate::template::matches(when, values) {
                    args.iter().map(String::as_str).collect()
                } else {
                    Vec::new()
                }
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Cwd {
    /// The project directory (created first).
    #[default]
    Project,
    /// Its parent, for tools that create the project directory themselves (`{{name}}`).
    Parent,
}

// ---- IPC ----

/// One entry of File › New Project.
#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GeneratorInfo {
    pub id: String,
    pub name: String,
    pub group: String,
    pub icon: String,
    pub order: i32,
    pub description: String,
    /// Offer "Create Git repository".
    pub git: bool,
    pub fields: Vec<Field>,
    /// More fields come from `scaffold_options` (a project service's metadata).
    pub dynamic: bool,
}

#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Field {
    pub id: String,
    pub label: String,
    pub kind: FieldKind,
    /// A template over the fields before it: `{{id}}`, `{{id|filter}}` (filters:
    /// `path`, `ident`, `kebab`, `snake`, `pascal`, `lower`, `json`).
    pub default: String,
    /// Shown only while each listed field has one of its values.
    pub visible: BTreeMap<String, Vec<String>>,
    pub hint: String,
}

#[derive(Clone, Debug, Serialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum FieldKind {
    #[serde(rename_all = "camelCase")]
    Text {
        pattern: Option<String>,
        placeholder: String,
    },
    #[serde(rename_all = "camelCase")]
    Choice {
        options: Vec<ChoiceOption>,
        segmented: bool,
    },
    Checkbox,
    /// An installed SDK of this kind (`jdk`); the value is its home, empty = automatic.
    Sdk {
        sdk: String,
    },
    /// Several ids out of grouped items; the value is comma-separated.
    Dependencies {
        groups: Vec<DependencyGroup>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Type)]
pub struct ChoiceOption {
    pub value: String,
    pub label: String,
}

#[derive(Clone, Debug, Serialize, Type)]
pub struct DependencyGroup {
    pub name: String,
    pub items: Vec<Dependency>,
}

#[derive(Clone, Debug, Serialize, Type)]
pub struct Dependency {
    pub id: String,
    pub name: String,
    pub description: String,
}

/// A program a generator needs, and whether this machine has it.
#[derive(Clone, Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Requirement {
    pub program: String,
    pub min: Option<String>,
    /// The version found; `None` when the program is missing or reports none.
    pub found: Option<String>,
    pub satisfied: bool,
    pub hint: String,
}

#[derive(Clone, Debug, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateRequest {
    pub generator: String,
    /// The parent directory; the project is `<location>/<name>`.
    pub location: ide_core::IpcPath,
    pub name: String,
    pub git: bool,
    pub values: Values,
}

/// Progress of `scaffold_create`.
#[derive(Clone, Debug, Serialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ScaffoldEvent {
    /// A new step began.
    Step { text: String },
    /// A line of a tool's output.
    Line { text: String },
}
