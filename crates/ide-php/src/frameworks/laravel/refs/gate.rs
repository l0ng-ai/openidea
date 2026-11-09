//! The `gate`, `authGuard` and `passwordBroker` reference kinds.
//!
//! `gate`: an ability, as Laravel's documentation on authorization writes
//! them: `Gate::allows/denies/check/any/none/authorize/inspect/has`,
//! `$user->can/cannot/cant/canAny`, a controller's `$this->authorize(…)` /
//! `authorizeForUser(…)` (`AuthorizesRequests`), a route's `->can(…)`, and
//! Blade's `@can`, `@cannot`, `@canany` and their `@else…` forms. The
//! `can:` middleware (`can:update,post`) is answered by the `middleware`
//! kind with the helpers here. An ability is a gate the providers define
//! ([`AuthFacts`]) or a method of a policy: the policy of the model the
//! next argument names (`$post`, `Post::class`, or a route parameter
//! `'post'`), registered or found by Laravel's conventions
//! ([`guessed_policies`]); without a model, of every policy. Completion
//! lists both, goto opens the gate's definition or the policy method, find
//! usages and rename work from a usage or a `Gate::define` string, and an
//! ability that is neither is unknown.
//!
//! `authGuard`: a guard of `config/auth.php` in `auth('…')`,
//! `Auth::guard(…)` / `shouldUse(…)`, `auth()->guard(…)`, Blade's
//! `@auth('…')` / `@guest('…')` (and the `auth:`/`guest:` middleware).
//! `passwordBroker`: a broker in `Password::broker('…')`.

use std::path::Path;

use ide_core::Severity;

use super::{
    CalleePattern, Declared, PlacePattern, Position, RefContext, RefItem, ReferenceKind, RenameTarget, Undefined,
};
use crate::frameworks::laravel::auth::{AuthEntry, AuthFacts, brokers, guards, guessed_policies};
use crate::navigate::Target;
use crate::summary::{ClassKind, Visibility};
use crate::syntax::ParsedFile;

const GATES: &[&str] = &[
    "Illuminate\\Support\\Facades\\Gate",
    "Gate",
    "Illuminate\\Contracts\\Auth\\Access\\Gate",
    "Illuminate\\Auth\\Access\\Gate",
];
const USERS: &[&str] = &[
    "Illuminate\\Foundation\\Auth\\User",
    "Illuminate\\Contracts\\Auth\\Access\\Authorizable",
    "Illuminate\\Foundation\\Auth\\Access\\Authorizable",
];
const AUTHORIZES: &[&str] = &["Illuminate\\Foundation\\Auth\\Access\\AuthorizesRequests"];

const GATE: CalleePattern =
    CalleePattern::Method { classes: GATES, names: &["allows", "denies", "authorize", "inspect", "has"] };
const GATE_MANY: CalleePattern = CalleePattern::Method { classes: GATES, names: &["check", "any", "none"] };
const USER: CalleePattern = CalleePattern::Method { classes: USERS, names: &["can", "cannot", "cant", "canAny"] };
const AUTHORIZE: CalleePattern = CalleePattern::Method { classes: AUTHORIZES, names: &["authorize"] };
const AUTHORIZE_FOR_USER: CalleePattern = CalleePattern::Method { classes: AUTHORIZES, names: &["authorizeForUser"] };
const ROUTE_CAN: CalleePattern = CalleePattern::Method { classes: &["Illuminate\\Routing\\Route"], names: &["can"] };

