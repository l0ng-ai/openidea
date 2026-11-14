//! Registering what a generator creates, so that it works without another
//! manual step:
//!
//! - **Observers:** `#[ObservedBy([PostObserver::class])]` on the model (or
//!   the observer added to the model's attribute).
//! - **Listeners:** the listener under its event in the `$listen` array of
//!   the project's event service provider, when it has one (Laravel 11 and
//!   later discover listeners, and there's nothing to register then).
//! - **Module service providers:** the provider in the `providers` of a
//!   `nwidart/laravel-modules` module's `module.json` (the application's
//!   go to `bootstrap/providers.php`, see [`super::classes`]).
//!
//! Each registration is a plain text edit computed from the file's text
//! (the functions here are pure, so tests feed them text).

use std::path::Path;

use ide_core::{FileEdit, TextEdit};

use crate::imports::import_insertion;
use crate::names::{FileNames, NameKind};
use crate::summary::FileSummary;
use crate::syntax::ParsedFile;

/// Eloquent's attribute naming a model's observers.
pub const OBSERVED_BY: &str = "Illuminate\\Database\\Eloquent\\Attributes\\ObservedBy";

/// `(start, end, text)` byte edits.
type Edits = Vec<(u32, u32, String)>;

/// The name to write for class `fqn` at byte `at` of `parsed`, and the
/// import it needs: the short name when it resolves to `fqn` already or can
/// be imported, else the fully qualified name.
fn written(parsed: &ParsedFile, names: &FileNames, at: u32, fqn: &str, edits: &mut Edits) -> String {
    let fqn = fqn.trim_start_matches('\\');
    let short = fqn.rsplit('\\').next().unwrap_or(fqn);
    let resolved = names.scope_at(at).resolve(NameKind::ClassLike, short);
    if resolved.resolution.matches(NameKind::ClassLike, fqn) {
        return short.to_owned();
    }
    // A short name of another class (imported, or of the file's namespace)
    // stays as it is.
    let own_namespace = names.scope_at(at).namespace().trim_matches('\\').to_owned();
    let declared_here =
        FileSummary::extract(parsed).class_likes.iter().any(|class| class.name.eq_ignore_ascii_case(short));
    if resolved.imported || declared_here {
        return format!("\\{fqn}");
    }
    let namespace = fqn.rsplit_once('\\').map_or("", |(namespace, _)| namespace);
    if !namespace.eq_ignore_ascii_case(&own_namespace) {
        let (at, line) = import_insertion(parsed, at, NameKind::ClassLike, fqn);
        edits.push((at, at, line));
    }
    short.to_owned()
}

/// The edit of `path` from byte edits on `text`.
fn file_edit(text: &str, path: &Path, mut edits: Edits) -> FileEdit {
    edits.sort_by_key(|(start, end, _)| (*start, *end));
    let lines = crate::syntax::LineIndex::new(text);
    FileEdit::Edit {
        path: path.to_path_buf().into(),
        edits: edits
            .into_iter()
            .map(|(start, end, new_text)| TextEdit { range: lines.range(start, end), new_text })
            .collect(),
        version: None,
    }
}

/// The byte of the `]` closing the `[` at `open`, skipping strings and
/// nested brackets.
fn closing_bracket(text: &str, open: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut depth = 0usize;
    let mut quote: Option<u8> = None;
    let mut i = open;
    while i < bytes.len() {
        let b = bytes[i];
        match quote {
            Some(_) if b == b'\\' => i += 1,
            Some(q) if b == q => quote = None,
            Some(_) => {}
            None => match b {
                b'\'' | b'"' => quote = Some(b),
                b'[' | b'(' => depth += 1,
                b']' | b')' => {
                    depth -= 1;
                    if depth == 0 {
                        return (b == b']').then_some(i);
                    }
                }
                _ => {}
            },
        }
        i += 1;
    }
    None
}

