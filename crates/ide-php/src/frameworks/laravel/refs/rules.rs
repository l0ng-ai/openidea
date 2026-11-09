//! String references from the completion rules of `ide.json` files
//! ([`crate::frameworks::laravel::ide_json`]): matching a rule's conditions
//! against a string site ([`condition_matches`]), and the two kinds only
//! rules use, `staticStrings` ([`StaticStrings`]: the rule's own list) and
//! `directoryFiles` ([`DirectoryFiles`]: the files of the rule's folders).
//! A rule naming another kind (`routeName`) gets that kind's completion,
//! goto, usages and inspection at the places it describes.

use std::path::{Path, PathBuf};

use ide_core::{Pos, Range};

use super::{ArrayStep, CallTarget, PlacePattern, RefContext, RefItem, ReferenceKind, StringSite};
use crate::frameworks::laravel::ide_json::{CompletionRule, Condition, Step};
use crate::names::{NameKind, fqn_eq};
use crate::navigate::Target;
use crate::types::Resolver;

/// The last segment of a name.
fn short(name: &str) -> &str {
    name.rsplit('\\').next().unwrap_or(name)
}

/// Whether class `class` (an FQN) fits the class lists of a condition; any
/// class fits empty lists.
fn class_fits(class: &str, names: &[String], fqns: &[String], parents: &[String], resolver: &Resolver<'_>) -> bool {
    let class = class.trim_start_matches('\\');
    (names.is_empty() && fqns.is_empty() && parents.is_empty())
        || names.iter().any(|name| short(class).eq_ignore_ascii_case(short(name)))
        || fqns.iter().any(|fqn| fqn_eq(NameKind::ClassLike, class, fqn))
        || parents.iter().any(|parent| {
            fqn_eq(NameKind::ClassLike, class, parent)
                || resolver.class_model(class).is_some_and(|model| model.is_subclass_of(parent))
        })
}

/// Whether `site` is in the place `condition` describes.
pub fn condition_matches(condition: &Condition, site: &StringSite, resolver: &Resolver<'_>) -> bool {
    if !condition.argument_matches(site.index, site.argument_name.as_deref()) {
        return false;
    }
    let steps: Vec<Step<'_>> = site
        .steps
        .iter()
        .map(|step| match step {
            ArrayStep::Key => Step::Key,
            ArrayStep::Value(key) => Step::Value(key.as_deref()),
        })
        .collect();
    if !condition.place_matches(&steps) {
        return false;
    }
    let c = condition;
    match &site.target {
        CallTarget::Return { class, method } => {
            c.place.is_return()
                && c.method_names.iter().any(|name| name.eq_ignore_ascii_case(method))
                && class_fits(class, &c.class_names, &c.class_fqns, &c.class_parents, resolver)
        }
        _ if c.place.is_return() => false,
        CallTarget::Function(candidates) => candidates.iter().any(|candidate| {
            let candidate = candidate.trim_start_matches('\\');
            c.function_names.iter().any(|name| short(candidate).eq_ignore_ascii_case(short(name)))
                || c.function_fqns.iter().any(|fqn| fqn_eq(NameKind::Function, candidate, fqn))
        }),
        CallTarget::Method { classes, name, .. } => {
            if name.eq_ignore_ascii_case("__construct") && c.is_new() {
                return classes.iter().any(|class| {
                    class_fits(class, &c.new_class_names, &c.new_class_fqns, &c.new_class_parents, resolver)
                });
            }
            let any_class = c.class_names.is_empty() && c.class_fqns.is_empty() && c.class_parents.is_empty();
            c.method_names.iter().any(|wanted| wanted.eq_ignore_ascii_case(name))
                && (any_class
                    || classes
                        .iter()
                        .any(|class| class_fits(class, &c.class_names, &c.class_fqns, &c.class_parents, resolver)))
        }
        CallTarget::Property { .. } => false,
    }
}

/// Whether `site` is in a place `rule` describes.
pub fn rule_matches(rule: &CompletionRule, site: &StringSite, resolver: &Resolver<'_>) -> bool {
    rule.conditions.iter().any(|condition| condition_matches(condition, site, resolver))
}

/// The rule the string of the context's site was matched by.
fn rule<'c>(cx: &'c RefContext<'_>) -> Option<&'c CompletionRule> {
    cx.site.as_ref()?.rule.as_ref()
}