static PATTERNS: [PlacePattern; 15] = [
    PlacePattern::argument(GATE, 0, "ability"),
    PlacePattern::argument(GATE_MANY, 0, "abilities"),
    PlacePattern::argument(GATE_MANY, 0, "abilities").at(Position::ListValue),
    PlacePattern::argument(USER, 0, "abilities"),
    PlacePattern::argument(USER, 0, "abilities").at(Position::ListValue),
    PlacePattern::argument(AUTHORIZE, 0, "ability"),
    PlacePattern::argument(AUTHORIZE_FOR_USER, 1, "ability"),
    PlacePattern::argument(ROUTE_CAN, 0, "ability"),
    // Blade (see `crate::blade::CALL_DIRECTIVES`).
    PlacePattern::argument(CalleePattern::Function("__blade_can"), 0, "ability"),
    PlacePattern::argument(CalleePattern::Function("__blade_cannot"), 0, "ability"),
    PlacePattern::argument(CalleePattern::Function("__blade_elsecan"), 0, "ability"),
    PlacePattern::argument(CalleePattern::Function("__blade_elsecannot"), 0, "ability"),
    PlacePattern::argument(CalleePattern::Function("__blade_canany"), 0, "abilities").at(Position::ListValue),
    PlacePattern::argument(CalleePattern::Function("__blade_elsecanany"), 0, "abilities").at(Position::ListValue),
    PlacePattern::argument(CalleePattern::Function("__blade_canany"), 0, "abilities"),
];

/// Policy methods that aren't abilities.
const NOT_ABILITIES: &[&str] = &["before", "after"];

/// An ability a usage can name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ability {
    pub name: String,
    /// `Gate · AppServiceProvider` or `PostPolicy`.
    pub detail: String,
    pub target: Option<Target>,
    /// A gate (as opposed to a policy method).
    pub gate: bool,
}

fn auth(cx: &RefContext<'_>) -> std::sync::Arc<AuthFacts> {
    cx.engine.laravel_auth().unwrap_or_default()
}

fn short(fqn: &str) -> &str {
    fqn.rsplit('\\').next().unwrap_or(fqn)
}

/// `blog_post` → `BlogPost`.
fn studly(name: &str) -> String {
    name.split(['_', '-'])
        .map(|part| {
            let mut chars = part.chars();
            chars.next().map(|first| first.to_ascii_uppercase().to_string() + chars.as_str()).unwrap_or_default()
        })
        .collect()
}

/// The models `subjects` (what the argument after the ability is: classes,
/// or route parameter names like `post`) stand for.
pub(crate) fn models_of(cx: &RefContext<'_>, subjects: &[String]) -> Vec<String> {
    let resolver = cx.engine.resolver();
    let namespace = cx.project.app_namespace.clone();
    let mut out: Vec<String> = Vec::new();
    for subject in subjects {
        let subject = subject.trim_start_matches('\\');
        let candidates = if subject.contains('\\') {
            vec![subject.to_owned()]
        } else if subject.chars().next().is_some_and(|c| c.is_ascii_lowercase()) {
            // A route parameter.
            let class = studly(subject);
            vec![format!("{namespace}Models\\{class}"), format!("{namespace}{class}")]
        } else {
            vec![subject.to_owned()]
        };
        if let Some(found) = candidates.into_iter().find_map(|candidate| {
            resolver
                .class_model(&candidate)
                .filter(|model| model.kind() == ClassKind::Class)
                .map(|model| model.fqn().to_owned())
        }) && !out.contains(&found)
        {
            out.push(found);
        }
    }
    out
}

/// The policy of `model`: registered, else found by Laravel's conventions.
pub(crate) fn policy_for(cx: &RefContext<'_>, facts: &AuthFacts, model: &str) -> Option<String> {
    if let Some(found) = facts.registered_policy(model) {
        return Some(found.policy.clone());
    }
    let resolver = cx.engine.resolver();
    guessed_policies(model)
        .into_iter()
        .find_map(|candidate| resolver.class_model(&candidate).map(|m| m.fqn().to_owned()))
}

/// Every policy of the project: the registered ones and the classes of the
/// `Policies` folders.
fn all_policies(facts: &AuthFacts) -> Vec<String> {
    let mut out: Vec<String> = facts.policies.iter().map(|policy| policy.policy.clone()).collect();
    out.extend(facts.policy_classes.iter().cloned());
    let mut seen = std::collections::HashSet::new();
    out.retain(|policy| seen.insert(policy.to_ascii_lowercase()));
    out
}

/// The policies an ability with `subjects` after it may be a method of.
fn policies(cx: &RefContext<'_>, facts: &AuthFacts, subjects: &[String]) -> Vec<String> {
    let models = models_of(cx, subjects);
    if models.is_empty() {
        return all_policies(facts);
    }
    models.iter().filter_map(|model| policy_for(cx, facts, model)).collect()
}

