//! The `translationKey` reference kind: the keys of the project's
//! translations ([`Translations`]) in `__('…')`, `trans('…')`,
//! `trans_choice('…')`, `Lang::get`/`has`/`hasForLocale`/`choice` (and the
//! translator, `trans()->get(…)`), and Blade's `@lang('…')` and
//! `@choice('…')`, as Laravel's documentation on localization lists them.
//!
//! Completion offers the group keys segment by segment (`messages.` then
//! the keys of `messages.php`) and the JSON keys whole; goto opens the key
//! in every locale; hover shows its text in each locale. Find usages also
//! starts from a key of a group file. A key no locale has is undefined
//! (group keys always, whole strings when the project has JSON
//! translations), with the quick-fix "Create translation key", which adds
//! it to every locale.

use std::path::Path;

use super::{CalleePattern, Declared, PlacePattern, RefContext, RefItem, ReferenceKind, Undefined};
use crate::frameworks::laravel::config::declared_key_at;
use crate::frameworks::laravel::lang::{Translations, is_group_key};
use crate::navigate::Target;
use crate::syntax::ParsedFile;

/// The translator: Laravel's `Lang` facade (and its global alias), the
/// translator and its contract.
const TRANSLATOR: &[&str] = &[
    "Illuminate\\Support\\Facades\\Lang",
    "Lang",
    "Illuminate\\Translation\\Translator",
    "Illuminate\\Contracts\\Translation\\Translator",
];

const TRANSLATOR_KEY: CalleePattern =
    CalleePattern::Method { classes: TRANSLATOR, names: &["get", "has", "hasForLocale", "choice"] };

static PATTERNS: [PlacePattern; 6] = [
    PlacePattern::argument(CalleePattern::Function("__"), 0, "key"),
    PlacePattern::argument(CalleePattern::Function("trans"), 0, "key"),
    PlacePattern::argument(CalleePattern::Function("trans_choice"), 0, "key"),
    PlacePattern::argument(TRANSLATOR_KEY, 0, "key"),
    // Blade (see `crate::blade::CALL_DIRECTIVES`).
    PlacePattern::argument(CalleePattern::Function("__blade_lang"), 0, "key"),
    PlacePattern::argument(CalleePattern::Function("__blade_choice"), 0, "key"),
];

/// See the module documentation.
pub struct TranslationKey;

impl TranslationKey {
    fn translations(cx: &RefContext<'_>) -> std::sync::Arc<Translations> {
        cx.engine.laravel_translations().unwrap_or_default()
    }
}

/// The end of the segment of `value` the byte `at` is in.
fn segment_end(value: &str, at: usize) -> usize {
    value[at.min(value.len())..].find('.').map_or(value.len(), |dot| at + dot)
}

/// The text a new key gets when none is asked for: a whole string itself,
/// a group key's last segment in words (`slug_taken` is `Slug taken`).
pub fn default_text(key: &str) -> String {
    if !is_group_key(key) {
        return key.to_owned();
    }
    let last = key.rsplit('.').next().unwrap_or(key).replace(['_', '-'], " ");
    let mut chars = last.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => last,
    }
}

impl ReferenceKind for TranslationKey {
    fn id(&self) -> &'static str {
        "translationKey"
    }

    fn patterns(&self) -> &'static [PlacePattern] {
        &PATTERNS
    }

    fn complete(&self, cx: &RefContext<'_>, value: &str, at: usize) -> Vec<RefItem> {
        let translations = Self::translations(cx);
        let typed = &value[..at.min(value.len())];
        let mut items: Vec<RefItem> = translations
            .json_keys()
            .into_iter()
            .map(|entry| RefItem {
                label: entry.key.clone(),
                insert: entry.key.clone(),
                detail: entry.text.clone(),
                from: 0,
                to: value.len(),
            })
            .collect();
        if typed.contains(char::is_whitespace) {
            return items;
        }
        let to = segment_end(value, at);
        let (parent, from) = match typed.rfind('.') {
            Some(dot) => (Some(&typed[..dot]), dot + 1),
            None => (None, 0),
        };
        let root = &cx.project.root;
        for entry in translations.children(parent) {
            let label = match parent {
                Some(parent) => entry.key[parent.len() + 1..].to_owned(),
                None => entry.key.clone(),
            };
            let detail = match &entry.text {
                Some(text) => Some(text.clone()),
                None if entry.is_file => {
                    Some(entry.path.strip_prefix(root).unwrap_or(&entry.path).to_string_lossy().replace('\\', "/"))
                }
                None => Some("array".to_owned()),
            };
            items.push(RefItem { insert: label.clone(), label, detail, from, to });
        }
        items
    }

    fn resolve(&self, cx: &RefContext<'_>, value: &str, at: usize) -> Vec<Target> {
        let translations = Self::translations(cx);
        let target =
            |entry: &crate::frameworks::laravel::TransEntry| Target { path: entry.path.clone(), range: entry.range };
        let json: Vec<Target> = translations.get(value).filter(|entry| entry.json).map(target).collect();
        if !json.is_empty() {
            return json;
        }
        let key = &value[..segment_end(value, at)];
        translations.get(key).filter(|entry| !entry.json).map(target).collect()
    }

    fn declared_at(&self, cx: &RefContext<'_>, path: &Path, parsed: &ParsedFile, offset: u32) -> Option<Declared> {
        let (group, _) = Self::translations(cx).group_of_file(path)?;
        let declared = declared_key_at(parsed, &group, offset)?;
        let at = declared.key.len() - (declared.end - offset.min(declared.end)) as usize;
        Some(Declared { value: declared.key, start: declared.start, end: declared.end, at })
    }

    fn is_known(&self, cx: &RefContext<'_>, value: &str) -> bool {
        Self::translations(cx).contains(value)
    }

    fn hover(&self, cx: &RefContext<'_>, value: &str) -> Option<String> {
        let translations = Self::translations(cx);
        let lines: Vec<String> = translations
            .get(value)
            .filter_map(|entry| Some(format!("**{}**: {}", entry.locale, entry.text.as_deref()?)))
            .collect();
        (!lines.is_empty()).then(|| lines.join("  \n"))
    }

    fn undefined(&self, cx: &RefContext<'_>, value: &str) -> Option<Undefined> {
        let translations = Self::translations(cx);
        if translations.is_empty() || translations.contains(value) || !translations.knows_namespace_of(value) {
            return None;
        }
        if !is_group_key(value) && !translations.has_json() {
            return None;
        }
        let problem = Undefined::warning(format!("Translation key '{value}' is not defined"));
        let locales = translations.locales();
        let texts: Vec<(String, String)> = locales.iter().map(|locale| (locale.clone(), default_text(value))).collect();
        match translations.create(value, &texts) {
            Some(edit) if !edit.files.is_empty() => {
                Some(problem.with_fix(format!("Create translation key '{value}'"), edit))
            }
            _ => Some(problem),
        }
    }
}
