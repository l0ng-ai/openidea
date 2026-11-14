//! Authorization facts of a Laravel project (`AuthFacts`): the gates the
//! service providers define (`Gate::define('edit-post', …)`, and the
//! abilities of `Gate::resource('posts', PostPolicy::class)`), the policies
//! they register (`Gate::policy(Post::class, PostPolicy::class)` and the
//! `$policies` property of an `AuthServiceProvider`), and the policy classes
//! of the app's and the modules' `Policies` folders. Guards and password
//! brokers come from `config/auth.php` ([`guards`], [`brokers`]).
//!
//! Policy discovery follows Laravel's documentation on authorization and
//! `Illuminate\Auth\Access\Gate::guessPolicyName` (MIT): a model
//! `App\Models\Post` is looked up as `App\Models\Policies\PostPolicy`, then
//! `App\Policies\PostPolicy` ([`guessed_policies`]).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use ide_core::Range;

use super::config::ConfigKeys;
use super::parts::{PartReader, TextParts};
use super::project::LaravelProject;
use super::views::{call_arguments, php_files, provider_files, string_literal};
use crate::names::{FileNames, NameKind, Resolution};
use crate::syntax::{LineIndex, ParsedFile};

/// The abilities `Gate::resource` defines, as Laravel's `Gate::resource`
/// names them (`posts.view` → `PostPolicy::view`).
pub const RESOURCE_ABILITIES: &[&str] = &["viewAny", "view", "create", "update", "delete"];

/// A gate a service provider defines.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GateDef {
    pub name: String,
    /// The provider, and the range of the name's string in it.
    pub path: PathBuf,
    pub range: Range,
    /// The policy class and method of the ability: a `Gate::resource`
    /// ability's, or the callback of `Gate::define('x', [Policy::class,
    /// 'method'])` (or `'Policy@method'`).
    pub policy: Option<(String, String)>,
    /// One of the abilities of `Gate::resource` (not renamed as a gate).
    pub resource: bool,
}

/// A policy registered for a model.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PolicyDef {
    /// FQNs without the leading `\`.
    pub model: String,
    pub policy: String,
    /// Where it is registered.
    pub path: PathBuf,
    pub range: Range,
}

/// See the module documentation.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthFacts {
    pub gates: Vec<GateDef>,
    pub policies: Vec<PolicyDef>,
    /// The classes of the `Policies` folders (FQNs), sorted.
    pub policy_classes: Vec<String>,
    /// How `Gate::guessPolicyNamesUsing(…)` names a model's policy, when
    /// its callback is one of the simple forms ([`PolicyGuess`]).
    pub policy_guess: Option<PolicyGuess>,
}

/// A `Gate::guessPolicyNamesUsing` callback the engine follows:
///
/// - `'App\\Policies\\'.class_basename($model).'Policy'` (`prefix`, the
///   model's base name, `suffix`);
/// - `str_replace('Models', 'Policies', $model).'Policy'` (and
///   `Str::replace`): the model's name with `from` replaced by `to`, then
///   `suffix`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum PolicyGuess {
    Basename { prefix: String, suffix: String },
    Replace { from: String, to: String, suffix: String },
}

impl PolicyGuess {
    /// The policy class this guess gives `model` (FQN without the leading
    /// `\`).
    pub fn policy_of(&self, model: &str) -> String {
        let model = model.trim_start_matches('\\');
        let found = match self {
            PolicyGuess::Basename { prefix, suffix } => {
                let base = model.rsplit('\\').next().unwrap_or(model);
                format!("{prefix}{base}{suffix}")
            }
            PolicyGuess::Replace { from, to, suffix } => format!("{}{suffix}", model.replace(from.as_str(), to)),
        };
        found.trim_start_matches('\\').to_owned()
    }