/// The abilities methods of `policy` define: its public methods, not static,
/// not magic, not `before`/`after`, not Laravel's own.
fn policy_abilities(cx: &RefContext<'_>, policy: &str) -> Vec<Ability> {
    let resolver = cx.engine.resolver();
    let Some(model) = resolver.class_model(policy) else { return Vec::new() };
    model
        .methods
        .iter()
        .filter(|method| {
            method.visibility == Visibility::Public
                && !method.is_static
                && !method.name.starts_with("__")
                && !NOT_ABILITIES.iter().any(|name| name.eq_ignore_ascii_case(&method.name))
                && !method.declaring.fqn.trim_start_matches('\\').starts_with("Illuminate\\")
        })
        .map(|method| Ability {
            name: method.name.clone(),
            detail: short(model.fqn()).to_owned(),
            target: super::controller_action::method_target(cx, model.fqn(), &method.name),
            gate: false,
        })
        .collect()
}

/// The abilities a usage with `subjects` after it can name: the gates, then
/// the methods of the policies.
pub(crate) fn abilities(cx: &RefContext<'_>, subjects: &[String]) -> Vec<Ability> {
    let facts = auth(cx);
    let mut out: Vec<Ability> = facts
        .gates
        .iter()
        .map(|gate| {
            let provider = gate.path.file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_default();
            let target = match &gate.policy {
                Some((policy, method)) => super::controller_action::method_target(cx, policy, method),
                None => None,
            };
            Ability {
                name: gate.name.clone(),
                detail: format!("Gate · {provider}"),
                target: target.or_else(|| Some(Target { path: gate.path.clone(), range: gate.range })),
                gate: true,
            }
        })
        .collect();
    for policy in policies(cx, &facts, subjects) {
        out.extend(policy_abilities(cx, &policy));
    }
    out
}

/// Completion items of abilities, replacing `from..to` of the value.
pub(crate) fn ability_items(cx: &RefContext<'_>, subjects: &[String], from: usize, to: usize) -> Vec<RefItem> {
    abilities(cx, subjects)
        .into_iter()
        .map(|ability| RefItem {
            label: ability.name.clone(),
            insert: ability.name,
            detail: Some(ability.detail),
            from,
            to,
        })
        .collect()
}

/// Where ability `name` is defined.
pub(crate) fn ability_targets(cx: &RefContext<'_>, subjects: &[String], name: &str) -> Vec<Target> {
    let mut out: Vec<Target> = Vec::new();
    for ability in abilities(cx, subjects) {
        // Gates are matched exactly, policy methods in any case (like PHP).
        let same = if ability.gate { ability.name == name } else { ability.name.eq_ignore_ascii_case(name) };
        if same
            && let Some(target) = ability.target
            && !out.contains(&target)
        {
            out.push(target);
        }
    }
    out
}

/// What is wrong with ability `name`, when it is neither a gate nor a
/// method of a policy it may be on.
pub(crate) fn ability_problem(cx: &RefContext<'_>, subjects: &[String], name: &str) -> Option<Undefined> {
    let facts = auth(cx);
    if facts.gates_named(name).next().is_some() {
        return None;
    }
    let models = models_of(cx, subjects);
    let candidates = if models.is_empty() {
        all_policies(&facts)
    } else {
        models.iter().filter_map(|model| policy_for(cx, &facts, model)).collect()
    };
    if candidates.iter().any(|policy| policy_abilities(cx, policy).iter().any(|a| a.name.eq_ignore_ascii_case(name))) {
        return None;
    }
    let message = match (models.as_slice(), candidates.as_slice()) {
        ([], _) => format!("Unknown ability '{name}': no gate or policy defines it"),
        ([model], []) => format!("Unknown ability '{name}': no gate defines it and {} has no policy", short(model)),
        (_, [policy]) => {
            format!("Unknown ability '{name}': no gate defines it and {} has no such method", short(policy))
        }
        _ => format!("Unknown ability '{name}': no gate or policy defines it"),
    };
    Some(Undefined { message, severity: Severity::Warning, fix: None })
}

