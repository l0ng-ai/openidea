//! The `envKey` reference kind: the variables of `.env` and `.env.example`
//! ([`EnvKeys`]) in `env('APP_NAME')` and `Env::get('APP_NAME')` /
//! `Env::getOrFail(…)`, as Laravel's documentation on configuration lists
//! them.
//!
//! Completion offers every key with its value (from `.env`, else
//! `.env.example`); goto opens its line in both files; hover shows both
//! values. A key neither file sets is undefined, with a quick-fix adding
//! it to `.env.example`; a key only `.env` sets is reported (as
//! information) with the same fix, so the example stays complete.

use ide_core::Severity;

use super::{CalleePattern, PlacePattern, RefContext, RefItem, ReferenceKind, Undefined};
use crate::frameworks::laravel::env::EnvKeys;
use crate::navigate::Target;

const ENV: CalleePattern = CalleePattern::Function("env");
const ENV_CLASS: CalleePattern =
    CalleePattern::Method { classes: &["Illuminate\\Support\\Env"], names: &["get", "getOrFail"] };

static PATTERNS: [PlacePattern; 2] =
    [PlacePattern::argument(ENV, 0, "key"), PlacePattern::argument(ENV_CLASS, 0, "key")];

/// See the module documentation.
pub struct EnvKey;

impl EnvKey {
    fn keys(cx: &RefContext<'_>) -> std::sync::Arc<EnvKeys> {
        cx.engine.laravel_env().unwrap_or_default()
    }
}

impl ReferenceKind for EnvKey {
    fn id(&self) -> &'static str {
        "envKey"
    }

    fn patterns(&self) -> &'static [PlacePattern] {
        &PATTERNS
    }

    fn complete(&self, cx: &RefContext<'_>, value: &str, _at: usize) -> Vec<RefItem> {
        let keys = Self::keys(cx);
        keys.keys()
            .into_iter()
            .map(|key| {
                let detail = keys.value(key).map(str::to_owned);
                RefItem { label: key.to_owned(), insert: key.to_owned(), detail, from: 0, to: value.len() }
            })
            .collect()
    }

    fn resolve(&self, cx: &RefContext<'_>, value: &str, _at: usize) -> Vec<Target> {
        Self::keys(cx).get(value).map(|entry| Target { path: entry.path.clone(), range: entry.range }).collect()
    }

    fn usage_words(&self, value: &str) -> Vec<String> {
        let mut words = crate::index::words(value);
        words.push("env".to_owned());
        words
    }

    fn is_known(&self, cx: &RefContext<'_>, value: &str) -> bool {
        Self::keys(cx).contains(value)
    }

    fn hover(&self, cx: &RefContext<'_>, value: &str) -> Option<String> {
        let keys = Self::keys(cx);
        let lines: Vec<String> = keys
            .get(value)
            .map(|entry| {
                let file = if entry.example { ".env.example" } else { ".env" };
                format!("{file}: `{}`", entry.value)
            })
            .collect();
        (!lines.is_empty()).then(|| format!("**env** `{value}`\n\n{}", lines.join("  \n")))
    }

    fn undefined(&self, cx: &RefContext<'_>, value: &str) -> Option<Undefined> {
        let keys = Self::keys(cx);
        if !keys.has_files() || keys.in_example(value) {
            return None;
        }
        let fix = (format!("Add '{value}' to .env.example"), keys.add_to_example(value));
        if keys.contains(value) {
            if !keys.has_example() {
                return None;
            }
            let message = format!("Environment variable '{value}' is missing from .env.example");
            return Some(Undefined { message, severity: Severity::Info, fix: Some(fix) });
        }
        let message = format!("Environment variable '{value}' is not defined in .env or .env.example");
        Some(Undefined { message, severity: Severity::Warning, fix: Some(fix) })
    }
}