    /// The guess of the callback whose text (the call's arguments) is
    /// `callback`.
    fn read(callback: &str) -> Option<Self> {
        // The value the callback returns: after `=>` or `return`.
        let body = match callback.find("=>") {
            Some(at) => &callback[at + 2..],
            None => &callback[callback.find("return")? + "return".len()..],
        };
        let body = body.split(';').next()?.trim();
        // The arrow function's closing `)` of the call.
        let body = if callback.contains("=>") { body.strip_suffix(')').unwrap_or(body).trim() } else { body };
        let parts: Vec<&str> = split_concat(body);
        let literal = |part: &str| string_literal(part.trim()).map(|value| value.replace("\\\\", "\\"));
        let basename = |part: &str| part.trim_start().starts_with("class_basename(");
        match parts.as_slice() {
            [prefix, base, suffix] if basename(base) => {
                Some(PolicyGuess::Basename { prefix: literal(prefix)?, suffix: literal(suffix)? })
            }
            [base, suffix] if basename(base) => {
                Some(PolicyGuess::Basename { prefix: String::new(), suffix: literal(suffix)? })
            }
            [replace, suffix] => {
                let replace = replace.trim();
                let open = replace.find('(')?;
                let name = replace[..open].trim().trim_start_matches('\\');
                if !["str_replace", "Str::replace", "Illuminate\\Support\\Str::replace"].contains(&name) {
                    return None;
                }
                let args = call_arguments(replace, open)?;
                Some(PolicyGuess::Replace {
                    from: literal(args.first()?)?,
                    to: literal(args.get(1)?)?,
                    suffix: literal(suffix)?,
                })
            }
            _ => None,
        }
    }
}