/// Hover of ability `name`.
pub(crate) fn ability_hover(cx: &RefContext<'_>, subjects: &[String], name: &str) -> Option<String> {
    let lines: Vec<String> = abilities(cx, subjects)
        .into_iter()
        .filter(|ability| if ability.gate { ability.name == name } else { ability.name.eq_ignore_ascii_case(name) })
        .map(|ability| if ability.gate { ability.detail } else { format!("`{}::{}()`", ability.detail, ability.name) })
        .collect();
    (!lines.is_empty()).then(|| format!("**ability** `{name}`\n\n{}", lines.join("  \n")))
}

/// See the module documentation.
pub struct Gate;

impl Gate {
    fn subjects(cx: &RefContext<'_>) -> Vec<String> {
        cx.site.as_ref().map(|site| site.next_argument.clone()).unwrap_or_default()
    }
}

impl ReferenceKind for Gate {
    fn id(&self) -> &'static str {
        "gate"
    }

    fn patterns(&self) -> &'static [PlacePattern] {
        &PATTERNS
    }

    fn uses_next_argument(&self) -> bool {
        true
    }

    fn complete(&self, cx: &RefContext<'_>, value: &str, _at: usize) -> Vec<RefItem> {
        ability_items(cx, &Self::subjects(cx), 0, value.len())
    }

    fn resolve(&self, cx: &RefContext<'_>, value: &str, _at: usize) -> Vec<Target> {
        ability_targets(cx, &Self::subjects(cx), value)
    }

    fn usage_words(&self, value: &str) -> Vec<String> {
        crate::index::words(value)
    }

    fn declared_at(&self, cx: &RefContext<'_>, path: &Path, parsed: &ParsedFile, offset: u32) -> Option<Declared> {
        let facts = auth(cx);
        let lines = parsed.line_index();
        facts.gates.iter().filter(|gate| gate.policy.is_none() && gate.path == path).find_map(|gate| {
            let start = lines.byte(gate.range.start);
            let end = lines.byte(gate.range.end);
            (start <= offset && offset <= end).then(|| Declared {
                value: gate.name.clone(),
                start,
                end,
                at: (offset - start) as usize,
            })
        })
    }

    fn rename_target(&self, cx: &RefContext<'_>, value: &str, _at: usize) -> Option<RenameTarget> {
        // Only a gate (a policy method is renamed as a method).
        let facts = auth(cx);
        let mut gates = facts.gates_named(value).filter(|gate| gate.policy.is_none());
        let gate = gates.next()?;
        if gates.next().is_some() {
            return None;
        }
        Some(RenameTarget {
            key: value.to_owned(),
            range: (0, value.len()),
            declaration: Some((gate.path.clone(), gate.range)),
        })
    }

    fn is_known(&self, cx: &RefContext<'_>, value: &str) -> bool {
        ability_problem(cx, &Self::subjects(cx), value).is_none()
    }

    fn hover(&self, cx: &RefContext<'_>, value: &str) -> Option<String> {
        ability_hover(cx, &Self::subjects(cx), value)
    }

    fn undefined(&self, cx: &RefContext<'_>, value: &str) -> Option<Undefined> {
        ability_problem(cx, &Self::subjects(cx), value)
    }
}

// ----------------------------------------------------------------- guards

const AUTH: &[&str] = &[
    "Illuminate\\Support\\Facades\\Auth",
    "Auth",
    "Illuminate\\Auth\\AuthManager",
    "Illuminate\\Contracts\\Auth\\Factory",
];
const PASSWORD: &[&str] = &[
    "Illuminate\\Support\\Facades\\Password",
    "Password",
    "Illuminate\\Auth\\Passwords\\PasswordBrokerManager",
    "Illuminate\\Contracts\\Auth\\PasswordBrokerFactory",
];

static GUARD_PATTERNS: [PlacePattern; 4] = [
    PlacePattern::argument(CalleePattern::Function("auth"), 0, "guard"),
    PlacePattern::argument(CalleePattern::Method { classes: AUTH, names: &["guard", "shouldUse"] }, 0, "name"),
    PlacePattern::argument(CalleePattern::Function("__blade_auth"), 0, "guard"),
    PlacePattern::argument(CalleePattern::Function("__blade_guest"), 0, "guard"),
];
static BROKER_PATTERNS: [PlacePattern; 1] =
    [PlacePattern::argument(CalleePattern::Method { classes: PASSWORD, names: &["broker"] }, 0, "name")];

