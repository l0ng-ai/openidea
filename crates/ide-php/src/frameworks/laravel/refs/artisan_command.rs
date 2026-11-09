//! The `artisanCommand` reference kind: an Artisan command
//! ([`ArtisanCommands`]) in `Artisan::call('…')` / `Artisan::queue('…')`
//! (and on the console kernel), a command's `$this->call('…')` /
//! `callSilent(…)` / `callSilently(…)`, `Schedule::command('…')` (and
//! `$schedule->command(…)`), and a test's `$this->artisan('…')`, as
//! Laravel's documentation on Artisan writes them.
//!
//! The string may hold arguments after the name
//! (`'posts:publish --dry-run'`): completion offers the command names on
//! the first word and the command's options (`--dry-run`, `--queue=`)
//! after it; goto opens the command's signature (its class, or its closure
//! in `routes/console.php`); hover shows its description and synopsis; find
//! usages works from a usage and from the name in a `$signature`.

use std::path::Path;
use std::sync::Arc;

use super::{CalleePattern, Declared, PlacePattern, RefContext, RefItem, ReferenceKind};
use crate::frameworks::laravel::artisan::{ArtisanCommand, ArtisanCommands, CommandSource};
use crate::navigate::Target;
use crate::syntax::ParsedFile;

const ARTISAN: &[&str] = &[
    "Illuminate\\Support\\Facades\\Artisan",
    "Illuminate\\Contracts\\Console\\Kernel",
    "Illuminate\\Foundation\\Console\\Kernel",
];
const COMMANDS: &[&str] = &["Illuminate\\Console\\Command", "Illuminate\\Console\\Concerns\\CallsCommands"];
const SCHEDULES: &[&str] = &["Illuminate\\Support\\Facades\\Schedule", "Illuminate\\Console\\Scheduling\\Schedule"];
const TESTS: &[&str] =
    &["Illuminate\\Foundation\\Testing\\Concerns\\InteractsWithConsole", "Illuminate\\Foundation\\Testing\\TestCase"];

static PATTERNS: [PlacePattern; 4] = [
    PlacePattern::argument(CalleePattern::Method { classes: ARTISAN, names: &["call", "queue"] }, 0, "command"),
    PlacePattern::argument(
        CalleePattern::Method { classes: COMMANDS, names: &["call", "callSilent", "callSilently"] },
        0,
        "command",
    ),
    PlacePattern::argument(CalleePattern::Method { classes: SCHEDULES, names: &["command"] }, 0, "command"),
    PlacePattern::argument(CalleePattern::Method { classes: TESTS, names: &["artisan"] }, 0, "command"),
];

fn commands(cx: &RefContext<'_>) -> Arc<ArtisanCommands> {
    cx.engine.laravel_artisan().unwrap_or_default()
}

/// The command name of a value (its first word) and the byte range of it.
fn name_of(value: &str) -> (&str, usize, usize) {
    let start = value.len() - value.trim_start().len();
    let end = value[start..].find(char::is_whitespace).map_or(value.len(), |len| start + len);
    (&value[start..end], start, end)
}

/// Where command `command` is declared.
pub(crate) fn command_target(command: &ArtisanCommand) -> Option<Target> {
    Some(Target { path: command.path.clone()?, range: command.range? })
}

/// `posts:publish`'s hover.
pub(crate) fn command_hover(command: &ArtisanCommand) -> String {
    let mut out = format!("**artisan** `{}`", command.name);
    if !command.description.is_empty() {
        out.push_str(&format!("\n\n{}", command.description));
    }
    out.push_str(&format!("\n\n`{}`", command.synopsis()));
    let mut lines = Vec::new();
    for argument in &command.arguments {
        let description =
            if argument.description.is_empty() { String::new() } else { format!(" — {}", argument.description) };
        lines.push(format!("`{}`{description}", argument.name));
    }
    for option in &command.options {
        let description =
            if option.description.is_empty() { String::new() } else { format!(" — {}", option.description) };
        lines.push(format!("`--{}`{description}", option.name));
    }
    if !lines.is_empty() {
        out.push_str(&format!("\n\n{}", lines.join("  \n")));
    }
    if let Some(class) = &command.class {
        out.push_str(&format!("\n\n`{class}`"));
    } else if command.source == CommandSource::Closure {
        out.push_str("\n\nClosure command");
    }
    out
}

/// See the module documentation.
pub struct ArtisanCommandKind;

impl ReferenceKind for ArtisanCommandKind {
    fn id(&self) -> &'static str {
        "artisanCommand"
    }

    fn patterns(&self) -> &'static [PlacePattern] {
        &PATTERNS
    }

    fn complete(&self, cx: &RefContext<'_>, value: &str, at: usize) -> Vec<RefItem> {
        let commands = commands(cx);
        let (name, _, name_end) = name_of(value);
        if at <= name_end {
            return commands
                .commands
                .iter()
                .map(|command| RefItem {
                    label: command.name.clone(),
                    insert: command.name.clone(),
                    detail: Some(command.description.clone()).filter(|d| !d.is_empty()),
                    from: 0,
                    to: name_end,
                })
                .collect();
        }
        // An option of the command, in the word at the caret.
        let Some(command) = commands.get(name) else { return Vec::new() };
        let from = value[..at].rfind(char::is_whitespace).map_or(0, |space| space + 1);
        let to = value[at..].find(char::is_whitespace).map_or(value.len(), |len| at + len);
        // Options given before the caret's word aren't offered again.
        let given: Vec<&str> =
            value[..from].split_whitespace().map(|word| word.split('=').next().unwrap_or(word)).collect();
        command
            .options
            .iter()
            .filter(|option| option.array || !given.contains(&format!("--{}", option.name).as_str()))
            .map(|option| {
                let flag = format!("--{}", option.name);
                RefItem {
                    label: flag.clone(),
                    insert: if option.accepts_value { format!("{flag}=") } else { flag },
                    detail: Some(option.description.clone()).filter(|d| !d.is_empty()),
                    from,
                    to,
                }
            })
            .collect()
    }

    fn resolve(&self, cx: &RefContext<'_>, value: &str, _at: usize) -> Vec<Target> {
        let (name, _, _) = name_of(value);
        commands(cx).get(name).and_then(command_target).into_iter().collect()
    }

    fn usage_words(&self, value: &str) -> Vec<String> {
        crate::index::words(name_of(value).0)
    }

    fn usage_text<'v>(&self, value: &'v str) -> &'v str {
        name_of(value).0
    }

    fn canonical(&self, _cx: &RefContext<'_>, value: &str) -> String {
        name_of(value).0.to_owned()
    }

    fn refers_to(&self, value: &str, key: &str) -> bool {
        name_of(value).0 == key
    }

    fn declared_at(&self, cx: &RefContext<'_>, path: &Path, _parsed: &ParsedFile, offset: u32) -> Option<Declared> {
        let commands = commands(cx);
        commands.in_file(path).find_map(|command| {
            let (start, end) = command.bytes?;
            // A class without a name string has the class name there.
            if command.class_range.is_some_and(|range| Some(range) == command.range) {
                return None;
            }
            (start <= offset && offset <= end).then(|| Declared {
                value: command.name.clone(),
                start,
                end,
                at: (offset - start) as usize,
            })
        })
    }

    fn is_known(&self, cx: &RefContext<'_>, value: &str) -> bool {
        commands(cx).get(name_of(value).0).is_some()
    }

    fn hover(&self, cx: &RefContext<'_>, value: &str) -> Option<String> {
        commands(cx).get(name_of(value).0).map(command_hover)
    }
}