/// The operands of a `.` concatenation, outside strings and brackets.
fn split_concat(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut quote: Option<char> = None;
    let mut escaped = false;
    let mut start = 0;
    for (i, c) in text.char_indices() {
        if let Some(open) = quote {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == open {
                quote = None;
            }
            continue;
        }
        match c {
            '\'' | '"' => quote = Some(c),
            '(' | '[' => depth += 1,
            ')' | ']' => depth -= 1,
            '.' if depth == 0 => {
                out.push(&text[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    out.push(&text[start..]);
    out
}

impl AuthFacts {
    /// The facts of `project`; `text_of` reads a provider (an open buffer
    /// first).
    pub fn read(project: &LaravelProject, text_of: impl Fn(&Path) -> Option<String>) -> Self {
        Self::read_parts(project, &TextParts(text_of))
    }

    /// [`read`](Self::read), each provider's gates and policies from
    /// `parts`: only the providers that changed are read again.
    pub fn read_parts(project: &LaravelProject, parts: &impl PartReader) -> Self {
        let mut facts = Self::default();
        let jobs: Vec<(PathBuf, String)> =
            provider_files(project).into_iter().map(|path| (path, String::new())).collect();
        let found = parts.parts_of("auth", &jobs, &|at, text| {
            let mut found = Self::default();
            found.read_provider(&jobs[at].0, text);
            found
        });
        for part in found.into_iter().flatten() {
            facts.gates.extend(part.gates.iter().cloned());
            facts.policies.extend(part.policies.iter().cloned());
            if part.policy_guess.is_some() {
                facts.policy_guess.clone_from(&part.policy_guess);
            }
        }
        let mut dirs = vec![
            (project.paths.app.join("Policies"), format!("{}Policies\\", project.app_namespace)),
            (project.paths.app.join("Models").join("Policies"), format!("{}Models\\Policies\\", project.app_namespace)),
        ];
        for module in project.modules.iter().filter(|module| module.enabled) {
            let Some(namespace) = &module.namespace else { continue };
            for sub in ["Policies", "app/Policies", "src/Policies"] {
                dirs.push((module.path.join(sub), format!("{namespace}Policies\\")));
            }
        }
        for (dir, namespace) in dirs {
            for path in php_files(&dir) {
                let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else { continue };
                facts.policy_classes.push(format!("{namespace}{stem}"));
            }
        }
        facts.policy_classes.sort();
        facts.policy_classes.dedup();
        facts
    }

    /// Reads the gates and policies of the provider `path`.
    pub fn read_provider(&mut self, path: &Path, text: &str) {
        if !text.contains("Gate::") && !text.contains("$policies") {
            return;
        }
        let parsed = ParsedFile::parse("provider.php", text);
        let names = FileNames::resolve(&parsed);
        let lines = LineIndex::new(text);
        let class_at = |written: &str, offset: usize| class_name(&names, written, offset);
        for (open, args) in calls(text, "Gate::define(") {
            if let Some((name, range)) = first_string(text, open, &lines) {
                let policy = args.get(1).and_then(|callback| policy_method(&names, callback, open));
                self.gates.push(GateDef { name, path: path.to_path_buf(), range, policy, resource: false });
            }
        }
        for (open, _) in calls(text, "Gate::guessPolicyNamesUsing(") {
            let close = text[open..].find(';').map_or(text.len(), |at| open + at);
            if let Some(guess) = PolicyGuess::read(&text[open + 1..close]) {
                self.policy_guess = Some(guess);
            }
        }
        for (open, args) in calls(text, "Gate::resource(") {
            let Some((name, range)) = first_string(text, open, &lines) else { continue };
            let Some(policy) = args.get(1).and_then(|arg| class_at(arg, open)) else { continue };
            for ability in RESOURCE_ABILITIES {
                self.gates.push(GateDef {
                    name: format!("{name}.{ability}"),
                    path: path.to_path_buf(),
                    range,
                    policy: Some((policy.clone(), (*ability).to_owned())),
                    resource: true,
                });
            }
        }
        for (open, args) in calls(text, "Gate::policy(") {
            let [model, policy, ..] = args.as_slice() else { continue };
            let (Some(model), Some(policy)) = (class_at(model, open), class_at(policy, open)) else { continue };
            let range = lines.range(open as u32 + 1, open as u32 + 1);
            self.policies.push(PolicyDef { model, policy, path: path.to_path_buf(), range });
        }
        // `protected $policies = [Post::class => PostPolicy::class];`
        let mut from = 0;
        while let Some(at) = text[from..].find("$policies") {
            let at = from + at;
            from = at + 1;
            let rest = &text[at + "$policies".len()..];
            let trimmed = rest.trim_start();
            let Some(after_eq) = trimmed.strip_prefix('=') else { continue };
            let after_eq = after_eq.trim_start();
            if !after_eq.starts_with('[') {
                continue;
            }
            let open = text.len() - after_eq.len();
            for entry in call_arguments(text, open).unwrap_or_default() {
                let Some((model, policy)) = entry.split_once("=>") else { continue };
                let (Some(model), Some(policy)) = (class_at(model, open), class_at(policy, open)) else { continue };
                let offset = text[open..].find(entry.as_str()).map_or(open, |found| open + found) as u32;
                let range = lines.range(offset, offset + entry.len() as u32);
                self.policies.push(PolicyDef { model, policy, path: path.to_path_buf(), range });
            }
        }
    }

    /// The gates named `name`.
    pub fn gates_named<'s>(&'s self, name: &'s str) -> impl Iterator<Item = &'s GateDef> + 's {
        self.gates.iter().filter(move |gate| gate.name == name)
    }

    /// The policy registered for `model`.
    pub fn registered_policy(&self, model: &str) -> Option<&PolicyDef> {
        self.policies.iter().find(|policy| policy.model.eq_ignore_ascii_case(model.trim_start_matches('\\')))
    }
}

/// The policy method a `Gate::define` callback names: `[Policy::class,
/// 'method']` or `'Policy@method'`.
fn policy_method(names: &FileNames, callback: &str, offset: usize) -> Option<(String, String)> {
    let callback = callback.trim();
    if let Some(inner) = callback.strip_prefix('[').and_then(|rest| rest.strip_suffix(']')) {
        let items = call_arguments(&format!("({inner})"), 0)?;
        let [class, method] = items.as_slice() else { return None };
        return Some((class_name(names, class, offset)?, string_literal(method.trim())?));
    }
    let written = string_literal(callback)?;
    let (class, method) = written.split_once('@')?;
    Some((class.replace("\\\\", "\\").trim_start_matches('\\').to_owned(), method.to_owned()))
}

/// The `(` offsets and arguments of the calls starting with `call` (which
/// ends in `(`).
pub(super) fn calls(text: &str, call: &str) -> Vec<(usize, Vec<String>)> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(at) = text[from..].find(call) {
        let open = from + at + call.len() - 1;
        from = open + 1;
        if let Some(args) = call_arguments(text, open) {
            out.push((open, args));
        }
    }
    out
}

/// The first argument of the call whose `(` is at `open` when it is a plain
/// string: its content and range.
pub(super) fn first_string(text: &str, open: usize, lines: &LineIndex) -> Option<(String, Range)> {
    let start = open + 1 + (text[open + 1..].len() - text[open + 1..].trim_start().len());
    let quote = text[start..].chars().next().filter(|c| *c == '\'' || *c == '"')?;
    let len = text[start + 1..].find(quote)?;
    let name = &text[start + 1..start + 1 + len];
    if name.is_empty() || name.contains(['$', '\\']) {
        return None;
    }
    Some((name.to_owned(), lines.range((start + 1) as u32, (start + 1 + len) as u32)))
}

/// The class `written` names (`Post::class` or `'App\Models\Post'`), in the
/// scope at `offset`.
pub(super) fn class_name(names: &FileNames, written: &str, offset: usize) -> Option<String> {
    let written = written.trim();
    if let Some(name) = written.strip_suffix("::class") {
        let name = name.trim();
        if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'\\') {
            return None;
        }
        return match names.scope_at(offset as u32).resolve(NameKind::ClassLike, name).resolution {
            Resolution::Fqn(fqn) | Resolution::Fallback { namespaced: fqn, .. } => {
                Some(fqn.trim_start_matches('\\').to_owned())
            }
            Resolution::Relative(_) => None,
        };
    }
    string_literal(written).map(|name| name.replace("\\\\", "\\").trim_start_matches('\\').to_owned())
}

/// The attribute naming a model's policy (Laravel 12).
pub const USE_POLICY: &str = "Illuminate\\Database\\Eloquent\\Attributes\\UsePolicy";

/// The policy the `#[UsePolicy(PostPolicy::class)]` attribute in `text` (a
/// model's file) names.
pub fn use_policy(text: &str) -> Option<String> {
    let at = text.find("UsePolicy(")?;
    let open = at + "UsePolicy".len();
    let args = call_arguments(text, open)?;
    let parsed = ParsedFile::parse("model.php", text);
    let names = FileNames::resolve(&parsed);
    class_name(&names, args.first()?, open)
}

/// The policy class names Laravel tries for `model`, most specific first
/// (`App\Models\Policies\PostPolicy`, `App\Policies\PostPolicy`).
pub fn guessed_policies(model: &str) -> Vec<String> {
    let model = model.trim_start_matches('\\');
    let Some((dir, base)) = model.rsplit_once('\\') else { return vec![format!("Policies\\{model}Policy")] };
    let segments: Vec<&str> = dir.split('\\').collect();
    (1..=segments.len()).rev().map(|len| format!("{}\\Policies\\{base}Policy", segments[..len].join("\\"))).collect()
}

/// A guard or password broker of `config/auth.php`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthEntry {
    pub name: String,
    /// The driver (`session`) or provider (`users`).
    pub detail: Option<String>,
    /// Where `config/auth.php` declares it; `None` for Laravel's default.
    pub declared: Option<(PathBuf, Range)>,
}

/// The entries below `parent` (`auth.guards`) of the configuration, or
/// `default` when the project has no such array (Laravel's own
/// `config/auth.php` is used then).
fn auth_entries(config: &ConfigKeys, parent: &str, detail_key: &str, default: &str) -> Vec<AuthEntry> {
    if config.get(parent).is_none() {
        return vec![AuthEntry { name: default.to_owned(), detail: None, declared: None }];
    }
    config
        .children(Some(parent))
        .map(|entry| {
            let detail = config
                .get(&format!("{}.{detail_key}", entry.key))
                .and_then(|found| found.value.as_deref())
                .and_then(string_literal);
            AuthEntry { name: entry.segment().to_owned(), detail, declared: Some((entry.path.clone(), entry.range)) }
        })
        .collect()
}

/// The guards (`auth.guards.*`, with their drivers).
pub fn guards(config: &ConfigKeys) -> Vec<AuthEntry> {
    auth_entries(config, "auth.guards", "driver", "web")
}

/// The user model of each guard of `config/auth.php`, and the default
/// guard: what `Auth::user()`, `Auth::guard('admin')->user()` and
/// `$request->user()` return.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct UserModels {
    /// `auth.defaults.guard`.
    pub default_guard: Option<String>,
    /// `(guard, model)`: the `model` of the guard's provider, fully
    /// qualified.
    pub guards: Vec<(String, String)>,
}