/// `item` appended to the array `[`…`]` at bytes `open..=close` of `text`:
/// on a line of its own when the array spans lines.
fn append_item(text: &str, open: usize, close: usize, item: &str) -> (u32, String) {
    let inner = &text[open + 1..close];
    let content = inner.trim_end();
    let at = open + 1 + content.len();
    if content.trim().is_empty() {
        return ((open + 1) as u32, item.to_owned());
    }
    let comma = if content.ends_with(',') { "" } else { "," };
    if inner.contains('\n') {
        let line_start = text[..at].rfind('\n').map_or(0, |i| i + 1);
        let indent: String = text[line_start..].chars().take_while(|c| *c == ' ' || *c == '\t').collect();
        let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
        (at as u32, format!("{comma}{nl}{indent}{item}{}", if comma.is_empty() { "," } else { "" }))
    } else {
        (at as u32, format!("{comma} {item}"))
    }
}

/// The edit registering observer `observer` on model `model`, whose class
/// is declared in `text` (file `path`): its `#[ObservedBy]` attribute gets
/// the observer, or the class gets the attribute. `None` when the model
/// isn't declared there or names the observer already.
pub fn observer_registration(text: &str, path: &Path, model: &str, observer: &str) -> Option<FileEdit> {
    let parsed = ParsedFile::parse(&path.to_string_lossy(), text);
    let summary = FileSummary::extract(&parsed);
    let class =
        summary.class_likes.iter().find(|class| class.fqn.eq_ignore_ascii_case(model.trim_start_matches('\\')))?;
    let names = FileNames::resolve(&parsed);
    let short = observer.rsplit('\\').next().unwrap_or(observer);
    let mut edits = Edits::new();
    if class.attributes.iter().any(|attribute| attribute.eq_ignore_ascii_case(OBSERVED_BY)) {
        let span = text.get(class.loc.start as usize..class.name_loc.start as usize)?;
        let at = class.loc.start as usize + span.find("ObservedBy")?;
        let open = at + text[at..].find('(')?;
        let close = open + text[open..].find(')')?;
        let args = &text[open + 1..close];
        if args.contains(&format!("{short}::class")) || args.contains(&format!("{observer}::class")) {
            return None;
        }
        let name = written(&parsed, &names, class.name_loc.start, observer, &mut edits);
        let item = format!("{name}::class");
        match args.trim_start().strip_prefix('[') {
            Some(_) => {
                let open = open + 1 + args.find('[')?;
                let close = closing_bracket(text, open)?;
                let (at, insert) = append_item(text, open, close, &item);
                edits.push((at, at, insert));
            }
            None => {
                let trimmed = args.trim();
                edits.push(((open + 1) as u32, close as u32, format!("[{trimmed}, {item}]")));
            }
        }
    } else {
        let name = written(&parsed, &names, class.name_loc.start, observer, &mut edits);
        let attribute = written(&parsed, &names, class.name_loc.start, OBSERVED_BY, &mut edits);
        // Before the line declaring the class (after its other attributes).
        let line_start = text[..class.name_loc.start as usize].rfind('\n').map_or(0, |i| i + 1);
        let indent: String = text[line_start..].chars().take_while(|c| *c == ' ' || *c == '\t').collect();
        let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
        edits.push((line_start as u32, line_start as u32, format!("{indent}#[{attribute}([{name}::class])]{nl}")));
    }
    Some(file_edit(text, path, edits))
}