/// The `staticStrings` kind: the strings of the rule.
pub struct StaticStrings;

impl ReferenceKind for StaticStrings {
    fn id(&self) -> &'static str {
        "staticStrings"
    }

    fn patterns(&self) -> &'static [PlacePattern] {
        &[]
    }

    fn complete(&self, cx: &RefContext<'_>, value: &str, _at: usize) -> Vec<RefItem> {
        let Some(rule) = rule(cx) else { return Vec::new() };
        rule.options
            .strings
            .iter()
            .map(|(string, location)| RefItem {
                label: string.clone(),
                insert: string.clone(),
                detail: location.clone(),
                from: 0,
                to: value.len(),
            })
            .collect()
    }

    fn resolve(&self, cx: &RefContext<'_>, value: &str, _at: usize) -> Vec<Target> {
        let Some(rule) = rule(cx) else { return Vec::new() };
        let Some((_, Some(location))) = rule.options.strings.iter().find(|(string, _)| string == value) else {
            return Vec::new();
        };
        location_target(&rule.file, location).into_iter().collect()
    }

    fn is_known(&self, cx: &RefContext<'_>, value: &str) -> bool {
        rule(cx).is_some_and(|rule| rule.options.strings.iter().any(|(string, _)| string == value))
    }
}

/// A location of `stringsWithLocation`: a file relative to the `ide.json`
/// at `file`, optionally with a 1-based `:line`.
fn location_target(file: &Path, location: &str) -> Option<Target> {
    let (path, line) = match location.rsplit_once(':') {
        Some((path, line)) if !path.is_empty() && line.bytes().all(|b| b.is_ascii_digit()) && !line.is_empty() => {
            (path, line.parse::<u32>().ok())
        }
        _ => (location, None),
    };
    let base = file.parent()?;
    let path = crate::project::normalize(&base.join(path.trim_start_matches(['/', '\\'])));
    if !path.exists() {
        return None;
    }
    let at = Pos::new(line.unwrap_or(1).saturating_sub(1), 0);
    Some(Target { path, range: Range { start: at, end: at } })
}

/// The `directoryFiles` kind: the files of the rule's folders, by their
/// path below the folder (`/` separated, `suffixToClear` cut off).
pub struct DirectoryFiles;

impl DirectoryFiles {
    fn files(rule: &CompletionRule) -> Vec<(String, PathBuf)> {
        let mut out = Vec::new();
        for dir in &rule.options.directories {
            collect(dir, dir, rule.options.recursive, &rule.options.suffix_to_clear, &mut out);
        }
        out
    }
}

fn collect(base: &Path, dir: &Path, recursive: bool, suffix: &str, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            if recursive {
                collect(base, &path, recursive, suffix, out);
            }
            continue;
        }
        let Ok(rel) = path.strip_prefix(base) else { continue };
        let rel = rel.to_string_lossy().replace('\\', "/");
        let name = match rel.strip_suffix(suffix) {
            Some(name) if !suffix.is_empty() && !name.is_empty() => name.to_owned(),
            _ => rel,
        };
        out.push((name, crate::project::normalize(&path)));
    }
}

impl ReferenceKind for DirectoryFiles {
    fn id(&self) -> &'static str {
        "directoryFiles"
    }

    fn patterns(&self) -> &'static [PlacePattern] {
        &[]
    }

    fn complete(&self, cx: &RefContext<'_>, value: &str, _at: usize) -> Vec<RefItem> {
        let Some(rule) = rule(cx) else { return Vec::new() };
        Self::files(rule)
            .into_iter()
            .map(|(name, _)| RefItem { insert: name.clone(), label: name, detail: None, from: 0, to: value.len() })
            .collect()
    }

    fn resolve(&self, cx: &RefContext<'_>, value: &str, _at: usize) -> Vec<Target> {
        let Some(rule) = rule(cx) else { return Vec::new() };
        Self::files(rule)
            .into_iter()
            .filter(|(name, _)| name == value)
            .map(|(_, path)| Target { path, range: Range::default() })
            .collect()
    }

    fn is_known(&self, cx: &RefContext<'_>, value: &str) -> bool {
        rule(cx).is_some_and(|rule| Self::files(rule).iter().any(|(name, _)| name == value))
    }
}