impl UserModels {
    /// The model of guard `guard`, else of the default guard.
    pub fn model(&self, guard: Option<&str>) -> Option<&str> {
        let guard = guard.filter(|guard| !guard.is_empty()).or(self.default_guard.as_deref())?;
        self.guards.iter().find(|(name, _)| name == guard).map(|(_, model)| model.as_str())
    }
}

/// The user models of the guards (`auth.guards.*.provider`, then
/// `auth.providers.*.model`: `Foo::class` resolved with the imports of
/// `config/auth.php`, read with `text_of`, or a class-name string, or
/// either as the default of `env('AUTH_MODEL', …)`). Without
/// `config/auth.php`, Laravel's own: the `web` guard and `App\Models\User`.
pub fn user_models(config: &ConfigKeys, text_of: &dyn Fn(&Path) -> Option<String>) -> UserModels {
    if config.get("auth.guards").is_none() {
        return UserModels {
            default_guard: Some("web".to_owned()),
            guards: vec![("web".to_owned(), "App\\Models\\User".to_owned())],
        };
    }
    let default_guard = config.string_value("auth.defaults.guard").or_else(|| Some("web".to_owned()));
    let mut files: Vec<(PathBuf, Option<FileNames>, usize)> = Vec::new();
    let mut guards = Vec::new();
    for guard in config.children(Some("auth.guards")) {
        let Some(provider) = config.string_value(&format!("{}.provider", guard.key)) else { continue };
        let Some(entry) = config.get(&format!("auth.providers.{provider}.model")) else { continue };
        let Some(mut written) = entry.value.as_deref().map(|value| value.trim().to_owned()) else { continue };
        if let Some(call) = written.strip_prefix("env(").or_else(|| written.strip_prefix("\\env(")) {
            let open = written.len() - call.len() - 1;
            let Some(default) = call_arguments(&written, open).and_then(|args| args.get(1).cloned()) else { continue };
            written = default;
        }
        // The names of the file, resolved once; at its end every import
        // is in scope.
        if !files.iter().any(|(path, ..)| *path == entry.path) {
            let names = text_of(&entry.path).map(|text| {
                let parsed = ParsedFile::parse(&entry.path.to_string_lossy(), text.as_str());
                (FileNames::resolve(&parsed), text.len())
            });
            let (names, end) = names.map_or((None, 0), |(names, end)| (Some(names), end));
            files.push((entry.path.clone(), names, end));
        }
        let Some((_, Some(names), end)) = files.iter().find(|(path, ..)| *path == entry.path) else { continue };
        if let Some(model) = class_name(names, &written, *end) {
            guards.push((guard.segment().to_owned(), model));
        }
    }
    UserModels { default_guard, guards }
}