/// The edit registering listener `listener` for event `event` in the
/// `$listen` array of the provider declared in `text` (file `path`): under
/// the event's entry, or in a new entry. `None` without a `$listen` array,
/// and when the event lists the listener already.
pub fn listener_registration(text: &str, path: &Path, event: &str, listener: &str) -> Option<FileEdit> {
    let parsed = ParsedFile::parse(&path.to_string_lossy(), text);
    let summary = FileSummary::extract(&parsed);
    let property = summary.class_likes.iter().flat_map(|class| &class.properties).find(|p| p.name == "listen")?;
    let statement = text.get(property.loc.start as usize..property.loc.end as usize)?;
    let open = property.loc.start as usize + statement.find('[')?;
    let close = closing_bracket(text, open)?;
    let names = FileNames::resolve(&parsed);
    let event_short = event.rsplit('\\').next().unwrap_or(event);
    let listener_short = listener.rsplit('\\').next().unwrap_or(listener);
    let mut edits = Edits::new();
    // The event's entry: `Event::class => [`.
    let body = &text[open..close];
    let entry = [format!("{event_short}::class"), format!("{}::class", event.trim_start_matches('\\'))]
        .iter()
        .filter_map(|needle| body.find(needle.as_str()).map(|at| open + at + needle.len()))
        .find(|&after| text[after..].trim_start().starts_with("=>"));
    match entry {
        Some(after) => {
            let list_open = after + text[after..].find('[')?;
            let list_close = closing_bracket(text, list_open)?;
            let list = &text[list_open..list_close];
            if list.contains(&format!("{listener_short}::class")) {
                return None;
            }
            let name = written(&parsed, &names, open as u32, listener, &mut edits);
            let (at, insert) = append_item(text, list_open, list_close, &format!("{name}::class"));
            edits.push((at, at, insert));
        }
        None => {
            let event_name = written(&parsed, &names, open as u32, event, &mut edits);
            let listener_name = written(&parsed, &names, open as u32, listener, &mut edits);
            let line_start = text[..property.loc.start as usize].rfind('\n').map_or(0, |i| i + 1);
            let indent: String = text[line_start..].chars().take_while(|c| *c == ' ' || *c == '\t').collect();
            let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
            let entry = format!(
                "{event_name}::class => [{nl}{indent}{indent}{indent}{listener_name}::class,{nl}{indent}{indent}]"
            );
            let inner = &text[open + 1..close];
            if inner.trim().is_empty() {
                edits.push(((open + 1) as u32, close as u32, format!("{nl}{indent}{indent}{entry},{nl}{indent}")));
            } else {
                let at = open + 1 + inner.trim_end().len();
                let comma = if inner.trim_end().ends_with(',') { "" } else { "," };
                edits.push((at as u32, at as u32, format!("{comma}{nl}{indent}{indent}{entry},")));
            }
        }
    }
    Some(file_edit(text, path, edits))
}