fn entry_items(entries: Vec<AuthEntry>, kind: &str, from: usize, to: usize) -> Vec<RefItem> {
    entries
        .into_iter()
        .map(|entry| RefItem {
            label: entry.name.clone(),
            insert: entry.name,
            detail: Some(match entry.detail {
                Some(detail) => format!("{kind} · {detail}"),
                None => kind.to_owned(),
            }),
            from,
            to,
        })
        .collect()
}

fn entry_targets(entries: Vec<AuthEntry>, name: &str) -> Vec<Target> {
    entries
        .into_iter()
        .filter(|entry| entry.name == name)
        .filter_map(|entry| entry.declared.map(|(path, range)| Target { path, range }))
        .collect()
}

/// The guards of the project (`config/auth.php`, else Laravel's `web`).
pub(crate) fn guard_entries(cx: &RefContext<'_>) -> Vec<AuthEntry> {
    guards(&cx.engine.laravel_config().unwrap_or_default())
}

/// Completion items of guards, replacing `from..to` of the value.
pub(crate) fn guard_items(cx: &RefContext<'_>, from: usize, to: usize) -> Vec<RefItem> {
    entry_items(guard_entries(cx), "guard", from, to)
}

/// Where guard `name` is declared.
pub(crate) fn guard_targets(cx: &RefContext<'_>, name: &str) -> Vec<Target> {
    entry_targets(guard_entries(cx), name)
}

/// See the module documentation.
pub struct AuthGuard;

impl ReferenceKind for AuthGuard {
    fn id(&self) -> &'static str {
        "authGuard"
    }

    fn patterns(&self) -> &'static [PlacePattern] {
        &GUARD_PATTERNS
    }

    fn complete(&self, cx: &RefContext<'_>, value: &str, _at: usize) -> Vec<RefItem> {
        guard_items(cx, 0, value.len())
    }

    fn resolve(&self, cx: &RefContext<'_>, value: &str, _at: usize) -> Vec<Target> {
        guard_targets(cx, value)
    }

    fn is_known(&self, cx: &RefContext<'_>, value: &str) -> bool {
        guard_entries(cx).iter().any(|entry| entry.name == value)
    }

    fn hover(&self, cx: &RefContext<'_>, value: &str) -> Option<String> {
        let entries = guard_entries(cx);
        let entry = entries.iter().find(|entry| entry.name == value)?;
        let driver = entry.detail.as_deref().map(|driver| format!("\n\ndriver: `{driver}`")).unwrap_or_default();
        Some(format!("**guard** `{value}`{driver}"))
    }
}

/// See the module documentation.
pub struct PasswordBroker;

impl PasswordBroker {
    fn entries(cx: &RefContext<'_>) -> Vec<AuthEntry> {
        brokers(&cx.engine.laravel_config().unwrap_or_default())
    }
}

impl ReferenceKind for PasswordBroker {
    fn id(&self) -> &'static str {
        "passwordBroker"
    }

    fn patterns(&self) -> &'static [PlacePattern] {
        &BROKER_PATTERNS
    }

    fn complete(&self, cx: &RefContext<'_>, value: &str, _at: usize) -> Vec<RefItem> {
        entry_items(Self::entries(cx), "password broker", 0, value.len())
    }

    fn resolve(&self, cx: &RefContext<'_>, value: &str, _at: usize) -> Vec<Target> {
        entry_targets(Self::entries(cx), value)
    }

    fn is_known(&self, cx: &RefContext<'_>, value: &str) -> bool {
        Self::entries(cx).iter().any(|entry| entry.name == value)
    }

    fn hover(&self, cx: &RefContext<'_>, value: &str) -> Option<String> {
        let entries = Self::entries(cx);
        let entry = entries.iter().find(|entry| entry.name == value)?;
        let provider =
            entry.detail.as_deref().map(|provider| format!("\n\nprovider: `{provider}`")).unwrap_or_default();
        Some(format!("**password broker** `{value}`{provider}"))
    }
}