/// The password brokers (`auth.passwords.*`, with their providers).
pub fn brokers(config: &ConfigKeys) -> Vec<AuthEntry> {
    auth_entries(config, "auth.passwords", "provider", "users")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guesses_policies_like_laravel() {
        assert_eq!(
            guessed_policies("App\\Models\\Post"),
            ["App\\Models\\Policies\\PostPolicy", "App\\Policies\\PostPolicy"]
        );
        assert_eq!(guessed_policies("App\\Post"), ["App\\Policies\\PostPolicy"]);
        assert_eq!(guessed_policies("Post"), ["Policies\\PostPolicy"]);
    }

    #[test]
    fn reads_gates_and_policies_of_a_provider() {
        let text = r#"<?php
namespace App\Providers;

use App\Models\Post;
use App\Models\Comment;
use App\Policies\PostPolicy;
use Illuminate\Support\Facades\Gate;

class AuthServiceProvider
{
    protected $policies = [
        Comment::class => \App\Policies\CommentPolicy::class,
    ];

    public function boot(): void
    {
        Gate::define('edit-settings', fn ($user) => true);
        Gate::define("publish", [PostPolicy::class, 'publish']);
        Gate::define($dynamic, fn () => true);
        Gate::policy(Post::class, PostPolicy::class);
        Gate::resource('posts', PostPolicy::class);
    }
}
"#;
        let mut facts = AuthFacts::default();
        facts.read_provider(Path::new("p.php"), text);
        let gates: Vec<(&str, u32, Option<&str>)> = facts
            .gates
            .iter()
            .map(|gate| (gate.name.as_str(), gate.range.start.line, gate.policy.as_ref().map(|p| p.1.as_str())))
            .collect();
        assert_eq!(
            gates,
            [
                ("edit-settings", 16, None),
                // The policy method the callback names.
                ("publish", 17, Some("publish")),
                ("posts.viewAny", 20, Some("viewAny")),
                ("posts.view", 20, Some("view")),
                ("posts.create", 20, Some("create")),
                ("posts.update", 20, Some("update")),
                ("posts.delete", 20, Some("delete")),
            ]
        );
        assert_eq!(facts.gates[2].policy.as_ref().unwrap().0, "App\\Policies\\PostPolicy");
        let policies: Vec<(&str, &str, u32)> =
            facts.policies.iter().map(|p| (p.model.as_str(), p.policy.as_str(), p.range.start.line)).collect();
        assert_eq!(
            policies,
            [
                ("App\\Models\\Post", "App\\Policies\\PostPolicy", 19),
                ("App\\Models\\Comment", "App\\Policies\\CommentPolicy", 11),
            ]
        );
        assert_eq!(facts.registered_policy("\\App\\Models\\Post").unwrap().policy, "App\\Policies\\PostPolicy");
        assert!(facts.registered_policy("App\\Models\\Tag").is_none());
    }
}