/// The edit adding provider `fqn` to the `providers` of a `module.json`
/// (`text`, file `path`). `None` when it lists it already or has no
/// `providers` array.
pub fn module_provider_registration(text: &str, path: &Path, fqn: &str) -> Option<FileEdit> {
    let escaped = fqn.trim_start_matches('\\').replace('\\', "\\\\");
    let key = text.find("\"providers\"")?;
    let open = key + text[key..].find('[')?;
    let close = closing_bracket(text, open)?;
    if text[open..close].contains(&format!("\"{escaped}\"")) {
        return None;
    }
    let (at, insert) = append_item(text, open, close, &format!("\"{escaped}\""));
    Some(file_edit(text, path, vec![(at, at, insert)]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apply(text: &str, edit: Option<FileEdit>) -> Option<String> {
        let Some(FileEdit::Edit { edits, .. }) = edit else { return None };
        let lines = crate::syntax::LineIndex::new(text);
        let mut out = text.to_owned();
        for edit in edits.iter().rev() {
            let start = lines.byte(edit.range.start) as usize;
            let end = lines.byte(edit.range.end) as usize;
            out.replace_range(start..end, &edit.new_text);
        }
        Some(out)
    }

    const MODEL: &str = "<?php\n\nnamespace App\\Models;\n\nuse Illuminate\\Database\\Eloquent\\Model;\n\nclass Post extends Model\n{\n}\n";

    #[test]
    fn observers_go_on_the_model() {
        let path = Path::new("app/Models/Post.php");
        let out = apply(MODEL, observer_registration(MODEL, path, "App\\Models\\Post", "App\\Observers\\PostObserver"));
        insta::assert_snapshot!(out.unwrap(), @r"
        <?php

        namespace App\Models;

        use App\Observers\PostObserver;
        use Illuminate\Database\Eloquent\Attributes\ObservedBy;
        use Illuminate\Database\Eloquent\Model;

        #[ObservedBy([PostObserver::class])]
        class Post extends Model
        {
        }
        ");
        let observed =
            apply(MODEL, observer_registration(MODEL, path, "App\\Models\\Post", "App\\Observers\\PostObserver"))
                .unwrap();
        // A second observer joins the list; the first one isn't added twice.
        assert!(observer_registration(&observed, path, "App\\Models\\Post", "App\\Observers\\PostObserver").is_none());
        let both = apply(
            &observed,
            observer_registration(&observed, path, "App\\Models\\Post", "App\\Observers\\AuditObserver"),
        )
        .unwrap();
        assert!(both.contains("#[ObservedBy([PostObserver::class, AuditObserver::class])]"), "{both}");
        assert!(both.contains("use App\\Observers\\AuditObserver;"), "{both}");
        // The attribute with one class (not a list) becomes a list.
        let single = MODEL.replace(
            "class Post",
            "#[\\Illuminate\\Database\\Eloquent\\Attributes\\ObservedBy(\\App\\Observers\\PostObserver::class)]\nclass Post",
        );
        let out =
            apply(&single, observer_registration(&single, path, "App\\Models\\Post", "App\\Observers\\AuditObserver"))
                .unwrap();
        assert!(out.contains("ObservedBy([\\App\\Observers\\PostObserver::class, AuditObserver::class])]"), "{out}");
        assert!(observer_registration(MODEL, path, "App\\Models\\Other", "App\\Observers\\X").is_none());
    }

    #[test]
    fn listeners_go_under_their_event() {
        let path = Path::new("app/Providers/EventServiceProvider.php");
        let text = "<?php\n\nnamespace App\\Providers;\n\nuse App\\Events\\OrderShipped;\nuse Illuminate\\Foundation\\Support\\Providers\\EventServiceProvider as ServiceProvider;\n\nclass EventServiceProvider extends ServiceProvider\n{\n    protected $listen = [\n        OrderShipped::class => [\n            \\App\\Listeners\\Notify::class,\n        ],\n    ];\n}\n";
        let out =
            apply(text, listener_registration(text, path, "App\\Events\\OrderShipped", "App\\Listeners\\SendShipment"))
                .unwrap();
        assert!(
            out.contains("        OrderShipped::class => [\n            \\App\\Listeners\\Notify::class,\n            SendShipment::class,\n        ],"),
            "{out}"
        );
        assert!(out.contains("use App\\Listeners\\SendShipment;"), "{out}");
        assert!(
            listener_registration(&out, path, "App\\Events\\OrderShipped", "App\\Listeners\\SendShipment").is_none()
        );
        // A new event gets an entry.
        let out = apply(text, listener_registration(text, path, "App\\Events\\UserJoined", "App\\Listeners\\Welcome"))
            .unwrap();
        assert!(
            out.contains("        ],\n        UserJoined::class => [\n            Welcome::class,\n        ],\n    ];"),
            "{out}"
        );
        // An empty `$listen`.
        let empty =
            "<?php\n\nnamespace App\\Providers;\n\nclass EventServiceProvider\n{\n    protected $listen = [];\n}\n";
        let out =
            apply(empty, listener_registration(empty, path, "App\\Events\\UserJoined", "App\\Listeners\\Welcome"))
                .unwrap();
        assert!(
            out.contains("    protected $listen = [\n        UserJoined::class => [\n            Welcome::class,\n        ],\n    ];"),
            "{out}"
        );
        // No `$listen`: nothing to register.
        assert!(listener_registration("<?php\nclass P {}\n", path, "E", "L").is_none());
    }

    #[test]
    fn module_providers_go_into_module_json() {
        let path = Path::new("Modules/Blog/module.json");
        let text = "{\n    \"name\": \"Blog\",\n    \"providers\": [\n        \"Modules\\\\Blog\\\\Providers\\\\BlogServiceProvider\"\n    ]\n}\n";
        let out =
            apply(text, module_provider_registration(text, path, "Modules\\Blog\\Providers\\EventProvider")).unwrap();
        assert_eq!(
            out,
            "{\n    \"name\": \"Blog\",\n    \"providers\": [\n        \"Modules\\\\Blog\\\\Providers\\\\BlogServiceProvider\",\n        \"Modules\\\\Blog\\\\Providers\\\\EventProvider\"\n    ]\n}\n"
        );
        assert!(module_provider_registration(&out, path, "Modules\\Blog\\Providers\\EventProvider").is_none());
        let empty = "{\"name\": \"Blog\", \"providers\": []}";
        assert_eq!(
            apply(empty, module_provider_registration(empty, path, "Modules\\Blog\\P")).unwrap(),
            "{\"name\": \"Blog\", \"providers\": [\"Modules\\\\Blog\\\\P\"]}"
        );
    }
}
