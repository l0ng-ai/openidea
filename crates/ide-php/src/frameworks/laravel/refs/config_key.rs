//! The `configKey` reference kind: the dotted keys of `config/*.php`
//! ([`ConfigKeys`]) in `config('app.name')`, `config(['app.name' => …])`,
//! `Config::get('app.name')` and the other reading and writing methods of
//! the configuration repository (`config()->get(…)`, a typed
//! `Repository $config`), as Laravel's documentation on configuration lists
//! them.
//!
//! Completion goes segment by segment: after `app.` the keys of
//! `config/app.php`, after `blog.feed.` the keys of the `feed` array. Goto
//! opens the segment at the caret (`app` opens the file, `name` the key).
//! Renaming changes one segment of a key in the array and in every usage
//! of the key or of the keys below it; a file's segment isn't renamed.

use std::path::Path;

use super::{CalleePattern, Declared, PlacePattern, Position, RefContext, RefItem, ReferenceKind, RenameTarget};
use crate::frameworks::laravel::config::{ConfigKeys, declared_key_at, file_prefix};
use crate::navigate::Target;
use crate::syntax::ParsedFile;

/// The configuration repository: Laravel's `Config` facade (and its global
/// alias), the repository class and its contract.
const CLASSES: &[&str] = &[
    "Illuminate\\Support\\Facades\\Config",
    "Config",
    "Illuminate\\Config\\Repository",
    "Illuminate\\Contracts\\Config\\Repository",
];

/// Repository methods whose first parameter (`$key`) is a key.
const KEY_METHODS: &[&str] =
    &["get", "has", "set", "string", "integer", "float", "boolean", "array", "collection", "prepend", "push"];

const CONFIG: CalleePattern = CalleePattern::Function("config");
const KEY: CalleePattern = CalleePattern::Method { classes: CLASSES, names: KEY_METHODS };
const SET: CalleePattern = CalleePattern::Method { classes: CLASSES, names: &["set"] };
const GET_MANY: CalleePattern = CalleePattern::Method { classes: CLASSES, names: &["getMany"] };

static PATTERNS: [PlacePattern; 6] = [
    // `config('app.name')`, `config(['app.name' => 'x'])`.
    PlacePattern::argument(CONFIG, 0, "key"),
    PlacePattern::argument(CONFIG, 0, "key").at(Position::ArrayKey),
    // `Config::get('app.name')`, `Config::set(['app.name' => 'x'])`.
    PlacePattern::argument(KEY, 0, "key"),
    PlacePattern::argument(SET, 0, "key").at(Position::ArrayKey),
    // `Config::getMany(['app.name', 'app.env' => 'local'])` (a key with
    // its default).
    PlacePattern::argument(GET_MANY, 0, "keys").at(Position::ListValue),
    PlacePattern::argument(GET_MANY, 0, "keys").at(Position::ArrayKey),
];

/// See the module documentation.
pub struct ConfigKey;

impl ConfigKey {
    fn keys(cx: &RefContext<'_>) -> std::sync::Arc<ConfigKeys> {
        cx.engine.laravel_config().unwrap_or_default()
    }
}

/// The end of the segment of `value` the byte `at` is in.
fn segment_end(value: &str, at: usize) -> usize {
    value[at.min(value.len())..].find('.').map_or(value.len(), |dot| at + dot)
}

impl ReferenceKind for ConfigKey {
    fn id(&self) -> &'static str {
        "configKey"
    }

    fn patterns(&self) -> &'static [PlacePattern] {
        &PATTERNS
    }

    fn complete(&self, cx: &RefContext<'_>, value: &str, at: usize) -> Vec<RefItem> {
        let keys = Self::keys(cx);
        let typed = &value[..at];
        let to = segment_end(value, at);
        let (parent, from) = match typed.rfind('.') {
            Some(dot) => (Some(&typed[..dot]), dot + 1),
            None => (None, 0),
        };
        // Files in folders (`config/services/mail.php`) are children of
        // the folder's segment too.
        keys.children(parent)
            .map(|entry| {
                let label = match parent {
                    Some(parent) => entry.key[parent.len() + 1..].to_owned(),
                    None => entry.key.clone(),
                };
                let detail = match &entry.value {
                    Some(value) => Some(value.clone()),
                    None if entry.is_file => Some(format!("config/{}.php", entry.key.replace('.', "/"))),
                    None => Some("array".to_owned()),
                };
                RefItem { insert: label.clone(), label, detail, from, to }
            })
            .collect()
    }

    fn resolve(&self, cx: &RefContext<'_>, value: &str, at: usize) -> Vec<Target> {
        let keys = Self::keys(cx);
        let key = &value[..segment_end(value, at)];
        // A file named with a dot (`services.mail`) is reached from either
        // of its segments.
        let entry = keys.get(key).or_else(|| keys.file_of(key).filter(|file| file.key.len() >= key.len()));
        entry.map(|entry| Target { path: entry.path.clone(), range: entry.range }).into_iter().collect()
    }

    fn usage_words(&self, value: &str) -> Vec<String> {
        let mut words = crate::index::words(value);
        words.push("config".to_owned());
        words
    }

    fn declared_at(&self, cx: &RefContext<'_>, path: &Path, parsed: &ParsedFile, offset: u32) -> Option<Declared> {
        let prefix = file_prefix(&cx.project.paths.config, path)?;
        let declared = declared_key_at(parsed, &prefix, offset)?;
        let at = declared.key.len() - (declared.end - offset.min(declared.end)) as usize;
        Some(Declared { value: declared.key, start: declared.start, end: declared.end, at })
    }

    fn rename_target(&self, cx: &RefContext<'_>, value: &str, at: usize) -> Option<RenameTarget> {
        let keys = Self::keys(cx);
        let end = segment_end(value, at);
        let key = &value[..end];
        let entry = keys.get(key)?;
        if entry.is_file {
            return None;
        }
        let start = key.rfind('.').map_or(0, |dot| dot + 1);
        Some(RenameTarget {
            key: key.to_owned(),
            range: (start, end),
            declaration: Some((entry.path.clone(), entry.range)),
        })
    }

    fn renames_with(&self, value: &str, key: &str) -> bool {
        value == key || value.strip_prefix(key).is_some_and(|rest| rest.starts_with('.'))
    }

    fn valid_name(&self, name: &str) -> bool {
        !name.is_empty() && !name.contains(['\'', '"', '\\', '.'])
    }

    fn is_known(&self, cx: &RefContext<'_>, value: &str) -> bool {
        Self::keys(cx).get(value).is_some()
    }
}
